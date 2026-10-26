/**
 * Google Таблицы сервиса «Статьи»: импорт ключей из вкладки сайта и обратная запись отчёта в те же строки.
 * Порт supabase/functions/sheets-sync (оригинал ходил через шлюз Lovable). Здесь — Google Sheets API напрямую под
 * сервисным аккаунтом: JSON-ключ лежит зашифрованным в ArtSettings.sheetsKeyEnc, таблице выдают доступ «Редактор»
 * на e-mail аккаунта (ArtSettings.sheetsEmail).
 *
 * Правила оригинала сохранены:
 *  - вкладка = домен сайта; колонки ищутся по заголовкам первой строки (COLUMNS), порядок любой;
 *  - в работу берутся строки без «Статуса» и без Publish URL; сценарий — по номеру в колонке «Сценарий», режим — из
 *    колонки «Режим» (2 = сначала модерация фото); строка без сценария или режима не берётся вообще;
 *  - после импорта строке ставится статус «в работе»; после публикации — ссылка, дата и статус «черновик» /
 *    «опубликовано»; при падении статьи — «ошибка»;
 *  - итог обратной записи хранится в Article.sheetSyncState/sheetSyncError, несохранённое досылает воркер (resyncSheets).
 * Используется и в Next.js (предпросмотр, запуск), и в воркере (запись отчёта) — без зависимостей.
 */
import { createSign } from "crypto";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { findDuplicateKeywords } from "./launch";
import { sanitizeTopic } from "./keywords";
import { mergeSiteSettings, type KeywordInput } from "./types";

const API = "https://sheets.googleapis.com/v4";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Сколько читаем со вкладки (оригинал: A1:Z2000) */
const LAST_COL = "AZ";
const MAX_ROWS = 5000;
/** Часовой пояс даты в колонках Data Draft / Data Publish */
const STAMP_TZ = process.env.SHEETS_TZ || "Europe/Kyiv";

const COLUMNS = {
  keyword: ["keyword", "ключ"],
  seo_keyword: ["seo keyword", "seo"],
  focus_keyword: ["focus keyword", "focus"],
  scenario: ["сценарий", "scenario", "сценарий", "recipe"],
  url_draft: ["url draft", "draft url"],
  data_draft: ["data draft", "дата черновика"],
  publish_url: ["publish url", "pulish url", "published url"],
  data_publish: ["data publish", "data pulish", "дата публикации"],
  status: ["статус", "status"],
  year_in_url: ["год в url", "год", "year in url", "year"],
  photo_geo: ["гео", "гео фото", "geo", "photo geo", "country", "страна"],
  photo_language: ["язык поиска", "язык фото", "язык", "lang", "language", "photo language"],
  photo_freshness: ["свежесть", "свежесть фото", "freshness", "photo freshness"],
  pipeline_mode: ["режим", "mode", "pipeline mode", "режим работы"],
} as const;
type ColKey = keyof typeof COLUMNS;

/** Статусы строки в таблице. Строка со статусом повторно в работу не берётся. */
export const SHEET_STATUS = { queued: "в работе", draft: "черновик", published: "опубликовано", error: "ошибка", deleted: "удалено" } as const;
export type SheetStatusKey = keyof typeof SHEET_STATUS;

/** Подсказка для интерфейса: какие заголовки понимает импорт. */
export const SHEET_COLUMNS_HELP: Array<{ title: string; note: string; required?: boolean; report?: boolean }> = [
  { title: "Keyword", note: "тема статьи", required: true },
  { title: "SEO Keyword", note: "SEO-ключ (необязательно)" },
  { title: "Focus Keyword", note: "фокус-ключ (необязательно)" },
  { title: "Сценарий", note: "номер сценария (№ на странице «Сценарии»)", required: true },
  { title: "Режим", note: "2 — сначала модерация фото, потом текст; 1 — текст сразу", required: true },
  { title: "Год в URL", note: "да / нет / процент 0–100; пусто — как в сценарии" },
  { title: "Гео", note: "страна поиска фото, 2 буквы (US, GB…)" },
  { title: "Язык", note: "язык поиска фото (en, de…)" },
  { title: "Свежесть", note: "год / месяц / неделя / любая" },
  { title: "Статус", note: "заполняет портал: в работе → черновик / опубликовано / ошибка", report: true },
  { title: "URL Draft, Data Draft", note: "ссылка и дата черновика — заполняет портал", report: true },
  { title: "Publish URL, Data Publish", note: "ссылка и дата публикации — заполняет портал", report: true },
];

