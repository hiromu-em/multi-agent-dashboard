import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// タグ（#A #B …）はレーンの並び順ではなく「指示の宛先」なので、
// 一度割り当てたらセッションが終わるまで動いてはいけない。
// 配列の添字から作ると、古いセッションが1つ消えるだけで後続が繰り上がり、
// `#C` 宛ての指示が別のセッションへ届く。だからsessionIdに紐づけて永続化する。
const TAGS_FILE = join(process.cwd(), ".logs", "tags.json");

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// タグは使い回す。生きているセッションが持っていないものは再利用の候補になる。
// ただし終了直後のタグをすぐ配ると「さっき言っていた #B」と混同するので、
// 未使用のタグを先に配り、次に「手放されてから最も長いもの」を選ぶ。
// 26個すべてが生きたセッションに使われている場合だけ #27 以降に落ちる。

// 記録を無限に溜めないための保持期間。再利用の可否ではなく掃除のための値。
const KEEP_RECORD_MS = 90 * 24 * 60 * 60 * 1000;

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

/**
 * 次に配るタグを選ぶ。`taken` は今この瞬間に使われているタグ。
 *
 * 一度も使っていないタグを優先し、無ければ最後に見かけたのが最も古いタグを選ぶ。
 * こうすると、直前に終わったセッションのタグが真っ先に配られることはない。
 * A〜Zがすべて生きたセッションに使われているときだけ #27 以降になる。
 */
function nextFreeTag(taken: Set<string>, tagLastSeen: Map<string, number>): string {
  const free = LETTERS.map((letter) => `#${letter}`).filter((tag) => !taken.has(tag));

  if (free.length === 0) {
    for (let n = LETTERS.length + 1; ; n++) {
      const tag = `#${n}`;
      if (!taken.has(tag)) return tag;
    }
  }

  const unused = free.filter((tag) => !tagLastSeen.has(tag));
  if (unused.length > 0) return unused[0];

  // 手放されてから最も長いものから配る。同着はアルファベット順で決める。
  return free.sort((a, b) => (tagLastSeen.get(a) ?? 0) - (tagLastSeen.get(b) ?? 0))[0];
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
 *
 * 終了したセッションのタグは再利用する。ただし配る順序で間隔を稼ぐので、
 * 直前に終わったタグがすぐ次のセッションに渡ることはない。
 */
export async function assignTags(sessions: TaggableSession[]): Promise<Map<string, string>> {
  const store = await load();
  const now = Date.now();
  const assigned = new Map<string, string>();

  // タグごとに「最後に見かけた時刻」を出す。同じタグを過去に複数のセッションが
  // 使っていることがあるので、最も新しいものを採る。
  const tagLastSeen = new Map<string, number>();
  for (const record of Object.values(store)) {
    const seen = tagLastSeen.get(record.tag);
    if (seen === undefined || record.lastSeen > seen) tagLastSeen.set(record.tag, record.lastSeen);
  }

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  let structuralChange = false;

  // 今この瞬間に使われているタグ。これ以外はすべて再利用の候補。
  const taken = new Set<string>();

  // 既知のセッションは自分のタグを維持する。
  for (const session of ordered) {
    const record = store[session.sessionId];
    if (!record) continue;
    record.lastSeen = now;
    tagLastSeen.set(record.tag, now);
    taken.add(record.tag);
    assigned.set(session.sessionId, record.tag);
  }

  // 残りにタグを配る。古いセッションから順に配るので、並びとタグは概ね一致する。
  for (const session of ordered) {
    if (assigned.has(session.sessionId)) continue;
    const tag = nextFreeTag(taken, tagLastSeen);
    taken.add(tag);
    tagLastSeen.set(tag, now);
    store[session.sessionId] = { tag, lastSeen: now };
    assigned.set(session.sessionId, tag);
    structuralChange = true;
  }

  // 古い記録の掃除。再利用の可否には影響しない（タグは常に使い回せる）。
  for (const [sessionId, record] of Object.entries(store)) {
    if (now - record.lastSeen > KEEP_RECORD_MS) {
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
