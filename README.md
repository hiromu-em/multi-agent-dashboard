## Claude Code Multi-Agent Dashboard

窓口セッション（Claude Code CLI）から複数のサブエージェントセッションへ出した指示と、その進捗をレーンごとに監視するローカルNext.jsダッシュボード。

### 決まっている設計方針

- **指示の入力口はCLIのみ。** ダッシュボード側に指示入力欄は置かない。窓口セッションで打った `#A ...` のような行をフックまたは専用コマンド経由でバックエンドAPIに渡し、対応するサブエージェントセッション（`git worktree` + `claude` CLIサブプロセス）にルーティングする。
- **窓口セッション自身はボードにならない。** ボードとして表示されるのは、`claude --bg` で起動されたバックグラウンドセッションのみ。
- **複数指示の一括送信に対応する。** 窓口セッションでの入力は、`#`で始まる行を新しい指示の開始とみなし、次の`#`行（または入力の終端）までをその宛先への指示本文として扱う。1回の送信で複数エージェントへ同時に指示を出せるようにする（並列ディスパッチ、逐次待ちしない）。
- **ダッシュボードは監視専用。返信フォームも置かない。** 対話待ちのレーンへの返信も「指示」なので、窓口CLIから出す。ダッシュボード上に文字を入力する場所は一切作らない。
- **ダッシュボード側から直接できる操作**（指示ではなく、レーンの操作・表示に限る）:
  - 緊急停止（Kill、実セッションを止めるため確認ダイアログあり）
  - Git Diffの開閉表示
  - レーンのフォーカス拡大 / 一覧表示切り替え（横スクロール）
- **宛先は固定式（スティッキー）。** `#B 本文` で宛先を切り替え、以降タグなしの入力は同じ宛先へ送られる。`#` 単独で宛先を解除して窓口との会話に戻る。現在の宛先は誤爆防止のためステータスラインとダッシュボードの両方に常時表示する。
- **窓口セッション自身をボードから除外する仕組みが必要。** `claude --bg` セッションとして窓口を動かす場合、`.logs/gateway.json` に自分の `sessionId` を登録しないと、窓口自身がボードに並び、かつ配送ループ防止に引っかかって指示が配送されなくなる。
- **通知**: 完了・対話待ちのレーンはバッジとカードの縁取りでハイライトする（音・ブラウザ通知は未実装）。

### 技術スタック

- TypeScript / Node.js
- Next.js (App Router) + Tailwind CSS — UIとAPI Routesを1プロジェクトに統合
- `claude` CLI — セッションの起動・停止・一覧は自前で実装せずCLIに任せる（`git worktree` の管理もCLI側が持っている）
- セッションの会話JSONL（`~/.claude/projects/**/<sessionId>.jsonl`）— ログはここから読む。端末出力を経由しないので、発言とツール実行を分けて表示できる

### ディレクトリ

```
src/app/page.tsx                 ダッシュボード本体
src/components/LaneCard.tsx      1レーン分のボード
src/lib/agents-cli.ts            claude CLI と git diff のラッパー
src/lib/transcript.ts            セッションの会話JSONLの読み取り
src/lib/agent-diff.ts            作業ディレクトリの変更収集
src/lib/dashboard-data.ts        ステータスの配色・ラベル定義
src/lib/dispatch.ts              指示の振り分け・宛先の保持・順番待ち
src/lib/dispatch-log.ts          配送の記録（.logs/dispatch.jsonl）
src/lib/lane-registry.ts         セッションの台帳（タグ割り当て・終了時刻）
src/app/api/agents/              セッション一覧（GET）
src/app/api/agents/[id]/logs/    会話取得（GET）
src/app/api/agents/[id]/diff/    作業ディレクトリの git diff（GET）
src/app/api/agents/[id]/stop/    セッション停止（POST）
src/app/api/dispatch/            指示の受け口（POST）と現在の宛先（GET）
scripts/route-prompt.mjs         窓口CLIの UserPromptSubmit フック
scripts/statusline.mjs           窓口CLIのステータスラインに宛先を出す
.logs/                           .logs/dispatch.jsonl・sessions.json・target.json・gateway.json（gitignore対象）
```

実装の詳細・設計判断の理由・環境固有の注意点は `AGENTS.md` に集約している。

### 未決定・要検討

- 通知（完了・確認待ち時の音・ブラウザ通知）は未実装
- 存在しない宛先を指した場合の扱い。現状はエラーにしている（自動生成にするかは未決）
- 順番待ちキューはサーバーのメモリに置いているため再起動で消える。永続化するかは未決

### 開発

```bash
npm run dev
```
