"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LaneCard, { type LaneView } from "@/components/LaneCard";
import { STATUS_META, type LaneStatus } from "@/lib/dashboard-data";

const LANE_COUNT_OPTIONS = [3, 4, 5, 8];
const AGENTS_POLL_MS = 4000;
const LOGS_POLL_MS = 5000;

interface ApiAgent {
  id: string;
  sessionId: string;
  tag: string;
  name: string;
  cwd: string;
  status: LaneStatus;
  startedAt: number;
  isAlive: boolean;
}

export default function DashboardPage() {
  const [laneCount, setLaneCountState] = useState(4);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [outputLoading, setOutputLoading] = useState<Record<string, boolean>>({});
  const [diffOpen, setDiffOpen] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState<Record<string, boolean>>({});
  const [seen, setSeen] = useState<Record<string, LaneStatus>>({});

  // 直前のステータスを覚えておき、変化したレーンに通知を出す。
  const prevStatus = useRef<Record<string, LaneStatus>>({});

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message ?? json?.error ?? "取得に失敗しました");
      setAgents(json.agents ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setInitialLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    const timer = setInterval(fetchAgents, AGENTS_POLL_MS);
    return () => clearInterval(timer);
  }, [fetchAgents]);

  const visibleAgents = useMemo(() => agents.slice(0, laneCount), [agents, laneCount]);
  const focusedAgent = focusedId ? (agents.find((a) => a.id === focusedId) ?? null) : null;
  const isFocusMode = !!focusedAgent;
  const displayAgents = isFocusMode ? [focusedAgent!] : visibleAgents;

  // 表示中のレーンのログだけを取りに行く（CLI呼び出しを抑えるため）。
  const displayIds = useMemo(() => displayAgents.map((a) => a.id).join(","), [displayAgents]);

  useEffect(() => {
    if (!displayIds) return;
    const ids = displayIds.split(",");
    let cancelled = false;

    const loadLogs = async () => {
      await Promise.all(
        ids.map(async (id) => {
          setOutputLoading((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
          try {
            const res = await fetch(`/api/agents/${id}/logs`, { cache: "no-store" });
            const json = await res.json();
            if (!cancelled && res.ok) {
              setOutputs((prev) => ({ ...prev, [id]: json.output ?? "" }));
            }
          } catch {
            // ポーリングなので個別の失敗は黙って次回に任せる
          } finally {
            if (!cancelled) setOutputLoading((prev) => ({ ...prev, [id]: false }));
          }
        }),
      );
    };

    loadLogs();
    const timer = setInterval(loadLogs, LOGS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [displayIds]);

  // ステータスが変わったレーンに通知ドットを立てる。
  useEffect(() => {
    agents.forEach((a) => {
      const before = prevStatus.current[a.id];
      if (before && before !== a.status && a.id !== focusedId) {
        setSeen((prev) => ({ ...prev, [a.id]: a.status }));
      }
      prevStatus.current[a.id] = a.status;
    });
  }, [agents, focusedId]);

  async function loadDiff(id: string) {
    setDiffLoading((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch(`/api/agents/${id}/diff`, { cache: "no-store" });
      const json = await res.json();
      if (res.ok) setDiffs((prev) => ({ ...prev, [id]: json.diff ?? "" }));
    } catch {
      setDiffs((prev) => ({ ...prev, [id]: "" }));
    } finally {
      setDiffLoading((prev) => ({ ...prev, [id]: false }));
    }
  }

  function toggleDiff(id: string) {
    const next = !diffOpen[id];
    setDiffOpen((prev) => ({ ...prev, [id]: next }));
    if (next) loadDiff(id);
  }

  function toggleFocus(id: string) {
    setFocusedId((prev) => (prev === id ? null : id));
    setSeen((prev) => {
      const { [id]: _removed, ...rest } = prev;
      return rest;
    });
  }

  async function killLane(id: string) {
    const target = agents.find((a) => a.id === id);
    const label = target ? `${target.tag} ${target.name}` : id;
    if (!window.confirm(`${label} を停止します。よろしいですか？（会話は保持されます）`)) return;

    try {
      const res = await fetch(`/api/agents/${id}/stop`, { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.message ?? "停止に失敗しました");
      }
      await fetchAgents();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  function setLaneCount(n: number) {
    const idx = agents.findIndex((a) => a.id === focusedId);
    if (idx !== -1 && idx >= n) setFocusedId(null);
    setLaneCountState(n);
  }

  const lanes: LaneView[] = displayAgents.map((a) => ({
    id: a.id,
    sessionId: a.sessionId,
    tag: a.tag,
    name: a.name,
    cwd: a.cwd,
    status: a.status,
    isAlive: a.isAlive,
    output: outputs[a.id] ?? "",
    outputLoading: outputLoading[a.id] ?? false,
    diffOpen: diffOpen[a.id] ?? false,
    diff: diffs[a.id] ?? "",
    diffLoading: diffLoading[a.id] ?? false,
    hasNotification: seen[a.id] !== undefined,
  }));

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
          <div className="font-mono text-[11.5px] text-[#8a8f98]">
            claude agents --json · {agents.length} セッション
            {loadError && <span className="ml-2 text-[#f87171]">{loadError}</span>}
          </div>
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
                className="cursor-pointer rounded-md border px-3.5 py-1.5 font-mono text-xs font-semibold"
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
            onClick={() => setFocusedId(null)}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[#23262b] px-3 py-1.5 text-xs text-[#aeb2b8]"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#aeb2b8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            一覧に戻る
          </button>
          {visibleAgents.map((a) => {
            const active = a.id === focusedId;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => toggleFocus(a.id)}
                className="flex cursor-pointer items-center rounded-md border px-3 py-1.5 font-mono text-xs font-semibold"
                style={{
                  borderColor: active ? "#f2874a" : "#23262b",
                  background: active ? "rgba(242,135,74,0.12)" : "transparent",
                  color: active ? "#f2874a" : "#aeb2b8",
                }}
              >
                <span
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: STATUS_META[a.status].dot }}
                />
                {a.tag}
              </button>
            );
          })}
        </div>
      )}

      <div
        className="dc-scroll flex flex-1 flex-row items-stretch gap-4 px-7 pt-4.5 pb-6"
        style={{
          minHeight: 0,
          overflowX: "auto",
          overflowY: "hidden",
          justifyContent: isFocusMode ? "center" : "flex-start",
        }}
      >
        {lanes.length > 0 ? (
          lanes.map((lane) => (
            <LaneCard
              key={lane.id}
              lane={lane}
              isFocused={isFocusMode}
              onToggleDiff={toggleDiff}
              onToggleFocus={toggleFocus}
              onKill={killLane}
            />
          ))
        ) : (
          <div className="flex w-full items-center justify-center text-sm text-[#5c6067]">
            {initialLoaded
              ? "バックグラウンドセッションがありません。claude --bg -w <名前> \"指示\" で起動すると、ここにボードが並びます。"
              : "セッションを読み込み中…"}
          </div>
        )}
      </div>
    </div>
  );
}
