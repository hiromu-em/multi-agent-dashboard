#!/usr/bin/env node
// 窓口CLIのステータスライン。
//
// `statusLine` を設定すると標準の表示は置き換わってしまうので、
// もともと出ていたもの（モデル・コンテキスト・パス・ブランチ）を出したうえで、
// 最後に現在の宛先を足す。
//
// 宛先が残っているのを忘れて窓口に話しかけると、その一言がエージェントへ飛ぶ。
// Enterを押した時点で取り消せないので、常に見えていることが要る。
//
// 設定例（.claude/settings.json）。`args` は使えないので1つの文字列で書く:
//   "statusLine": { "type": "command", "command": "node scripts/statusline.mjs" }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 宛先ファイルはこのスクリプトから見た位置で決める。
// 窓口セッションがどのディレクトリで動いていても同じ場所を読むため
// （窓口はダッシュボードのリポジトリの外に居ることが多い）。
const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS_DIR = join(PROJECT_DIR, ".logs");

const DIM = "[2m";
const ORANGE = "[38;5;208m";
const RESET = "[0m";

function readTarget() {
  try {
    const target = JSON.parse(readFileSync(join(LOGS_DIR, "target.json"), "utf8"));
    if (typeof target?.tag === "string") return target;
  } catch {
    // 宛先なし。
  }
  return null;
}

/**
 * 受け取った内容を1度だけ書き出す。
 * 渡されるフィールドはCLIの版で変わるので、実物を残しておくと後で直せる。
 */
function keepSample(input) {
  try {
    const path = join(LOGS_DIR, "statusline-sample.json");
    if (existsSync(path)) return;
    mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(input, null, 2), "utf8");
  } catch {
    // 残せなくても表示には関係ない。
  }
}

/** 末尾2階層だけ出す。フルパスは長すぎて他の表示を押し出す。 */
function shortenPath(path) {
  if (typeof path !== "string" || !path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(sep);
}

/** ブランチ名。渡されなければ .git/HEAD を読む（gitの起動より軽い）。 */
function branchName(input, cwd) {
  const given =
    input?.workspace?.branch ??
    input?.workspace?.git_branch ??
    input?.gitBranch ??
    input?.branch;
  if (typeof given === "string" && given) return given;

  try {
    let gitDir = join(cwd, ".git");
    try {
      // worktree では `.git` はディレクトリではなくファイルで、実体の場所が書いてある。
      const marker = readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)$/m);
      if (marker) gitDir = marker[1].trim();
    } catch {
      // 通常のリポジトリなら `.git` はディレクトリなので、そのまま使う。
    }

    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const match = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function contextLabel(input) {
  const context = input?.context_window;
  if (!context) return input?.exceeds_200k_tokens ? "200k超" : "";

  const used = context.used_percentage;
  if (typeof used === "number" && Number.isFinite(used)) return `${Math.round(used)}%`;

  const tokens = context.total_input_tokens;
  if (typeof tokens === "number" && tokens > 0) return `${Math.round(tokens / 1000)}k`;
  return "";
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // 標準入力が読めなくても、宛先だけは出せる。
  }
  keepSample(input);

  const cwd = input?.workspace?.current_dir ?? input?.cwd ?? process.cwd();

  const parts = [];

  const model = input?.model?.display_name ?? input?.model?.id;
  if (model) parts.push(`${DIM}${model}${RESET}`);

  const context = contextLabel(input);
  if (context) parts.push(`${DIM}${context}${RESET}`);

  const path = shortenPath(cwd);
  if (path) parts.push(`${DIM}${path}${RESET}`);

  const branch = branchName(input, cwd);
  if (branch) parts.push(`${DIM}${branch}${RESET}`);

  // 宛先は最後。ここだけ色を付けて、目に留まるようにする。
  const target = readTarget();
  if (target) {
    const name = target.name ? ` ${target.name}` : "";
    parts.push(`${ORANGE}→ ${target.tag}${name}${RESET}`);
  }

  process.stdout.write(parts.join(`${DIM} | ${RESET}`));
}

main().catch(() => {
  process.stdout.write("");
});
