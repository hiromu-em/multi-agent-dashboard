import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// タグ（#A #B …）はレーンの並び順ではなく「指示の宛先」なので、
// 一度割り当てたらセッションが終わるまで動いてはいけない。
// 配列の添字から作ると、古いセッションが1つ消えるだけで後続が繰り上がり、
// `#C` 宛ての指示が別のセッションへ届く。だからsessionIdに紐づけて永続化する。
const TAGS_FILE = join(process.cwd(), ".logs", "tags.json");

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// 終了したセッションのタグをすぐ再利用すると「さっき言っていた #B」と混同する。
// この期間は空けてから再利用する。
const RECYCLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// ポーリングのたびに書き込まないための最短間隔。
const WRITE_INTERVAL_MS = 30 * 1000;

interface TagRecord {
  tag: string;
  /** 最後にセッション一覧で見かけた時刻。再利用の判断に使う。 */
  lastSeen: number;
}

type TagStore = Record<string, TagRecord>;

let lastWrite = 0;

async function load(): Promise<TagStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(TAGS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    // 壊れた記録は捨てる。タグは作り直せるので落ちるより作り直すほうがよい。
    const store: TagStore = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as { tag?: unknown; lastSeen?: unknown };
      if (typeof record?.tag === "string" && typeof record?.lastSeen === "number") {
        store[sessionId] = { tag: record.tag, lastSeen: record.lastSeen };
      }
    }
    return store;
  } catch {
    // まだ無い、または読めない。
    return {};
  }
}

async function save(store: TagStore): Promise<void> {
  try {
    await mkdir(dirname(TAGS_FILE), { recursive: true });
    await writeFile(TAGS_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    lastWrite = Date.now();
  } catch {
    // 書けなくてもタグの割り当て自体は返せる。次回に任せる。
  }
}

/** 予約済みでない最小のタグを返す。A〜Zを使い切ったら #27 以降の数字にする。 */
function nextFreeTag(reserved: Set<string>): string {
  for (const letter of LETTERS) {
    const tag = `#${letter}`;
    if (!reserved.has(tag)) return tag;
  }
  for (let n = LETTERS.length + 1; ; n++) {
    const tag = `#${n}`;
    if (!reserved.has(tag)) return tag;
  }
}

export interface TaggableSession {
  sessionId: string;
  startedAt: number;
}

/**
 * sessionId ごとに安定したタグを割り当てて返す。
 *
 * 既に割り当て済みのセッションはそのタグを保ち、新しいセッションだけが
 * 空いているタグを受け取る。並び順（開始時刻の昇順）とは独立しているので、
 * 表示は `#A #C #D` のように飛ぶことがある。宛先の同一性を優先した結果。
 */
export async function assignTags(sessions: TaggableSession[]): Promise<Map<string, string>> {
  const store = await load();
  const now = Date.now();
  const assigned = new Map<string, string>();

  // 最近まで生きていたタグは、たとえ今の一覧に無くても新規割り当てに使わない。
  const reserved = new Set<string>();
  for (const record of Object.values(store)) {
    if (now - record.lastSeen < RECYCLE_AFTER_MS) reserved.add(record.tag);
  }

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  let structuralChange = false;

  // 既知のセッションは自分のタグを維持する。
  for (const session of ordered) {
    const record = store[session.sessionId];
    if (!record) continue;
    record.lastSeen = now;
    reserved.add(record.tag);
    assigned.set(session.sessionId, record.tag);
  }

  // 残りに空きタグを配る。古いセッションから順に配るので、並びとタグは概ね一致する。
  for (const session of ordered) {
    if (assigned.has(session.sessionId)) continue;
    const tag = nextFreeTag(reserved);
    reserved.add(tag);
    store[session.sessionId] = { tag, lastSeen: now };
    assigned.set(session.sessionId, tag);
    structuralChange = true;
  }

  // 長く見かけないセッションの記録は捨てる。ここで初めてタグが再利用可能になる。
  for (const [sessionId, record] of Object.entries(store)) {
    if (now - record.lastSeen > RECYCLE_AFTER_MS) {
      delete store[sessionId];
      structuralChange = true;
    }
  }

  // lastSeen の更新だけのために4秒ごとに書き込まない。
  if (structuralChange || now - lastWrite > WRITE_INTERVAL_MS) {
    await save(store);
  }

  return assigned;
}
