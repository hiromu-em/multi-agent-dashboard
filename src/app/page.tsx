"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import LaneCard from "@/components/LaneCard";
import { type Lane, makePool, nowLabel, STATUS_META } from "@/lib/dashboard-data";

const LANE_COUNT_OPTIONS = [3, 4, 5, 8];

export default function DashboardPage() {
  const [laneCount, setLaneCountState] = useState(4);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [lanes, setLanes] = useState<Lane[]>(() => makePool());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // CLI(窓口セッション)側ですでに走っている作業を模して、
  // 「実行中」で始まるレーンはそれぞれ時間差で自動的に完了させる。
  useEffect(() => {
    const initial = lanes;
    initial.forEach((l) => {
      if (l.status === "running") {
        const delay = 1800 + Math.random() * 3200;
        const t = setTimeout(() => completeLane(l.id), delay);
        timers.current.push(t);
      }
    });
    return () => {
      timers.current.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function completeLane(id: string) {
    setLanes((prev) =>
      prev.map((l) =>
        l.id === id && l.status === "running"
          ? {
              ...l,
              status: "done",
              hasNotification: true,
              logs: [
                ...l.logs,
                { kind: "agent", text: `${l.name}の対応が完了しました。差分をご確認ください。`, time: nowLabel() },
              ],
            }
          : l,
      ),
    );
  }

  function toggleDiff(id: string) {
    setLanes((prev) => prev.map((l) => (l.id === id ? { ...l, diffOpen: !l.diffOpen } : l)));
  }

  function toggleFocus(id: string) {
    setFocusedId((prev) => (prev === id ? null : id));
    setLanes((prev) => prev.map((l) => (l.id === id ? { ...l, hasNotification: false } : l)));
  }

  function backToGrid() {
    setFocusedId(null);
  }

  function killLane(id: string) {
    setLanes((prev) =>
      prev.map((l) =>
        l.id === id
          ? {
              ...l,
              status: "killed",
              hasNotification: false,
              question: "",
              logs: [...l.logs, { kind: "system", text: "ユーザーによって停止されました", time: nowLabel() }],
            }
          : l,
      ),
    );
  }

  function retryLane(id: string) {
    setLanes((prev) =>
      prev.map((l) =>
        l.id === id
          ? {
              ...l,
              status: "running",
              hasNotification: false,
              logs: [...l.logs, { kind: "system", text: "再試行を開始します", time: nowLabel() }],
            }
          : l,
      ),
    );
    const t = setTimeout(() => completeLane(id), 1800 + Math.random() * 2000);
    timers.current.push(t);
  }

  function answer(id: string, replyText: string) {
    setLanes((prev) =>
      prev.map((l) =>
        l.id === id
          ? {
              ...l,
              status: "running",
              hasNotification: false,
              question: "",
              draftReply: "",
              logs: [...l.logs, { kind: "instruction", text: replyText, time: nowLabel() }],
            }
          : l,
      ),
    );
    const t = setTimeout(() => completeLane(id), 1500 + Math.random() * 1500);
    timers.current.push(t);
  }

  function setDraft(id: string, value: string) {
    setLanes((prev) => prev.map((l) => (l.id === id ? { ...l, draftReply: value } : l)));
  }

  function setLaneCount(n: number) {
    const idx = lanes.findIndex((l) => l.id === focusedId);
    if (idx !== -1 && idx >= n) setFocusedId(null);
    setLaneCountState(n);
  }

  const visibleLanes = useMemo(() => lanes.slice(0, laneCount), [lanes, laneCount]);
  const focused = focusedId ? (lanes.find((l) => l.id === focusedId) ?? null) : null;
  const isFocusMode = !!focused;
  const displayLanes = isFocusMode ? [focused!] : visibleLanes;

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[#0a0b0d] text-[#e6e8eb]">
      <header className="flex shrink-0 items-center justify-between border-b border-[#1d2024] bg-[#111317] px-7 py-4">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-[#e6e8eb]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f2874a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="7" height="7" rx="1.5" />
              <rect x="14" y="4" width="7" height="7" rx="1.5" />
              <rect x="3" y="15" width="7" height="5" rx="1.5" />
              <rect x="14" y="15" width="7" height="5" rx="1.5" />
            </svg>
            Multi-Agent Dashboard
          </div>
          <div className="font-mono text-[11.5px] text-[#8a8f98]">窓口セッション: claude code · orchestrator</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="mr-0.5 text-[11px] text-[#6f7580]">レーン数</span>
          {LANE_COUNT_OPTIONS.map((n) => {
            const active = n === laneCount;
            return (
              <button
                key={n}
                type="button"
                onClick={() => setLaneCount(n)}
                className="rounded-md border px-3.5 py-1.5 font-mono text-xs font-semibold cursor-pointer"
                style={{
                  borderColor: active ? "#f2874a" : "#23262b",
                  background: active ? "rgba(242,135,74,0.14)" : "transparent",
                  color: active ? "#f2874a" : "#8a8f98",
                }}
              >
                {n}
              </button>
            );
          })}
        </div>
      </header>

      {isFocusMode && (
        <div className="flex shrink-0 items-center gap-2 px-7 pt-3">
          <button
            type="button"
            onClick={backToGrid}
            className="flex items-center gap-1.5 rounded-md border border-[#23262b] px-3 py-1.5 text-xs text-[#aeb2b8] cursor-pointer"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#aeb2b8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            一覧に戻る
          </button>
          {visibleLanes.map((l) => {
            const active = l.id === focusedId;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => toggleFocus(l.id)}
                className="flex items-center rounded-md border px-3 py-1.5 font-mono text-xs font-semibold cursor-pointer"
                style={{
                  borderColor: active ? "#f2874a" : "#23262b",
                  background: active ? "rgba(242,135,74,0.12)" : "transparent",
                  color: active ? "#f2874a" : "#aeb2b8",
                }}
              >
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: STATUS_META[l.status].dot }}
                />
                {l.tag}
              </button>
            );
          })}
        </div>
      )}

      <div
        className="dc-scroll flex flex-1 flex-row items-stretch gap-4 px-7 pb-6 pt-4.5"
        style={{ minHeight: 0, overflowX: "auto", overflowY: "hidden", justifyContent: isFocusMode ? "center" : "flex-start" }}
      >
        {displayLanes.map((lane) => (
          <LaneCard
            key={lane.id}
            lane={lane}
            isFocused={isFocusMode}
            onToggleDiff={toggleDiff}
            onToggleFocus={toggleFocus}
            onKill={killLane}
            onRetry={retryLane}
            onYes={(id) => answer(id, "はい、進めてください")}
            onNo={(id) => answer(id, "いいえ、別案でお願いします")}
            onDraftChange={setDraft}
            onSendDraft={(id) => {
              const current = lanes.find((l) => l.id === id);
              if (current?.draftReply.trim()) answer(id, current.draftReply.trim());
            }}
          />
        ))}
      </div>
    </div>
  );
}
