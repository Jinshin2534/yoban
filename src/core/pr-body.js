// PR 本文の組み立て。中身に何が入っていても Markdown を壊さないことが仕事。

export const MAX_BODY_LENGTH = 60_000
const MAX_PROMPT = 8_000
const MAX_MESSAGE = 12_000
const MAX_VERIFY_OUTPUT = 6_000
const ELLIPSIS = '\n…（以下略）'

/** 中身に含まれるバッククォート列より 1 つ長いフェンスを返す */
export function fence(text) {
  const longest = Math.max(0, ...[...String(text ?? '').matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function block(text) {
  const body = String(text ?? '').replace(/\s+$/, '')
  const f = fence(body)
  return `${f}\n${body}\n${f}`
}

function head(text, max) {
  const t = String(text ?? '')
  return t.length <= max ? t : t.slice(0, max) + ELLIPSIS
}

/** 末尾を残して切る。エラーは出力の終わりに出るため。 */
function tail(text, max) {
  const t = String(text ?? '')
  return t.length <= max ? t : '（以下略）\n' + t.slice(t.length - max)
}

function formatTime(iso) {
  if (!iso) return '不明'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '不明'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatDuration(run) {
  if (!run?.startedAt || !run?.endedAt) return '不明'
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '不明'
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`
}

export function prBody({ task, run, verify }) {
  const parts = []
  parts.push('このPRは **夜番** が自動で作りました。中身は人が見てから取り込んでください。')

  parts.push('## 依頼した内容')
  parts.push(block(head(task?.prompt, MAX_PROMPT)))

  parts.push(`## ${task?.agent === 'codex' ? 'Codex' : 'Claude Code'} の報告`)
  parts.push(run?.finalMessage ? block(head(run.finalMessage, MAX_MESSAGE)) : '（最終メッセージはありませんでした）')

  parts.push('## 検証')
  if (!verify) {
    parts.push('検証コマンドは設定されていません。')
  } else {
    const ok = verify.exitCode === 0
    parts.push(`\`${verify.command}\` … **${ok ? '成功' : '失敗'}**（終了コード ${verify.exitCode}）`)
    if (verify.output) parts.push(block(tail(verify.output, MAX_VERIFY_OUTPUT)))
  }

  const meta = [
    `エージェント: ${task?.agent}${task?.model ? ` (${task.model})` : ''}`,
    `ブランチ: \`${run?.branch ?? '不明'}\``,
    `開始: ${formatTime(run?.startedAt)}`,
    `所要: ${formatDuration(run)}`,
  ]
  if (run?.tokensIn != null || run?.tokensOut != null) {
    meta.push(`トークン: in ${run.tokensIn ?? '?'} / out ${run.tokensOut ?? '?'}`)
  }
  parts.push('---')
  parts.push(meta.map((m) => `- ${m}`).join('\n'))

  const body = parts.join('\n\n')
  return body.length <= MAX_BODY_LENGTH ? body : body.slice(0, MAX_BODY_LENGTH - ELLIPSIS.length) + ELLIPSIS
}
