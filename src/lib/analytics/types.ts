/** Трафик сайтов (Google Analytics 4): константы и общие типы. Инструмент — проект `analytics`, страницы /analytics. */

export const ANALYTICS = "analytics";

/** Сколько истории тянем при подключении сайта (дней назад от сегодня в поясе свойства). */
export const BACKFILL_DAYS = { daily: 400, dims: 400, hourly: 90, pages: 120 } as const;
/** Сколько строк страниц сохраняем на день (топ по просмотрам). */
export const PAGES_PER_DAY = 1000;
/** Строк страниц за день сколько запрашиваем у GA (одна страница может прийти с несколькими заголовками). */
export const PAGES_FETCH_ROWS = 2500;
/** Сколько дней страниц загружаем за один проход воркера при первичной загрузке. */
export const PAGES_BACKFILL_STEP = 10;
/** Разрезы, которые храним по дням. */
export const DIM_KINDS = ["channel", "source", "country", "device", "referrer"] as const;
export type DimKind = (typeof DIM_KINDS)[number];
/** Строк на разрез за один запрос по диапазону дат. */
export const DIMS_ROWS_LIMIT = 100_000;
/** Сколько дней назад перечитываем при обычной синхронизации (GA досчитывает данные ~48 часов). */
export const RESYNC_DAYS = 3;
/** Пауза между обычными синхронизациями одного сайта (минуты). */
export const SYNC_INTERVAL_MIN = Number(process.env.GA_SYNC_INTERVAL_MIN || 60);
/** Данные старше этого срока удаляются (кроме дневных итогов). */
export const KEEP_HOURLY_DAYS = 400;
export const KEEP_PAGES_DAYS = 400;
export const KEEP_DIMS_DAYS = 400;
/** «Сегодня» для сводок по нескольким сайтам (у одного сайта берём пояс свойства). */
export const DEFAULT_TZ = process.env.GA_DEFAULT_TZ || "Europe/Kyiv";

export type SyncState = { dailyFrom?: string; hourlyFrom?: string; pagesFrom?: string; dimsFrom?: string };

export const DIM_LABELS: Record<DimKind, string> = {
  channel: "Каналы",
  source: "Источники",
  country: "Страны",
  device: "Устройства",
  referrer: "Переходы с сайтов",
};

/** Подписи каналов GA4 по-русски (остальные остаются как есть). */
export const CHANNEL_LABELS: Record<string, string> = {
  "Organic Search": "Поиск",
  Direct: "Прямые заходы",
  "Organic Social": "Соцсети",
  "Paid Social": "Соцсети (реклама)",
  Referral: "Переходы с сайтов",
  "Paid Search": "Поиск (реклама)",
  Email: "Почта",
  Display: "Медийная реклама",
  "Organic Video": "Видео",
  "Paid Video": "Видео (реклама)",
  "Paid Other": "Другая реклама",
  Affiliates: "Партнёрки",
  Audio: "Аудио",
  SMS: "SMS",
  "Mobile Push Notifications": "Push-уведомления",
  "Cross-network": "Кросс-сеть",
  "Paid Shopping": "Шопинг (реклама)",
  "Organic Shopping": "Шопинг",
  Unassigned: "Не определено",
};

export const DEVICE_LABELS: Record<string, string> = { desktop: "Компьютер", mobile: "Телефон", tablet: "Планшет", "smart tv": "Smart TV" };

export const GROUP_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
