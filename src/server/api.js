// HTTP API と Web UI の配信。127.0.0.1 でしか待ち受けない前提。
import http from 'node:http'
import path from 'node:path'
import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateTask, mergeTask } from '../core/task.js'
import { nextRunAt, describeSchedule } from '../core/schedule.js'

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url))
const MAX_BODY = 1_000_000

// ブラウザから勝手に叩かれないための合図。クロスオリジンではこのヘッダを付けられない。
const GUARD_HEADER = 'x-yoban'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** 検証エラーは 400 として扱う */
function asBadRequest(fn) {
  try {
    return fn()
  } catch (err) {
    throw new HttpError(400, err.message)
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY) {
        reject(new HttpError(413, '本文が大きすぎます'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new HttpError(400, 'JSON として読めませんでした'))
      }
    })
    req.on('error', reject)
  })
}

function decorateTask(task, store) {
  return {
    ...task,
    scheduleText: describeSchedule(task.schedule),
    lastRun: store.lastRun(task.id),
  }
}

function scheduleNext(store, task) {
  if (!task.enabled) return store.setNextRunAt(task.id, null)
  const next = nextRunAt(task.schedule, new Date())
  return store.setNextRunAt(task.id, next ? next.toISOString() : null)
}

function listRepos(allowedRoots) {
  const repos = []
  for (const root of allowedRoots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(root, entry.name)
      if (existsSync(path.join(full, '.git'))) repos.push({ name: entry.name, path: full })
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = path.resolve(WEB_DIR, rel)
  if (!target.startsWith(path.resolve(WEB_DIR) + path.sep)) {
    json(res, 400, { error: '不正なパスです' })
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    json(res, 404, { error: '見つかりません' })
    return
  }
  res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(target)] ?? 'application/octet-stream' })
  res.end(readFileSync(target))
}

/** 実行ログを返す。follow=1 なら SSE で追記を流し続ける。 */
function serveLog(req, res, run, follow) {
  const logPath = run.logPath
  if (!follow) {
    if (!logPath || !existsSync(logPath)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    createReadStream(logPath).pipe(res)
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  let offset = 0
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const pump = () => {
    if (!logPath || !existsSync(logPath)) return
    const size = statSync(logPath).size
    if (size <= offset) return
    const stream = createReadStream(logPath, { start: offset, end: size - 1, encoding: 'utf8' })
    let chunk = ''
    stream.on('data', (d) => {
      chunk += d
    })
    stream.on('end', () => {
      offset = size
      if (chunk) send('log', chunk)
    })
  }

  pump()
  const timer = setInterval(pump, 500)
  const close = () => {
    clearInterval(timer)
    res.end()
  }
  req.on('close', close)
  // 実行が終わっていれば、追いつき次第すぐ閉じる
  const finishWatcher = setInterval(() => {
    const current = res.locals?.getRun?.() ?? null
    if (current && !['queued', 'running'].includes(current.status)) {
      pump()
      setTimeout(() => {
        send('done', { status: current.status })
        clearInterval(finishWatcher)
        close()
      }, 600)
    }
  }, 1000)
  req.on('close', () => clearInterval(finishWatcher))
}

export function createServer({ store, scheduler, config }) {
  const allowedRoots = config.allowedRoots
  const validationOptions = { allowedRoots, home: config.home }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)
    const method = req.method ?? 'GET'

    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname)
      return
    }

    if (method !== 'GET' && req.headers[GUARD_HEADER] !== '1') {
      json(res, 403, { error: `${GUARD_HEADER} ヘッダが必要です（ブラウザからの誤操作を防ぐため）` })
      return
    }

    const segments = pathname.split('/').filter(Boolean) // ['api', 'tasks', ':id', ...]
    const [, resource, id, action] = segments

    if (resource === 'health' && method === 'GET') {
      const s = scheduler.status()
      return json(res, 200, { ok: true, running: s.running, queued: s.queued, tasks: store.listTasks().length })
    }

    if (resource === 'repos' && method === 'GET') {
      return json(res, 200, listRepos(allowedRoots))
    }

    if (resource === 'tasks') {
      if (!id && method === 'GET') {
        return json(res, 200, store.listTasks().map((t) => decorateTask(t, store)))
      }
      if (!id && method === 'POST') {
        const body = await readBody(req)
        const fields = asBadRequest(() => validateTask(body, validationOptions))
        const created = store.createTask(fields)
        return json(res, 201, decorateTask(scheduleNext(store, created), store))
      }

      const task = id ? store.getTask(id) : null
      if (!task) throw new HttpError(404, 'タスクが見つかりません')

      if (action === 'run' && method === 'POST') {
        try {
          return json(res, 202, scheduler.enqueue(task.id, 'manual'))
        } catch (err) {
          throw new HttpError(409, err.message)
        }
      }
      if (!action && method === 'GET') return json(res, 200, decorateTask(task, store))
      if (!action && method === 'PATCH') {
        const patch = await readBody(req)
        const merged = asBadRequest(() => mergeTask(task, patch, validationOptions))
        const updated = store.updateTask(task.id, merged)
        return json(res, 200, decorateTask(scheduleNext(store, updated), store))
      }
      if (!action && method === 'DELETE') {
        store.deleteTask(task.id)
        res.writeHead(204)
        return res.end()
      }
    }

    if (resource === 'runs') {
      if (!id && method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500)
        return json(res, 200, store.listRuns({ taskId: url.searchParams.get('taskId') ?? undefined, limit }))
      }
      const run = id ? store.getRun(id) : null
      if (!run) throw new HttpError(404, '実行が見つかりません')

      if (!action && method === 'GET') return json(res, 200, run)
      if (action === 'log' && method === 'GET') {
        res.locals = { getRun: () => store.getRun(run.id) }
        return serveLog(req, res, run, url.searchParams.get('follow') === '1')
      }
      if (action === 'cancel' && method === 'POST') {
        return json(res, 200, { cancelled: scheduler.cancel(run.id) })
      }
    }

    throw new HttpError(404, '見つかりません')
  }

  return http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (res.headersSent) return res.end()
      const status = err instanceof HttpError ? err.status : 500
      json(res, status, { error: err.message })
    })
  })
}
