#!/usr/bin/env node
// 夜番の CLI。Web UI と同じ API を叩くので、両者は常に同じ状態を見る。
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from '../src/cli/args.js'
import { config } from '../src/config.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${config.label}.plist`)
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'yoban')

const HELP = `夜番 (yoban) — 時刻を指定して Claude Code / Codex にコーディングタスクを投げ、PR まで作る

つかいかた:
  yoban list                        タスク一覧と次回実行時刻
  yoban show <task>                 タスクの詳細
  yoban add --name <名前> --repo <パス> --prompt <本文> --daily 02:00
  yoban edit <task> [オプション]     タスクの部分更新
  yoban rm <task>                   タスクを削除
  yoban enable <task> / disable <task>
  yoban run <task>                  今すぐ実行
  yoban runs [--task <task>] [--limit 20]
  yoban logs <run> [--follow]       実行ログ
  yoban cancel <run>                実行中の run を止める
  yoban status                      デーモンの状態
  yoban open                        Web UI をブラウザで開く
  yoban serve                       前面でデーモンを起動（デバッグ用）
  yoban install / uninstall         launchd への登録・解除

スケジュール:
  --daily 02:00            毎日
  --weekly mon,thu@02:00   毎週
  --every 6h               N時間ごと
  --once "2026-08-30 09:00"  1回だけ

そのほかのオプション:
  --agent claude|codex   --model <名前>   --base <ブランチ>
  --prompt <本文> / --prompt-file <パス> / 標準入力
  --setup "pnpm install"   --verify "pnpm test"
  --timeout <分>   --grace <時間>   --no-draft   --keep-worktree   --no-catch-up
  --json                 結果を JSON で出す
`

function die(message, code = 1) {
  console.error(message)
  process.exit(code)
}

