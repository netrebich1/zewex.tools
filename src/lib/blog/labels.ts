/** Единый словарь статусов инфо-статьи на русском. */
import type { BlogStatus } from "@prisma/client";

export type Tone = "muted" | "info" | "ok" | "warn" | "danger";

export const STATUS_LABELS: Record<BlogStatus, { label: string; tone: Tone; help: string }> = {
  PENDING: { label: "В очереди", tone: "muted", help: "Ждёт воркера. Запустится, когда есть свободные места по лимиту сайта." },
  RUNNING: { label: "В работе", tone: "info", help: "Воркер выполняет этап." },
  REVIEW_PENDING: { label: "На проверке", tone: "warn", help: "Статья собрана и ждёт человека: предпросмотр, замена фото, правка текста, публикация." },
  NEEDS_REWORK: { label: "В доработку", tone: "danger", help: "Возвращена с замечанием: план или текст пишутся заново." },
  PUBLISHING: { label: "Публикуется", tone: "info", help: "Загрузка фото и создание поста в WordPress." },
  COMPLETED: { label: "Опубликована", tone: "ok", help: "Пост создан на сайте." },
  PUBLISH_ERROR: { label: "Ошибка публикации", tone: "danger", help: "WordPress не принял пост или фото. Повторите после проверки сайта." },
  FAILED: { label: "Ошибка", tone: "danger", help: "Этап завершился ошибкой. Подробности — в карточке статьи." },
  STOPPED: { label: "Остановлена", tone: "muted", help: "Остановлена пользователем." },
};

export const statusLabel = (s: BlogStatus) => STATUS_LABELS[s]?.label ?? s;
