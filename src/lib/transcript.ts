import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code はセッションごとの会話を JSONL で書き出している。
//   ~/.claude/projects/<cwdを符号化したディレクトリ>/<sessionId>.jsonl
// `claude logs` が返すANSI付きの端末描画と違い、こちらは構造化された会話そのもの。
// 端末の上書き（\r）に悩まされず、発言とツール実行を分けて表示できる。
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// 末尾から読む量。長い会話でも直近だけ見れば足りるので全体は読まない。
const TAIL_BYTES = 512 * 1024;

// 1レーンあたりに返す最大件数。
const MAX_ENTRIES = 300;

/** ツール実行の説明として拾う入力キー。前にあるものほど優先する。 */
const DETAIL_KEYS = ["description", "command", "file_path", "pattern", "path", "prompt"];

export type TranscriptRole = "user" | "agent" | "tool" | "error";

/** ダッシュボードに表示する1件分。 */
export interface TranscriptEntry {
  /** Reactのkey用。同じ行から複数件出る場合はブロック番号を足している。 */
  key: string;
  role: TranscriptRole;
  /** HH:MM。timestampが無い行では空になる。 */
  time: string;
  text: string;
  /** role === "tool" のときのツール名。 */
  tool?: string;
}

// sessionId から実ファイルへの解決結果。プロジェクトディレクトリ全走査を毎回やらないため。
const pathCache = new Map<string, string>();

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * セッションの会話ファイルを探す。
 *
 * ディレクトリ名は作業ディレクトリを符号化したもので規則が公開されていないため、
 * パスを組み立てず `<sessionId>.jsonl` を各ディレクトリから探す。
 * sessionId が分からない場合は、短いID（sessionIdの先頭8桁）の前方一致で探す。
 */
async function resolveTranscript(id: string, sessionId?: string): Promise<string | null> {
  const cacheKey = sessionId ?? id;
  const cached = pathCache.get(cacheKey);
  if (cached && (await isFile(cached))) return cached;
  pathCache.delete(cacheKey);

  let dirs: string[];
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // ~/.claude/projects が無い環境。
    return null;
  }

  // 同じセッションが別の作業ディレクトリにも記録されている場合があるので、
  // 見つかったものの中で最後に書かれたファイルを採用する。
  let newest: { path: string; mtimeMs: number } | null = null;

  for (const dir of dirs) {
    const candidates: string[] = [];

    if (sessionId) {
      candidates.push(join(PROJECTS_DIR, dir, `${sessionId}.jsonl`));
    } else {
      try {
        const files = await readdir(join(PROJECTS_DIR, dir));
        for (const file of files) {
          if (file.startsWith(`${id}-`) && file.endsWith(".jsonl")) {
            candidates.push(join(PROJECTS_DIR, dir, file));
          }
        }
      } catch {
        continue;
      }
    }

    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (!newest || info.mtimeMs > newest.mtimeMs) {
          newest = { path: candidate, mtimeMs: info.mtimeMs };
        }
      } catch {
        // 候補が無いディレクトリ。
      }
    }
  }

  if (!newest) return null;
  pathCache.set(cacheKey, newest.path);
  return newest.path;
}

/** ファイル末尾だけを読む。先頭は行の途中から始まるので1行目は捨てる。 */
async function readTail(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return "";

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");

    // 途中から読むと1行目が欠ける。マルチバイト文字の切断もここで一緒に落ちる。
    if (start === 0) return text;
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    await handle.close();
  }
}

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

function timeLabel(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** tool_result の content は文字列にもブロック配列にもなる。 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

/** ツール実行を1行で説明する。何をしているか分かれば十分なので短く畳む。 */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").trim().slice(0, 140);
    }
  }
  return "";
}

// 窓口の発言には system-reminder が紛れることがある。表示には要らないので落とす。
const REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * セッションの会話を読み、表示用の配列にして返す。
 * 思考(thinking)と成功したツール結果は出さない。失敗したツール結果だけエラーとして拾う。
 */
export async function readTranscript(
  id: string,
  sessionId?: string,
): Promise<TranscriptEntry[]> {
  const filePath = await resolveTranscript(id, sessionId);
  if (!filePath) return [];

  const entries: TranscriptEntry[] = [];

  for (const line of (await readTail(filePath)).split("\n")) {
    if (!line.trim()) continue;

    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    // サブエージェント内部のやり取りはレーンの本筋ではないので出さない。
    if (row.isSidechain) continue;

    const message = row.message as { content?: unknown } | undefined;
    if (!message) continue;

    const time = timeLabel(row.timestamp);
    const uuid = typeof row.uuid === "string" ? row.uuid : `row-${entries.length}`;

    if (row.type === "user") {
      // 窓口からの指示は content が文字列で入る。
      if (typeof message.content === "string") {
        const text = message.content.replace(REMINDER_PATTERN, "").trim();
        if (text) entries.push({ key: uuid, role: "user", time, text });
        continue;
      }

      // 配列のときはツール結果。失敗したものだけ拾う。
      if (Array.isArray(message.content)) {
        message.content.forEach((block, i) => {
          const c = block as { type?: string; is_error?: boolean; content?: unknown };
          if (c.type === "tool_result" && c.is_error) {
            const text = flattenContent(c.content).trim().slice(0, 600);
            if (text) entries.push({ key: `${uuid}-${i}`, role: "error", time, text });
          }
        });
      }
      continue;
    }

    if (row.type === "assistant" && Array.isArray(message.content)) {
      message.content.forEach((block, i) => {
        const c = block as { type?: string; text?: string; name?: string; input?: unknown };

        if (c.type === "text" && c.text?.trim()) {
          entries.push({ key: `${uuid}-${i}`, role: "agent", time, text: c.text.trim() });
          return;
        }

        if (c.type === "tool_use") {
          entries.push({
            key: `${uuid}-${i}`,
            role: "tool",
            time,
            tool: c.name ?? "tool",
            text: toolDetail(c.input),
          });
        }

        // thinking は監視には不要なので出さない。
      });
    }
  }

  return entries.slice(-MAX_ENTRIES);
}