/* ───────── Доступ: сервисный аккаунт ───────── */

export type ServiceKey = { client_email: string; private_key: string };

/** Разбор JSON-ключа сервисного аккаунта (файл из Google Cloud). Бросает понятную ошибку. */
export function parseServiceKey(raw: string): ServiceKey {
  let j: unknown;
  try { j = JSON.parse(raw.trim()); } catch { throw new Error("Это не JSON: вставьте содержимое файла ключа сервисного аккаунта целиком, от { до }"); }
  const o = (j ?? {}) as Record<string, unknown>;
  const email = typeof o.client_email === "string" ? o.client_email.trim() : "";
  const key = typeof o.private_key === "string" ? o.private_key : "";
  if (o.type && o.type !== "service_account") throw new Error("Нужен ключ сервисного аккаунта (type: service_account), а это другой тип ключа Google");
  if (!email || !key.includes("PRIVATE KEY")) throw new Error("В ключе нет полей client_email и private_key — скачайте JSON-ключ сервисного аккаунта заново");
  return { client_email: email, private_key: key };
}

export type SheetsConnection = { connected: boolean; email: string | null };

export async function sheetsConnection(): Promise<SheetsConnection> {
  const row = await prisma.artSettings.findUnique({ where: { id: "main" }, select: { sheetsKeyEnc: true, sheetsEmail: true } });
  return { connected: !!row?.sheetsKeyEnc, email: row?.sheetsEmail ?? null };
}

const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** Токен доступа по JWT сервисного аккаунта (RS256), живёт час. */
export async function fetchAccessToken(key: ServiceKey): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(key.private_key).toString("base64url");
  } catch {
    throw new Error("Закрытый ключ сервисного аккаунта повреждён: скачайте JSON-ключ заново и вставьте целиком");
  }
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${signature}` }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (/invalid_grant/.test(text)) throw new Error("Google не принял ключ сервисного аккаунта: ключ удалён или аккаунт отключён. Создайте новый JSON-ключ и вставьте его в портал.");
    throw new Error(`Google не выдал доступ (${resp.status}): ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Google не вернул токен доступа");
  return { token: j.access_token, expiresIn: j.expires_in ?? 3600 };
}

let tokenCache: { enc: string; email: string; token: string; until: number } | null = null;

async function auth(): Promise<{ token: string; email: string }> {
  const row = await prisma.artSettings.findUnique({ where: { id: "main" }, select: { sheetsKeyEnc: true } });
  if (!row?.sheetsKeyEnc) throw new Error("Google Таблицы не подключены: администратор добавляет ключ сервисного аккаунта в настройках сайта сервиса «Статьи» (блок «Google Таблицы»)");
  if (tokenCache && tokenCache.enc === row.sheetsKeyEnc && tokenCache.until > Date.now()) return { token: tokenCache.token, email: tokenCache.email };
  const key = parseServiceKey(decryptSecret(row.sheetsKeyEnc));
  const t = await fetchAccessToken(key);
  tokenCache = { enc: row.sheetsKeyEnc, email: key.client_email, token: t.token, until: Date.now() + Math.max(60, t.expiresIn - 300) * 1000 };
  return { token: t.token, email: key.client_email };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ответ Google человеческим языком: что сделать владельцу таблицы. */
function explain(status: number, text: string, email: string): string {
  if (status === 404) return "Таблица не найдена: проверьте ссылку (нужна ссылка вида docs.google.com/spreadsheets/d/…)";
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(text)) return "В проекте Google Cloud не включён Google Sheets API: откройте проект сервисного аккаунта → «APIs & Services» → включите «Google Sheets API»";
  if (status === 403) return `Нет доступа к таблице: откройте её → «Настройки доступа» → добавьте ${email} с ролью «Редактор»`;
  if (status === 400 && /not supported for this document/i.test(text)) return "Это файл Excel, а не Google Таблица: откройте его → «Файл» → «Сохранить как таблицу Google» и дайте ссылку на новую таблицу";
  if (status === 400 && /Unable to parse range|exceeds grid limits/i.test(text)) return `Google не нашёл нужную ячейку (${text.slice(0, 160)}): проверьте название вкладки и что справа от заголовков есть свободные колонки`;
  if (status === 429) return "Google Таблицы временно ограничили запросы (лимит в минуту). Подождите минуту и повторите.";
  return `Google Таблицы ответили ${status}: ${text.slice(0, 300)}`;
}

