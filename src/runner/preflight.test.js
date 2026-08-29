import { describe, it, expect } from 'vitest'
import { preflight } from './preflight.js'

const task = { repoPath: '/repo', agent: 'claude', baseBranch: 'master' }

const okDeps = () => ({
  isGitRepo: async () => true,
  hasRemote: async () => true,
  detectBaseBranch: async () => 'master',
  branchExists: async () => true,
  commandExists: async () => true,
  ghAuthOk: async () => true,
})

describe('preflight', () => {
  it('すべて揃っていれば通り、base ブランチを確定して返す', async () => {
    const got = await preflight(task, okDeps())
    expect(got.ok).toBe(true)
    expect(got.errors).toEqual([])
    expect(got.baseBranch).toBe('master')
  })

  it('base ブランチ未指定なら自動検出した名前を返す', async () => {
    const deps = { ...okDeps(), detectBaseBranch: async () => 'main' }
    const got = await preflight({ ...task, baseBranch: null }, deps)
    expect(got.baseBranch).toBe('main')
  })

  it.each([
    ['git リポジトリでない', { isGitRepo: async () => false }, /リポジトリ/],
    ['origin が無い', { hasRemote: async () => false }, /origin/],
    ['base ブランチが無い', { branchExists: async () => false }, /ブランチ/],
    ['AI の CLI が無い', { commandExists: async (c) => c !== 'claude' }, /claude/],
    ['gh が無い', { commandExists: async (c) => c !== 'gh' }, /gh/],
    ['gh が未認証', { ghAuthOk: async () => false }, /認証/],
  ])('%s なら理由付きで落とす', async (_label, override, pattern) => {
    const got = await preflight(task, { ...okDeps(), ...override })
    expect(got.ok).toBe(false)
    expect(got.errors.join('\n')).toMatch(pattern)
  })

  it('複数の不足をまとめて報告する（1つ直すたびに落ちるのを避ける）', async () => {
    const got = await preflight(task, {
      ...okDeps(),
      hasRemote: async () => false,
      ghAuthOk: async () => false,
    })
    expect(got.errors.length).toBe(2)
  })

  it('codex を使うタスクでは codex の存在を見る', async () => {
    const got = await preflight({ ...task, agent: 'codex' }, { ...okDeps(), commandExists: async (c) => c !== 'codex' })
    expect(got.ok).toBe(false)
    expect(got.errors.join('\n')).toMatch(/codex/)
  })

  it('base ブランチの検出に失敗しても落ちずに理由を返す', async () => {
    const deps = {
      ...okDeps(),
      detectBaseBranch: async () => {
        throw new Error('HEAD が無い')
      },
    }
    const got = await preflight({ ...task, baseBranch: null }, deps)
    expect(got.ok).toBe(false)
    expect(got.errors.join('\n')).toMatch(/ブランチ/)
  })
})
