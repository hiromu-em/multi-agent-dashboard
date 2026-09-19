import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaneStatus } from "@/lib/dashboard-data";
import { collectDiff } from "@/lib/agent-diff";
import { dismissSession, registerSessions } from "@/lib/lane-registry";

const run = promisify(execFile);

// `claude` は Windows でも実行可能ファイル（claude.exe）なので shell を挟まずに呼べる。
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

/** `claude agents --json` が返す1件分。 */
export interface CliAgent {
  id: string;
  sessionId: string;
  name?: string;
  cwd: string;
  kind: string;
  startedAt: number;
  pid?: number;
  /** working | blocked | done | failed | stopped（working 以外は終端状態） */
  state?: string;
  /** busy | idle | "" */
  status?: string;
}

/** ダッシュボードのレーン1件分。 */
export interface AgentLane {
  id: string;
  sessionId: string;
  tag: string;
  name: string;
  cwd: string;
  status: LaneStatus;
  startedAt: number;
  isAlive: boolean;
}

// 盤面から落とす対象になる状態。対話待ちは人の応答待ちなので含めない。
const FINISHED_STATUSES = new Set<LaneStatus>(["done", "error", "killed"]);

function toLaneStatus(agent: CliAgent): LaneStatus {
  switch (agent.state) {
    case "working":
      return "running";
    case "blocked":
      return "waiting";
    // エージェント自身が「これ以上進められない」と判断して終了した状態。
    // 完了と同じ緑で出すと見落とすので、エラーとして扱う。
    case "failed":
      return "error";
    case "stopped":
      return "killed";
    case "done":
      // 正常終了でもプロセスが残っていなければ「停止済み」扱いにする。
      return agent.pid ? "done" : "killed";
    default:
      return agent.status === "busy" ? "running" : "done";
  }
}

// `claude` CLI呼び出しの失敗をstdout/stderrも含めて1行にする。
//
// execFileの失敗は既定だと `error.message` が "Command failed: <cmd>"
// だけになりがちで、実際の原因（クラッシュ時の出力）が `error.stdout` /
// `error.stderr` に残っていても捨てられていた。ここで拾って残しておかないと、
// 次に同じ失敗が起きたときも「Command failed」としか分からず切り分けられない。
export function describeExecError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const parts = [String(err.message)];
    if (err.stdout) parts.push(`stdout: ${err.stdout.slice(0, 2000)}`);
    if (err.stderr) parts.push(`stderr: ${err.stderr.slice(0, 2000)}`);
    return parts.join(" | ");
  }
  return String(error);
}

// 直近の取得結果を短時間だけ使い回す。
//
// Diffや指示の配送はIDから作業ディレクトリやsessionIdを引くために一覧を要求するが、
// そのたびに `claude.exe`（218MB）を起動していた。画面のポーリングは4秒間隔なので、
// それより短いTTLなら表示の鮮度を落とさずに重複した起動だけを潰せる。
const LIST_TTL_MS = 1500;

let cached: { at: number; lanes: AgentLane[] } | null = null;
let inFlight: Promise<AgentLane[]> | null = null;

