import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// セッションごとの台帳。タグと「いつ終わったか」を覚えている。
//
// タグ（#A #B …）はレーンの並び順ではなく「指示の宛先」なので、
// 一度割り当てたらセッションが終わるまで動いてはいけない。
// 配列の添字から作ると、古いセッションが1つ消えるだけで後続が繰り上がり、
// `#C` 宛ての指示が別のセッションへ届く。だからsessionIdに紐づけて永続化する。
const REGISTRY_FILE = join(process.cwd(), ".logs", "sessions.json");

// 終わったレーンは時間では消さない。片付けるまで盤面に残す。
//
// 以前は終了から3時間で落としていたが、それだと**返事を待っているレーンが
// 黙って消える**。エージェントが質問文を返してターンを終えた状態を、CLIは
// 数秒で `done` として返す（`blocked` はほとんど観測できない）ので、
// 「対話待ちは打ち切らない」という例外も実際には効いていなかった。
// 3時間放置した質問は、レーンごと——タグの割り当てごと——消えていた。
//
// 代わりに手で片付ける（`dismissSession`）。片付けたレーンが再開したら
// 記録を取り消して盤面に戻す。

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// タグは使い回す。生きているセッションが持っていないものは再利用の候補になる。
// ただし終了直後のタグをすぐ配ると「さっき言っていた #B」と混同するので、
// 未使用のタグを先に配り、次に「手放されてから最も長いもの」を選ぶ。
// 26個すべてが生きたセッションに使われている場合だけ #27 以降に落ちる。

// 記録を無限に溜めないための保持期間。再利用の可否ではなく掃除のための値。
const KEEP_RECORD_MS = 90 * 24 * 60 * 60 * 1000;

// ポーリングのたびに書き込まないための最短間隔。
const WRITE_INTERVAL_MS = 30 * 1000;

interface SessionRecord {
  tag: string;
  /** 最後にセッション一覧で見かけた時刻。タグ再利用の判断に使う。 */
  lastSeen: number;
  /** 終わった状態で最初に見かけた時刻。並び順に使う。 */
  endedAt?: number;
  /** 盤面から片付けた時刻。入っている間は表示しない。 */
  dismissedAt?: number;
}

type SessionStore = Record<string, SessionRecord>;

let lastWrite = 0;

async function load(): Promise<SessionStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(REGISTRY_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    // 壊れた記録は捨てる。タグは作り直せるので落ちるより作り直すほうがよい。
    const store: SessionStore = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as {
        tag?: unknown;
        lastSeen?: unknown;
        endedAt?: unknown;
        dismissedAt?: unknown;
      };
      if (typeof record?.tag === "string" && typeof record?.lastSeen === "number") {
        store[sessionId] = {
          tag: record.tag,
          lastSeen: record.lastSeen,
          endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
          dismissedAt: typeof record.dismissedAt === "number" ? record.dismissedAt : undefined,
        };
      }
    }
    return store;
  } catch {
    // まだ無い、または読めない。
    return {};
  }
}

