// 実行ログをファイルに追記する。UI はこのファイルを読んで表示する。
import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs'
import path from 'node:path'

export function createLogWriter(logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a')
  let closed = false
  return {
    write(text) {
      if (closed || text == null) return
      writeSync(fd, String(text))
    },
    line(text) {
      this.write(`${text}\n`)
    },
    close() {
      if (closed) return
      closed = true
      closeSync(fd)
    },
  }
}
