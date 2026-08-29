import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRepoPair, remoteBranches, git as rawGit } from '../../test/helpers/repo.js'
import { openStore } from '../server/store.js'
import { executeRun, defaultDeps } from './executor.js'

const FAKE = fileURLToPath(new URL('../../test/helpers/fake-agent.js', import.meta.url))
const fakeAgent = (...args) => ({ command: process.execPath, args: [FAKE, ...args] })

let repo
let store
let stateDir
let prCalls

const baseTask = (over = {}) => ({
  name: 'テストを追加する',
  repoPath: null,
  agent: 'claude',
  model: null,
  prompt: 'src にファイルを足して',
  schedule: { type: 'daily', time: '02:00' },
  enabled: true,
  baseBranch: 'master',
  setupCommand: null,
  verifyCommand: null,
  timeoutMinutes: 1,
  catchUp: true,
  catchUpGraceHours: 6,
  draftPr: true,
  keepWorktreeOnFailure: false,
  ...over,
})

function makeDeps(over = {}) {
  return {
    ...defaultDeps,
    preflight: async (task) => ({ ok: true, errors: [], baseBranch: task.baseBranch ?? 'master' }),
    createPullRequest: async (args) => {
      prCalls.push(args)
      return 'https://github.com/tester/repo/pull/42'
    },
    ...over,
  }
}

async function run({ task: taskOver = {}, agentCommand, deps = {} } = {}) {
  const task = store.createTask(baseTask({ repoPath: repo.work, ...taskOver }))
  const created = store.createRun({ taskId: task.id, trigger: 'manual', logPath: 'placeholder' })
  const logPath = path.join(stateDir, 'runs', `${created.id}.log`)
  store.updateRun(created.id, { logPath })
  const result = await executeRun({
    task,
    run: { ...created, logPath },
    store,
    worktreePath: path.join(stateDir, 'worktrees', created.id),
    logPath,
    deps: makeDeps({
      agentCommand:
        agentCommand ?? fakeAgent('--write', 'src/added.js', '--content', 'export const two = 2\n'),
      ...deps,
    }),
  })
  return { task, result, logPath }
}

beforeEach(() => {
  repo = makeRepoPair()
  stateDir = mkdtempSync(path.join(tmpdir(), 'yoban-state-'))
  store = openStore(path.join(stateDir, 'yoban.db'))
  prCalls = []
})

afterEach(() => {
  store.close()
  rmSync(stateDir, { recursive: true, force: true })
  repo.cleanup()
})

