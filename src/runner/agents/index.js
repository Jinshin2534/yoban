// AI CLI の起動。コマンドの組み立てと実行を分けてあるので、テストでは偽エージェントに差し替えられる。
import { spawnProcess } from '../exec.js'
import { buildClaudeCommand } from './claude.js'
import { buildCodexCommand } from './codex.js'

export function buildAgentCommand({ agent, prompt, cwd, model }) {
  if (agent === 'claude') return buildClaudeCommand({ prompt, cwd, model })
  if (agent === 'codex') return buildCodexCommand({ prompt, cwd, model })
  throw new Error(`未知のエージェント: ${agent}`)
}

/**
 * エージェントを起動して終わるまで待つ。
 * 非ゼロ終了やタイムアウトは例外にせず、結果として返す（呼ぶ側が run の状態に落とす）。
 */
export async function runAgent({ command, agent, prompt, cwd, model, timeoutMs, onOutput, signal, env }) {
  const cmd = command ?? buildAgentCommand({ agent, prompt, cwd, model })
  return spawnProcess({
    command: cmd.command,
    args: cmd.args,
    cwd,
    env,
    timeoutMs,
    onOutput,
    signal,
  })
}
