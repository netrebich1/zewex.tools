/**
 * «Старые URL» → отдельная Google-таблица (OLD_SHEET): работа со старыми страницами, которые приносят трафик, а новых пинов на них нет.
 *
 * Источник — недельная история трафика страниц `PrjUrlHist` (Метрика, визиты людей по страницам входа, только страницы с 10+ визитами
 * в неделю; собирает ночной `metrikaSync`). «Старая» страница — опубликована в WordPress OLD_DAYS и больше дней назад (дата из открытого
 * REST сайта, кэш `PrjPostDate`); если сайт дату не отдал — та, которой нет среди статей и блог-постов портала (Article/BlogPost).
 *
 * Вкладки:
 *  - «Сводка»    — сайт: трафик старых и новых страниц за 4 недели к предыдущим 4, сколько страниц в работе и сколько свободных кандидатов;
 *  - «Ниши»      — сайт × ниша (nails, hair color, outfits, кухня…): сколько страниц реально дают трафик, рост, доля топ-страницы и медиана,
 *                  чтобы одна «качающая» статья не выдавала нишу за сильную;
 *  - «Кандидаты» — самые трафиковые старые страницы всех сайтов и их статус (свободна / в пачке / уже есть пины);
 *  - вкладка на каждую пачку (`PrjOldBatch`) — страницы «в работу» (на них делают прогон пинов) и контрольные (не трогаем):
 *    было визитов в неделю до пачки → стало после, до какого числа расписаны пины (из прогонов «Пинов»: `PinRunPage` + `PinRunItem`);
 *  - «Как читать».
 * Пачки создаёт `createOldBatch` (скрипт scripts/projects/old-batch.ts): топ старых страниц сайта через одну делятся на «в работу» и «контроль».
 * Пишет воркер (`oldUrlsTick`), целиком, только если данные изменились; колонка «ЗАМЕТКА» во вкладках пачек сохраняется по URL.
 */
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { sheetsFetch, quoteTab, rangePath } from "@/lib/articles/sheets";
import { urlPath, fullWeeks } from "./stats";

const OLD_SHEET = process.env.PRJ_OLD_SHEET || "1Vcc-9BSnlJmiSGiSjdtzJgHFt5uzt_616IYfTmJWu0Q";
const OLD_TEAM = process.env.PRJ_OLD_TEAM || "zewex";
const TZ = process.env.SHEETS_TZ || "Europe/Kyiv";
const LEGEND_TAB = "Как читать";
const WEEKS = 8;
/** Кандидат в работу: не меньше стольких визитов за 4 недели. */
const MIN_CAND = 40;
/** «Старая» страница: опубликована в WordPress не меньше стольких дней назад. */
const OLD_DAYS = 90;

const dom = (s: string | null | undefined) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(2, 4)}`;
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

/** Служебные страницы (главная, рубрики, пагинация, политика) — не статьи; туда же ходят роботы-обходчики. */
const SERVICE = /^\/?$|^\/(category|tag|author|page|search|feed|wp-|privacy|disclaimer|contact|about|terms|cookie|sitemap)|\/page\/\d+$|\/feed$|\/amp$/i;

/** Ниша страницы по словам в адресе. Порядок важен: «christmas nails» — это nails, «farmhouse style kitchen» — кухня. */
const NICHES: [string, RegExp][] = [
  ["nails", /nail|manicure|pedicure/],
  ["tattoo", /tattoo/],
  ["makeup", /makeup|make-up|lipstick|eyeshadow|eyeliner|eyebrow|lashes|blush/],
  ["hair color", /hair-?colou?r|highlights|lowlights|balayage|blonde|brunette|brown-hair|red-hair|copper|gray-blend|grey-blend|hair-dye|auburn|ombre-hair/],
  ["haircuts / hairstyles", /hair|(^|[-/])(bob|lob|bangs|pixie|braids?|curls?|curly|updo|ponytail|shag|mullet|perm|twists?|locs|wigs?|fringe)([-/.]|$)/],
  ["outfits", /outfit|dress|jeans|coat|jacket|skirt|shoes|boots|sneaker|sweater|pants|legging|swimsuit|bikini|ugg|blazer|cardigan|fashion/],
  ["кухня", /kitchen|pantry/],
  ["ванная", /bathroom|shower|bathtub/],
  ["спальня", /bedroom/],
  ["гостиная", /living-room|livingroom|family-room/],
  ["сад и двор", /garden|yard|patio|outdoor|outdore|balcony|porch|landscap|fence|pool|deck/],
  ["праздничный декор", /christmas|xmas|halloween|thanksgiving|easter|valentine|fourth-of-july|new-year|advent/],
  ["декор прочее", /decor|home|room|wall|paint|furniture|interior|house|apartment|floor|hallway|closet|shelf|shelves|curtain|entryway/],
  ["еда", /recipe|dinner|dessert|cake|cookie|salad|soup|chicken|pasta|breakfast|snack|drink|cocktail/],
  ["outfits", /wear|style|looks?([-/.]|$)|wardrobe/],
];
export const nicheOf = (path: string): string => { const p = path.toLowerCase(); for (const [n, re] of NICHES) if (re.test(p)) return n; return "прочее"; };

type Color = "g" | "r" | "y" | "x";
type OTab = { title: string; values: (string | number)[][]; colors: [number, number, Color][]; widths: number[]; frozenCols: number; left: number[]; bold: number[] };
const pct = (a: number, b: number) => (b ? `'${Math.round((a / b) * 100)}%` : "—");
const delta = (cur: number, prev: number): { text: string; color: Color | null } => {
  if (prev < 20) return cur >= 20 ? { text: "новое", color: "g" } : { text: "—", color: null };
  const p = Math.round(((cur - prev) / prev) * 100);
  return { text: p ? `${p > 0 ? "▲" : "▼"}${Math.abs(p)}%` : "ровно", color: p >= 15 ? "g" : p <= -15 ? "r" : null };
};
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

