import { NextResponse, type NextRequest } from "next/server";
import { currentTarget, queuedCount, resolveAddressee, routePrompt } from "@/lib/dispatch";
import { logDispatch, readDispatchLog, recentProblems } from "@/lib/dispatch-log";

// 窓口CLIの `UserPromptSubmit` フックから叩かれる。
// フックは中身を判断せず、入力をそのまま渡して結果を受け取るだけの薄い管。
// 振り分けの規則はすべてここ（サーバー側）に置く。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let prompt = "";
  try {
    const body = await req.json();
    prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return NextResponse.json({ block: false, message: "" });

    const sessionId = typeof body?.session_id === "string" ? body.session_id : undefined;

    return NextResponse.json(await routePrompt(prompt, sessionId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // `routePrompt` は最初に `listAgents()`（`claude agents --json --all`）を呼ぶ。
    // そこが失敗すると、判断できないからと block: false を返して素通しにしていた。
    // だが宛先付きの入力（`#B ...` や、宛先が設定されている状態の入力）まで
    // 素通しすると、指示文がそのまま窓口のClaudeへの発言として実行されてしまう。
    // AGENTS.mdが言う「指示が黙って消える経路」の3つ目がこれ。
    // `resolveAddressee` は `listAgents()` を使わずに判定するので、この壊れている
    // 経路には依存しない。
    try {
      const addressee = await resolveAddressee(prompt);
      if (addressee) {
        await logDispatch({
          event: "failed",
          tag: addressee.tag,
          sessionId: addressee.sessionId,
          body: prompt,
          reason: message,
        });
        return NextResponse.json({ block: true, message: `配送に失敗しました: ${message}` });
      }
    } catch {
      // 判定自体が失敗したら、今まで通り素通しにする。
    }

    // 宛先の無い素の入力は横取りしない。窓口のCLIが使えなくなるほうが困る。
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
