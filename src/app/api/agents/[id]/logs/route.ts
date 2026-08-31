import { NextResponse, type NextRequest } from "next/server";
import { readAgentLogs } from "@/lib/agents-cli";

// `claude logs <id>` の出力（ANSI除去済み）を返す。
// 方式Aではダッシュボード側がこれをポーリングして各レーンに表示する。

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // CLIに渡す前に、想定しているID形式（英数字）以外を弾く。
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const output = await readAgentLogs(id);
    return NextResponse.json({ id, output });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "claude_cli_failed", message }, { status: 500 });
  }
}
