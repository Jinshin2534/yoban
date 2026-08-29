import { describe, it, expect } from 'vitest'
import { parseArgs } from './args.js'

describe('コマンドと引数', () => {
  it('コマンドだけ', () => {
    expect(parseArgs(['list'])).toEqual({ command: 'list', args: [], options: {} })
  })

  it('コマンドが無ければ help', () => {
    expect(parseArgs([]).command).toBe('help')
  })

  it('位置引数を拾う', () => {
    const got = parseArgs(['logs', '01ABC', '--follow'])
    expect(got.command).toBe('logs')
    expect(got.args).toEqual(['01ABC'])
    expect(got.options.follow).toBe(true)
  })
})

describe('スケジュールの指定', () => {
  it('--daily', () => {
    expect(parseArgs(['add', '--daily', '02:00']).options.schedule).toEqual({ type: 'daily', time: '02:00' })
  })

  it('--weekly', () => {
    expect(parseArgs(['add', '--weekly', 'mon,thu@02:00']).options.schedule).toEqual({
      type: 'weekly',
      days: ['mon', 'thu'],
      time: '02:00',
    })
  })

  it('--every は時間数', () => {
    expect(parseArgs(['add', '--every', '6h']).options.schedule).toEqual({ type: 'interval', hours: 6 })
    expect(parseArgs(['add', '--every', '12']).options.schedule).toEqual({ type: 'interval', hours: 12 })
  })

  it('--once は空白区切りでも T 区切りでも受ける', () => {
    expect(parseArgs(['add', '--once', '2026-08-30 09:00']).options.schedule).toEqual({
      type: 'once',
      at: '2026-08-30T09:00',
    })
    expect(parseArgs(['add', '--once', '2026-08-30T09:00']).options.schedule).toEqual({
      type: 'once',
      at: '2026-08-30T09:00',
    })
  })

  it('スケジュールを2つ指定したら例外', () => {
    expect(() => parseArgs(['add', '--daily', '02:00', '--every', '6h'])).toThrow(/スケジュール/)
  })

  it.each([
    ['--daily', '25:00'],
    ['--weekly', 'mon'],
    ['--weekly', 'funday@02:00'],
    ['--every', 'たくさん'],
    ['--every', '0'],
    ['--once', 'あした'],
  ])('壊れた指定は例外: %s %s', (flag, value) => {
    expect(() => parseArgs(['add', flag, value])).toThrow()
  })
})

describe('その他のオプション', () => {
  it('文字列オプション', () => {
    const o = parseArgs([
      'add', '--name', 'テスト', '--repo', '~/ranzo_project/bonsai', '--agent', 'codex',
      '--model', 'gpt-5', '--prompt', 'やって', '--setup', 'pnpm i', '--verify', 'pnpm test',
      '--base', 'main',
    ]).options
    expect(o.name).toBe('テスト')
    expect(o.repoPath).toBe('~/ranzo_project/bonsai')
    expect(o.agent).toBe('codex')
    expect(o.model).toBe('gpt-5')
    expect(o.prompt).toBe('やって')
    expect(o.setupCommand).toBe('pnpm i')
    expect(o.verifyCommand).toBe('pnpm test')
    expect(o.baseBranch).toBe('main')
  })

  it('数値オプション', () => {
    expect(parseArgs(['add', '--timeout', '90']).options.timeoutMinutes).toBe(90)
    expect(parseArgs(['runs', '--limit', '10']).options.limit).toBe(10)
    expect(() => parseArgs(['add', '--timeout', 'ながめ'])).toThrow()
  })

  it('真偽オプション', () => {
    expect(parseArgs(['add', '--no-draft']).options.draftPr).toBe(false)
    expect(parseArgs(['add', '--keep-worktree']).options.keepWorktreeOnFailure).toBe(true)
    expect(parseArgs(['runs', '--json']).options.json).toBe(true)
  })

  it('値が無い指定は例外', () => {
    expect(() => parseArgs(['add', '--name'])).toThrow(/値/)
  })

  it('知らないフラグは例外（黙って無視しない）', () => {
    expect(() => parseArgs(['add', '--nanika', '1'])).toThrow(/--nanika/)
  })

  it('短縮形も使える', () => {
    expect(parseArgs(['logs', 'x', '-f']).options.follow).toBe(true)
  })
})
