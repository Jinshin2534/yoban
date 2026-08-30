// スケジューラ。tick で予定を拾い、キューに積み、同時実行数を守って走らせる。
import path from 'node:path'
import { decideRun, nextRunAt } from '../core/schedule.js'

const TICK_MS = 30_000
const RESTART_MESSAGE = 'デーモンの再起動により中断されました'

export function createScheduler({
  store,
  execute,
  now = () => new Date(),
  maxConcurrent = 2,
  stateDir,
  tickMs = TICK_MS,
  onEvent = () => {},
}) {
  const queue = [] // { runId, taskId, repoPath }
  const running = new Map() // runId -> { taskId, repoPath, controller }
  let timer = null
  // 作った時点で使える。stop() を呼ぶまで tick と enqueue は動く。
  let stopped = false

  const isBusy = (taskId) =>
    [...running.values()].some((r) => r.taskId === taskId) || queue.some((q) => q.taskId === taskId)

  const repoBusy = (repoPath) => [...running.values()].some((r) => r.repoPath === repoPath)

  function pathsFor(runId) {
    return {
      logPath: path.join(stateDir, 'runs', `${runId}.log`),
      worktreePath: path.join(stateDir, 'worktrees', runId),
    }
  }

  function enqueue(taskId, trigger = 'manual') {
    const task = store.getTask(taskId)
    if (!task) throw new Error(`タスクが見つかりません: ${taskId}`)
    if (isBusy(taskId)) throw new Error(`このタスクは実行中です: ${task.name}`)

    const { logPath } = pathsFor('tmp')
    const run = store.createRun({ taskId, trigger, logPath })
    const paths = pathsFor(run.id)
    store.updateRun(run.id, { logPath: paths.logPath })

    queue.push({ runId: run.id, taskId, repoPath: task.repoPath })
    onEvent({ type: 'queued', runId: run.id, taskId })
    pump()
    return store.getRun(run.id)
  }

  function pump() {
    if (stopped) return
    for (let i = 0; i < queue.length && running.size < maxConcurrent; ) {
      const item = queue[i]
      if (repoBusy(item.repoPath)) {
        i++ // 同じリポジトリが空くまで、この1件は飛ばす
        continue
      }
      queue.splice(i, 1)
      start(item)
    }
  }

  function start({ runId, taskId, repoPath }) {
    const task = store.getTask(taskId)
    const run = store.getRun(runId)
    if (!task || !run) return

    const controller = new AbortController()
    running.set(runId, { taskId, repoPath, controller })
    onEvent({ type: 'started', runId, taskId })

    const paths = pathsFor(runId)
    Promise.resolve()
      .then(() => execute({ task, run, store, signal: controller.signal, ...paths }))
      .catch((err) => {
        store.updateRun(runId, {
          status: 'failed',
          errorMessage: `実行中に想定外のエラー: ${err.message}`,
          endedAt: new Date().toISOString(),
        })
      })
      .finally(() => {
        running.delete(runId)
        onEvent({ type: 'finished', runId, taskId })
        pump()
      })
  }

  /** 予定を1回ぶん確認する */
  async function tick() {
    if (stopped) return
    const at = now()
    for (const task of store.dueTasks(at)) {
      const decision = decideRun(task, at)
      if (decision === 'wait') continue

      // 走らせる前に次回時刻を確定させる（実行が長引いても二重に拾わない）
      const next = task.schedule?.type === 'once' ? null : nextRunAt(task.schedule, at)
      store.setNextRunAt(task.id, next ? next.toISOString() : null)
      if (task.schedule?.type === 'once') store.updateTask(task.id, { enabled: false })

      if (decision === 'skip') {
        onEvent({ type: 'skipped', taskId: task.id })
        continue
      }
      if (isBusy(task.id)) continue
      enqueue(task.id, 'schedule')
    }
    pump()
  }

  function cancel(runId) {
    const active = running.get(runId)
    if (active) {
      active.controller.abort()
      return true
    }
    const index = queue.findIndex((q) => q.runId === runId)
    if (index >= 0) {
      queue.splice(index, 1)
      store.updateRun(runId, {
        status: 'cancelled',
        errorMessage: '実行前に取り消されました',
        endedAt: new Date().toISOString(),
      })
      return true
    }
    return false
  }

  function start_() {
    if (timer) return
    stopped = false
    store.closeStaleRuns(RESTART_MESSAGE)
    timer = setInterval(() => {
      tick().catch((err) => onEvent({ type: 'error', message: err.message }))
    }, tickMs)
    timer.unref?.()
    tick().catch((err) => onEvent({ type: 'error', message: err.message }))
  }

  function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
  }

  function status() {
    return {
      running: running.size,
      queued: queue.length,
      runningRuns: [...running.entries()].map(([runId, r]) => ({ runId, taskId: r.taskId })),
      queuedRuns: queue.map((q) => ({ runId: q.runId, taskId: q.taskId })),
      stopped,
    }
  }

  return { start: start_, stop, tick, enqueue, cancel, status }
}
