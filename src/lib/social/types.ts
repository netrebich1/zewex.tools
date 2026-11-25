/**
 * «Соцсети» (раздел Discovery, проект `social`): из статей сайта — посты под каждую соцсеть и файлы импорта Metricool.
 * Pinterest здесь нет намеренно: пины делает сервис пинов.
 */
export const PROJECT_SLUG = "social";
export const BASE_PATH = "/discovery/social";
export const SLOT_TEXT = "text_main";
export const MAX_RUN_ITEMS = 300;
export const ITEM_LEASE_SECONDS = 600;
/** Metricool советует не больше 50 постов в файле: большие файлы импортируются медленно или с ошибками. */
export const ROWS_PER_FILE = 50;

export type NetworkKey = "instagram" | "threads" | "x" | "facebook" | "tiktok" | "linkedin" | "bluesky" | "gbp" | "ig_reel" | "tiktok_video" | "yt_short" | "fb_reel";

export type NetworkSpec = {
  key: NetworkKey;
  label: string;
  /** Варианты названия колонки-флага сети в шаблоне Metricool (сравнение без регистра и пробелов). */
  column: string[];
  /** Лимит знаков текста поста (вместе со ссылкой и хэштегами). */
  maxChars: number;
  /** Сколько фото сеть принимает в одном посте. */
  maxImages: number;
  /** Ссылка в тексте кликабельна — ставим её в пост. Иначе ссылку в текст не пишем. */
  linkInText: boolean;
  /** Без фото пост в эту сеть не уходит. */
  needsImage: boolean;
  /** Видео-формат: пост = ролик из фото статьи с озвучкой и субтитрами (src/lib/social/video.ts). */
  video?: boolean;
  hashtags: [number, number];
  /** Как писать именно для этой сети — уходит в промпт. */
  style: string;
};

export const NETWORKS: NetworkSpec[] = [
  { key: "instagram", label: "Instagram", column: ["Instagram"], maxChars: 2200, maxImages: 10, linkInText: false, needsImage: true, hashtags: [5, 10],
    style: "Карусель из фото статьи. Первая строка — зацепка до 120 знаков (её видно до «ещё»). Дальше 3–6 коротких абзацев с пользой из статьи, пустая строка между абзацами. Ссылки в тексте не кликаются — в конце призыв «полная статья по ссылке в профиле». Хэштеги отдельным блоком в конце." },
  { key: "threads", label: "Threads", column: ["Threads"], maxChars: 500, maxImages: 10, linkInText: true, needsImage: false, hashtags: [0, 1],
    style: "Разговорная реплика от первого лица, как мнение или наблюдение, 1–3 коротких абзаца. Заканчивается вопросом к читателям или спорным утверждением. Без списка хэштегов, максимум один тег-тема." },
  { key: "x", label: "X (Twitter)", column: ["Twitter/X", "Twitter", "X"], maxChars: 280, maxImages: 4, linkInText: true, needsImage: false, hashtags: [0, 2],
    style: "Один твит: самый сильный факт или вывод статьи одной-двумя фразами. Телеграфный стиль, без вступлений. Ссылка в конце." },
  { key: "facebook", label: "Facebook", column: ["Facebook"], maxChars: 1200, maxImages: 10, linkInText: true, needsImage: false, hashtags: [0, 3],
    style: "2–4 абзаца: зацепка, что человек узнает из статьи, 2–3 конкретных пункта, призыв перейти по ссылке. Тон дружелюбный, как пост страницы журнала." },
  { key: "tiktok", label: "TikTok (фото)", column: ["TikTok"], maxChars: 2000, maxImages: 35, linkInText: false, needsImage: true, hashtags: [3, 6],
    style: "Подпись к фото-карусели: 1–2 живые фразы, затем хэштеги. Ссылки не кликаются — не писать их." },
  { key: "linkedin", label: "LinkedIn", column: ["LinkedIn"], maxChars: 3000, maxImages: 9, linkInText: true, needsImage: false, hashtags: [3, 5],
    style: "Экспертный пост: тезис в первой строке, 3–5 коротких абзацев с выводами, в конце ссылка и 3–5 хэштегов. Без канцелярита." },
  { key: "bluesky", label: "Bluesky", column: ["Bluesky"], maxChars: 300, maxImages: 4, linkInText: true, needsImage: false, hashtags: [0, 2],
    style: "Короткая реплика как в X: один сильный факт или вывод, ссылка в конце." },
  { key: "gbp", label: "Google Business Profile", column: ["GBP", "Google Business Profile"], maxChars: 1500, maxImages: 1, linkInText: true, needsImage: false, hashtags: [0, 0],
    style: "Новость компании: 2–3 предложения по делу, без хэштегов и эмодзи, ссылка в конце." },
  { key: "ig_reel", label: "Instagram Reels (видео)", column: ["Instagram"], maxChars: 2200, maxImages: 1, linkInText: false, needsImage: true, video: true, hashtags: [4, 8],
    style: "Подпись к Reels: первая строка — зацепка, 1–2 коротких абзаца о том, что в ролике, призыв «полная статья по ссылке в профиле»." },
  { key: "tiktok_video", label: "TikTok (видео)", column: ["TikTok"], maxChars: 2000, maxImages: 1, linkInText: false, needsImage: true, video: true, hashtags: [3, 6],
    style: "Подпись к видео TikTok: одна-две живые фразы и вопрос к зрителям. Ссылок не писать." },
  { key: "yt_short", label: "YouTube Shorts", column: ["YouTube"], maxChars: 5000, maxImages: 1, linkInText: true, needsImage: true, video: true, hashtags: [2, 4],
    style: "Описание Shorts: 2–3 предложения с ключевыми словами темы — о чём ролик и что зритель узнает. В конце система добавит ссылку на статью." },
  { key: "fb_reel", label: "Facebook Reels (видео)", column: ["Facebook"], maxChars: 2200, maxImages: 1, linkInText: false, needsImage: true, video: true, hashtags: [0, 3],
    style: "Подпись к Reels на Facebook: 1–2 дружелюбные фразы о пользе ролика и вопрос к подписчикам." },
];