type Page = { site: string; path: string; niche: string; old: boolean; pub: string; w: number[]; cur: number; prev: number; pinTo: string | null };

/**
 * Даты публикации страниц из открытого REST WordPress (`/wp-json/wp/v2/posts?slug[]=…`), с кэшем в `PrjPostDate`.
 * Спрашиваем только страницы, которых в кэше ещё нет; не найденные запоминаем с пустой датой, чтобы не спрашивать снова.
 */
async function postDates(keys: string[]): Promise<Map<string, string>> {
  const sites = [...new Set(keys.map((k) => k.slice(0, k.indexOf("|"))))];
  const known = await prisma.prjPostDate.findMany({ where: { site: { in: sites } }, select: { site: true, path: true, published: true } });
  const out = new Map(known.map((r) => [r.site + "|" + r.path, r.published]));
  const need = new Map<string, string[]>();
  for (const k of keys) if (!out.has(k)) { const i = k.indexOf("|"), s = k.slice(0, i); (need.get(s) ?? need.set(s, []).get(s)!).push(k.slice(i + 1)); }
  const slugOf = (p: string) => (p.replace(/\/+$/, "").split("/").pop() ?? "").replace(/\.html?$/i, "");
  for (const [site, paths] of need) {
    for (let i = 0; i < paths.length; i += 40) {
      const part = paths.slice(i, i + 40), q = part.map((p) => "slug[]=" + encodeURIComponent(slugOf(p))).join("&");
      try {
        const r = await fetch(`https://${site}/wp-json/wp/v2/posts?per_page=100&_fields=date,link&${q}`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; zewex-tools)" }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) break;
        const found = new Map(((await r.json()) as Array<{ date: string; link: string }>).map((x) => [urlPath(x.link), x.date.slice(0, 10)]));
        const data = part.map((path) => ({ site, path, published: found.get(path) ?? "" }));
        await prisma.prjPostDate.createMany({ data });
        for (const x of data) out.set(site + "|" + x.path, x.published);
      } catch { break; }
      await new Promise((res) => setTimeout(res, 150));
    }
  }
  return out;
}
type BatchPage = { site: string; path: string; niche: string; role: string; base: number };
type Batch = { id: string; name: string; createdAt: Date; pages: BatchPage[] };
type Data = { today: string; weeks: string[]; pages: Page[]; pinSites: Set<string>; batches: Batch[]; hist: Map<string, Map<string, number>>; pinFrom: Map<string, Array<{ from: string; to: string }>> };

