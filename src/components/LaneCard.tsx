"use client";

import type { CSSProperties } from "react";
import type { DiffLine, Lane } from "@/lib/dashboard-data";
import { LOG_META, STATUS_META } from "@/lib/dashboard-data";

interface LaneCardProps {
  lane: Lane;
  isFocused: boolean;
  onToggleDiff: (id: string) => void;
  onToggleFocus: (id: string) => void;
  onKill: (id: string) => void;
  onRetry: (id: string) => void;
  onYes: (id: string) => void;
  onNo: (id: string) => void;
  onDraftChange: (id: string, value: string) => void;
  onSendDraft: (id: string) => void;
}

function diffLineStyle(line: DiffLine): CSSProperties {
  const isAdd = line.type === "add";
  const isDel = line.type === "del";
  const isFile = line.type === "file";
  const color = isAdd ? "#4ade80" : isDel ? "#f87171" : isFile ? "#9aa0a8" : "#8a8f98";
  const bg = isAdd ? "rgba(74,222,128,0.08)" : isDel ? "rgba(248,113,113,0.08)" : "transparent";
  return {
    color,
    background: bg,
    padding: "1.5px 14px",
    whiteSpace: "pre",
    fontWeight: isFile ? 600 : 400,
  };
}

function diffLinePrefix(line: DiffLine): string {
  if (line.type === "add") return "+ ";
  if (line.type === "del") return "- ";
  if (line.type === "file") return "";
  return "  ";
}

export default function LaneCard({
  lane,
  isFocused,
  onToggleDiff,
  onToggleFocus,
  onKill,
  onRetry,
  onYes,
  onNo,
  onDraftChange,
  onSendDraft,
}: LaneCardProps) {
  const meta = STATUS_META[lane.status];
  const isWaiting = lane.status === "waiting";
  const isError = lane.status === "error";
  const isKilled = lane.status === "killed";
  const hasDiff = lane.diffLines.length > 0;

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
    opacity: isKilled ? 0.55 : 1,
    overflow: "hidden",
    transition: "box-shadow .2s ease, opacity .2s ease",
  };

  return (
    <div style={cardStyle}>
      <div className="flex items-center justify-between gap-2 border-b border-[#1f2226] px-3.5 py-2.5 shrink-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-bold text-[#f2874a]">{lane.tag}</span>
          <span className="truncate text-[13px] font-semibold text-[#e6e8eb]">{lane.name}</span>
          {lane.hasNotification && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
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
            className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-[#23262b] cursor-pointer"
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
            className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-[#23262b] text-[#8a8f98] cursor-pointer"
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
            title="緊急停止"
            disabled={isKilled}
            onClick={() => onKill(lane.id)}
            className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-[#3a1f1f] text-[#f87171] cursor-pointer disabled:cursor-not-allowed disabled:opacity-35"
            style={{ background: "rgba(248,113,113,0.08)" }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="5" width="14" height="14" rx="1.5" />
            </svg>
          </button>
        </div>
      </div>

      {lane.diffOpen && (
        <div className="dc-scroll shrink-0 border-b border-[#1f2226] bg-[#0d0f12] py-2 font-mono text-[11px]" style={{ maxHeight: 170, overflow: "auto" }}>
          {hasDiff ? (
            lane.diffLines.map((line, i) => (
              <div key={i} style={diffLineStyle(line)}>
                {diffLinePrefix(line)}
                {line.code}
              </div>
            ))
          ) : (
            <div className="px-3.5 py-1.5 text-[#5c6067]">変更ファイルはまだありません</div>
          )}
        </div>
      )}

      <div className="dc-scroll flex flex-1 flex-col p-3.5" style={{ minHeight: 0, overflowY: "auto", fontSize: isFocused ? 14.5 : 13.5 }}>
        {lane.logs.map((entry, i) => {
          const m = LOG_META[entry.kind];
          const isSystem = entry.kind === "system";
          const isErr = entry.kind === "error";
          const isWarn = entry.kind === "warning";
          const isInstr = entry.kind === "instruction";
          const bg = isErr
            ? "rgba(248,113,113,0.1)"
            : isWarn
              ? "rgba(251,191,36,0.1)"
              : isInstr
                ? "rgba(242,135,74,0.1)"
                : "rgba(255,255,255,0.035)";
          const borderColor = isErr ? "#f87171" : isWarn ? "#fbbf24" : isInstr ? "#f2874a" : "transparent";
          return (
            <div
              key={i}
              className="mb-2.5 flex flex-col gap-0.5"
              style={{ alignSelf: m.align === "right" ? "flex-end" : m.align === "center" ? "center" : "flex-start", maxWidth: isSystem ? "100%" : "88%" }}
            >
              <div className="font-mono text-[10px] tracking-wide" style={{ color: m.color, textAlign: isSystem ? "center" : m.align }}>
                {m.label} {entry.time}
              </div>
              <div
                className="leading-relaxed"
                style={{
                  background: bg,
                  borderLeft: borderColor === "transparent" ? "none" : `3px solid ${borderColor}`,
                  padding: isSystem ? "1px 0" : "8px 11px",
                  borderRadius: isSystem ? 0 : 8,
                  color: isErr ? "#fca5a5" : isWarn ? "#fde68a" : "#dfe2e6",
                  wordBreak: "break-word",
                }}
              >
                {entry.text}
              </div>
            </div>
          );
        })}
        {isError && (
          <button
            type="button"
            onClick={() => onRetry(lane.id)}
            className="mt-0.5 self-start rounded-md border border-[#4f1f1f] px-3 py-1.5 text-xs font-semibold text-[#f87171] cursor-pointer"
            style={{ background: "rgba(248,113,113,0.12)" }}
          >
            再試行する
          </button>
        )}
      </div>

      {isWaiting && (
        <div className="flex shrink-0 flex-col gap-2 border-t px-3.5 py-3" style={{ borderColor: "#2a2410", background: "#171307" }}>
          <div className="text-xs leading-relaxed text-[#fde68a]">{lane.question}</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onYes(lane.id)}
              className="flex-1 rounded-md border border-[#1f4f39] py-1.5 text-xs font-semibold text-[#4ade80] cursor-pointer"
              style={{ background: "rgba(74,222,128,0.14)" }}
            >
              はい
            </button>
            <button
              type="button"
              onClick={() => onNo(lane.id)}
              className="flex-1 rounded-md border border-[#4f1f1f] py-1.5 text-xs font-semibold text-[#f87171] cursor-pointer"
              style={{ background: "rgba(248,113,113,0.1)" }}
            >
              いいえ
            </button>
          </div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={lane.draftReply}
              onChange={(e) => onDraftChange(lane.id, e.target.value)}
              placeholder="自由入力で返信..."
              className="flex-1 rounded-md border px-2.5 py-1.5 text-xs text-[#e6e8eb] outline-none"
              style={{ background: "#0d0f12", borderColor: "#2a2410" }}
            />
            <button
              type="button"
              disabled={!lane.draftReply.trim()}
              onClick={() => onSendDraft(lane.id)}
              className="rounded-md border-none px-3.5 text-xs font-bold text-[#1a0f08] cursor-pointer disabled:cursor-not-allowed disabled:opacity-35"
              style={{ background: "#f2874a" }}
            >
              送信
            </button>
          </div>
        </div>
      )}

      {isKilled && (
        <div className="shrink-0 border-t border-dashed border-[#2a2d33] px-3.5 py-2 text-center text-[11px] text-[#6b7280]">
          このレーンは停止されました
        </div>
      )}
    </div>
  );
}
