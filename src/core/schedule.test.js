import { describe, it, expect } from 'vitest'
import { nextRunAt, decideRun, describeSchedule, validateSchedule } from './schedule.js'

// ローカル時刻で組み立てる（テストがタイムゾーンに依存しないように）
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0)

describe('nextRunAt / once', () => {
  it('未来の指定時刻をそのまま返す', () => {
    const got = nextRunAt({ type: 'once', at: '2026-08-30T09:00' }, at(2026, 8, 29, 12, 0))
    expect(got).toEqual(at(2026, 8, 30, 9, 0))
  })

  it('すでに過ぎていたら null（二度と走らない）', () => {
    const got = nextRunAt({ type: 'once', at: '2026-08-30T09:00' }, at(2026, 8, 30, 9, 0, 0))
    expect(got).toBeNull()
  })
})

describe('nextRunAt / daily', () => {
  it('今日まだ来ていなければ今日', () => {
    const got = nextRunAt({ type: 'daily', time: '02:00' }, at(2026, 8, 29, 1, 0))
    expect(got).toEqual(at(2026, 8, 29, 2, 0))
  })

  it('今日の分が過ぎていれば翌日', () => {
    const got = nextRunAt({ type: 'daily', time: '02:00' }, at(2026, 8, 29, 3, 0))
    expect(got).toEqual(at(2026, 8, 30, 2, 0))
  })

  it('ちょうど同時刻なら次の日（同じ時刻を二度返さない）', () => {
    const got = nextRunAt({ type: 'daily', time: '02:00' }, at(2026, 8, 29, 2, 0))
    expect(got).toEqual(at(2026, 8, 30, 2, 0))
  })

  it('月をまたぐ', () => {
    const got = nextRunAt({ type: 'daily', time: '02:00' }, at(2026, 8, 31, 5, 0))
    expect(got).toEqual(at(2026, 9, 1, 2, 0))
  })

  it('年をまたぐ', () => {
    const got = nextRunAt({ type: 'daily', time: '02:00' }, at(2026, 12, 31, 5, 0))
    expect(got).toEqual(at(2027, 1, 1, 2, 0))
  })
})

describe('nextRunAt / weekly', () => {
  // 2026-08-29 は土曜日
  it('同じ週の先の曜日を選ぶ', () => {
    const got = nextRunAt({ type: 'weekly', days: ['sun'], time: '02:00' }, at(2026, 8, 29, 12, 0))
    expect(got).toEqual(at(2026, 8, 30, 2, 0))
  })

  it('週をまたいで折り返す', () => {
    const got = nextRunAt({ type: 'weekly', days: ['mon'], time: '02:00' }, at(2026, 8, 29, 12, 0))
    expect(got).toEqual(at(2026, 8, 31, 2, 0))
  })

  it('複数曜日のうち最も近いものを選ぶ', () => {
    const s = { type: 'weekly', days: ['mon', 'thu'], time: '02:00' }
    // 火曜 9/1 から見ると次は木曜 9/3
    expect(nextRunAt(s, at(2026, 9, 1, 12, 0))).toEqual(at(2026, 9, 3, 2, 0))
    // 木曜 9/3 の 3時から見ると次は月曜 9/7
    expect(nextRunAt(s, at(2026, 9, 3, 3, 0))).toEqual(at(2026, 9, 7, 2, 0))
  })

  it('当日の時刻前ならその日を選ぶ', () => {
    const got = nextRunAt({ type: 'weekly', days: ['sat'], time: '23:00' }, at(2026, 8, 29, 12, 0))
    expect(got).toEqual(at(2026, 8, 29, 23, 0))
  })
})

