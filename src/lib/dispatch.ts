import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeExecError, invalidateAgentCache, listAgents, type AgentLane } from "@/lib/agents-cli";
import { logDispatch } from "@/lib/dispatch-log";
import { isTagTaken, reserveTag } from "@/lib/lane-registry";

const run = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// ダッシュボードの指示入力欄から来た入力を、宛先のセッションへ振り分ける。
//
// `#B 本文` で宛先を指定し、以降は `#` を省くと同じ宛先へ送られる（スティッキー）。
// `#` 単独で宛先を解除する（以降は `#タグ` を明示しないと送れない）。

// 現在の宛先。サーバーを再起動しても保つためファイルに置く。
const TARGET_FILE = join(process.cwd(), ".logs", "target.json");

// 同時に走らせるセッションの上限。これを超える分はキューで待たせる。
const MAX_ACTIVE = 5;

// `#B` `#12` のような宛先指定の行。`# メモ` のような普通の見出しには当てない。
const TAG_LINE = /^#([A-Za-z]|\d{1,3})(?:[ \t]+(.*))?$/;

export interface DispatchTarget {
  tag: string;
  sessionId: string;
  name: string;
  updatedAt: number;
  // 宛先を切り替えた直後で、まだ「#無しの入力」を確認していない。
  // 切り替え後いちばん誤爆しやすい最初の1通だけ一呼吸置くためのフラグ
  // （confirmSend で消費されるまで立ったまま）。
  needsConfirm: boolean;
}

/** ダッシュボードの入力欄に返す結果。`ok` は表示の色分け（成功/要確認は通常表示、失敗は赤）にだけ使う。 */
export interface DispatchResult {
  ok: boolean;
  message: string;
}

interface Instruction {
  tag: string;
  body: string;
}

type ParsedPrompt =
  | { kind: "clear" }
  | { kind: "plain"; body: string }
  | { kind: "addressed"; instructions: Instruction[] };

/**
 * 入力を宛先ごとに切り分ける。
 *
 * `#` で始まる行を新しい指示の開始とみなし、次の `#` 行または入力の末尾までを
 * その宛先への本文として扱う。1回の入力で複数の宛先へ同時に出せる。
 */
export function parsePrompt(prompt: string): ParsedPrompt {
  const trimmed = prompt.trim();
  if (trimmed === "#") return { kind: "clear" };

  const instructions: Instruction[] = [];
  let current: Instruction | null = null;

  for (const line of trimmed.split("\n")) {
    const match = line.trimEnd().match(TAG_LINE);
    if (match) {
      if (current) instructions.push(current);
      current = { tag: `#${match[1].toUpperCase()}`, body: (match[2] ?? "").trim() };
      continue;
    }
    if (current) current.body = current.body ? `${current.body}\n${line}` : line;
  }
  if (current) instructions.push(current);

  // 宛先の指定が無ければ、今の宛先に向けた普通の入力として扱う。
  if (instructions.length === 0) return { kind: "plain", body: trimmed };
  return { kind: "addressed", instructions: instructions.filter((i) => i.body.trim()) };
}

/**
 * 入力が `#K` のようなタグ1つだけなら、そのタグを返す。
 *
 * `parsePrompt` は本文の無い指示を落とすので、そこからは区別が付かない。
 * 確認待ちの作成を数文字で実行できるようにするために、ここで拾い直す。
 */
function bareTagOf(prompt: string): string | null {
  const lines = prompt.trim().split("\n").filter((line) => line.trim());
  if (lines.length !== 1) return null;
  const match = lines[0].trimEnd().match(TAG_LINE);
  if (!match || (match[2] ?? "").trim()) return null;
  return `#${match[1].toUpperCase()}`;
}

async function readTarget(): Promise<DispatchTarget | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(TARGET_FILE, "utf8"));
    const target = parsed as Partial<DispatchTarget>;
    if (typeof target?.tag === "string" && typeof target?.sessionId === "string") {
      return {
        tag: target.tag,
        sessionId: target.sessionId,
        name: typeof target.name === "string" ? target.name : "",
        updatedAt: typeof target.updatedAt === "number" ? target.updatedAt : 0,
        needsConfirm: target.needsConfirm === true,
      };
    }
  } catch {
    // まだ無い、または読めない。宛先なしとして扱う。
  }
  return null;
}

