import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { makeRepoPair, git as rawGit, remoteBranches } from '../../test/helpers/repo.js'
import {
  isGitRepo, detectBaseBranch, hasRemote, remoteBranchExists, fetch as gitFetch,
  changedFiles, commitAll, push, currentBranch,
} from './git.js'
import { createWorktree, removeWorktree, listWorktrees } from './worktree.js'

let repo
let wt

beforeEach(() => {
  repo = makeRepoPair()
  wt = path.join(repo.root, 'worktrees', 'run-1')
})

afterEach(() => {
  repo.cleanup()
})

describe('リポジトリの状態を読む', () => {
  it('git リポジトリかどうかを判定する', async () => {
    expect(await isGitRepo(repo.work)).toBe(true)
    expect(await isGitRepo(repo.root)).toBe(false)
    expect(await isGitRepo(path.join(repo.root, '存在しない'))).toBe(false)
  })

  it('origin/HEAD から base ブランチを見つける', async () => {
    expect(await detectBaseBranch(repo.work)).toBe('master')
  })

  it('origin が無ければ分かる', async () => {
    expect(await hasRemote(repo.work)).toBe(true)
    rawGit(['remote', 'remove', 'origin'], repo.work)
    expect(await hasRemote(repo.work)).toBe(false)
  })

  it('リモートにブランチがあるかを見る', async () => {
    expect(await remoteBranchExists(repo.work, 'master')).toBe(true)
    expect(await remoteBranchExists(repo.work, 'yoban/まだ無い')).toBe(false)
  })

  it('fetch が通る', async () => {
    await expect(gitFetch(repo.work)).resolves.toBeUndefined()
  })
})

describe('worktree', () => {
  it('base ブランチの最新から作られ、本体の作業ツリーに影響しない', async () => {
    // 本体に未コミットの変更を置いておく（無人実行で壊してはいけないもの）
    writeFileSync(path.join(repo.work, 'src', 'index.js'), 'export const one = 999 // 作業中\n')

    await createWorktree({ repoPath: repo.work, worktreePath: wt, branch: 'yoban/test-1', base: 'master' })

    expect(existsSync(path.join(wt, 'README.md'))).toBe(true)
    expect(await currentBranch(wt)).toBe('yoban/test-1')
    // worktree 側には本体の未コミット変更は入っていない
    expect(readFileSync(path.join(wt, 'src', 'index.js'), 'utf8')).toContain('one = 1')
    // 本体の作業中ファイルはそのまま
    expect(readFileSync(path.join(repo.work, 'src', 'index.js'), 'utf8')).toContain('999')
  })

  it('同じブランチ名では二度作れない', async () => {
    await createWorktree({ repoPath: repo.work, worktreePath: wt, branch: 'yoban/test-1', base: 'master' })
    const second = path.join(repo.root, 'worktrees', 'run-2')
    await expect(
      createWorktree({ repoPath: repo.work, worktreePath: second, branch: 'yoban/test-1', base: 'master' }),
    ).rejects.toThrow()
  })

  it('削除すると痕跡が残らない', async () => {
    await createWorktree({ repoPath: repo.work, worktreePath: wt, branch: 'yoban/test-1', base: 'master' })
    expect(await listWorktrees(repo.work)).toContain(wt)

    await removeWorktree({ repoPath: repo.work, worktreePath: wt })
    expect(existsSync(wt)).toBe(false)
    expect(await listWorktrees(repo.work)).not.toContain(wt)
  })

  it('中に変更が残っていても削除できる', async () => {
    await createWorktree({ repoPath: repo.work, worktreePath: wt, branch: 'yoban/test-1', base: 'master' })
    writeFileSync(path.join(wt, 'ゴミ.txt'), 'x')
    await removeWorktree({ repoPath: repo.work, worktreePath: wt })
    expect(existsSync(wt)).toBe(false)
  })

  it('存在しない worktree の削除は失敗しない', async () => {
    await expect(removeWorktree({ repoPath: repo.work, worktreePath: wt })).resolves.toBeUndefined()
  })
})

describe('変更の検出とコミット', () => {
  beforeEach(async () => {
    await createWorktree({ repoPath: repo.work, worktreePath: wt, branch: 'yoban/test-1', base: 'master' })
  })

  it('何もしなければ変更ゼロ', async () => {
    expect(await changedFiles(wt)).toEqual([])
  })

  it('新規ファイル・変更・削除をすべて拾う', async () => {
    writeFileSync(path.join(wt, 'new.txt'), 'あたらしい')
    writeFileSync(path.join(wt, 'src', 'index.js'), 'export const one = 2\n')
    mkdirSync(path.join(wt, 'deep', 'nest'), { recursive: true })
    writeFileSync(path.join(wt, 'deep', 'nest', 'a b.txt'), '空白入り')

    const files = await changedFiles(wt)
    expect(files).toContain('new.txt')
    expect(files).toContain('src/index.js')
    expect(files).toContain('deep/nest/a b.txt')
  })

  it('コミットすると変更ゼロに戻る', async () => {
    writeFileSync(path.join(wt, 'new.txt'), 'あたらしい')
    const sha = await commitAll({ cwd: wt, message: 'テストを追加する' })
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await changedFiles(wt)).toEqual([])
    expect(rawGit(['log', '-1', '--pretty=%s'], wt)).toBe('テストを追加する')
  })

  it('git の身元が未設定でもコミットできる', async () => {
    // グローバル設定に依存しないよう、リポジトリの user 設定を消してから試す
    try {
      rawGit(['config', '--unset', 'user.email'], wt)
      rawGit(['config', '--unset', 'user.name'], wt)
    } catch {
      // もともと未設定ならそれでよい
    }
    writeFileSync(path.join(wt, 'new.txt'), 'あたらしい')
    await expect(commitAll({ cwd: wt, message: '身元なしコミット' })).resolves.toMatch(/^[0-9a-f]{40}$/)
  })

  it('変更が無いのにコミットしようとしたら例外', async () => {
    await expect(commitAll({ cwd: wt, message: '空コミット' })).rejects.toThrow()
  })
})

describe('push', () => {
  it('origin に新しいブランチが現れる', async () => {
    await createWorktree({ repoPath: repo.work, worktreePath: wt, branch: 'yoban/test-1', base: 'master' })
    writeFileSync(path.join(wt, 'new.txt'), 'あたらしい')
    await commitAll({ cwd: wt, message: 'テスト' })

    expect(remoteBranches(repo.origin)).not.toContain('yoban/test-1')
    await push({ cwd: wt, branch: 'yoban/test-1' })
    expect(remoteBranches(repo.origin)).toContain('yoban/test-1')
  })

  it('origin が無ければ分かるエラーになる', async () => {
    await createWorktree({ repoPath: repo.work, worktreePath: wt, branch: 'yoban/test-2', base: 'master' })
    writeFileSync(path.join(wt, 'new.txt'), 'x')
    await commitAll({ cwd: wt, message: 'テスト' })
    rawGit(['remote', 'remove', 'origin'], repo.work)

    await expect(push({ cwd: wt, branch: 'yoban/test-2' })).rejects.toThrow()
  })
})