async function load(): Promise<Data | null> {
  const team = await prisma.team.findUnique({ where: { slug: OLD_TEAM }, select: { id: true } });
  if (!team) return null;
  const teamId = team.id, today = todayStr();
  const weeks = fullWeeks(addDays(today, -1), WEEKS);
  const batches = (await prisma.prjOldBatch.findMany({ where: { teamId }, orderBy: { createdAt: "asc" }, include: { pages: true } })) as Batch[];
  const firstWeek = [weeks[0], ...batches.map((b) => addDays(b.createdAt.toISOString().slice(0, 10), -35))].sort()[0];
  const [rows, access, artSites, blogSites, pinSites, arts, posts, pinRuns, runPages, itemAgg] = await Promise.all([
    prisma.prjUrlHist.findMany({ where: { teamId, week: { gte: firstWeek }, NOT: { path: "*" } }, select: { site: true, path: true, week: true, visits: true } }),
    prisma.siteAccess.findMany({ where: { teamId }, select: { id: true, name: true, baseUrl: true } }),
    prisma.artSite.findMany({ where: { teamId }, select: { id: true, name: true, accessId: true } }),
    prisma.blogSite.findMany({ where: { teamId }, select: { id: true, name: true, accessId: true } }),
    prisma.pinSite.findMany({ where: { teamId }, select: { id: true, name: true, wpConnectionId: true } }),
    prisma.article.findMany({ where: { teamId, wpUrl: { not: null } }, select: { siteId: true, wpUrl: true } }),
    prisma.blogPost.findMany({ where: { teamId, wpUrl: { not: null } }, select: { siteId: true, wpUrl: true } }),
    prisma.pinRun.findMany({ where: { teamId }, select: { id: true, siteId: true } }),
    prisma.pinRunPage.findMany({ where: { run: { teamId } }, select: { runId: true, url: true, finalUrl: true } }),
    prisma.pinRunItem.groupBy({ by: ["runId"], where: { run: { teamId } }, _max: { scheduledAt: true }, _min: { scheduledAt: true } }),
  ]);
  const accDom = new Map(access.map((a) => [a.id, dom(a.baseUrl) || dom(a.name)]));
  const artDom = new Map(artSites.map((s) => [s.id, (s.accessId && accDom.get(s.accessId)) || dom(s.name)]));
  const blogDom = new Map(blogSites.map((s) => [s.id, (s.accessId && accDom.get(s.accessId)) || dom(s.name)]));
  const pinDom = new Map(pinSites.map((s) => [s.id, (s.wpConnectionId && accDom.get(s.wpConnectionId)) || dom(s.name)]));
  const fresh = new Set<string>();
  for (const a of arts) { const d = artDom.get(a.siteId); if (d) fresh.add(d + "|" + urlPath(a.wpUrl!)); }
  for (const p of posts) { const d = blogDom.get(p.siteId); if (d) fresh.add(d + "|" + urlPath(p.wpUrl!)); }

  // Пины по страницам: все периоды расписания прогонов, куда входит страница.
  const runDom = new Map<string, string>();
  for (const r of pinRuns) { const d = r.siteId ? pinDom.get(r.siteId) : null; if (d) runDom.set(r.id, d); }
  const sched = new Map(itemAgg.filter((i) => i._max.scheduledAt && i._min.scheduledAt).map((i) => [i.runId, { from: i._min.scheduledAt!.toISOString().slice(0, 10), to: i._max.scheduledAt!.toISOString().slice(0, 10) }]));
  const pinFrom = new Map<string, Array<{ from: string; to: string }>>();
  for (const p of runPages) {
    const d = runDom.get(p.runId), s = sched.get(p.runId); if (!d || !s) continue;
    const k = d + "|" + urlPath(p.finalUrl || p.url);
    (pinFrom.get(k) ?? pinFrom.set(k, []).get(k)!).push(s);
  }

  const hist = new Map<string, Map<string, number>>();
  for (const r of rows) { const k = r.site + "|" + r.path; (hist.get(k) ?? hist.set(k, new Map()).get(k)!).set(r.week, r.visits); }
  const pages: Page[] = [];
  for (const [k, m] of hist) {
    const i = k.indexOf("|"), site = k.slice(0, i), path = k.slice(i + 1);
    if (SERVICE.test(path)) continue;
    const w = weeks.map((x) => m.get(x) ?? 0);
    const cur = w.slice(4).reduce((a, b) => a + b, 0), prev = w.slice(0, 4).reduce((a, b) => a + b, 0);
    if (!cur && !prev) continue;
    const to = (pinFrom.get(k) ?? []).map((s) => s.to).sort().pop() ?? null;
    pages.push({ site, path, niche: nicheOf(path), old: !fresh.has(k), pub: "", w, cur, prev, pinTo: to });
  }
  // Возраст — по дате публикации в WordPress; если сайт её не отдал, старой считаем страницу не из портала.
  const dates = await postDates(pages.map((p) => p.site + "|" + p.path)), border = addDays(today, -OLD_DAYS);
  for (const p of pages) { p.pub = dates.get(p.site + "|" + p.path) ?? ""; if (p.pub) p.old = p.pub <= border; }
  return { today, weeks, pages, pinSites: new Set(pinDom.values()), batches, hist, pinFrom };
}

const HEAD = (a: string[], b: string[]) => [a, b];

