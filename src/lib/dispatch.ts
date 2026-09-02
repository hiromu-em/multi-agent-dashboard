import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invalidateAgentCache, listAgents, type AgentLane } from "@/lib/agents-cli";

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

// 直近の送信失敗。窓口は送信の完了を待たないので、ここに置いて画面から見せる。
let lastError: string | null = null;

export function queuedCount(): number {
  return queue.length;
}

export function lastDispatchError(): string | null {
  return lastError;
}

/**
 * 実際にセッションへ送る。
 *
 * プロセスが生きているセッションに `--resume` すると継続ではなく**コピーが生える**
 * （CLIが "started a copy" と言う）。先に `stop` してから起こすと、会話を保ったまま
 * 同じIDで再開する。作業中のセッションをここへ渡してはいけない（作業が中断される）。
 */
async function sendToSession(lane: AgentLane, body: string): Promise<void> {
  if (lane.isAlive) {
    await run(CLAUDE_BIN, ["stop", lane.id], { maxBuffer: 1024 * 1024 });
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
 * 結果はレーンの表示に出るし、失敗は `lastError` から画面で見える。
 */
function sendInBackground(lane: AgentLane, body: string): void {
  sending.add(lane.sessionId);
  void sendToSession(lane, body)
    .then(() => {
      lastError = null;
    })
    .catch((error) => {
      lastError = `${lane.tag}: ${error instanceof Error ? error.message : String(error)}`;
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
    if (!lane) {
      queue.splice(queue.indexOf(item), 1);
      continue;
    }

    if (!canSendNow(lane, active)) continue;

    queue.splice(queue.indexOf(item), 1);
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
    return `${lane.tag} は作業中のため順番待ちにしました`;
  }

  sendInBackground(lane, body);
  return `${lane.tag} へ送りました`;
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
  // 窓口はボードに並ばない決まりなので、レーンに居る＝窓口ではない。
  if (sessionId && lanes.some((lane) => lane.sessionId === sessionId)) {
    return { block: false, message: "" };
  }

  const parsed = parsePrompt(prompt);

  if (parsed.kind === "clear") {
    await writeTarget(null);
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