describe('成功したとき', () => {
  it('コミット・push され、PR が作られる', async () => {
    const { result } = await run()

    expect(result.status).toBe('success')
    expect(result.step).toBe('done')
    expect(result.prUrl).toBe('https://github.com/tester/repo/pull/42')
    expect(remoteBranches(repo.origin)).toContain(result.branch)
    expect(result.branch).toMatch(/^yoban\//)
  })

  it('PR には base ブランチ・タイトル・本文が渡る', async () => {
    const { result } = await run()
    expect(prCalls).toHaveLength(1)
    expect(prCalls[0].base).toBe('master')
    expect(prCalls[0].branch).toBe(result.branch)
    expect(prCalls[0].title).toBe('テストを追加する')
    expect(prCalls[0].body).toContain('src にファイルを足して')
    expect(prCalls[0].draft).toBe(true)
  })

  it('本体のリポジトリは元のまま（作業中のファイルを壊さない）', async () => {
    const before = readFileSync(path.join(repo.work, 'src', 'index.js'), 'utf8')
    await run()
    expect(readFileSync(path.join(repo.work, 'src', 'index.js'), 'utf8')).toBe(before)
    expect(existsSync(path.join(repo.work, 'src', 'added.js'))).toBe(false)
  })

  it('worktree は片付けられる', async () => {
    const { result } = await run()
    expect(existsSync(path.join(stateDir, 'worktrees', result.id))).toBe(false)
  })

  it('ログがファイルに残る', async () => {
    const { logPath } = await run({
      agentCommand: fakeAgent('--write', 'a.txt', '--print', 'エージェントの出力です'),
    })
    expect(readFileSync(logPath, 'utf8')).toContain('エージェントの出力です')
  })
})

describe('変更が無かったとき', () => {
  it('PR を作らず no_changes で終わる', async () => {
    const { result } = await run({ agentCommand: fakeAgent('--print', '何もすることがありませんでした') })
    expect(result.status).toBe('no_changes')
    expect(result.prUrl).toBeNull()
    expect(prCalls).toHaveLength(0)
    expect(remoteBranches(repo.origin)).toEqual(['master'])
  })
})

describe('失敗したとき', () => {
  it('preflight で落ちたらエージェントを起動しない', async () => {
    let launched = false
    const { result } = await run({
      deps: {
        preflight: async () => ({ ok: false, errors: ['gh が認証されていません'], baseBranch: 'master' }),
        runAgent: async () => {
          launched = true
          return { code: 0, stdout: '', timedOut: false, aborted: false }
        },
      },
    })
    expect(result.status).toBe('failed')
    expect(result.step).toBe('preflight')
    expect(result.errorMessage).toMatch(/認証/)
    expect(launched).toBe(false)
  })

  it('エージェントが異常終了したら failed', async () => {
    const { result } = await run({ agentCommand: fakeAgent('--write', 'a.txt', '--exit', '2') })
    expect(result.status).toBe('failed')
    expect(result.step).toBe('agent')
    expect(prCalls).toHaveLength(0)
  })

  it('タイムアウトしたら timeout として記録する', async () => {
    const { result } = await run({
      agentCommand: fakeAgent('--sleep', '30000'),
      deps: { timeoutMsOverride: 300 },
    })
    expect(result.status).toBe('timeout')
    expect(result.step).toBe('agent')
  })

  it('準備コマンドが失敗したらそこで止める', async () => {
    const { result } = await run({ task: { setupCommand: 'exit 7' } })
    expect(result.status).toBe('failed')
    expect(result.step).toBe('setup')
    expect(result.errorMessage).toMatch(/7/)
  })

  it('PR 作成に失敗しても、push 済みのブランチは残す', async () => {
    const { result } = await run({
      deps: {
        createPullRequest: async () => {
          throw new Error('gh が壊れています')
        },
      },
    })
    expect(result.status).toBe('failed')
    expect(result.step).toBe('pr')
    expect(remoteBranches(repo.origin)).toContain(result.branch)
    expect(result.errorMessage).toMatch(/gh が壊れています/)
  })

  it('失敗時に worktree を残す設定が効く', async () => {
    const { result } = await run({
      task: { keepWorktreeOnFailure: true },
      agentCommand: fakeAgent('--write', 'a.txt', '--exit', '2'),
    })
    expect(existsSync(path.join(stateDir, 'worktrees', result.id))).toBe(true)
  })
})

describe('検証コマンド', () => {
  it('成功したら終了コード 0 を記録して PR を作る', async () => {
    const { result } = await run({ task: { verifyCommand: 'test -f src/added.js' } })
    expect(result.verifyExitCode).toBe(0)
    expect(result.status).toBe('success')
    expect(prCalls[0].body).toMatch(/成功/)
  })

  it('失敗しても PR は作り、失敗したことを残す', async () => {
    const { result } = await run({ task: { verifyCommand: 'exit 1' } })
    expect(result.verifyExitCode).toBe(1)
    expect(result.status).toBe('success')
    expect(prCalls).toHaveLength(1)
    expect(prCalls[0].body).toMatch(/失敗/)
  })

  it('検証の出力が PR 本文に載る', async () => {
    const { result } = await run({ task: { verifyCommand: 'echo テストが落ちました >&2; exit 1' } })
    expect(result.verifyExitCode).toBe(1)
    expect(prCalls[0].body).toContain('テストが落ちました')
  })
})

describe('ブランチ名の衝突', () => {
  it('同じ名前が既にあれば連番を付ける', async () => {
    // 英字のタスク名は日付＋スラッグが同じになるので、二度目は必ずぶつかる
    const first = await run({ task: { name: 'add tests' } })
    const second = await run({ task: { name: 'add tests' } })
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    expect(first.result.branch).toBe(`yoban/${stamp}-add-tests`)
    expect(second.result.branch).not.toBe(first.result.branch)
    expect(second.result.branch).toMatch(/-2$/)
    expect(remoteBranches(repo.origin)).toEqual(
      expect.arrayContaining([first.result.branch, second.result.branch]),
    )
  })
})

describe('中止', () => {
  it('signal を倒すと cancelled になる', async () => {
    const controller = new AbortController()
    const task = store.createTask(baseTask({ repoPath: repo.work }))
    const created = store.createRun({ taskId: task.id, trigger: 'manual', logPath: 'x' })
    const logPath = path.join(stateDir, 'runs', 'cancel.log')
    const promise = executeRun({
      task,
      run: { ...created, logPath },
      store,
      worktreePath: path.join(stateDir, 'worktrees', created.id),
      logPath,
      deps: makeDeps({ agentCommand: fakeAgent('--sleep', '30000') }),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 500)
    const result = await promise
    expect(result.status).toBe('cancelled')
    expect(prCalls).toHaveLength(0)
  })
})
