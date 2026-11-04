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

/**
 * Модели OpenRouter по стенду 2026-11-04 (scripts/deepl/model-bench.ts, 28 моделей, украинские промты, docs/deepl/bench-2026-11-04.md):
 * постредактура — gpt-5.6-luna ($0.20/$1.20 за 1M, ≈$0.015 за проход по статье): все секции приняты, правки точечные и по делу
 * (каблучка/покриття/смуга), ни одного русизма. Дешевле и приемлемо: mistral-small-3.2 (≈$0.004, медленная), deepseek-v4.1-flash (≈$0.006).
 * deepseek-v4-flash с ноября 2026 добавляет русизмы в украинский текст — не брать. Gemini: 2.5-flash-lite почти не правит,
 * 3.5-flash-lite возвращает формулировки оригинала и меняет лицо, 3.5+ flash дороги (reasoning) и переписывают.
 * H2 — gpt-6-luna ($0.10/$0.50): держит формулу промта «сущность + кут», без выдуманных обещаний и штампов.
 */
export const RECOMMENDED_MODELS = { edit: "openai/gpt-5.6-luna", headings: "openai/gpt-6-luna" } as const;
/** Модели, которые при копировании прогона заменяются рекомендованными (стенд 2026-11-04: добавляют русизмы). */
export const DEPRECATED_MODELS: Record<string, string> = { "deepseek/deepseek-v4-flash": RECOMMENDED_MODELS.edit };
/** Оценка качества итога: отдельная недорогая модель, не та, что правила (меньше самооценки). */
export const JUDGE_MODEL = "openai/gpt-6-luna";

/**
 * Пакет «качество текста» (2026-11-04, разбор стенда): после постредактуры оставались смешение «ти/ви», канцелярит
 * из немецкого звена перевода и мелкие сдвиги фактов. address/glossary — внутри постредактуры, style — отдельный этап,
 * judge — оценка итога по секциям (баллы мова/факти/терміни/звертання/стиль и цитаты) на странице прогона.
 */
export type QualitySettings = { address: boolean; glossary: boolean; style: boolean; judge: boolean; judgeModel: string };

export type DeeplSettings = {
  translateSteps: TranslateStep[];
  headings: { enabled: boolean; promptId: string; prompt: string };
  postEdit: { enabled: boolean; promptId: string; prompt: string };
  /** Добор ключей после постредактуры: авто-ключи из исходника + ручной список, коридор % от числа вхождений в исходнике */
  seo: { enabled: boolean; auto: boolean; keywords: string[]; minPct: number; maxPct: number };
  /** Модель OpenRouter для постредактуры и добора ключей; пусто — модель правила ключа */
  model: string;
  /** Модель OpenRouter для заголовков H2; пусто — как `model` */
  headingsModel: string;
  publish: { enabled: boolean; target: "source" | "new"; status: "draft" | "pending" | "publish" };
  quality: QualitySettings;
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
  model: RECOMMENDED_MODELS.edit,
  headingsModel: RECOMMENDED_MODELS.headings,
  publish: { enabled: false, target: "source", status: "draft" },
  quality: { address: true, glossary: true, style: true, judge: true, judgeModel: JUDGE_MODEL },
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
  style: "стиль",
  judge: "оценка качества",
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

/** Оценка качества итоговой статьи (1–5 по шкалам) с цитатами; считается по секциям и усредняется. */
export type QualityIssueNote = { k: string; q: string; fix: string; section?: number };
export type QualityReport = {
  model: string;
  sections: number;
  scores: { mova: number; fakty: number; terminy: number; zvertannia: number; styl: number };
  /** среднее по пяти шкалам */
  total: number;
  issues: QualityIssueNote[];
  /** метрики кода: русизмы, штампы, обращение в исходнике и итоге */
  metrics: { russianisms: number; clichesSource: number; clichesFinal: number; addressSource: string | null; addressFinal: string | null; addressMixed: boolean };
  costUsd: number;
};
export const QUALITY_LABELS: Record<keyof QualityReport["scores"], string> = { mova: "мова", fakty: "факты", terminy: "термины", zvertannia: "обращение", styl: "стиль" };
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
  const q = (s.quality ?? {}) as Partial<QualitySettings>;
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
    headingsModel: typeof s.headingsModel === "string" ? s.headingsModel.trim() : "",
    publish: {
      enabled: bool(pub.enabled, false),
      target: pub.target === "new" ? "new" : "source",
      status: pub.status === "publish" || pub.status === "pending" ? pub.status : "draft",
    },
    quality: {
      address: bool(q.address, true),
      glossary: bool(q.glossary, true),
      style: bool(q.style, true),
      judge: bool(q.judge, true),
      judgeModel: typeof q.judgeModel === "string" && q.judgeModel.trim() ? q.judgeModel.trim() : JUDGE_MODEL,
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
  if (s.postEdit.enabled && s.quality.style) parts.push("стиль");
  if (s.seo.enabled && s.postEdit.enabled) parts.push(`ключи ${s.seo.minPct}–${s.seo.maxPct}%`);
  if (s.postEdit.enabled && s.quality.judge) parts.push("оценка");
  if (s.publish.enabled) parts.push(`публикация (${s.publish.target === "source" ? "в исходный пост" : "новым постом"}, ${s.publish.status})`);
  return parts.join(" · ") || "без этапов";
}
