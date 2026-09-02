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
- `claude agents --json` / `claude stop` / `git diff` をAPI化して接続済み。ログは `claude logs` ではなく会話JSONLから読む（後述）
- ログはセッションの会話JSONLから読み、発言・ツール実行・エラーを分けて表示する
- 未実装: 窓口CLIからの `#` プレフィックス指示の受け口（対話待ちレーンへの返信もこれに含まれる）

## 主要ファイル

| パス | 役割 |
|---|---|
| `src/app/page.tsx` | ダッシュボード本体。ポーリング、レーン数切替、フォーカス表示、Kill確認 |
| `src/components/LaneCard.tsx` | 1レーン分のボード。会話表示（最新追従つき）、Diffパネル、各種ボタン |
| `src/lib/agents-cli.ts` | `claude` CLIと `git diff` のラッパー。状態マッピング |
| `src/lib/transcript.ts` | セッションの会話JSONLを読んで表示用に整形する |
| `src/lib/lane-registry.ts` | セッションの台帳。タグの割り当てと終了時刻の記録（`.logs/sessions.json`） |
| `src/lib/dashboard-data.ts` | ステータスの配色・ラベル定義 |
| `src/app/api/agents/route.ts` | セッション一覧（GET） |
| `src/app/api/agents/[id]/logs/route.ts` | 会話取得（GET）。`?session=<uuid>` を取る |
| `src/app/api/agents/[id]/diff/route.ts` | 作業ディレクトリの `git diff`（GET） |
| `src/app/api/agents/[id]/stop/route.ts` | セッション停止（POST） |
| `src/app/api/agents/[id]/stream/route.ts` | SSE配信のスタブ（未実装。JSONLの更新通知に使う想定） |

## 設計上の決定（変更する前に必ず読むこと）

- **ダッシュボードに指示入力欄は置かない。** 指示はすべて窓口のCLIから出す。中段にあった入力欄と送信ボタンは意図的に削除済みなので、復活させないこと
- **窓口セッション自身はボードにしない。** ボードになるのは、バックグラウンドで起動されたサブエージェントセッションだけ
- **ボードの並びはセッション開始時刻の昇順**（古いものが左）
- **タグ `#A` `#B` … は並び順ではなくsessionIdに紐づく**（`src/lib/lane-registry.ts`、`.logs/sessions.json` に永続化）。指示の宛先として使うので、一度割り当てたら動かしてはいけない。配列の添字から作ると、古いセッションが1つ消えるだけで後続が繰り上がり `#C` 宛ての指示が別のセッションへ届く。**そのため表示は `#A #C #D` のように飛ぶことがある。これは仕様。**

  **タグは使い回す。** 生きているセッションが持っていないタグはすべて再利用の候補。ただし配る順序で間隔を稼ぐ：未使用のタグを先に配り、無ければ「最後に見かけたのが最も古いタグ」を選ぶ。こうすると直前に終わったタグがすぐ次のセッションへ渡らない。`#27` のような数字タグは、A〜Zの26個すべてが**同時に生きている**ときだけ出る（時間経過では出ない）
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

**`claude agents --json` は既定では終了したセッションを返さない。** そのため `--all` を付けている。これが無いと `failed` のレーンが赤く出るどころか一覧から消え、一番見落としてはいけないものが一番静かに消える。

`--all` は過去の完了分も全部返すので、終わったレーンは**終了から3時間で盤面から落とす**（`src/lib/lane-registry.ts` の `RETENTION_MS`）。終了時刻はCLIが返さないので、終端状態を最初に観測した時刻を台帳に記録して起点にしている。

**対話待ち（`blocked`）は打ち切りの対象外。** 人の応答を待っている状態なので、消すと返事待ちのレーンに気づけなくなる。

### ログは会話JSONLから読む（`claude logs` は使わない）

Claude Code はセッションごとの会話を JSONL で書き出している。

```
~/.claude/projects/<cwdを符号化したディレクトリ>/<sessionId>.jsonl
```

`src/lib/transcript.ts` がこれを追尾する。`claude logs` の出力はANSI付きの端末描画そのもので、進捗表示の上書き（`\r`）が縦に展開されてログが数百行に膨らむ上、発言とツール実行を区別できない。JSONLなら構造化された会話がそのまま取れて、CLIの起動も要らない。

