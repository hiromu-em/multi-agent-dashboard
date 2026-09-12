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
- 窓口CLIの `#` 指示をフックで横取りしてセッションへ配送する（対話待ちレーンへの返信もこれで行う）
- 配送の記録を `.logs/dispatch.jsonl` に残し、届かなかった指示を画面に出す
- 未実装: 通知（完了・確認待ち時の音・ブラウザ通知）

会話ログ自体の永続化は不要。Claude Code が `~/.claude/projects/**/<sessionId>.jsonl` に書き出しており、`claude rm` しても残る。長期保存したいなら `cleanupPeriodDays` を設定する（コードの作業ではない）。

## 主要ファイル

| パス | 役割 |
|---|---|
| `src/app/page.tsx` | ダッシュボード本体。ポーリング、レーン数切替、フォーカス表示、Kill確認 |
| `src/components/LaneCard.tsx` | 1レーン分のボード。会話表示（最新追従つき）、Diffパネル、各種ボタン |
| `src/lib/agents-cli.ts` | `claude` CLIのラッパー。状態マッピング |
| `src/lib/agent-diff.ts` | 作業ディレクトリの変更収集（未コミット・新規・コミット済み） |
| `src/lib/dispatch.ts` | 窓口CLIからの指示の振り分け・宛先の保持・順番待ち |
| `src/lib/dispatch-log.ts` | 配送の記録（`.logs/dispatch.jsonl`）と取りこぼしの抽出 |
| `src/app/api/dispatch/route.ts` | 指示の受け口（POST）と現在の宛先（GET） |
| `src/app/api/dispatch/pending/route.ts` | 存在しない宛先の「作りますか？」への返事（POST）。`confirmCreate` / `rejectCreate` |
| `scripts/route-prompt.mjs` | 窓口CLIの `UserPromptSubmit` フック |
| `scripts/target.mjs` | 現在の宛先を確認する（`npm run t`）。`.logs/target.json` を直接読む |
| `src/lib/transcript.ts` | セッションの会話JSONLを読んで表示用に整形する |
| `src/lib/lane-registry.ts` | セッションの台帳。タグの割り当てと終了時刻の記録（`.logs/sessions.json`） |
| `src/lib/dashboard-data.ts` | ステータスの配色・ラベル定義 |
| `src/app/api/agents/route.ts` | セッション一覧（GET） |
| `src/app/api/agents/[id]/logs/route.ts` | 会話取得（GET）。`?session=<uuid>` を取る |
| `src/app/api/agents/[id]/diff/route.ts` | 作業ディレクトリの変更（GET） |
| `src/app/api/agents/[id]/stop/route.ts` | セッション停止（POST） |
| `src/app/api/agents/[id]/reply/route.ts` | レーンへの返信（POST）。`src/lib/dispatch.ts` の `replyFromBoard` |
| `src/app/api/agents/[id]/dismiss/route.ts` | 終わったレーンを盤面から片付ける（POST）。`src/lib/lane-registry.ts` の `dismissSession` |
| `src/lib/reply-options.ts` | 質問文から選択肢らしい行を抜き出す（返信欄のボタン用） |
| `src/lib/live-question.ts` | 対話待ちのレーンに限り `claude logs` から保留中の`AskUserQuestion`を読む |

## 設計上の決定（変更する前に必ず読むこと）

