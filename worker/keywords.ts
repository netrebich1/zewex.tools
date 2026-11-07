import http from "node:http";
import https from "node:https";
import { prisma } from "@/lib/db";
import { recomputeKeywords, urlHash } from "@/lib/keywords/recompute";
import { yearIn } from "@/lib/keywords/metrics";
import { styleTick } from "@/lib/keywords/style";
import { log } from "./log";

/**
 * Подбор ключей Pinterest — фоновая работа воркера:
 *  • статьи из топ-10 выдачи: дата публикации (перенос docs/keyword-research/prototype/artdates.py), заголовок и год в нём,
 *    слова, фото, H2 → KwArticle, пересчёт ключей;
 *  • пересчёт оценок раз в сутки (возраст статей растёт сам);
 *  • уборка: просроченные аренды заданий — обратно в очередь, выполненные задания старше 30 дней — удалить.
 * Выдачу Pinterest сервер сам не запрашивает — её снимает расширение (extension/collector).
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_BYTES = 600_000;
const TIMEOUT_MS = 15_000;
const BATCH = 200;
const CONCURRENCY = Number(process.env.KEYWORDS_ARTDATES_CONCURRENCY || 8);
/** Сколько старых статей (без заголовка и объёма) перечитывать за проход. */
const REFETCH = 100;

