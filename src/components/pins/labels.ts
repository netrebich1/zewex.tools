import type { PinRunStatus } from "@prisma/client";
import type { PinStage } from "@/lib/pins/types";

export const RUN_STATUS_LABELS: Record<PinRunStatus, string> = {
  DRAFT: "Черновик",
  QUEUED: "В очереди",
  RUNNING: "Работает",
  WAITING_MODERATION: "Модерация",
  BLOCKED: "Проблема",
  STOPPED: "Пауза",
  DONE: "Готов",
  FAILED: "Ошибка",
};

export function runStatusTone(s: PinRunStatus): "neutral" | "ok" | "warn" | "danger" | "brand" | "ink" {
  switch (s) {
    case "RUNNING": case "QUEUED": return "brand";
    case "WAITING_MODERATION": return "warn";
    case "BLOCKED": case "FAILED": return "danger";
    case "DONE": return "ok";
    default: return "neutral";
  }
}

export const STAGE_LABELS: Record<PinStage, string> = {
  pages: "Ссылки",
  meta: "Ключи и доски",
  photos: "Фото",
  plan: "План",
  prompts: "Промты",
  images: "Картинки",
  canvas: "Canvas",
  moderation: "Модерация",
  texts: "Тексты",
  upload: "WordPress",
  schedule: "Расписание",
  ready: "Готов",
};

export const ENGINE_LABELS: Record<string, string> = { OPENAI: "ИИ-пины", PINORA: "Pinora", CANVAS: "Canvas", PHOTO: "Фото", ALL: "Всего" };
