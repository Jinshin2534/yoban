import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openStore } from './store.js'
import { createServer } from './api.js'

let dir
let reposRoot
let store
let server
let baseUrl
let enqueued
let cancelled

const fakeScheduler = () => ({
  enqueue: (taskId, trigger) => {
    enqueued.push({ taskId, trigger })
    const run = store.createRun({ taskId, trigger, logPath: path.join(dir, 'runs', 'x.log') })
    return run
  },
  cancel: (runId) => {
    cancelled.push(runId)
    return runId !== 'NOPE'
  },
  status: () => ({ running: 1, queued: 0, runningRuns: [], queuedRuns: [], stopped: false }),
})

const api = (p, options = {}) =>
  fetch(`${baseUrl}${p}`, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-yoban': '1', ...(options.headers ?? {}) },
  })

const newTask = (over = {}) => ({
  name: 'テストを追加する',
  repoPath: path.join(reposRoot, 'hair-pin'),
  agent: 'claude',
  prompt: 'テストを足して',
  schedule: { type: 'daily', time: '02:00' },
  ...over,
})

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'yoban-api-'))
  reposRoot = path.join(dir, 'projects')
  mkdirSync(path.join(reposRoot, 'hair-pin', '.git'), { recursive: true })
  mkdirSync(path.join(reposRoot, 'bonsai', '.git'), { recursive: true })
  mkdirSync(path.join(reposRoot, 'ただのフォルダ'), { recursive: true })
  store = openStore(path.join(dir, 'yoban.db'))
  enqueued = []
  cancelled = []

  server = createServer({
    store,
    scheduler: fakeScheduler(),
    config: { allowedRoots: [reposRoot], stateDir: dir },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('health', () => {
  it('デーモンの状態を返す', async () => {
    const res = await api('/api/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.running).toBe(1)
  })
})

describe('タスクの CRUD', () => {
  it('作成すると次回実行時刻が入る', async () => {
    const res = await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })
    expect(res.status).toBe(201)
    const task = await res.json()
    expect(task.id).toBeTruthy()
    expect(task.nextRunAt).toBeTruthy()
    expect(new Date(task.nextRunAt) > new Date()).toBe(true)
  })

  it('一覧にはスケジュールの説明と直近の実行が付く', async () => {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })
    const list = await (await api('/api/tasks')).json()
    expect(list).toHaveLength(1)
    expect(list[0].scheduleText).toBe('毎日 02:00')
    expect(list[0].lastRun).toBeNull()
  })

  it('更新でスケジュールを変えると次回実行時刻も変わる', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    const res = await api(`/api/tasks/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ schedule: { type: 'interval', hours: 3 } }),
    })
    const updated = await res.json()
    expect(updated.schedule).toEqual({ type: 'interval', hours: 3 })
    expect(updated.nextRunAt).not.toBe(created.nextRunAt)
  })

  it('無効にすると次回実行時刻が消える', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    const updated = await (
      await api(`/api/tasks/${created.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
    ).json()
    expect(updated.enabled).toBe(false)
    expect(updated.nextRunAt).toBeNull()
  })

  it('削除できる', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    expect((await api(`/api/tasks/${created.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await api(`/api/tasks/${created.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('存在しないタスクは 404', async () => {
    expect((await api('/api/tasks/NOPE')).status).toBe(404)
  })
})

describe('入力の検証', () => {
  it('許可ルートの外のリポジトリは 400', async () => {
    const res = await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask({ repoPath: '/etc' })) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/許可/)
  })

  it('必須項目が無ければ 400', async () => {
    const res = await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask({ name: '' })) })
    expect(res.status).toBe(400)
  })

  it('壊れた JSON は 400', async () => {
    const res = await api('/api/tasks', { method: 'POST', body: '{壊れている' })
    expect(res.status).toBe(400)
  })

  it('未知のスケジュールは 400', async () => {
    const res = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(newTask({ schedule: { type: 'yearly' } })),
    })
    expect(res.status).toBe(400)
  })
})

describe('ブラウザからの不正な操作を防ぐ', () => {
  it('専用ヘッダの無い書き込みは断る', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(newTask()),
    })
    expect(res.status).toBe(403)
    expect(store.listTasks()).toHaveLength(0)
  })

  it('読み取りはヘッダ無しでもできる', async () => {
    expect((await fetch(`${baseUrl}/api/tasks`)).status).toBe(200)
  })
})

describe('実行', () => {
  it('今すぐ実行を頼める', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    const res = await api(`/api/tasks/${created.id}/run`, { method: 'POST' })
    expect(res.status).toBe(202)
    expect(enqueued).toEqual([{ taskId: created.id, trigger: 'manual' }])
  })

  it('実行履歴を一覧できる', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    await api(`/api/tasks/${created.id}/run`, { method: 'POST' })
    const runs = await (await api('/api/runs')).json()
    expect(runs).toHaveLength(1)
    expect(runs[0].taskName).toBe('テストを追加する')
  })

  it('中止を頼める', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    const run = await (await api(`/api/tasks/${created.id}/run`, { method: 'POST' })).json()
    expect((await api(`/api/runs/${run.id}/cancel`, { method: 'POST' })).status).toBe(200)
    expect(cancelled).toEqual([run.id])
  })

  it('ログを読める', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    const run = await (await api(`/api/tasks/${created.id}/run`, { method: 'POST' })).json()
    mkdirSync(path.dirname(run.logPath), { recursive: true })
    writeFileSync(run.logPath, '# 実行ログ\nこんばんは\n')

    const res = await api(`/api/runs/${run.id}/log`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('こんばんは')
  })

  it('ログがまだ無くても落ちない', async () => {
    const created = await (await api('/api/tasks', { method: 'POST', body: JSON.stringify(newTask()) })).json()
    const run = await (await api(`/api/tasks/${created.id}/run`, { method: 'POST' })).json()
    const res = await api(`/api/runs/${run.id}/log`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
})

describe('リポジトリの候補', () => {
  it('許可ルート配下の git リポジトリだけを返す', async () => {
    const repos = await (await api('/api/repos')).json()
    const names = repos.map((r) => r.name)
    expect(names).toContain('hair-pin')
    expect(names).toContain('bonsai')
    expect(names).not.toContain('ただのフォルダ')
  })
})

describe('Web UI の配信', () => {
  it('/ で画面が返る', async () => {
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('<title>')
  })

  it('知らないパスは 404', async () => {
    expect((await fetch(`${baseUrl}/存在しない`)).status).toBe(404)
  })

  it('web ディレクトリの外は読ませない', async () => {
    const res = await fetch(`${baseUrl}/../../../etc/passwd`)
    expect([400, 404]).toContain(res.status)
  })
})