- **ダッシュボードに指示入力欄は置かない。** 指示はすべて窓口のCLIから出す。中段にあった入力欄と送信ボタンは意図的に削除済みなので、復活させないこと

  **唯一の例外はレーンへの返信。** 各レーン（`LaneCard.tsx` の `ReplyBox`）に返信欄を出す。宛先は既にそのレーンに固定されているのでタグ指定が要らず、`#B` のように別の宛先へ新しい指示を送る用途とは別物。エージェントの直近の発言に列挙（`1.` `A)` `・` など）があれば `src/lib/reply-options.ts` の `extractOptions` がボタン化し、それ以外は自由入力欄だけになる。送信は `POST /api/agents/[id]/reply` → `src/lib/dispatch.ts` の `replyFromBoard`。窓口CLI経由の返信（`#タグ 本文`）も従来通り使える

  **返信欄は「対話待ち」ではなく「実行中以外のすべて」に出す。** 当初は `state: "blocked"`（＝レーンの「対話待ち」）のときだけ出していたが、**`blocked` はほとんど観測できない**。バックグラウンドセッションが質問文を返してターンを終えると、CLIは数秒で `state: "done"` / `status: "idle"` を返す。結果、返信欄は出ても1〜2回のポーリング（4秒間隔）で消え、押せてもAPI側の同じ条件で「対話待ちのレーンにのみ返信できます」と弾かれる——**質問に答えるための欄が、質問に答えられる状態のときだけ消える**という壊れ方をしていた。したがって条件は `lane.status !== "running"` にする。実行中を外すのは、送信が `claude stop` → `--resume` なので割り込むと作業が中断されるため（`replyFromBoard` 側では弾かず、`deliver` が順番待ちに積む）。ただし**色は分ける**：`waiting` のときだけ琥珀色で「返事を待っています」と出し、それ以外は灰色の「返信する」にする。全部同じ色にすると、本当に返事を待っているレーンが盤面に埋もれる
- **窓口セッション自身はボードにしない。** ボードになるのは、バックグラウンドで起動されたサブエージェントセッションだけ

  **窓口を `claude --bg` セッションとして使う場合は、`.logs/gateway.json` に自分のsessionIdを登録すること。** `claude agents --json --all` は「窓口かサブエージェントか」を区別しない。バックグラウンドで起動したセッションはすべて同じ形で並ぶので、コード側からは構造的に見分けが付かない。登録を忘れると2つとも起きる：ボードに窓口自身のレーンが並ぶ（本来ボードに並ばない前提が崩れる）、かつ配送ループ防止（「レーンに居る＝窓口ではない」の判定、`src/lib/dispatch.ts` の `routePrompt`）に引っかかって**窓口からの `#` 指示が一切配送されず、黙って窓口のClaudeへの普通の発言として流れる**。`.logs/gateway.json` は `{ "sessionIds": ["…"] }`（`src/lib/gateway.ts`）。窓口を切り替えたら古いIDを消し、新しいIDを足す

  **起動と登録は `scripts/new-gateway.mjs` にまとめてある。** `node scripts/new-gateway.mjs <表示名> ["初期プロンプト"]` で、`claude --bg` の起動・sessionIdの解決・`.logs/gateway.json` への登録までを1コマンドで行う。フックの発火には依存しない（`claude --bg` の標準出力を読むだけのローカル処理なので、フックが効くかどうかとは無関係に確実に動く）。worktree名は `-w` の制約でASCIIのみになるため、表示名が日本語でも `gateway` 固定＋重複時は連番（`gateway-2` …）にしている。実行後は `claude attach <id>` を案内するだけで、そこから先（attachして `#` を打つ）は変わらず手動
- **ボードの並びは「完了」→「対話待ち」→「実行中」→「エラー・停止済み」の優先度で決まる**（`src/lib/agents-cli.ts` の `fetchAgents`、`STATUS_PRIORITY`）。開始時刻はどこにも使わない（tiebreakとしてのみ残す）。安定ソートを3回チェーンしていて、最後に適用したものが最優先になる：①開始時刻昇順（tiebreak）→②終了時刻（`endedAt`、`lane-registry.ts` が記録）の昇順（同じ優先度グループ内では先に終わったものほど左。新しく終わったレーンはグループの右端に追加されるだけで、既存の完了レーンを追い越して割り込むことは無い。実行中・対話待ちは`endedAt`が無い）→③状態グループの優先度。**「完了」と「エラー・停止済み」はグループとして分かれている**（完了は最優先、エラー・停止済みは最後）ので、失敗したレーンが完了と紛れて左側に来ることは無い。同じグループ内の順序は、一度決まったら別のレーンが新しく完了しても動かない（右端に追加されるだけ）。
- **タグ `#A` `#B` … は並び順ではなくsessionIdに紐づく**（`src/lib/lane-registry.ts`、`.logs/sessions.json` に永続化）。指示の宛先として使うので、一度割り当てたら動かしてはいけない。配列の添字から作ると、古いセッションが1つ消えるだけで後続が繰り上がり `#C` 宛ての指示が別のセッションへ届く。**そのため表示は `#A #C #D` のように飛ぶことがある。これは仕様。**

  **タグは使い回す。** 生きているセッションが持っていないタグはすべて再利用の候補。ただし配る順序で間隔を稼ぐ：未使用のタグを先に配り、無ければ「最後に見かけたのが最も古いタグ」を選ぶ。こうすると直前に終わったタグがすぐ次のセッションへ渡らない。`#27` のような数字タグは、A〜Zの26個すべてが**同時に生きている**ときだけ出る（時間経過では出ない）
