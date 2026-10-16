/**
 * DeepL Articler (раздел Discovery): пакетная адаптация статей WordPress.
 * Цепочка: перевод DeepL до 3 шагов (напр. UK → EN-GB → DE → UK) → H2 → постредактура → добор SEO-ключей → публикация.
 * Перенос конвейера «article-jumble-maker» (Lovable/Supabase, supabase/functions/_shared/pipeline.ts + pipeline-worker)
 * без мешапа, вступления, мета-тегов, перелива картинок и обложек.
 */

export const PROJECT_SLUG = "deepl";
export const BASE_PATH = "/discovery/deepl";
/** Слот ключа ИИ для редактуры (правила портала, по умолчанию OpenRouter). */
export const EDIT_SLOT = "text_main";

/** Статей в одном прогоне — не больше. */
export const MAX_JOB_ITEMS = 500;

export type TranslateStep = { source: string; target: string };

export type DeeplSettings = {
  translateSteps: TranslateStep[];
  headings: { enabled: boolean; promptId: string; prompt: string };
  postEdit: { enabled: boolean; promptId: string; prompt: string };
  /** Добор ключей после постредактуры: авто-ключи из исходника + ручной список, коридор % от числа вхождений в исходнике */
  seo: { enabled: boolean; auto: boolean; keywords: string[]; minPct: number; maxPct: number };
  /** Модель OpenRouter для редактуры (`google/gemini-2.5-flash`); пусто — модель правила ключа */
  model: string;
  publish: { enabled: boolean; target: "source" | "new"; status: "draft" | "pending" | "publish" };
};

export const DEFAULT_SETTINGS: DeeplSettings = {
  translateSteps: [
    { source: "UK", target: "EN-GB" },
    { source: "EN", target: "DE" },
    { source: "DE", target: "UK" },
  ],
  headings: { enabled: true, promptId: "", prompt: "" },
  postEdit: { enabled: true, promptId: "", prompt: "" },
  seo: { enabled: true, auto: true, keywords: [], minPct: 25, maxPct: 70 },
  model: "",
  publish: { enabled: false, target: "source", status: "draft" },
};

/** Языки DeepL: исходные — базовые коды, целевые — с вариантами (EN-GB, EN-US, PT-BR…). */
export const DEEPL_LANGS: { code: string; name: string; targetOnly?: boolean }[] = [
  { code: "UK", name: "Украинский" },
  { code: "RU", name: "Русский" },
  { code: "EN", name: "Английский" },
  { code: "EN-GB", name: "Английский (британский)", targetOnly: true },
  { code: "EN-US", name: "Английский (американский)", targetOnly: true },
  { code: "DE", name: "Немецкий" },
  { code: "FR", name: "Французский" },
  { code: "ES", name: "Испанский" },
  { code: "IT", name: "Итальянский" },
  { code: "PL", name: "Польский" },
  { code: "PT-PT", name: "Португальский", targetOnly: true },
  { code: "PT-BR", name: "Португальский (Бразилия)", targetOnly: true },
  { code: "PT", name: "Португальский" },
  { code: "NL", name: "Нидерландский" },
  { code: "CS", name: "Чешский" },
  { code: "SK", name: "Словацкий" },
  { code: "BG", name: "Болгарский" },
  { code: "RO", name: "Румынский" },
  { code: "HU", name: "Венгерский" },
  { code: "LT", name: "Литовский" },
  { code: "LV", name: "Латышский" },
  { code: "ET", name: "Эстонский" },
  { code: "SL", name: "Словенский" },
  { code: "EL", name: "Греческий" },
  { code: "TR", name: "Турецкий" },
  { code: "SV", name: "Шведский" },
  { code: "DA", name: "Датский" },
  { code: "FI", name: "Финский" },
  { code: "NB", name: "Норвежский" },
];

export const WP_STATUSES: { value: string; label: string }[] = [
  { value: "draft", label: "Черновики" },
  { value: "publish", label: "Опубликованные" },
  { value: "pending", label: "На утверждении" },
  { value: "future", label: "Запланированные" },
  { value: "private", label: "Личные" },
];

