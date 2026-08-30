// 夜番の画面。API を叩いて描くだけ。判断はすべてサーバー側にある。

const STATUS_LABEL = {
  queued: '待機',
  running: '実行中',
  success: '成功',
  no_changes: '変更なし',
  failed: '失敗',
  timeout: 'タイムアウト',
  cancelled: '中止',
}

const state = { tasks: [], runs: [], health: null, repos: [], editing: null, logRun: null }

const $ = (id) => document.getElementById(id)

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-yoban': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return null
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(data?.error ?? `エラー ${res.status}`)
  return data
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatDuration(run) {
  if (!run.startedAt) return ''
  const end = run.endedAt ? new Date(run.endedAt) : new Date()
  const ms = end - new Date(run.startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  return min > 0 ? `${min}分` : `${Math.round(ms / 1000)}秒`
}

const badge = (status) =>
  el('span', { class: `badge ${status}`, text: STATUS_LABEL[status] ?? status })

// ---- 描画 ----

function renderHealth() {
  const h = state.health
  $('health').textContent = h
    ? `タスク ${h.tasks} 件 ・ 実行中 ${h.running} ・ 待機 ${h.queued}`
    : 'デーモンにつながりません'
}

function renderTasks() {
  const box = $('tasks')
  box.replaceChildren()
  if (state.tasks.length === 0) {
    box.appendChild(el('p', { class: 'empty', text: 'まだタスクがありません。「タスクを追加」から作ってください。' }))
    return
  }
  for (const task of state.tasks) {
    const last = task.lastRun
    box.appendChild(
      el('div', { class: `task ${task.enabled ? '' : 'disabled'}` }, [
        el('div', {}, [
          el('div', { class: 'task-name', text: task.name }),
          el('div', { class: 'task-meta' }, [
            el('span', { text: task.agent === 'codex' ? 'Codex' : 'Claude Code' }),
            el('span', { text: task.scheduleText }),
            el('span', { text: `次回 ${task.enabled ? formatTime(task.nextRunAt) : '—'}` }),
            last ? badge(last.status) : el('span', { class: 'run-sub', text: '未実行' }),
            last?.prUrl ? el('a', { href: last.prUrl, target: '_blank', text: 'PR' }) : null,
          ]),
          el('div', { class: 'repo', text: task.repoPath }),
        ]),
        el('div', { class: 'task-actions' }, [
          el('button', { class: 'quiet', text: '今すぐ実行', onclick: () => runNow(task) }),
          el('button', { class: 'quiet', text: task.enabled ? '無効にする' : '有効にする', onclick: () => toggle(task) }),
          el('button', { class: 'quiet', text: '編集', onclick: () => openForm(task) }),
          el('button', { class: 'quiet', text: '削除', onclick: () => removeTask(task) }),
        ]),
      ]),
    )
  }
}

function renderRuns() {
  const box = $('runs')
  box.replaceChildren()
  if (state.runs.length === 0) {
    box.appendChild(el('p', { class: 'empty', text: 'まだ実行はありません。' }))
    return
  }
  for (const run of state.runs) {
    box.appendChild(
      el('div', { class: 'run', onclick: () => openLog(run) }, [
        badge(run.status),
        el('div', { class: 'run-main' }, [
          el('div', { class: 'run-name', text: run.taskName ?? '(削除されたタスク)' }),
          el('div', {
            class: 'run-sub',
            text: run.errorMessage ?? (run.finalMessage ? run.finalMessage.split('\n')[0] : `ステップ: ${run.step ?? '—'}`),
          }),
        ]),
        el('div', { class: 'run-right' }, [
          run.prUrl ? el('a', { href: run.prUrl, target: '_blank', text: 'PR', onclick: (e) => e.stopPropagation() }) : null,
          el('span', { text: formatDuration(run) }),
          el('span', { text: formatTime(run.startedAt ?? run.createdAt) }),
        ]),
      ]),
    )
  }
}

function render() {
  renderHealth()
  renderTasks()
  renderRuns()
}

// ---- 操作 ----

async function refresh() {
  try {
    const [health, tasks, runs] = await Promise.all([
      api('/api/health'),
      api('/api/tasks'),
      api('/api/runs?limit=30'),
    ])
    Object.assign(state, { health, tasks, runs })
  } catch {
    state.health = null
  }
  render()
  return state
}

async function runNow(task) {
  try {
    await api(`/api/tasks/${task.id}/run`, { method: 'POST' })
    await refresh()
  } catch (err) {
    alert(err.message)
  }
}

async function toggle(task) {
  await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { enabled: !task.enabled } })
  await refresh()
}

async function removeTask(task) {
  if (!confirm(`「${task.name}」を削除します。実行履歴も消えます。`)) return
  await api(`/api/tasks/${task.id}`, { method: 'DELETE' })
  await refresh()
}

// ---- フォーム ----

function syncScheduleFields() {
  const type = $('task-form').elements.scheduleType.value
  for (const node of document.querySelectorAll('[data-when]')) {
    node.hidden = !node.dataset.when.split(' ').includes(type)
  }
}

