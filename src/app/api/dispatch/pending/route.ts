import { NextResponse, type NextRequest } from "next/server";
import { confirmCreate, rejectCreate } from "@/lib/dispatch";

// 存在しない宛先を指されたときの「作りますか？」に、盤面から答える口。
// 入力欄で `#K` とタグだけ打つのと同じ保留を消化する（src/lib/dispatch.ts）。

export const dynamic = "force-dynamic";

const TAG_PATTERN = /^#([A-Za-z]|\d{1,3})$/;

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const tag = typeof json?.tag === "string" ? json.tag : "";
    const action = json?.action === "reject" ? "reject" : "create";

    if (!TAG_PATTERN.test(tag)) {
      return NextResponse.json({ error: "invalid_tag" }, { status: 400 });
    }

    if (action === "reject") {
      const dropped = rejectCreate(tag);
      return NextResponse.json({
        message: dropped ? `${tag} の作成を取り消しました。` : `${tag} の確認待ちはありません。`,
      });
    }

    const result = await confirmCreate(tag);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    return NextResponse.json({ message: result.message });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
