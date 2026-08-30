import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseClaudeStream, parseCodexStream, parseAgentStream } from './agent-output.js'

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), 'utf8')

describe('parseClaudeStream', () => {
  it('result 行から最終メッセージとトークン数を取り出す', () => {
    const got = parseClaudeStream(fixture('claude-success.jsonl'))
    expect(got.finalMessage).toBe('テストを2件追加しました。')
    expect(got.tokensIn).toBe(2000) // input 1200 + cache_creation 300 + cache_read 500
    expect(got.tokensOut).toBe(670)
    expect(got.isError).toBe(false)
    expect(got.costUsd).toBeCloseTo(0.1234)
  })

  it('本物の認証エラー出力からエラーだと判定できる', () => {
    const got = parseClaudeStream(fixture('claude-auth-error.jsonl'))
    expect(got.isError).toBe(true)
    expect(got.finalMessage).toMatch(/Failed to authenticate/)
  })

  it('result 行が無ければ最後の assistant テキストで代用する', () => {
    const lines = fixture('claude-success.jsonl')
      .split('\n')
      .filter((l) => l && !l.includes('"type":"result"'))
      .join('\n')
    const got = parseClaudeStream(lines)
    expect(got.finalMessage).toBe('テストを2件追加しました。')
    expect(got.isError).toBe(true) // 完了行が無いまま終わっている＝異常終了
  })

  it('tool_use しか無い assistant 行を最終メッセージにしない', () => {
    const text = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"作業します"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}',
    ].join('\n')
    expect(parseClaudeStream(text).finalMessage).toBe('作業します')
  })
})

describe('parseCodexStream', () => {
  it('agent_message と turn.completed から取り出す', () => {
    const got = parseCodexStream(fixture('codex-success.jsonl'))
    expect(got.finalMessage).toBe('ok')
    expect(got.tokensIn).toBe(19301)
    expect(got.tokensOut).toBe(5)
    expect(got.isError).toBe(false)
  })

  it('turn.failed があればエラーとして扱う', () => {
    const got = parseCodexStream(fixture('codex-failed.jsonl'))
    expect(got.isError).toBe(true)
    expect(got.finalMessage).toMatch(/retry limit/)
  })

  it('警告の error アイテムだけでは失敗にしない', () => {
    // 本物の出力には「スキル説明が短縮された」という error アイテムが混ざるが、実行自体は成功している
    expect(fixture('codex-success.jsonl')).toContain('"type":"error"')
    expect(parseCodexStream(fixture('codex-success.jsonl')).isError).toBe(false)
  })
})

describe('壊れた入力', () => {
  const broken = [
    ['空文字', ''],
    ['空白と改行だけ', '\n\n  \n'],
    ['JSON でない行が混ざる', 'これはログです\n{"type":"turn.started"}\nERROR: 何か\n'],
    ['途中で切れた JSON', '{"type":"item.completed","item":{"type":"agent_mess'],
    ['配列や数値が来る', '123\n"文字列"\n[1,2,3]\n'],
    ['null が来る', 'null\n'],
  ]

  it.each(broken)('claude: %s でも落ちない', (_label, text) => {
    const got = parseClaudeStream(text)
    expect(got).toHaveProperty('finalMessage')
    expect(got).toHaveProperty('isError')
  })

  it.each(broken)('codex: %s でも落ちない', (_label, text) => {
    const got = parseCodexStream(text)
    expect(got).toHaveProperty('finalMessage')
    expect(got).toHaveProperty('isError')
  })

  it('壊れた入力ではエラー扱いになる（黙って成功にしない）', () => {
    expect(parseClaudeStream('').isError).toBe(true)
    expect(parseCodexStream('').isError).toBe(true)
    expect(parseClaudeStream('ログだけ\n').isError).toBe(true)
  })

  it('途中に壊れた行があっても、正しい行は拾える', () => {
    const text = [
      'ゴミ',
      '{"type":"item.completed","item":{"type":"agent_message","text":"拾えた"}}',
      '{壊れた',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
    ].join('\n')
    const got = parseCodexStream(text)
    expect(got.finalMessage).toBe('拾えた')
    expect(got.tokensIn).toBe(10)
  })
})

describe('parseAgentStream', () => {
  it('エージェント名で振り分ける', () => {
    expect(parseAgentStream('claude', fixture('claude-success.jsonl')).finalMessage).toBe('テストを2件追加しました。')
    expect(parseAgentStream('codex', fixture('codex-success.jsonl')).finalMessage).toBe('ok')
  })

  it('未知のエージェントは例外', () => {
    expect(() => parseAgentStream('gemini', '')).toThrow()
  })
})
