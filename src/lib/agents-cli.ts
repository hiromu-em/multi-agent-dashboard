import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaneStatus } from "@/lib/dashboard-data";
import { collectDiff } from "@/lib/agent-diff";
import { registerSessions } from "@/lib/lane-registry";
import { filterOutGateway } from "@/lib/gateway";

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
  const { stdout } = await run(CLAUDE_BIN, ["agents", "--json", "--all"], {
    maxBuffer: 8 * 1024 * 1024,
  });

  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];

  // セッションの作成・削除が短時間に重なると、`claude agents --json` が
  // 同じ id を持つ行を過渡的に2件返すことがある。id はReactのkeyにも
  // API（/api/agents/[id]/...）の識別子にも使うので、ここで一意にしておく。
  // 同じidが複数あれば後勝ち（より新しい行のほうがstartedAt等が正しい）。
  const deduped = new Map<string, CliAgent>();
  for (const agent of parsed as CliAgent[]) deduped.set(agent.id, agent);

  // 窓口として登録されているセッションはここで弾く。タグも消費させない。
  const filtered = await filterOutGateway([...deduped.values()]);
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

  // 並び順は「完了」→「対話待ち」→「実行中」→「エラー・停止済み」の優先度で決める。
  // 開始時刻はどこにも使わない（最後のtiebreakとしてのみ残す）。
  //
  // 安定ソートを3回チェーンしているので、最後に適用したものが最優先になる：
  //   1. startedAt昇順 … 完全な同着だけのtiebreak
  //   2. 終了時刻（endedAt）昇順 … 同じ優先度グループの中では、先に終わった
  //      （完了／エラー・停止）レーンほど左。新しく終わったレーンはグループの
  //      右端に追加されるだけで、既存の完了レーンを追い越して割り込むことはない
  //      （実行中・対話待ちはendedAtが無いので、このキーだけでは③に上書きされる
  //      まえの間 undefined 側＝左寄りに来る）
  //   3. 状態グループの優先度（低いほど左）
  const STATUS_PRIORITY: Record<LaneStatus, number> = {
    done: 0,
    waiting: 1,
    running: 2,
    error: 3,
    killed: 3,
  };
  const agents = filtered
    .sort((a, b) => a.startedAt - b.startedAt)
    .sort((a, b) => {
      const aEnded = registry.get(a.sessionId)?.endedAt;
      const bEnded = registry.get(b.sessionId)?.endedAt;
      if (aEnded === undefined && bEnded === undefined) return 0;
      if (aEnded === undefined) return -1;
      if (bEnded === undefined) return 1;
      return aEnded - bEnded;
    })
    .sort((a, b) => {
      const aPriority = STATUS_PRIORITY[statuses.get(a.sessionId) ?? "done"];
      const bPriority = STATUS_PRIORITY[statuses.get(b.sessionId) ?? "done"];
      return aPriority - bPriority;
    });

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

/** `claude stop <id>` でバックグラウンドセッションを停止する（会話は保持される）。 */
export async function stopAgent(id: string): Promise<void> {
  await run(CLAUDE_BIN, ["stop", id], { maxBuffer: 1024 * 1024 });
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
