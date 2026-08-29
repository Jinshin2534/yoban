// AI CLI の JSONL 出力から、最終メッセージ・トークン数・成否を取り出す。
// 出力は途中で切れることも、JSON でない行が混ざることもある前提で書く。

function parseLines(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t || (t[0] !== '{' && t[0] !== '[')) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v)
    } catch {
      // 途中で切れた行・壊れた行は捨てる
    }
  }
  return out
}

function textOf(content) {
  if (!Array.isArray(content)) return null
  const texts = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text)
  return texts.length ? texts.join('\n').trim() : null
}

const empty = () => ({ finalMessage: null, tokensIn: null, tokensOut: null, costUsd: null, isError: true })

export function parseClaudeStream(text) {
  const events = parseLines(text)
  const result = { ...empty() }

  let lastAssistantText = null
  let resultEvent = null
  for (const e of events) {
    if (e.type === 'assistant') {
      const t = textOf(e.message?.content)
      if (t) lastAssistantText = t
    } else if (e.type === 'result') {
      resultEvent = e
    }
  }

  if (resultEvent) {
    const u = resultEvent.usage ?? {}
    result.finalMessage =
      (typeof resultEvent.result === 'string' && resultEvent.result.trim()) || lastAssistantText || null
    result.tokensIn =
      sum(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens)
    result.tokensOut = numberOrNull(u.output_tokens)
    result.costUsd = numberOrNull(resultEvent.total_cost_usd)
    result.isError = resultEvent.is_error === true || resultEvent.subtype === 'error'
    return result
  }

  // 完了行が無い＝途中で死んだということ。成功にはしない。
  result.finalMessage = lastAssistantText
  result.isError = true
  return result
}

export function parseCodexStream(text) {
  const events = parseLines(text)
  const result = { ...empty() }

  let lastAgentMessage = null
  let completed = false
  let failure = null
  for (const e of events) {
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') {
      lastAgentMessage = e.item.text.trim()
    } else if (e.type === 'turn.completed') {
      completed = true
      const u = e.usage ?? {}
      result.tokensIn = numberOrNull(u.input_tokens)
      result.tokensOut = numberOrNull(u.output_tokens)
    } else if (e.type === 'turn.failed' || e.type === 'error') {
      failure = e.error?.message ?? e.message ?? 'codex の実行が失敗しました'
    }
  }

  result.finalMessage = failure ?? lastAgentMessage
  result.isError = !completed || failure != null
  return result
}

export function parseAgentStream(agent, text) {
  if (agent === 'claude') return parseClaudeStream(text)
  if (agent === 'codex') return parseCodexStream(text)
  throw new Error(`未知のエージェント: ${agent}`)
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function sum(...values) {
  const nums = values.map(numberOrNull).filter((v) => v != null)
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null
}