function summaryTab(d: Data): OTab {
  const colors: OTab["colors"] = [];
  const values = HEAD(
    ["САЙТ", "СТАРЫЕ СТРАНИЦЫ", "СТАРЫЕ: ВИЗИТЫ, 4 НЕД", "К ПРЕД. 4 НЕД", "ДОЛЯ СТАРЫХ", "НОВЫЕ: ВИЗИТЫ, 4 НЕД", "К ПРЕД. 4 НЕД", "РАСТЁТ НИША", "ПАДАЕТ НИША", "В РАБОТЕ", "СВОБОДНЫХ КАНДИДАТОВ"],
    ["домен", "с трафиком 10+ в нед.", `опубликованы ${OLD_DAYS}+ дней назад`, "", "от трафика статей", `моложе ${OLD_DAYS} дней`, "", "больше всего прибавила", "больше всего потеряла", "страниц в пачках", `старые без пинов, ${MIN_CAND}+ визитов`],
  ) as OTab["values"];
  const inBatch = new Map<string, number>();
  for (const b of d.batches) for (const p of b.pages) if (p.role === "test") inBatch.set(p.site, (inBatch.get(p.site) ?? 0) + 1);
  const taken = new Set(d.batches.flatMap((b) => b.pages.map((p) => p.site + "|" + p.path)));
  const sites = [...new Set(d.pages.map((p) => p.site))];
  const rows = sites.map((site) => {
    const ps = d.pages.filter((p) => p.site === site), old = ps.filter((p) => p.old), nw = ps.filter((p) => !p.old);
    const s = (a: Page[], f: (p: Page) => number) => a.reduce((n, p) => n + f(p), 0);
    const byN = new Map<string, { cur: number; prev: number; n: number }>();
    for (const p of ps) { const x = byN.get(p.niche) ?? byN.set(p.niche, { cur: 0, prev: 0, n: 0 }).get(p.niche)!; x.cur += p.cur; x.prev += p.prev; if (p.cur) x.n++; }
    const moves = [...byN].filter(([, x]) => x.n >= 3).map(([n, x]) => ({ n, diff: x.cur - x.prev, t: delta(x.cur, x.prev).text })).sort((a, b) => b.diff - a.diff);
    const up = moves[0] && moves[0].diff > 0 ? `${moves[0].n} ${moves[0].t}` : "—", down = moves.length && moves[moves.length - 1].diff < 0 ? `${moves[moves.length - 1].n} ${moves[moves.length - 1].t}` : "—";
    const free = old.filter((p) => p.cur >= MIN_CAND && !(p.pinTo && p.pinTo >= d.today) && !taken.has(p.site + "|" + p.path)).length;
    return { site, oldN: old.filter((p) => p.cur).length, oc: s(old, (p) => p.cur), op: s(old, (p) => p.prev), nc: s(nw, (p) => p.cur), np: s(nw, (p) => p.prev), up, down, work: inBatch.get(site) ?? 0, free };
  }).sort((a, b) => b.oc - a.oc);
  for (const r of rows) {
    const i = values.length, d1 = delta(r.oc, r.op), d2 = delta(r.nc, r.np);
    values.push([r.site, r.oldN, r.oc, d1.text, pct(r.oc, r.oc + r.nc), r.nc, d2.text, r.up, r.down, r.work || "—", r.free || "—"]);
    if (d1.color) colors.push([i, 3, d1.color]); if (d2.color) colors.push([i, 6, d2.color]);
    if (r.free >= 20 && !r.work) colors.push([i, 10, "y"]);
  }
  const t = rows.reduce((a, r) => ({ oc: a.oc + r.oc, op: a.op + r.op, nc: a.nc + r.nc, np: a.np + r.np, n: a.n + r.oldN, w: a.w + r.work, f: a.f + r.free }), { oc: 0, op: 0, nc: 0, np: 0, n: 0, w: 0, f: 0 });
  values.push(["ИТОГО", t.n, t.oc, delta(t.oc, t.op).text, pct(t.oc, t.oc + t.nc), t.nc, delta(t.nc, t.np).text, "", "", t.w, t.f]);
  return { title: "Сводка", values, colors, widths: [210, 110, 120, 90, 90, 120, 90, 200, 200, 90, 120], frozenCols: 1, left: [0, 7, 8], bold: [values.length - 1] };
}

function nichesTab(d: Data): OTab {
  const colors: OTab["colors"] = [];
  const values = HEAD(
    ["САЙТ", "НИША", "СТРАНИЦ С ТРАФИКОМ", "ИЗ НИХ СТАРЫХ", "ВИЗИТЫ, 4 НЕД", "ПРЕД. 4 НЕД", "ИЗМЕНЕНИЕ", "ДОЛЯ ТОП-СТРАНИЦЫ", "МЕДИАНА НА СТРАНИЦУ", "ВЫВОД", "ТОП-СТРАНИЦА"],
    ["домен", "по словам в адресе", "10+ визитов в неделю", `старше ${OLD_DAYS} дней`, "люди, без роботов", "", "", "сколько трафика ниши даёт одна страница", "визитов за 4 нед", "", "самая трафиковая в нише"],
  ) as OTab["values"];
  const bold: number[] = [];
  const block = (label: string, ps: Page[]) => {
    const byN = new Map<string, Page[]>();
    for (const p of ps) (byN.get(p.niche) ?? byN.set(p.niche, []).get(p.niche)!).push(p);
    const rows = [...byN].map(([n, a]) => {
      const live = a.filter((p) => p.cur > 0).sort((x, y) => y.cur - x.cur);
      const cur = a.reduce((s, p) => s + p.cur, 0), prev = a.reduce((s, p) => s + p.prev, 0);
      return { n, live, cur, prev, oldN: live.filter((p) => p.old).length };
    }).filter((r) => r.cur >= 100 || r.prev >= 100).sort((a, b) => b.cur - a.cur);
    rows.forEach((r, j) => {
      const i = values.length, dl = delta(r.cur, r.prev), top = r.live[0], share = top && r.cur ? Math.round((top.cur / r.cur) * 100) : 0;
      const single = r.live.length < 3 || share >= 50;
      const verdict = single ? "держится на 1–2 страницах" : dl.color === "g" ? "растёт" : dl.color === "r" ? "падает" : "ровно";
      values.push([j === 0 ? label : "", r.n, r.live.length, r.oldN, r.cur, r.prev, dl.text, `'${share}%`, median(r.live.map((p) => p.cur)), verdict, top ? `https://${top.site}${top.path}` : ""]);
      if (dl.color) colors.push([i, 6, dl.color]);
      colors.push([i, 9, single ? "y" : dl.color === "g" ? "g" : dl.color === "r" ? "r" : "x"]);
      if (share >= 50) colors.push([i, 7, "y"]);
      if (j === 0) bold.push(i);
    });
  };
  block("ВСЕ САЙТЫ", d.pages);
  const bySite = new Map<string, Page[]>();
  for (const p of d.pages) (bySite.get(p.site) ?? bySite.set(p.site, []).get(p.site)!).push(p);
  for (const [site, ps] of [...bySite].sort((a, b) => b[1].reduce((s, p) => s + p.cur, 0) - a[1].reduce((s, p) => s + p.cur, 0))) block(site, ps);
  return { title: "Ниши", values, colors, widths: [210, 170, 110, 90, 100, 100, 90, 120, 110, 190, 520], frozenCols: 2, left: [0, 1, 9, 10], bold };
}

