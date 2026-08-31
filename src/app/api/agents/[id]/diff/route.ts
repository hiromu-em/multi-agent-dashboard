import { NextResponse, type NextRequest } from "next/server";
import { readAgentDiff } from "@/lib/agents-cli";

// そのセッションの作業ディレクトリでの `git diff` を返す。

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const diff = await readAgentDiff(id);
    return NextResponse.json({ id, diff });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "diff_failed", message }, { status: 500 });
  }
}
