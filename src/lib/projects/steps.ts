/** Предзаданные этапы проекта: создаются в карточке при первом открытии; свои этапы добавляются кнопкой (key `custom:<slug>`). */
export const DEFAULT_STEPS: ReadonlyArray<{ key: string; title: string }> = [
  { key: "clusters", title: "Кластеры и ключи прописаны" },
  { key: "account", title: "Pinterest-аккаунт и доски готовы" },
  { key: "articles", title: "Статьи-подборки написаны" },
  { key: "blog", title: "Блоговые статьи написаны" },
  { key: "pins_setup", title: "Настройки пинов (стили, доски) сделаны" },
  { key: "pins", title: "Пины сделаны и залиты" },
];

export const STEP_STATES: Record<string, { label: string; tone: "neutral" | "ok" | "warn" | "brand" }> = {
  todo: { label: "не начато", tone: "neutral" },
  doing: { label: "в работе", tone: "brand" },
  done: { label: "сделано", tone: "ok" },
  skip: { label: "не нужно", tone: "neutral" },
};

export const PROJECT_STATUSES: ReadonlyArray<{ key: "NEW" | "SETUP" | "ACTIVE" | "PAUSED" | "DONE" | "ARCHIVED"; label: string; tone: "neutral" | "ok" | "warn" | "brand" | "danger" | "ink" }> = [
  { key: "NEW", label: "Новый", tone: "neutral" },
  { key: "SETUP", label: "Подготовка", tone: "brand" },
  { key: "ACTIVE", label: "В работе", tone: "ok" },
  { key: "PAUSED", label: "На паузе", tone: "warn" },
  { key: "DONE", label: "Готов", tone: "ink" },
  { key: "ARCHIVED", label: "Архив", tone: "neutral" },
];

export const statusLabel = (k: string) => PROJECT_STATUSES.find((s) => s.key === k)?.label ?? k;
export const statusTone = (k: string) => PROJECT_STATUSES.find((s) => s.key === k)?.tone ?? "neutral";

export const PIN_ACCOUNT_STATUSES: ReadonlyArray<{ key: string; label: string; tone: "neutral" | "ok" | "warn" | "danger" }> = [
  { key: "none", label: "нет аккаунта", tone: "neutral" },
  { key: "ok", label: "работает", tone: "ok" },
  { key: "limited", label: "ограничен", tone: "warn" },
  { key: "banned", label: "заблокирован", tone: "danger" },
];

export const FINANCE_CATEGORIES: ReadonlyArray<{ key: string; label: string; kind: "income" | "expense" | "both" }> = [
  { key: "domain", label: "Домен", kind: "expense" },
  { key: "hosting", label: "Хостинг", kind: "expense" },
  { key: "writer", label: "Копирайтер / фрилансер", kind: "expense" },
  { key: "ads", label: "Реклама", kind: "expense" },
  { key: "tools", label: "Сервисы и инструменты", kind: "expense" },
  { key: "affiliate", label: "Партнёрки", kind: "income" },
  { key: "adsense", label: "Реклама на сайте (AdSense и др.)", kind: "income" },
  { key: "sale", label: "Продажа / сделка", kind: "income" },
  { key: "other", label: "Другое", kind: "both" },
];
export const financeCategoryLabel = (k: string) => FINANCE_CATEGORIES.find((c) => c.key === k)?.label ?? k;

export const CLUSTER_STATUSES: ReadonlyArray<{ key: string; label: string; tone: "neutral" | "ok" | "brand" }> = [
  { key: "planned", label: "прописан", tone: "neutral" },
  { key: "written", label: "статья есть", tone: "brand" },
  { key: "pinned", label: "пины есть", tone: "ok" },
];
