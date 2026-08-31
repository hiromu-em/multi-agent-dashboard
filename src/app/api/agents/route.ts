import { NextRequest, NextResponse } from "next/server";

// サブエージェントの一覧取得・新規起動・指示送信を担当するエンドポイント（スタブ）。
//
// 実装予定:
// - GET  : 現在アクティブなサブエージェント（レーン）の一覧をJSONで返す
// - POST : 窓口セッションからの指示を受け取り、
//          `#A ...` のようなプレフィックスでルーティング先を判定する。
//          - 既存セッション宛なら、そのプロセスのstdinに書き込む
//          - 新規プレフィックス宛なら、`git worktree add` で作業ディレクトリを切り、
//            `child_process.spawn` で `claude` CLIを起動する
//          複数行にまたがる一括指示（#A .../#B .../#C ...）にも対応する。

export async function GET() {
  return NextResponse.json({ agents: [] });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  return NextResponse.json(
    { error: "not_implemented", received: body },
    { status: 501 },
  );
}
