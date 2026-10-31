/**
 * Записи и медиа WordPress для сервиса «Статьи» — то, чего нет в общем клиенте src/lib/pins/wp/client.ts:
 * поиск записи по slug, создание/обновление записи, подписи медиафайла, поиск медиа по имени файла, удаление медиа.
 *
 * Оригинал: supabase/functions/stage7-publish-wordpress/index.ts:355-404 (поиск по slug и POST /posts),
 * :294-304 (alt/title/caption), :583-604 (extractWpErrorMessage), test-wp-connection/index.ts:64-72 (DELETE /media).
 *
 * Транспорт повторяет стиль pins/wp/client.ts (fetch + Basic auth + AbortSignal), но создание записи идёт
 * одной попыткой: повтор POST /posts после таймаута может создать вторую запись — защита от дублей
 * делается на уровне этапа (поиск по slug перед созданием, 08-plan §3 п.9).
 */
import { assertPublicUrl } from "@/lib/pins/fetch";
import { WpError, normalizeBaseUrl, stripHtml, type WpCreds } from "@/lib/pins/wp/client";

/** Таймаут запроса на создание/обновление записи. Оригинал: max(30 с, 125 с − прошло) под лимит функции (:378); у нас бюджетов нет. */
export const POST_TIMEOUT_MS = 90_000;
/** Поиск записи по slug. Оригинал: 10 с (:358) — удвоено, медленные хостинги отвечали дольше. */
const LOOKUP_TIMEOUT_MS = 20_000;
const META_TIMEOUT_MS = 20_000;
const USER_AGENT = "ZewexArticles/1.0 (+https://zewex.tools)"; // оригинал: Mozilla/5.0 (compatible; StyleSparkPublisher/1.0)

export type WpPostStatus = "publish" | "draft" | "pending" | "future" | "private";

export type WpPostInput = {
  title: string;
  content: string;
  slug: string;
  status: WpPostStatus;
  excerpt?: string;
  categories?: number[];
  featured_media?: number;
  /** Поля Yoast (_yoast_wpseo_title, _yoast_wpseo_metadesc, _yoast_wpseo_focuskw) — WP примет, если плагин их зарегистрировал */
  meta?: Record<string, string>;
};

export type WpPostResult = { id: number; url: string; slug: string; status: string };
export type WpFoundPost = { id: number; slug: string; status: string; url: string; title: string };
export type WpMediaMetaPatch = { alt_text?: string; title?: string; caption?: string };

type RequestOpts = { signal?: AbortSignal; timeoutMs?: number; maxRetries?: number };
type WpResponse = { status: number; text: string; headers: Headers };

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

function authHeader(creds: WpCreds): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`, "utf8").toString("base64")}`;
}

function apiUrl(creds: WpCreds, path: string): string {
  return `${normalizeBaseUrl(creds.baseUrl)}/wp-json/wp/v2${path}`;
}

/** Текст ошибки WP: JSON {code, message} либо очищенный текст; подсказки CDN (оригинал extractWpErrorMessage :583-604). */
export function parseWpError(text: string): { message: string; code?: string } {
  const t = (text || "").trim();
  if (!t) return { message: "пустой ответ сервера" };
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j: unknown = JSON.parse(t);
      if (isRecord(j)) {
        const message = str(j.message) || str(j.error);
        if (message) return { message: stripHtml(message).slice(0, 240), code: typeof j.code === "string" ? j.code : undefined };
      }
    } catch {
      /* не JSON */
    }
  }
  const compact = t.replace(/\s+/g, " ");
  if (/origin unreachable/i.test(compact)) return { message: "CDN не достучался до сервера WordPress (origin unreachable)" };
  if (/origin error/i.test(compact)) return { message: "CDN сообщил об ошибке сервера WordPress (origin error)" };
  return { message: stripHtml(compact).slice(0, 240) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new WpError("WP вернул не JSON (проверьте адрес сайта и постоянные ссылки)", 0);
  }
}

