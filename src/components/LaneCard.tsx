"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { STATUS_META, type LaneStatus } from "@/lib/dashboard-data";
import type { TranscriptEntry } from "@/lib/transcript";
import { convertBulletMarkers, parseInlineMarkdown, splitMarkdownBlocks } from "@/lib/markdown";
import { extractOptions } from "@/lib/reply-options";

// 「最下部にいる」と判定する余白(px)。これより下端に近ければ追従を続ける。
const TAIL_THRESHOLD = 48;

export interface LaneView {
  id: string;
  sessionId: string;
  tag: string;
  name: string;
  cwd: string;
  status: LaneStatus;
  isAlive: boolean;
  entries: TranscriptEntry[];
  entriesLoaded: boolean;
  diffOpen: boolean;
  diff: string;
  diffLoading: boolean;
  hasNotification: boolean;
  /** 窓口CLIで `#` を省いた入力が飛ぶ先か。 */
  isTarget: boolean;
}

interface LaneCardProps {
  lane: LaneView;
  isFocused: boolean;
  onToggleDiff: (id: string) => void;
  onToggleFocus: (id: string) => void;
  onKill: (id: string) => void;
  /** 終わったレーンを盤面から片付ける。セッションは止めない。 */
  onDismiss: (id: string) => void;
  /** レーンへの返信。成功可否とメッセージを返す。 */
  onReply: (id: string, body: string) => Promise<{ ok: boolean; message: string }>;
}

function diffLineStyle(line: string): CSSProperties {
  const isMeta = line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("@@");
  const isAdd = !isMeta && line.startsWith("+");
  const isDel = !isMeta && line.startsWith("-");
  return {
    color: isAdd ? "#4ade80" : isDel ? "#f87171" : isMeta ? "#9aa0a8" : "#8a8f98",
    background: isAdd
      ? "rgba(74,222,128,0.08)"
      : isDel
        ? "rgba(248,113,113,0.08)"
        : "transparent",
    padding: "1.5px 14px",
    whiteSpace: "pre",
    fontWeight: isMeta ? 600 : 400,
  };
}

// インラインMarkdown（**太字** `コード` *斜体*）だけをReact要素に変換する。
// 生のHTMLタグは対象外（テキストとしてそのまま出す）。src/lib/markdown.ts 参照。
function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInlineMarkdown(convertBulletMarkers(text)).map((token, i) => {
        switch (token.kind) {
          case "bold":
            return (
              <strong key={i} className="font-semibold text-inherit">
                {token.value}
              </strong>
            );
          case "italic":
            return (
              <em key={i} className="italic">
                {token.value}
              </em>
            );
          case "code":
            return (
              <code
                key={i}
                className="rounded px-1 py-0.5 font-mono text-[0.9em]"
                style={{ background: "rgba(196,181,253,0.16)", color: "#c4b5fd" }}
              >
                {token.value}
              </code>
            );
          default:
            return <span key={i}>{token.value}</span>;
        }
      })}
    </>
  );
}

