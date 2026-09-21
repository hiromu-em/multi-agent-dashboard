"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LaneCard, { type LaneView } from "@/components/LaneCard";
import { STATUS_META, type LaneStatus } from "@/lib/dashboard-data";
import type { TranscriptEntry } from "@/lib/transcript";

const LANE_COUNT_OPTIONS = [3, 4, 5, 8];
const AGENTS_POLL_MS = 4000;
const LOGS_POLL_MS = 5000;

/** 存在しない宛先を指されて、作るかどうかの返事を待っているもの。 */
interface PendingCreate {
  tag: string;
  body: string;
  at: number;
}

/** 宛先を切り替えた直後の最初の1通で、送るかどうかの返事を待っているもの。 */
interface PendingSend {
  tag: string;
  name: string;
  body: string;
  at: number;
}

interface DispatchProblem {
  at: string;
  event: "failed" | "dropped";
  tag: string;
  name?: string;
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
  // 存在しない宛先を指されて、作るかどうかの返事を待っているもの。
  const [pending, setPending] = useState<PendingCreate[]>([]);
  const [pendingBusy, setPendingBusy] = useState<string | null>(null);
  // 宛先を切り替えた直後の最初の1通で、送るかどうかの返事を待っているもの。
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);
  const [pendingSendBusy, setPendingSendBusy] = useState<string | null>(null);
  // 指示入力欄（グローバル）。`#タグ 本文` で宛先を指定、省略時は直前の宛先へ。
  const [dispatchText, setDispatchText] = useState("");
  const [dispatchBusy, setDispatchBusy] = useState(false);
  // 入力欄を広げているか。長い指示のときだけボタンで広げる（既定は2行）。
  const [dispatchExpanded, setDispatchExpanded] = useState(false);
  // 送信結果はポップアップで数秒だけ出す。`toastShown` を別に持つのは、
  // フェードアウトの間も本文（dispatchStatus）は残しておきたいため
  // （先に dispatchStatus を消すと、透明度の遷移が終わる前に文字が消える）。
  const [dispatchStatus, setDispatchStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [toastShown, setToastShown] = useState(false);
  const toastTimers = useRef<{ hide?: ReturnType<typeof setTimeout>; remove?: ReturnType<typeof setTimeout> }>({});

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

  // 入力欄で `#` を省いた入力が飛ぶ先。誤爆を防ぐため盤面でも強調する。
  const fetchTarget = useCallback(async () => {
    try {
      const res = await fetch("/api/dispatch", { cache: "no-store" });
      const json = await res.json();
      setTargetSessionId(json?.target?.sessionId ?? null);
      setQueued(json?.queued ?? 0);
      setProblems(json?.problems ?? []);
      setPending(json?.pending ?? []);
      setPendingSends(json?.pendingSends ?? []);
    } catch {
      // 表示だけの情報なので、取れなければ前回のままにする。
    }
  }, []);

  // 「作りますか？」への返事。入力欄で `#K` と打つのと同じ保留を消化する。
  const answerPending = useCallback(
    async (tag: string, action: "create" | "reject") => {
      setPendingBusy(tag);
      try {
        const res = await fetch("/api/dispatch/pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag, action }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) setLoadError(json?.error ?? "作成に失敗しました");
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingBusy(null);
        await fetchTarget();
      }
    },
    [fetchTarget],
  );

  // 宛先を切り替えた直後の「このまま送りますか？」への返事。
  // 入力欄で `#B` と打つのと同じ保留を消化する。
  const answerPendingSend = useCallback(
    async (tag: string, action: "send" | "reject") => {
      setPendingSendBusy(tag);
      try {
        const res = await fetch("/api/dispatch/confirm-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tag, action }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) setLoadError(json?.error ?? "送信に失敗しました");
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        setPendingSendBusy(null);
        await fetchTarget();
      }
    },
    [fetchTarget],
  );

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

  // 送信結果のポップアップを出し、数秒後にフェードアウトさせて消す。
  // 新しい結果が来たら前のタイマーは打ち切り、アニメーションをやり直す。
  const showDispatchToast = useCallback((status: { ok: boolean; message: string }) => {
    if (toastTimers.current.hide) clearTimeout(toastTimers.current.hide);
    if (toastTimers.current.remove) clearTimeout(toastTimers.current.remove);

    setDispatchStatus(status);
    setToastShown(false);
    requestAnimationFrame(() => setToastShown(true)); // 次フレームで表示し、スライドイン・フェードインさせる

    toastTimers.current.hide = setTimeout(() => setToastShown(false), 4000); // 4秒後にフェードアウト開始
    toastTimers.current.remove = setTimeout(() => setDispatchStatus(null), 4300); // 遷移(300ms)が終わってから消す
  }, []);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      if (timers.hide) clearTimeout(timers.hide);
      if (timers.remove) clearTimeout(timers.remove);
    };
  }, []);

  // グローバル入力欄からの送信。宛先の解決・スティッキー・確認まわりの判断は
  // すべてサーバー側（src/lib/dispatch.ts の routePrompt）に任せ、ここは結果を出すだけ。
  const submitDispatch = useCallback(async () => {
    const text = dispatchText;
    if (!text.trim() || dispatchBusy) return;

    setDispatchBusy(true);
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const json = await res.json().catch(() => ({}));
      const ok = res.ok && json?.ok !== false;
      showDispatchToast({ ok, message: json?.message ?? "" });
      // 失敗したときは入力欄を消さない。宛先が無い・タグを打ち間違えたといった
      // 失敗はタグを直して送り直すだけなので、本文まで消えると打ち直しになる。
      if (ok) setDispatchText("");
    } catch (error) {
      showDispatchToast({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDispatchBusy(false);
      await fetchTarget();
      await fetchAgents();
    }
  }, [dispatchText, dispatchBusy, fetchTarget, fetchAgents, showDispatchToast]);

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

  // 終わったレーンを盤面から片付ける。セッションは止めない（Killとは別物）。
  async function dismissLane(id: string) {
    try {
      const res = await fetch(`/api/agents/${id}/dismiss`, { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.message ?? "片付けに失敗しました");
      }
      if (focusedId === id) setFocusedId(null);
      await fetchAgents();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  // レーンへの返信。各レーンの返信欄専用の経路（グローバル入力欄とは別）。
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
                  {problem.name ? ` ${problem.name}` : ""}
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

      {/*
        指示の入力欄。ヘッダーの外に置くのは、ヘッダーを畳んでいても使えるように
        するため（ダッシュボードからレーンへ指示を出す唯一の経路なので、隠れて
        使えなくなると困る）。宛先の解決・スティッキー・確認はすべてサーバー側
        （src/lib/dispatch.ts の routePrompt）に任せ、ここでは結果を表示するだけ。
      */}
      <div className="flex shrink-0 items-start gap-3 border-b border-[#1d2024] bg-[#111317] px-7 py-3">
        <textarea
          value={dispatchText}
          onChange={(e) => setDispatchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitDispatch();
            }
          }}
          placeholder="#B 本文 のように宛先を指定（省略時は直前の宛先へ）。# 単独で宛先解除。Shift+Enterで改行、複数行で複数宛先に同時送信"
          rows={dispatchExpanded ? 10 : 2}
          disabled={dispatchBusy}
          className="min-w-0 flex-1 resize-none rounded-md border border-[#23262b] bg-[#0a0b0d] px-3 py-2 font-mono text-[15px] text-[#e6e8eb] placeholder:text-[#5c6067] focus:border-[#f2874a] focus:outline-none disabled:opacity-50"
        />
        <div className="flex shrink-0 flex-col items-stretch gap-1.5">
          <button
            type="button"
            onClick={submitDispatch}
            disabled={dispatchBusy || !dispatchText.trim()}
            className="cursor-pointer rounded-md border px-4 py-2 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: "#5a3018", background: "rgba(242,135,74,0.14)", color: "#f2874a" }}
          >
            送信
          </button>
          {/*
            入力欄の高さをボタンで切り替える。長い指示を書くときだけ広げられれば
            よく、常に大きいとレーンの表示領域を食う。ドラッグでのリサイズは
            掴みどころが小さく、盤面の他の操作（ヘッダーの開閉など）がすべて
            ボタンなので、ここも同じボタン式で揃えている。
          */}
          <button
            type="button"
            onClick={() => setDispatchExpanded((prev) => !prev)}
            title={dispatchExpanded ? "入力欄を狭める" : "入力欄を広げる"}
            className="flex cursor-pointer items-center justify-center rounded-md border border-[#23262b] py-1.5 text-[#6f7580] hover:text-[#aeb2b8]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              {dispatchExpanded ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
            </svg>
          </button>
        </div>
      </div>
      {/*
        送信結果のポップアップ。レイアウトを押し広げない浮き表示にして、数秒で
        自動的にフェードアウトする（showDispatchToast）。盤面の確認バー（下の
        pending/pendingSends）とは違い、こちらは操作を要求しないただの結果表示
        なので、居座らせず消してよい。
      */}
      {dispatchStatus && (
        <div
          className="fixed top-4 right-5 z-50 max-w-sm rounded-lg border px-4 py-2.5 font-mono text-[12px] shadow-lg"
          style={{
            transition: "opacity 220ms ease, transform 220ms ease",
            opacity: toastShown ? 1 : 0,
            transform: toastShown ? "translateY(0)" : "translateY(-8px)",
            ...(dispatchStatus.ok
              ? { borderColor: "#23262b", background: "#111317", color: "#c7cbd1" }
              : { borderColor: "#3a1414", background: "#1a0d0d", color: "#f87171" }),
          }}
        >
          {dispatchStatus.message}
        </div>
      )}

      {/*
        存在しない宛先を指されたときの確認。ヘッダーの外に置くのは、ヘッダーを
        畳んでいても見えるようにするため。返事を待っている＝指示が宙に
        浮いている状態なので、畳んだせいで気づけないと困る。
      */}
      {pending.map((item) => (
        <div
          key={item.tag}
          className="flex shrink-0 items-center gap-3 border-b px-7 py-2.5"
          style={{ borderColor: "#2a2410", background: "#171307" }}
        >
          <span className="shrink-0 font-mono text-xs font-bold text-[#fbbf24]">{item.tag}</span>
          <span className="shrink-0 text-[12px] text-[#fde68a]">
            という宛先はありません。作りますか？
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#8a8f98]">
            {item.body}
          </span>
          <button
            type="button"
            disabled={pendingBusy === item.tag}
            onClick={() => answerPending(item.tag, "create")}
            className="shrink-0 cursor-pointer rounded-md border px-3 py-1 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: "#4a3f14", background: "rgba(251,191,36,0.14)", color: "#fbbf24" }}
          >
            実行
          </button>
          <button
            type="button"
            disabled={pendingBusy === item.tag}
            onClick={() => answerPending(item.tag, "reject")}
            className="shrink-0 cursor-pointer rounded-md border border-[#3a3d44] px-3 py-1 text-[12px] text-[#aeb2b8] disabled:cursor-not-allowed disabled:opacity-40"
          >
            拒否
          </button>
        </div>
      ))}

      {/*
        宛先を切り替えた直後、`#`無しの最初の1通の確認。誤爆がいちばん起きやすい
        瞬間はここだと考え、この1通だけ一呼吸置く（2通目以降は毎回は聞かない）。
        「作りますか？」（上のバー）とは別の保留なので、色も分けて区別する。
      */}
      {pendingSends.map((item) => (
        <div
          key={item.tag}
          className="flex shrink-0 items-center gap-3 border-b px-7 py-2.5"
          style={{ borderColor: "#12283a", background: "#0b1a26" }}
        >
          <span className="shrink-0 font-mono text-xs font-bold text-[#7dd3fc]">
            {item.tag} {item.name}
          </span>
          <span className="shrink-0 text-[12px] text-[#bae6fd]">
            に切り替えた直後です。このまま送りますか？
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#8a8f98]">
            {item.body}
          </span>
          <button
            type="button"
            disabled={pendingSendBusy === item.tag}
            onClick={() => answerPendingSend(item.tag, "send")}
            className="shrink-0 cursor-pointer rounded-md border px-3 py-1 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: "#1e4a63", background: "rgba(125,211,252,0.14)", color: "#7dd3fc" }}
          >
            送信
          </button>
          <button
            type="button"
            disabled={pendingSendBusy === item.tag}
            onClick={() => answerPendingSend(item.tag, "reject")}
            className="shrink-0 cursor-pointer rounded-md border border-[#3a3d44] px-3 py-1 text-[12px] text-[#aeb2b8] disabled:cursor-not-allowed disabled:opacity-40"
          >
            取消
          </button>
        </div>
      ))}

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
              onDismiss={dismissLane}
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