/** 稼働中のサブエージェントセッションを取得してレーン形式に変換する。 */
export async function listAgents(): Promise<AgentLane[]> {
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.lanes;

  // 同時に複数の要求が来ても起動は1回で済ませる。
  if (!inFlight) {
    inFlight = fetchAgents().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function fetchAgents(): Promise<AgentLane[]> {
  // `--all` が無いと、終了したセッション（failed / 停止済み）が一覧から消える。
  // 失敗したレーンこそ見落としてはいけないので、終わったものも含めて取得する。
  let stdout: string;
  try {
    ({ stdout } = await run(CLAUDE_BIN, ["agents", "--json", "--all"], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(describeExecError(error));
  }

  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];

  // セッションの作成・削除が短時間に重なると、`claude agents --json` が
  // 同じ id を持つ行を過渡的に2件返すことがある。id はReactのkeyにも
  // API（/api/agents/[id]/...）の識別子にも使うので、ここで一意にしておく。
  // 同じidが複数あれば後勝ち（より新しい行のほうがstartedAt等が正しい）。
  const deduped = new Map<string, CliAgent>();
  for (const agent of parsed as CliAgent[]) deduped.set(agent.id, agent);

  const filtered = [...deduped.values()];
  const statuses = new Map(filtered.map((agent) => [agent.sessionId, toLaneStatus(agent)]));

  // タグは並び順ではなくsessionIdに紐づく。指示の宛先として使うので動いてはいけない。
  // 台帳は同時に、終わってから時間の経ったレーンを一覧から落とし、endedAt（終了時刻）を返す。
  // registerSessions 自身は内部でstartedAt順に並べ直すので、渡す順序は問わない。
  const registry = await registerSessions(
    filtered.map((agent) => ({
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
      // 対話待ち（waiting）は終了扱いにしない。返事を待っているレーンは消さない。
      isFinished: FINISHED_STATUSES.has(statuses.get(agent.sessionId) ?? "done"),
    })),
  );

  // 並び順は開始時刻の昇順だけで決める。状態（完了・対話待ち・実行中…）では並べ替えない。
  // 状態で並べると、見ている最中にレーンが左右へ入れ替わって位置で覚えられなくなる。
  // 開始順なら新しいレーンは右端に足されるだけで、既存のレーンは動かない。
  const agents = filtered.sort((a, b) => a.startedAt - b.startedAt);

  const lanes = agents
    .filter((agent) => registry.has(agent.sessionId))
    .map((agent) => ({
      id: agent.id,
      sessionId: agent.sessionId,
      tag: registry.get(agent.sessionId)?.tag ?? "#?",
      name: agent.name?.trim() || agent.id,
      cwd: agent.cwd,
      status: statuses.get(agent.sessionId) ?? "done",
      startedAt: agent.startedAt,
      isAlive: typeof agent.pid === "number",
    }));

  cached = { at: Date.now(), lanes };
  return lanes;
}

/** 指示を配送した直後など、次の取得で必ず最新を見たいときに使う。 */
export function invalidateAgentCache(): void {
  cached = null;
}

// ログは `claude logs` ではなくセッションの会話JSONLから読む（src/lib/transcript.ts）。
// 端末描画を経由しないので、ANSI除去も \r の後始末も要らない。

/**
 * 終わったレーンを盤面から片付ける（「片付ける」ボタン）。
 *
 * セッションは止めも消しもしない。表示から外すだけなので、`claude attach <id>`
 * でも、そのセッションが再開すれば盤面でも、そのまま続きを見られる。
 */
export async function dismissLane(id: string): Promise<boolean> {
  const lanes = await listAgents();
  const lane = lanes.find((item) => item.id === id);
  if (!lane) return false;

  const dismissed = await dismissSession(lane.sessionId);
  // 次の取得で消えた状態を返すため、キャッシュを捨てる。
  invalidateAgentCache();
  return dismissed;
}

/** `claude stop <id>` でバックグラウンドセッションを停止する（会話は保持される）。 */
export async function stopAgent(id: string): Promise<void> {
  try {
    await run(CLAUDE_BIN, ["stop", id], { maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw new Error(describeExecError(error));
  }
}

/**
 * そのセッションの作業ディレクトリの変更を取得する。
 *
 * 作業ディレクトリはクライアントから受け取らず、実在するセッションと
 * 突き合わせて解決する。任意のパスを覗ける口にしないため。
 */
export async function readAgentDiff(id: string): Promise<string> {
  const agents = await listAgents();
  const agent = agents.find((a) => a.id === id);
  if (!agent) throw new Error(`agent not found: ${id}`);

  return collectDiff(agent.cwd);
}
