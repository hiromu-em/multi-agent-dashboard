import { NextResponse, type NextRequest } from "next/server";
import { replyFromBoard } from "@/lib/dispatch";

// ダッシュボードの対話待ちレーンから直接返信する（例外的にここだけ入力欄を持つ）。
// 詳細は src/lib/dispatch.ts の replyFromBoard 参照。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const json = await req.json();
    const body = typeof json?.body === "string" ? json.body : "";

    const result = await replyFromBoard(id, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

    return NextResponse.json({ message: result.message });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
