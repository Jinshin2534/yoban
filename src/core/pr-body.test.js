import { describe, it, expect } from 'vitest'
import { prBody, fence, MAX_BODY_LENGTH } from './pr-body.js'

const task = {
  name: 'テストを追加する',
  agent: 'claude',
  model: 'claude-opus-5',
  prompt: 'src/lib のテストを足して',
  verifyCommand: 'pnpm test',
}

const run = {
  id: '01K3ABC',
  branch: 'yoban/20260829-stvwxyz',
  startedAt: new Date(2026, 7, 29, 2, 0).toISOString(),
  endedAt: new Date(2026, 7, 29, 2, 12).toISOString(),
  finalMessage: 'テストを2件追加しました。',
  tokensIn: 2000,
  tokensOut: 670,
}

describe('prBody', () => {
  it('依頼内容・AI の報告・検証結果・実行情報がすべて入る', () => {
    const body = prBody({ task, run, verify: { command: 'pnpm test', exitCode: 0, output: '2 passed' } })
    expect(body).toContain('src/lib のテストを足して')
    expect(body).toContain('テストを2件追加しました。')
    expect(body).toContain('2 passed')
    expect(body).toContain('claude')
    expect(body).toContain('yoban/20260829-stvwxyz')
    expect(body).toContain('夜番')
  })

  it('検証が成功したことが分かる', () => {
    const body = prBody({ task, run, verify: { command: 'pnpm test', exitCode: 0, output: 'ok' } })
    expect(body).toMatch(/成功/)
  })

  it('検証が失敗したら、失敗だと明記して出力も載せる', () => {
    const body = prBody({ task, run, verify: { command: 'pnpm test', exitCode: 1, output: '1 failed' } })
    expect(body).toMatch(/失敗/)
    expect(body).toContain('1 failed')
    expect(body).toContain('終了コード 1')
  })

  it('検証コマンドが無い場合はその旨を書く', () => {
    const body = prBody({ task: { ...task, verifyCommand: null }, run, verify: null })
    expect(body).toMatch(/検証コマンドは設定されていません/)
  })

  it('AI が何も言わなかった場合でも壊れない', () => {
    const body = prBody({ task, run: { ...run, finalMessage: null }, verify: null })
    expect(body).toContain('夜番')
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('コードフェンスの扱い', () => {
  it.each([
    'ここに ``` が入る\n```js\ncode\n```',
    '`````\n5連のフェンス\n`````',
    '``` だけの行\n```',
  ])('中身にバッククォートがあっても、囲みごと元の文が復元できる: %j', (nasty) => {
    const body = prBody({ task: { ...task, prompt: nasty }, run, verify: null })
    const f = fence(nasty)
    // 中身がフェンスに丸ごと包まれたまま入っている＝壊れていない
    expect(body).toContain(`${f}\n${nasty}\n${f}`)
    // 中身のどの行もフェンスと同じ長さのバッククォート列にならない
    for (const line of nasty.split('\n')) expect(line.trim()).not.toBe(f)
  })

  it('fence は中身の最長バッククォート列より長くする', () => {
    expect(fence('ふつうの文')).toBe('```')
    expect(fence('``` あり')).toBe('````')
    expect(fence('````` 5連')).toBe('``````')
  })
})

describe('長さの制限', () => {
  it('全体が GitHub の上限に収まる', () => {
    const huge = 'あ'.repeat(200_000)
    const body = prBody({
      task: { ...task, prompt: huge },
      run: { ...run, finalMessage: huge },
      verify: { command: 'pnpm test', exitCode: 1, output: huge },
    })
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH)
  })

  it('切り詰めたことが分かるようにする', () => {
    const body = prBody({
      task: { ...task, prompt: 'あ'.repeat(50_000) },
      run,
      verify: null,
    })
    expect(body).toMatch(/以下略/)
  })

  it('検証の出力は末尾を残す（エラーは終わりに出るため）', () => {
    const output = 'ノイズ\n'.repeat(5000) + '最後の行が大事'
    const body = prBody({ task, run, verify: { command: 'pnpm test', exitCode: 1, output } })
    expect(body).toContain('最後の行が大事')
  })
})