function candidatesTab(d: Data): OTab {
  const colors: OTab["colors"] = [];
  const values = HEAD(
    ["САЙТ", "СТРАНИЦА", "НИША", "ОПУБЛИКОВАНА", "ГОД В АДРЕСЕ", "ВИЗИТЫ, 4 НЕД", "ПРЕД. 4 НЕД", "ИЗМЕНЕНИЕ", "СТАТУС"],
    ["домен", "старые страницы по убыванию трафика", "", "дата в WordPress", "", "люди, без роботов", "", "", "свободна / в пачке / уже есть пины"],
  ) as OTab["values"];
  const where = new Map<string, string>();
  for (const b of d.batches) for (const p of b.pages) where.set(p.site + "|" + p.path, `${p.role === "test" ? "в работе" : "контроль"}: ${b.name}`);
  for (const p of d.pages.filter((x) => x.old && x.cur >= MIN_CAND).sort((a, b) => b.cur - a.cur).slice(0, 800)) {
    const i = values.length, dl = delta(p.cur, p.prev), k = p.site + "|" + p.path;
    const year = Math.max(0, ...(p.path.match(/20\d\d/g) ?? []).map(Number));
    const st = where.get(k) ?? (p.pinTo && p.pinTo >= d.today ? `пины до ${dmy(p.pinTo)}` : !d.pinSites.has(p.site) ? "сайта нет в «Пинах»" : "свободна");
    values.push([p.site, `https://${p.site}${p.path}`, p.niche, p.pub ? `'${p.pub.slice(5, 7)}.${p.pub.slice(0, 4)}` : "—", year || "—", p.cur, p.prev, dl.text, st]);
    if (dl.color) colors.push([i, 7, dl.color]);
    colors.push([i, 8, st === "свободна" ? "y" : st.startsWith("сайта нет") ? "r" : st.startsWith("контроль") ? "x" : "g"]);
  }
  return { title: "Кандидаты", values, colors, widths: [200, 560, 160, 110, 90, 100, 100, 90, 260], frozenCols: 1, left: [0, 1, 2, 8], bold: [] };
}

