"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LaneCard, { type LaneView } from "@/components/LaneCard";
import { STATUS_META, type LaneStatus } from "@/lib/dashboard-data";
import type { TranscriptEntry } from "@/lib/transcript";

const LANE_COUNT_OPTIONS = [3, 4, 5, 8];
const AGENTS_POLL_MS = 4000;
const LOGS_POLL_MS = 5000;

interface DispatchProblem {
  at: string;
  event: "failed" | "dropped";
  tag: string;
  reason?: string;
}

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
  // ヘッダーを畳んでレーンの表示領域を広げられるようにする。
  const [headerHidden, setHeaderHidden] = useState(false);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  const [entries, setEntries] = useState<Record<string, TranscriptEntry[]>>({});
  const [entriesLoaded, setEntriesLoaded] = useState<Record<string, boolean>>({});
  const [diffOpen, setDiffOpen] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState<Record<string, boolean>>({});
  const [seen, setSeen] = useState<Record<string, LaneStatus>>({});
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  // 届かなかった指示。送信は裏で走るので、ここに出さないと誰も気づけない。
  const [problems, setProblems] = useState<DispatchProblem[]>([]);

  // 直前のステータスを覚えておき、変化したレーンに通知を出す。
  const prevStatus = useRef<Record<string, LaneStatus>>({});

  // 一覧から消えたセッションの分を各辞書から取り除く。
  // これをやらないと、長く動かしている間ログや差分の文字列が溜まり続ける。
  const pruneVanished = useCallback((list: ApiAgent[]) => {
    const alive = new Set(list.map((a) => a.id));

    // 消えたIDが無ければ同じ参照を返し、無駄な再レンダリングを避ける。
    function prune<T>(prev: Record<string, T>): Record<string, T> {
      const keys = Object.keys(prev);
      if (keys.every((key) => alive.has(key))) return prev;
      return Object.fromEntries(keys.filter((key) => alive.has(key)).map((key) => [key, prev[key]]));
    }

    setEntries(prune);
    setEntriesLoaded(prune);
    setDiffOpen(prune);
    setDiffs(prune);
    setDiffLoading(prune);
    setSeen(prune);

    for (const id of Object.keys(prevStatus.current)) {
      if (!alive.has(id)) delete prevStatus.current[id];
    }
  }, []);

  // 窓口CLIで `#` を省いた入力が飛ぶ先。誤爆を防ぐため盤面でも強調する。
  const fetchTarget = useCallback(async () => {
    try {
      const res = await fetch("/api/dispatch", { cache: "no-store" });
      const json = await res.json();
      setTargetSessionId(json?.target?.sessionId ?? null);
      setQueued(json?.queued ?? 0);
      setProblems(json?.problems ?? []);
    } catch {
      // 表示だけの情報なので、取れなければ前回のままにする。
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message ?? json?.error ?? "取得に失敗しました");

      const list: ApiAgent[] = json.agents ?? [];
      setAgents(list);
      pruneVanished(list);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setInitialLoaded(true);
    }
  }, [pruneVanished]);

  useEffect(() => {
    const poll = () => {
      fetchAgents();
      fetchTarget();
    };
    poll();
    const timer = setInterval(poll, AGENTS_POLL_MS);
    return () => clearInterval(timer);
  }, [fetchAgents, fetchTarget]);

  const visibleAgents = useMemo(() => agents.slice(0, laneCount), [agents, laneCount]);
  const focusedAgent = focusedId ? (agents.find((a) => a.id === focusedId) ?? null) : null;
  const isFocusMode = !!focusedAgent;
  const displayAgents = isFocusMode ? [focusedAgent!] : visibleAgents;

  // 表示中のレーンの会話だけを取りに行く。
  // 会話ファイルの特定に sessionId が要るので、id と一緒に持ち回る。
  const displayKeys = useMemo(
    () => displayAgents.map((a) => `${a.id}:${a.sessionId}`).join(","),
    [displayAgents],
  );

  useEffect(() => {
    if (!displayKeys) return;
    const targets = displayKeys.split(",").map((key) => key.split(":"));
    let cancelled = false;

    const loadTranscripts = async () => {
      await Promise.all(
        targets.map(async ([id, sessionId]) => {
          try {
            const res = await fetch(
              `/api/agents/${id}/logs?session=${encodeURIComponent(sessionId)}`,
              { cache: "no-store" },
            );
            const json = await res.json();
            if (!cancelled && res.ok) {
              setEntries((prev) => ({ ...prev, [id]: json.entries ?? [] }));
            }
          } catch {
            // ポーリングなので個別の失敗は黙って次回に任せる
          } finally {
            if (!cancelled) setEntriesLoaded((prev) => ({ ...prev, [id]: true }));
          }
        }),
      );
    };

    loadTranscripts();
    const timer = setInterval(loadTranscripts, LOGS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [displayKeys]);

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

  // レーンへの返信。ダッシュボードの入力欄からの唯一の送信経路。
  async function replyToLane(id: string, body: string): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`/api/agents/${id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, message: json?.error ?? "送信に失敗しました" };
      return { ok: true, message: json?.message ?? "送信しました" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  function setLaneCount(n: number) {
    const idx = agents.findIndex((a) => a.id === focusedId);
    if (idx !== -1 && idx >= n) setFocusedId(null);
    setLaneCountState(n);
  }

  const targetAgent = targetSessionId
    ? (agents.find((a) => a.sessionId === targetSessionId) ?? null)
    : null;

  const lanes: LaneView[] = displayAgents.map((a) => ({
    id: a.id,
    sessionId: a.sessionId,
    tag: a.tag,
    name: a.name,
    cwd: a.cwd,
    status: a.status,
    isAlive: a.isAlive,
    entries: entries[a.id] ?? [],
    entriesLoaded: entriesLoaded[a.id] ?? false,
    diffOpen: diffOpen[a.id] ?? false,
    diff: diffs[a.id] ?? "",
    diffLoading: diffLoading[a.id] ?? false,
    hasNotification: seen[a.id] !== undefined,
    isTarget: a.sessionId === targetSessionId,
  }));

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-[#0a0b0d] text-[#e6e8eb]">
      {headerHidden ? (
        <div className="flex shrink-0 items-center justify-center border-b border-[#1d2024] bg-[#111317] py-1">
          <button
            type="button"
            onClick={() => setHeaderHidden(false)}
            title="ヘッダーを表示"
            className="cursor-pointer rounded-md px-3 py-0.5 text-[#6f7580] hover:text-[#aeb2b8]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 15 12 9 18 15" />
            </svg>
          </button>
        </div>
      ) : (
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
            {agents.length} セッション
            {targetAgent ? (
              <span className="ml-2 text-[#f2874a]">
                → {targetAgent.tag} {targetAgent.name} に送信中
              </span>
            ) : (
              <span className="ml-2 text-[#5c6067]">宛先なし</span>
            )}
            {queued > 0 && <span className="ml-2 text-[#fbbf24]">順番待ち {queued} 件</span>}
            {loadError && <span className="ml-2 text-[#f87171]">{loadError}</span>}
          </div>
          {problems.length > 0 && (
            <div className="mt-1 font-mono text-[11px] text-[#f87171]">
              届かなかった指示 {problems.length} 件：
              {problems.map((problem) => (
                <span key={`${problem.at}-${problem.tag}`} className="ml-2">
                  {problem.tag}
                  {problem.event === "dropped" ? "（宛先が消えた）" : "（送信失敗）"}
                </span>
              ))}
            </div>
          )}
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
          <button
            type="button"
            onClick={() => setHeaderHidden(true)}
            title="ヘッダーを隠す"
            className="ml-1 cursor-pointer rounded-md px-1.5 py-1 text-[#6f7580] hover:text-[#aeb2b8]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
      </header>
      )}

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
              onReply={replyToLane}
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