- ディレクトリ名の符号化規則は公開されていないので、**パスを組み立てず `<sessionId>.jsonl` を各ディレクトリから探す**。sessionId が無い場合は短いID（sessionIdの先頭8桁）の前方一致で探す
- 会話が長くなるので末尾512KBだけ読む。途中から読むと1行目が欠けるので捨てる（マルチバイト文字の切断もここで落ちる）
- 出すのは「窓口の指示」「エージェントの発言」「ツール実行」「失敗したツール結果」の4種類。思考（`thinking`）と成功したツール結果は出さない。`isSidechain` はサブエージェント内部のやり取りなので除外する

**方式B（バックエンドが `claude -p --output-format stream-json` を spawn する案）は採用しない。** あれはバックエンドがセッションの所有者になる設計で、`claude --bg` で起動したセッションを外から監視する今の形と噛み合わない。構造化ログという目的はJSONL追尾で達成済み。

### 宛先は固定式（スティッキー）

`#` を毎回打つ手間を減らすため、**直前に指示した宛先を覚えておき、`#` の無い入力はそこへ送る**。

| 入力 | 動作 |
|---|---|
| `#B 本文` | 宛先をBに切り替えて送信 |
| 本文だけ（宛先あり） | その宛先へ送信 |
| 本文だけ（宛先なし） | 窓口のClaudeへ素通し（横取りしない） |
| **`#` 単独** | **宛先を解除。以降は窓口と会話する** |

複数行の一括指示（`#B` と `#C` を並べる）では、最後に書いた `#` が宛先として残る。

宛先は `.logs/target.json` に持つ。フック（窓口CLI側で動く）とダッシュボードAPIの両方から読む必要があるため。

**この方式は誤爆する。** 宛先が残っているのを忘れて窓口に話しかけると、その文がエージェントへ飛ぶ。Enterを押した時点で配送されるので取り消せない。したがって**現在の宛先を常時表示することが必須**：

- `statusLine` 設定（任意コマンドの出力をCLI下部に常時表示できる）で `→ #B 認証機能` のように出す
- ダッシュボード側でも現在の宛先レーンを強調する

宛先のセッションが終了・消滅したら自動で解除して窓口に戻す。消えたセッション宛てに打ち続けるのを防ぐため。

### 窓口CLIから指示を飛ばす方法（未実装）

`claude --bg --resume <sessionId> "指示"` で既存セッションを継続できる。ただし **対象が実行中（`working`）のときは継続にならずコピーが新しく生える**（`--bg` のヘルプに明記）。`claude agents --json` の `state` を見て、`working` の間は送らずキューに積む必要がある。これは並列数の制御ではなく、セッションの複製を防ぐために必須。

### 対話待ちの扱いについての注意

バックグラウンドセッションには、対話型TUIのような y/n プロンプトはそのままの形では現れない。権限確認は `--permission-mode` や `--allowedTools` で事前に決める。したがって「対話待ち」（`state: "blocked"`）は「エージェントがターンを終えて質問文を返した状態」であり、返信は割り込みではなく**追加プロンプトの送信**になる。送信手段は上の `claude --bg --resume` と同じで、返信専用の仕組みは要らない。

## この環境（Windows）特有の注意点

- **jqが入っていない。** シェルスクリプトはjq非依存で書くこと。黙って空を返して壊れる
- **`claude` は `claude.exe`** なので、`child_process` から呼ぶときに `shell: true` は不要
- **`npm run dev` を止めても `next dev` の子プロセスが生き残る。** ポートを掴んだままになるので `taskkill /PID <pid> /T /F` でプロセスツリーごと落とす。なおダッシュボードのKillは `claude stop` に任せているのでこの問題を回避できている
- **ポーリング間隔**: セッション一覧が4秒、会話が5秒。会話は表示中のレーンだけ取得している。会話はファイル読み取りなのでCLI起動を伴わない
- git worktreeを使う場合、`node_modules` は共有されないので別途インストールが必要。またTurbopackはジャンクション越しの `node_modules` を受け付けない

## 次にやること

1. 窓口CLIの `#` プレフィックス指示の受け口。`UserPromptSubmit` フックで `#` 始まりの入力だけを横取りしてAPIにPOSTし、そのプロンプトはブロックする（窓口のコンテキストを消費させない）
2. 受け取った指示の配送。`claude --bg --resume <sessionId>` を使う。宛先が `working` の間は送らずキューに積む（セッションの複製を防ぐため必須）。同時アクティブ数の制御もここに乗せる
3. 現在の宛先の可視化。`statusLine` に `→ #B 認証機能` を出し、ダッシュボードでも該当レーンを強調する（誤爆を防ぐため、1と同時に入れる）
4. ログの永続化（`.logs/`）と通知（完了・確認待ち時の音・ブラウザ通知）

## 開発コマンド

```bash
npm run dev     # http://localhost:3000
npm run build   # 型チェックを含む
```
