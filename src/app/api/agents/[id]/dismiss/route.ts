import { NextResponse, type NextRequest } from "next/server";
import { dismissLane } from "@/lib/agents-cli";

// 終わったレーンを盤面から片付ける（セッションには触らない）。
// 終了から3時間で自動的に消していたのをやめた代わりの手段。
// 詳細は src/lib/lane-registry.ts の dismissSession 参照。

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const dismissed = await dismissLane(id);
    if (!dismissed) {
      return NextResponse.json(
        { error: "not_found", message: "セッションが見つかりません" },
        { status: 404 },
      );
    }

    return NextResponse.json({ id, dismissed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "dismiss_failed", message }, { status: 500 });
  }
}
