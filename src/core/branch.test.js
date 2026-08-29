import { describe, it, expect } from 'vitest'
import { slugify, branchName, prTitle, commitMessage } from './branch.js'

const now = new Date(2026, 7, 29, 2, 0) // 2026-08-29
const opts = (over = {}) => ({ runId: '01K3ABCDEFGHJKMNPQRSTVWXYZ', now, ...over })

// git が受け付けないもの・後で困るものを全部落とせているか
const SAFE = /^yoban\/\d{8}-[a-z0-9][a-z0-9-]*$/

describe('slugify', () => {
  it('英数字とハイフンだけにする', () => {
    expect(slugify('Add Tests To Parser')).toBe('add-tests-to-parser')
  })

  it('スラッシュ・空白・記号をハイフンに潰す', () => {
    expect(slugify('fix: src/lib の bug!! (急ぎ)')).toBe('fix-src-lib-bug')
  })

  it('連続ハイフンをまとめ、先頭と末尾のハイフンを落とす', () => {
    expect(slugify('---a---b---')).toBe('a-b')
  })

  it('日本語だけの名前は空になる', () => {
    expect(slugify('テストを追加する')).toBe('')
  })

  it('長すぎる名前は切り詰め、末尾がハイフンで終わらない', () => {
    const s = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30))
    expect(s.length).toBeLessThanOrEqual(40)
    expect(s.endsWith('-')).toBe(false)
  })
})

describe('branchName', () => {
  it('日付とスラッグからブランチ名を作る', () => {
    expect(branchName({ name: 'Add tests' }, opts())).toBe('yoban/20260829-add-tests')
  })

  it('日本語名は run id の断片で代用する', () => {
    const got = branchName({ name: 'テストを追加する' }, opts())
    expect(got).toBe('yoban/20260829-stvwxyz')
    expect(got).toMatch(SAFE)
  })

  it('2回目以降は連番を付ける', () => {
    expect(branchName({ name: 'Add tests' }, opts({ seq: 2 }))).toBe('yoban/20260829-add-tests-2')
    expect(branchName({ name: 'Add tests' }, opts({ seq: 3 }))).toBe('yoban/20260829-add-tests-3')
  })

  it('全体の長さを 60 文字以内に収める', () => {
    const got = branchName({ name: 'x'.repeat(200) }, opts({ seq: 12 }))
    expect(got.length).toBeLessThanOrEqual(60)
    expect(got).toMatch(SAFE)
  })

  it.each([
    '',
    '   ',
    '///',
    '..',
    'HEAD',
    '@{upstream}',
    'a.lock',
    'feature~1^2:3?4*5[6]',
    '改行\nを含む',
    'タブ\tと 空白',
    '絵文字🎉だけ',
    '.hidden',
    '-leading-hyphen',
    'trailing-hyphen-',
  ])('危ない名前でも git が受け付ける形になる: %j', (name) => {
    const got = branchName({ name }, opts())
    expect(got).toMatch(SAFE)
    expect(got).not.toContain('--')
    expect(got.endsWith('.lock')).toBe(false)
    expect(got.endsWith('.')).toBe(false)
  })
})

describe('prTitle / commitMessage', () => {
  it('タスク名をそのまま使う', () => {
    expect(prTitle({ name: 'テストを追加する' })).toBe('テストを追加する')
    expect(commitMessage({ name: 'テストを追加する' })).toBe('テストを追加する')
  })

  it('改行はタイトルに混ぜない', () => {
    expect(prTitle({ name: '一行目\n二行目' })).toBe('一行目 二行目')
  })

  it('名前が空なら既定の文言を使う', () => {
    expect(prTitle({ name: '   ' })).toBe('夜番による自動実行')
    expect(commitMessage({ name: '' })).toBe('夜番による自動実行')
  })

  it('長いタイトルは切り詰める', () => {
    const got = prTitle({ name: 'あ'.repeat(200) })
    expect(got.length).toBeLessThanOrEqual(72)
  })
})