export const networkOf = (key: string): NetworkSpec | undefined => NETWORKS.find((n) => n.key === key);
/** Сети владельца в Metricool (2026-11-11): Facebook, Instagram, Threads, TikTok, LinkedIn, Google Business; X пока не нужен. */
export const DEFAULT_NETWORKS: NetworkKey[] = ["instagram", "threads", "facebook", "tiktok", "linkedin", "gbp"];

export type SocialSettings = {
  networks: NetworkKey[];
  /** auto — язык статьи; иначе название языка для модели («украинский», «English»). */
  language: string;
  /** Дополнительные пожелания редакции к текстам. */
  notes: string;
  emoji: boolean;
  /** Сколько фото статьи брать в пост (сверху ещё лимит сети). */
  maxImages: number;
  schedule: {
    /** yyyy-mm-dd — первый день публикаций. */
    startDate: string;
    /** Статей в день: каждая статья выходит во все выбранные сети в свой день. */
    perDay: number;
    /** Окно публикаций, часы по времени бренда в Metricool. */
    fromHour: number;
    toHour: number;
  };
  /** Модель OpenRouter; пусто — модель правила слота. */
  model: string;
  /** Имя бренда в Metricool (колонка Brand name); пусто — текущий бренд при импорте. */
  brand: string;
  /** Импортировать черновиками (колонка Draft). */
  draft: boolean;
  /** Голос озвучки видео (OpenAI TTS). */
  voice: string;
  /** Категория YouTube для Shorts — обязательная колонка Metricool (значение из списка в его шаблоне). */
  ytCategory: string;
  /** Дописывать к ссылке utm_source=<сеть>&utm_medium=social — переходы видны в аналитике по сетям. */
  utm: boolean;
};

const clamp = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

export function todayKyiv(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

export function parseSettings(raw: unknown): SocialSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sch = (r.schedule && typeof r.schedule === "object" ? r.schedule : {}) as Record<string, unknown>;
  const nets = (Array.isArray(r.networks) ? r.networks : DEFAULT_NETWORKS).map(String).filter((k): k is NetworkKey => !!networkOf(k));
  const fromHour = clamp(sch.fromHour, 0, 22, 9);
  const start = String(sch.startDate ?? "");
  return {
    networks: [...new Set(nets)],
    language: String(r.language ?? "auto").trim().slice(0, 40) || "auto",
    notes: String(r.notes ?? "").trim().slice(0, 2000),
    emoji: r.emoji !== false,
    maxImages: clamp(r.maxImages, 1, 10, 5),
    schedule: {
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : todayKyiv(),
      perDay: clamp(sch.perDay, 1, 50, 3),
      fromHour,
      toHour: Math.max(fromHour + 1, clamp(sch.toHour, 1, 23, 21)),
    },
    model: String(r.model ?? "").trim().slice(0, 120),
    brand: String(r.brand ?? "").trim().slice(0, 120),
    draft: r.draft === true,
    utm: r.utm !== false,
    voice: String(r.voice ?? "coral").trim().slice(0, 20) || "coral",
    ytCategory: String(r.ytCategory ?? "HOWTO_AND_STYLE").trim().toUpperCase().replace(/[^A-Z_&]/g, "_").slice(0, 40) || "HOWTO_AND_STYLE",
  };
}

/** Пост статьи для одной сети. */
/** Для видео-сетей: images[0] — ссылка на mp4, poster — кадр-обложка, title/tags — для YouTube, script — сцены (экран / голос). */
export type SocialPost = { text: string; firstComment?: string; images: string[]; alts: string[]; trimmed?: boolean; skipped?: string; edited?: boolean; video?: boolean; poster?: string; title?: string; tags?: string[]; durationSec?: number; script?: { text: string; voice: string }[] };
export type SocialPosts = Partial<Record<NetworkKey, SocialPost>>;

export type ArticleImageRef = { url: string; alt: string };

export const RUN_STATUS_LABELS: Record<string, string> = { QUEUED: "В очереди", RUNNING: "В работе", DONE: "Готов", FAILED: "Ошибка" };
export const RUN_TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "brand"> = { QUEUED: "neutral", RUNNING: "brand", DONE: "ok", FAILED: "danger" };
export const ITEM_STATUS_LABELS: Record<string, string> = { pending: "Ждёт", processing: "Пишется", done: "Готово", error: "Ошибка" };