function batchTab(d: Data, b: Batch, notes: Map<string, string>): OTab {
  const colors: OTab["colors"] = [];
  const start = b.createdAt.toISOString().slice(0, 10);
  const values = HEAD(
    ["САЙТ", "СТРАНИЦА", "НИША", "ГРУППА", "БЫЛО В НЕДЕЛЮ", "СТАЛО В НЕДЕЛЮ", "ИЗМЕНЕНИЕ", "ПИНЫ", "ЗАМЕТКА"],
    ["домен", `пачка от ${dmy(start)}: на страницы «в работу» делаем прогон пинов`, "", "в работу / контроль", "среднее за 4 нед до пачки", "среднее по полным неделям после пачки", "", "до какого числа расписаны", "ваша, сохраняется"],
  ) as OTab["values"];
  const after = d.weeks.filter((w) => w > start);
  const allWeeks = (k: string) => { const m = d.hist.get(k); let n = 0; for (const w of after) n += m?.get(w) ?? 0; return n; };
  const rows = b.pages.map((p) => {
    const k = p.site + "|" + p.path;
    const pins = (d.pinFrom.get(k) ?? []).filter((s) => s.to >= start).sort((x, y) => x.to.localeCompare(y.to));
    return { p, k, was: Math.round(p.base / 4), now: after.length ? Math.round(allWeeks(k) / after.length) : null, to: pins.length ? pins[pins.length - 1].to : null };
  });
  const order = (r: (typeof rows)[number]) => (r.p.role === "test" ? 0 : 1);
  rows.sort((a, b2) => order(a) - order(b2) || a.p.site.localeCompare(b2.p.site) || b2.p.base - a.p.base);
  const bold: number[] = [];
  for (const [role, label] of [["test", "В РАБОТЕ — итого"], ["control", "КОНТРОЛЬ — итого"]] as const) {
    const g = rows.filter((r) => r.p.role === role); if (!g.length) continue;
    const was = g.reduce((s, r) => s + r.was, 0), now = after.length ? g.reduce((s, r) => s + (r.now ?? 0), 0) : null, i = values.length;
    const dl = now === null ? { text: "ждём неделю", color: null } : delta(now, was);
    values.push([label, `${g.length} стр.`, "", role === "test" ? "в работу" : "контроль", was, now ?? "—", dl.text, role === "test" ? `с пинами ${g.filter((r) => r.to).length} из ${g.length}` : "пины не делаем", ""]);
    if (dl.color) colors.push([i, 6, dl.color]);
    bold.push(i);
  }
  for (const r of rows) {
    const i = values.length, test = r.p.role === "test", url = `https://${r.p.site}${r.p.path}`;
    const dl = r.now === null ? { text: "ждём неделю", color: null as Color | null } : delta(r.now, r.was);
    const pin = r.to ? (r.to >= d.today ? `до ${dmy(r.to)}` : `кончились ${dmy(r.to)}`) : test ? "ждёт прогона" : "—";
    values.push([r.p.site, url, r.p.niche, test ? "в работу" : "контроль", r.was, r.now ?? "—", dl.text, !test && r.to ? `⚠ попала в прогон, ${pin}` : pin, notes.get(url) ?? ""]);
    if (dl.color) colors.push([i, 6, dl.color]);
    colors.push([i, 3, test ? "g" : "x"]);
    colors.push([i, 7, !test ? (r.to ? "r" : "x") : !r.to ? "y" : r.to >= d.today ? "g" : "y"]);
  }
  return { title: b.name.slice(0, 90), values, colors, widths: [200, 560, 160, 100, 110, 110, 100, 190, 260], frozenCols: 1, left: [0, 1, 2, 8], bold };
}

const LEGEND: string[][] = [
  ["Старые URL: как читать", ""],
  ["Зачем", "Большую часть трафика дают старые страницы, на которые новые пины не делаются. Здесь видно, какие это страницы, какие ниши на каком сайте реально растут, и что меняется, когда на старую страницу выходят свежие пины."],
  ["Откуда цифры", "Яндекс Метрика: визиты людей (без роботов) на страницу как на страницу входа, по полным неделям (пн–вс). Метрика отдаёт только страницы с 10+ визитами за неделю: неделя, когда у страницы меньше 10 визитов, считается нулём."],
  ["«Сводка»", "По сайту: трафик старых страниц (опубликованы в WordPress 90 и больше дней назад) и новых (моложе 90 дней) за последние 4 полные недели к предыдущим 4. «Свободных кандидатов» — старые страницы с трафиком, на которые пинов в расписании нет и которые ещё не взяты в пачку."],
  ["«Ниши»", "Сайт × ниша. Смотрите не только на рост, но и на число страниц и долю топ-страницы: если ниша «держится на 1–2 страницах», это успех одной статьи, а не ниши. Медиана показывает, сколько приносит обычная страница ниши."],
  ["«Кандидаты»", "Самые трафиковые старые страницы всех сайтов. Жёлтый «свободна» — можно брать в следующую пачку."],
  ["Вкладка пачки", "Страницы «в работу» — на них делается прогон пинов в «Пинах» (адреса копируются из столбца «СТРАНИЦА»). «Контроль» — такие же по трафику страницы того же сайта, которые не трогаем: без них не понять, пины ли дали рост или весь сайт вырос/упал."],
  ["«ПИНЫ»", "Заполняется само: как только страница попала в прогон с расписанием, здесь появляется дата, до которой расписаны пины. «ждёт прогона» — прогон ещё не сделан. Красное у контрольной — она случайно попала в прогон, сравнение по ней испорчено."],
  ["Как оценивать", "Сравнивайте строки «В РАБОТЕ — итого» и «КОНТРОЛЬ — итого». Вывод делать не раньше, чем через 4 полные недели после начала заливки: пины разгоняются медленно. Если «в работе» растёт заметно лучше контроля — метод работает, расширяем."],
  ["Зелёный", "рост от 15% / пины расписаны / страница в работе"],
  ["Жёлтый", "ждёт действия: свободный кандидат, ждёт прогона, пины кончились, ниша держится на 1–2 страницах"],
  ["Красный", "падение от 15% / сайта нет в «Пинах» / контрольная страница попала в прогон"],
];
const LEGEND_COLORS: Record<number, Color> = { 9: "g", 10: "y", 11: "r" };