async function writeTarget(target: DispatchTarget | null): Promise<void> {
  try {
    if (!target) {
      await unlink(TARGET_FILE).catch(() => {});
      return;
    }
    await mkdir(dirname(TARGET_FILE), { recursive: true });
    await writeFile(TARGET_FILE, `${JSON.stringify(target, null, 2)}\n`, "utf8");
  } catch {
    // 書けなくても配送自体は済ませる。
  }
}

/**
 * `listAgents()`（=`claude agents --json --all`）を一切呼ばずに、この入力が
 * 宛先付きだったかを判定する。
 *
 * `routePrompt` が `listAgents()` の失敗そのもので落ちたときのフォールバック専用。
 * `currentTarget()` は内部で `listAgents()` を呼ぶため、まさに壊れている経路に
 * 再び依存してしまい使えない。`.logs/target.json` を直接読む。
 *
 * `null` なら宛先なしの素の入力。それ以外は
 * 「宛先付きなら黙って消さず必ずエラーを返す」という設計方針の対象。
 */
export async function resolveAddressee(
  prompt: string,
): Promise<{ tag: string; sessionId: string } | null> {
  const parsed = parsePrompt(prompt);

  if (parsed.kind === "clear") return { tag: "#", sessionId: "" };
  if (parsed.kind === "addressed") {
    return { tag: parsed.instructions.map((i) => i.tag).join(",") || "?", sessionId: "" };
  }

  // plain: 今の宛先（スティッキー）が設定されていれば、それも宛先付きと同じ扱いにする。
  const target = await readTarget();
  return target ? { tag: target.tag, sessionId: target.sessionId } : null;
}

/** ダッシュボードが読む、現在の宛先。 */
export async function currentTarget(): Promise<DispatchTarget | null> {
  const target = await readTarget();
  if (!target) return null;

  // 宛先のセッションが消えていたら解除する。届かない相手に打ち続けないため。
  const lanes = await listAgents();
  if (!lanes.some((lane) => lane.sessionId === target.sessionId)) {
    await writeTarget(null);
    return null;
  }
  return target;
}

// 宛先が作業中のあいだ待たせる指示。プロセス内に持つのでサーバー再起動で消える。
interface QueuedInstruction {
  tag: string;
  sessionId: string;
  // 宛先が消えて捨てるとき（dropped）、名前も一緒に記録できるよう待たせた時点で控えておく。
  name: string;
  body: string;
  queuedAt: number;
}

const queue: QueuedInstruction[] = [];

// 送信中のセッション。二重に `stop` → `--resume` を打たないための鍵。
const sending = new Set<string>();

export function queuedCount(): number {
  return queue.length;
}

/**
 * 実際にセッションへ送る。
 *
 * プロセスが生きているセッションに `--resume` すると継続ではなく**コピーが生える**
 * （CLIが "started a copy" と言う）。先に `stop` してから起こすと、会話を保ったまま
 * 同じIDで再開する。作業中のセッションをここへ渡してはいけない（作業が中断される）。
 */
