#!/usr/bin/env node
// 窓口CLIのステータスラインに、今の宛先を出す。
//
// `#` を省いた入力はここに表示されている相手へ飛ぶ。宛先が残っているのを忘れて
// 窓口に話しかけると、その一言がエージェントへ送られてしまい、Enterを押した時点で
// 取り消せない。だから常に見えていることが要る。
//
// ファイルを直接読む。ステータスラインは頻繁に走るのでHTTPは使わない。
//
// 設定例（.claude/settings.json）:
//   "statusLine": { "type": "command", "command": "node", "args": ["scripts/statusline.mjs"] }

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIM = "[2m";
const ORANGE = "[38;5;208m";
const RESET = "[0m";

function readTarget(projectDir) {
  try {
    const raw = readFileSync(join(projectDir, ".logs", "target.json"), "utf8");
    const target = JSON.parse(raw);
    if (typeof target?.tag === "string") return target;
  } catch {
    // 宛先なし。
  }
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // 標準入力が読めなくても、環境変数から場所を決められる。
  }

  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ??
    input?.workspace?.project_dir ??
    input?.cwd ??
    process.cwd();

  const branch = input?.gitBranch ?? input?.workspace?.git_branch ?? "";
  const target = readTarget(projectDir);

  const parts = [];
  if (target) {
    const name = target.name ? ` ${target.name}` : "";
    parts.push(`${ORANGE}→ ${target.tag}${name}${RESET}`);
  } else {
    parts.push(`${DIM}宛先なし${RESET}`);
  }
  if (branch) parts.push(`${DIM}${branch}${RESET}`);

  process.stdout.write(parts.join(`${DIM} | ${RESET}`));
}

main().catch(() => {
  process.stdout.write("");
});
