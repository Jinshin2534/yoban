// テスト用に、本物の git リポジトリ（origin 役の bare + その clone）を tmp に作る。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const IDENTITY = [
  '-c', 'user.name=テスト',
  '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=master',
]

export function git(args, cwd) {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim()
}

/** bare リポジトリ（origin）と作業用 clone を作り、初期コミットを1つ積む */
export function makeRepoPair({ defaultBranch = 'master' } = {}) {
  // macOS の /var → /private/var 対策。git が返すパスと突き合わせられるよう実体パスにする
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'yoban-repo-')))
  const origin = path.join(root, 'origin.git')
  const work = path.join(root, 'work')

  mkdirSync(origin, { recursive: true })
  git(['init', '--bare', '--initial-branch', defaultBranch, origin], root)
  git(['clone', origin, work], root)

  writeFileSync(path.join(work, 'README.md'), '# テスト用\n')
  mkdirSync(path.join(work, 'src'), { recursive: true })
  writeFileSync(path.join(work, 'src', 'index.js'), 'export const one = 1\n')
  git(['add', '-A'], work)
  git(['commit', '-m', '初期コミット'], work)
  git(['push', '-u', 'origin', defaultBranch], work)
  git(['remote', 'set-head', 'origin', '-a'], work)

  return {
    root,
    origin,
    work,
    defaultBranch,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

export function remoteBranches(originPath) {
  return git(['branch', '--format=%(refname:short)'], originPath).split('\n').filter(Boolean)
}