- **ボードのサイズは全レーン共通の固定値**（通常720px幅、フォーカス時980px幅）。高さは画面の残り領域いっぱいに自動で伸びる。縦スクロールは出さない
- **ログは常に最新（最下部）を表示する。** 新着で自動追従し、ユーザーが上にスクロールしている間は追従を止めて「最新へ」ボタンを出す
- **Killは本物のセッションを止める。** 実際のユーザーのセッションが並ぶので、確認ダイアログを外さないこと
- **複数行の一括指示に対応している**（`src/lib/dispatch.ts` の `parsePrompt`）。`#` で始まる行を新しい指示の開始とみなし、次の `#` 行または入力末尾までをその宛先への本文として扱い、並列でディスパッチする

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

**終わったレーンは時間では消さない。** 以前は終了から3時間で盤面から落としていた（`RETENTION_MS`）が、廃止した。「対話待ち（`blocked`）は打ち切りの対象外」という例外を付けてあったものの、**`blocked` はほとんど観測できない**（質問文を返してターンを終えたセッションを、CLIは数秒で `done` にする）ので実際には効いておらず、**返事を待っているレーンが3時間で黙って消えていた**。消えると質問も、タグの割り当ても失われる。時間で消す限り、放置した質問ほど静かに消えるという向きは変えられない。

代わりに**手で片付ける**（各レーンの「×」ボタン → `POST /api/agents/[id]/dismiss` → `src/lib/lane-registry.ts` の `dismissSession`）。片付けるのは表示だけで、セッションは止めない（Killとは別物）。台帳に `dismissedAt` を残し、そのセッションが再開したら記録を取り消して盤面に戻す。片付けボタンは終わったレーン（完了・エラー・停止済み）にだけ出す——実行中や対話待ちを消せると、監視の意味が無くなる。

終了時刻（`endedAt`）の記録自体は残す。並び順に使うため。CLIは終了時刻を返さないので、終端状態を最初に観測した時刻を起点にしている。

### Diffは `git diff` だけでは足りない

引数なしの `git diff` は「作業ツリーとステージの差」しか出さない。エージェントは新しいファイルを作り、区切りで `git add` するので、それだけを見ていると**真面目に作業しているほど差分が消える**。実際には大量に変更されているのに「変更なし」と表示されてしまう。

`src/lib/agent-diff.ts` が3つを合わせて出す。

| 対象 | 取り方 |
|---|---|
| 追跡済みファイルの未コミット変更（ステージ済みを含む） | `git diff HEAD` |
| 新規ファイル | `git ls-files --others --exclude-standard` で列挙し、1件ずつ `git diff --no-index -- /dev/null <file>` |
| エージェントがコミットした分 | `git diff <base>...HEAD`（base は `main` → `master` の順に探す） |

注意点:

- **`git add` してはいけない。** 新規ファイルを差分にするために `--intent-to-add` を使うとエージェントのインデックスを書き換えてしまう。`--no-index` は読み取りだけで済む
- `git diff --no-index` は**差分があると終了コード1を返す**。`execFile` はこれを例外にするので、code 1 のときは stdout を使う
- コミットが1つも無いリポジトリでは `git diff HEAD` が失敗する。`git diff --cached` にフォールバックし、それも失敗するならgit管理下ではないとみなす
- 分岐元が分からないときはコミット済み差分を出さない。推測で誤ったものを見せるより出さない
- 新規ファイルは20件、差分全体は40万文字が上限。巨大な生成物でパネルと通信を潰さないため

