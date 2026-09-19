import { NextResponse, type NextRequest } from "next/server";
import { confirmSend, rejectSend } from "@/lib/dispatch";

// 宛先を切り替えた直後、`#`無しの最初の1通に対する「このまま送りますか？」に、
// 盤面から答える口。入力欄で `#B` とタグだけ打つのと同じ保留を消化する
// （src/lib/dispatch.ts）。存在しない宛先の「作りますか？」（pending/route.ts）とは
// 別の保留なので、エンドポイントも分けてある。

export const dynamic = "force-dynamic";

const TAG_PATTERN = /^#([A-Za-z]|\d{1,3})$/;

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const tag = typeof json?.tag === "string" ? json.tag : "";
    const action = json?.action === "reject" ? "reject" : "send";

    if (!TAG_PATTERN.test(tag)) {
      return NextResponse.json({ error: "invalid_tag" }, { status: 400 });
    }

    if (action === "reject") {
      const dropped = rejectSend(tag);
      return NextResponse.json({
        message: dropped ? `${tag} への送信を取り消しました。` : `${tag} の送信確認はありません。`,
      });
    }

    const result = await confirmSend(tag);
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: 400 });
    return NextResponse.json({ message: result.message });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