export const JOB_STATUS_LABELS: Record<string, string> = {
  QUEUED: "В очереди",
  RUNNING: "Идёт",
  DONE: "Готово",
  FAILED: "Ошибка",
  STOPPED: "Остановлен",
};

export const ITEM_STATUS_LABELS: Record<string, string> = {
  pending: "Ждёт",
  processing: "В работе",
  done: "Готово",
  warning: "Проверить",
  error: "Ошибка",
  stopped: "Остановлена",
};

export const STAGE_LABELS: Record<string, string> = {
  pending: "в очереди",
  fetch: "загрузка из WordPress",
  translate: "перевод DeepL",
  headings: "заголовки H2",
  post_edit: "постредактура",
  keyword_topup: "добор ключей",
  publish: "публикация",
  publishing: "публикация",
  done: "готово",
  review: "нужна проверка",
};

/** Снимок версии статьи после этапа. */
export type Snapshot = {
  key: string;
  label: string;
  html: string;
  chars: number;
  changedWords?: number;
  status?: "changed" | "noop" | "partial";
};

export type Warning = { code: string; detail: string };
export type KeywordStat = { key: string; source: number; current: number; min: number; max: number; ok: boolean };

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const clamp = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : d;
};

/** Нормализация сохранённых настроек (старые записи и сценарии не ломаются). */
export function parseSettings(json: unknown): DeeplSettings {
  const s = (json ?? {}) as Partial<DeeplSettings> & Record<string, unknown>;
  const steps = Array.isArray(s.translateSteps)
    ? s.translateSteps
        .map((x) => ({ source: String((x as TranslateStep)?.source ?? "").toUpperCase(), target: String((x as TranslateStep)?.target ?? "").toUpperCase() }))
        .filter((x) => x.target)
        .slice(0, 3)
    : DEFAULT_SETTINGS.translateSteps;
  const h = (s.headings ?? {}) as Partial<DeeplSettings["headings"]>;
  const p = (s.postEdit ?? {}) as Partial<DeeplSettings["postEdit"]>;
  const seo = (s.seo ?? {}) as Partial<DeeplSettings["seo"]>;
  const pub = (s.publish ?? {}) as Partial<DeeplSettings["publish"]>;
  const minPct = clamp(seo.minPct, DEFAULT_SETTINGS.seo.minPct, 0, 100);
  return {
    translateSteps: steps,
    headings: { enabled: bool(h.enabled, false), promptId: String(h.promptId ?? ""), prompt: String(h.prompt ?? "") },
    postEdit: { enabled: bool(p.enabled, false), promptId: String(p.promptId ?? ""), prompt: String(p.prompt ?? "") },
    seo: {
      enabled: bool(seo.enabled, false),
      auto: bool(seo.auto, true),
      keywords: Array.isArray(seo.keywords) ? seo.keywords.map(String).map((k) => k.trim()).filter(Boolean).slice(0, 50) : [],
      minPct,
      maxPct: Math.max(minPct, clamp(seo.maxPct, DEFAULT_SETTINGS.seo.maxPct, 0, 200)),
    },
    model: typeof s.model === "string" ? s.model.trim() : "",
    publish: {
      enabled: bool(pub.enabled, false),
      target: pub.target === "new" ? "new" : "source",
      status: pub.status === "publish" || pub.status === "pending" ? pub.status : "draft",
    },
  };
}

/** Короткое описание цепочки для списков: «UK → EN-GB → DE → UK · H2 · постредактура · ключи». */
export function describeSettings(s: DeeplSettings): string {
  const parts: string[] = [];
  if (s.translateSteps.length) {
    const first = s.translateSteps[0]!.source || "авто";
    parts.push([first, ...s.translateSteps.map((x) => x.target)].join(" → "));
  }
  if (s.headings.enabled) parts.push("H2");
  if (s.postEdit.enabled) parts.push("постредактура");
  if (s.seo.enabled && s.postEdit.enabled) parts.push(`ключи ${s.seo.minPct}–${s.seo.maxPct}%`);
  if (s.publish.enabled) parts.push(`публикация (${s.publish.target === "source" ? "в исходный пост" : "новым постом"}, ${s.publish.status})`);
  return parts.join(" · ") || "без этапов";
}