export async function sheetsFetch<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  // Google: 60 чтений в минуту на пользователя. При 429/5xx ждём и пробуем снова (оригинал :55-78).
  const maxAttempts = 5;
  let relogin = false;
  for (let attempt = 1; ; attempt++) {
    const { token, email } = await auth();
    let resp: Response;
    try {
      resp = await fetch(`${API}${path}`, {
        method: init?.method ?? "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (attempt >= maxAttempts) throw new Error(`Google Таблицы не ответили: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(Math.min(20_000, 2000 * 2 ** (attempt - 1)));
      continue;
    }
    const text = await resp.text();
    if (resp.ok) return (text ? JSON.parse(text) : null) as T;
    // Токен отозван или ключ заменён в другом процессе — берём новый один раз
    if (resp.status === 401 && !relogin) { relogin = true; tokenCache = null; continue; }
    const retryable = resp.status === 429 || resp.status >= 500;
    if (!retryable || attempt >= maxAttempts) throw new Error(explain(resp.status, text, email));
    const retryAfter = Number(resp.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(60_000, retryAfter * 1000) : Math.min(20_000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500));
  }
}

/* ───────── Разбор таблицы (порт оригинала) ───────── */

export function spreadsheetIdOf(url: string): string {
  const m = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error("Некорректная ссылка на Google Таблицу: нужна ссылка вида https://docs.google.com/spreadsheets/d/…");
  return m[1];
}

/** Домен без схемы, www и пути. */
export function domainOf(value?: string | null): string {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

const normHeader = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Индексы колонок по заголовкам первой строки. */
function headerIndex(headerRow: unknown[]): Partial<Record<ColKey, number>> {
  const out: Partial<Record<ColKey, number>> = {};
  headerRow.forEach((cell, i) => {
    const h = normHeader(cell);
    if (!h) return;
    for (const [key, aliases] of Object.entries(COLUMNS) as [ColKey, readonly string[]][]) {
      if (out[key] !== undefined) continue;
      if (aliases.some((a) => h === a || h.startsWith(a))) { out[key] = i; break; }
    }
  });
  return out;
}

export function colLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** «Год в URL»: «нет/no/false/0» → 0 %, «да/yes/true» → 100 %, число 0–100 → процент, пусто → null (как в сценарии). */
function parseYearInUrl(raw: string): number | null {
  const v = String(raw || "").trim().toLowerCase().replace("%", "");
  if (!v) return null;
  if (["нет", "no", "false", "off", "-"].includes(v)) return 0;
  if (["да", "yes", "true", "on", "+"].includes(v)) return 100;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

/** Свежесть фото из таблицы: год / месяц / неделя / любая. */
function parseFreshness(raw: string): string | null {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (["y", "год", "года", "year", "12m", "12"].includes(v)) return "y";
  if (["m", "месяц", "month", "30d"].includes(v)) return "m";
  if (["w", "неделя", "week", "7d"].includes(v)) return "w";
  if (["any", "любая", "любой", "все", "-"].includes(v)) return "any";
  return null;
}

export const quoteTab = (tab: string) => (/^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`);
export const rangePath = (id: string, range: string) => `/spreadsheets/${id}/values/${encodeURIComponent(range)}`;

/** Что нужно знать о сайте, чтобы найти его вкладку. */
export type SheetSite = { id: string; name: string; settings: unknown; access?: { baseUrl: string; linkDomain?: string | null; name?: string | null } | null };

/** Домены сайта, по которым ищется вкладка (первый — основной, он же показывается в подсказках). */
export function siteDomains(site: SheetSite): string[] {
  return [...new Set([site.access?.baseUrl, site.access?.linkDomain, site.access?.name, site.name].map(domainOf).filter(Boolean))];
}

/** Вкладка сайта: имя вкладки = домен сайта. */
export async function resolveTab(spreadsheetId: string, site: SheetSite): Promise<string> {
  const meta = await sheetsFetch<{ sheets?: Array<{ properties?: { title?: string } }> }>(`/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`);
  const titles = (meta?.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  const wanted = siteDomains(site);
  for (const w of wanted) {
    const hit = titles.find((t) => domainOf(t) === w);
    if (hit) return hit;
  }
  throw new Error(`В таблице нет вкладки с доменом сайта (${wanted[0] || "домен не задан"}). Есть вкладки: ${titles.join(", ") || "—"}. Переименуйте нужную вкладку в домен сайта.`);
}

export type SheetRow = {
  row: number; keyword: string; seoKeyword: string | null; focusKeyword: string | null; recipeNumber: number | null;
  publishUrl: string | null; status: string | null; yearInUrl: number | null; geo: string | null; language: string | null; freshness: string | null;
  /** 2 — сначала модерация фото; 1 — текст сразу; null — колонка пуста */
  mode: 1 | 2 | null;
};

/** Чтение вкладки сайта: все строки с ключом. Ничего не пишет. */
export async function readSheet(site: SheetSite, sheetUrl: string): Promise<{ spreadsheetId: string; tab: string; rows: SheetRow[]; columns?: Partial<Record<ColKey, string>> }> {
  const spreadsheetId = spreadsheetIdOf(sheetUrl);
  const tab = await resolveTab(spreadsheetId, site);
  const values = await sheetsFetch<{ values?: unknown[][] }>(rangePath(spreadsheetId, `${quoteTab(tab)}!A1:${LAST_COL}${MAX_ROWS}`));
  const rows = values?.values ?? [];
  if (rows.length < 2) return { spreadsheetId, tab, rows: [] };
  const idx = headerIndex(rows[0]);
  if (idx.keyword === undefined) throw new Error(`Во вкладке «${tab}» нет колонки Keyword: первая строка должна быть строкой заголовков`);
  // Где какая колонка по заголовкам («J · Статус») — для подсказки, если заголовки разъехались с данными.
  const columns: Partial<Record<ColKey, string>> = {};
  for (const [k, at] of Object.entries(idx) as [ColKey, number][]) columns[k] = `${colLetter(at)} · ${String(rows[0][at] ?? "").trim()}`;
  const out = rows.slice(1).map((r, i): SheetRow => {
    const get = (k: ColKey) => { const at = idx[k]; return at === undefined ? "" : String(r[at] ?? "").trim(); };
    const mode = get("pipeline_mode");
    return {
      row: i + 2,
      keyword: get("keyword"),
      seoKeyword: get("seo_keyword") || null,
      focusKeyword: get("focus_keyword") || null,
      recipeNumber: parseInt(get("scenario"), 10) || null,
      publishUrl: get("publish_url") || null,
      status: get("status") || null,
      yearInUrl: parseYearInUrl(get("year_in_url")),
      // Настройки поиска фото на статью: пусто = из сценария / параметров запуска
      geo: get("photo_geo").toUpperCase().slice(0, 2) || null,
      language: get("photo_language").toLowerCase().slice(0, 5) || null,
      freshness: parseFreshness(get("photo_freshness")),
      mode: /2/.test(mode) ? 2 : mode ? 1 : null,
    };
  }).filter((r) => r.keyword);
  return { spreadsheetId, tab, rows: out, columns };
}

/** Значения колонки «Статус», которые ставит сервис (и их английские варианты) — всё остальное там быть не должно. */
export const KNOWN_STATUS = new Set<string>([...Object.values(SHEET_STATUS), "queued", "in progress", "draft", "published", "error", "deleted", "done", "готово"].map((s) => s.toLowerCase()));

/** Заголовки вкладки; при `ensureStatus` колонка «Статус» создаётся справа от последнего заголовка (оригинал :203-210). */
async function tabHeader(spreadsheetId: string, tab: string, ensureStatus = false): Promise<Partial<Record<ColKey, number>>> {
  const header = await sheetsFetch<{ values?: unknown[][] }>(rangePath(spreadsheetId, `${quoteTab(tab)}!A1:${LAST_COL}1`));
  const first = header?.values?.[0] ?? [];
  const idx = headerIndex(first);
  if (idx.status === undefined && ensureStatus) {
    const at = first.length;
    await sheetsFetch(`${rangePath(spreadsheetId, `${quoteTab(tab)}!${colLetter(at)}1`)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values: [["Статус"]] } });
    idx.status = at;
  }
  return idx;
}