const rgb = (r: number, g: number, b: number) => ({ red: r / 255, green: g / 255, blue: b / 255 });
const BG: Record<Color, ReturnType<typeof rgb>> = { g: rgb(183, 225, 205), r: rgb(244, 180, 180), y: rgb(255, 229, 153), x: rgb(239, 239, 239) };
type Meta = { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> };

let running = false;
let lastHash = "";

/** Тик воркера: пересобрать таблицу «Старые URL», если данные изменились. */
export async function oldUrlsTick(force = false): Promise<{ written: boolean; tabs: number; error?: string }> {
  if (running) return { written: false, tabs: 0 };
  running = true;
  try {
    const d = await load();
    if (!d || !d.pages.length) return { written: false, tabs: 0 };
    const batch = (requests: unknown[]) => (requests.length ? sheetsFetch(`/spreadsheets/${OLD_SHEET}:batchUpdate`, { method: "POST", body: { requests } }) : Promise.resolve(null));
    const put = (range: string, values: unknown[][]) => sheetsFetch(`${rangePath(OLD_SHEET, range)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values } });
    const meta = () => sheetsFetch<Meta>(`/spreadsheets/${OLD_SHEET}?fields=sheets(properties(sheetId,title))`);
    let m = await meta();
    const find = (t: string) => (m.sheets ?? []).find((s) => s.properties?.title === t);

    const tabs: OTab[] = [summaryTab(d), nichesTab(d), candidatesTab(d)];
    for (const b of [...d.batches].reverse()) {
      const notes = new Map<string, string>(), title = b.name.slice(0, 90);
      if (find(title)) {
        const cur = await sheetsFetch<{ values?: unknown[][] }>(rangePath(OLD_SHEET, `${quoteTab(title)}!A1:I2000`));
        for (const r of (cur.values ?? []).slice(2)) { const u = String(r?.[1] ?? "").trim(), n = String(r?.[8] ?? "").trim(); if (u.startsWith("http") && n) notes.set(u, n); }
      }
      tabs.push(batchTab(d, b, notes));
    }
    const stamp = `Обновлено: ${new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" })} · недели ${dmy(d.weeks[4])}–${dmy(addDays(d.weeks[7], 6))} к ${dmy(d.weeks[0])}–${dmy(addDays(d.weeks[3], 6))}`;
    const hash = createHash("sha1").update(JSON.stringify(tabs.map((t) => [t.title, t.values, t.colors]))).digest("hex");
    const titles = [...tabs.map((t) => t.title), LEGEND_TAB];
    if (!force && hash === lastHash && titles.every((t) => find(t))) return { written: false, tabs: tabs.length };

    const pre: unknown[] = [];
    for (const t of titles) if (!find(t)) pre.push({ addSheet: { properties: { title: t } } });
    if (pre.length) { await batch(pre); m = await meta(); }
    // Пустой лист, с которым таблица создаётся, убираем.
    const blank = (m.sheets ?? []).filter((s) => /^(Лист|Sheet)\s?\d+$/.test(s.properties?.title ?? ""));
    if (blank.length) { await batch(blank.map((s) => ({ deleteSheet: { sheetId: s.properties!.sheetId } }))); m = await meta(); }

    const req: unknown[] = [];
    titles.forEach((t, i) => req.push({ updateSheetProperties: { properties: { sheetId: find(t)!.properties!.sheetId, index: i }, fields: "index" } }));
    for (const t of tabs) {
      const sheetId = find(t.title)!.properties!.sheetId!, rows = t.values.length, cols = t.widths.length;
      const cell = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
      await batch([{ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: Math.max(rows + 20, 60), columnCount: Math.max(cols, 12), frozenRowCount: 2, frozenColumnCount: t.frozenCols } }, fields: "gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)" } }]);
      await sheetsFetch(`${rangePath(OLD_SHEET, quoteTab(t.title))}:clear`, { method: "POST", body: {} });
      await put(`${quoteTab(t.title)}!A1`, t.values);
      req.push({ repeatCell: { range: { sheetId }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } });
      t.widths.forEach((px, c) => req.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: c, endIndex: c + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } }));
      const head = (bg: ReturnType<typeof rgb>, fontSize: number) => ({ backgroundColor: bg, textFormat: { bold: true, fontSize, foregroundColor: rgb(255, 255, 255) }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" });
      req.push({ repeatCell: { range: cell(0, 1, 0, cols), cell: { userEnteredFormat: head(rgb(38, 50, 56), 10) }, fields: "userEnteredFormat" } });
      req.push({ repeatCell: { range: cell(1, 2, 0, cols), cell: { userEnteredFormat: head(rgb(84, 110, 122), 8) }, fields: "userEnteredFormat" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 2 }, properties: { pixelSize: 38 }, fields: "pixelSize" } });
      if (rows > 2) {
        req.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: rows }, properties: { pixelSize: 24 }, fields: "pixelSize" } });
        const align = "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)";
        req.push({ repeatCell: { range: cell(2, rows, 0, cols), cell: { userEnteredFormat: { horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "CLIP" } }, fields: align } });
        for (const c of t.left) req.push({ repeatCell: { range: cell(2, rows, c, c + 1), cell: { userEnteredFormat: { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE", wrapStrategy: "CLIP" } }, fields: align } });
        req.push({ repeatCell: { range: cell(2, rows, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } });
        for (const r of t.bold) req.push({ repeatCell: { range: cell(r, r + 1, 0, cols), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } });
        for (const [r, c, k] of t.colors) req.push({ repeatCell: { range: cell(r, r + 1, c, c + 1), cell: { userEnteredFormat: { backgroundColor: BG[k] } }, fields: "userEnteredFormat.backgroundColor" } });
        req.push({ updateBorders: { range: cell(2, rows, 0, cols), innerHorizontal: { style: "SOLID", color: rgb(255, 255, 255) }, innerVertical: { style: "SOLID", color: rgb(255, 255, 255) } } });
      }
    }
    {
      const sheetId = find(LEGEND_TAB)!.properties!.sheetId!, rows = LEGEND.length;
      const cell = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
      await sheetsFetch(`${rangePath(OLD_SHEET, quoteTab(LEGEND_TAB))}:clear`, { method: "POST", body: {} });
      await put(`${quoteTab(LEGEND_TAB)}!A1`, LEGEND.map((r, i) => (i === 0 ? [r[0], stamp] : r)));
      req.push({ repeatCell: { range: { sheetId }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 210 }, fields: "pixelSize" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 820 }, fields: "pixelSize" } });
      req.push({ repeatCell: { range: cell(0, rows, 0, 2), cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } });
      req.push({ repeatCell: { range: cell(0, rows, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } });
      req.push({ repeatCell: { range: cell(0, 1, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 }, wrapStrategy: "OVERFLOW_CELL" } }, fields: "userEnteredFormat(textFormat,wrapStrategy)" } });
      for (const [r, k] of Object.entries(LEGEND_COLORS)) req.push({ repeatCell: { range: cell(+r, +r + 1, 0, 1), cell: { userEnteredFormat: { backgroundColor: BG[k], textFormat: { bold: true } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } });
    }
    // Форматирование — порциями: у больших вкладок запросов тысячи.
    for (let i = 0; i < req.length; i += 4000) await batch(req.slice(i, i + 4000));
    lastHash = hash;
    return { written: true, tabs: tabs.length };
  } catch (e) {
    return { written: false, tabs: 0, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  } finally {
    running = false;
  }
}

export type NewBatch = { name: string; test: number; control: number; sites: Array<{ site: string; test: number; control: number; visits: number }> };
/**
 * Новая пачка: по каждому сайту из «Пинов» — самые трафиковые свободные старые страницы (без пинов в расписании, не в других пачках,
 * от MIN_CAND визитов за 4 недели). Страницы идут по убыванию трафика и через одну делятся на «в работу» и «контроль»,
 * так что обе группы одинаково сильные. perSite — сколько страниц «в работу» на сайт; dry — только посчитать.
 */
export async function createOldBatch(name: string, perSite = 20, opts: { control?: boolean; dry?: boolean; minSite?: number } = {}): Promise<NewBatch> {
  const d = await load();
  if (!d) throw new Error("команда не найдена");
  const control = opts.control !== false, minSite = opts.minSite ?? 6;
  const taken = new Set(d.batches.flatMap((b) => b.pages.map((p) => p.site + "|" + p.path)));
  const out: NewBatch = { name, test: 0, control: 0, sites: [] };
  const data: Array<{ site: string; path: string; niche: string; role: string; base: number }> = [];
  for (const site of [...d.pinSites].sort()) {
    const c = d.pages.filter((p) => p.site === site && p.old && p.cur >= MIN_CAND && !(p.pinTo && p.pinTo >= d.today) && !taken.has(p.site + "|" + p.path)).sort((a, b) => b.cur - a.cur).slice(0, perSite * (control ? 2 : 1));
    if (c.length < minSite) continue;
    let t = 0, k = 0, v = 0;
    c.forEach((p, i) => { const role = control && i % 2 === 1 ? "control" : "test"; data.push({ site, path: p.path, niche: p.niche, role, base: p.cur }); if (role === "test") { t++; v += p.cur; } else k++; });
    out.sites.push({ site, test: t, control: k, visits: v }); out.test += t; out.control += k;
  }
  if (!opts.dry && data.length) {
    const team = await prisma.team.findUnique({ where: { slug: OLD_TEAM }, select: { id: true } });
    const b = await prisma.prjOldBatch.create({ data: { teamId: team!.id, name } });
    await prisma.prjOldPage.createMany({ data: data.map((x) => ({ ...x, batchId: b.id })) });
  }
  return out;
}
