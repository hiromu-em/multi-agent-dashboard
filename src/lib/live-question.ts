import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// 会話は基本的にJSONLから読む方針（src/lib/transcript.ts）。`claude logs` は
// ANSI付きの端末描画そのもので、進捗表示の上書きでログが膨らむ上、発言とツール
// 実行を区別できないため採用しないと決めている（AGENTS.md参照）。
//
// ただし `AskUserQuestion`（対話的な選択肢提示ツール）が保留中の間、その
// ツール呼び出し自体がJSONLに書き込まれるまでにはっきりした遅延がある
// （実測で30秒待っても現れず、後になって初めて記録された）。対話待ち
// （`state: "blocked"`）のレーンに限っては、その遅延の間「今何を聞かれているか」が
// JSONLのどこにも無いので、ここでだけ例外的に `claude logs` を読み、対話ピッカーの
// 最後の描画（画面末尾）から質問文と選択肢を抜き出す。汎用のANSI端末エミュレータは
// 作らない——この決まった形のウィジェット1つだけを狙い撃ちで解釈する。
// 解釈できなければ諦めて `null` を返し、盤面には何も足さない。

const ANSI_PATTERN = /\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|\x1b./g;
const FOOTER_PATTERN = /Enter to select|to navigate/;
const HEADER_PATTERN = /^[☐☑]\s+.+$/;
const OPTION_PATTERN = /^(?:❯\s*)?(\d+)\.\s+(.+)$/;
const DIVIDER_PATTERN = /^─+$/;
// ウィジェットが常に足す定型の選択肢。実際の選択肢ではないので除外する。
const SKIP_LABELS = /^(Type something\.?|Chat about this)$/;

// 短時間の重複呼び出しをまとめるだけの薄いキャッシュ。`claude.exe` の起動は
// 軽くないので、同じレーンへの立て続けのポーリングで毎回起動しない。
const CACHE_TTL_MS = 2000;
const cache = new Map<string, { at: number; value: string | null }>();

/** ANSI除去後のテキストから、末尾に描画されているAskUserQuestionのピッカーを拾う。 */
function parsePicker(strippedLog: string): string | null {
  const lines = strippedLog.split("\n");

  // 最後に描画されたフレームを狙うので、フッター（操作説明）は末尾から探す。
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_PATTERN.test(lines[i])) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx === -1) return null;

  // そこから遡ってウィジェットの見出し（チェックボックス行）を探す。
  let headerIdx = -1;
  for (let i = footerIdx; i >= 0 && footerIdx - i <= 60; i--) {
    if (HEADER_PATTERN.test(lines[i].trim())) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;

  let i = headerIdx + 1;
  while (i < footerIdx && lines[i].trim() === "") i++;
  const question = lines[i]?.trim();
  if (!question) return null;
  i++;

  const options: string[] = [];
  for (; i < footerIdx; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (DIVIDER_PATTERN.test(trimmed)) break; // ここから下は「Chat about this」などの定型部分。

    const match = trimmed.match(OPTION_PATTERN);
    if (!match) continue;
    const label = match[2];
    if (SKIP_LABELS.test(label)) continue;

    const next = lines[i + 1]?.trim() ?? "";
    const hasDescription = next && !OPTION_PATTERN.test(next) && !DIVIDER_PATTERN.test(next);
    const n = options.length + 1;
    options.push(hasDescription ? `${n}. ${label}\n   ${next}` : `${n}. ${label}`);
  }

  if (options.length === 0) return null;
  return [question, ...options].join("\n");
}

/**
 * 対話待ち（`state: "blocked"`）のレーンに限って、今まさに聞かれている質問を
 * `claude logs <id>` から抜き出す。それ以外のステータスのレーンには使わない。
 */
export async function readLiveQuestion(id: string): Promise<string | null> {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value: string | null = null;
  try {
    const { stdout } = await run(CLAUDE_BIN, ["logs", id], { maxBuffer: 4 * 1024 * 1024 });
    value = parsePicker(stdout.replace(ANSI_PATTERN, ""));
  } catch {
    value = null;
  }

  cache.set(id, { at: Date.now(), value });
  return value;
}
