# 作業ログ

日付ごとに追記する。実装の設計判断は AGENTS.md に、機能の説明は README.md にまとめてあるので、ここには「その日に何があったか」だけを書く。

## 2026-09-05

### 1. ダッシュボード疎通確認

`#F` 宛てに疎通テストを送信。一度文字化けが発生したが、テストコマンド側の不具合と判明し、再送して疎通確認を完了。

### 2. 窓口セッションの運用に関するQ&A（`#A` とのやり取り）

- 窓口セッションの立ち上げ方（バックグラウンド起動 → sessionIdを窓口として登録 → `claude attach` で開く、という流れ）を確認
- 宛先の自動登録の仕組みについて質問・イメージ合わせ
- 自動化スクリプト `node scripts/new-gateway.mjs` を作成し、実際に `窓口2` を作成して動作確認
- `claude attach` 後にagents画面へ戻ると操作できなくなる件を調査し解決
- 役目を終えた `窓口2` の削除を依頼

### 3. 窓口ワークツリー（`worktree-gateway`）での作業

- README.md が AGENTS.md の実装内容（宛先スティッキー方式、`.logs/gateway.json` による窓口除外、`dispatch.ts`/`dispatch-log.ts`/`lane-registry.ts` など）に対して古くなっていたため、記載を実装に合わせて更新
- 更新差分を `worktree-gateway` ブランチでコミット（`3b4c4f0` "Sync README with implemented dispatch/lane-registry design"）
- コミットを main へ反映する方法を確認。リモートは未設定であり、main は別ワークツリー（`#A` が動いているディレクトリ）でチェックアウト中のため、窓口ワークツリー側からは直接マージできないと判明
- そのため `#A` へ `git merge worktree-gateway` の実行を依頼し、`0a9aa2b` として main に反映

### 4. 宛先解除後のステータスライン表示についての調査

- `#` 単独で宛先を解除した直後、ステータスラインに宛先表示が残っているように見える件を調査
- サーバー側（`/api/dispatch` のGET、`.logs/target.json`、`.logs/dispatch.jsonl` の `cleared` イベント）はいずれも正しく解除済みであることを確認
- 原因は恐らく、宛先解除の入力がフックでblockされモデルのターンが発生しないため、ステータスラインの再描画タイミングが少し遅れること（`refreshInterval` 未設定）。設定ファイル（`claude_project/.claude/settings.json`）のパスや内容自体に誤りは無いことも確認済み
