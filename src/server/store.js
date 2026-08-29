// SQLite への保存。検証はしない（呼ぶ側の責務）。ここは素直な入れ物に徹する。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { newId } from '../core/id.js'

const SCHEMA_VERSION = 1

const TASK_COLUMNS = [
  'name', 'enabled', 'repoPath', 'baseBranch', 'agent', 'model', 'prompt', 'schedule',
  'setupCommand', 'verifyCommand', 'timeoutMinutes', 'catchUp', 'catchUpGraceHours',
  'draftPr', 'keepWorktreeOnFailure', 'nextRunAt',
]
const TASK_BOOLEANS = ['enabled', 'catchUp', 'draftPr', 'keepWorktreeOnFailure']

const RUN_COLUMNS = [
  'status', 'step', 'trigger', 'startedAt', 'endedAt', 'branch', 'prUrl',
  'verifyExitCode', 'finalMessage', 'tokensIn', 'tokensOut', 'errorMessage', 'logPath',
]

function toRowValue(key, value) {
  if (key === 'schedule') return JSON.stringify(value ?? null)
  if (TASK_BOOLEANS.includes(key)) return value ? 1 : 0
  if (value === undefined) return null
  return value
}

function taskFromRow(row) {
  if (!row) return null
  const task = { ...row }
  for (const key of TASK_BOOLEANS) task[key] = row[key] === 1
  try {
    task.schedule = JSON.parse(row.schedule)
  } catch {
    task.schedule = null
  }
  return task
}

export function openStore(file) {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma foreign_keys = on')
  db.exec(`
    create table if not exists tasks (
      id text primary key,
      name text not null,
      enabled integer not null default 1,
      repoPath text not null,
      baseBranch text,
      agent text not null,
      model text,
      prompt text not null,
      schedule text not null,
      setupCommand text,
      verifyCommand text,
      timeoutMinutes integer not null default 30,
      catchUp integer not null default 1,
      catchUpGraceHours integer not null default 6,
      draftPr integer not null default 1,
      keepWorktreeOnFailure integer not null default 0,
      nextRunAt text,
      createdAt text not null,
      updatedAt text not null
    );
    create table if not exists runs (
      id text primary key,
      taskId text not null references tasks(id) on delete cascade,
      status text not null,
      step text,
      trigger text not null,
      startedAt text,
      endedAt text,
      branch text,
      prUrl text,
      verifyExitCode integer,
      finalMessage text,
      tokensIn integer,
      tokensOut integer,
      errorMessage text,
      logPath text not null,
      createdAt text not null
    );
    create index if not exists idx_runs_task on runs(taskId);
    create table if not exists meta (key text primary key, value text not null);
  `)
  db.prepare('insert or replace into meta (key, value) values (?, ?)').run('schemaVersion', String(SCHEMA_VERSION))

  const nowIso = () => new Date().toISOString()

  function createTask(fields) {
    const id = newId()
    const at = nowIso()
    const values = TASK_COLUMNS.map((k) => toRowValue(k, fields[k]))
    db.prepare(
      `insert into tasks (id, ${TASK_COLUMNS.join(', ')}, createdAt, updatedAt)
       values (?, ${TASK_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
    ).run(id, ...values, at, at)
    return getTask(id)
  }

  function getTask(id) {
    return taskFromRow(db.prepare('select * from tasks where id = ?').get(id))
  }

  function listTasks() {
    return db.prepare('select * from tasks order by createdAt').all().map(taskFromRow)
  }

  /** id の先頭一致 → 名前の完全一致 → 名前の部分一致 の順で 1 件だけ返す */
  function findTask(ref) {
    if (!ref) return null
    const byId = db.prepare('select * from tasks where id = ? or id like ? order by id limit 2').all(ref, `${ref}%`)
    if (byId.length === 1) return taskFromRow(byId[0])
    const byName = db.prepare('select * from tasks where name = ? limit 2').all(ref)
    if (byName.length === 1) return taskFromRow(byName[0])
    const partial = db.prepare('select * from tasks where name like ? limit 2').all(`%${ref}%`)
    if (partial.length === 1) return taskFromRow(partial[0])
    return null
  }

  function updateTask(id, patch) {
    const keys = TASK_COLUMNS.filter((k) => Object.prototype.hasOwnProperty.call(patch, k))
    if (keys.length) {
      db.prepare(`update tasks set ${keys.map((k) => `${k} = ?`).join(', ')}, updatedAt = ? where id = ?`)
        .run(...keys.map((k) => toRowValue(k, patch[k])), nowIso(), id)
    }
    return getTask(id)
  }

  function deleteTask(id) {
    return db.prepare('delete from tasks where id = ?').run(id).changes > 0
  }

  function setNextRunAt(id, iso) {
    db.prepare('update tasks set nextRunAt = ?, updatedAt = ? where id = ?').run(iso ?? null, nowIso(), id)
    return getTask(id)
  }

  function dueTasks(now = new Date()) {
    return db
      .prepare('select * from tasks where enabled = 1 and nextRunAt is not null and nextRunAt <= ? order by nextRunAt')
      .all(now.toISOString())
      .map(taskFromRow)
  }

  function createRun({ taskId, trigger, logPath, status = 'queued' }) {
    const id = newId()
    db.prepare(
      'insert into runs (id, taskId, status, trigger, logPath, createdAt) values (?, ?, ?, ?, ?, ?)',
    ).run(id, taskId, status, trigger, logPath, nowIso())
    return getRun(id)
  }

  function getRun(id) {
    return db.prepare('select * from runs where id = ?').get(id) ?? null
  }

  function findRun(ref) {
    if (!ref) return null
    const rows = db.prepare('select * from runs where id = ? or id like ? order by rowid limit 2').all(ref, `${ref}%`)
    return rows.length === 1 ? rows[0] : null
  }

  function updateRun(id, patch) {
    const keys = RUN_COLUMNS.filter((k) => Object.prototype.hasOwnProperty.call(patch, k))
    if (keys.length) {
      db.prepare(`update runs set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`)
        .run(...keys.map((k) => (patch[k] === undefined ? null : patch[k])), id)
    }
    return getRun(id)
  }

  function listRuns({ taskId, limit = 50 } = {}) {
    const sql = `select runs.*, tasks.name as taskName from runs
                 join tasks on tasks.id = runs.taskId
                 ${taskId ? 'where runs.taskId = ?' : ''}
                 order by runs.rowid desc limit ?`
    return taskId ? db.prepare(sql).all(taskId, limit) : db.prepare(sql).all(limit)
  }

  function lastRun(taskId) {
    return db.prepare('select * from runs where taskId = ? order by rowid desc limit 1').get(taskId) ?? null
  }

  /** デーモン起動時に、前回の残骸（queued / running）を失敗として閉じる */
  function closeStaleRuns(message) {
    const at = nowIso()
    return db
      .prepare("update runs set status = 'failed', errorMessage = ?, endedAt = ? where status in ('queued', 'running')")
      .run(message, at).changes
  }

  function schemaVersion() {
    return Number(db.prepare('select value from meta where key = ?').get('schemaVersion')?.value ?? 0)
  }

  return {
    createTask, getTask, listTasks, findTask, updateTask, deleteTask, setNextRunAt, dueTasks,
    createRun, getRun, findRun, updateRun, listRuns, lastRun, closeStaleRuns, schemaVersion,
    close: () => db.close(),
  }
}
