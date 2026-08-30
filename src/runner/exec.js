// 外部プロセスの起動。無人実行なので stdin は必ず塞ぐ（codex は stdin を待って固まる）。
import { spawn } from 'node:child_process'

export class ExecError extends Error {
  constructor(message, { code, stdout, stderr }) {
    super(message)
    this.name = 'ExecError'
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

/**
 * プロセスを起動して終了まで待つ。
 * - stdin は常に閉じる
 * - detached でプロセスグループを作り、タイムアウト時はグループごと止める
 * - onOutput があれば stdout/stderr を逐次流す
 */
export function spawnProcess({ command, args = [], cwd, env, timeoutMs, onOutput, signal }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false

    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          // すでに死んでいる
        }
      }
    }

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killGroup('SIGTERM')
          setTimeout(() => killGroup('SIGKILL'), 5000).unref?.()
        }, timeoutMs)
      : null

    const onAbort = () => {
      aborted = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 5000).unref?.()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      onOutput?.(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      onOutput?.(chunk)
    })

    const finish = (result, err) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (err) reject(err)
      else resolve(result)
    }

    child.on('error', (err) => finish(null, err))
    child.on('close', (code, sig) => {
      finish({ code: code ?? -1, signal: sig, stdout, stderr, timedOut, aborted })
    })
  })
}

/** 標準出力を返す。失敗したら例外。git のような短いコマンド向け。 */
export async function execCapture(command, args, options = {}) {
  const result = await spawnProcess({ command, args, ...options })
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 5).join('\n')
    throw new ExecError(`${command} ${args.join(' ')} が失敗しました (code ${result.code})\n${detail}`, {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  }
  return result.stdout
}

/** 成否だけ知りたいとき */
export async function execOk(command, args, options = {}) {
  try {
    await execCapture(command, args, options)
    return true
  } catch {
    return false
  }
}

/** シェル経由でコマンド文字列を実行する（準備コマンド・検証コマンド用） */
export function runShell(commandLine, options = {}) {
  return spawnProcess({ command: '/bin/sh', args: ['-c', commandLine], ...options })
}