const PATS = [
  /property=["']article:published_time["'][^>]*content=["']([^"']+)/i,
  /content=["']([^"']+)["'][^>]*property=["']article:published_time/i,
  /"datePublished"\s*:\s*"([^"]+)"/i,
  /itemprop=["']datePublished["'][^>]*content=["']([^"']+)/i,
  /name=["'](?:date|publish[-_]?date|pubdate)["'][^>]*content=["']([^"']+)/i,
  /<time[^>]*datetime=["']([^"']+)/i,
  /"dateModified"\s*:\s*"([^"]+)"/i,
];

function norm(s: string): string {
  const m = /(20\d\d|19\d\d)-(\d\d)-(\d\d)/.exec(s);
  return m ? m[0] : "";
}

/** GET как urllib в прототипе: без проверки сертификата, с редиректами, первые 600 КБ. 4xx/5xx — ошибка. */
function fetchHtml(url: string, redirects = 5): Promise<{ final: string; html: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error("bad url"));
    }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.get(u, { headers: { "User-Agent": UA, Accept: "text/html" }, timeout: TIMEOUT_MS, rejectUnauthorized: false } as https.RequestOptions, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("too many redirects"));
        return fetchHtml(new URL(res.headers.location, u).toString(), redirects - 1).then(resolve, reject);
      }
      if (code >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${code}`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        if (size >= MAX_BYTES) return;
        chunks.push(c);
        size += c.length;
        if (size >= MAX_BYTES) res.destroy();
      });
      const done = () => resolve({ final: u.toString(), html: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8") });
      res.on("end", done);
      res.on("close", done);
      res.on("error", (e) => (size ? done() : reject(e)));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** Дата публикации статьи: метатеги → JSON-LD → <time> → дата в адресе (как `get()` в artdates.py). "" — даты нет. */
function dateOf(final: string, html: string): string {
  for (const p of PATS) {
    const m = p.exec(html);
    if (m && norm(m[1])) return norm(m[1]);
  }
  const m = /\/(20[12]\d)\/(\d\d)\/(?:(\d\d)\/)?/.exec(final);
  return m ? `${m[1]}-${m[2]}-${m[3] || "15"}` : "";
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };
const decode = (s: string) => s
  .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
  .replace(/&([a-z0-9#]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
  .replace(/\s+/g, " ").trim();

/** Заголовок: og:title → первый h1 → title (без хвоста « | Сайт» / « - Сайт»). */
function titleOf(html: string): string | null {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title/i.exec(html);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = og?.[1] ?? (h1 ? h1[1].replace(/<[^>]+>/g, " ") : null) ?? (tt ? tt[1].replace(/\s+[|–—-]\s+[^|–—-]+$/, "") : null);
  const t = raw ? decode(raw) : "";
  return t && !/^(undefined|null)$/i.test(t) ? t.slice(0, 300) : null;
}

/**
 * Основная часть страницы: <article> → <main> → <body>, без скриптов, стилей, noscript (ленивые копии картинок),
 * svg, шапки/подвала/меню/сайдбара. Считаем слова, картинки и H2 — грубо, но одинаково для всех сайтов.
 */
function bodyStats(html: string): { words: number; images: number; h2: number } {
  let s = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const part = /<article[\s>][\s\S]*<\/article>/i.exec(s) || /<main[\s>][\s\S]*<\/main>/i.exec(s) || /<body[\s>][\s\S]*/i.exec(s);
  s = part ? part[0] : s;
  s = s.replace(/<(header|footer|nav|aside|form)[\s>][\s\S]*?<\/\1>/gi, " ");
  const images = (s.match(/<img\s[^>]*>/gi) ?? []).filter((t) => !/src=["']data:/i.test(t) || /data-(?:lazy-)?src=/i.test(t)).length;
  const h2 = (s.match(/<h2[\s>]/gi) ?? []).length;
  const text = decode(s.replace(/<[^>]+>/g, " "));
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return { words, images, h2 };
}

export type ArticleInfo = { date: string; title: string | null; words: number; images: number; h2: number };

/** Дата, заголовок и объём статьи; null — страница не открылась. */
export async function articleInfo(url: string): Promise<ArticleInfo | null> {
  try {
    const { final, html } = await fetchHtml(url);
    return { date: dateOf(final, html), title: titleOf(html), ...bodyStats(html) };
  } catch {
    return null;
  }
}

const validDate = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? new Date(`${d}T00:00:00Z`) : null);
const details = (i: ArticleInfo, now: Date) => ({ title: i.title, titleYear: yearIn(i.title), words: i.words, images: i.images, h2: i.h2, detailsAt: now });

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "").slice(0, 190);
  } catch {
    return "";
  }
};

let running = false;

/** Один проход: до 200 новых ссылок топа, затем до 100 старых статей без заголовка/объёма. Возвращает, сколько ссылок открыто. */
export async function keywordsArticleDatesTick(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    // Пины, записанные до появления linkHash, получают хэш здесь.
    const noHash = await prisma.kwPin.findMany({ where: { linkHash: null, link: { startsWith: "http" } }, select: { id: true, link: true }, take: 2000 });
    for (const p of noHash) await prisma.kwPin.update({ where: { id: p.id }, data: { linkHash: urlHash(p.link!) } });

    const rows = await prisma.$queryRaw<Array<{ link: string; linkHash: string }>>`
      SELECT MIN(p.link) AS link, p.linkHash AS linkHash
      FROM KwPin p LEFT JOIN KwArticle a ON a.urlHash = p.linkHash
      WHERE p.linkHash IS NOT NULL AND a.urlHash IS NULL
      GROUP BY p.linkHash
      LIMIT ${BATCH}`;
    // Статьи, записанные до разбора заголовка и объёма (стартовые данные, первые прогоны), — проходим заново.
    const old = rows.length < BATCH
      ? await prisma.kwArticle.findMany({ where: { detailsAt: null }, select: { urlHash: true, url: true, publishedAt: true }, take: Math.min(REFETCH, BATCH - rows.length) })
      : [];
    if (!rows.length && !old.length) return 0;
    const now = new Date();
    let found = 0;
    await mapLimit(rows, CONCURRENCY, async (r) => {
      const i = await articleInfo(r.link);
      if (i) found++;
      await prisma.kwArticle.createMany({
        data: [{ urlHash: r.linkHash, url: r.link, domain: domainOf(r.link), publishedAt: i ? validDate(i.date) : null, status: i ? (i.date ? "ok" : "nodate") : "error", ...(i ? details(i, now) : { detailsAt: now }) }],
        skipDuplicates: true,
      });
    });
    await mapLimit(old, CONCURRENCY, async (a) => {
      const i = await articleInfo(a.url);
      if (i) found++;
      // Дату, найденную раньше, не теряем; недоступная страница помечается разобранной, чтобы не открывать её каждые 10 минут.
      await prisma.kwArticle.update({
        where: { urlHash: a.urlHash },
        data: i ? { ...details(i, now), ...(a.publishedAt ? {} : { publishedAt: validDate(i.date), status: i.date ? "ok" : "nodate" }) } : { detailsAt: now },
      });
    });
    const hashes = [...rows.map((r) => r.linkHash), ...old.map((a) => a.urlHash)];
    const kwIds = [...new Set((await prisma.kwPin.findMany({ where: { linkHash: { in: hashes } }, select: { snapshot: { select: { keywordId: true } } } })).map((p) => p.snapshot.keywordId))];
    if (found && kwIds.length) await recomputeKeywords(kwIds);
    log.info(`keywords: articles ${found}/${rows.length + old.length} opened (${rows.length} new, ${old.length} re-read), recomputed ${found ? kwIds.length : 0} keyword(s)`);
    return rows.length + old.length;
  } finally {
    running = false;
  }
}

/** Раз в сутки: пересчёт всех ключей и уборка очереди. */
export async function keywordsDaily(): Promise<void> {
  const n = await recomputeKeywords();
  const del = await prisma.kwTask.deleteMany({ where: { status: "DONE", updatedAt: { lt: new Date(Date.now() - 30 * 864e5) } } });
  log.info(`keywords: daily recompute ${n} keyword(s), removed ${del.count} old task(s)`);
}

/** Просроченные аренды (расширение закрыли посреди задания) — обратно в очередь, чтобы счётчики на «Сборе» не врали. */
export async function keywordsRequeueStale(): Promise<void> {
  const r = await prisma.kwTask.updateMany({ where: { status: "LEASED", leaseUntil: { lt: new Date() } }, data: { status: "QUEUED", leaseUntil: null, collectorId: null } });
  if (r.count) log.info(`keywords: requeued ${r.count} stale task(s)`);
}

let styling = false;
let lastSkip = "";
/** Оформление пинов (коллаж / фото с надписью / чистое фото) по картинкам новых снимков — через слот vision. */
export async function keywordsStyleTick(): Promise<void> {
  if (styling) return;
  styling = true;
  try {
    const r = await styleTick(5);
    if (r.skipped) {
      if (r.skipped !== lastSkip) log.warn(`keywords: pin styles skipped — ${r.skipped}`);
      lastSkip = r.skipped;
    } else {
      lastSkip = "";
      if (r.pins) log.info(`keywords: pin styles ${r.pins} pin(s) in ${r.snapshots} snapshot(s)`);
    }
  } finally {
    styling = false;
  }
}