/**
 * Запрос к REST API: Basic auth, таймаут, повторы при сети/429/5xx (пауза 2000·(n+1) мс, учёт Retry-After).
 * Повторов по умолчанию нет — вызывающий решает, идемпотентен ли запрос.
 */
async function wpFetch(creds: WpCreds, path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit }, opts: RequestOpts = {}): Promise<WpResponse> {
  const url = apiUrl(creds, path);
  await assertPublicUrl(url);
  const timeoutMs = opts.timeoutMs ?? POST_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 0;
  let lastStatus = 0;
  let lastError = "";

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
        headers: { Authorization: authHeader(creds), Accept: "application/json", "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
        body: init.body,
        signal: ac.signal,
      });
      const text = await res.text();
      if (res.ok || (res.status < 500 && res.status !== 429 && res.status !== 408)) return { status: res.status, text, headers: res.headers };
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
      ? `Сайт не ответил (WP ${lastStatus})${tries > 1 ? ` после ${tries} попыток` : ""}: сервер перегружен или не хватает памяти PHP. ${lastError}`.trim()
      : lastStatus === 429
        ? `Сайт ограничивает запросы (HTTP 429). ${lastError}`.trim()
        : `WP не ответил${tries > 1 ? ` после ${tries} попыток` : ""}: ${lastError}`,
    lastStatus,
  );
}

/** Запрос, который должен вернуть 2xx и JSON; иначе WpError со статусом и кодом WP (rest_*). */
async function wpJson(creds: WpCreds, path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit }, opts: RequestOpts = {}): Promise<unknown> {
  const res = await wpFetch(creds, path, init, opts);
  if (res.status < 200 || res.status >= 300) {
    const err = parseWpError(res.text);
    throw new WpError(`WP ${res.status}: ${err.message}`, res.status, err.code);
  }
  return parseJson(res.text);
}

