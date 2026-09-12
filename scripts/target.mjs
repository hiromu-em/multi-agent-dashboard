#!/usr/bin/env node
// 現在の宛先を確認する。 `npm run target` でいつでも呼べる。
//
// かつてのステータスラインは自動表示だったため、既存の表示を丸ごと置き換える割に
// 得られるのは宛先1行だけで廃止した（AGENTS.md参照）。これは `git branch` と同じ
// 「聞いたときだけ答える」道具。ダッシュボードのサーバーが起きていなくても使える
// ように、APIには頼らず `.logs/target.json` を直接読む。
//
// 生死の確認は「あれば見る」程度に留める。`currentTarget()` のように
// 消えていたら自動で解除する判断まではしない。それは実際に配送を担っている
// ダッシュボード側の役目で、ここは見るだけの道具。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_FILE = join(PROJECT_DIR, ".logs", "target.json");

async function readTarget() {
  try {
    const parsed = JSON.parse(await readFile(TARGET_FILE, "utf8"));
    if (typeof parsed?.tag === "string" && typeof parsed?.sessionId === "string") return parsed;
  } catch {
    // まだ無い、または読めない。宛先なしとして扱う。
  }
  return null;
}

async function findLane(sessionId) {
  try {
    const { stdout } = await run(CLAUDE_BIN, ["agents", "--json", "--all"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const lanes = JSON.parse(stdout);
    return lanes.find((lane) => lane.sessionId === sessionId) ?? null;
  } catch {
    // CLIが呼べない。生死は分からないが、宛先自体は表示する。
    return undefined;
  }
}

async function main() {
  const target = await readTarget();
  if (!target) {
    console.log("→ 宛先なし（窓口のClaudeと会話中）");
    return;
  }

  const name = target.name ? ` ${target.name}` : "";
  const lane = await findLane(target.sessionId);

  if (lane === null) {
    console.log(`→ ${target.tag}${name} 宛（セッションが見つかりません。次の入力で自動解除されます）`);
    return;
  }
  if (lane === undefined) {
    console.log(`→ ${target.tag}${name} 宛（claude CLIに接続できず生死は未確認）`);
    return;
  }
  console.log(`→ ${target.tag}${name} 宛 (${lane.state})`);
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
