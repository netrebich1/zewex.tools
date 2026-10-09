/**
 * Клиент WordPress REST API для сервиса Pinterest Pins.
 * Порт supabase/functions/bulk-upload-wp и bulk-wp-posts из legacy (Deno) на Node 24.
 *
 * Базовый URL сайта задаёт пользователь, поэтому ходим обычным fetch с Basic-авторизацией
 * (Application Password). Таймауты — через AbortSignal, повторы — с паузой 2000·(n+1) мс,
 * не больше 3 повторов. Загрузок в медиатеку одновременно не больше 3 (слабый хостинг
 * WP отдаёт 500 под нагрузкой).
 */

export type WpCreds = { baseUrl: string; username: string; appPassword: string };

export type WpRequestOptions = {
  signal?: AbortSignal;
  /** Таймаут одного HTTP-запроса. */
  timeoutMs?: number;
  /** Сколько раз повторять при сети/429/5xx (по умолчанию 3). */
  maxRetries?: number;
};

export type WpMediaFile = { data: Buffer; filename: string; mime: string };
export type WpMediaMeta = { title?: string; altText?: string; caption?: string };
export type WpMediaResult = { id: number; url: string; warning?: string };

export type WpPost = { id: number; url: string; title: string; date: string; featuredImage?: string };
export type WpTerm = { id: number; name: string; count: number };

export type WpListPostsParams = {
  perPage?: number;
  page?: number;
  /** yyyy-mm-dd (или полный ISO) — с какой даты. */
  after?: string;
  /** yyyy-mm-dd (или полный ISO) — по какую дату. */
  before?: string;
  categories?: number[];
  /** Инвертировать фильтр по категориям (categories_exclude). */
  excludeCategories?: boolean;
  tags?: number[];
  search?: string;
  status?: string;
  postType?: "posts" | "pages";
};

export class WpError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "WpError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 90_000;
const DEFAULT_RETRIES = 3;
const UPLOAD_CONCURRENCY = 3;
const USER_AGENT = "ZewexPins/1.0 (+https://zewex.tools)";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function codePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

/** Убрать теги и самые частые HTML-сущности из заголовков WP (title.rendered). */
export function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (m, d: string) => codePoint(Number(d), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => codePoint(parseInt(h, 16), m))
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Нормализует адрес сайта: добавляет https://, убирает хвостовые слэши и
 * случайно вставленный путь /wp-json… Возвращает origin + путь подкаталога (если WP в папке).
 */
export function normalizeBaseUrl(url: string): string {
  let s = url.trim();
  if (!s) throw new Error("Не указан адрес сайта WordPress");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Некорректный адрес сайта: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Недопустимый протокол: ${u.protocol}`);
  let path = u.pathname.replace(/\/wp-json(\/.*)?$/i, "").replace(/\/+$/, "");
  if (path === "/") path = "";
  return `${u.protocol}//${u.host}${path}`;
}

function apiUrl(creds: WpCreds, path: string): string {
  return `${normalizeBaseUrl(creds.baseUrl)}/wp-json/wp/v2${path}`;
}

function authHeader(creds: WpCreds): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`, "utf8").toString("base64")}`;
}

function cleanText(text: string, max = 200): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Сообщение об ошибке WP из JSON-тела ({code, message}) либо очищенный текст. */
function parseWpError(text: string): { message: string; code?: string } {
  try {
    const j: unknown = JSON.parse(text);
    if (isRecord(j) && typeof j.message === "string") {
      return { message: cleanText(j.message), code: typeof j.code === "string" ? j.code : undefined };
    }
  } catch {
    /* не JSON */
  }
  return { message: cleanText(text) };
}

type WpResponse = { status: number; text: string; headers: Headers };

/**
 * Один запрос к REST API с таймаутом и повторами. Повторяем только сетевые ошибки,
 * 429 и 5xx; 4xx отдаём сразу. Отмена через opts.signal повторов не вызывает.
 */
import { assertPublicUrl } from "../fetch";

