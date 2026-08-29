// スケジュールの解釈と次回実行時刻の計算。副作用なし・時計は引数で受け取る。

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_JA = { sun: '日', mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土' }
const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

// tick は 30 秒間隔なので、これくらいの遅れは「予定どおり」とみなす
const ON_TIME_TOLERANCE_MS = 90_000
const DEFAULT_GRACE_HOURS = 6

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
const TIME = /^(\d{2}):(\d{2})$/

/** 'YYYY-MM-DDTHH:MM' をローカル時刻の Date として読む */
export function parseLocalDateTime(text) {
  const m = typeof text === 'string' && text.match(LOCAL_DATETIME)
  if (!m) throw new Error(`日時の形式が正しくありません: ${text}`)
  const [, y, mo, d, h, mi, s] = m
  const date = new Date(+y, +mo - 1, +d, +h, +mi, s ? +s : 0, 0)
  if (Number.isNaN(date.getTime())) throw new Error(`日時として解釈できません: ${text}`)
  return date
}

function parseTimeOfDay(text) {
  const m = typeof text === 'string' && text.match(TIME)
  if (!m) throw new Error(`時刻は HH:MM 形式で指定してください: ${text}`)
  const h = +m[1]
  const mi = +m[2]
  if (h > 23 || mi > 59) throw new Error(`時刻の範囲が不正です: ${text}`)
  return { h, mi }
}

export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('スケジュールが指定されていません')
  switch (schedule.type) {
    case 'once':
      parseLocalDateTime(schedule.at)
      return schedule
    case 'daily':
      parseTimeOfDay(schedule.time)
      return schedule
    case 'weekly': {
      parseTimeOfDay(schedule.time)
      const days = schedule.days
      if (!Array.isArray(days) || days.length === 0) throw new Error('曜日を1つ以上指定してください')
      for (const d of days) {
        if (!DAY_KEYS.includes(d)) throw new Error(`曜日の指定が不正です: ${d}`)
      }
      return schedule
    }
    case 'interval': {
      const h = schedule.hours
      if (!Number.isFinite(h) || h <= 0) throw new Error('interval の hours は 1 以上の数値で指定してください')
      if (schedule.anchor != null) parseLocalDateTime(schedule.anchor)
      return schedule
    }
    default:
      throw new Error(`不明なスケジュール種別: ${schedule?.type}`)
  }
}

function atTimeOnDay(base, dayOffset, { h, mi }) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, mi, 0, 0)
}

/**
 * from より後の、最も近い実行時刻を返す。もう実行しないなら null。
 * 同じ時刻を二度返さないよう、境界は常に「from より真に後」で判定する。
 */
export function nextRunAt(schedule, from = new Date()) {
  validateSchedule(schedule)
  switch (schedule.type) {
    case 'once': {
      const at = parseLocalDateTime(schedule.at)
      return at > from ? at : null
    }
    case 'daily': {
      const t = parseTimeOfDay(schedule.time)
      const today = atTimeOnDay(from, 0, t)
      return today > from ? today : atTimeOnDay(from, 1, t)
    }
    case 'weekly': {
      const t = parseTimeOfDay(schedule.time)
      for (let i = 0; i <= 7; i++) {
        const candidate = atTimeOnDay(from, i, t)
        if (candidate > from && schedule.days.includes(DAY_KEYS[candidate.getDay()])) return candidate
      }
      return null
    }
    case 'interval': {
      const step = schedule.hours * 3600_000
      const anchor = schedule.anchor ? parseLocalDateTime(schedule.anchor) : from
      if (anchor > from) return anchor
      const k = Math.floor((from.getTime() - anchor.getTime()) / step) + 1
      return new Date(anchor.getTime() + k * step)
    }
    default:
      return null
  }
}

/**
 * 今このタスクを走らせるべきか。
 *  wait … まだ時刻が来ていない
 *  run  … 走らせる
 *  skip … 遅れすぎ（または catchUp 無効）なので今回は見送り、次回に回す
 */
export function decideRun(task, now = new Date()) {
  if (!task?.nextRunAt) return 'wait'
  const due = task.nextRunAt instanceof Date ? task.nextRunAt : new Date(task.nextRunAt)
  const delay = now.getTime() - due.getTime()
  if (delay < 0) return 'wait'
  if (delay <= ON_TIME_TOLERANCE_MS) return 'run'
  if (!task.catchUp) return 'skip'
  const graceMs = (task.catchUpGraceHours ?? DEFAULT_GRACE_HOURS) * 3600_000
  return delay <= graceMs ? 'run' : 'skip'
}

export function describeSchedule(schedule) {
  switch (schedule?.type) {
    case 'once':
      return `1回だけ ${String(schedule.at).replace('T', ' ')}`
    case 'daily':
      return `毎日 ${schedule.time}`
    case 'weekly': {
      const days = [...schedule.days]
        .sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b))
        .map((d) => DAY_JA[d])
        .join('・')
      return `毎週 ${days} ${schedule.time}`
    }
    case 'interval':
      return `${schedule.hours}時間ごと`
    default:
      return '不明'
  }
}
