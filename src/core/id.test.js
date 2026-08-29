import { describe, it, expect } from 'vitest'
import { newId } from './id.js'

describe('newId', () => {
  it('26 文字の英数字（大文字）になる', () => {
    expect(newId()).toMatch(/^[0-9A-Z]{26}$/)
  })

  it('重複しない', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()))
    expect(ids.size).toBe(5000)
  })

  it('時刻順に並ぶ（辞書順＝生成順）', () => {
    const a = newId(new Date(2026, 0, 1).getTime())
    const b = newId(new Date(2026, 0, 2).getTime())
    expect(a < b).toBe(true)
  })

  it('同じミリ秒でも辞書順が壊れない', () => {
    const t = 1_787_000_000_000
    const ids = Array.from({ length: 200 }, () => newId(t))
    expect(new Set(ids).size).toBe(200)
    expect(ids.every((id) => id.length === 26)).toBe(true)
  })
})
