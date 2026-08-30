import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openStore } from './store.js'

let dir
let store

const taskFields = (over = {}) => ({
  name: 'テストを追加する',
  repoPath: '/Users/tester/ranzo_project/hair-pin',
  agent: 'claude',
  model: null,
  prompt: 'テストを足して',
  schedule: { type: 'daily', time: '02:00' },
  enabled: true,
  baseBranch: null,
  setupCommand: null,
  verifyCommand: 'pnpm test',
  timeoutMinutes: 30,
  catchUp: true,
  catchUpGraceHours: 6,
  draftPr: true,
  keepWorktreeOnFailure: false,
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'yoban-store-'))
  store = openStore(path.join(dir, 'yoban.db'))
})

afterEach(() => {
  store?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('tasks', () => {
  it('作って読み戻すと、型が保たれている', () => {
    const created = store.createTask(taskFields())
    expect(created.id).toMatch(/^[0-9A-Z]{26}$/)

    const got = store.getTask(created.id)
    expect(got.name).toBe('テストを追加する')
    expect(got.enabled).toBe(true)
    expect(got.draftPr).toBe(true)
    expect(got.keepWorktreeOnFailure).toBe(false)
    expect(got.schedule).toEqual({ type: 'daily', time: '02:00' })
    expect(got.model).toBeNull()
    expect(got.timeoutMinutes).toBe(30)
  })

  it('存在しない id は null', () => {
    expect(store.getTask('NOPE')).toBeNull()
  })

  it('更新できる', () => {
    const t = store.createTask(taskFields())
    const updated = store.updateTask(t.id, { name: '名前を変えた', enabled: false, schedule: { type: 'interval', hours: 3 } })
    expect(updated.name).toBe('名前を変えた')
    expect(updated.enabled).toBe(false)
    expect(updated.schedule).toEqual({ type: 'interval', hours: 3 })
    expect(store.getTask(t.id).name).toBe('名前を変えた')
  })

  it('削除するとタスクも実行履歴も消える', () => {
    const t = store.createTask(taskFields())
    store.createRun({ taskId: t.id, trigger: 'manual', logPath: '/tmp/a.log' })
    expect(store.deleteTask(t.id)).toBe(true)
    expect(store.getTask(t.id)).toBeNull()
    expect(store.listRuns({ taskId: t.id })).toEqual([])
    expect(store.deleteTask(t.id)).toBe(false)
  })

  it('id の先頭一致と名前で引ける', () => {
    const t = store.createTask(taskFields({ name: '夜のテスト' }))
    expect(store.findTask(t.id.slice(0, 6))?.id).toBe(t.id)
    expect(store.findTask('夜のテスト')?.id).toBe(t.id)
    expect(store.findTask('存在しない')).toBeNull()
  })
})

describe('dueTasks', () => {
  const iso = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).toISOString()

  it('有効かつ予定時刻を過ぎたものだけ返す', () => {
    const past = store.createTask(taskFields({ name: '過ぎている' }))
    const future = store.createTask(taskFields({ name: 'まだ先' }))
    const disabled = store.createTask(taskFields({ name: '無効', enabled: false }))
    store.setNextRunAt(past.id, iso(2026, 8, 29, 2, 0))
    store.setNextRunAt(future.id, iso(2026, 8, 30, 2, 0))
    store.setNextRunAt(disabled.id, iso(2026, 8, 29, 2, 0))

    const due = store.dueTasks(new Date(2026, 7, 29, 3, 0))
    expect(due.map((t) => t.name)).toEqual(['過ぎている'])
  })

  it('nextRunAt が未設定のタスクは対象外', () => {
    store.createTask(taskFields({ name: '予定なし' }))
    expect(store.dueTasks(new Date(2030, 0, 1))).toEqual([])
  })
})

describe('runs', () => {
  it('作って更新して読み戻せる', () => {
    const t = store.createTask(taskFields())
    const run = store.createRun({ taskId: t.id, trigger: 'schedule', logPath: '/tmp/x.log' })
    expect(run.status).toBe('queued')

    store.updateRun(run.id, {
      status: 'success',
      step: 'pr',
      branch: 'yoban/20260829-abc',
      prUrl: 'https://github.com/x/y/pull/1',
      verifyExitCode: 0,
      finalMessage: '終わった',
      tokensIn: 100,
      tokensOut: 20,
      endedAt: new Date().toISOString(),
    })
    const got = store.getRun(run.id)
    expect(got.status).toBe('success')
    expect(got.prUrl).toBe('https://github.com/x/y/pull/1')
    expect(got.verifyExitCode).toBe(0)
    expect(got.tokensIn).toBe(100)
  })

  it('新しい順に並び、件数を絞れる', () => {
    const t = store.createTask(taskFields())
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(store.createRun({ taskId: t.id, trigger: 'manual', logPath: `/tmp/${i}.log` }).id)
    const listed = store.listRuns({ limit: 3 })
    expect(listed.map((r) => r.id)).toEqual([...ids].reverse().slice(0, 3))
  })

  it('タスクで絞れる', () => {
    const a = store.createTask(taskFields({ name: 'A' }))
    const b = store.createTask(taskFields({ name: 'B' }))
    store.createRun({ taskId: a.id, trigger: 'manual', logPath: '/tmp/a.log' })
    store.createRun({ taskId: b.id, trigger: 'manual', logPath: '/tmp/b.log' })
    expect(store.listRuns({ taskId: a.id })).toHaveLength(1)
  })

  it('タスク名を一緒に返す（一覧表示のため）', () => {
    const t = store.createTask(taskFields({ name: '夜のテスト' }))
    store.createRun({ taskId: t.id, trigger: 'manual', logPath: '/tmp/a.log' })
    expect(store.listRuns({})[0].taskName).toBe('夜のテスト')
  })

  it('最後の実行を取れる', () => {
    const t = store.createTask(taskFields())
    store.createRun({ taskId: t.id, trigger: 'manual', logPath: '/tmp/1.log' })
    const last = store.createRun({ taskId: t.id, trigger: 'manual', logPath: '/tmp/2.log' })
    expect(store.lastRun(t.id).id).toBe(last.id)
  })

  it('走りっぱなしの run を失敗として閉じる', () => {
    const t = store.createTask(taskFields())
    const running = store.createRun({ taskId: t.id, trigger: 'manual', logPath: '/tmp/a.log' })
    store.updateRun(running.id, { status: 'running', startedAt: new Date().toISOString() })
    const queued = store.createRun({ taskId: t.id, trigger: 'schedule', logPath: '/tmp/c.log' })
    const done = store.createRun({ taskId: t.id, trigger: 'manual', logPath: '/tmp/b.log' })
    store.updateRun(done.id, { status: 'success' })

    const closed = store.closeStaleRuns('デーモンが再起動しました')
    expect(closed).toBe(2) // running と queued の両方
    expect(store.getRun(queued.id).status).toBe('failed')
    expect(store.getRun(running.id).status).toBe('failed')
    expect(store.getRun(running.id).errorMessage).toMatch(/再起動/)
    expect(store.getRun(done.id).status).toBe('success')
  })
})

describe('永続化', () => {
  it('開き直しても内容が残り、スキーマ作成は何度でも通る', () => {
    const file = path.join(dir, 'reopen.db')
    const s1 = openStore(file)
    const t = s1.createTask(taskFields({ name: '残るはず' }))
    s1.close()

    expect(existsSync(file)).toBe(true)
    const s2 = openStore(file)
    expect(s2.getTask(t.id).name).toBe('残るはず')
    expect(s2.schemaVersion()).toBeGreaterThanOrEqual(1)
    s2.close()
  })
})
