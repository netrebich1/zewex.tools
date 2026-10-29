/**
 * Сбор статей конкурентов с просмотрами за последние N дней (по умолчанию 30).
 * Только сайты, где число просмотров видно публично: TSN, 24 Канал, Lux FM, Главред, УНИАН.
 * Viva не берём: её счётчик сам прибавляет просмотр при запросе.
 * Результат — JSONL (одна статья на строку), запуск можно повторять: уже собранные адреса пропускаются.
 * Запуск: npx tsx scripts/news/views-collect.ts <out.jsonl> [days]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";

type Row = { site: string; url: string; title: string; publishedAt: string; views: number };
const out = process.argv[2] ?? "views.jsonl";
const days = Number(process.argv[3] ?? 30);
const cutoff = Date.now() - days * 86_400_000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const seen = new Set<string>(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as Row).url) : []);

async function get(u: string, tries = 3): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u, { headers: { "user-agent": UA, "accept-language": "uk" }, signal: AbortSignal.timeout(25_000) });
      if (r.status === 404) return "";
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
    }
  }
}
const num = (s?: string) => (s ? Number(s.replace(/[^\d]/g, "")) || 0 : 0);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&rsquo;|&#8217;/g, "’").replace(/&laquo;/g, "«").replace(/&raquo;/g, "»").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();
const ogTitle = (h: string) => decode(h.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)?.[1] ?? h.match(/<title>([^<]+)/)?.[1] ?? "");
/** Дата публикации; у 24 Канала первой в разметке бывает «2026/09/02 17:59:00» — такие пропускаем, берём ISO. */
const pubDate = (h: string) =>
  [h.match(/article:published_time"\s+content="([^"]+)"/)?.[1], ...[...h.matchAll(/"(?:datePublished|publishedDate)"\s*:\s*"([^"]+)"/g)].map((m) => m[1])].find((d) => d && !Number.isNaN(new Date(d).getTime())) ?? "";

type Site = {
  name: string;
  /** Адреса статей: из карт сайта или страниц архива (листаем, пока не уйдём за отсечку). */
  urls: () => AsyncGenerator<string[]>;
  views: (url: string, html: string) => Promise<number>;
  /** Архив по страницам от новых к старым: можно остановиться, когда страница целиком старше отсечки. */
  archive?: boolean;
};

const fromSitemaps = (maps: string[], keep: RegExp) =>
  async function* () {
    for (const m of maps) {
      const x = await get(m).catch(() => "");
      yield [...x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((r) => r[1]).filter((u) => keep.test(u));
    }
  };
/** Архив по страницам; стоп, когда целая страница уже собрана или старше отсечки (это проверяет обход по датам). */
const fromPages = (page: (n: number) => string, link: RegExp, maxPages = 120) =>
  async function* () {
    for (let n = 1; n <= maxPages; n++) {
      const h = await get(page(n)).catch(() => "");
      const found = [...new Set([...h.matchAll(link)].map((r) => r[1]))];
      if (!found.length) return;
      yield found;
    }
  };
const months = (() => {
  const a: string[] = [];
  for (let t = cutoff; t <= Date.now() + 86_400_000 * 31; t += 86_400_000 * 28) {
    const d = new Date(t);
    a.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return [...new Set(a)].filter((m) => m <= `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`);
})();
const ajaxViews = (host: string) => async (url: string) => num(JSON.parse((await get(`${host}/ajax/views/${url.match(/-(\d{7,})\.html/)?.[1]}`).catch(() => "{}")) || "{}").views?.toString());

const SITES: Site[] = [
  {
    name: "tsn.ua",
    urls: fromPages((n) => (n === 1 ? "https://tsn.ua/glamur" : `https://tsn.ua/glamur/page-${n}`), /href="(https:\/\/tsn\.ua\/glamur\/[^"]+-\d{7}\.html)"/g),
    archive: true,
    views: async (_u, h) => num(h.match(/i-icon-eye[^>]*><\/i>\s*([\d\s ]+)/)?.[1]),
  },
  {
    name: "24tv.ua",
    urls: fromSitemaps(months.map((m) => `https://24tv.ua/resources/xml/subdomain_sitemaps/24/sitemap-simple-news-${m}.xml`), /24tv\.ua\/(show24|lady24)\//),
    views: async (_u, h) => num(h.match(/"viewsCount"\s*:\s*(\d+)/)?.[1]),
  },
  {
    name: "lux.fm",
    urls: fromSitemaps(months.flatMap((m) => ["kino", "fun", "moda"].map((s) => `https://lux.fm/sitemaps_${s}/uk/sitemap-simple-news-${m}.xml`)), /lux\.fm\//),
    // Первый счётчик без класса small — у самой статьи; дальше идут счётчики соседних материалов.
    views: async (_u, h) => num(h.match(/<span[^>]*class="views-count">([\d\s ]+)</)?.[1]),
  },
  ...["starnews", "stars", "show"].map((sec) => ({
    name: "glavred.net",
    urls: fromPages((n) => `https://glavred.net/${sec}${n > 1 ? `?page=${n}` : ""}`, new RegExp(`href="(https://glavred\\.net/${sec}/[^"]+-\\d{7,}\\.html)"`, "g")),
    archive: true,
    views: ajaxViews("https://glavred.net"),
  })),
  ...["stars", "show", "style"].map((sec) => ({
    name: "unian.ua",
    urls: fromPages((n) => `https://www.unian.ua/lite/${sec}${n > 1 ? `?page=${n}` : ""}`, new RegExp(`href="(https://www\\.unian\\.ua/lite/${sec}/[^"]+-\\d{7,}\\.html)"`, "g")),
    archive: true,
    views: ajaxViews("https://www.unian.ua"),
  })),
];

async function runSite(s: Site) {
  let saved = 0, old = 0;
  for await (const batch of s.urls()) {
    const todo = batch.filter((u) => !seen.has(u));
    let olderInBatch = 0;
    // По 4 запроса параллельно на сайт — вежливо и достаточно быстро.
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async (u) => {
        seen.add(u);
        try {
          const h = await get(u);
          const at = pubDate(h);
          if (!h || !at) return;
          if (new Date(at).getTime() < cutoff) { olderInBatch++; old++; return; }
          const row: Row = { site: s.name, url: u, title: ogTitle(h), publishedAt: at, views: await s.views(u, h) };
          appendFileSync(out, JSON.stringify(row) + "\n");
          saved++;
        } catch (e) {
          console.error(s.name, u, String((e as Error).message).slice(0, 80));
        }
      }));
    }
    // Архив листается от новых к старым: страница целиком за отсечкой — дальше не идём.
    if (s.archive && todo.length && olderInBatch === todo.length) break;
  }
  console.log(`${s.name}: сохранено ${saved}, старше отсечки ${old}`);
}

// Четвёртый аргумент — только эти сайты через запятую (дособрать после правки).
const only = process.argv[4]?.split(",");
Promise.all(SITES.filter((x) => !only || only.includes(x.name)).map(runSite)).then(() => console.log("готово"));
