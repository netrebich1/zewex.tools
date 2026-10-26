/**
 * Google Таблицы сервиса «Pin Blog Article»: импорт ключей и тем статей из вкладки сайта и обратная запись отчёта.
 * Подключение к Google общее со «Статьями»: один сервисный аккаунт портала (ключ — в настройках сайта сервиса «Статьи»,
 * блок «Google Таблицы»); таблице выдают доступ «Редактор» на его e-mail. Низкоуровневые вызовы — из src/lib/articles/sheets.ts.
 *
 * Правила (как у «Статей», но без лишних колонок):
 *  - вкладка = домен сайта; колонки ищутся по заголовкам первой строки, порядок любой;
 *  - нужны только «Keyword» (ключ) и, желательно, «Тема статьи» (заголовок — по нему система сама определяет формат);
 *    необязательно: «Focus Keyword», «Год в URL». Сценарий, режим, гео, язык и свежесть фото в таблице НЕ задаются:
 *    формат определяет система, сценарий — сайта по умолчанию (или выбранный при запуске), фото — англоязычная выдача (US);
 *  - в работу берутся строки без «Статуса» и без «Publish URL»; после импорта — «в работе»;
 *  - портал пишет: «Тип статьи» (что определила система), «Статус», «URL Draft»/«Data Draft» или «Publish URL»/«Data Publish»;
 *    при падении — «ошибка». Несохранённое досылает воркер (resyncBlogSheets, раз в 5 минут).
 */
import { prisma } from "@/lib/db";
import {
  KNOWN_STATUS, SHEET_STATUS, batchWrite, colLetter, quoteTab, rangePath, resolveTab, sheetsConnection, sheetsFetch, spreadsheetIdOf, stamp,
  type SheetSite, type SheetStatusKey,
} from "@/lib/articles/sheets";
import { sanitizeTopic } from "@/lib/articles/text/textGuards";
import { searchPhraseOf } from "./text";
import { findDuplicateKeywords } from "./recipes";
import { deferredFormatOf, pickScenario } from "./scenarios";
import { mergeSiteSettings, type BlogBrief, type KeywordInput } from "./types";

export { sheetsConnection, SHEET_STATUS };

const LAST_COL = "AZ";
const MAX_ROWS = 5000;

/** Заголовки колонок. exact — только точное совпадение (чтобы «Тип статьи» портала не совпал с «Тип статьи в топ-10» исследования). */
const COLUMNS: Record<string, { aliases: string[]; exact?: boolean }> = {
  keyword: { aliases: ["keyword", "ключ"] },
  topic: { aliases: ["тема статьи", "тема", "topic", "article title", "заголовок"] },
  focus_keyword: { aliases: ["focus keyword", "фокус-ключ", "фокус ключ"] },
  year_in_url: { aliases: ["год в url", "year in url"] },
  status: { aliases: ["статус", "status"] },
  article_type: { aliases: ["тип статьи", "article type"], exact: true },
  url_draft: { aliases: ["url draft", "draft url"] },
  data_draft: { aliases: ["data draft", "дата черновика"] },
  publish_url: { aliases: ["publish url", "pulish url", "published url"] },
  data_publish: { aliases: ["data publish", "data pulish", "дата публикации"] },
};
type ColKey = keyof typeof COLUMNS;

/** Подсказка в интерфейсе и пример таблицы: какие колонки нужны. */
export const BLOG_SHEET_COLUMNS: Array<{ title: string; note: string; required?: boolean; report?: boolean; example?: string }> = [
  { title: "Keyword", note: "ключ — как его ищут в Pinterest", required: true, example: "Clear skin" },
  { title: "Тема статьи", note: "заголовок статьи; по нему система определяет формат (список, рецепт, инструкция…) и число пунктов. Пусто — по ключу", example: "25 Clear Skin Tips That Actually Work" },
  { title: "Focus Keyword", note: "необязательно: фокус-ключ для Yoast; пусто — ключ", example: "" },
  { title: "Год в URL", note: "необязательно: да / нет / процент 0–100; пусто — как в сценарии", example: "" },
  { title: "Тип статьи", note: "заполняет портал: какой формат определила система", report: true, example: "Нумерованный список · 25 пунктов" },
  { title: "Статус", note: "заполняет портал: в работе → черновик / опубликовано / ошибка", report: true, example: "в работе" },
  { title: "URL Draft, Data Draft", note: "ссылка и дата черновика — заполняет портал", report: true },
  { title: "Publish URL, Data Publish", note: "ссылка и дата публикации — заполняет портал", report: true },
];

