import { NextRequest } from "next/server";

// 指定したサブエージェント(id)の標準出力をSSEでダッシュボードに配信するエンドポイント（スタブ）。
//
// 実装予定:
// - 対応する child_process の stdout/stderr をリッスンし、
//   `data: {...}\n\n` 形式でクライアントにストリーミングする
// - プロセスが対話待ち(y/n等)を検知した場合は status イベントを送る
// - クライアント切断時はリスナーを解除する（プロセス自体は継続）

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        `data: ${JSON.stringify({ type: "system", text: `stream stub for agent ${id}` })}\n\n`,
      );
      // TODO: 実プロセスの stdout をここにパイプする
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
