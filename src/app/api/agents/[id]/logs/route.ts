import { NextResponse, type NextRequest } from "next/server";
import { readTranscript } from "@/lib/transcript";
import { listAgents } from "@/lib/agents-cli";
import { readLiveQuestion } from "@/lib/live-question";

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

    // 対話待ち（AskUserQuestionが保留中）の間は、その質問自体がJSONLにまだ
    // 現れないことがある（回答されて初めて記録される）。その間だけ、例外的に
    // `claude logs` から今の質問を補って末尾に足す（src/lib/live-question.ts）。
    const lanes = await listAgents();
    if (lanes.find((a) => a.id === id)?.status === "waiting") {
      const liveQuestion = await readLiveQuestion(id);
      if (liveQuestion) {
        entries.push({ key: `${id}-live-question`, role: "agent", time: "", text: liveQuestion });
      }
    }

    return NextResponse.json({ id, entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "transcript_failed", message }, { status: 500 });
  }
}
