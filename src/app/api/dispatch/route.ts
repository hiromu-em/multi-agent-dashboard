import { NextResponse, type NextRequest } from "next/server";
import { currentTarget, queuedCount, routePrompt } from "@/lib/dispatch";
import { readDispatchLog, recentProblems } from "@/lib/dispatch-log";

// 窓口CLIの `UserPromptSubmit` フックから叩かれる。
// フックは中身を判断せず、入力をそのまま渡して結果を受け取るだけの薄い管。
// 振り分けの規則はすべてここ（サーバー側）に置く。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return NextResponse.json({ block: false, message: "" });

    const sessionId = typeof body?.session_id === "string" ? body.session_id : undefined;

    return NextResponse.json(await routePrompt(prompt, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 判断できないときは横取りしない。窓口のCLIが使えなくなるほうが困る。
    return NextResponse.json({ block: false, message, error: "dispatch_failed" });
  }
}

/**
 * 現在の宛先と、直近の取りこぼし。
 * `?log=1` を付けると配送の記録そのものを返す。
 */
export async function GET(req: NextRequest) {
  try {
    if (req.nextUrl.searchParams.get("log")) {
      return NextResponse.json({ records: await readDispatchLog(100) });
    }

    return NextResponse.json({
      target: await currentTarget(),
      queued: queuedCount(),
      problems: await recentProblems(),
    });
  } catch {
    return NextResponse.json({ target: null, queued: 0, problems: [] });
  }
}
