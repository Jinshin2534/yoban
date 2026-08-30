import { describe, it, expect } from 'vitest'
import { buildPrArgs } from './github.js'

describe('buildPrArgs', () => {
  const base = { branch: 'yoban/20260829-abc', base: 'master', title: 'テスト', body: '本文', draft: true }

  it('必要な指定がすべて入る', () => {
    const args = buildPrArgs(base)
    expect(args.slice(0, 2)).toEqual(['pr', 'create'])
    expect(args).toContain('--head')
    expect(args[args.indexOf('--head') + 1]).toBe('yoban/20260829-abc')
    expect(args[args.indexOf('--base') + 1]).toBe('master')
    expect(args[args.indexOf('--title') + 1]).toBe('テスト')
    expect(args[args.indexOf('--body') + 1]).toBe('本文')
  })

  it('draft の有無が反映される', () => {
    expect(buildPrArgs(base)).toContain('--draft')
    expect(buildPrArgs({ ...base, draft: false })).not.toContain('--draft')
  })

  it('本文は引数で渡す（標準入力は閉じているため）', () => {
    expect(buildPrArgs(base)).not.toContain('--body-file')
  })
})