const normHeader = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function headerIndex(headerRow: unknown[]): Partial<Record<ColKey, number>> {
  const out: Partial<Record<ColKey, number>> = {};
  headerRow.forEach((cell, i) => {
    const h = normHeader(cell);
    if (!h) return;
    for (const [key, spec] of Object.entries(COLUMNS)) {
      if (out[key] !== undefined) continue;
      if (spec.aliases.some((a) => h === a || (!spec.exact && h.startsWith(a)))) { out[key] = i; break; }
    }
  });
  return out;
}

function parseYearInUrl(raw: string): number | null {
  const v = String(raw || "").trim().toLowerCase().replace("%", "");
  if (!v) return null;
  if (["нет", "no", "false", "off", "-"].includes(v)) return 0;
  if (["да", "yes", "true", "on", "+"].includes(v)) return 100;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

/** Заголовки вкладки; при ensure — недостающие колонки отчёта создаются справа от последнего заголовка. */
async function tabHeader(spreadsheetId: string, tab: string, ensure: ColKey[] = []): Promise<Partial<Record<ColKey, number>>> {
  const header = await sheetsFetch<{ values?: unknown[][] }>(rangePath(spreadsheetId, `${quoteTab(tab)}!A1:${LAST_COL}1`));
  const first = header?.values?.[0] ?? [];
  const idx = headerIndex(first);
  let at = first.length;
  const titles: Record<string, string> = { status: "Статус", article_type: "Тип статьи", url_draft: "URL Draft", data_draft: "Data Draft", publish_url: "Publish URL", data_publish: "Data Publish" };
  const add: Array<{ range: string; values: string[][] }> = [];
  for (const k of ensure) {
    if (idx[k] !== undefined) continue;
    add.push({ range: `${quoteTab(tab)}!${colLetter(at)}1`, values: [[titles[k] ?? k]] });
    idx[k] = at++;
  }
  if (add.length) await batchWrite(spreadsheetId, add);
  return idx;
}

export type BlogSheetRow = { row: number; keyword: string; topic: string | null; focusKeyword: string | null; yearInUrl: number | null; status: string | null; publishUrl: string | null };

export async function readBlogSheet(site: SheetSite, sheetUrl: string): Promise<{ spreadsheetId: string; tab: string; rows: BlogSheetRow[]; columns: Partial<Record<ColKey, string>> }> {
  const spreadsheetId = spreadsheetIdOf(sheetUrl);
  const tab = await resolveTab(spreadsheetId, site);
  const values = await sheetsFetch<{ values?: unknown[][] }>(rangePath(spreadsheetId, `${quoteTab(tab)}!A1:${LAST_COL}${MAX_ROWS}`));
  const rows = values?.values ?? [];
  if (rows.length < 2) return { spreadsheetId, tab, rows: [], columns: {} };
  const idx = headerIndex(rows[0]);
  if (idx.keyword === undefined) throw new Error(`Во вкладке «${tab}» нет колонки Keyword (или «Ключ»): первая строка должна быть строкой заголовков`);
  const columns: Partial<Record<ColKey, string>> = {};
  for (const [k, at] of Object.entries(idx) as [ColKey, number][]) columns[k] = `${colLetter(at)} · ${String(rows[0][at] ?? "").trim()}`;
  const out = rows.slice(1).map((r, i): BlogSheetRow => {
    const get = (k: ColKey) => { const at = idx[k]; return at === undefined ? "" : String(r[at] ?? "").trim(); };
    return {
      row: i + 2, keyword: get("keyword"), topic: get("topic") || null, focusKeyword: get("focus_keyword") || null,
      yearInUrl: parseYearInUrl(get("year_in_url")), status: get("status") || null, publishUrl: get("publish_url") || null,
    };
  }).filter((r) => r.keyword);
  return { spreadsheetId, tab, rows: out, columns };
}

/** Строка, готовая к запуску: ключ, тема, ожидаемый тип статьи (по теме, до исследования). */
export type BlogSheetReady = KeywordInput & { sheetRow: number; expectedType: string };
export type BlogSheetPlan = { spreadsheetId: string; tab: string; total: number; taken: number; ready: BlogSheetReady[]; skipped: Array<{ row: number; keyword: string; reason: string }>; warnings: string[] };

const GUESS_BRIEF = { intent: "other", ymyl: false, topicDomain: "" } as unknown as BlogBrief;

/** Что из вкладки пойдёт в работу. Ничего не пишет. */
export async function planBlogSheetImport(site: SheetSite, sheetUrl: string): Promise<BlogSheetPlan> {
  const { spreadsheetId, tab, rows, columns } = await readBlogSheet(site, sheetUrl);
  const warnings: string[] = [];
  const odd = new Map<string, number>();
  for (const r of rows) if (r.status && !KNOWN_STATUS.has(r.status.toLowerCase())) odd.set(r.status, (odd.get(r.status) ?? 0) + 1);
  if (odd.size) {
    const sample = [...odd].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([v, n]) => `«${v}» — ${n}`).join(", ");
    warnings.push(`В колонке «Статус» (${columns.status ?? "?"}) стоят не статусы (${sample} строк). Похоже, заголовки разъехались с данными. Такие строки считаются уже взятыми — поправьте заголовки и нажмите «Прочитать заново».`);
  }
  if (columns.topic === undefined) warnings.push("Во вкладке нет колонки «Тема статьи»: формат будет определяться только по ключу. Добавьте колонку с заголовками статей — так система точнее выберет формат и число пунктов.");
  const fresh = rows.filter((r) => !r.publishUrl && !r.status);
  const linked = await prisma.blogPost.findMany({ where: { siteId: site.id, sheetTab: tab, sheetRow: { in: fresh.map((r) => r.row) }, status: { notIn: ["FAILED", "STOPPED"] } }, select: { sheetRow: true } });
  const inQueue = new Set(linked.map((a) => a.sheetRow));
  const cleanKw = (k: string) => searchPhraseOf(sanitizeTopic(k));
  const dup = new Set(await findDuplicateKeywords(site.id, fresh.map((r) => cleanKw(r.keyword))));
  const ready: BlogSheetReady[] = [];
  const skipped: BlogSheetPlan["skipped"] = [];
  const seen = new Set<string>();
  let already = 0;
  for (const r of fresh) {
    if (inQueue.has(r.row)) { already++; continue; }
    const keyword = cleanKw(r.keyword);
    const topic = r.topic ? sanitizeTopic(r.topic).slice(0, 300) : "";
    const skip = (reason: string) => skipped.push({ row: r.row, keyword: r.keyword, reason });
    if (!keyword || keyword.length < 3) { skip("ключ слишком короткий"); continue; }
    if (keyword.length > 180) { skip("ключ длиннее 180 символов"); continue; }
    const deferred = deferredFormatOf(topic);
    if (deferred) { skip(`формат «${deferred.label}» пока не делаем`); continue; }
    const low = keyword.toLowerCase();
    if (seen.has(low)) { skip("повтор ключа в таблице"); continue; }
    if (dup.has(low)) { skip("статья с таким ключом уже есть у сайта"); continue; }
    seen.add(low);
    const guess = pickScenario("auto", GUESS_BRIEF, keyword, topic);
    ready.push({
      keyword, topic: topic || undefined, focusKeyword: r.focusKeyword ?? undefined, sheetRow: r.row,
      yearInUrlPercent: r.yearInUrl ?? undefined,
      expectedType: guess ? `${guess.scenario.label}${guess.n ? ` · ${guess.n} пунктов` : ""}` : "—",
    });
  }
  return { spreadsheetId, tab, total: rows.length, taken: rows.length - fresh.length + already, ready, skipped, warnings };
}

