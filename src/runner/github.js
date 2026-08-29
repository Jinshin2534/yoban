// PR の作成。gh に閉じ込めてあるので、テストではここだけ差し替える。
import { execCapture } from './exec.js'

export function buildPrArgs({ branch, base, title, body, draft }) {
  const args = ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body]
  if (draft) args.push('--draft')
  return args
}

/** 作成された PR の URL を返す */
export async function createPullRequest({ cwd, branch, base, title, body, draft }) {
  const out = await execCapture('gh', buildPrArgs({ branch, base, title, body, draft }), {
    cwd,
    timeoutMs: 120_000,
  })
  const url = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('http'))
  if (!url) throw new Error(`PR の URL を読み取れませんでした: ${out.trim().slice(0, 200)}`)
  return url
}