async function wpRequest(
  creds: WpCreds,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit },
  opts: WpRequestOptions = {},
): Promise<WpResponse> {
  const url = apiUrl(creds, path);
  // Адрес сайта задаёт пользователь: не даём клиенту ходить в приватные сети (SSRF).
  await assertPublicUrl(url);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
  let lastError = "";
  let lastStatus = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Отменено");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
    const onOuter = () => ac.abort(opts.signal?.reason ?? new Error("aborted"));
    opts.signal?.addEventListener("abort", onOuter, { once: true });
    try {
      const res = await fetch(url, {
        method: init.method ?? "GET",
        redirect: "follow",
        headers: {
          Authorization: authHeader(creds),
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(init.headers ?? {}),
        },
        body: init.body,
        signal: ac.signal,
      });
      const text = await res.text();
      if (res.ok || (res.status < 500 && res.status !== 429)) {
        return { status: res.status, text, headers: res.headers };
      }
      lastStatus = res.status;
      lastError = parseWpError(text).message;
      if (attempt < maxRetries) {
        const retryAfter = Math.min(60, Number(res.headers.get("retry-after")) || 0);
        await sleep(Math.max(retryAfter * 1000, 2000 * (attempt + 1)));
        continue;
      }
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Отменено");
      lastStatus = 0;
      lastError = e instanceof Error ? (e.message === "timeout" ? `нет ответа за ${Math.round(timeoutMs / 1000)} с` : e.message) : String(e);
      if (attempt < maxRetries) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuter);
    }
  }

  const tries = maxRetries + 1;
  throw new WpError(
    lastStatus >= 500
      ? `Сайт не ответил (WP ${lastStatus}) после ${tries} попыток: сервер перегружен или не хватает памяти PHP. ${lastError}`.trim()
      : lastStatus === 429
        ? `Сайт ограничивает запросы (HTTP 429) — подождите минуту и повторите. ${lastError}`.trim()
        : `WP не ответил после ${tries} попыток: ${lastError}`,
    lastStatus,
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new WpError("WP вернул не JSON (проверьте адрес сайта и постоянные ссылки)", 0);
  }
}

/** Запрос, который должен вернуть 2xx и JSON. */
async function wpJson(creds: WpCreds, path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit }, opts?: WpRequestOptions): Promise<{ json: unknown; headers: Headers }> {
  const res = await wpRequest(creds, path, init, opts);
  if (res.status < 200 || res.status >= 300) {
    const err = parseWpError(res.text);
    throw new WpError(`WP ${res.status}: ${err.message}`, res.status, err.code);
  }
  return { json: parseJson(res.text), headers: res.headers };
}

/* ------------------------------ проверка доступа ------------------------------ */

/** GET /users/me — проверяет логин и Application Password, ничего не загружая. */
export async function testConnection(creds: WpCreds, opts: WpRequestOptions = {}): Promise<{ ok: boolean; note: string; user?: string }> {
  try {
    normalizeBaseUrl(creds.baseUrl);
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
  if (!creds.username.trim() || !creds.appPassword.trim()) return { ok: false, note: "Не указаны логин или пароль приложения" };

  let res: WpResponse;
  try {
    res = await wpRequest(creds, "/users/me?context=edit", {}, { maxRetries: 1, ...opts });
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, note: `Доступ отклонён (HTTP ${res.status}): проверьте логин и пароль приложения. ${parseWpError(res.text).message}`.trim() };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, note: `WP ${res.status}: ${parseWpError(res.text).message}` };
  }
  let user = "";
  let canUpload = true;
  try {
    const j = parseJson(res.text);
    if (isRecord(j)) {
      user = str(j.name) || str(j.slug);
      if (isRecord(j.capabilities) && j.capabilities.upload_files === false) canUpload = false;
    }
  } catch {
    return { ok: false, note: "WP вернул не JSON (проверьте адрес сайта и постоянные ссылки)" };
  }
  const note = canUpload
    ? `Подключение работает${user ? `, пользователь ${user}` : ""}`
    : `Подключение работает (${user}), но у пользователя нет права загружать файлы (upload_files)`;
  return { ok: true, note, user: user || undefined };
}

/* ------------------------------ медиатека ------------------------------ */