async function save(store: SessionStore): Promise<void> {
  try {
    await mkdir(dirname(REGISTRY_FILE), { recursive: true });
    await writeFile(REGISTRY_FILE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
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

export interface RegisteredSession {
  sessionId: string;
  startedAt: number;
  /**
   * 終わったレーンか。`done` `failed` `stopped` は true。
   * `blocked`（対話待ち）は人の応答を待っている状態なので false のまま扱う。
   * 消してしまうと、返事を待っているレーンに気づけなくなる。
   */
  isFinished: boolean;
}

export interface RegisteredLane {
  tag: string;
  /** 終わった状態を最初に見かけた時刻。まだ終わっていなければ undefined。 */
  endedAt?: number;
}

/**
 * sessionId ごとに安定したタグを割り当て、表示すべきセッションだけを返す。
 *
 * 既に割り当て済みのセッションはそのタグを保ち、新しいセッションだけが
 * 空いているタグを受け取る。並び順（開始時刻の昇順）とは独立しているので、
 * 表示は `#A #C #D` のように飛ぶことがある。宛先の同一性を優先した結果。
 *
 * 終了したセッションのタグは再利用する。ただし配る順序で間隔を稼ぐので、
 * 直前に終わったタグがすぐ次のセッションに渡ることはない。
 *
 * 片付けた（`dismissSession`）セッションは戻り値に含めない。呼び出し側は
 * このMapに無いものをレーンから外す。時間では落とさない。
 *
 * `endedAt` も一緒に返す。並び順（完了が新しい順に並べる）に使うため。
 */
export async function registerSessions(
  sessions: RegisteredSession[],
): Promise<Map<string, RegisteredLane>> {
  const store = await load();
  const now = Date.now();
  const assigned = new Map<string, RegisteredLane>();

  // タグごとに「最後に見かけた時刻」を出す。同じタグを過去に複数のセッションが
  // 使っていることがあるので、最も新しいものを採る。
  const tagLastSeen = new Map<string, number>();
  for (const record of Object.values(store)) {
    const seen = tagLastSeen.get(record.tag);
    if (seen === undefined || record.lastSeen > seen) tagLastSeen.set(record.tag, record.lastSeen);
  }

  const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  let structuralChange = false;

  // 終了時刻を記録し、まだ盤面に残すべきものだけを選ぶ。
  const visible: RegisteredSession[] = [];
  for (const session of ordered) {
    const record = store[session.sessionId];

    if (!session.isFinished) {
      // 実行中・対話待ちは常に表示する。再開したなら終了の記録は取り消す。
      if (record?.endedAt !== undefined) {
        record.endedAt = undefined;
        structuralChange = true;
      }
      // 片付けたレーンでも、返信などで動き出したなら盤面に戻す。
      if (record?.dismissedAt !== undefined) {
        record.dismissedAt = undefined;
        structuralChange = true;
      }
      visible.push(session);
      continue;
    }

    // 終わった状態を最初に見かけた時刻を起点にする。
    // ダッシュボード起動前に終わっていたセッションは、初めて見た時刻が起点になる。
    if (record && record.endedAt === undefined) {
      record.endedAt = now;
      structuralChange = true;
    }

    // 時間では落とさない。手で片付けたものだけ盤面から外す。
    if (record?.dismissedAt === undefined) visible.push(session);
  }

  // 今この瞬間に使われているタグ。これ以外はすべて再利用の候補。
  const taken = new Set<string>();

  // 既知のセッションは自分のタグを維持する。
  for (const session of visible) {
    const record = store[session.sessionId];
    if (!record) continue;
    record.lastSeen = now;
    tagLastSeen.set(record.tag, now);
    taken.add(record.tag);
    assigned.set(session.sessionId, { tag: record.tag, endedAt: record.endedAt });
  }

  // 残りにタグを配る。古いセッションから順に配るので、並びとタグは概ね一致する。
  for (const session of visible) {
    if (assigned.has(session.sessionId)) continue;
    const tag = nextFreeTag(taken, tagLastSeen);
    taken.add(tag);
    tagLastSeen.set(tag, now);
    const endedAt = session.isFinished ? now : undefined;
    store[session.sessionId] = { tag, lastSeen: now, endedAt };
    assigned.set(session.sessionId, { tag, endedAt });
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

/**
 * 終わったレーンを盤面から片付ける。セッション自体には触らない。
 *
 * 時間で自動的に消さなくなった代わりの手段。片付けてもタグの記録は残り、
 * そのセッションが再開すれば `registerSessions` が記録を取り消して盤面に戻す。
 */
export async function dismissSession(sessionId: string): Promise<boolean> {
  const store = await load();
  const record = store[sessionId];
  if (!record) return false;

  record.dismissedAt = Date.now();
  await save(store);
  return true;
}