// `| a | b |` の表だけを実際の <table> にする。他は InlineText のまま。
// 横に長い表でボードの幅を超えても、ボード自体は横スクロールさせない
// （AGENTS.mdの固定サイズの決定）ので、表だけ自前でスクロールさせる。
function MarkdownTable({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <div className="my-1 overflow-x-auto" style={{ whiteSpace: "normal" }}>
      <table className="border-collapse text-[0.92em]">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="border px-2 py-1 text-left font-semibold"
                style={{ borderColor: "rgba(255,255,255,0.14)" }}
              >
                <InlineText text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="border px-2 py-1 align-top"
                  style={{ borderColor: "rgba(255,255,255,0.14)" }}
                >
                  <InlineText text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// `#`〜`######` を見出しとして太字・やや大きめに出す。チャット欄の中なので
// レベルの差は控えめ（h1/h2だけ少し大きく、h3以降は太さだけで区別する）。
function MarkdownHeading({ level, text }: { level: number; text: string }) {
  const size = level <= 1 ? "text-[1.12em]" : level === 2 ? "text-[1.05em]" : "text-[1em]";
  const Tag = (`h${Math.min(level, 6)}` as const) as
    | "h1"
    | "h2"
    | "h3"
    | "h4"
    | "h5"
    | "h6";
  return (
    <Tag className={`mt-1.5 mb-0.5 font-bold text-inherit first:mt-0 ${size}`}>
      <InlineText text={text} />
    </Tag>
  );
}

// テキストを表・見出し・地の文のブロックに割って、それぞれ別のReact要素に組み立てる。
function InlineMarkdown({ text }: { text: string }) {
  return (
    <>
      {splitMarkdownBlocks(text).map((block, i) => {
        switch (block.kind) {
          case "table":
            return <MarkdownTable key={i} header={block.header} rows={block.rows} />;
          case "heading":
            return <MarkdownHeading key={i} level={block.level} text={block.text} />;
          default:
            return <InlineText key={i} text={block.value} />;
        }
      })}
    </>
  );
}

// 会話1件の表示。窓口の指示・エージェントの発言・ツール実行・エラーを見分けられるようにする。
function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === "tool") {
    return (
      <div className="flex items-baseline gap-2 py-0.5 text-[#6f7580]">
        <span className="shrink-0 text-[#4b5058]">▸</span>
        <span className="shrink-0 font-semibold text-[#7f8590]">{entry.tool}</span>
        <span className="truncate">{entry.text}</span>
      </div>
    );
  }

  const isUser = entry.role === "user";
  const isError = entry.role === "error";

  // `claude logs` から補ったライブの質問（api/agents/[id]/logs/route.ts の
  // `${id}-live-question`）だけは、質問文だけを吹き出しに出し選択肢の列挙を省く。
  // 選択肢はこのすぐ下の返信欄がボタン化するので（extractOptions は entry.text を
  // そのまま見るので影響しない）、同じ一覧をここでも書くと二重になる。
  const isLiveQuestion = entry.key.endsWith("-live-question");
  const displayText = isLiveQuestion ? (entry.text.split("\n")[0] ?? entry.text) : entry.text;

  return (
    <div className={`flex flex-col py-1.5 ${isUser ? "items-end" : "items-start"}`}>
      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-[#5c6067]">
        <span style={{ color: isUser ? "#f2874a" : isError ? "#f87171" : "#8a8f98" }}>
          {isUser ? "窓口 →" : isError ? "ERROR" : "エージェント"}
        </span>
        {entry.time && <span>{entry.time}</span>}
      </div>
      <div
        className="max-w-[92%] rounded-lg px-2.5 py-1.5"
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: isError ? "#fca5a5" : isUser ? "#f4d3bd" : "#c9cdd3",
          background: isError
            ? "rgba(248,113,113,0.08)"
            : isUser
              ? "rgba(242,135,74,0.10)"
              : "rgba(255,255,255,0.03)",
          border: `1px solid ${
            isError ? "rgba(248,113,113,0.25)" : isUser ? "rgba(242,135,74,0.25)" : "transparent"
          }`,
        }}
      >
        <InlineMarkdown text={displayText} />
      </div>
    </div>
  );
}

/**
 * 手の空いたレーンへの返信欄。表示時にスライドイン・フェードインする。
 *
 * ダッシュボードに指示入力欄は置かない設計の唯一の例外。宛先は既にこのレーンに
 * 固定されているので `#B` のようなタグ指定は要らない。新しい指示を好きな宛先に
 * 送る用途にはならない（それは引き続き窓口のCLI経由）。
 *
 * 当初は「対話待ち（CLIの `blocked`）のときだけ出す」形にしていたが、質問を返して
 * ターンを終えたセッションをCLIは数秒で `done` として返すため、返信欄が出ても
 * すぐ消えて選べなかった。実行中以外のすべてのレーンに出す。
 */
