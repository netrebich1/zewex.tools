import type { ArtStatus } from "@prisma/client";
import { Badge } from "@/components/ui";
import { STATUS_LABELS, type Tone } from "@/lib/articles/labels";

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "brand" | "ink";

/** Тон словаря статусов → тон бейджа портала. */
export function badgeTone(t: Tone): BadgeTone {
  return t === "muted" ? "neutral" : t === "info" ? "brand" : t;
}

/** Бейдж статуса статьи по единому русскому словарю; подсказка — в title. */
export function StatusBadge({ status, title }: { status: ArtStatus; title?: string }) {
  const s = STATUS_LABELS[status] ?? { label: status, tone: "muted" as Tone, help: "" };
  return (
    <span title={title ?? s.help}>
      <Badge tone={badgeTone(s.tone)}>{s.label}</Badge>
    </span>
  );
}

/** Бейдж статуса записи журнала этапа (ArtStageLog.status). */
export function StageLogBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: BadgeTone }> = {
    running: { label: "выполняется", tone: "brand" },
    done: { label: "готово", tone: "ok" },
    error: { label: "ошибка", tone: "danger" },
    skipped: { label: "отложено", tone: "neutral" },
  };
  const m = map[status] ?? { label: status, tone: "neutral" as BadgeTone };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