function openForm(task = null) {
  state.editing = task
  const form = $('task-form')
  form.reset()
  $('dialog-title').textContent = task ? 'タスクを編集' : 'タスクを追加'
  $('form-error').hidden = true

  const f = form.elements
  if (task) {
    f.name.value = task.name
    f.repoPath.value = task.repoPath
    f.prompt.value = task.prompt
    f.agent.value = task.agent
    f.model.value = task.model ?? ''
    f.baseBranch.value = task.baseBranch ?? ''
    f.setupCommand.value = task.setupCommand ?? ''
    f.verifyCommand.value = task.verifyCommand ?? ''
    f.timeoutMinutes.value = task.timeoutMinutes
    f.catchUpGraceHours.value = task.catchUpGraceHours
    f.catchUp.checked = task.catchUp
    f.draftPr.checked = task.draftPr
    f.keepWorktreeOnFailure.checked = task.keepWorktreeOnFailure
    const s = task.schedule ?? {}
    f.scheduleType.value = s.type ?? 'daily'
    if (s.time) f.time.value = s.time
    if (s.hours) f.hours.value = s.hours
    if (s.at) f.at.value = s.at
    for (const box of form.querySelectorAll('input[name="days"]')) {
      box.checked = (s.days ?? []).includes(box.value)
    }
  }
  syncScheduleFields()
  $('task-dialog').showModal()
}

function scheduleFromForm(f) {
  const type = f.scheduleType.value
  if (type === 'daily') return { type, time: f.time.value }
  if (type === 'weekly') {
    const days = [...document.querySelectorAll('input[name="days"]:checked')].map((b) => b.value)
    return { type, days, time: f.time.value }
  }
  if (type === 'interval') return { type, hours: Number(f.hours.value) }
  return { type: 'once', at: f.at.value }
}

async function submitForm(event) {
  event.preventDefault()
  const form = $('task-form')
  const f = form.elements
  const body = {
    name: f.name.value,
    repoPath: f.repoPath.value,
    prompt: f.prompt.value,
    agent: f.agent.value,
    model: f.model.value || null,
    baseBranch: f.baseBranch.value || null,
    setupCommand: f.setupCommand.value || null,
    verifyCommand: f.verifyCommand.value || null,
    timeoutMinutes: Number(f.timeoutMinutes.value),
    catchUpGraceHours: Number(f.catchUpGraceHours.value),
    catchUp: f.catchUp.checked,
    draftPr: f.draftPr.checked,
    keepWorktreeOnFailure: f.keepWorktreeOnFailure.checked,
    schedule: scheduleFromForm(f),
  }
  try {
    if (state.editing) await api(`/api/tasks/${state.editing.id}`, { method: 'PATCH', body })
    else await api('/api/tasks', { method: 'POST', body })
    $('task-dialog').close()
    await refresh()
  } catch (err) {
    const box = $('form-error')
    box.textContent = err.message
    box.hidden = false
  }
}

// ---- ログ ----

let logSource = null

async function openLog(run) {
  state.logRun = run
  $('log-title').textContent = `${run.taskName ?? '実行'} — ${STATUS_LABEL[run.status] ?? run.status}`
  const body = $('log-body')
  body.textContent = '読み込み中…'
  $('cancel-run').hidden = !['queued', 'running'].includes(run.status)
  $('log-dialog').showModal()

  closeLogStream()
  const text = await (await fetch(`/api/runs/${run.id}/log`)).text()
  body.textContent = text || '（ログはまだありません）'
  body.scrollTop = body.scrollHeight

  if (['queued', 'running'].includes(run.status)) {
    logSource = new EventSource(`/api/runs/${run.id}/log?follow=1`)
    logSource.addEventListener('log', (e) => {
      if (body.textContent === '（ログはまだありません）') body.textContent = ''
      body.textContent += JSON.parse(e.data)
      body.scrollTop = body.scrollHeight
    })
    logSource.addEventListener('done', (e) => {
      const status = JSON.parse(e.data).status
      $('log-title').textContent = `${run.taskName ?? '実行'} — ${STATUS_LABEL[status] ?? status}`
      $('cancel-run').hidden = true
      closeLogStream()
      refresh()
    })
  }
}

function closeLogStream() {
  if (logSource) {
    logSource.close()
    logSource = null
  }
}

// ---- 起動 ----

function setupEvents() {
  $('add-task').addEventListener('click', () => openForm(null))
  $('cancel-form').addEventListener('click', () => $('task-dialog').close())
  $('task-form').addEventListener('submit', submitForm)
  $('task-form').elements.scheduleType.addEventListener('change', syncScheduleFields)
  $('close-log').addEventListener('click', () => {
    closeLogStream()
    $('log-dialog').close()
  })
  $('cancel-run').addEventListener('click', async () => {
    if (!state.logRun) return
    await api(`/api/runs/${state.logRun.id}/cancel`, { method: 'POST' })
    $('cancel-run').hidden = true
    await refresh()
  })
}

async function loadRepos() {
  try {
    state.repos = await api('/api/repos')
    const list = $('repo-list')
    list.replaceChildren(...state.repos.map((r) => el('option', { value: r.path, label: r.name })))
  } catch {
    // 候補が出ないだけなので、失敗しても画面は使える
  }
}

function scheduleAutoRefresh() {
  setInterval(() => {
    const busy = state.health?.running > 0 || state.health?.queued > 0
    if (busy || document.visibilityState === 'visible') refresh()
  }, 5000)
}

setupEvents()
loadRepos()
refresh()
scheduleAutoRefresh()

// ヘッドレスからの検証用
window.__app = { state, refresh, openForm, openLog, api, render }
