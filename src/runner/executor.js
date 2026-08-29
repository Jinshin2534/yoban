// 1 回の実行の全工程。
// preflight → worktree → 準備 → AI → 変更検出 → 検証 → commit → push → PR → 後片付け
//
// git 操作は AI にやらせず、すべてここで決め打ちにする。
import { branchName, prTitle, commitMessage } from '../core/branch.js'
import { prBody } from '../core/pr-body.js'
import { parseAgentStream } from '../core/agent-output.js'
import { buildPrompt } from '../core/prompt.js'
import * as gitOps from './git.js'
import { createWorktree, removeWorktree, deleteLocalBranch } from './worktree.js'
import { runAgent, buildAgentCommand } from './agents/index.js'
import { createPullRequest } from './github.js'
import { preflight } from './preflight.js'
import { runShell } from './exec.js'
import { createLogWriter } from './log.js'

const MAX_BRANCH_ATTEMPTS = 5
const FAILED_STATUSES = ['failed', 'timeout', 'cancelled']

export const defaultDeps = {
  preflight,
  git: gitOps,
  createWorktree,
  removeWorktree,
  deleteLocalBranch,
  runAgent,
  buildAgentCommand,
  createPullRequest,
  runShell,
  createLogWriter,
}

/** 空いているブランチ名を探す（同じ日に同じ名前のタスクを二度走らせても衝突しない） */
async function pickBranch({ task, run, git, repoPath }) {
  for (let seq = 1; seq <= MAX_BRANCH_ATTEMPTS; seq++) {
    const candidate = branchName(task, { runId: run.id, seq })
    const taken =
      (await git.localBranchExists(repoPath, candidate)) || (await git.remoteBranchExists(repoPath, candidate))
    if (!taken) return candidate
  }
  throw new Error('空いているブランチ名が見つかりませんでした')
}