function jsonBody(body: unknown): { method: string; headers: Record<string, string>; body: BodyInit } {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function toPostResult(json: unknown): WpPostResult {
  if (!isRecord(json)) throw new WpError("WP вернул неожиданный ответ при сохранении записи", 0);
  const id = num(json.id);
  const url = str(json.link);
  if (!id || !url) throw new WpError("WP не вернул id/link записи", 0);
  return { id, url, slug: str(json.slug), status: str(json.status) };
}

/* ------------------------------ поиск по slug ------------------------------ */

/**
 * Все slug, под которыми запись могла оказаться на сайте: сам slug, суффиксы -2…-4 (WordPress добавляет их
 * при совпадении с другой записью/страницей), с годом и без (seoYearUrlPercent мог дать разные варианты между попытками).
 */
export function slugVariants(slug: string): string[] {
  const s = slug.trim().toLowerCase();
  if (!s) return [];
  const year = new Date().getFullYear();
  const m = s.match(/^(.*)-(20\d\d)$/);
  const bases = m ? [s, m[1]] : [s, `${s}-${year}`, `${s}-${year + 1}`];
  const out = new Set<string>();
  for (const b of bases) {
    out.add(b);
    for (let i = 2; i <= 4; i++) out.add(`${b}-${i}`);
  }
  return [...out];
}

/**
 * Метка статьи в тексте записи (HTML-комментарий в начале content). По ней — и только по ней или по сохранённому
 * Article.wpPostId — запись считается нашей. Комментарии WordPress сохраняет (kses их пропускает), читателю не видны.
 */
export function articleMarker(articleId: string): string {
  return `<!-- zewex-article:${articleId} -->`;
}

/** Свободный адрес: slug-2, slug-3 … (первый, которого нет среди занятых). */
export function pickFreeSlug(slug: string, taken: Set<string>): string {
  for (let i = 2; i < 100; i++) {
    const s = `${slug}-${i}`;
    if (!taken.has(s)) return s;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

export type WpSlugLookup = {
  /** Запись этой статьи (с её меткой в тексте) среди вариантов адреса */
  own: WpFoundPost | null;
  /** Все занятые адреса из проверенных вариантов (любой статус) */
  taken: Set<string>;
  /** Кто занимает точный адрес, если это не наша запись */
  foreign: WpFoundPost | null;
};

/**
 * Поиск записи по адресу перед созданием (защита от дублей, аудит 04 §10 п.3) БЕЗ перезаписи чужого: раньше точное
 * совпадение slug считалось «всегда нашим» и пост, написанный человеком, затирался (аудит 2026-10-14, stability §1.1).
 * Теперь своя — только запись с меткой articleMarker(articleId). Варианты: slug, -2…-9, с годом/без.
 * Ошибку запроса не глушим: этап повторит публикацию позже, вместо того чтобы создать дубль.
 */
export async function lookupPostSlug(creds: WpCreds, slug: string, articleId: string, opts: { signal?: AbortSignal } = {}): Promise<WpSlugLookup> {
  const base = slug.trim().toLowerCase();
  const variants = [...new Set([...slugVariants(base), ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)])];
  if (!variants.length) return { own: null, taken: new Set(), foreign: null };
  const fields = "id,slug,status,link,title,content";
  const path = (status: string, context: string) => `/posts?slug=${variants.join(",")}&status=${status}&per_page=50&context=${context}&_fields=${fields}`;
  const reqOpts: RequestOpts = { signal: opts.signal, timeoutMs: LOOKUP_TIMEOUT_MS, maxRetries: 1 };
  // context=edit отдаёт сырой текст (метку видно наверняка); без права edit — обычный вид, метка в rendered.
  // оригинал (:358): status=publish,draft,pending,future; `any` короче и включает private — при отказе (400) откатываемся к списку
  let res = await wpFetch(creds, path("any", "edit"), {}, reqOpts);
  if (res.status === 400) res = await wpFetch(creds, path("publish,draft,pending,future,private", "edit"), {}, reqOpts);
  if (res.status === 401 || res.status === 403) res = await wpFetch(creds, path("publish,draft,pending,future,private", "view"), {}, reqOpts);
  if (res.status < 200 || res.status >= 300) {
    const err = parseWpError(res.text);
    throw new WpError(`WP ${res.status} при поиске записи по адресу: ${err.message}`, res.status, err.code);
  }
  const arr = parseJson(res.text);
  const marker = articleMarker(articleId);
  const taken = new Set<string>();
  let own: WpFoundPost | null = null;
  let foreign: WpFoundPost | null = null;
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (!isRecord(raw)) continue;
      const id = num(raw.id);
      if (!id) continue;
      const t = raw.title;
      const c = raw.content;
      const content = isRecord(c) ? `${str(c.raw)} ${str(c.rendered)}` : str(c);
      const post: WpFoundPost = { id, slug: str(raw.slug), status: str(raw.status), url: str(raw.link), title: stripHtml(isRecord(t) ? str(t.rendered) : str(t)) };
      if (post.slug) taken.add(post.slug);
      const mine = content.includes(marker);
      if (mine && !own) own = post;
      if (!mine && post.slug === base && !foreign) foreign = post;
    }
  }
  return { own, taken, foreign: own && own.slug === base ? null : foreign };
}

/* ------------------------------ записи ------------------------------ */

