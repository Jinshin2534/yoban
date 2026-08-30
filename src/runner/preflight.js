// 実行前チェック。AI を起動する前に、確実に失敗する条件を洗い出す。
// 見つかった不足はまとめて返す（1つ直すたびにやり直させないため）。
import { execOk } from './exec.js'
import * as gitOps from './git.js'

export const defaultDeps = {
  isGitRepo: gitOps.isGitRepo,
  hasRemote: gitOps.hasRemote,
  detectBaseBranch: gitOps.detectBaseBranch,
  branchExists: async (repoPath, branch) =>
    (await gitOps.localBranchExists(repoPath, branch)) || (await gitOps.remoteBranchExists(repoPath, branch)),
  commandExists: (command) => execOk('which', [command], { timeoutMs: 15_000 }),
  ghAuthOk: () => execOk('gh', ['auth', 'status'], { timeoutMs: 30_000 }),
}

export async function preflight(task, deps = defaultDeps) {
  const errors = []
  const { repoPath, agent } = task

  if (!(await deps.isGitRepo(repoPath))) {
    errors.push(`${repoPath} は git リポジトリではありません`)
    return { ok: false, errors, baseBranch: task.baseBranch ?? null }
  }

  if (!(await deps.hasRemote(repoPath))) {
    errors.push('origin が設定されていません（push と PR 作成ができません）')
  }

  let baseBranch = task.baseBranch ?? null
  if (!baseBranch) {
    try {
      baseBranch = await deps.detectBaseBranch(repoPath)
    } catch (err) {
      errors.push(`base ブランチを自動検出できませんでした: ${err.message}`)
    }
  }
  if (baseBranch && !(await deps.branchExists(repoPath, baseBranch))) {
    errors.push(`base ブランチ ${baseBranch} が見つかりません`)
  }

  if (!(await deps.commandExists(agent))) {
    errors.push(`${agent} コマンドが見つかりません（PATH を確認してください）`)
  }

  if (!(await deps.commandExists('gh'))) {
    errors.push('gh コマンドが見つかりません（PR の作成に必要です）')
  } else if (!(await deps.ghAuthOk())) {
    errors.push('gh が認証されていません（gh auth login を実行してください）')
  }

  return { ok: errors.length === 0, errors, baseBranch }
}