### ログは会話JSONLから読む（`claude logs` は使わない）

Claude Code はセッションごとの会話を JSONL で書き出している。

```
~/.claude/projects/<cwdを符号化したディレクトリ>/<sessionId>.jsonl
```

`src/lib/transcript.ts` がこれを追尾する。`claude logs` の出力はANSI付きの端末描画そのもので、進捗表示の上書き（`\r`）が縦に展開されてログが数百行に膨らむ上、発言とツール実行を区別できない。JSONLなら構造化された会話がそのまま取れて、CLIの起動も要らない。

- ディレクトリ名の符号化規則は公開されていないので、**パスを組み立てず `<sessionId>.jsonl` を各ディレクトリから探す**。sessionId が無い場合は短いID（sessionIdの先頭8桁）の前方一致で探す
- 会話が長くなるので末尾512KBだけ読む。途中から読むと1行目が欠けるので捨てる（マルチバイト文字の切断もここで落ちる）
- 出すのは「窓口の指示」「エージェントの発言」「ツール実行」「失敗したツール結果」の4種類。思考（`thinking`）と成功したツール結果は出さない。`isSidechain` はサブエージェント内部のやり取りなので除外する

**`AskUserQuestion`（対話的な選択肢提示ツール）だけは例外的に「エージェントの発言」として組み立て直す**（`formatAskUserQuestion`）。他のツールと同じ扱い（`role: "tool"`、`toolDetail` が拾う `description`/`command`/… のどれとも形が合わない）のままだと、「▸ AskUserQuestion」とだけ出て質問文も選択肢も画面から一切見えなかった。組み立て直した文章は選択肢を行頭 `1.` の通し番号にするので、盤面の返信欄の選択肢抽出（`src/lib/reply-options.ts` の `extractOptions`）にもそのまま乗る。説明文（`description`）は次行にインデントで置き、番号記号が無いので抽出には拾われない——ボタンを押したときに送る文面が説明まで含んで長くなるのを防ぐため。

**`AskUserQuestion`で止まっているレーンに返信欄から答えても、1回目はそのまま届かない。** 保留中のツール呼び出しに対して `claude --bg --resume` で素のテキストを送ると、CLIは「ユーザーがこの質問を拒否して、聞き直してほしいと言っている」という定型の却下として扱い、エージェントは選んだはずの答えを無視して聞き直す。2回目に送った同じ答えは（このときには保留中のツール呼び出しが無くなっているので）普通の返信として通る。実際に検証して確認した挙動で、CLI側の仕様なのでダッシュボード側では直せない。

**`AskUserQuestion`が保留中の間、その質問自体はJSONLにまだ書き込まれない。** 実際に検証すると、対話ピッカーが `claude logs` の画面には表示されているのに、対応するJSONLの行は30秒待っても増えなかった。回答されて初めて（却下されてでも）記録される。つまり `formatAskUserQuestion` による表示は、**すでに解決した質問を後から見る**ことはできても、**今まさに保留中の質問の中身をJSONLだけで見る**ことはできない——これは今の設計（会話はJSONLから読む）の構造的な死角。

これに対応するため、対話待ち（`state: "blocked"`）のレーンに限って例外的に `claude logs <id>` を読む（`src/lib/live-question.ts` の `readLiveQuestion`、`src/app/api/agents/[id]/logs/route.ts` から呼ぶ）。汎用のANSI端末エミュレータは作らず、AskUserQuestionの対話ピッカー1つだけを画面末尾から狙い撃ちで解釈する（見出しのチェックボックス行 `☐`/`☑` からフッター `Enter to select / to navigate` までの間を、行頭 `❯ N.` の選択肢として拾う。「Type something.」「Chat about this」はウィジェットが常に足す定型なので除外）。解釈できなければ諦めて何も足さない。これは「`claude logs` は使わない」という上の決定への例外で、対象は保留中のAskUserQuestionの中身を拾うことだけに絞ってある——JSONLの代わりに全面的に使うわけではない。

