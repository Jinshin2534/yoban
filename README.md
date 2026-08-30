# 夜番 (yoban)

時刻を指定して、指定したリポジトリに Claude Code / Codex のコーディングタスクを自動で投げ、
結果を **Pull Request** として受け取るためのローカルツール。
寝ているあいだに AI に働いてもらい、朝 PR を見て採否を決める、という使い方を想定している。

作業は必ず専用の `git worktree` の中で行うので、リポジトリ本体と作業中のファイルには一切触れない。

## つかう

```bash
pnpm install
node bin/yoban.js install     # launchd に常駐登録（ログイン時に自動起動）
node bin/yoban.js open        # Web UI → http://localhost:5460
```

デバッグ中など、常駐させずに前面で動かしたいときは `pnpm serve`。

### CLI

Web UI と同じ API を叩くので、どちらから触っても同じ状態を見る。

```bash
yoban add --name "テストを足す" --repo ~/ranzo_project/hair-pin \
          --prompt-file ./task.md --daily 02:00 --verify "pnpm test"
yoban list                    # 一覧と次回実行時刻
yoban run <task>              # 今すぐ実行
yoban logs <run> --follow     # 実行ログを追いかける
yoban runs                    # 実行履歴（PR のリンク付き）
yoban status                  # デーモンの状態
```

スケジュールは `--daily 02:00` / `--weekly mon,thu@02:00` / `--every 6h` / `--once "2026-08-30 09:00"` の4種類。

## テスト

```bash
pnpm test
```

AI CLI は偽エージェントに差し替えて回すので、テストで課金は発生しない。
git まわりは tmp に本物のリポジトリ（bare を origin 役に）を作って通している。

## 作りの要点

- **1回の実行の流れ**: preflight → worktree 作成 → 準備コマンド → AI 実行 → 変更検出
  → 検証コマンド → commit → push → `gh pr create` → 後片付け
- **git 操作は AI にやらせない**。ブランチ・コミット・push・PR 作成はすべて runner 側で決め打ちにし、
  AI の仕事はファイルの変更だけに限る。プロンプトにもその約束を必ず添える。
  無人実行では AI の git 操作ミスに誰も気付けないので、ここが信頼性の分かれ目になる
- **変更がゼロなら PR を作らない**（`no_changes` として正常終了）。空 PR を量産しないため
- **検証コマンドが失敗しても PR は作る**。終了コードと出力をそのまま PR 本文と UI に載せ、判断は人に任せる
- **catch-up**: スリープで予定を逃しても、復帰後に1回だけ追いかける。
  遅れが猶予（既定6時間）を超えていたらスキップして次回に回す。朝PCを開けた瞬間に夜中のタスクが走り出さないように
- **同時実行**は既定2本まで。同じリポジトリに対しては常に1本だけ（fetch の競合回避）
- 純粋ロジックは `src/core/`（スケジュール計算・ブランチ名・AI 出力の解析・PR 本文）。
  副作用は `src/runner/`、デーモンは `src/server/`
- 実行時の依存はゼロ。`node:sqlite` / `node:http` / `node:child_process` だけで動く（Node 24 系を想定）

### ハマりどころ

- **`codex exec` は stdin を待って固まる**。無人実行では stdin を必ず閉じる（`stdio: ['ignore', ...]`）
- 同一ミリ秒に作った ID は辞書順が保証されないので、実行履歴の並びは `rowid` で取る
- `[hidden]` は `form label { display: grid }` に負ける。`[hidden] { display: none !important }` が要る

## 意図的な制約

- **完了通知は出さない**。Web UI を見に行く運用
- **自動リトライはしない**。無人で同じ失敗を繰り返すだけなので、手動で再実行する
- **cron 式は使えない**。上記4種類で足りるはずで、必要になってから足す
- **worktree は OS レベルのサンドボックスではない**。作業中のファイルとリポジトリ本体を守るための隔離であって、
  Claude Code の `bypassPermissions` は理屈上その外にも触れられる（Codex の `-s workspace-write` は本物のサンドボックス）。
  完全な封じ込めが要るなら Docker などが必要で、それはこのツールの範囲外
- リポジトリのパスは許可ルート（既定 `~/ranzo_project`）の配下しか受け付けない。
  サーバーは `127.0.0.1` のみに bind し、書き込み系 API は専用ヘッダを要求する
