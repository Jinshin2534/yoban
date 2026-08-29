// デーモンの組み立て。store・scheduler・HTTP サーバーを1つにまとめる。
import { openStore } from './store.js'
import { createScheduler } from './scheduler.js'
import { createServer } from './api.js'
import { executeRun } from '../runner/executor.js'

export function createDaemon(config) {
  const store = openStore(config.dbPath)

  const scheduler = createScheduler({
    store,
    stateDir: config.stateDir,
    maxConcurrent: config.maxConcurrent,
    execute: ({ task, run, signal, logPath, worktreePath }) =>
      executeRun({ task, run, store, logPath, worktreePath, signal }),
    onEvent: (event) => {
      if (event.type === 'error') console.error('[夜番] スケジューラのエラー:', event.message)
    },
  })

  const server = createServer({ store, scheduler, config })

  return {
    store,
    scheduler,
    server,
    start() {
      scheduler.start()
      return new Promise((resolve) => server.listen(config.port, config.host, resolve))
    },
    async stop() {
      scheduler.stop()
      await new Promise((resolve) => server.close(resolve))
      store.close()
    },
  }
}