/** Отметка «в работе» сразу после запуска (чтобы строки не взять снова) + колонка «Тип статьи», если её нет. */
export async function markBlogRows(spreadsheetId: string, tab: string, rows: number[], status: SheetStatusKey): Promise<void> {
  const list = [...new Set(rows.filter((r) => Number.isInteger(r) && r > 1))];
  if (!list.length) return;
  const idx = await tabHeader(spreadsheetId, tab, ["status", "article_type"]);
  const letter = colLetter(idx.status!);
  for (let i = 0; i < list.length; i += 500) {
    await batchWrite(spreadsheetId, list.slice(i, i + 500).map((r) => ({ range: `${quoteTab(tab)}!${letter}${r}`, values: [[SHEET_STATUS[status]]] })));
  }
}

/* ───────── Обратная запись по статье ───────── */

async function postSheet(postId: string) {
  const p = await prisma.blogPost.findUnique({ where: { id: postId }, select: { id: true, sheetRow: true, sheetTab: true, site: { select: { id: true, name: true, settings: true, accessId: true } } } });
  if (!p || !p.sheetRow) return null;
  const access = p.site.accessId ? await prisma.siteAccess.findUnique({ where: { id: p.site.accessId }, select: { baseUrl: true, linkDomain: true, name: true } }) : null;
  const sheetUrl = mergeSiteSettings(p.site.settings).sheetUrl;
  return { id: p.id, row: p.sheetRow, tab: p.sheetTab, site: { id: p.site.id, name: p.site.name, settings: p.site.settings, access } as SheetSite, sheetUrl };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

async function writeCells(postId: string, cells: Partial<Record<ColKey, string>>, ensure: ColKey[], trackSync: boolean): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const p = await postSheet(postId).catch(() => null);
  if (!p) return { ok: true, skipped: true };
  try {
    if (!p.sheetUrl) throw new Error("У сайта не указана ссылка на Google Таблицу (настройки сайта → «Google Таблица»)");
    const spreadsheetId = spreadsheetIdOf(p.sheetUrl);
    const tab = p.tab || (await resolveTab(spreadsheetId, p.site));
    const idx = await tabHeader(spreadsheetId, tab, ensure);
    const data = (Object.entries(cells) as [ColKey, string][]).filter(([k]) => idx[k] !== undefined).map(([k, v]) => ({ range: `${quoteTab(tab)}!${colLetter(idx[k]!)}${p.row}`, values: [[v]] }));
    await batchWrite(spreadsheetId, data);
    if (trackSync) await prisma.blogPost.update({ where: { id: p.id }, data: { sheetTab: tab, sheetSyncState: "ok", sheetSyncError: null } });
    return { ok: true };
  } catch (e) {
    const error = errText(e);
    if (trackSync) await prisma.blogPost.update({ where: { id: p.id }, data: { sheetSyncState: "error", sheetSyncError: error } }).catch(() => {});
    return { ok: false, error };
  }
}

