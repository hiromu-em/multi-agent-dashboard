import { NextResponse, type NextRequest } from "next/server";
import {
  currentTarget,
  pendingCreates,
  pendingSends,
  queuedCount,
  resolveAddressee,
  routePrompt,
} from "@/lib/dispatch";
import { logDispatch, readDispatchLog, recentProblems } from "@/lib/dispatch-log";

// ダッシュボードの指示入力欄から叩かれる。振り分けの規則はすべてここ（サーバー側）に置く。

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let prompt = "";
  try {
    const body = await req.json();
    prompt = typeof body?.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return NextResponse.json({ ok: false, message: "本文が空です。" });

    return NextResponse.json(await routePrompt(prompt));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // `routePrompt` は最初に `listAgents()`（`claude agents --json --all`）を呼ぶ。
    // そこが失敗すると宛先の判断自体ができない。`resolveAddressee` は
    // `listAgents()` を使わずに判定するので、この壊れている経路には依存しない。
    // 記録だけは残し、いずれにせよ失敗として返す。
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
      }
    } catch {
      // 判定自体も失敗。ログは諦める。
    }

    return NextResponse.json({ ok: false, message: `配送に失敗しました: ${message}` });
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
      pending: pendingCreates(),
      pendingSends: pendingSends(),
    });
  } catch {
    return NextResponse.json({ target: null, queued: 0, problems: [], pending: [], pendingSends: [] });
  }
}
