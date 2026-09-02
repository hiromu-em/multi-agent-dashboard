#!/usr/bin/env node
// 窓口CLIの UserPromptSubmit フック。
//
// `#B 本文` のような宛先付きの入力と、宛先が固定されている間の入力を横取りして
// ダッシュボードのAPIへ渡し、そのプロンプトは窓口のClaudeに届かないよう止める。
// 止めないと指示文が窓口のコンテキストを埋め、窓口自身が作業を始めてしまう。
//
// 判断はすべてサーバー側で行う。このスクリプトは中身を解釈しない。
//
// 設定例（.claude/settings.json）:
//   "hooks": { "UserPromptSubmit": [{ "hooks": [
//     { "type": "command", "command": "node", "args": ["scripts/route-prompt.mjs"] }
//   ]}]}

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";
// 送信自体は非同期なのでAPIはすぐ返る。セッション一覧の取得ぶんだけ余裕を見る。
const TIMEOUT_MS = 15000;

// 宛先を明示した入力かどうか。接続できないときの扱いを分けるためだけに使う。
const ADDRESSED = /^#([A-Za-z]|\d{1,3})([ \t]|$)/m;

function block(reason) {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        // 止めた旨の表示に元のプロンプトを混ぜない。
        // 混ざると結局その指示文が窓口の画面とコンテキストに残る。
        suppressOriginalPrompt: true,
      },
    }),
  );
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return; // 読めなければ素通し。
  }

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const source = typeof input.source === "string" ? input.source : "user";

  // 人が打った入力だけを対象にする。システムが注入したものは触らない。
  if (source !== "user" || !prompt.trim()) return;

  let result;
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // session_id を渡す。配送先のエージェント自身が同じフックを持っていても、
      // サーバー側でレーンだと分かれば横取りされない（指示が回り続けるのを防ぐ）。
      body: JSON.stringify({ prompt, source, session_id: input.session_id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    result = await res.json();
  } catch {
    // ダッシュボードに繋がらない。
    //
    // 宛先を明示した入力は止めて知らせる。黙って窓口へ流すと、
    // エージェント宛ての指示を窓口のClaudeが実行してしまう。
    // 素の入力は素通しする。ここで止めると窓口のCLIが使えなくなる。
    if (ADDRESSED.test(prompt.trim())) {
      block(`ダッシュボードに接続できないため送れませんでした（${DASHBOARD_URL}）`);
    }
    return;
  }

  if (result?.block) block(String(result.message ?? "送信しました"));
}

main().catch(() => {
  // フックの失敗で窓口のCLIを止めない。
});
