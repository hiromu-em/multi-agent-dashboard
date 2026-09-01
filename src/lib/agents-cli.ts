import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LaneStatus } from "@/lib/dashboard-data";

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

const TAGS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

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

/** 稼働中のサブエージェントセッションを取得してレーン形式に変換する。 */
export async function listAgents(): Promise<AgentLane[]> {
  const { stdout } = await run(CLAUDE_BIN, ["agents", "--json"], {
    maxBuffer: 8 * 1024 * 1024,
  });

  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];

  return (parsed as CliAgent[])
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((agent, i) => ({
      id: agent.id,
      sessionId: agent.sessionId,
      tag: `#${TAGS[i] ?? i + 1}`,
      name: agent.name?.trim() || agent.id,
      cwd: agent.cwd,
      status: toLaneStatus(agent),
      startedAt: agent.startedAt,
      isAlive: typeof agent.pid === "number",
    }));
}

// ANSIエスケープシーケンス（色・カーソル移動など）を除去する。
// ソースに生の制御文字を置かないよう、文字列から RegExp を組み立てる。
const ANSI_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*" +
    "(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007" +
    "|(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])",
  "g",
);

// 残った制御文字（ベル・バックスペース等）。改行とタブは残す。
const CONTROL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F]", "g");

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "").replace(/\r/g, "\n").replace(CONTROL_PATTERN, "");
}

/** `claude logs <id>` の出力をANSI除去して返す。 */
export async function readAgentLogs(id: string): Promise<string> {
  const { stdout } = await run(CLAUDE_BIN, ["logs", id], {
    maxBuffer: 8 * 1024 * 1024,
  });

  return stripAnsi(stdout)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `claude stop <id>` でバックグラウンドセッションを停止する（会話は保持される）。 */
export async function stopAgent(id: string): Promise<void> {
  await run(CLAUDE_BIN, ["stop", id], { maxBuffer: 1024 * 1024 });
}

/**
 * そのセッションの作業ディレクトリでの `git diff` を取得する。
 * git管理下でない場合や差分が無い場合は空文字を返す。
 */
export async function readAgentDiff(id: string): Promise<string> {
  const agents = await listAgents();
  const agent = agents.find((a) => a.id === id);
  if (!agent) throw new Error(`agent not found: ${id}`);

  try {
    const { stdout } = await run("git", ["-C", agent.cwd, "diff", "--unified=3"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    // gitリポジトリでない場合など。差分なしとして扱う。
    return "";
  }
}
