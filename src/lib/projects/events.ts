/**
 * История проекта пишется сама: хуки из конвейеров (прогон, публикация, экспорт) и из ручных действий CRM.
 * Все функции «молчаливые»: ошибка истории никогда не ломает основную работу.
 */
import { prisma } from "@/lib/db";

export type EventKind =
  | "run_created" | "run_done" | "run_failed" | "export_downloaded" | "export_uploaded" | "export_unmarked" | "export_upload_failed" | "export_verified"
  | "article_published" | "blog_published"
  | "status_changed" | "owner_changed" | "step_changed" | "strategy_changed" | "cluster_changed"
  | "task_created" | "task_done" | "finance_added" | "card_changed" | "note";

export const EVENT_LABELS: Record<EventKind, string> = {
  run_created: "Прогон пинов запущен", run_done: "Прогон пинов завершён", run_failed: "Прогон пинов упал",
  export_downloaded: "Выгрузка скачана", export_uploaded: "Залито в Pinterest", export_unmarked: "Отметка заливки снята",
  export_upload_failed: "Заливка не удалась", export_verified: "Заливка проверена",
  article_published: "Статья опубликована", blog_published: "Блоговая статья опубликована",
  status_changed: "Статус проекта", owner_changed: "Ответственный", step_changed: "Этап", strategy_changed: "Стратегии", cluster_changed: "Кластер",
  task_created: "Задача создана", task_done: "Задача закрыта", finance_added: "Финансы", card_changed: "Карточка", note: "Заметка",
};

/** Группы для фильтра ленты. */
export const EVENT_GROUPS: Record<string, { label: string; kinds: EventKind[] }> = {
  pins: { label: "Пины", kinds: ["run_created", "run_done", "run_failed", "export_downloaded", "export_uploaded", "export_unmarked", "export_upload_failed", "export_verified"] },
  articles: { label: "Статьи", kinds: ["article_published", "blog_published"] },
  changes: { label: "Изменения", kinds: ["status_changed", "owner_changed", "step_changed", "strategy_changed", "cluster_changed", "task_created", "task_done", "card_changed"] },
  finance: { label: "Финансы", kinds: ["finance_added"] },
  notes: { label: "Заметки", kinds: ["note"] },
};

export type EventInput = { kind: EventKind; summary: string; refId?: string | null; userId?: string | null; at?: Date; payload?: unknown };

/** Карточка по доступу; создаётся без истории (бэкфил делает ensureCard при первом открытии). */
async function cardIdForAccess(accessId: string): Promise<string | null> {
  const card = await prisma.prjCard.findUnique({ where: { accessId }, select: { id: true } });
  if (card) return card.id;
  const exists = await prisma.siteAccess.findUnique({ where: { id: accessId }, select: { id: true } });
  if (!exists) return null;
  const created = await prisma.prjCard.upsert({ where: { accessId }, update: {}, create: { accessId }, select: { id: true } });
  return created.id;
}

export async function logEventByCard(cardId: string, e: EventInput): Promise<void> {
  try {
    await prisma.prjEvent.create({ data: { cardId, kind: e.kind, summary: e.summary, refId: e.refId ?? null, userId: e.userId ?? null, at: e.at ?? new Date(), payload: e.payload === undefined ? undefined : (e.payload as object) } });
  } catch { /* история не должна ломать работу */ }
}

export async function logEventByAccess(accessId: string | null | undefined, e: EventInput): Promise<void> {
  if (!accessId) return;
  try {
    const cardId = await cardIdForAccess(accessId);
    if (cardId) await logEventByCard(cardId, e);
  } catch { /* тихо */ }
}

/** Событие по сайту пинов (PinSite → доступ). */
export async function logEventByPinSite(pinSiteId: string | null | undefined, e: EventInput): Promise<void> {
  if (!pinSiteId) return;
  try {
    const s = await prisma.pinSite.findUnique({ where: { id: pinSiteId }, select: { wpConnectionId: true } });
    await logEventByAccess(s?.wpConnectionId, e);
  } catch { /* тихо */ }
}

export async function logEventByArtSite(artSiteId: string | null | undefined, e: EventInput): Promise<void> {
  if (!artSiteId) return;
  try {
    const s = await prisma.artSite.findUnique({ where: { id: artSiteId }, select: { accessId: true } });
    await logEventByAccess(s?.accessId, e);
  } catch { /* тихо */ }
}

export async function logEventByBlogSite(blogSiteId: string | null | undefined, e: EventInput): Promise<void> {
  if (!blogSiteId) return;
  try {
    const s = await prisma.blogSite.findUnique({ where: { id: blogSiteId }, select: { accessId: true } });
    await logEventByAccess(s?.accessId, e);
  } catch { /* тихо */ }
}

/** Готовые тексты для хуков конвейеров (одной строкой). Деньги в текст не кладём — только в payload.costUsd: их видят лишь главные админы. */
export const eventText = {
  runCreated: (name: string, pages: number) => `Прогон «${name || "без имени"}»: ${pages} стат.`,
  runDone: (name: string, pins: number) => `Прогон «${name || "без имени"}» готов: ${pins} пинов`,
  runFailed: (name: string, reason: string | null) => `Прогон «${name || "без имени"}» остановлен${reason ? `: ${reason.slice(0, 160)}` : ""}`,
  exportDownloaded: (day: string, rows: number, fileName: string) => `Скачан файл за ${day}: ${rows} пинов (${fileName})`,
  exportUploaded: (day: string) => `Залито в Pinterest: файл за ${day}`,
  exportUploadedAuto: (day: string, rows: number, agent: string) => `Залито в Pinterest автоматически: файл за ${day}, ${rows} пинов (агент ${agent})`,
  exportUploadFailed: (day: string, reason: string) => `Автозаливка за ${day} не удалась: ${reason.slice(0, 160)}`,
  exportVerified: (day: string, published: number | null, failed: number | null) => `Проверка в Pinterest за ${day}: ${published == null ? "статус не прочитан" : `опубликовано ${published}`}${failed ? `, ошибок ${failed}` : ""}`,
  articlePublished: (keyword: string, url: string | null) => `«${keyword}» опубликована${url ? ` — ${url}` : ""}`,
};