/** POST /posts — одна попытка (повтор после таймаута мог бы создать вторую запись). */
export async function createPost(creds: WpCreds, input: WpPostInput, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WpPostResult> {
  const json = await wpJson(creds, "/posts", jsonBody(input), { signal: opts.signal, timeoutMs: opts.timeoutMs ?? POST_TIMEOUT_MS, maxRetries: 0 });
  return toPostResult(json);
}

/** POST /posts/{id} — идемпотентно, поэтому повторы при 5xx/сети допустимы. 404 (rest_post_invalid_id) — запись удалили на сайте. */
export async function updatePost(creds: WpCreds, id: number, patch: Partial<WpPostInput>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WpPostResult> {
  const json = await wpJson(creds, `/posts/${id}`, jsonBody(patch), { signal: opts.signal, timeoutMs: opts.timeoutMs ?? POST_TIMEOUT_MS, maxRetries: 2 });
  return toPostResult(json);
}

/** GET /posts/{id}?context=edit — сырые заголовок и текст записи (для точечных правок опубликованного). */
export async function fetchPostRaw(creds: WpCreds, id: number, opts: { signal?: AbortSignal } = {}): Promise<{ title: string; content: string }> {
  const json = await wpJson(creds, `/posts/${id}?context=edit&_fields=id,title,content`, {}, { signal: opts.signal, timeoutMs: LOOKUP_TIMEOUT_MS, maxRetries: 2 });
  if (!isRecord(json)) throw new WpError("WP вернул неожиданный ответ записи", 0);
  const t = json.title;
  const c = json.content;
  return { title: isRecord(t) ? str(t.raw) : str(t), content: isRecord(c) ? str(c.raw) : str(c) };
}

/* ------------------------------ медиа ------------------------------ */

/** POST /media/{id} {alt_text, title, caption} (оригинал :294-304 — best effort, ошибка не ломает публикацию; решает вызывающий). */
export async function setMediaMeta(creds: WpCreds, mediaId: number, meta: WpMediaMetaPatch, opts: { signal?: AbortSignal } = {}): Promise<void> {
  const patch: Record<string, string> = {};
  if (meta.alt_text !== undefined) patch.alt_text = meta.alt_text;
  if (meta.title !== undefined) patch.title = meta.title;
  if (meta.caption !== undefined) patch.caption = meta.caption;
  if (!Object.keys(patch).length) return;
  await wpJson(creds, `/media/${mediaId}`, jsonBody(patch), { signal: opts.signal, timeoutMs: META_TIMEOUT_MS, maxRetries: 1 });
}

/**
 * Медиафайл по slug вложения (= имя файла без расширения). Имя файла статьи несёт маркер id фото
 * (`<slug>-<pos>-<photoId8>`), поэтому при повторе публикации уже загруженный файл находится, а не грузится второй раз
 * (документация оригинала обещала это, в коде не было — аудит 04 §6.2).
 */
export async function findMediaBySlug(creds: WpCreds, mediaSlug: string, opts: { signal?: AbortSignal } = {}): Promise<{ id: number; url: string } | null> {
  const s = mediaSlug.trim().toLowerCase();
  if (!s) return null;
  const json = await wpJson(creds, `/media?slug=${encodeURIComponent(s)}&per_page=5&_fields=id,source_url,slug`, {}, { signal: opts.signal, timeoutMs: LOOKUP_TIMEOUT_MS, maxRetries: 1 });
  if (!Array.isArray(json)) return null;
  for (const raw of json) {
    if (!isRecord(raw)) continue;
    const id = num(raw.id);
    const url = str(raw.source_url);
    if (id && url && str(raw.slug) === s) return { id, url };
  }
  return null;
}

/** DELETE /media/{id}?force=true (для проверки подключения: тестовый файл удаляется сразу). */
export async function deleteMedia(creds: WpCreds, mediaId: number, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
  const res = await wpFetch(creds, `/media/${mediaId}?force=true`, { method: "DELETE" }, { signal: opts.signal, timeoutMs: META_TIMEOUT_MS, maxRetries: 0 });
  return res.status >= 200 && res.status < 300;
}

/** GET /users/me?context=edit — имя, роли и право upload_files (оригинал test-wp-connection :77-101). */
export async function fetchMe(creds: WpCreds, opts: { signal?: AbortSignal } = {}): Promise<{ name: string; roles: string[]; canUpload: boolean }> {
  const json = await wpJson(creds, "/users/me?context=edit", {}, { signal: opts.signal, timeoutMs: META_TIMEOUT_MS, maxRetries: 1 });
  if (!isRecord(json)) throw new WpError("WP вернул неожиданный ответ /users/me", 0);
  const roles = Array.isArray(json.roles) ? json.roles.map((r) => str(r)).filter(Boolean) : [];
  const caps = isRecord(json.capabilities) ? json.capabilities : {};
  return { name: str(json.name) || str(json.slug), roles, canUpload: caps.upload_files !== false };
}