**方式B（バックエンドが `claude -p --output-format stream-json` を spawn する案）は採用しない。** あれはバックエンドがセッションの所有者になる設計で、`claude --bg` で起動したセッションを外から監視する今の形と噛み合わない。構造化ログという目的はJSONL追尾で達成済み。

**SSE配信のエンドポイントも置かない。** `src/app/api/agents/[id]/stream/route.ts` にスタブを置いていたが、どこからも呼ばれないまま残っていたので消した。配信すべき stdout を持っているのはバックエンドではなくCLIなので、このスタブを埋める作業は方式Bを作ることと同じになる。会話はJSONLのポーリング（5秒）で足りている。

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

**この方式は誤爆する。** 宛先が残っているのを忘れて窓口に話しかけると、その文がエージェントへ飛ぶ。Enterを押した時点で配送されるので取り消せない。

**かつては `statusLine` 設定（`scripts/statusline.mjs`）で窓口CLIの下部に宛先を常時表示していたが、運用者の判断で廃止した。** `statusLine` を設定すると標準の表示が丸ごと置き換わるため、既存のユーザー設定のコマンドを実行して出力の末尾に宛先を継ぎ足すという入り組んだ作りが必要になり、その割に得られるのは警告表示1つだった。スクリプトと3か所の `statusLine` 設定（`~/.claude`・`claude_project/.claude`・このリポジトリの `.claude`）、および元の表示を作っていた `~/.claude/statusline-command.sh` は削除済みで、標準のステータスラインに戻してある。**復活させる場合は、標準表示の置き換えになる点を承知のうえで判断すること。**

- **ダッシュボードのほか、`npm run t` でも確認できる。** `scripts/target.mjs` が `.logs/target.json` を直接読んで表示するだけの道具で、`git branch` のように「聞いたときだけ答える」。自動表示ではないので、statusLineのときのような「既存の表示を丸ごと置き換える」問題は起きない。ダッシュボードのサーバーが起きていなくても使えるよう、APIには頼らずファイルを直接読む。生きているセッションかどうかは `claude agents --json --all` で確認するが、消えていたら自動で解除するところまではしない（見るだけの道具で、実際の解除判断はダッシュボード側の役目）

宛先のセッションが終了・消滅したら自動で解除して窓口に戻す。消えたセッション宛てに打ち続けるのを防ぐため。

### 窓口CLIから指示を飛ばす仕組み

```
窓口CLIの入力
  ↓ UserPromptSubmit フック（scripts/route-prompt.mjs）
POST /api/dispatch     ← 判断はすべてサーバー側。フックは薄い管
  ↓ src/lib/dispatch.ts
claude stop <id> → claude --bg --resume <sessionId> "本文"
```

**送信は `stop` してから `--resume` する。** プロセスが生きているセッションにいきなり `--resume` すると、継続ではなく**コピーが生える**（CLIが "started a copy" と言う）。`state` が `done` でもプロセスは生きているので、ほぼ常に `stop` が要る。`stop` しても会話は保たれ、同じIDで "woke session" として再開する。

したがって**作業中（`working`）のセッションには送ってはいけない**。止めると作業が中断される。順番待ちに積んで、空いてから送る。

その他の要点:

- **送信の完了を待たない。** `claude.exe` の起動に数秒かかるため、待つと窓口の入力が固まる（実測でフックが5秒でタイムアウトした）。APIは受理だけして即返し、送信は裏で走らせる。失敗は `/api/dispatch` の GET から画面に出す
- **順番待ちの消化は `/api/agents` の GET に相乗り**させている。専用のタイマーを持たない
- **同じ相手へ二重に送らない。** 送信中のsessionIdを持っておき、`stop` → `--resume` が重ならないようにする
- **呼び出し元がレーンなら横取りしない。** 配送先のエージェントが同じフックを持っていると、送った指示をそのエージェントがまた振り分けて回り続ける。`session_id` を見て、レーンに居るなら素通しする
- **同時に走らせる上限は5**（`MAX_ACTIVE`）。超える分は順番待ちになる
- **`state` は遅れる。** 一覧はキャッシュされている上、CLIが返す `state` 自体も実態から遅れる。実際に、作業中のセッションへ送れてしまい `stop` が走った。`stop` の直前にキャッシュを捨てて状態を取り直し、`running` なら送信を取りやめる