export async function batchWrite(spreadsheetId: string, data: Array<{ range: string; values: string[][] }>): Promise<void> {
  if (!data.length) return;
  await sheetsFetch(`/spreadsheets/${spreadsheetId}/values:batchUpdate`, { method: "POST", body: { valueInputOption: "USER_ENTERED", data } });
}

/** Отметка статуса в строках (после импорта — «в работе», чтобы не взять их снова). */
export async function markRows(spreadsheetId: string, tab: string, rows: number[], status: SheetStatusKey): Promise<void> {
  const list = [...new Set(rows.filter((r) => Number.isInteger(r) && r > 1))];
  if (!list.length) return;
  const idx = await tabHeader(spreadsheetId, tab, true);
  const letter = colLetter(idx.status!);
  for (let i = 0; i < list.length; i += 500) {
    await batchWrite(spreadsheetId, list.slice(i, i + 500).map((r) => ({ range: `${quoteTab(tab)}!${letter}${r}`, values: [[SHEET_STATUS[status]]] })));
  }
}

/** Дата для колонок Data Draft / Data Publish: YYYY-MM-DD HH:MM. */
export function stamp(d = new Date()): string {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: STAMP_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return p.replace(",", "").slice(0, 16);
}

/* ───────── Обратная запись по статье ───────── */

