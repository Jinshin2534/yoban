import { describe, it, expect } from 'vitest'
import { validateTask, mergeTask, DEFAULTS } from './task.js'

const home = '/Users/tester'
const roots = ['/Users/tester/ranzo_project']
const opts = { allowedRoots: roots, home }

const valid = {
  name: 'テストを追加する',
  repoPath: '/Users/tester/ranzo_project/hair-pin',
  agent: 'claude',
  prompt: 'テストを足して',
  schedule: { type: 'daily', time: '02:00' },
}

describe('validateTask / 必須項目', () => {
  it('最小構成が通り、既定値が埋まる', () => {
    const t = validateTask(valid, opts)
    expect(t.name).toBe('テストを追加する')
    expect(t.enabled).toBe(true)
    expect(t.timeoutMinutes).toBe(DEFAULTS.timeoutMinutes)
    expect(t.catchUp).toBe(true)
    expect(t.catchUpGraceHours).toBe(DEFAULTS.catchUpGraceHours)
    expect(t.draftPr).toBe(true)
    expect(t.keepWorktreeOnFailure).toBe(false)
    expect(t.baseBranch).toBeNull()
    expect(t.model).toBeNull()
    expect(t.setupCommand).toBeNull()
    expect(t.verifyCommand).toBeNull()
  })

  it.each([
    ['name が無い', { name: undefined }],
    ['name が空白だけ', { name: '   ' }],
    ['prompt が無い', { prompt: undefined }],
    ['prompt が空白だけ', { prompt: '\n\n' }],
    ['repoPath が無い', { repoPath: undefined }],
    ['agent が未知', { agent: 'gemini' }],
    ['agent が無い', { agent: undefined }],
    ['schedule が無い', { schedule: undefined }],
    ['schedule が不正', { schedule: { type: 'daily', time: '99:99' } }],
  ])('%s なら例外', (_label, over) => {
    expect(() => validateTask({ ...valid, ...over }, opts)).toThrow()
  })
})

describe('validateTask / repoPath', () => {
  it('~ を展開する', () => {
    const t = validateTask({ ...valid, repoPath: '~/ranzo_project/bonsai' }, opts)
    expect(t.repoPath).toBe('/Users/tester/ranzo_project/bonsai')
  })

  it('末尾のスラッシュを落とす', () => {
    const t = validateTask({ ...valid, repoPath: '/Users/tester/ranzo_project/bonsai/' }, opts)
    expect(t.repoPath).toBe('/Users/tester/ranzo_project/bonsai')
  })

  it.each([
    '/etc',
    '/Users/tester/Documents/secret',
    '/Users/tester/ranzo_project/../../etc',
    '~/ranzo_project/../.ssh',
    'relative/path',
  ])('許可ルートの外は拒否する: %s', (p) => {
    expect(() => validateTask({ ...valid, repoPath: p }, opts)).toThrow(/許可/)
  })

  it('許可ルートそのものは受け付ける', () => {
    const t = validateTask({ ...valid, repoPath: '/Users/tester/ranzo_project' }, opts)
    expect(t.repoPath).toBe('/Users/tester/ranzo_project')
  })

  it('許可ルートに似た別ディレクトリは拒否する', () => {
    expect(() => validateTask({ ...valid, repoPath: '/Users/tester/ranzo_project-evil' }, opts)).toThrow(/許可/)
  })
})

describe('validateTask / 数値の範囲', () => {
  it.each([
    ['timeoutMinutes', 0],
    ['timeoutMinutes', -5],
    ['timeoutMinutes', 721],
    ['timeoutMinutes', 'たくさん'],
    ['catchUpGraceHours', 0],
    ['catchUpGraceHours', 73],
  ])('%s = %s は拒否する', (key, value) => {
    expect(() => validateTask({ ...valid, [key]: value }, opts)).toThrow()
  })

  it('範囲内の値はそのまま通る', () => {
    const t = validateTask({ ...valid, timeoutMinutes: 90, catchUpGraceHours: 12 }, opts)
    expect(t.timeoutMinutes).toBe(90)
    expect(t.catchUpGraceHours).toBe(12)
  })

  it('文字列の数値も受け付ける（フォームからの入力）', () => {
    const t = validateTask({ ...valid, timeoutMinutes: '45' }, opts)
    expect(t.timeoutMinutes).toBe(45)
  })
})

describe('validateTask / 真偽値', () => {
  it('チェックボックス由来の文字列を解釈する', () => {
    const t = validateTask({ ...valid, draftPr: 'false', catchUp: 'true', enabled: false }, opts)
    expect(t.draftPr).toBe(false)
    expect(t.catchUp).toBe(true)
    expect(t.enabled).toBe(false)
  })
})

describe('mergeTask', () => {
  it('部分更新をマージして検証する', () => {
    const existing = validateTask(valid, opts)
    const merged = mergeTask(existing, { schedule: { type: 'daily', time: '03:00' } }, opts)
    expect(merged.schedule.time).toBe('03:00')
    expect(merged.name).toBe(existing.name)
  })

  it('更新後に不正になる変更は拒否する', () => {
    const existing = validateTask(valid, opts)
    expect(() => mergeTask(existing, { agent: 'gemini' }, opts)).toThrow()
    expect(() => mergeTask(existing, { repoPath: '/etc' }, opts)).toThrow(/許可/)
  })

  it('未知のキーと id の上書きは無視する', () => {
    const existing = { ...validateTask(valid, opts), id: 'task-1' }
    const merged = mergeTask(existing, { nope: 1, id: 'ずるい' }, opts)
    expect(merged.nope).toBeUndefined()
    expect(merged.id).toBe('task-1')
  })
})
