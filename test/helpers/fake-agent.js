#!/usr/bin/env node
// テスト用の偽エージェント。本物の AI CLI の代わりに使う（課金も通信もしない）。
//   --write <path>   … 作業ディレクトリにファイルを書く
//   --content <text> … 書く内容
//   --print <text>   … 標準出力に出す
//   --sleep <ms>     … 終了前に待つ（タイムアウト検証用）
//   --exit <code>    … 終了コード
//   --read-stdin     … 標準入力を読み切ってから終わる（stdin が閉じているかの検証用）
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const get = (flag, fallback = null) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const has = (flag) => args.includes(flag)

const file = get('--write')
if (file) {
  const target = path.resolve(process.cwd(), file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, get('--content', '偽エージェントが書きました\n'))
}

const printed = get('--print')
if (printed) process.stdout.write(printed + '\n')

const sleepMs = Number(get('--sleep', '0'))
const exitCode = Number(get('--exit', '0'))

async function main() {
  if (has('--read-stdin')) {
    for await (const _chunk of process.stdin) {
      // 読み捨て。stdin が閉じていれば即座に終わる。
    }
    process.stdout.write('stdin closed\n')
  }
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs))
  process.exit(exitCode)
}

main()
