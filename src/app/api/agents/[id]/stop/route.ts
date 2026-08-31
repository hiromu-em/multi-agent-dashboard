import { NextResponse, type NextRequest } from "next/server";
import { stopAgent } from "@/lib/agents-cli";

// `claude stop <id>` でバックグラウンドセッションを停止する（Killボタン）。
// 会話自体は保持されるので、`claude attach <id>` で開き直せる。

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    await stopAgent(id);
    return NextResponse.json({ id, stopped: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "claude_cli_failed", message }, { status: 500 });
  }
}
