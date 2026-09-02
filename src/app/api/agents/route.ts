import { NextResponse } from "next/server";
import { listAgents } from "@/lib/agents-cli";
import { drainQueue } from "@/lib/dispatch";

// `claude agents --json` をラップして、サブエージェントをレーン一覧として返す。
// 窓口CLIからの指示は `/api/dispatch` が受け取る。

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const agents = await listAgents();

    // 順番待ちの指示をここで送る。専用のタイマーを持たずに済む。
    // 送信に失敗しても一覧の取得は成功として返す。
    await drainQueue().catch(() => {});

    return NextResponse.json({ agents });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "claude_cli_failed", message }, { status: 500 });
  }
}