export async function executeRun({ task, run, store, worktreePath, logPath, deps = {}, signal }) {
  const d = { ...defaultDeps, ...deps }
  const log = d.createLogWriter(logPath ?? run.logPath)
  const startedAt = new Date().toISOString()

  let step = 'preflight'
  let branch = null
  let worktreeCreated = false
  let agentOut = { finalMessage: null, tokensIn: null, tokensOut: null }

  store.updateRun(run.id, { status: 'running', step, startedAt })
  log.line(`# 夜番 ${startedAt}`)
  log.line(`# タスク: ${task.name}`)
  log.line(`# リポジトリ: ${task.repoPath}`)
  log.line(`# エージェント: ${task.agent}${task.model ? ` (${task.model})` : ''}`)

  const cleanup = async (status) => {
    const keep = FAILED_STATUSES.includes(status) && task.keepWorktreeOnFailure
    if (worktreeCreated && !keep) {
      try {
        await d.removeWorktree({ repoPath: task.repoPath, worktreePath })
        if (branch) await d.deleteLocalBranch({ repoPath: task.repoPath, branch })
      } catch (err) {
        log.line(`# 後片付けに失敗しました: ${err.message}`)
      }
    }
  }

  const finish = async (status, { errorMessage = null, extra = {} } = {}) => {
    await cleanup(status)
    const endedAt = new Date().toISOString()
    log.line(`# 結果: ${status}${errorMessage ? ` — ${errorMessage}` : ''}`)
    log.close()
    return store.updateRun(run.id, {
      status,
      step,
      endedAt,
      branch,
      errorMessage,
      finalMessage: agentOut.finalMessage,
      tokensIn: agentOut.tokensIn,
      tokensOut: agentOut.tokensOut,
      ...extra,
    })
  }

  try {
    // --- preflight ---
    const pre = await d.preflight(task)
    if (!pre.ok) return await finish('failed', { errorMessage: pre.errors.join(' / ') })
    const base = pre.baseBranch

    try {
      await d.git.fetch(task.repoPath)
    } catch (err) {
      // fetch できなくてもローカルの base で続行する（オフラインでも動くように）
      log.line(`# fetch に失敗しました（ローカルの ${base} で続行）: ${err.message}`)
    }

    branch = await pickBranch({ task, run, git: d.git, repoPath: task.repoPath })

    // --- worktree ---
    step = 'worktree'
    store.updateRun(run.id, { step, branch })
    log.line(`# ブランチ: ${branch}（base: ${base}）`)
    await d.createWorktree({ repoPath: task.repoPath, worktreePath, branch, base })
    worktreeCreated = true

    if (signal?.aborted) return await finish('cancelled', { errorMessage: '中止されました' })

    const timeoutMs = d.timeoutMsOverride ?? task.timeoutMinutes * 60_000

    // --- 準備コマンド ---
    if (task.setupCommand) {
      step = 'setup'
      store.updateRun(run.id, { step })
      log.line(`\n# 準備コマンド: ${task.setupCommand}`)
      const setup = await d.runShell(task.setupCommand, {
        cwd: worktreePath,
        timeoutMs,
        onOutput: (c) => log.write(c),
        signal,
      })
      if (setup.aborted) return await finish('cancelled', { errorMessage: '中止されました' })
      if (setup.code !== 0) {
        return await finish('failed', { errorMessage: `準備コマンドが失敗しました (code ${setup.code})` })
      }
    }

    // --- AI 実行 ---
    step = 'agent'
    store.updateRun(run.id, { step })
    const prompt = buildPrompt(task)
    const command = d.agentCommand ?? d.buildAgentCommand({ agent: task.agent, prompt, cwd: worktreePath, model: task.model })
    log.line(`\n# 実行: ${command.command} ${command.args.length} 個の引数`)
    const agentResult = await d.runAgent({
      command,
      cwd: worktreePath,
      timeoutMs,
      onOutput: (c) => log.write(c),
      signal,
    })

    try {
      const parsed = parseAgentStream(task.agent, agentResult.stdout ?? '')
      agentOut = { finalMessage: parsed.finalMessage, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut }
    } catch {
      // 解析できなくても実行の成否には影響させない
    }

    if (agentResult.aborted || signal?.aborted) return await finish('cancelled', { errorMessage: '中止されました' })
    if (agentResult.timedOut) {
      return await finish('timeout', { errorMessage: `${task.timeoutMinutes} 分でタイムアウトしました` })
    }
    if (agentResult.code !== 0) {
      return await finish('failed', { errorMessage: `エージェントが異常終了しました (code ${agentResult.code})` })
    }

    // --- 変更検出 ---
    step = 'changes'
    store.updateRun(run.id, { step })
    const files = await d.git.changedFiles(worktreePath)
    log.line(`\n# 変更されたファイル: ${files.length} 件`)
    for (const f of files.slice(0, 50)) log.line(`  ${f}`)
    if (files.length === 0) return await finish('no_changes')

    // --- 検証コマンド ---
    let verify = null
    if (task.verifyCommand) {
      step = 'verify'
      store.updateRun(run.id, { step })
      log.line(`\n# 検証コマンド: ${task.verifyCommand}`)
      const result = await d.runShell(task.verifyCommand, {
        cwd: worktreePath,
        timeoutMs,
        onOutput: (c) => log.write(c),
        signal,
      })
      if (result.aborted) return await finish('cancelled', { errorMessage: '中止されました' })
      verify = {
        command: task.verifyCommand,
        exitCode: result.code,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      }
      log.line(`# 検証の終了コード: ${result.code}`)
    }

    // --- コミット ---
    step = 'commit'
    store.updateRun(run.id, { step })
    await d.git.commitAll({ cwd: worktreePath, message: commitMessage(task) })

    // --- push ---
    step = 'push'
    store.updateRun(run.id, { step })
    await d.git.push({ cwd: worktreePath, branch })

    // --- PR ---
    step = 'pr'
    store.updateRun(run.id, { step })
    const body = prBody({
      task,
      run: { ...run, branch, startedAt, endedAt: new Date().toISOString(), ...agentOut },
      verify,
    })
    const prUrl = await d.createPullRequest({
      cwd: worktreePath,
      branch,
      base,
      title: prTitle(task),
      body,
      draft: !!task.draftPr,
    })
    log.line(`\n# PR: ${prUrl}`)

    step = 'done'
    return await finish('success', {
      extra: { prUrl, verifyExitCode: verify ? verify.exitCode : null },
    })
  } catch (err) {
    if (signal?.aborted) return await finish('cancelled', { errorMessage: '中止されました' })
    log.line(`\n# エラー (${step}): ${err.message}`)
    return await finish('failed', { errorMessage: err.message })
  }
}
