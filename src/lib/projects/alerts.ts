/** Сигналы по проекту: чистая функция от сводки, карточки и задач. Коротко и с подсказкой, куда идти. */
import type { ProjectSummary } from "./summary";

export type Alert = { key: string; tone: "danger" | "warn" | "neutral"; text: string; href?: string };

export function projectAlerts(
  s: ProjectSummary,
  card: { status: string; nextDueAt: Date | null } | null,
  tasks: { overdue: number },
  lastEventAt: Date | null,
  now = new Date(),
): Alert[] {
  const out: Alert[] = [];
  const archived = card?.status === "ARCHIVED" || card?.status === "DONE";
  const pinsOn = !!s.pins.tool?.active;
  const pinsHref = s.pins.tool?.ids[0] ? `/pinterest/pins/sites/${s.pins.tool.ids[0]}` : "/pinterest/pins";
  if (!archived && pinsOn) {
    if (s.pins.pins.planned === 0) out.push({ key: "no_pins", tone: "warn", text: "Пинов ещё нет", href: "/pinterest/pins/runs/new" });
    else if (s.pins.schedule.stockRunDays === 0) out.push({ key: "stock_out", tone: "danger", text: "Запас пинов закончился", href: pinsHref });
    else if (s.pins.schedule.stockRunDays < 7) out.push({ key: "stock_low", tone: "warn", text: `Пинов на ${s.pins.schedule.stockRunDays} дн.`, href: pinsHref });
    if (s.pins.uploads.pendingDays > 0) out.push({ key: "export_not_uploaded", tone: "warn", text: `Не отмечено залитым: ${s.pins.uploads.pendingDays} дн.`, href: "?tab=uploads" });
    if (s.pins.pins.errors > 0) out.push({ key: "pin_errors", tone: "neutral", text: `Пинов с ошибкой: ${s.pins.pins.errors}`, href: pinsHref });
    if (s.pins.runs.last && (s.pins.runs.last.status === "BLOCKED" || s.pins.runs.last.status === "FAILED" || s.pins.runs.last.status === "WAITING_MODERATION")) {
      const t = s.pins.runs.last.status === "WAITING_MODERATION" ? "Прогон ждёт модерации" : "Прогон остановлен с ошибкой";
      out.push({ key: "run_problem", tone: s.pins.runs.last.status === "WAITING_MODERATION" ? "neutral" : "danger", text: t, href: `/pinterest/pins/runs/${s.pins.runs.last.id}` });
    }
  }
  if (!archived && (s.articles.tool || s.blog.tool) && s.articles.published + s.blog.published === 0) out.push({ key: "no_articles", tone: "neutral", text: "Опубликованных статей нет" });
  const wo = (s.articles.withoutPins ?? 0) + (s.blog.withoutPins ?? 0);
  if (!archived && pinsOn && wo >= 3) out.push({ key: "articles_without_pins", tone: "neutral", text: `Статей без пинов: ${wo}`, href: "?tab=work" });
  if (tasks.overdue > 0) out.push({ key: "tasks_overdue", tone: "danger", text: `Просрочено задач: ${tasks.overdue}`, href: "?tab=tasks" });
  if (card?.nextDueAt && card.nextDueAt < now && !archived) out.push({ key: "next_overdue", tone: "warn", text: "Срок «что дальше» прошёл" });
  const last = lastEventAt ?? (s.lastActivityAt ? new Date(s.lastActivityAt) : null);
  if (!archived && card && card.status === "ACTIVE" && last && now.getTime() - last.getTime() > 14 * 86400000) out.push({ key: "stale", tone: "neutral", text: `Нет движения ${Math.floor((now.getTime() - last.getTime()) / 86400000)} дн.` });
  return out;
}

export function alertsTone(list: Alert[]): "danger" | "warn" | "neutral" | "ok" {
  if (list.some((a) => a.tone === "danger")) return "danger";
  if (list.some((a) => a.tone === "warn")) return "warn";
  return list.length ? "neutral" : "ok";
}