function ReplyBox({
  id,
  tag,
  laneStatus,
  question,
  onReply,
}: {
  id: string;
  tag: string;
  laneStatus: LaneStatus;
  question: string;
  onReply: (id: string, body: string) => Promise<{ ok: boolean; message: string }>;
}) {
  // 対話待ちのレーンだけ琥珀色にする。手が空いているだけのレーンまで同じ色にすると、
  // 本当に返事を待っているレーンが盤面に埋もれる。
  const urgent = laneStatus === "waiting";
  const [mounted, setMounted] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // 選択肢のボタン化は対話待ち（本当に質問されている）ときだけ。
  // 完了・エラーのレーンは最後の発言が普通の報告文であることが多く、その中の
  // Markdown箇条書き（`- 項目`）まで選択肢として拾ってしまうと、答え終わった
  // 完了報告が「まだ選べる質問」に見えてしまう。
  const options = useMemo(() => (urgent ? extractOptions(question) : []), [question, urgent]);

  async function send(body: string) {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setStatus(null);
    const result = await onReply(id, trimmed);
    setSending(false);
    setStatus(result.ok ? "送信しました" : result.message);
    if (result.ok) setText("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(text);
    }
  }

  return (
    <div
      className="shrink-0 overflow-hidden border-t"
      style={{
        borderColor: urgent ? "#2a2410" : "#23262b",
        background: urgent ? "#171307" : "#111317",
        transition: "max-height 220ms ease, opacity 220ms ease, transform 220ms ease",
        maxHeight: mounted ? 280 : 0,
        opacity: mounted ? 1 : 0,
        transform: mounted ? "translateY(0)" : "translateY(6px)",
      }}
    >
      <div className="px-3.5 py-2.5">
        <div className="mb-1.5 text-[11px]" style={{ color: urgent ? "#fde68a" : "#8a8f98" }}>
          {urgent ? `${tag} が返事を待っています` : `${tag} へ返信する`}
        </div>

        {options.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {options.map((opt) => (
              <button
                key={opt.label}
                type="button"
                disabled={sending}
                onClick={() => send(opt.text)}
                className="cursor-pointer rounded-md border px-2.5 py-1 text-left text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  borderColor: urgent ? "#4a3f14" : "#3a3d44",
                  background: urgent ? "rgba(251,191,36,0.10)" : "rgba(255,255,255,0.04)",
                  color: urgent ? "#fbbf24" : "#c3c7ce",
                }}
              >
                {opt.label}. {opt.text.length > 32 ? `${opt.text.slice(0, 32)}…` : opt.text}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={1}
            placeholder={
              urgent
                ? "返事を入力（Enterで送信 / Shift+Enterで改行）"
                : "返信を入力（Enterで送信 / Shift+Enterで改行）"
            }
            className="min-h-[34px] flex-1 resize-none rounded-md border bg-[#0d0f12] px-2.5 py-1.5 text-[12px] text-[#e6e8eb] outline-none placeholder:text-[#5c6067]"
            style={{ borderColor: urgent ? "#3a3220" : "#2a2d33" }}
          />
          <button
            type="button"
            disabled={sending || !text.trim()}
            onClick={() => send(text)}
            className="flex h-[34px] shrink-0 cursor-pointer items-center justify-center rounded-md border px-3 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              borderColor: urgent ? "#4a3f14" : "#3a3d44",
              background: urgent ? "rgba(251,191,36,0.14)" : "rgba(255,255,255,0.06)",
              color: urgent ? "#fbbf24" : "#e6e8eb",
            }}
          >
            送信
          </button>
        </div>

        {status && <div className="mt-1.5 text-[10.5px] text-[#8a8f98]">{status}</div>}
      </div>
    </div>
  );
}

