"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { STATUS_META, type LaneStatus } from "@/lib/dashboard-data";
import type { TranscriptEntry } from "@/lib/transcript";

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
}

interface LaneCardProps {
  lane: LaneView;
  isFocused: boolean;
  onToggleDiff: (id: string) => void;
  onToggleFocus: (id: string) => void;
  onKill: (id: string) => void;
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
        {entry.text}
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
}: LaneCardProps) {
  const meta = STATUS_META[lane.status];
  const isWaiting = lane.status === "waiting";
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
    border: `1px solid ${lane.hasNotification ? meta.border : "#23262b"}`,
    boxShadow: lane.hasNotification ? `0 0 0 1px ${meta.border}` : "none",
    opacity: isKilled ? 0.62 : 1,
    overflow: "hidden",
    transition: "box-shadow .2s ease, opacity .2s ease",
  };

  return (
    <div style={cardStyle}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#1f2226] px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-bold text-[#f2874a]">{lane.tag}</span>
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
            <div className="px-3.5 py-1.5 text-[#5c6067]">未コミットの変更はありません</div>
          )}
        </div>
      )}

      <div className="relative flex flex-1" style={{ minHeight: 0 }}>
        <div
          ref={logRef}
          onScroll={handleLogScroll}
          className="dc-scroll flex-1 p-3.5 font-mono"
          style={{ minHeight: 0, overflowY: "auto", fontSize: isFocused ? 12.5 : 12 }}
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

      {isWaiting && (
        <div
          className="shrink-0 border-t px-3.5 py-2.5 text-[11.5px] leading-relaxed text-[#fde68a]"
          style={{ borderColor: "#2a2410", background: "#171307" }}
        >
          このセッションは入力待ちです。返信の送信はまだ未実装のため、
          <span className="font-mono"> claude attach {lane.id} </span>
          で開いて応答してください。
        </div>
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