### 存在しない宛先を指したとき

**1回目は作らない。本文を預かって確認を求める**（`src/lib/dispatch.ts` の `handleUnknownTag`）。

```
窓口:  #K 調べておいて  → 「#K という宛先はありません。… 盤面の「実行」を押すか、
                          もう一度 #K と打つと、この指示のまま新しいセッションを作ります」
盤面:  #K という宛先はありません。作りますか？  調べておいて   [実行] [拒否]
```

即座に自動生成しないのは、`#B` のつもりで `#K` と打ち間違えただけでセッションが生えるのを避けるため。逆に、ただエラーにして終わりだと「じゃあどうやって新しいレーンを作るのか」が窓口から見えない。確認を1回挟む形にして両方を避けている。

**確認の道は2つあり、どちらも同じ保留を消化する**（`confirmCreate` / `rejectCreate`）。盤面の「実行」「拒否」ボタン（`POST /api/dispatch/pending`）と、窓口で `#K` とタグだけ打つこと。**本文は1回目の時点で預かっているので、打ち直す必要は無い**——確認のたびに指示文を再入力させるのは、窓口の打鍵としては重すぎる。`#` 単独（宛先の解除）は確認待ちも一緒に捨てる。

本文の無い `#K` は普段なら「宛先だけで本文がありません」だが、確認待ちがあるときだけ「実行」の合図として解釈する（`bareTagOf`）。

待ち合わせの状態はプロセス内（`pendingCreate`、5分で失効）に持つ。順番待ちと同じくサーバー再起動で消えてよい類の一時的な状態。**確認バーはヘッダーの外に出す**。ヘッダーは畳めるので、中に置くと畳んだときに気づけない——返事待ち＝窓口の指示が宙に浮いている状態なので、隠れて困る種類の表示。

**タグは作る前に台帳へ予約する**（`src/lib/lane-registry.ts` の `reserveTag`）。`registerSessions` は「台帳に記録のあるセッションはそのタグを維持し、記録の無いセッションにだけ `nextFreeTag` で空きを配る」順序で動くので、一覧に現れる前に記録を作っておかないと、`#K` へ送って作ったセッションが `#C` として盤面に出る。作成後に `claude agents --json` から sessionId を引き直してから予約する（`claude --bg` は短いIDしか返さない）。

**片付け済みのセッションが持っているタグは作らない**（`isTagTaken` は盤面ではなく台帳を見る）。片付けたレーンは盤面から消えてもタグは持ったままで、再開すれば戻ってくる。ここで同じタグの新しいセッションを作ると、そのとき同じタグが2つになる。

**同時実行の上限（`MAX_ACTIVE`）は作成時にも見る。** 作ったセッションはその場で動き出すので、上限に達しているときに作れてしまうと上限の意味が無くなる。

作成は `.logs/dispatch.jsonl` に `created` として残る。

### 配送の記録（`.logs/dispatch.jsonl`）

送信は非同期なので、結果は窓口に返らない。さらに**指示が黙って消える経路が2つある**ため、何をどこへ送ったかを1行1件で残している。

| event | 意味 |
|---|---|
| `sent` | 送信を受理した（実際の送信は裏で走る） |
| `queued` | 宛先が作業中なので順番待ちにした |
| `delivered` | 送信が完了した |
| `failed` | 送信に失敗した |
| `dropped` | 順番待ちのまま宛先が消えたので捨てた |
| `cleared` | 宛先を解除した |

`failed` と `dropped` が「届かなかった指示」で、直近1時間ぶんをダッシュボードのヘッダーに赤く出す。これが無いと、順番待ちの宛先が盤面から消えたときに指示が痕跡なく消える（窓口には「順番待ちにしました」と伝えた後で）。

会話JSONLには「そのセッションが何を受け取ったか」しか残らない。タグ・順番待ち・送信失敗は盤面側の事実なので、ここにしか残らない。

### フックの設定