describe('nextRunAt / interval', () => {
  it('anchor が未来ならその時刻', () => {
    const s = { type: 'interval', hours: 6, anchor: '2026-08-29T12:00' }
    expect(nextRunAt(s, at(2026, 8, 29, 9, 0))).toEqual(at(2026, 8, 29, 12, 0))
  })

  it('anchor から N 時間刻みで次を返す', () => {
    const s = { type: 'interval', hours: 6, anchor: '2026-08-29T00:00' }
    expect(nextRunAt(s, at(2026, 8, 29, 1, 0))).toEqual(at(2026, 8, 29, 6, 0))
    expect(nextRunAt(s, at(2026, 8, 29, 6, 0))).toEqual(at(2026, 8, 29, 12, 0))
    expect(nextRunAt(s, at(2026, 8, 30, 5, 0))).toEqual(at(2026, 8, 30, 6, 0))
  })

  it('長く止まっていても次の1点だけを返す', () => {
    const s = { type: 'interval', hours: 6, anchor: '2026-08-01T00:00' }
    expect(nextRunAt(s, at(2026, 8, 29, 13, 0))).toEqual(at(2026, 8, 29, 18, 0))
  })
})

describe('validateSchedule', () => {
  it.each([
    [{ type: 'nope' }],
    [{ type: 'daily' }],
    [{ type: 'daily', time: '25:00' }],
    [{ type: 'daily', time: '2:0' }],
    [{ type: 'weekly', time: '02:00', days: [] }],
    [{ type: 'weekly', time: '02:00', days: ['funday'] }],
    [{ type: 'interval', hours: 0 }],
    [{ type: 'interval', hours: -3 }],
    [{ type: 'once', at: 'いつか' }],
    [null],
  ])('不正な指定は例外を投げる: %j', (bad) => {
    expect(() => validateSchedule(bad)).toThrow()
  })

  it('正しい指定は通る', () => {
    expect(() => validateSchedule({ type: 'daily', time: '02:00' })).not.toThrow()
    expect(() => validateSchedule({ type: 'weekly', days: ['mon'], time: '23:59' })).not.toThrow()
    expect(() => validateSchedule({ type: 'interval', hours: 6 })).not.toThrow()
    expect(() => validateSchedule({ type: 'once', at: '2026-08-30T09:00' })).not.toThrow()
  })

  it('anchor が無い interval は現在時刻を anchor にできる', () => {
    const got = nextRunAt({ type: 'interval', hours: 3 }, at(2026, 8, 29, 1, 0))
    expect(got).toEqual(at(2026, 8, 29, 4, 0))
  })
})

describe('decideRun', () => {
  const base = { nextRunAt: at(2026, 8, 29, 2, 0).toISOString(), catchUp: true, catchUpGraceHours: 6 }

  it('予定時刻より前は待つ', () => {
    expect(decideRun(base, at(2026, 8, 29, 1, 59))).toBe('wait')
  })

  it('予定時刻ちょうどは走る', () => {
    expect(decideRun(base, at(2026, 8, 29, 2, 0))).toBe('run')
  })

  it('猶予の内側で遅れていれば追いかけて走る', () => {
    expect(decideRun(base, at(2026, 8, 29, 7, 30))).toBe('run')
  })

  it('猶予を超えて遅れていたら見送る', () => {
    expect(decideRun(base, at(2026, 8, 29, 9, 0))).toBe('skip')
  })

  it('catchUp が無効なら少しの遅れでも見送る', () => {
    const t = { ...base, catchUp: false }
    expect(decideRun(t, at(2026, 8, 29, 2, 30))).toBe('skip')
  })

  it('catchUp が無効でも予定時刻ちょうど付近なら走る（tick の粒度ぶんは許す）', () => {
    const t = { ...base, catchUp: false }
    expect(decideRun(t, new Date(at(2026, 8, 29, 2, 0).getTime() + 30_000))).toBe('run')
  })

  it('nextRunAt が無いタスクは待ちのまま', () => {
    expect(decideRun({ ...base, nextRunAt: null }, at(2030, 1, 1))).toBe('wait')
  })
})

describe('describeSchedule', () => {
  it('人が読める文字列にする', () => {
    expect(describeSchedule({ type: 'daily', time: '02:00' })).toBe('毎日 02:00')
    expect(describeSchedule({ type: 'weekly', days: ['mon', 'thu'], time: '02:00' })).toBe('毎週 月・木 02:00')
    expect(describeSchedule({ type: 'interval', hours: 6 })).toBe('6時間ごと')
    expect(describeSchedule({ type: 'once', at: '2026-08-30T09:00' })).toBe('1回だけ 2026-08-30 09:00')
  })
})
