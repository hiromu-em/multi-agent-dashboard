export type LogKind = "system" | "instruction" | "agent" | "error" | "warning";
export type LaneStatus = "running" | "waiting" | "done" | "error" | "killed";
export type DiffType = "file" | "add" | "del" | "ctx";

export interface LogEntry {
  kind: LogKind;
  text: string;
  time: string;
}

export interface DiffLine {
  type: DiffType;
  code: string;
}

export interface Lane {
  id: string;
  tag: string;
  name: string;
  status: LaneStatus;
  logs: LogEntry[];
  diffLines: DiffLine[];
  diffOpen: boolean;
  question: string;
  draftReply: string;
  hasNotification: boolean;
}

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

export const LOG_META: Record<
  LogKind,
  { label: string; color: string; align: "left" | "right" | "center" }
> = {
  system: { label: "SYSTEM", color: "#6f7580", align: "center" },
  instruction: { label: "窓口 →", color: "#f2874a", align: "right" },
  agent: { label: "エージェント", color: "#8a8f98", align: "left" },
  error: { label: "ERROR", color: "#f87171", align: "left" },
  warning: { label: "WARN", color: "#fbbf24", align: "left" },
};

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

export function nowLabel(): string {
  const d = new Date();
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// 窓口セッション(CLI)からすでに走っているサブエージェントの初期状態。
// 実装が進んだら、この固定データを /api/agents からの取得結果に置き換える。
export function makePool(): Lane[] {
  return [
    {
      id: "a",
      tag: "#A",
      name: "認証機能",
      status: "running",
      diffOpen: false,
      question: "",
      draftReply: "",
      hasNotification: false,
      diffLines: [],
      logs: [
        { kind: "system", text: "Git worktree 'agent-a' を作成しました", time: "10:20" },
        { kind: "instruction", text: "ログイン画面のバリデーション処理を修正して", time: "10:21" },
        { kind: "agent", text: "対応中です。まず既存の validate.ts を確認します…", time: "10:21" },
        { kind: "agent", text: "email 正規表現の不備を発見。修正パッチを作成中です。", time: "10:24" },
      ],
    },
    {
      id: "b",
      tag: "#B",
      name: "UI改修",
      status: "waiting",
      diffOpen: false,
      question: "現行踏襲(y) か 新デザインの角丸+グラデーション(n) 、どちらにしますか？",
      draftReply: "",
      hasNotification: false,
      diffLines: [],
      logs: [
        { kind: "system", text: "Git worktree 'agent-b' を作成しました", time: "09:58" },
        { kind: "instruction", text: "ログインボタンの配色を新デザインに合わせて", time: "09:59" },
        {
          kind: "agent",
          text: "現行スタイルを踏襲するか、新デザインにするか判断がつかないため確認したいです。",
          time: "10:05",
        },
      ],
    },
    {
      id: "c",
      tag: "#C",
      name: "API連携",
      status: "done",
      diffOpen: false,
      question: "",
      draftReply: "",
      hasNotification: false,
      diffLines: [
        { type: "file", code: "src/lib/api/client.ts" },
        { type: "del", code: "const res = await fetch(`/api/v1/orders`);" },
        { type: "add", code: "const res = await fetch(`/api/v2/orders`);" },
        { type: "ctx", code: "return res.json();" },
      ],
      logs: [
        { kind: "system", text: "Git worktree 'agent-c' を作成しました", time: "09:40" },
        { kind: "instruction", text: "注文APIをv2エンドポイントに差し替えて", time: "09:41" },
        {
          kind: "agent",
          text: "v2エンドポイントへの差し替えとレスポンス型の更新が完了しました。",
          time: "09:52",
        },
      ],
    },
    {
      id: "d",
      tag: "#D",
      name: "DB移行",
      status: "error",
      diffOpen: false,
      question: "",
      draftReply: "",
      hasNotification: false,
      diffLines: [
        { type: "file", code: "migrations/0032_users.sql" },
        { type: "del", code: "DROP TABLE users_old;" },
        { type: "add", code: "ALTER TABLE users_old RENAME TO users_archive;" },
      ],
      logs: [
        { kind: "system", text: "Git worktree 'agent-d' を作成しました", time: "09:30" },
        { kind: "instruction", text: "usersテーブルを新スキーマに移行して", time: "09:31" },
        {
          kind: "error",
          text: 'Error: relation "users_old" does not exist (migration 0032)',
          time: "09:47",
        },
      ],
    },
    {
      id: "e",
      tag: "#E",
      name: "スタイル調整",
      status: "running",
      diffOpen: false,
      question: "",
      draftReply: "",
      hasNotification: false,
      diffLines: [],
      logs: [
        { kind: "system", text: "Git worktree 'agent-e' を作成しました", time: "10:02" },
        { kind: "instruction", text: "全体のスペーシングを Tailwind のデフォルトに揃えて", time: "10:03" },
        { kind: "agent", text: "対象コンポーネント18個中11個の調整が完了。残りを続けます。", time: "10:19" },
      ],
    },
    {
      id: "f",
      tag: "#F",
      name: "決済API",
      status: "done",
      diffOpen: false,
      question: "",
      draftReply: "",
      hasNotification: false,
      diffLines: [
        { type: "file", code: "src/lib/payment/checkout.ts" },
        { type: "add", code: "if (requires3ds) return redirectTo(challengeUrl);" },
      ],
      logs: [
        { kind: "instruction", text: "Stripe の3Dセキュア対応を追加して", time: "09:12" },
        {
          kind: "agent",
          text: "3Dセキュアのリダイレクトフローを実装し、テスト決済で確認済みです。",
          time: "09:44",
        },
      ],
    },
    {
      id: "g",
      tag: "#G",
      name: "E2Eテスト",
      status: "waiting",
      diffOpen: false,
      question: "決済モジュール(#F)も E2E テストの対象に含めますか？",
      draftReply: "",
      hasNotification: false,
      diffLines: [],
      logs: [
        { kind: "instruction", text: "チェックアウト画面のE2Eテストを書いて", time: "10:08" },
        { kind: "agent", text: "新規追加された決済モジュールもテスト対象に含めますか？", time: "10:16" },
      ],
    },
    {
      id: "h",
      tag: "#H",
      name: "スキーマ変更",
      status: "running",
      diffOpen: false,
      question: "",
      draftReply: "",
      hasNotification: false,
      diffLines: [],
      logs: [
        { kind: "system", text: "Git worktree 'agent-h' を作成しました", time: "10:11" },
        { kind: "instruction", text: "注文テーブルにステータス列を追加して", time: "10:12" },
        { kind: "agent", text: "マイグレーションファイルを作成中です。", time: "10:15" },
      ],
    },
  ];
}
