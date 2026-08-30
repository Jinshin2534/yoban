// CLI の引数解釈。純粋関数なのでテストしやすい。
import { validateSchedule, parseLocalDateTime } from '../core/schedule.js'

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const STRING_FLAGS = {
  '--name': 'name',
  '--repo': 'repoPath',
  '--agent': 'agent',
  '--model': 'model',
  '--prompt': 'prompt',
  '--prompt-file': 'promptFile',
  '--setup': 'setupCommand',
  '--verify': 'verifyCommand',
  '--base': 'baseBranch',
  '--task': 'task',
}

const NUMBER_FLAGS = {
  '--timeout': 'timeoutMinutes',
  '--limit': 'limit',
  '--grace': 'catchUpGraceHours',
}

const BOOLEAN_FLAGS = {
  '--no-draft': ['draftPr', false],
  '--draft': ['draftPr', true],
  '--keep-worktree': ['keepWorktreeOnFailure', true],
  '--no-catch-up': ['catchUp', false],
  '--json': ['json', true],
  '--follow': ['follow', true],
  '-f': ['follow', true],
  '--yes': ['yes', true],
  '-y': ['yes', true],
}

function parseWeekly(value) {
  const [daysPart, time] = String(value).split('@')
  if (!time) throw new Error('--weekly は 曜日@時刻 の形で指定してください（例: mon,thu@02:00）')
  const days = daysPart.split(',').map((d) => d.trim().toLowerCase())
  for (const d of days) {
    if (!DAY_KEYS.includes(d)) throw new Error(`曜日の指定が不正です: ${d}（${DAY_KEYS.join('/')}）`)
  }
  return { type: 'weekly', days, time }
}

function parseEvery(value) {
  const m = String(value).trim().match(/^(\d+)\s*h?$/i)
  if (!m) throw new Error(`--every は時間数で指定してください（例: 6h）: ${value}`)
  return { type: 'interval', hours: Number(m[1]) }
}

function parseOnce(value) {
  const normalized = String(value).trim().replace(' ', 'T')
  parseLocalDateTime(normalized) // 形式チェック
  return { type: 'once', at: normalized }
}

export function parseArgs(argv) {
  const options = {}
  const args = []
  let command = null

  const setSchedule = (schedule) => {
    if (options.schedule) throw new Error('スケジュールの指定は1つだけにしてください')
    options.schedule = validateSchedule(schedule)
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]

    if (!token.startsWith('-')) {
      if (command === null) command = token
      else args.push(token)
      continue
    }

    if (BOOLEAN_FLAGS[token]) {
      const [key, value] = BOOLEAN_FLAGS[token]
      options[key] = value
      continue
    }

    const needsValue = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${token} に値がありません`)
      return value
    }

    if (STRING_FLAGS[token]) {
      options[STRING_FLAGS[token]] = needsValue()
      continue
    }
    if (NUMBER_FLAGS[token]) {
      const raw = needsValue()
      const n = Number(raw)
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${token} は整数で指定してください: ${raw}`)
      options[NUMBER_FLAGS[token]] = n
      continue
    }

    switch (token) {
      case '--daily':
        setSchedule({ type: 'daily', time: needsValue() })
        continue
      case '--weekly':
        setSchedule(parseWeekly(needsValue()))
        continue
      case '--every':
        setSchedule(parseEvery(needsValue()))
        continue
      case '--once':
        setSchedule(parseOnce(needsValue()))
        continue
      case '--help':
      case '-h':
        command = 'help'
        continue
      default:
        throw new Error(`知らないオプションです: ${token}`)
    }
  }

  return { command: command ?? 'help', args, options }
}