async function articleSheet(articleId: string) {
  const a = await prisma.article.findUnique({
    where: { id: articleId },
    select: { id: true, sheetRow: true, sheetTab: true, site: { select: { id: true, name: true, settings: true, access: { select: { baseUrl: true, linkDomain: true, name: true } } } } },
  });
  if (!a || !a.sheetRow) return null;
  const sheetUrl = mergeSiteSettings(a.site.settings).sheetUrl;
  return { id: a.id, row: a.sheetRow, tab: a.sheetTab, site: a.site as SheetSite, sheetUrl };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

/**
 * Ссылка + дата + статус в строку статьи: kind=draft → URL Draft / Data Draft / «черновик», publish → Publish URL /
 * Data Publish / «опубликовано». Не бросает: итог пишется в Article.sheetSyncState/sheetSyncError. Статья не из таблицы — пропуск.
 */
export async function writeArticleResult(articleId: string, kind: "draft" | "publish", url: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const a = await articleSheet(articleId);
  if (!a) return { ok: true, skipped: true };
  try {
    if (!a.sheetUrl) throw new Error("У сайта не указана ссылка на Google Таблицу (настройки сайта → «Google Таблица»)");
    const spreadsheetId = spreadsheetIdOf(a.sheetUrl);
    const tab = a.tab || (await resolveTab(spreadsheetId, a.site));
    const idx = await tabHeader(spreadsheetId, tab);
    const urlKey: ColKey = kind === "draft" ? "url_draft" : "publish_url";
    const dateKey: ColKey = kind === "draft" ? "data_draft" : "data_publish";
    if (idx[urlKey] === undefined) throw new Error(`Во вкладке «${tab}» нет колонки «${kind === "draft" ? "URL Draft" : "Publish URL"}» — добавьте её в строку заголовков`);
    const cell = (i: number) => `${quoteTab(tab)}!${colLetter(i)}${a.row}`;
    const data = [{ range: cell(idx[urlKey]!), values: [[url]] }];
    if (idx[dateKey] !== undefined) data.push({ range: cell(idx[dateKey]!), values: [[stamp()]] });
    if (idx.status !== undefined) data.push({ range: cell(idx.status), values: [[kind === "draft" ? SHEET_STATUS.draft : SHEET_STATUS.published]] });
    await batchWrite(spreadsheetId, data);
    await prisma.article.update({ where: { id: a.id }, data: { sheetTab: tab, sheetSyncState: "ok", sheetSyncError: null } });
    return { ok: true };
  } catch (e) {
    const error = errText(e);
    await prisma.article.update({ where: { id: a.id }, data: { sheetSyncState: "error", sheetSyncError: error } }).catch(() => {});
    return { ok: false, error };
  }
}

/** Статус в строку статьи (падение → «ошибка»). Не бросает; на состояние обратной записи отчёта не влияет. */
export async function markArticleStatus(articleId: string, status: SheetStatusKey): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  try {
    // Чтение строки статьи — внутри try: функцию зовут без await из раннера, сбой базы не должен стать необработанным отказом.
    const a = await articleSheet(articleId);
    if (!a || !a.sheetUrl) return { ok: true, skipped: true };
    const spreadsheetId = spreadsheetIdOf(a.sheetUrl);
    const tab = a.tab || (await resolveTab(spreadsheetId, a.site));
    const idx = await tabHeader(spreadsheetId, tab);
    if (idx.status === undefined) return { ok: true, skipped: true };
    await batchWrite(spreadsheetId, [{ range: `${quoteTab(tab)}!${colLetter(idx.status)}${a.row}`, values: [[SHEET_STATUS[status]]] }]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/**
 * Досылка отчёта: опубликованные статьи из таблицы, у которых запись не прошла (нет состояния или ошибка).
 * Оригинал: publish-worker :96-105. Берём только свежие (7 дней), чтобы не стучаться вечно в удалённую таблицу.
 */
export async function resyncSheets(limit = 10): Promise<{ tried: number; ok: number }> {
  if (!(await sheetsConnection()).connected) return { tried: 0, ok: 0 };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const rows = await prisma.article.findMany({
    // Окно — по дате завершения (updatedAt сдвигается каждой попыткой записи); порядок — давно не пробовали первыми
    where: { status: "COMPLETED", sheetRow: { not: null }, wpUrl: { not: null }, finishedAt: { gt: since }, OR: [{ sheetSyncState: null }, { sheetSyncState: "error" }] },
    orderBy: { updatedAt: "asc" }, take: limit, select: { id: true, wpUrl: true, wpStatus: true },
  });
  let ok = 0;
  for (const a of rows) {
    const r = await writeArticleResult(a.id, a.wpStatus === "draft" ? "draft" : "publish", a.wpUrl!);
    if (r.ok) ok++;
  }
  return { tried: rows.length, ok };
}

/* ───────── План импорта ───────── */

export type SheetReadyRow = KeywordInput & { sheetRow: number; recipeId: string; recipeNumber: number; recipeName: string };
export type SheetPlan = {
  spreadsheetId: string;
  tab: string;
  /** Строк с ключом во вкладке */
  total: number;
  /** Уже со статусом или ссылкой на публикацию — не берутся повторно */
  taken: number;
  ready: SheetReadyRow[];
  skipped: Array<{ row: number; keyword: string; reason: string }>;
  /** Похоже на ошибку в таблице (например, заголовки разъехались с данными) — показывается до запуска */
  warnings: string[];
};

/**
 * Что из вкладки пойдёт в работу: строки без статуса и Publish URL, со сценарием и режимом (оригинал
 * ArticleQueuePanel.importFromSheets :472-530). Причины пропуска — списком, чтобы показать до запуска.
 */
export async function planSheetImport(site: SheetSite, sheetUrl: string): Promise<SheetPlan> {
  const { spreadsheetId, tab, rows, columns } = await readSheet(site, sheetUrl);
  // В «Статусе» не статусы (qunex.online, 2026-10-25: заголовки H–J сдвинуты, в «Статусе» язык «en») — строки молча
  // считались взятыми. Строки с таким значением всё равно не берём (гео/язык прочитаются не из тех колонок), но говорим почему.
  const warnings: string[] = [];
  const odd = new Map<string, number>();
  for (const r of rows) if (r.status && !KNOWN_STATUS.has(r.status.toLowerCase())) odd.set(r.status, (odd.get(r.status) ?? 0) + 1);
  if (odd.size) {
    const sample = [...odd].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([v, n]) => `«${v}» — ${n}`).join(", ");
    const map = (["status", "photo_geo", "photo_language"] as const).map((k) => columns?.[k] && `${k === "status" ? "Статус" : k === "photo_geo" ? "Гео" : "Язык"}: ${columns[k]}`).filter(Boolean).join("; ");
    warnings.push(`В колонке «Статус» стоят не статусы (${sample} строк). Похоже, заголовки разъехались с данными: сервис читает колонки по первой строке (${map}). Такие строки считаются уже взятыми — поправьте заголовки, чтобы над каждой колонкой стояло её название, и нажмите «Прочитать заново».`);
  }
  // Уже взятые в работу и опубликованные темы повторно не подтягиваются
  const fresh = rows.filter((r) => !r.publishUrl && !r.status);
  const [recipes, linked] = await Promise.all([
    prisma.artRecipe.findMany({ where: { number: { not: null } }, select: { id: true, number: true, name: true, isActive: true } }),
    prisma.article.findMany({ where: { siteId: site.id, sheetTab: tab, sheetRow: { in: fresh.map((r) => r.row) }, status: { notIn: ["FAILED", "STOPPED"] } }, select: { sheetRow: true } }),
  ]);
  const byNumber = new Map(recipes.map((r) => [r.number as number, r]));
  const inQueue = new Set(linked.map((a) => a.sheetRow));
  const dup = new Set(await findDuplicateKeywords(site.id, fresh.map((r) => r.keyword)));

  const ready: SheetReadyRow[] = [];
  const skipped: SheetPlan["skipped"] = [];
  const seen = new Set<string>();
  let already = 0;
  for (const r of fresh) {
    if (inQueue.has(r.row)) { already++; continue; }
    const keyword = sanitizeTopic(r.keyword);
    const skip = (reason: string) => skipped.push({ row: r.row, keyword: r.keyword, reason });
    if (!keyword || keyword.length < 3) { skip("ключ слишком короткий"); continue; }
    if (keyword.length > 180) { skip("ключ длиннее 180 символов"); continue; }
    // Без сценария и режима в таблице статью не добавляем вообще
    if (r.recipeNumber == null) { skip("не указан сценарий (номер сценария)"); continue; }
    if (r.mode == null) { skip("не указан режим (1 или 2)"); continue; }
    const recipe = byNumber.get(r.recipeNumber);
    if (!recipe) { skip(`сценарий №${r.recipeNumber} не найден`); continue; }
    if (!recipe.isActive) { skip(`сценарий №${r.recipeNumber} выключен`); continue; }
    const low = keyword.toLowerCase();
    if (seen.has(low)) { skip("повтор ключа в таблице"); continue; }
    if (dup.has(low)) { skip("статья с таким ключом уже есть у сайта"); continue; }
    seen.add(low);
    ready.push({
      keyword, seoKeyword: r.seoKeyword ?? undefined, focusKeyword: r.focusKeyword ?? undefined,
      sheetRow: r.row, recipeId: recipe.id, recipeNumber: r.recipeNumber, recipeName: recipe.name,
      photoReview: r.mode === 2,
      // Колонки «Год в URL» / «Гео» / «Язык» / «Свежесть» важнее параметров запуска и сценария
      yearInUrlPercent: r.yearInUrl ?? undefined,
      search: { country: r.geo?.toLowerCase() ?? undefined, language: r.language ?? undefined, freshness: r.freshness ?? undefined },
    });
  }
  return { spreadsheetId, tab, total: rows.length, taken: rows.length - fresh.length + already, ready, skipped, warnings };
}
