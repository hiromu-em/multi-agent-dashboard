import { NextResponse, type NextRequest } from "next/server";
import { readTranscript } from "@/lib/transcript";

// セッションの会話（~/.claude/projects/**/<sessionId>.jsonl）を読んで返す。
// `claude logs` の端末描画ではなく構造化された会話なので、CLIも起動しない。
//
// sessionId はクライアントが持っているので `?session=` で受け取る。
// 無い場合は短いID（sessionIdの先頭8桁）の前方一致で探す。

export const dynamic = "force-dynamic";

const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const session = req.nextUrl.searchParams.get("session");
  if (session && !SESSION_ID_PATTERN.test(session)) {
    return NextResponse.json({ error: "invalid_session" }, { status: 400 });
  }

  try {
    const entries = await readTranscript(id, session ?? undefined);
    return NextResponse.json({ id, entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "transcript_failed", message }, { status: 500 });
  }
}
