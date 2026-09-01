export type LaneStatus = "running" | "waiting" | "done" | "error" | "killed";

export const STATUS_META: Record<
  LaneStatus,
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  running: {
    label: "実行中",
    text: "#7dd3fc",
    bg: "rgba(56,189,248,0.12)",
    border: "rgba(56,189,248,0.4)",
    dot: "#38bdf8",
  },
  waiting: {
    label: "対話待ち",
    text: "#fbbf24",
    bg: "rgba(251,191,36,0.12)",
    border: "rgba(251,191,36,0.45)",
    dot: "#fbbf24",
  },
  done: {
    label: "完了",
    text: "#4ade80",
    bg: "rgba(74,222,128,0.12)",
    border: "rgba(74,222,128,0.4)",
    dot: "#4ade80",
  },
  error: {
    label: "エラー",
    text: "#f87171",
    bg: "rgba(248,113,113,0.12)",
    border: "rgba(248,113,113,0.45)",
    dot: "#f87171",
  },
  killed: {
    label: "停止済み",
    text: "#9aa0a8",
    bg: "rgba(154,160,168,0.08)",
    border: "rgba(154,160,168,0.3)",
    dot: "#6b7280",
  },
};
