// git 操作。AI にやらせず、ここで決め打ちにする。
import { existsSync } from 'node:fs'
import { execCapture, execOk } from './exec.js'

const FALLBACK_IDENTITY = ['-c', 'user.name=夜番', '-c', 'user.email=yoban@localhost']

function git(args, cwd, options = {}) {
  return execCapture('git', args, { cwd, timeoutMs: 120_000, ...options })
}

export async function isGitRepo(dir) {
  if (!dir || !existsSync(dir)) return false
  return execOk('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, timeoutMs: 30_000 })
}

export async function currentBranch(cwd) {
  return (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
}

export async function hasRemote(cwd) {
  return execOk('git', ['remote', 'get-url', 'origin'], { cwd, timeoutMs: 30_000 })
}

/** origin/HEAD → 現在のブランチ の順に base ブランチを決める */
export async function detectBaseBranch(cwd) {
  try {
    const ref = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)).trim()
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length)
  } catch {
    // origin/HEAD が無いリポジトリもある
  }
  return currentBranch(cwd)
}

export async function remoteBranchExists(cwd, branch) {
  try {
    const out = await git(['ls-remote', '--heads', 'origin', branch], cwd, { timeoutMs: 60_000 })
    return out.trim().length > 0
  } catch {
    return false
  }
}

export async function localBranchExists(cwd, branch) {
  return execOk('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd, timeoutMs: 30_000 })
}

export async function fetch(cwd) {
  await git(['fetch', '--prune', 'origin'], cwd, { timeoutMs: 300_000 })
}

/**
 * 変更のあるファイル一覧。未追跡ファイルも含む。
 * -z で NUL 区切りにするので、空白や日本語のファイル名でも壊れない。
 */
export async function changedFiles(cwd) {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd)
  const records = out.split('\0').filter((r) => r.length > 0)
  const files = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    const status = record.slice(0, 2)
    const file = record.slice(3)
    files.push(file)
    // リネーム・コピーは「変更後→変更前」の2レコードで来るので、変更前を読み飛ばす
    if (status[0] === 'R' || status[0] === 'C') i++
  }
  return files
}

async function identityArgs(cwd) {
  const hasEmail = await execOk('git', ['config', '--get', 'user.email'], { cwd, timeoutMs: 30_000 })
  const hasName = await execOk('git', ['config', '--get', 'user.name'], { cwd, timeoutMs: 30_000 })
  return hasEmail && hasName ? [] : FALLBACK_IDENTITY
}

/** すべての変更をコミットして SHA を返す。変更が無ければ例外。 */
export async function commitAll({ cwd, message }) {
  await git(['add', '-A'], cwd)
  const identity = await identityArgs(cwd)
  await git([...identity, '-c', 'commit.gpgsign=false', 'commit', '-m', message], cwd)
  return (await git(['rev-parse', 'HEAD'], cwd)).trim()
}

export async function push({ cwd, branch }) {
  await git(['push', '-u', 'origin', `${branch}:${branch}`], cwd, { timeoutMs: 300_000 })
}

export async function remoteUrl(cwd) {
  try {
    return (await git(['remote', 'get-url', 'origin'], cwd)).trim()
  } catch {
    return null
  }
}
