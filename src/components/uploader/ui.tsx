import { Badge } from "@/components/ui";
import { ACCOUNT_STATUS_LABELS, RUN_STATUS_LABELS, TASK_STATUS_LABELS, type AccountStatus, type RunStatus, type TaskStatus } from "@/lib/uploader/types";

type Tone = "neutral" | "ok" | "warn" | "danger" | "brand" | "ink";

export const RUN_TONE: Record<string, Tone> = { QUEUED: "neutral", RUNNING: "brand", VERIFY_WAIT: "warn", VERIFYING: "brand", DONE: "ok", FAILED: "danger", STOPPED: "neutral" };
export const TASK_TONE: Record<string, Tone> = { QUEUED: "neutral", LEASED: "brand", DONE: "ok", FAILED: "danger", SKIPPED: "warn" };
export const ACCOUNT_TONE: Record<string, Tone> = { ok: "ok", needs_login: "danger", paused: "warn", limited: "warn", banned: "danger", off: "neutral" };
export const AGENT_TONE: Record<string, Tone> = { online: "ok", busy: "brand", offline: "neutral" };
export const AGENT_LABELS: Record<string, string> = { online: "На связи", busy: "Работает", offline: "Не на связи" };

export const RunBadge = ({ status }: { status: string }) => <Badge tone={RUN_TONE[status] ?? "neutral"}>{RUN_STATUS_LABELS[status as RunStatus] ?? status}</Badge>;
export const TaskBadge = ({ status }: { status: string }) => <Badge tone={TASK_TONE[status] ?? "neutral"}>{TASK_STATUS_LABELS[status as TaskStatus] ?? status}</Badge>;
export const AccountBadge = ({ status }: { status: string }) => <Badge tone={ACCOUNT_TONE[status] ?? "neutral"}>{ACCOUNT_STATUS_LABELS[status as AccountStatus] ?? status}</Badge>;
export const AgentBadge = ({ status }: { status: string }) => <Badge tone={AGENT_TONE[status] ?? "neutral"}>{AGENT_LABELS[status] ?? status}</Badge>;

export const dt = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString("ru-RU", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
export const ago = (d: Date | string | null | undefined, now = new Date()) => {
  if (!d) return "никогда";
  const s = Math.round((now.getTime() - new Date(d).getTime()) / 1000);
  if (s < 90) return "только что";
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return dt(d);
};
