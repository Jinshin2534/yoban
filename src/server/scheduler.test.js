import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openStore } from './store.js'
import { createScheduler } from './scheduler.js'
import { nextRunAt } from '../core/schedule.js'

let dir
let store
let clock
let started
let gates

const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi)

const taskFields = (over = {}) => ({
  name: 'タスク',
  repoPath: '/repo/a',
  agent: 'claude',
  model: null,
  prompt: 'やって',
  schedule: { type: 'daily', time: '02:00' },
  enabled: true,
  baseBranch: null,
  setupCommand: null,
  verifyCommand: null,
  timeoutMinutes: 30,
  catchUp: true,
  catchUpGraceHours: 6,
  draftPr: true,
  keepWorktreeOnFailure: false,
  ...over,
})

/** 実行を止めたり進めたりできる偽エグゼキュータ */
function makeExecute() {
  return async ({ task, run, signal }) => {
    started.push({ taskId: task.id, runId: run.id, repoPath: task.repoPath })
    store.updateRun(run.id, { status: 'running' })
    await new Promise((resolve) => {
      gates.set(run.id, () => resolve())
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    store.updateRun(run.id, { status: signal?.aborted ? 'cancelled' : 'success' })
    return store.getRun(run.id)
  }
}

const settle = () => new Promise((r) => setTimeout(r, 10))

function makeScheduler(over = {}) {
  return createScheduler({
    store,
    execute: makeExecute(),
    now: () => clock,
    maxConcurrent: 2,
    stateDir: dir,
    ...over,
  })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'yoban-sched-'))
  store = openStore(path.join(dir, 'yoban.db'))
  clock = at(2026, 8, 29, 3, 0)
  started = []
  gates = new Map()
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('予定の拾い上げ', () => {
  it('予定時刻を過ぎたタスクを走らせ、次回時刻を計算し直す', async () => {
    const task = store.createTask(taskFields())
    store.setNextRunAt(task.id, at(2026, 8, 29, 2, 0).toISOString())

    const scheduler = makeScheduler()
    await scheduler.tick()
    await settle()

    expect(started).toHaveLength(1)
    const after = store.getTask(task.id)
    expect(new Date(after.nextRunAt)).toEqual(nextRunAt(task.schedule, clock))
  })

  it('何度 tick しても二重に走らない', async () => {
    const task = store.createTask(taskFields())
    store.setNextRunAt(task.id, at(2026, 8, 29, 2, 0).toISOString())

    const scheduler = makeScheduler()
    await scheduler.tick()
    await scheduler.tick()
    await scheduler.tick()
    await settle()

    expect(started).toHaveLength(1)
  })

  it('遅れすぎたタスクは走らせず、次回に回す', async () => {
    const task = store.createTask(taskFields({ catchUpGraceHours: 1 }))
    store.setNextRunAt(task.id, at(2026, 8, 29, 2, 0).toISOString())
    clock = at(2026, 8, 29, 10, 0)

    const scheduler = makeScheduler()
    await scheduler.tick()
    await settle()

    expect(started).toHaveLength(0)
    expect(store.getTask(task.id).nextRunAt).not.toBeNull()
    expect(new Date(store.getTask(task.id).nextRunAt) > clock).toBe(true)
    expect(store.listRuns({})).toHaveLength(0)
  })

  it('1回だけのタスクは実行後に無効になる', async () => {
    const task = store.createTask(
      taskFields({ schedule: { type: 'once', at: '2026-08-29T02:00' } }),
    )
    store.setNextRunAt(task.id, at(2026, 8, 29, 2, 0).toISOString())

    const scheduler = makeScheduler()
    await scheduler.tick()
    await settle()

    expect(started).toHaveLength(1)
    const after = store.getTask(task.id)
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeNull()
  })

  it('無効なタスクは拾わない', async () => {
    const task = store.createTask(taskFields({ enabled: false }))
    store.setNextRunAt(task.id, at(2026, 8, 29, 2, 0).toISOString())

    await makeScheduler().tick()
    await settle()
    expect(started).toHaveLength(0)
  })
})

describe('同時実行の制御', () => {
  it('上限を超えて同時に走らせない', async () => {
    for (const repo of ['/repo/a', '/repo/b', '/repo/c']) {
      const t = store.createTask(taskFields({ name: repo, repoPath: repo }))
      store.setNextRunAt(t.id, at(2026, 8, 29, 2, 0).toISOString())
    }

    const scheduler = makeScheduler({ maxConcurrent: 2 })
    await scheduler.tick()
    await settle()

    expect(started).toHaveLength(2)
    expect(scheduler.status().running).toBe(2)
    expect(scheduler.status().queued).toBe(1)

    // 1本終わらせると、待っていた3本目が始まる
    gates.get(started[0].runId)()
    await settle()
    expect(started).toHaveLength(3)
  })

  it('同じリポジトリのタスクは同時に走らせない', async () => {
    const a = store.createTask(taskFields({ name: 'A', repoPath: '/repo/same' }))
    const b = store.createTask(taskFields({ name: 'B', repoPath: '/repo/same' }))
    store.setNextRunAt(a.id, at(2026, 8, 29, 2, 0).toISOString())
    store.setNextRunAt(b.id, at(2026, 8, 29, 2, 0).toISOString())

    const scheduler = makeScheduler({ maxConcurrent: 4 })
    await scheduler.tick()
    await settle()

    expect(started).toHaveLength(1)
    expect(scheduler.status().queued).toBe(1)

    gates.get(started[0].runId)()
    await settle()
    expect(started).toHaveLength(2)
    expect(started[0].repoPath).toBe(started[1].repoPath)
  })
})

describe('手動実行', () => {
  it('予定に関係なく走らせられる', async () => {
    const task = store.createTask(taskFields({ enabled: false }))
    const scheduler = makeScheduler()

    const run = scheduler.enqueue(task.id, 'manual')
    await settle()

    expect(run.trigger).toBe('manual')
    expect(started).toHaveLength(1)
    expect(store.getRun(run.id).status).toBe('running')
  })

  it('存在しないタスクは例外', () => {
    expect(() => makeScheduler().enqueue('NOPE', 'manual')).toThrow()
  })

  it('実行中のタスクをもう一度手動で走らせようとしたら断る', async () => {
    const task = store.createTask(taskFields())
    const scheduler = makeScheduler()
    scheduler.enqueue(task.id, 'manual')
    await settle()
    expect(() => scheduler.enqueue(task.id, 'manual')).toThrow(/実行中/)
  })
})

describe('中止', () => {
  it('実行中の run を止められる', async () => {
    const task = store.createTask(taskFields())
    const scheduler = makeScheduler()
    const run = scheduler.enqueue(task.id, 'manual')
    await settle()

    expect(scheduler.cancel(run.id)).toBe(true)
    await settle()
    expect(store.getRun(run.id).status).toBe('cancelled')
    expect(scheduler.status().running).toBe(0)
  })

  it('走っていない run の中止は false', () => {
    expect(makeScheduler().cancel('NOPE')).toBe(false)
  })

  it('待機中の run も取り消せる', async () => {
    const a = store.createTask(taskFields({ name: 'A', repoPath: '/repo/same' }))
    const b = store.createTask(taskFields({ name: 'B', repoPath: '/repo/same' }))
    const scheduler = makeScheduler()
    scheduler.enqueue(a.id, 'manual')
    const waiting = scheduler.enqueue(b.id, 'manual')
    await settle()

    expect(scheduler.status().queued).toBe(1)
    expect(scheduler.cancel(waiting.id)).toBe(true)
    expect(scheduler.status().queued).toBe(0)
    expect(store.getRun(waiting.id).status).toBe('cancelled')
  })
})

describe('起動と停止', () => {
  it('起動時に前回の走りっぱなしを閉じる', async () => {
    const task = store.createTask(taskFields())
    const stale = store.createRun({ taskId: task.id, trigger: 'schedule', logPath: '/tmp/x.log' })
    store.updateRun(stale.id, { status: 'running' })

    const scheduler = makeScheduler()
    scheduler.start()
    scheduler.stop()

    expect(store.getRun(stale.id).status).toBe('failed')
    expect(store.getRun(stale.id).errorMessage).toMatch(/再起動|中断/)
  })

  it('起動直後に一度だけ予定を確認する', async () => {
    const task = store.createTask(taskFields())
    store.setNextRunAt(task.id, at(2026, 8, 29, 2, 0).toISOString())

    const scheduler = makeScheduler()
    scheduler.start()
    await settle()
    scheduler.stop()

    expect(started).toHaveLength(1)
  })

  it('stop 後は tick しても何も起きない', async () => {
    const scheduler = makeScheduler()
    scheduler.start()
    await settle()
    expect(started).toHaveLength(0) // まだ予定は無い

    const task = store.createTask(taskFields())
    store.setNextRunAt(task.id, at(2026, 8, 29, 2, 0).toISOString())
    scheduler.stop()
    await scheduler.tick()
    await settle()

    expect(started).toHaveLength(0)
  })
})
