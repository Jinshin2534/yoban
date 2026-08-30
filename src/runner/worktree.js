// git worktree の作成と後片付け。作業を本体のツリーから隔離するのが目的。
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { execCapture } from './exec.js'
import { remoteBranchExists } from './git.js'

function git(args, cwd, timeoutMs = 120_000) {
  return execCapture('git', args, { cwd, timeoutMs })
}

export async function listWorktrees(repoPath) {
  const out = await git(['worktree', 'list', '--porcelain'], repoPath)
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
}

/**
 * base ブランチの最新から新しいブランチを切って worktree を作る。
 * origin にある base を優先するので、本体のローカルが古くても影響を受けない。
 */
export async function createWorktree({ repoPath, worktreePath, branch, base }) {
  mkdirSync(path.dirname(worktreePath), { recursive: true })
  const startPoint = (await remoteBranchExists(repoPath, base)) ? `origin/${base}` : base
  await git(['worktree', 'add', worktreePath, '-b', branch, startPoint], repoPath, 300_000)
  return { worktreePath, branch, startPoint }
}

/** worktree を消す。存在しなくてもエラーにしない。 */
export async function removeWorktree({ repoPath, worktreePath }) {
  const registered = (await listWorktrees(repoPath).catch(() => [])).includes(worktreePath)
  if (registered) {
    try {
      await git(['worktree', 'remove', '--force', worktreePath], repoPath)
    } catch {
      // 登録だけ残っている場合に備えて、実体を消してから prune する
    }
  }
  if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
  await git(['worktree', 'prune'], repoPath).catch(() => {})
}

/** 使い終わったブランチのローカル参照を消す（リモートには残す） */
export async function deleteLocalBranch({ repoPath, branch }) {
  await git(['branch', '-D', branch], repoPath).catch(() => {})
}
