// ブランチ名・PR タイトル・コミットメッセージの生成。git に渡して壊れない形に落とす責務。

const BRANCH_PREFIX = 'yoban/'
const MAX_BRANCH_LENGTH = 60
const MAX_SLUG_LENGTH = 40
const MAX_TITLE_LENGTH = 72
const FALLBACK_TITLE = '夜番による自動実行'

/** 英数字とハイフンだけの文字列に落とす。作れなければ空文字を返す。 */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, '')
}

function dateStamp(now) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * ブランチ名を作る。日本語だけの名前など slug が作れない場合は run id の断片を使う。
 * seq は同名ブランチが既にあったときの連番（2 以上で末尾に付く）。
 */
export function branchName(task, { runId, seq = 1, now = new Date() } = {}) {
  const stamp = dateStamp(now)
  const suffix = seq > 1 ? `-${seq}` : ''
  const head = `${BRANCH_PREFIX}${stamp}-`
  const room = MAX_BRANCH_LENGTH - head.length - suffix.length

  const fallback = String(runId ?? 'run').slice(-7).toLowerCase().replace(/[^a-z0-9]/g, '') || 'run'
  let slug = slugify(task?.name) || fallback
  if (slug.length > room) slug = slug.slice(0, room).replace(/-$/, '')
  if (!slug) slug = fallback.slice(0, Math.max(1, room))

  return `${head}${slug}${suffix}`
}

function oneLine(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return FALLBACK_TITLE
  return t.length > max ? t.slice(0, max) : t
}

export function prTitle(task) {
  return oneLine(task?.name, MAX_TITLE_LENGTH)
}

export function commitMessage(task) {
  return oneLine(task?.name, MAX_TITLE_LENGTH)
}
