// Claude Code (claude -p) のコマンドライン組み立て。
export function buildClaudeCommand({ prompt, model }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
  ]
  if (model) args.push('--model', model)
  return { command: 'claude', args }
}
