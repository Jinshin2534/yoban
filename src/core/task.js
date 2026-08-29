// タスク定義の検証と正規化。ファイルシステムには触れず、パス文字列の判定だけを行う。
import path from 'node:path'
import os from 'node:os'
import { validateSchedule } from './schedule.js'

export const AGENTS = ['claude', 'codex']

export const DEFAULTS = {
  enabled: true,
  baseBranch: null,
  model: null,
  setupCommand: null,
  verifyCommand: null,
  timeoutMinutes: 30,
  catchUp: true,
  catchUpGraceHours: 6,
  draftPr: true,
  keepWorktreeOnFailure: false,
}

const LIMITS = {
  timeoutMinutes: [1, 720],
  catchUpGraceHours: [1, 72],
}

function requiredText(value, label) {
  const t = typeof value === 'string' ? value.trim() : ''
  if (!t) throw new Error(`${label}を入力してください`)
  return t
}

function optionalText(value, fallback = null) {
  if (value == null) return fallback
  const t = String(value).trim()
  return t === '' ? null : t
}

function toBool(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const t = String(value).trim().toLowerCase()
  if (['true', '1', 'on', 'yes'].includes(t)) return true
  if (['false', '0', 'off', 'no', ''].includes(t)) return false
  throw new Error(`真偽値として解釈できません: ${value}`)
}

function toInt(value, key, fallback) {
  if (value == null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${key} は整数で指定してください: ${value}`)
  const [min, max] = LIMITS[key]
  if (n < min || n > max) throw new Error(`${key} は ${min}〜${max} の範囲で指定してください: ${n}`)
  return n
}

/** '~' を展開し、許可ルート配下の絶対パスに正規化する */
export function normalizeRepoPath(input, { allowedRoots, home = os.homedir() } = {}) {
  const raw = requiredText(input, 'リポジトリのパス')
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
  const resolved = path.resolve(expanded).replace(/\/+$/, '') || '/'

  if (!path.isAbsolute(expanded)) {
    throw new Error(`リポジトリのパスは絶対パスで、許可ルートの中を指定してください: ${raw}`)
  }
  const roots = (allowedRoots ?? []).map((r) => path.resolve(r.startsWith('~/') ? path.join(home, r.slice(2)) : r))
  const inside = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  if (!inside) {
    throw new Error(`許可されたルート（${roots.join(', ')}）の外は指定できません: ${resolved}`)
  }
  return resolved
}

/** 入力を検証し、既定値を埋めたタスクを返す。壊れていれば例外。 */
export function validateTask(input, options = {}) {
  if (!input || typeof input !== 'object') throw new Error('タスクの内容がありません')

  const agent = optionalText(input.agent)
  if (!AGENTS.includes(agent)) throw new Error(`agent は ${AGENTS.join(' か ')} を指定してください: ${input.agent}`)

  return {
    name: requiredText(input.name, 'タスク名'),
    repoPath: normalizeRepoPath(input.repoPath, options),
    agent,
    prompt: requiredText(input.prompt, 'プロンプト'),
    schedule: validateSchedule(input.schedule),
    enabled: toBool(input.enabled, DEFAULTS.enabled),
    baseBranch: optionalText(input.baseBranch, DEFAULTS.baseBranch),
    model: optionalText(input.model, DEFAULTS.model),
    setupCommand: optionalText(input.setupCommand, DEFAULTS.setupCommand),
    verifyCommand: optionalText(input.verifyCommand, DEFAULTS.verifyCommand),
    timeoutMinutes: toInt(input.timeoutMinutes, 'timeoutMinutes', DEFAULTS.timeoutMinutes),
    catchUp: toBool(input.catchUp, DEFAULTS.catchUp),
    catchUpGraceHours: toInt(input.catchUpGraceHours, 'catchUpGraceHours', DEFAULTS.catchUpGraceHours),
    draftPr: toBool(input.draftPr, DEFAULTS.draftPr),
    keepWorktreeOnFailure: toBool(input.keepWorktreeOnFailure, DEFAULTS.keepWorktreeOnFailure),
  }
}

const EDITABLE_KEYS = [
  'name', 'repoPath', 'agent', 'prompt', 'schedule', 'enabled', 'baseBranch', 'model',
  'setupCommand', 'verifyCommand', 'timeoutMinutes', 'catchUp', 'catchUpGraceHours',
  'draftPr', 'keepWorktreeOnFailure',
]

/** 既存タスクに部分更新を当てて検証する。id や作成日時は patch から書き換えられない。 */
export function mergeTask(existing, patch, options = {}) {
  const next = { ...existing }
  for (const key of EDITABLE_KEYS) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key]
  }
  const validated = validateTask(next, options)
  return {
    ...validated,
    ...(existing?.id !== undefined ? { id: existing.id } : {}),
    ...(existing?.createdAt !== undefined ? { createdAt: existing.createdAt } : {}),
  }
}
