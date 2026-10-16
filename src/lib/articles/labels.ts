/** Единый словарь статусов статьи на русском (используется в таблицах, карточке, фильтрах). */
import type { ArtStatus } from "@prisma/client";

export type Tone = "muted" | "info" | "ok" | "warn" | "danger";

export const STATUS_LABELS: Record<ArtStatus, { label: string; tone: Tone; help: string }> = {
  PENDING: { label: "В очереди", tone: "muted", help: "Ждёт воркера. Запустится, когда есть свободные места по лимитам сайта." },
  RUNNING: { label: "В работе", tone: "info", help: "Воркер выполняет этап." },
  PHOTO_REVIEW: { label: "Модерация фото", tone: "warn", help: "Фото отобраны, ждут одобрения человеком или ИИ. Текст пишется после одобрения." },
  INSUFFICIENT_PHOTOS: { label: "Мало фото", tone: "danger", help: "Модератор отметил, что подходящих кадров не хватает. Решение: добрать или закрыть." },
  WAITING_FOR_PHOTOS: { label: "Не хватило фото", tone: "danger", help: "После всех кругов добора меньше 15 подходящих кадров. Можно повторить поиск позже." },
  REVIEW_PENDING: { label: "Модерация статьи", tone: "warn", help: "Статья собрана, ждёт проверки перед публикацией." },
  NEEDS_REWORK: { label: "В доработку", tone: "danger", help: "Модератор вернул статью с замечанием." },
  PUBLISH_QUEUED: { label: "К публикации", tone: "info", help: "Одобрена, ждёт очереди публикации." },
  PUBLISHING: { label: "Публикуется", tone: "info", help: "Загрузка фото и создание поста в WordPress." },
  COMPLETED: { label: "Опубликована", tone: "ok", help: "Пост создан на сайте." },
  PUBLISH_ERROR: { label: "Ошибка публикации", tone: "danger", help: "WordPress не принял пост или фото. Повторите после проверки сайта." },
  FAILED: { label: "Ошибка", tone: "danger", help: "Этап завершился ошибкой. Подробности — в карточке статьи." },
  PAUSED: { label: "Пауза", tone: "muted", help: "Остановлена вручную или из-за серии сбоев сайта." },
  STOPPED: { label: "Остановлена", tone: "muted", help: "Остановлена пользователем." },
};

export const statusLabel = (s: ArtStatus) => STATUS_LABELS[s]?.label ?? s;

/** Статусы, в которых статья ждёт человека. */
export const HUMAN_STATUSES: ArtStatus[] = ["PHOTO_REVIEW", "INSUFFICIENT_PHOTOS", "REVIEW_PENDING", "NEEDS_REWORK"];
/** Статусы, которые воркер может подхватить. */
export const QUEUE_STATUSES: ArtStatus[] = ["PENDING"];
/** «Живые» статусы — ещё не закончены. */
export const ACTIVE_STATUSES: ArtStatus[] = ["PENDING", "RUNNING", "PHOTO_REVIEW", "INSUFFICIENT_PHOTOS", "REVIEW_PENDING", "NEEDS_REWORK", "PUBLISH_QUEUED", "PUBLISHING"];
