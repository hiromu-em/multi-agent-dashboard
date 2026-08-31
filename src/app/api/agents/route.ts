import { NextResponse } from "next/server";
import { listAgents } from "@/lib/agents-cli";

// `claude agents --json` をラップして、稼働中のサブエージェントをレーン一覧として返す。
//
// TODO(方式B): 窓口セッションからの指示を受け取るPOSTを追加する。
//   `#A ...` のプレフィックスでルーティング先を判定し、
//   新規なら `claude --bg -w <name>`、既存なら `--resume <sessionId>` で継続する。

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const agents = await listAgents();
    return NextResponse.json({ agents });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "claude_cli_failed", message }, { status: 500 });
  }
}
