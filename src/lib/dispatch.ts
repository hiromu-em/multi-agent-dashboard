import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invalidateAgentCache, listAgents, type AgentLane } from "@/lib/agents-cli";
import { logDispatch } from "@/lib/dispatch-log";

const run = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// 窓口CLIから来た入力を、宛先のセッションへ振り分ける。
//
// 指示はすべて窓口のCLIから出す。ダッシュボードに入力欄は無い。
// `#B 本文` で宛先を指定し、以降は `#` を省くと同じ宛先へ送られる（スティッキー）。
// `#` 単独で宛先を解除し、窓口のClaudeとの会話に戻る。

// 現在の宛先。フックとステータスラインの両方から読むのでファイルに置く。
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
}

/** 窓口に返す判断。`block` なら窓口のClaudeにはプロンプトを渡さない。 */
export interface RouteResult {
  block: boolean;
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

/** ダッシュボードとステータスラインが読む、現在の宛先。 */
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

  if (fresh.isAlive) {
    await run(CLAUDE_BIN, ["stop", fresh.id], { maxBuffer: 1024 * 1024 });
  }
  await run(CLAUDE_BIN, ["--bg", "--resume", lane.sessionId, body], {
    maxBuffer: 4 * 1024 * 1024,
  });
  invalidateAgentCache();
}

/**
 * 送信を待たずに返す。
 *
 * `claude.exe` の起動は数秒かかるので、窓口の入力をその間止めない。
 * そのぶん結果は窓口に返らないので、成否は必ず記録に残す。
 * 以前は直近の失敗を変数1つに持っていたが、次の送信が成功すると消えていた。
 */
function sendInBackground(lane: AgentLane, body: string): void {
  sending.add(lane.sessionId);
  void sendToSession(lane, body)
    .then(() => {
      void logDispatch({ event: "delivered", tag: lane.tag, sessionId: lane.sessionId });
    })
    .catch((error) => {
      void logDispatch({
        event: "failed",
        tag: lane.tag,
        sessionId: lane.sessionId,
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
    // 窓口には「順番待ちにしました」と伝えてあるので、捨てたことを必ず残す。
    if (!lane) {
      queue.splice(queue.indexOf(item), 1);
      void logDispatch({
        event: "dropped",
        tag: item.tag,
        sessionId: item.sessionId,
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
    queue.push({ tag: lane.tag, sessionId: lane.sessionId, body, queuedAt: Date.now() });
    await logDispatch({ event: "queued", tag: lane.tag, sessionId: lane.sessionId, body });
    return `${lane.tag} は作業中のため順番待ちにしました`;
  }

  await logDispatch({ event: "sent", tag: lane.tag, sessionId: lane.sessionId, body });
  sendInBackground(lane, body);
  return `${lane.tag} へ送りました`;
}

/**
 * ダッシュボードのレーンから直接返信する。
 *
 * 指示はすべて窓口のCLIから出す設計だが、盤面に見えているレーンへの返信に限っては
 * 例外を認める。宛先はUIで選んだレーンそのものなので、`#B` のようなタグ解決は
 * 要らない。それ以外の用途（新しい指示を好きな宛先に送る）には使わない——それは
 * 引き続き窓口のCLI経由でしか出来ない。
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
 * 窓口の入力を振り分ける。窓口のCLIのフックから呼ばれる。
 * `block: false` を返した入力だけが窓口のClaudeに渡る。
 */
export async function routePrompt(prompt: string, sessionId?: string): Promise<RouteResult> {
  const lanes = await listAgents();

  // 呼び出し元がレーンそのものなら横取りしない。
  //
  // 配送先のエージェントが同じフックを持っていると、こちらが送った指示を
  // そのエージェントがまた振り分けてしまい、指示が延々と回り続ける。
  // 窓口はボードに並ばない決まりなので、レーンに居る＝窓口ではない
  // （`claude --bg` で起動した窓口自身も `.logs/gateway.json` に登録して
  // ここで弾く。登録し忘れると、この分岐に引っかかって窓口からの `#` 指示が
  // 一切配送されず、素通りしているように見える）。
  if (sessionId && lanes.some((lane) => lane.sessionId === sessionId)) {
    return { block: false, message: "" };
  }

  const parsed = parsePrompt(prompt);

  if (parsed.kind === "clear") {
    const previous = await currentTarget();
    await writeTarget(null);
    if (previous) {
      await logDispatch({ event: "cleared", tag: previous.tag, sessionId: previous.sessionId });
    }
    return { block: true, message: "宛先を解除しました。以降は窓口のClaudeと会話します。" };
  }

  if (parsed.kind === "plain") {
    const target = await currentTarget();
    // 宛先が無ければ横取りしない。窓口のClaudeとの普通の会話。
    if (!target) return { block: false, message: "" };

    const lane = lanes.find((item) => item.sessionId === target.sessionId);
    if (!lane) {
      await writeTarget(null);
      return { block: true, message: "宛先のセッションが見つからないため解除しました。" };
    }
    return { block: true, message: await deliver(lane, parsed.body) };
  }

  if (parsed.instructions.length === 0) {
    return { block: true, message: "宛先だけで本文がありません。" };
  }

  // 宛先を先に解決する。1つでも不明なら何も送らない。
  // 一部だけ届く状態は、届いたかどうかが分からなくなるので避ける。
  const resolved: Array<{ lane: AgentLane; body: string }> = [];
  for (const instruction of parsed.instructions) {
    const lane = lanes.find((item) => item.tag === instruction.tag);
    if (!lane) {
      const available = lanes.map((item) => item.tag).join(" ") || "（セッションがありません）";
      return {
        block: true,
        message: `${instruction.tag} という宛先はありません。今ある宛先: ${available}`,
      };
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
  const last = resolved[resolved.length - 1].lane;
  await writeTarget({
    tag: last.tag,
    sessionId: last.sessionId,
    name: last.name,
    updatedAt: Date.now(),
  });

  return { block: true, message: results.join(" / ") };
}
