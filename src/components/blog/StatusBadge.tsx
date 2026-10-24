import type { BlogStatus } from "@prisma/client";
import { Badge } from "@/components/ui";
import { STATUS_LABELS, type Tone } from "@/lib/blog/labels";

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "brand" | "ink";

export function badgeTone(t: Tone): BadgeTone {
  return t === "muted" ? "neutral" : t === "info" ? "brand" : t;
}

export function StatusBadge({ status, title }: { status: BlogStatus; title?: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, tone: "muted" as Tone, help: "" };
  return <span title={title ?? s.help}><Badge tone={badgeTone(s.tone)}>{s.label}</Badge></span>;
}

export function StageLogBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: BadgeTone }> = {
    running: { label: "выполняется", tone: "brand" }, done: { label: "готово", tone: "ok" }, error: { label: "ошибка", tone: "danger" }, skipped: { label: "отложено", tone: "neutral" },
  };
  const m = map[status] ?? { label: status, tone: "neutral" as BadgeTone };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
