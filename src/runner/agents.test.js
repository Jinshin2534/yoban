import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAgentCommand, runAgent } from './agents/index.js'

const FAKE = fileURLToPath(new URL('../../test/helpers/fake-agent.js', import.meta.url))
const fake = (...args) => ({ command: process.execPath, args: [FAKE, ...args] })

let dir
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'yoban-agent-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('buildAgentCommand / claude', () => {
  const built = (over = {}) => buildAgentCommand({ agent: 'claude', prompt: 'テストを足して', cwd: '/w', ...over })

  it('無人実行に必要なフラグが揃っている', () => {
    const { command, args } = built()
    expect(command).toBe('claude')
    expect(args).toContain('-p')
    expect(args).toContain('テストを足して')
    expect(args.join(' ')).toContain('--output-format stream-json')
    expect(args).toContain('--verbose')
    expect(args.join(' ')).toContain('--permission-mode bypassPermissions')
  })

  it('モデル指定があれば渡す', () => {
    expect(built({ model: 'claude-opus-5' }).args.join(' ')).toContain('--model claude-opus-5')
  })

  it('モデル未指定なら --model を付けない', () => {
    expect(built().args).not.toContain('--model')
  })
})

describe('buildAgentCommand / codex', () => {
  const built = (over = {}) => buildAgentCommand({ agent: 'codex', prompt: 'テストを足して', cwd: '/w', ...over })

  it('作業ディレクトリとサンドボックスを指定する', () => {
    const { command, args } = built()
    expect(command).toBe('codex')
    expect(args[0]).toBe('exec')
    expect(args.join(' ')).toContain('--cd /w')
    expect(args.join(' ')).toContain('-s workspace-write')
    expect(args).toContain('--json')
    expect(args.at(-1)).toBe('テストを足して')
  })

  it('ネットワークを許可する（依存の取得やテスト実行に要る）', () => {
    expect(built().args.join(' ')).toContain('network_access=true')
  })

  it('モデル指定があれば渡す', () => {
    expect(built({ model: 'gpt-5' }).args.join(' ')).toContain('-m gpt-5')
  })
})

describe('buildAgentCommand / 未知', () => {
  it('例外になる', () => {
    expect(() => buildAgentCommand({ agent: 'gemini', prompt: 'x', cwd: '/w' })).toThrow()
  })
})

describe('runAgent', () => {
  it('作業ディレクトリの中にファイルを作れる', async () => {
    const result = await runAgent({
      command: fake('--write', 'out.txt', '--content', 'できた'),
      cwd: dir,
      timeoutMs: 10_000,
    })
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('できた')
  })

  it('標準出力を逐次流しつつ、全文も返す', async () => {
    const chunks = []
    const result = await runAgent({
      command: fake('--print', 'これはログ'),
      cwd: dir,
      timeoutMs: 10_000,
      onOutput: (c) => chunks.push(c),
    })
    expect(result.stdout).toContain('これはログ')
    expect(chunks.join('')).toContain('これはログ')
  })

  it('非ゼロ終了はそのまま返す（例外にしない）', async () => {
    const result = await runAgent({ command: fake('--exit', '3'), cwd: dir, timeoutMs: 10_000 })
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
  })

  it('タイムアウトしたら止めて、そうと分かる', async () => {
    const started = Date.now()
    const result = await runAgent({ command: fake('--sleep', '30000'), cwd: dir, timeoutMs: 400 })
    expect(result.timedOut).toBe(true)
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('中止できる', async () => {
    const controller = new AbortController()
    const promise = runAgent({ command: fake('--sleep', '30000'), cwd: dir, timeoutMs: 60_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const result = await promise
    expect(result.aborted).toBe(true)
    expect(result.code).not.toBe(0)
  })

  it('標準入力は閉じている（開いたままだと無人実行が固まる）', async () => {
    const result = await runAgent({ command: fake('--read-stdin'), cwd: dir, timeoutMs: 5_000 })
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain('stdin closed')
  })

  it('コマンドが存在しなければ分かるエラーになる', async () => {
    await expect(
      runAgent({ command: { command: 'yoban-存在しないコマンド', args: [] }, cwd: dir, timeoutMs: 5_000 }),
    ).rejects.toThrow()
  })

  it('作ったファイルは作業ディレクトリの外に出ない', async () => {
    await runAgent({ command: fake('--write', 'nested/deep/a.txt'), cwd: dir, timeoutMs: 10_000 })
    expect(existsSync(path.join(dir, 'nested', 'deep', 'a.txt'))).toBe(true)
  })
})
