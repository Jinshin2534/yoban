// Codex (codex exec) のコマンドライン組み立て。
// worktree の中だけを書き込み可能にしつつ、依存の取得やテスト実行のためネットワークは開ける。
export function buildCodexCommand({ prompt, cwd, model }) {
  const args = [
    'exec',
    '--cd', cwd,
    '-s', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '--json',
  ]
  if (model) args.push('-m', model)
  args.push(prompt)
  return { command: 'codex', args }
}