/** Имя файла для Content-Disposition: ASCII, без кавычек; расширение сохраняется. */
export function safeFilename(name: string, fallbackExt = "jpg"): string {
  const trimmed = name.trim();
  const m = trimmed.match(/^(.*?)(?:\.([a-z0-9]{2,5}))?$/i);
  const base = (m?.[1] ?? trimmed)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
  const ext = (m?.[2] ?? fallbackExt).toLowerCase();
  return `${base || "pin"}.${ext}`;
}

function extForMime(mime: string): string {
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "image/avif") return "avif";
  return "bin";
}

/** Копия Buffer в отдельный ArrayBuffer (BodyInit без пула Buffer и SharedArrayBuffer). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/**
 * POST /media бинарным телом с Content-Disposition: attachment (как в legacy),
 * затем best-effort обновление alt_text / title / caption. Возвращает id и source_url.
 */
export async function uploadMedia(
  creds: WpCreds,
  file: WpMediaFile,
  meta: WpMediaMeta = {},
  opts: { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number } = {},
): Promise<WpMediaResult> {
  if (!file.data.byteLength) throw new Error("Пустой файл для загрузки");
  const filename = safeFilename(file.filename, extForMime(file.mime));
  const reqOpts: WpRequestOptions = { signal: opts.signal, timeoutMs: opts.timeoutMs ?? UPLOAD_TIMEOUT_MS, maxRetries: opts.maxRetries };

  const res = await wpRequest(
    creds,
    "/media",
    {
      method: "POST",
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: toArrayBuffer(file.data),
    },
    reqOpts,
  );
  if (res.status < 200 || res.status >= 300) {
    const err = parseWpError(res.text);
    const hint =
      res.status === 401 || res.status === 403
        ? "Нет прав на загрузку: проверьте пароль приложения и роль пользователя. "
        : res.status === 413
          ? "Файл больше лимита хостинга (upload_max_filesize / client_max_body_size). "
          : "";
    throw new WpError(`WP ${res.status}: ${hint}${err.message}`.trim(), res.status, err.code);
  }

  const json = parseJson(res.text);
  if (!isRecord(json)) throw new WpError("WP вернул неожиданный ответ при загрузке", res.status);
  const id = num(json.id);
  const url = str(json.source_url);
  if (!id || !url) throw new WpError("WP не вернул id/source_url загруженного файла", res.status);

  // Подписи ставим отдельным запросом (так делает и legacy): ошибка здесь не ломает загрузку.
  const patch: Record<string, string> = {};
  if (meta.altText !== undefined) patch.alt_text = meta.altText;
  if (meta.title !== undefined) patch.title = meta.title;
  if (meta.caption !== undefined) patch.caption = meta.caption;
  if (Object.keys(patch).length) {
    try {
      await wpRequest(
        creds,
        `/media/${id}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
        { signal: opts.signal, timeoutMs: DEFAULT_TIMEOUT_MS, maxRetries: 1 },
      );
    } catch (e) {
      console.warn("[wp] alt/title update failed", id, e instanceof Error ? e.message : e);
    }
  }

  const warning = /\.(webp|avif)(\?|$)/i.test(url)
    ? "Сайт отдал ссылку .webp/.avif — вероятно, плагин WP конвертирует загрузки. Отключите авто-конвертацию, чтобы получить прямой JPEG-URL."
    : undefined;
  return warning ? { id, url, warning } : { id, url };
}

/** Выполнить fn над элементами не более чем по `limit` одновременно, сохраняя порядок результатов. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type WpUploadItem<K = string> = { key: K; file: WpMediaFile; meta?: WpMediaMeta };
export type WpUploadOutcome<K = string> = { key: K; ok: true; id: number; url: string; warning?: string } | { key: K; ok: false; error: string };

/** Пакетная загрузка: не больше 3 одновременно; ошибка одного файла не останавливает остальные. */
export async function uploadMediaBatch<K = string>(
  creds: WpCreds,
  items: readonly WpUploadItem<K>[],
  opts: { signal?: AbortSignal; timeoutMs?: number; concurrency?: number; shouldStop?: () => boolean } = {},
): Promise<WpUploadOutcome<K>[]> {
  const concurrency = Math.min(opts.concurrency ?? UPLOAD_CONCURRENCY, UPLOAD_CONCURRENCY);
  return mapLimited(items, concurrency, async (it): Promise<WpUploadOutcome<K>> => {
    if (opts.signal?.aborted || opts.shouldStop?.()) return { key: it.key, ok: false, error: "Остановлено" };
    try {
      const r = await uploadMedia(creds, it.file, it.meta, { signal: opts.signal, timeoutMs: opts.timeoutMs });
      return r.warning ? { key: it.key, ok: true, id: r.id, url: r.url, warning: r.warning } : { key: it.key, ok: true, id: r.id, url: r.url };
    } catch (e) {
      return { key: it.key, ok: false, error: e instanceof Error ? e.message : "WordPress не принял файл" };
    }
  });
}

/* ------------------------------ список постов ------------------------------ */

function toIsoBoundary(value: string, end: boolean): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T${end ? "23:59:59" : "00:00:00"}`;
  return v;
}

function featuredFromEmbedded(p: Record<string, unknown>): string | undefined {
  const emb = p._embedded;
  if (!isRecord(emb)) return undefined;
  const arr = emb["wp:featuredmedia"];
  if (!Array.isArray(arr) || !arr.length) return undefined;
  const m: unknown = arr[0];
  if (!isRecord(m)) return undefined;
  const direct = str(m.source_url);
  if (direct) return direct;
  const details = m.media_details;
  if (isRecord(details) && isRecord(details.sizes)) {
    for (const key of ["large", "medium_large", "full"]) {
      const size = details.sizes[key];
      if (isRecord(size) && str(size.source_url)) return str(size.source_url);
    }
  }
  return undefined;
}

/**
 * Одна страница списка постов/страниц (порт bulk-wp-posts, action "posts"),
 * с `_embed=wp:featuredmedia` для главной картинки. Страница за пределами
 * диапазона (rest_post_invalid_page_number) возвращает пустой список, а не ошибку.
 */
export async function listPosts(
  creds: WpCreds,
  params: WpListPostsParams = {},
  opts: WpRequestOptions = {},
): Promise<{ posts: WpPost[]; totalPages: number; total: number }> {
  const postType = params.postType === "pages" ? "pages" : "posts";
  const perPage = Math.min(Math.max(Math.trunc(params.perPage ?? 100), 1), 100);
  const page = Math.max(Math.trunc(params.page ?? 1), 1);
  const qs = new URLSearchParams({
    per_page: String(perPage),
    page: String(page),
    status: params.status?.trim() || "publish",
    orderby: "date",
    order: "desc",
    _embed: "wp:featuredmedia",
    _fields: "id,link,title,date,featured_media,_links,_embedded",
  });
  const cats = (params.categories ?? []).filter((n) => Number.isFinite(n) && n > 0);
  const tags = (params.tags ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (postType === "posts" && cats.length) qs.set(params.excludeCategories ? "categories_exclude" : "categories", cats.join(","));
  if (postType === "posts" && tags.length) qs.set("tags", tags.join(","));
  if (params.after) qs.set("after", toIsoBoundary(params.after, false));
  if (params.before) qs.set("before", toIsoBoundary(params.before, true));
  if (params.search?.trim()) qs.set("search", params.search.trim());

  const res = await wpRequest(creds, `/${postType}?${qs.toString()}`, {}, opts);
  if (res.status === 400 && /rest_(post_)?invalid_page_number/.test(res.text)) {
    return { posts: [], totalPages: Math.max(page - 1, 0), total: 0 };
  }
  if (res.status < 200 || res.status >= 300) {
    const err = parseWpError(res.text);
    throw new WpError(`WP ${res.status}: ${err.message}`, res.status, err.code);
  }
  const json = parseJson(res.text);
  const arr = Array.isArray(json) ? json : [];
  const posts: WpPost[] = [];
  for (const raw of arr) {
    if (!isRecord(raw)) continue;
    const link = str(raw.link);
    if (!link) continue;
    const titleObj = raw.title;
    const title = stripHtml(isRecord(titleObj) ? str(titleObj.rendered) : str(titleObj));
    const featuredImage = featuredFromEmbedded(raw);
    const post: WpPost = { id: num(raw.id), url: link, title, date: str(raw.date).slice(0, 10) };
    if (featuredImage) post.featuredImage = featuredImage;
    posts.push(post);
  }
  return {
    posts,
    totalPages: Number(res.headers.get("x-wp-totalpages")) || (posts.length < perPage ? page : page + 1),
    total: Number(res.headers.get("x-wp-total")) || posts.length,
  };
}

/**
 * Все посты по фильтру с пагинацией: пауза между страницами, частичный результат
 * при ошибке на не первой странице (как fetchWpPosts в legacy).
 */
export async function listAllPosts(
  creds: WpCreds,
  params: Omit<WpListPostsParams, "page"> & { limit?: number; pauseMs?: number },
  opts: WpRequestOptions & { onProgress?: (loaded: number, total: number) => void; shouldStop?: () => boolean } = {},
): Promise<WpPost[]> {
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 100), 1), 5000);
  const pauseMs = Math.min(Math.max(params.pauseMs ?? 250, 0), 2000);
  const all: WpPost[] = [];
  const seen = new Set<string>();
  let page = 1;
  let totalPages = 0;
  let total = 0;
  for (let guard = 0; all.length < limit && guard < 200; guard++) {
    if (opts.shouldStop?.() || opts.signal?.aborted) break;
    let res: { posts: WpPost[]; totalPages: number; total: number };
    try {
      res = await listPosts(creds, { ...params, page, perPage: params.perPage ?? 100 }, opts);
    } catch (e) {
      if (all.length) break;
      throw e;
    }
    for (const p of res.posts) {
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      all.push(p);
      if (all.length >= limit) break;
    }
    totalPages = res.totalPages || totalPages;
    total = res.total || total;
    opts.onProgress?.(all.length, Math.min(total || limit, limit));
    if (!res.posts.length || (totalPages > 0 && page >= totalPages)) break;
    page++;
    if (pauseMs) await sleep(pauseMs);
  }
  return all.slice(0, limit);
}

/* ------------------------------ таксономии ------------------------------ */

function mapTerms(json: unknown): WpTerm[] {
  if (!Array.isArray(json)) return [];
  const out: WpTerm[] = [];
  for (const t of json) {
    if (!isRecord(t)) continue;
    const id = num(t.id);
    if (!id) continue;
    out.push({ id, name: stripHtml(str(t.name)), count: num(t.count) });
  }
  return out;
}

/** Категории и метки (до 100 самых наполненных каждая); ошибка меток не ломает ответ. */
export async function listTaxonomies(creds: WpCreds, opts: WpRequestOptions = {}): Promise<{ categories: WpTerm[]; tags: WpTerm[] }> {
  const q = "per_page=100&orderby=count&order=desc&hide_empty=false&_fields=id,name,count";
  const [cats, tags] = await Promise.all([
    wpJson(creds, `/categories?${q}`, {}, opts),
    wpJson(creds, `/tags?${q}`, {}, opts).catch(() => ({ json: [] as unknown })),
  ]);
  return { categories: mapTerms(cats.json), tags: mapTerms(tags.json) };
}

/* ------------------------------ подмена домена ------------------------------ */

/** Заменить протокол и хост адреса на указанный домен (с схемой или без). Пустой домен — адрес без изменений. */
function swapHost(url: string, domain: string | null | undefined): string {
  const d = (domain ?? "").trim().replace(/\/+$/, "");
  if (!url || !d) return url;
  try {
    const u = new URL(url);
    const target = new URL(/^https?:\/\//i.test(d) ? d : `https://${d}`);
    u.protocol = target.protocol;
    u.host = target.host;
    return u.toString();
  } catch {
    return url;
  }
}

/** Ссылка пина на статью с подменённым доменом (`link_domain` подключения). */
export function rewriteLinkDomain(url: string, linkDomain?: string | null): string {
  return swapHost(url, linkDomain);
}

/** Адрес загруженного медиафайла на домене отдачи (`media_domain` подключения, CDN). */
export function mediaUrlOnDomain(url: string, mediaDomain?: string | null): string {
  return swapHost(url, mediaDomain);
}