async function callApi(pathname, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(`${config.baseUrl}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-yoban': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    die(
      `夜番のデーモンにつながりません（${config.baseUrl}）。\n` +
        `  常駐させる:  yoban install\n` +
        `  前面で試す:  yoban serve`,
    )
  }
  if (res.status === 204) return null
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) die(`エラー (${res.status}): ${data?.error ?? text}`)
  return data
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const STATUS_LABEL = {
  queued: '待機',
  running: '実行中',
  success: '成功',
  no_changes: '変更なし',
  failed: '失敗',
  timeout: 'タイムアウト',
  cancelled: '中止',
}

async function resolveTask(ref) {
  if (!ref) die('タスクを指定してください（ID の先頭数文字か名前）')
  const tasks = await callApi('/api/tasks')
  const matches = tasks.filter(
    (t) => t.id === ref || t.id.startsWith(ref.toUpperCase()) || t.name === ref || t.name.includes(ref),
  )
  if (matches.length === 0) die(`タスクが見つかりません: ${ref}`)
  if (matches.length > 1) die(`タスクを1つに絞れません: ${matches.map((t) => t.name).join(' / ')}`)
  return matches[0]
}

async function resolveRun(ref) {
  if (!ref) die('run を指定してください（ID の先頭数文字）')
  const runs = await callApi('/api/runs?limit=200')
  const matches = runs.filter((r) => r.id === ref || r.id.startsWith(ref.toUpperCase()))
  if (matches.length === 0) die(`実行が見つかりません: ${ref}`)
  return matches[0]
}

function readPrompt(options) {
  if (options.prompt) return options.prompt
  if (options.promptFile) return readFileSync(options.promptFile, 'utf8')
  if (!process.stdin.isTTY) {
    const stdin = readFileSync(0, 'utf8')
    if (stdin.trim()) return stdin
  }
  return null
}

function taskFieldsFromOptions(options, { requirePrompt }) {
  const fields = {}
  const map = {
    name: 'name',
    repoPath: 'repoPath',
    agent: 'agent',
    model: 'model',
    baseBranch: 'baseBranch',
    setupCommand: 'setupCommand',
    verifyCommand: 'verifyCommand',
    timeoutMinutes: 'timeoutMinutes',
    catchUpGraceHours: 'catchUpGraceHours',
    schedule: 'schedule',
    draftPr: 'draftPr',
    keepWorktreeOnFailure: 'keepWorktreeOnFailure',
    catchUp: 'catchUp',
  }
  for (const [from, to] of Object.entries(map)) {
    if (options[from] !== undefined) fields[to] = options[from]
  }
  const prompt = readPrompt(options)
  if (prompt) fields.prompt = prompt
  else if (requirePrompt) die('プロンプトを指定してください（--prompt / --prompt-file / 標準入力）')
  return fields
}

// ---- コマンド ----

const commands = {
  async list(_args, options) {
    const tasks = await callApi('/api/tasks')
    if (options.json) return console.log(JSON.stringify(tasks, null, 2))
    if (tasks.length === 0) return console.log('タスクはまだありません。yoban add で追加できます。')
    for (const t of tasks) {
      const last = t.lastRun ? `${STATUS_LABEL[t.lastRun.status] ?? t.lastRun.status}` : '—'
      console.log(
        [
          `${t.enabled ? '●' : '○'} ${t.id.slice(0, 6)}  ${t.name}`,
          `    ${t.agent}  ${t.scheduleText}  次回 ${formatTime(t.nextRunAt)}  直近 ${last}`,
          `    ${t.repoPath}`,
        ].join('\n'),
      )
    }
  },

  async show(args, options) {
    const task = await resolveTask(args[0])
    if (options.json) return console.log(JSON.stringify(task, null, 2))
    console.log(`${task.name} (${task.id})`)
    console.log(`  リポジトリ: ${task.repoPath}`)
    console.log(`  エージェント: ${task.agent}${task.model ? ` (${task.model})` : ''}`)
    console.log(`  スケジュール: ${task.scheduleText}  次回 ${formatTime(task.nextRunAt)}`)
    console.log(`  base: ${task.baseBranch ?? '（自動検出）'}`)
    console.log(`  準備: ${task.setupCommand ?? '—'}   検証: ${task.verifyCommand ?? '—'}`)
    console.log(`  タイムアウト: ${task.timeoutMinutes}分   catch-up: ${task.catchUp ? `${task.catchUpGraceHours}時間まで` : 'しない'}`)
    console.log(`  PR: ${task.draftPr ? 'draft' : '通常'}`)
    console.log('\n--- プロンプト ---')
    console.log(task.prompt)
  },

  async add(_args, options) {
    const fields = taskFieldsFromOptions(options, { requirePrompt: true })
    if (!fields.name) die('--name を指定してください')
    if (!fields.repoPath) die('--repo を指定してください')
    if (!fields.schedule) die('スケジュールを指定してください（--daily / --weekly / --every / --once）')
    if (!fields.agent) fields.agent = 'claude'
    const task = await callApi('/api/tasks', { method: 'POST', body: fields })
    console.log(`追加しました: ${task.name} (${task.id.slice(0, 6)})  次回 ${formatTime(task.nextRunAt)}`)
  },

  async edit(args, options) {
    const target = await resolveTask(args[0])
    const fields = taskFieldsFromOptions(options, { requirePrompt: false })
    if (Object.keys(fields).length === 0) die('変更する項目を指定してください')
    const task = await callApi(`/api/tasks/${target.id}`, { method: 'PATCH', body: fields })
    console.log(`更新しました: ${task.name}  次回 ${formatTime(task.nextRunAt)}`)
  },

  async rm(args) {
    const task = await resolveTask(args[0])
    await callApi(`/api/tasks/${task.id}`, { method: 'DELETE' })
    console.log(`削除しました: ${task.name}`)
  },

  async enable(args) {
    const task = await resolveTask(args[0])
    const updated = await callApi(`/api/tasks/${task.id}`, { method: 'PATCH', body: { enabled: true } })
    console.log(`有効にしました: ${updated.name}  次回 ${formatTime(updated.nextRunAt)}`)
  },

  async disable(args) {
    const task = await resolveTask(args[0])
    await callApi(`/api/tasks/${task.id}`, { method: 'PATCH', body: { enabled: false } })
    console.log(`無効にしました: ${task.name}`)
  },

  async run(args) {
    const task = await resolveTask(args[0])
    const run = await callApi(`/api/tasks/${task.id}/run`, { method: 'POST' })
    console.log(`実行を頼みました: ${task.name} (run ${run.id.slice(0, 6)})`)
    console.log(`ログ: yoban logs ${run.id.slice(0, 6)} --follow`)
  },

  async runs(args, options) {
    const task = options.task ? await resolveTask(options.task) : null
    const query = new URLSearchParams()
    if (task) query.set('taskId', task.id)
    query.set('limit', String(options.limit ?? 20))
    const runs = await callApi(`/api/runs?${query}`)
    if (options.json) return console.log(JSON.stringify(runs, null, 2))
    if (runs.length === 0) return console.log('まだ実行はありません。')
    for (const r of runs) {
      const label = STATUS_LABEL[r.status] ?? r.status
      console.log(
        `${r.id.slice(0, 6)}  ${label.padEnd(6, '　')}  ${formatTime(r.startedAt ?? r.createdAt)}  ${r.taskName}` +
          `${r.prUrl ? `\n        ${r.prUrl}` : ''}${r.errorMessage ? `\n        ${r.errorMessage}` : ''}`,
      )
    }
  },

  async logs(args, options) {
    const run = await resolveRun(args[0])
    if (!options.follow) {
      const res = await fetch(`${config.baseUrl}/api/runs/${run.id}/log`)
      process.stdout.write(await res.text())
      return
    }
    const res = await fetch(`${config.baseUrl}/api/runs/${run.id}/log?follow=1`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const line of decoder.decode(value).split('\n')) {
        if (line.startsWith('data: ')) {
          const payload = JSON.parse(line.slice(6))
          if (typeof payload === 'string') process.stdout.write(payload)
          else if (payload?.status) console.log(`\n--- ${STATUS_LABEL[payload.status] ?? payload.status} ---`)
        }
      }
    }
  },

  async cancel(args) {
    const run = await resolveRun(args[0])
    const result = await callApi(`/api/runs/${run.id}/cancel`, { method: 'POST' })
    console.log(result.cancelled ? '中止しました。' : 'その run は走っていません。')
  },

  async status(_args, options) {
    const health = await callApi('/api/health')
    if (options.json) return console.log(JSON.stringify(health, null, 2))
    console.log(`デーモン: 動作中 (${config.baseUrl})`)
    console.log(`タスク: ${health.tasks} 件   実行中: ${health.running}   待機: ${health.queued}`)
  },

  async open() {
    spawn('open', [config.baseUrl], { detached: true, stdio: 'ignore' }).unref()
    console.log(`ブラウザで開きました: ${config.baseUrl}`)
  },

  async serve() {
    const { createDaemon } = await import('../src/server/daemon.js')
    const daemon = createDaemon(config)
    await daemon.start()
    console.log(`夜番のデーモンを起動しました: ${config.baseUrl}`)
    console.log(`状態の保存先: ${config.stateDir}`)
    console.log(`対象ルート: ${config.allowedRoots.join(', ')}`)
    const shutdown = async () => {
      console.log('\n終了します。')
      await daemon.stop()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  },

  async install() {
    mkdirSync(path.dirname(PLIST_PATH), { recursive: true })
    mkdirSync(LOG_DIR, { recursive: true })
    const plist = renderPlist()
    writeFileSync(PLIST_PATH, plist)
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
    } catch {
      // 未登録なら unload は失敗する。問題ない。
    }
    execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'inherit' })
    console.log(`launchd に登録しました: ${PLIST_PATH}`)
    console.log(`ログイン時に自動起動し、落ちても再起動します。`)
    console.log(`Web UI: ${config.baseUrl}`)
  },

  async uninstall() {
    if (!existsSync(PLIST_PATH)) return console.log('登録されていません。')
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' })
    } catch {
      // すでに止まっている
    }
    unlinkSync(PLIST_PATH)
    console.log(`登録を解除しました: ${PLIST_PATH}`)
  },

  async help() {
    console.log(HELP)
  },
}

function renderPlist() {
  const nodePath = process.execPath
  const script = path.join(ROOT, 'bin', 'yoban.js')
  const pathEnv = `${path.dirname(nodePath)}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${config.label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>--no-warnings</string>
    <string>${script}</string>
    <string>serve</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT.replace(/\/$/, '')}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${os.homedir()}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${path.join(LOG_DIR, 'out.log')}</string>

  <key>StandardErrorPath</key>
  <string>${path.join(LOG_DIR, 'err.log')}</string>
</dict>
</plist>
`
}

async function main() {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    die(`${err.message}\n\n${HELP}`)
  }
  const command = commands[parsed.command]
  if (!command) die(`知らないコマンドです: ${parsed.command}\n\n${HELP}`)
  try {
    await command(parsed.args, parsed.options)
  } catch (err) {
    die(`エラー: ${err.message}`)
  }
}

main()