export default function LaneCard({
  lane,
  isFocused,
  onToggleDiff,
  onToggleFocus,
  onKill,
  onDismiss,
  onReply,
}: LaneCardProps) {
  const meta = STATUS_META[lane.status];
  // 実行中のレーンへ送ると `stop` が走って作業が中断されるので、そこだけ出さない。
  const canReply = lane.status !== "running";
  // 終わったレーンだけ片付けられる。実行中・対話待ちは自分では消せない。
  const canDismiss = lane.status === "done" || lane.status === "killed" || lane.status === "error";
  const isKilled = lane.status === "killed";
  const isError = lane.status === "error";
  const diffLines = lane.diff ? lane.diff.split("\n") : [];

  const logRef = useRef<HTMLDivElement>(null);
  // 最新に追従するか。自分で上にスクロールしている間は止める。
  const [followTail, setFollowTail] = useState(true);

  // 毎回のポーリングで新しい配列が来るので、中身が増えたときだけ追従させる。
  const lastKey = lane.entries.at(-1)?.key ?? "";

  useEffect(() => {
    if (!followTail) return;
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lastKey, lane.entries.length, followTail, isFocused, lane.diffOpen]);

  function handleLogScroll() {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_THRESHOLD;
    setFollowTail(atBottom);
  }

  function jumpToTail() {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowTail(true);
  }

  const cardStyle: CSSProperties = {
    width: isFocused ? 980 : 720,
    minWidth: isFocused ? 980 : 720,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: "#15171b",
    borderRadius: 10,
    // 宛先のレーンは常に分かるようにする。誤爆はここを見落とすことで起きる。
    border: `1px solid ${lane.isTarget ? "#f2874a" : lane.hasNotification ? meta.border : "#23262b"}`,
    boxShadow: lane.isTarget
      ? "0 0 0 1px #f2874a"
      : lane.hasNotification
        ? `0 0 0 1px ${meta.border}`
        : "none",
    opacity: isKilled ? 0.62 : 1,
    overflow: "hidden",
    transition: "box-shadow .2s ease, opacity .2s ease",
  };

  return (
    <div style={cardStyle}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#1f2226] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-bold text-[#f2874a]">{lane.tag}</span>
          {lane.isTarget && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[9.5px] font-semibold"
              style={{ color: "#f2874a", background: "rgba(242,135,74,0.14)" }}
              title="窓口CLIで # を省いた入力はこのレーンへ送られます"
            >
              宛先
            </span>
          )}
          <span className="truncate text-[13px] font-semibold text-[#e6e8eb]">{lane.name}</span>
          {lane.hasNotification && (
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: meta.dot, animation: "dc-pulse 1.6s ease-in-out infinite" }}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            style={{ color: meta.text, background: meta.bg, border: `1px solid ${meta.border}` }}
          >
            {meta.label}
          </span>
          <button
            type="button"
            title="Git Diff"
            onClick={() => onToggleDiff(lane.id)}
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md border border-[#23262b]"
            style={{
              background: lane.diffOpen ? "rgba(242,135,74,0.12)" : "transparent",
              color: lane.diffOpen ? "#f2874a" : "#8a8f98",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
          <button
            type="button"
            title={isFocused ? "縮小" : "拡大"}
            onClick={() => onToggleFocus(lane.id)}
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md border border-[#23262b] text-[#8a8f98]"
          >
            {isFocused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
          {canDismiss && (
            <button
              type="button"
              title="盤面から片付ける（セッションは残る）"
              onClick={() => onDismiss(lane.id)}
              className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md border border-[#23262b] text-[#8a8f98]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
          <button
            type="button"
            title="停止 (claude stop)"
            disabled={!lane.isAlive}
            onClick={() => onKill(lane.id)}
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md border border-[#3a1f1f] text-[#f87171] disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: "rgba(248,113,113,0.08)" }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="14" height="14" rx="1.5" />
            </svg>
          </button>
        </div>
      </div>

      <div className="shrink-0 truncate border-b border-[#1f2226] bg-[#101215] px-3.5 py-1.5 font-mono text-[10.5px] text-[#5c6067]">
        {lane.cwd}
      </div>

      {lane.diffOpen && (
        <div
          className="dc-scroll shrink-0 border-b border-[#1f2226] bg-[#0d0f12] py-2 font-mono text-[11px]"
          style={{ maxHeight: 200, overflow: "auto" }}
        >
          {lane.diffLoading ? (
            <div className="px-3.5 py-1.5 text-[#5c6067]">差分を取得中…</div>
          ) : diffLines.length > 0 ? (
            diffLines.map((line, i) => (
              <div key={i} style={diffLineStyle(line)}>
                {line || " "}
              </div>
            ))
          ) : (
            <div className="px-3.5 py-1.5 text-[#5c6067]">変更はありません</div>
          )}
        </div>
      )}

      <div className="relative flex flex-1" style={{ minHeight: 0 }}>
        <div
          ref={logRef}
          onScroll={handleLogScroll}
          className="dc-scroll flex-1 p-3.5 font-mono"
          style={{ minHeight: 0, overflowY: "auto", fontSize: isFocused ? 14.5 : 14 }}
        >
          {lane.entries.length > 0 ? (
            lane.entries.map((entry) => <TranscriptRow key={entry.key} entry={entry} />)
          ) : (
            <div className="text-[#5c6067]">
              {lane.entriesLoaded ? "まだやり取りがありません" : "会話を読み込み中…"}
            </div>
          )}
        </div>

        {!followTail && (
          <button
            type="button"
            onClick={jumpToTail}
            className="absolute bottom-3 right-4 flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold shadow-lg"
            style={{ borderColor: "#3a3d44", background: "#1f2228", color: "#e6e8eb" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <polyline points="19 12 12 19 5 12" />
            </svg>
            最新へ
          </button>
        )}
      </div>

      {canReply && (
        <ReplyBox
          id={lane.id}
          tag={lane.tag}
          laneStatus={lane.status}
          question={[...lane.entries].reverse().find((e) => e.role === "agent")?.text ?? ""}
          onReply={onReply}
        />
      )}

      {isError && (
        <div
          className="shrink-0 border-t px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[#fca5a5]"
          style={{ borderColor: "#3a1f1f", background: "#170c0c" }}
        >
          このセッションは作業を完了できずに終了しました。
          <span className="font-mono"> claude attach {lane.id} </span>
          で開くと経緯を確認して再開できます。
        </div>
      )}

      {isKilled && (
        <div className="shrink-0 border-t border-dashed border-[#2a2d33] px-3.5 py-2 text-center text-[11px] text-[#6b7280]">
          このセッションは終了しています（claude attach {lane.id} で再開できます）
        </div>
      )}
    </div>
  );
}
