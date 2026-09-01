<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# マルチエージェント監視ダッシュボード

## このプロジェクトは何か

窓口となる Claude Code セッション（CLI）から複数のサブエージェントセッションへ並列に指示を出したとき、結果が窓口に時間差で集約されて読みづらくなる問題を解決するためのローカル専用ダッシュボード。各サブエージェントを独立した「ボード（レーン）」として横並びに表示し、状態とログを分離して監視する。外部クラウドは使わず、ローカルの Next.js サーバーのみで動く。

## 現在どこまで出来ているか

- ダッシュボードUIは実装済み。モックデータではなく、実際に動いているバックグラウンドセッションを表示する
- `claude agents --json` / `claude logs` / `claude stop` / `git diff` をAPI化して接続済み（後述の「方式A」）
- 未実装: 窓口CLIからの `#` プレフィックス指示の受け口（対話待ちレーンへの返信もこれに含まれる）、ログの構造化表示

## 主要ファイル

| パス | 役割 |
|---|---|
| `src/app/page.tsx` | ダッシュボード本体。ポーリング、レーン数切替、フォーカス表示、Kill確認 |
| `src/components/LaneCard.tsx` | 1レーン分のボード。ログ表示（最新追従つき）、Diffパネル、各種ボタン |
| `src/lib/agents-cli.ts` | `claude` CLIと `git diff` のラッパー。状態マッピングとANSI除去 |
| `src/lib/dashboard-data.ts` | ステータスの配色・ラベル定義 |
| `src/app/api/agents/route.ts` | セッション一覧（GET） |
| `src/app/api/agents/[id]/logs/route.ts` | ログ取得（GET） |
| `src/app/api/agents/[id]/diff/route.ts` | 作業ディレクトリの `git diff`（GET） |
| `src/app/api/agents/[id]/stop/route.ts` | セッション停止（POST） |
| `src/app/api/agents/[id]/stream/route.ts` | SSE配信のスタブ（方式B用、未実装） |

## 設計上の決定（変更する前に必ず読むこと）

- **ダッシュボードに指示入力欄は置かない。** 指示はすべて窓口のCLIから出す。中段にあった入力欄と送信ボタンは意図的に削除済みなので、復活させないこと
- **窓口セッション自身はボードにしない。** ボードになるのは、バックグラウンドで起動されたサブエージェントセッションだけ
- **ボードの並びはセッション開始時刻の昇順**（古いものが左）。タグ `#A` `#B` … はこの順で機械的に割り当てている
- **ボードのサイズは全レーン共通の固定値**（通常720px幅、フォーカス時980px幅）。高さは画面の残り領域いっぱいに自動で伸びる。縦スクロールは出さない
- **ログは常に最新（最下部）を表示する。** 新着で自動追従し、ユーザーが上にスクロールしている間は追従を止めて「最新へ」ボタンを出す
- **Killは本物のセッションを止める。** 実際のユーザーのセッションが並ぶので、確認ダイアログを外さないこと
- **複数行の一括指示に対応する予定**（未実装）。`#` で始まる行を新しい指示の開始とみなし、次の `#` 行または入力末尾までをその宛先への本文として扱い、並列でディスパッチする

## Claude Code CLI との接続

CLI側に、当初自前で作ろうとしていた機能がすでに揃っている。自前のプロセス管理やworktree管理を再実装しないこと。

- `claude --bg -w <名前> "指示"` — git worktreeを作ってバックグラウンド起動。短いIDを返す
- `claude agents --json` — 稼働中セッションをJSONで返す（TTY不要）。返るキー: `id` `sessionId` `name` `cwd` `kind` `startedAt` `pid` `state` `status`
- `claude logs <id>` / `claude stop <id>` / `claude rm <id>` / `claude attach <id>`

状態のマッピング（`src/lib/agents-cli.ts` の `toLaneStatus`）:

CLIが返す `state` は `working` `blocked` `done` `failed` `stopped` の5種類で、`working` 以外はすべて終端状態。

| CLIの `state` | レーンの表示 |
|---|---|
| `working` | 実行中 |
| `blocked` | 対話待ち |
| `done`（`pid`あり） | 完了 |
| `done`（`pid`なし） | 停止済み |
| `failed` | エラー |
| `stopped` | 停止済み |

`failed` は「エージェントが自分で作業を諦めて終了した」状態。これを拾わずに `done` へ倒すと、失敗したレーンが完了と同じ緑で並んで見落とすことになる。

なお `claude agents --json` は既定では完了済みセッションを含まない。過去分も並べたい場合は `--all`、対象ディレクトリで絞りたい場合は `--cwd <path>` を付ける。

### 方式Aと方式B

- **方式A（現在の実装）**: `claude agents --json` と `claude logs <id>` をポーリングする。実装が軽い。ただし `claude logs` が返すのはANSI付きの端末描画そのものなので、チャットの吹き出しではなくターミナル風の表示になる
- **方式B（次の段階）**: バックエンドが `claude -p --session-id <uuid> --output-format stream-json --include-partial-messages` を spawn し、標準出力のJSON行をそのままSSEでダッシュボードに流す。`--input-format stream-json` を併用すると走っているプロセスのstdinへ追加メッセージを送れるので、対話待ちレーンへの返信フォームもこれで実現できる

### 対話待ちの扱いについての注意

`-p`（非対話）モードには、対話型TUIのような y/n プロンプトはそのままの形では現れない。権限確認は `--permission-mode` や `--allowedTools` で事前に決める。したがって「対話待ち」は「エージェントがターンを終えて質問文を返した状態」として扱い、返信は追加プロンプトの送信として実装するのが現実的。

## この環境（Windows）特有の注意点

- **jqが入っていない。** シェルスクリプトはjq非依存で書くこと。黙って空を返して壊れる
- **`claude` は `claude.exe`** なので、`child_process` から呼ぶときに `shell: true` は不要
- **`npm run dev` を止めても `next dev` の子プロセスが生き残る。** ポートを掴んだままになるので `taskkill /PID <pid> /T /F` でプロセスツリーごと落とす。なおダッシュボードのKillは `claude stop` に任せているのでこの問題を回避できている
- **ポーリング間隔**: セッション一覧が4秒、ログが5秒。ログは表示中のレーンだけ取得している（CLI呼び出しを抑えるため）
- git worktreeを使う場合、`node_modules` は共有されないので別途インストールが必要。またTurbopackはジャンクション越しの `node_modules` を受け付けない

## 次にやること

1. 方式Bへの移行（SSEストリーミング、対話待ちへの返信送信）
2. 窓口CLIからの `#` プレフィックス指示の受け口。`UserPromptSubmit` フックで `#` 始まりの入力だけを横取りしてAPIにPOSTし、そのプロンプトはブロックする（窓口のコンテキストを消費させない）
3. 同時アクティブ数の制御（レートリミット対策のキュー）
4. ログの永続化（`.logs/`）と通知（完了・確認待ち時の音・ブラウザ通知）

## 開発コマンド

```bash
npm run dev     # http://localhost:3000
npm run build   # 型チェックを含む
```