/** Ссылка + дата + статус после публикации (черновик или опубликовано). Не бросает; итог — BlogPost.sheetSyncState. */
export async function writeBlogResult(postId: string, kind: "draft" | "publish", url: string) {
  return writeCells(postId, kind === "draft"
    ? { url_draft: url, data_draft: stamp(), status: SHEET_STATUS.draft }
    : { publish_url: url, data_publish: stamp(), status: SHEET_STATUS.published }, kind === "draft" ? ["status", "url_draft", "data_draft"] : ["status", "publish_url", "data_publish"], true);
}

/** Статус строки (падение → «ошибка»). Не бросает. */
export async function markBlogStatus(postId: string, status: SheetStatusKey) {
  return writeCells(postId, { status: SHEET_STATUS[status] }, [], false).catch((e) => ({ ok: false, error: errText(e) }));
}

/** «Тип статьи»: что определила система (после этапа «Тип статьи»). Не бросает. */
export async function markBlogType(postId: string, label: string) {
  return writeCells(postId, { article_type: label }, ["article_type"], false).catch((e) => ({ ok: false, error: errText(e) }));
}

/** Досылка отчёта: опубликованные статьи из таблицы, у которых запись не прошла (за 7 дней). */
export async function resyncBlogSheets(limit = 10): Promise<{ tried: number; ok: number }> {
  if (!(await sheetsConnection()).connected) return { tried: 0, ok: 0 };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const rows = await prisma.blogPost.findMany({
    where: { status: "COMPLETED", sheetRow: { not: null }, wpUrl: { not: null }, finishedAt: { gt: since }, OR: [{ sheetSyncState: null }, { sheetSyncState: "error" }] },
    orderBy: { updatedAt: "asc" }, take: limit, select: { id: true, wpUrl: true, wpStatus: true },
  });
  let ok = 0;
  for (const a of rows) { const r = await writeBlogResult(a.id, a.wpStatus === "draft" ? "draft" : "publish", a.wpUrl!); if (r.ok) ok++; }
  return { tried: rows.length, ok };
}
