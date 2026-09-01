## Claude Code Multi-Agent Dashboard

窓口セッション（Claude Code CLI）から複数のサブエージェントセッションへ出した指示と、その進捗をレーンごとに監視するローカルNext.jsダッシュボード。

### 決まっている設計方針

- **指示の入力口はCLIのみ。** ダッシュボード側に指示入力欄は置かない。窓口セッションで打った `#A ...` のような行をフックまたは専用コマンド経由でバックエンドAPIに渡し、対応するサブエージェントセッション（`git worktree` + `claude` CLIサブプロセス）にルーティングする。
- **窓口セッション自身はボードにならない。** ボードとして表示されるのは、バックエンドが `child_process` で実際にスポーンしたサブエージェントセッションのみ。
- **複数指示の一括送信に対応する。** 窓口セッションでの入力は、`#`で始まる行を新しい指示の開始とみなし、次の`#`行（または入力の終端）までをその宛先への指示本文として扱う。1回の送信で複数エージェントへ同時に指示を出せるようにする（並列ディスパッチ、逐次待ちしない）。
- **ダッシュボードは監視専用。返信フォームも置かない。** 対話待ちのレーンへの返信も「指示」なので、窓口CLIから出す。ダッシュボード上に文字を入力する場所は一切作らない。
- **ダッシュボード側から直接できる操作**（指示ではなく、レーンの操作・表示に限る）:
  - 緊急停止（Kill）
  - エラー時の再試行
  - Git Diffの開閉表示
  - レーンのフォーカス拡大 / 一覧表示切り替え（3 / 4 / 5 / 8 レーン、横スクロール）
- **通知**: 完了・対話待ちのレーンはバッジ（ドット）とカードの縁取りでハイライトする。

### 技術スタック

- TypeScript / Node.js
- Next.js (App Router) + Tailwind CSS — UIとAPI Routesを1プロジェクトに統合
- SSE (Server-Sent Events) — `app/api/**/route.ts` の `ReadableStream` でサブエージェントの標準出力をリアルタイム配信
- `child_process` + `git worktree` — サブエージェントごとに作業ディレクトリを完全分離

### ディレクトリ

```
src/app/page.tsx                 ダッシュボード本体
src/components/LaneCard.tsx      1レーン分のボード
src/lib/agents-cli.ts            claude CLI と git diff のラッパー
src/lib/dashboard-data.ts        ステータスの配色・ラベル定義
src/app/api/agents/              セッション一覧（GET）
src/app/api/agents/[id]/logs/    ログ取得（GET）
src/app/api/agents/[id]/diff/    作業ディレクトリの git diff（GET）
src/app/api/agents/[id]/stop/    セッション停止（POST）
src/app/api/agents/[id]/stream/  SSE配信（方式B用スタブ、未実装）
.logs/                           ログの永続化先（gitignore対象、未実装）
```

実装の詳細・設計判断の理由・環境固有の注意点は `AGENTS.md` に集約している。

### 未決定・要検討

- 窓口セッションでの `#` プレフィックス入力をどう横取りするか（`UserPromptSubmit` フック vs 専用スラッシュコマンド）
- 存在しない宛先プレフィックスを指示した場合に新規セッションを自動生成するか、事前にセッションを作る操作を必須にするか
- 最大同時アクティブ数の制御（レートリミット対策のキュー構造）

### 開発

```bash
npm run dev
```
