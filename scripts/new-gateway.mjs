#!/usr/bin/env node
// 窓口セッションを1コマンドで作る。
//
// やっていることは3つだけ（AGENTS.mdの「窓口を claude --bg セッションとして使う場合」参照）。
//   1. claude --bg でバックグラウンドセッションを起動する
//   2. 返ってきた短いIDから、本物のsessionIdを引く
//   3. .logs/gateway.json に登録する（ダッシュボードのボードから隠す）
//
// フックの発火には依存しない。ここでの登録はCLIの標準出力を読むだけの
// ローカルな処理なので、フックが効くかどうかとは無関係に確実に動く。
//
// 使い方:
//   node scripts/new-gateway.mjs <表示名> ["初期プロンプト"]
//
// 実行後、「claude attach <id>」で開ける。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATEWAY_FILE = join(PROJECT_DIR, ".logs", "gateway.json");
const WORKTREES_DIR = join(PROJECT_DIR, ".claude", "worktrees");

const DEFAULT_PROMPT =
  "あなたは運用者の窓口セッションです。運用者はここに #B のようなタグ付きの指示を打ち込み、" +
  "ダッシュボード（multi-agent-dashboard）経由で他のバックグラウンドセッションへ配送します。" +
  "あなた自身が何か作業する必要はありません。準備ができたことだけ知らせてください。";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** worktree名は `-w` に渡すのでASCIIのみ。表示名が日本語でも "gateway" 固定にし、重複したら連番にする。 */
async function pickWorktreeName() {
  let existing = new Set();
  try {
    existing = new Set(await readdir(WORKTREES_DIR));
  } catch {
    // まだ worktree が1つも無い。
  }
  if (!existing.has("gateway")) return "gateway";
  for (let i = 2; ; i++) {
    const name = `gateway-${i}`;
    if (!existing.has(name)) return name;
  }
}

async function readGatewayIds() {
  try {
    const parsed = JSON.parse(await readFile(GATEWAY_FILE, "utf8"));
    const list = parsed?.sessionIds;
    return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function addGatewayId(sessionId) {
  const ids = new Set(await readGatewayIds());
  ids.add(sessionId);
  await mkdir(dirname(GATEWAY_FILE), { recursive: true });
  await writeFile(GATEWAY_FILE, `${JSON.stringify({ sessionIds: [...ids] }, null, 2)}\n`, "utf8");
}

async function main() {
  const [displayName, initialPrompt] = process.argv.slice(2);
  if (!displayName) {
    fail('表示名を指定してください（例: node scripts/new-gateway.mjs 窓口2）');
  }

  const worktreeName = await pickWorktreeName();
  const prompt = initialPrompt?.trim() || DEFAULT_PROMPT;

  console.log(`起動中… (-w ${worktreeName} -n "${displayName}")`);
  const { stdout } = await run(
    CLAUDE_BIN,
    ["--bg", "-w", worktreeName, "-n", displayName, prompt],
    { maxBuffer: 1024 * 1024 },
  ).catch((error) => fail(`起動に失敗しました: ${error.message}`));

  const idMatch = stdout.match(/([0-9a-f]{8})/i);
  if (!idMatch) fail(`起動はしましたが、IDが読み取れませんでした:\n${stdout}`);
  const shortId = idMatch[1];

  const { stdout: agentsJson } = await run(CLAUDE_BIN, ["agents", "--json", "--all"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const agent = JSON.parse(agentsJson).find((a) => a.id === shortId);
  if (!agent) fail(`起動した ${shortId} が一覧に見つかりませんでした。`);

  await addGatewayId(agent.sessionId);

  console.log(`✓ 窓口セッションを作成し、ボードから除外登録しました。`);
  console.log("");
  console.log(`  claude attach ${shortId}`);
  console.log("");
  console.log("で開いてください。");
}

main().catch((error) => fail(error.message));
