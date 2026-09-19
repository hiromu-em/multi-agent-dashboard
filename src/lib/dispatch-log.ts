import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

// 指示入力欄から出した指示の記録。1行1件のJSONLで追記する。
//
// 会話JSONLには「そのセッションが何を受け取ったか」しか残らない。盤面の側の事実
// ——どのタグ宛てだったか、いつ順番待ちになったか、送信に失敗したか——は
// どこにも残らないので、ここに書く。
//
// 特に、指示が黙って消える経路が2つある。この記録がその唯一の痕跡になる。
//   1. 順番待ちの宛先が盤面から消えると、その指示は捨てられる
//   2. 送信は非同期なので、失敗しても呼び出し元にはすぐ返らない
const LOG_FILE = join(process.cwd(), ".logs", "dispatch.jsonl");

// 本文が長くても記録に全文は要らない。何を送ったか分かれば足りる。
const MAX_BODY_CHARS = 2000;

// 読み出すときに見る末尾の量。
const TAIL_BYTES = 256 * 1024;

export type DispatchEvent =
  /** 送信を受理した（実際の送信は裏で走る） */
  | "sent"
  /** 宛先が作業中なので順番待ちにした */
  | "queued"
  /** 送信が完了した */
  | "delivered"
  /** 送信に失敗した */
  | "failed"
  /** 順番待ちのまま宛先が消えたので捨てた */
  | "dropped"
  /** 宛先を解除した */
  | "cleared"
  /** 存在しない宛先を指され、確認のうえ新しいセッションを作った */
  | "created";

export interface DispatchRecord {
  at: string;
  event: DispatchEvent;
  tag: string;
  sessionId: string;
  // タグだけでは何を扱っているセッションか分からないので、記録の時点の名前も残す。
  // セッションが消えたあとでも（dropped など）盤面に名前を出せるようにするため。
  name?: string;
  body?: string;
  reason?: string;
}

/** 記録を1行追記する。失敗しても配送自体は続ける。 */
export async function logDispatch(record: Omit<DispatchRecord, "at">): Promise<void> {
  try {
    const line: DispatchRecord = {
      at: new Date().toISOString(),
      ...record,
      body: record.body ? record.body.slice(0, MAX_BODY_CHARS) : undefined,
    };
    await mkdir(dirname(LOG_FILE), { recursive: true });
    await appendFile(LOG_FILE, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // 記録できなくても指示は届けたい。
  }
}

/** 末尾だけ読む。行の途中から始まるので1行目は捨てる。 */
async function readTail(): Promise<string> {
  const handle = await open(LOG_FILE, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    if (length <= 0) return "";

    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;

    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    await handle.close();
  }
}

/** 新しいものから順に読む。 */
export async function readDispatchLog(limit = 100): Promise<DispatchRecord[]> {
  let text: string;
  try {
    text = await readTail();
  } catch {
    return []; // まだ1件も無い。
  }

  const records: DispatchRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as DispatchRecord;
      if (typeof record?.at === "string" && typeof record?.event === "string") {
        records.push(record);
      }
    } catch {
      // 壊れた行は飛ばす。
    }
  }

  return records.slice(-limit).reverse();
}

// 画面に出す「取りこぼし」を探す範囲。
const PROBLEM_WINDOW_MS = 60 * 60 * 1000;
const PROBLEM_EVENTS = new Set<DispatchEvent>(["failed", "dropped"]);

/**
 * 直近の取りこぼし。送信の失敗と、宛先が消えて捨てられた指示。
 *
 * 送信の完了は待たない設計なので、これを画面に出さないと
 * 「送ったのに動いていない」理由が誰にも分からない。
 *
 * ただし、同じ宛先へその後に届いた記録（`delivered`）があれば、その失敗は
 * もう解消済みとみなして外す。再送して届いた指示がいつまでも「送信失敗」の
 * ままだと、直っているのに壊れているように見えて紛らわしい。
 */
export async function recentProblems(limit = 5): Promise<DispatchRecord[]> {
  const since = Date.now() - PROBLEM_WINDOW_MS;
  const records = await readDispatchLog(200); // 新しい順

  return records
    .filter((record, index) => {
      if (!PROBLEM_EVENTS.has(record.event)) return false;
      const at = Date.parse(record.at);
      if (!Number.isFinite(at) || at < since) return false;

      // 新しい順なので、自分より前（配列の手前側）が時間的には後。
      // そこに同じ宛先への delivered があれば解消済み。
      return !records
        .slice(0, index)
        .some((later) => later.event === "delivered" && later.sessionId === record.sessionId);
    })
    .slice(0, limit);
}