**設定の効く範囲は「gitリポジトリのルート」で決まる。OS上の親フォルダは無関係。**

Claude Code公式ドキュメント（settings）に明記されている：「サブディレクトリで起動した場合はリポジトリのルートにあるファイルを読み書きする。worktreeの場合はメインチェックアウトのルートにあるファイルを使う」。**親ディレクトリを遡って探すという仕組みは無い。** これを「親のものも読まれる」と誤解し、リポジトリ内の設定ファイルを消してしまったことがある（`932630b`）。結果、窓口を含むほとんどのセッション（cwdがこのリポジトリの中）でフックが一切効かなくなり、`#` を打っても静かに素通りする状態が続いた。気づいたのは、実際に窓口セッションから配送を試して `.logs/dispatch.jsonl` に何も残らないことを確認したとき。

cwdごとに参照する設定ファイルは1つに決まる。**両方に同じ内容を置く。**

```
claude_project/.claude/settings.json                ← cwdが claude_project 直下のセッション用
                                                        （claude_project 自体はgitリポジトリではないので、
                                                         親を遡らずこのファイルがそのまま使われる）
claude_project/multi-agent-dashboard/.claude/settings.json
                                                      ← cwdがこのリポジトリの中（worktreeを含む）の
                                                         セッション用。worktreeも「メインチェックアウトの
                                                         ルート」＝ここを見る
```

**パスは必ず絶対パスで書く。** 相対パスはセッションの作業ディレクトリを基準に解決される。実際に `args: ["multi-agent-dashboard/scripts/route-prompt.mjs"]` と書いていたため、リポジトリの中で動くセッションでは `multi-agent-dashboard/multi-agent-dashboard/...` を探して毎プロンプト `MODULE_NOT_FOUND` で落ちたことがある。フックの失敗は入力のたびに画面へ出るので、これは黙って壊れるより悪い。

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node",
        "args": ["C:/.../multi-agent-dashboard/scripts/route-prompt.mjs"] } ] }
    ]
  }
}
```

止めたいときは両方のファイルの `hooks` を消す（ファイルごと消してもよい）。ダッシュボードが起動していないときは、宛先を明示した `#B ...` だけがエラーで止まり、素の入力は素通しする（窓口のCLIが使えなくなる事態を避けるため）。

**設定は各セッションの起動時に読み込まれる。** ファイルを直しても、既に動いているセッションには反映されない。`claude stop <id>` → `claude --bg --resume <sessionId> "..."` で再起動すると、会話を保ったまま新しい設定を読み直す。

### 対話待ちの扱いについての注意

バックグラウンドセッションには、対話型TUIのような y/n プロンプトはそのままの形では現れない。権限確認は `--permission-mode` や `--allowedTools` で事前に決める。したがって「対話待ち」（`state: "blocked"`）は「エージェントがターンを終えて質問文を返した状態」であり、返信は割り込みではなく**追加プロンプトの送信**になる。送信手段は上の `claude --bg --resume` と同じで、返信専用の仕組みは要らない。

## この環境（Windows）特有の注意点

- **jqが入っていない。** シェルスクリプトはjq非依存で書くこと。黙って空を返して壊れる
- **`claude` は `claude.exe`** なので、`child_process` から呼ぶときに `shell: true` は不要
- **`npm run dev` を止めても `next dev` の子プロセスが生き残る。** ポートを掴んだままになるので `taskkill /PID <pid> /T /F` でプロセスツリーごと落とす。なおダッシュボードのKillは `claude stop` に任せているのでこの問題を回避できている
- **ポーリング間隔**: セッション一覧が4秒、会話が5秒。会話は表示中のレーンだけ取得している。会話はファイル読み取りなのでCLI起動を伴わない
- git worktreeを使う場合、`node_modules` は共有されないので別途インストールが必要。またTurbopackはジャンクション越しの `node_modules` を受け付けない

## 次にやること

1. 通知（完了・確認待ち時の音・ブラウザ通知）
2. 順番待ちはサーバーのメモリに置いているので再起動で消える。永続化するかは未決

## 開発コマンド

```bash
npm run dev     # http://localhost:3000
npm run build   # 型チェックを含む
```
