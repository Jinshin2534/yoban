import { describe, it, expect } from 'vitest'
import { buildPrompt, AUTOMATION_NOTE } from './prompt.js'

describe('buildPrompt', () => {
  it('依頼の本文を先頭に置く', () => {
    expect(buildPrompt({ prompt: 'テストを足して' }).startsWith('テストを足して')).toBe(true)
  })

  it('git 操作をしないよう必ず伝える', () => {
    const p = buildPrompt({ prompt: 'x' })
    expect(p).toContain('コミット')
    expect(p).toContain('push')
    expect(p).toContain('PR')
    expect(p).toContain(AUTOMATION_NOTE)
  })

  it('無人であることと、最後に要約することを伝える', () => {
    const p = buildPrompt({ prompt: 'x' })
    expect(p).toMatch(/無人/)
    expect(p).toMatch(/まとめ/)
  })

  it('前後の空白を落とす', () => {
    expect(buildPrompt({ prompt: '  \n テストを足して \n ' }).startsWith('テストを足して')).toBe(true)
  })
})