async function sendToSession(lane: AgentLane, body: string): Promise<void> {
  // 止める直前に状態を取り直す。
  //
  // 判断に使う一覧はキャッシュされている上、CLIが返す `state` 自体も
  // 少し遅れる。その隙に相手が作業を始めていると、`stop` が作業を中断させる。
  // 実際に、作業中のセッションへ送れてしまう場面を踏んだ。
  invalidateAgentCache();
  const fresh = (await listAgents()).find((item) => item.sessionId === lane.sessionId);
  if (!fresh) throw new Error("宛先のセッションが見つかりません");
  if (fresh.status === "running") throw new Error("宛先が作業中のため送信を取りやめました");

  try {
    if (fresh.isAlive) {
      await run(CLAUDE_BIN, ["stop", fresh.id], { maxBuffer: 1024 * 1024 });
    }
    await run(CLAUDE_BIN, ["--bg", "--resume", lane.sessionId, body], {
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(describeExecError(error));
  }
  invalidateAgentCache();
}

/**
 * 送信を待たずに返す。
 *
 * `claude.exe` の起動は数秒かかるので、入力欄の送信操作をその間止めない。
 * そのぶん結果は呼び出し元にすぐ返らないので、成否は必ず記録に残す。
 * 以前は直近の失敗を変数1つに持っていたが、次の送信が成功すると消えていた。
 */
function sendInBackground(lane: AgentLane, body: string): void {
  sending.add(lane.sessionId);
  void sendToSession(lane, body)
    .then(() => {
      void logDispatch({ event: "delivered", tag: lane.tag, sessionId: lane.sessionId, name: lane.name });
    })
    .catch((error) => {
      void logDispatch({
        event: "failed",
        tag: lane.tag,
        sessionId: lane.sessionId,
        name: lane.name,
        body,
        reason: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      sending.delete(lane.sessionId);
    });
}

/**
 * 待たせている指示を送れるだけ送る。
 * セッション一覧を取り直すたびに呼ばれるので、専用のタイマーは持たない。
 */
export async function drainQueue(): Promise<void> {
  if (queue.length === 0) return;

  const lanes = await listAgents();
  const byId = new Map(lanes.map((lane) => [lane.sessionId, lane]));
  let active = activeCount(lanes);

  for (const item of [...queue]) {
    const lane = byId.get(item.sessionId);

    // 宛先が消えた指示は捨てる。届け先が無い。
    // 入力欄には「順番待ちにしました」と伝えてあるので、捨てたことを必ず残す。
    if (!lane) {
      queue.splice(queue.indexOf(item), 1);
      void logDispatch({
        event: "dropped",
        tag: item.tag,
        sessionId: item.sessionId,
        name: item.name,
        body: item.body,
        reason: "宛先のセッションが盤面から消えた",
      });
      continue;
    }

    if (!canSendNow(lane, active)) continue;

    queue.splice(queue.indexOf(item), 1);
    void logDispatch({
      event: "sent",
      tag: lane.tag,
      sessionId: lane.sessionId,
      name: lane.name,
      body: item.body,
    });
    sendInBackground(lane, item.body);
    active += 1;
  }
}

/** 走っているセッション数。送信を始めたばかりの分も数える。 */
function activeCount(lanes: AgentLane[]): number {
  const running = lanes.filter((lane) => lane.status === "running").map((lane) => lane.sessionId);
  return new Set([...running, ...sending]).size;
}

function canSendNow(lane: AgentLane, active: number): boolean {
  // 作業中のセッションを止めて割り込むと、その作業が中断される。
  if (lane.status === "running") return false;
  // 同じ相手へ二重に送らない。
  if (sending.has(lane.sessionId)) return false;
  return active < MAX_ACTIVE;
}

/** 1件の指示を送るか、宛先が作業中なら待たせる。送信の完了は待たない。 */
async function deliver(lane: AgentLane, body: string): Promise<string> {
  const lanes = await listAgents();

  if (!canSendNow(lane, activeCount(lanes))) {
    queue.push({ tag: lane.tag, sessionId: lane.sessionId, name: lane.name, body, queuedAt: Date.now() });
    await logDispatch({ event: "queued", tag: lane.tag, sessionId: lane.sessionId, name: lane.name, body });
    return `${lane.tag}（${lane.name}）は作業中のため順番待ちにしました`;
  }

  await logDispatch({ event: "sent", tag: lane.tag, sessionId: lane.sessionId, name: lane.name, body });
  sendInBackground(lane, body);
  return `${lane.tag}（${lane.name}）へ送りました`;
}

// 存在しない宛先を指されたとき、確認を挟んでから新しいセッションを作る。
//
// 打ち間違い（`#B` のつもりで `#K`）でセッションが生えるのは避けたいので、
// 1回目は作らずに知らせるだけにする。**本文はここで預かる**ので、確認のときに
// もう一度打ち直す必要は無い。確認する道は2つ：盤面の「実行」ボタンと、入力欄で
// `#K` とタグだけ打つこと。どちらも同じ保留を消化する。
//
// 待ち合わせはプロセス内に持つ。数分で消えて構わない一時的な状態なので、
// 順番待ちと同じくサーバー再起動で消えてよい。
interface PendingCreate {
  body: string;
  at: number;
}

const pendingCreate = new Map<string, PendingCreate>();
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

/** 期限切れの保留を落とす。読むたびに掃除するので専用のタイマーは持たない。 */
function prunePending(): void {
  const now = Date.now();
  for (const [tag, pending] of pendingCreate) {
    if (now - pending.at > CONFIRM_WINDOW_MS) pendingCreate.delete(tag);
  }
}

export interface PendingCreateView {
  tag: string;
  body: string;
  at: number;
}

/** 盤面に出す、確認待ちの作成。 */
export function pendingCreates(): PendingCreateView[] {
  prunePending();
  return [...pendingCreate.entries()].map(([tag, pending]) => ({
    tag,
    body: pending.body,
    at: pending.at,
  }));
}

/** 盤面の「拒否」。預かっていた本文ごと捨てる。 */
export function rejectCreate(tag: string): boolean {
  return pendingCreate.delete(tag);
}

/**
 * 盤面の「実行」。預かっていた本文でセッションを作る。
 * 入力欄で `#K` とタグだけ打った場合もここへ来る。
 */
export async function confirmCreate(tag: string): Promise<{ ok: boolean; message: string }> {
  prunePending();
  const pending = pendingCreate.get(tag);
  if (!pending) return { ok: false, message: `${tag} の確認待ちはありません（期限切れの可能性）。` };

  pendingCreate.delete(tag);

  // 作った直後から動き出すので、同時実行の上限はここでも見る。
  const lanes = await listAgents();
  if (activeCount(lanes) >= MAX_ACTIVE) {
    return {
      ok: false,
      message: `${tag} は作れません。同時に走らせる上限（${MAX_ACTIVE}）に達しています。`,
    };
  }

  return { ok: true, message: await createLaneForTag(tag, pending.body) };
}

/** 新しいセッションのワークツリー名。`-w` はASCIIしか受け付けないのでタグから作る。 */
function worktreeNameFor(tag: string): string {
  return `lane-${tag.replace("#", "").toLowerCase()}`;
}

/** 盤面に出す名前。指示の1行目を短く使う。何も取れなければタグそのもの。 */
function displayNameFor(tag: string, body: string): string {
  const firstLine = body.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (!firstLine) return tag;
  return firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
}

/**
 * 指定のタグで新しいバックグラウンドセッションを起こし、指示をその最初の
 * プロンプトとして渡す。作成そのものが配送を兼ねるので `deliver` は通さない。
 *
 * タグは `reserveTag` で先に台帳へ書く。そうしないと `nextFreeTag` が空きを
 * 勝手に配り、`#K` へ送ったのに `#C` として盤面に出る。
 */
async function createLaneForTag(tag: string, body: string): Promise<string> {
  const worktree = worktreeNameFor(tag);
  const name = displayNameFor(tag, body);

  let stdout: string;
  try {
    ({ stdout } = await run(CLAUDE_BIN, ["--bg", "-w", worktree, "-n", name, body], {
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    const detail = describeExecError(error);
    await logDispatch({ event: "failed", tag, sessionId: "", body, reason: detail });
    return `${tag} のセッションを作れませんでした: ${detail}`;
  }

  // `claude --bg` は短いIDだけを返す。sessionIdは一覧から引き直す。
  const shortId = stdout.match(/([0-9a-f]{8})/i)?.[1];
  invalidateAgentCache();
  const agent = shortId ? (await listAgents()).find((lane) => lane.id === shortId) : undefined;

  if (!shortId || !agent) {
    // 起動はした。タグを予約できないので、台帳が空きタグを配ることになる。
    await logDispatch({
      event: "created",
      tag,
      sessionId: "",
      body,
      reason: `起動したがIDを解決できず、${tag} を予約できなかった`,
    });
    return `セッションは作りましたが ${tag} を割り当てられませんでした。盤面で実際のタグを確認してください。`;
  }

  await reserveTag(agent.sessionId, tag);
  invalidateAgentCache();
  await logDispatch({ event: "created", tag, sessionId: agent.sessionId, name, body });
  return `${tag}（${name}）を新しく作って指示を渡しました（${agent.id}）。`;
}

/**
 * 存在しない宛先を指されたときの返事。作らずに本文を預かって確認を求める。
 *
 * 本文つきでもう一度送られた場合も（打ち直しても届くように）そのまま作成する。
 *
 * 盤面に出ていなくても台帳がそのタグを持っていることがある（片付け済みの
 * セッションはタグを持ったまま盤面から消えている）。その場合は作らない。
 * 作ってしまうと、片付けたセッションが再開したときに同じタグが2つになる。
 */
async function handleUnknownTag(tag: string, body: string, lanes: AgentLane[]): Promise<string> {
  // タグだけでは何を扱っているセッションか分からないので、名前も添える。
  const available = lanes.map((lane) => `${lane.tag}(${lane.name})`).join(" ") || "（セッションがありません）";

  if (await isTagTaken(tag)) {
    pendingCreate.delete(tag);
    return `${tag} は片付け済みのセッションが持っています。今ある宛先: ${available}`;
  }

  prunePending();
  if (pendingCreate.has(tag)) {
    // 本文つきで打ち直された。今回の本文で作る。
    pendingCreate.set(tag, { body, at: Date.now() });
    return (await confirmCreate(tag)).message;
  }

  pendingCreate.set(tag, { body, at: Date.now() });
  return `${tag} という宛先はありません。今ある宛先: ${available} / 盤面の「実行」を押すか、もう一度 ${tag} と打つと、この指示のまま新しいセッションを作ります（${tag} だけでよく、本文は預かっています）。`;
}

// 宛先を切り替えた直後、`#`無しの最初の1通だけ保留して確認を挟む。
//
// 誤爆（`#B` へ切り替えたのを忘れて別の宛先のつもりで話しかける）がいちばん起きやすいのは
// 切り替えた直後だと考え、そこだけ一呼吸置く。2通目以降は目的の相手だと分かっている
// はずなので、これまで通りスティッキーのまま連続送信できる。
//
// pendingCreate と同じ理由でプロセス内に持つ（数分で消えて構わない一時的な状態）。
interface PendingConfirm {
  sessionId: string;
  name: string;
  body: string;
  at: number;
}

const pendingConfirm = new Map<string, PendingConfirm>();

/** 期限切れの保留を落とす。 */
function prunePendingConfirm(): void {
  const now = Date.now();
  for (const [tag, pending] of pendingConfirm) {
    if (now - pending.at > CONFIRM_WINDOW_MS) pendingConfirm.delete(tag);
  }
}

export interface PendingSendView {
  tag: string;
  name: string;
  body: string;
  at: number;
}

/** 盤面に出す、確認待ちの送信。 */
export function pendingSends(): PendingSendView[] {
  prunePendingConfirm();
  return [...pendingConfirm.entries()].map(([tag, pending]) => ({
    tag,
    name: pending.name,
    body: pending.body,
    at: pending.at,
  }));
}

/** 盤面の「取消」。預かっていた本文を捨てる。宛先自体の解除はしない。 */
export function rejectSend(tag: string): boolean {
  return pendingConfirm.delete(tag);
}

/**
 * 盤面の「送信」。預かっていた本文をそのまま送る。
 * 入力欄で `#B` とタグだけ打った場合もここへ来る。
 *
 * 送ったら宛先の `needsConfirm` を下ろす。以降の `#` 無しの入力は、次に
 * 宛先が切り替わるまで確認なしで送れる。
 */
export async function confirmSend(tag: string): Promise<{ ok: boolean; message: string }> {
  prunePendingConfirm();
  const pending = pendingConfirm.get(tag);
  if (!pending) return { ok: false, message: `${tag} の送信確認はありません（期限切れの可能性）。` };

  pendingConfirm.delete(tag);

  const lanes = await listAgents();
  const lane = lanes.find((item) => item.sessionId === pending.sessionId);
  if (!lane) return { ok: false, message: `${tag} のセッションが見つかりません。` };

  const target = await readTarget();
  if (target && target.tag === tag) {
    await writeTarget({ ...target, needsConfirm: false });
  }

  return { ok: true, message: await deliver(lane, pending.body) };
}

/**
 * ダッシュボードのレーンから直接返信する。
 *
 * 上部のグローバル入力欄（`routePrompt`）は `#タグ` によるスティッキー宛先解決を
 * 経由するのに対し、こちらは各レーンの返信欄専用の経路。宛先はUIで選んだレーン
 * そのものなので、タグ解決は要らない。
 *
 * 当初は `waiting`（CLIの `blocked`）のレーンだけに許していたが、質問を返して
 * ターンを終えたセッションをCLIは数秒で `done` として返すため、返信欄が出ても
 * 押す前に消え、押せてもここで弾かれていた。実行中のレーンの扱いは deliver に
 * 任せる（止めずに順番待ちへ積む）。
 */
export async function replyFromBoard(
  id: string,
  body: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: "本文が空です" };

  const lanes = await listAgents();
  const lane = lanes.find((item) => item.id === id);
  if (!lane) return { ok: false, error: "セッションが見つかりません" };
  const message = await deliver(lane, trimmed);
  return { ok: true, message };
}

/**
 * ダッシュボードの指示入力欄からの入力を振り分ける。
 */
export async function routePrompt(prompt: string): Promise<DispatchResult> {
  const lanes = await listAgents();

  const parsed = parsePrompt(prompt);

  if (parsed.kind === "clear") {
    const previous = await currentTarget();
    await writeTarget(null);
    if (previous) {
      await logDispatch({ event: "cleared", tag: previous.tag, sessionId: previous.sessionId, name: previous.name });
    }

    // `#` は「今のやりとりを取り消す」合図として使うので、確認待ちの作成・送信も一緒に捨てる。
    const droppedCreates = pendingCreates().map((p) => p.tag);
    for (const tag of droppedCreates) rejectCreate(tag);
    const droppedSends = pendingSends().map((p) => p.tag);
    for (const tag of droppedSends) rejectSend(tag);
    const dropped = [...droppedCreates, ...droppedSends];
    const note = dropped.length > 0 ? ` ${dropped.join(" ")} の作成・送信も取り消しました。` : "";

    return { ok: true, message: `宛先を解除しました。${note}` };
  }

  if (parsed.kind === "plain") {
    const target = await currentTarget();
    // 宛先が無ければ送りようがない。窓口CLIの時代は「素の入力は普通の会話」に
    // 落とせたが、ダッシュボードの入力欄はレーンへ送る以外の役目を持たない。
    if (!target) return { ok: false, message: "宛先がありません。#タグ で指定してください。" };

    const lane = lanes.find((item) => item.sessionId === target.sessionId);
    if (!lane) {
      await writeTarget(null);
      rejectSend(target.tag);
      return { ok: false, message: "宛先のセッションが見つからないため解除しました。" };
    }

    // 宛先を切り替えた直後の最初の1通だけ、本文を預かって一呼吸置く。
    // `#B 本文` のように明示的に打った入力はここを通らないので対象外
    // （タグを打つこと自体が既に確認済みの操作）。
    if (target.needsConfirm) {
      prunePendingConfirm();
      pendingConfirm.set(target.tag, {
        sessionId: target.sessionId,
        name: lane.name,
        body: parsed.body,
        at: Date.now(),
      });
      return {
        ok: true,
        message: `${target.tag}（${lane.name}）は宛先を切り替えた直後です。このまま${target.tag}宛てでよければ ${target.tag} とだけ打つか、盤面の「送信」を押してください（本文は預かっています）。`,
      };
    }

    return { ok: true, message: await deliver(lane, parsed.body) };
  }

  if (parsed.instructions.length === 0) {
    // 本文の無い `#K` は、確認待ちがあれば「実行」（または「送信」）の合図として扱う。
    // 打ち直さずに数文字で確認できるようにするためで、盤面のボタンと同じ経路。
    const bareTag = bareTagOf(prompt);
    if (bareTag && pendingCreates().some((p) => p.tag === bareTag)) {
      return await confirmCreate(bareTag);
    }
    if (bareTag && pendingSends().some((p) => p.tag === bareTag)) {
      return await confirmSend(bareTag);
    }
    return { ok: false, message: "宛先だけで本文がありません。" };
  }

  // 宛先を先に解決する。1つでも不明なら何も送らない。
  // 一部だけ届く状態は、届いたかどうかが分からなくなるので避ける。
  const resolved: Array<{ lane: AgentLane; body: string }> = [];
  for (const instruction of parsed.instructions) {
    const lane = lanes.find((item) => item.tag === instruction.tag);
    if (!lane) {
      // 確認を挟んでから作る。1回目は知らせるだけ、同じ宛先へもう一度送られたら作る。
      return { ok: false, message: await handleUnknownTag(instruction.tag, instruction.body, lanes) };
    }
    resolved.push({ lane, body: instruction.body });
  }

  // 並列に投げる。1件の完了を待たない。
  const results = await Promise.all(
    resolved.map(async ({ lane, body }) => {
      try {
        return await deliver(lane, body);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return `${lane.tag} へ送れませんでした: ${detail}`;
      }
    }),
  );

  // 最後に書いた宛先を、以降の `#` 無しの入力の送り先にする。
  //
  // 前と違うタグへの切り替えなら needsConfirm を立てる。今回のように `#タグ 本文` と
  // 明示して打つこと自体はすでに確認済みの操作なので対象外——対象は次に来る
  // `#無し` の1通だけ。同じタグへの明示的な再送信（切り替えではない）なら、
  // 誤爆の対象になっている保留があっても意味が無いので一緒に捨てる。
  const last = resolved[resolved.length - 1].lane;
  const previousTarget = await readTarget();
  const isNewSwitch = !previousTarget || previousTarget.tag !== last.tag;
  rejectSend(last.tag);
  await writeTarget({
    tag: last.tag,
    sessionId: last.sessionId,
    name: last.name,
    updatedAt: Date.now(),
    needsConfirm: isNewSwitch,
  });

  return { ok: true, message: results.join(" / ") };
}
