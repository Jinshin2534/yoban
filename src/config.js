// 設定。環境変数で上書きできる（テストや別ポートでの起動用）。
import os from 'node:os'
import path from 'node:path'

const home = os.homedir()

export const config = {
  port: Number(process.env.YOBAN_PORT ?? 5460),
  host: '127.0.0.1',
  stateDir: process.env.YOBAN_STATE_DIR ?? path.join(home, 'Library', 'Application Support', 'yoban'),
  allowedRoots: (process.env.YOBAN_ROOTS ?? path.join(home, 'ranzo_project'))
    .split(':')
    .filter(Boolean),
  maxConcurrent: Number(process.env.YOBAN_MAX_CONCURRENT ?? 2),
  home,
}

config.dbPath = path.join(config.stateDir, 'yoban.db')
config.baseUrl = `http://${config.host}:${config.port}`
config.label = 'com.nokokoro.yoban'
