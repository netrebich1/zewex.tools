/**
 * «Проекты» → Google-таблицы команд (TARGETS: Zewex «Pinterest CRM», PinOra, WexOra): сетка «сайт × кластер».
 * Вкладки «Женские» и «Декор»: одна строка = один сайт, столбцы = кластеры (подборки 2027, Christmas 2026, блог, мешап,
 * пины на старые статьи), у кластера две клетки — «статьи» (сколько опубликовано) и «пины» (до какого дня расписаны);
 * справа итог по сайту: пины до, запас, последняя заливка, что сделать и ручная колонка «заметка» (сохраняется при перезаписи).
 * Цвет клетки: зелёный — сделано, жёлтый — частично или кончается за 7 дней, красный — не сделано, серый — не относится.
 * Портал только читает свои таблицы; пишет воркер раз в час (prjGridTick из worker/cron.ts), целиком, если что-то изменилось.
 * Доступ к таблицам — у сервисного аккаунта «Статей» (таблица открыта на редактирование по ссылке).
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { sheetsFetch, quoteTab, rangePath } from "@/lib/articles/sheets";
import { buildTrafficTab, weekClicks, pinReadyDay, urlWeeks, urlPath, cmp, type WeekCell, type UrlWeek } from "./stats";
import { buildUploadsTab } from "./uploads";

/**
 * Команда портала → её Google-таблица (у каждой команды своя, сетка одинаковая). Таблица должна быть открыта на редактирование по ссылке.
 * dropOld — убрать вкладки первых вариантов (были только в таблице Zewex). Переопределение: PRJ_GRID_TARGETS="slug=sheetId,slug=sheetId".
 */
type Target = { team: string; sheet: string; dropOld?: boolean };
const TARGETS: Target[] = process.env.PRJ_GRID_TARGETS
  ? process.env.PRJ_GRID_TARGETS.split(",").map((x) => x.trim().split("=")).filter((x) => x[0] && x[1]).map(([team, sheet]) => ({ team, sheet }))
  : [
      { team: "zewex", sheet: "1XNNsdYRlPYkEGZ63XosMLECA7tsRbogCAvRZ9gRLZaA", dropOld: true },
      { team: "pinora", sheet: "1jM5YH8tK4tmTzwagPCYNvH2eaXFa_o2Y1GZpnE73sT8" },
      { team: "wexora", sheet: "1eYCpaNWmLulfx9rwp_Qh8O0fqj6Arpb24a8P-cqPxW0" },
    ];
const TZ = process.env.SHEETS_TZ || "Europe/Kyiv";
const LEGEND_TAB = "Как читать";
const OLD_TABS = ["Сайты", "Прогоны", "Подробно по прогонам"];
const XMAS = /christmas|xmas|new year/i;
/** Запуски меньше этого числа статей — тесты, в сетку не идут. */
const MIN_RUN = 20;

const dom = (s: string) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
const nurl = (s: string | null | undefined) => (s || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const dm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const dmy = (s: string) => `${dm(s)}.${s.slice(2, 4)}`;
const colLetter = (i: number): string => (i >= 26 ? colLetter(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

/** Постоянные кластеры — "y2027" | "xmas" | "blog" | "copy"; остальные («spring:2027», «easter:2027», «year:2028») появляются сами. */
type ClusterKey = string;
/**
 * Сезоны и праздники определяются по слову в ключе, год — по году в ключе: «Spring Outfits 2027» → кластер SPRING 2027.
 * Чтобы пара «зимних» ключей внутри подборок 2027 не плодила столбцы, кластер считается отдельным для сайта, только когда
 * таких статей на сайте набралось MIN_RUN; иначе они остаются в подборках. Столбец появляется на вкладке сам, как только
 * кластер есть хотя бы у одного её сайта. Так же появляются вечнозелёные следующего года (ПОДБОРКИ 2028) и Christmas 2027+.
 * Новый сезон или праздник = строка здесь. Порядок строк — порядок столбцов внутри года.
 */
const SEASONS: [string, string, RegExp][] = [
  ["winter", "WINTER", /\bwinter\b/i], ["valentine", "VALENTINE", /valentine/i], ["patrick", "ST PATRICK", /patrick/i], ["spring", "SPRING", /\bspring\b/i],
  ["easter", "EASTER", /\beaster\b/i], ["mother", "MOTHER'S DAY", /mother'?s day/i], ["summer", "SUMMER", /\bsummer\b/i], ["july4", "4TH OF JULY", /4th of july|fourth of july|independence day/i],
  ["school", "BACK TO SCHOOL", /back to school/i], ["fall", "FALL", /\b(fall|autumn)\b/i], ["halloween", "HALLOWEEN", /\bhalloween\b/i], ["thanksgiving", "THANKSGIVING", /thanksgiving/i],
  ["xmas", "CHRISTMAS", /christmas|xmas|new year/i], ["year", "ПОДБОРКИ", /^$/],
];
const BASE_KEYS: ClusterKey[] = ["y2027", "xmas", "blog", "copy"];
const BASE_TITLE: Record<string, string> = { y2027: "ПОДБОРКИ 2027", xmas: "CHRISTMAS 2026", blog: "БЛОГ", copy: "МЕШАП (Article Copy)" };
const clusterTitle = (k: ClusterKey): string => {
  if (BASE_TITLE[k]) return BASE_TITLE[k];
  const [name, year] = k.split(":");
  return `${SEASONS.find((s) => s[0] === name)?.[1] ?? name.toUpperCase()}${year ? " " + year : ""}`;
};
const clusterWord = (k: ClusterKey) => (k === "copy" ? "мешап" : clusterTitle(k).toLowerCase());
/** Порядок сезонных столбцов: по году, внутри года — как в SEASONS. */
const dynOrder = (k: ClusterKey) => { const [name, year] = k.split(":"); return (Number(year) || 0) * 100 + SEASONS.findIndex((s) => s[0] === name); };
/** Ниша сайта = вкладка. Определяется по нишам рецептов статей, а если статей портала нет — по нишам страниц в прогонах пинов. */
type Kind = "women" | "decor" | "food";
const KIND_OF: Record<string, Kind> = { outfits: "women", outfit: "women", hair: "women", nails: "women", interior: "decor", decor: "decor", cooking: "food", food: "food", recipes: "food", recipe: "food" };
const KIND_TABS: [Kind, string][] = [["women", "Женские"], ["decor", "Декор"], ["food", "Кулинария"]];
/**
 * Трафик кластера по Метрике (страницы входа, люди): визиты за 7 дней и предыдущие 7 по статьям кластера.
 * Статьи моложе TRAFFIC_AGE_DAYS не считаются (первые дни на них ходит наш робот и прямые заходы); n — сколько статей посчитано, young — сколько ещё ждут.
 */
type Traffic = { v7: number; p7: number; n: number; young: number };
const TRAFFIC_AGE_DAYS = 3;
type Cluster = { total: number; pub: number; pinned: number; pinTo: string | null; traffic: Traffic | null };
export type GridSite = { domain: string; kind: Kind; clusters: Partial<Record<ClusterKey, Cluster>>; old: { pages: number; pinTo: string; traffic: Traffic | null } | null; until: string | null; uploadLast: string | null };
type PageRef = { path: string; at: Date | null };

/** Сумма визитов по страницам кластера; null — у сайта нет данных Метрики по страницам. */
function clusterTraffic(urls: PageRef[], site: Map<string, UrlWeek> | undefined, today: string): Traffic | null {
  if (!site) return null;
  const minAt = Date.parse(`${today}T00:00:00Z`) - TRAFFIC_AGE_DAYS * 86_400_000;
  const t: Traffic = { v7: 0, p7: 0, n: 0, young: 0 };
  const seen = new Set<string>();
  for (const u of urls) {
    if (!u.path || seen.has(u.path)) continue; seen.add(u.path);
    if (u.at && u.at.getTime() > minAt) { t.young++; continue; }
    t.n++;
    const w = site.get(u.path); if (w) { t.v7 += w.visits7; t.p7 += w.prev7; }
  }
  return t;
}

/** Сводка по сайтам команды: кластеры статей, покрытие пинами (по URL страниц прогонов и истории), расписание, заливка, трафик кластеров. */
export async function collectGrid(teamSlug: string, today = todayStr(), weeks: Map<string, Map<string, UrlWeek>> = new Map()): Promise<GridSite[]> {
  const team = await prisma.team.findUnique({ where: { slug: teamSlug }, select: { id: true } });
  if (!team) return [];
  const teamId = team.id;
  const [access, artSites, blogSites, pinSites, recipes, copyArts] = await Promise.all([
    prisma.siteAccess.findMany({ where: { teamId }, select: { id: true, name: true, baseUrl: true } }),
    prisma.artSite.findMany({ where: { teamId }, select: { id: true, name: true, accessId: true } }),
    prisma.blogSite.findMany({ where: { teamId }, select: { id: true, name: true, accessId: true } }),
    prisma.pinSite.findMany({ where: { teamId }, select: { id: true, name: true, wpConnectionId: true } }),
    prisma.artRecipe.findMany({ select: { id: true, nicheCode: true } }),
    prisma.copyArticle.findMany({ select: { articleId: true } }),
  ]);
  const [arts, posts, pinRuns, pages, itemAgg, uploads, hist] = await Promise.all([
    prisma.article.findMany({ where: { teamId }, select: { id: true, siteId: true, runId: true, recipeId: true, status: true, keyword: true, wpUrl: true, publishedAt: true, finishedAt: true, createdAt: true } }),
    prisma.blogPost.findMany({ where: { teamId }, select: { siteId: true, status: true, wpUrl: true, publishedAt: true, finishedAt: true, createdAt: true } }),
    prisma.pinRun.findMany({ where: { teamId }, select: { id: true, siteId: true } }),
    prisma.pinRunPage.findMany({ where: { run: { teamId } }, select: { runId: true, url: true, finalUrl: true, niche: true } }),
    prisma.pinRunItem.groupBy({ by: ["runId"], where: { run: { teamId } }, _max: { scheduledAt: true } }),
    prisma.prjUpload.findMany({ where: { pinSiteId: { in: pinSites.map((p) => p.id) } }, select: { pinSiteId: true, day: true } }),
    prisma.pinUrlHistory.findMany({ where: { siteId: { in: pinSites.map((p) => p.id) } }, select: { siteId: true, url: true } }),
  ]);
  const copySet = new Set(copyArts.map((c) => c.articleId));
  const recNiche = new Map(recipes.map((r) => [r.id, r.nicheCode]));
  const accDom = new Map(access.map((a) => [a.id, dom(a.baseUrl) || dom(a.name)]));
  const artDom = new Map(artSites.map((s) => [s.id, (s.accessId && accDom.get(s.accessId)) || dom(s.name)]));
  const blogDom = new Map(blogSites.map((s) => [s.id, (s.accessId && accDom.get(s.accessId)) || dom(s.name)]));
  const pinDom = new Map(pinSites.map((s) => [s.id, (s.wpConnectionId && accDom.get(s.wpConnectionId)) || dom(s.name)]));

  type Acc = { total: number; pub: number; pinned: number; pinRuns: Set<string>; urls: PageRef[] };
  type Site = { domain: string; niches: Record<string, number>; cl: Partial<Record<ClusterKey, Acc>>; histUrls: Set<string>; pinRunIds: string[]; uploads: string[] };
  const sites = new Map<string, Site>();
  const get = (d: string) => sites.get(d) ?? sites.set(d, { domain: d, niches: {}, cl: {}, histUrls: new Set(), pinRunIds: [], uploads: [] }).get(d)!;
  const bump = (s: Site, k: string) => { s.niches[k] = (s.niches[k] ?? 0) + 1; };

  const schedTo = new Map(itemAgg.map((i) => [i.runId, day(i._max.scheduledAt)]));
  const runDom = new Map<string, string>();
  for (const r of pinRuns) { const d = r.siteId ? pinDom.get(r.siteId) : null; if (d) { runDom.set(r.id, d); get(d).pinRunIds.push(r.id); } }
  const urlRuns = new Map<string, Set<string>>();
  const runPages = new Map<string, number>();
  const runPaths = new Map<string, PageRef[]>();
  for (const p of pages) {
    const d = runDom.get(p.runId); if (!d) continue;
    runPages.set(p.runId, (runPages.get(p.runId) ?? 0) + 1);
    (runPaths.get(p.runId) ?? runPaths.set(p.runId, []).get(p.runId)!).push({ path: urlPath(p.finalUrl || p.url), at: null });
    if (p.niche) bump(get(d), "pin:" + p.niche);
    if (!schedTo.get(p.runId)) continue; // прогон без расписанных пинов покрытием не считается
    for (const u of [nurl(p.url), nurl(p.finalUrl)]) if (u) { const k = d + "|" + u; (urlRuns.get(k) ?? urlRuns.set(k, new Set()).get(k)!).add(p.runId); }
  }
  for (const h of hist) { const d = pinDom.get(h.siteId); if (d) get(d).histUrls.add(nurl(h.url)); }
  for (const u of uploads) { const d = pinDom.get(u.pinSiteId); if (d) get(d).uploads.push(u.day); }

  const used = new Set<string>();
  const add = (s: Site, key: ClusterKey, status: string, wpUrl: string | null, at: Date | null) => {
    const c = (s.cl[key] ??= { total: 0, pub: 0, pinned: 0, pinRuns: new Set(), urls: [] });
    c.total++;
    if (status !== "COMPLETED" || !wpUrl) return;
    c.pub++;
    c.urls.push({ path: urlPath(wpUrl), at });
    const u = nurl(wpUrl);
    const rs = urlRuns.get(s.domain + "|" + u);
    if (rs) { c.pinned++; for (const id of rs) { c.pinRuns.add(id); used.add(id); } } else if (s.histUrls.has(u)) c.pinned++;
  };
  const runSize = new Map<string, number>();
  for (const a of arts) if (a.runId) runSize.set(a.runId, (runSize.get(a.runId) ?? 0) + 1);
  const picked: { s: Site; key: ClusterKey; season: ClusterKey | null; status: string; wpUrl: string | null; at: Date | null }[] = [];
  const seasonCount = new Map<string, number>();
  for (const a of arts) {
    const d = artDom.get(a.siteId); if (!d) continue;
    const isCopy = copySet.has(a.id);
    if (!isCopy && (!a.runId || (runSize.get(a.runId) ?? 0) < MIN_RUN)) continue;
    const s = get(d);
    const n = a.recipeId ? recNiche.get(a.recipeId) : null; if (n) bump(s, "art:" + n);
    const year = Math.max(0, ...(a.keyword.match(/20\d\d/g) ?? []).map(Number));
    // Christmas и всё с годом 2026 — постоянный кластер CHRISTMAS 2026; Christmas 2027 и дальше — уже отдельные кластеры по году.
    const key = isCopy ? "copy" : (XMAS.test(a.keyword) && year < 2027) || year === 2026 ? "xmas" : "y2027";
    const name = key === "y2027" ? SEASONS.find(([, , re]) => re.test(a.keyword))?.[0] ?? (year >= 2028 ? "year" : null) : null;
    const season = name ? `${name}:${year || ""}` : null;
    if (season) seasonCount.set(d + "|" + season, (seasonCount.get(d + "|" + season) ?? 0) + 1);
    picked.push({ s, key, season, status: a.status, wpUrl: a.wpUrl, at: a.publishedAt ?? a.finishedAt ?? a.createdAt });
  }
  for (const p of picked) add(p.s, p.season && (seasonCount.get(p.s.domain + "|" + p.season) ?? 0) >= MIN_RUN ? p.season : p.key, p.status, p.wpUrl, p.at);
  for (const p of posts) { const d = blogDom.get(p.siteId); if (d) add(get(d), "blog", p.status, p.wpUrl, p.publishedAt ?? p.finishedAt ?? p.createdAt); }

  const out: GridSite[] = [];
  for (const s of sites.values()) {
    const clusters: GridSite["clusters"] = {};
    for (const [k, c] of Object.entries(s.cl) as [ClusterKey, Acc | undefined][]) {
      if (!c) continue;
      const tos = [...c.pinRuns].map((id) => schedTo.get(id)).filter((x): x is string => !!x).sort();
      clusters[k] = { total: c.total, pub: c.pub, pinned: c.pinned, pinTo: tos[tos.length - 1] ?? null, traffic: clusterTraffic(c.urls, weeks.get(s.domain), today) };
    }
    const oldRuns = s.pinRunIds.filter((id) => !used.has(id) && (runPages.get(id) ?? 0) >= MIN_RUN && schedTo.get(id));
    const old = oldRuns.length
      ? { pages: oldRuns.reduce((n, id) => n + (runPages.get(id) ?? 0), 0), pinTo: oldRuns.map((id) => schedTo.get(id)!).sort().pop()!, traffic: clusterTraffic(oldRuns.flatMap((id) => runPaths.get(id) ?? []), weeks.get(s.domain), today) }
      : null;
    if (!Object.keys(clusters).length && !old) continue;
    const until = s.pinRunIds.map((id) => schedTo.get(id)).filter((x): x is string => !!x).sort().pop() ?? null;
    const vote = (prefix: string): Kind | null => {
      const sum: Partial<Record<Kind, number>> = {};
      for (const [k, c] of Object.entries(s.niches)) { const kd = k.startsWith(prefix) ? KIND_OF[k.slice(prefix.length)] : undefined; if (kd) sum[kd] = (sum[kd] ?? 0) + c; }
      return (Object.entries(sum) as [Kind, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const kind: Kind = vote("art:") ?? vote("pin:") ?? "women";
    out.push({ domain: s.domain, kind, clusters, old, until, uploadLast: s.uploads.sort().pop() ?? null });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

type Color = "g" | "r" | "y" | "x" | "b";
export type Tab = { title: string; values: (string | number)[][]; colors: [number, number, Color][]; merges: number[][]; widths: Record<number, number>; dates: number[]; groups: number[]; cols: number; noteCol: number; frozenCols?: number };

/** Клетка «трафик, 7 дн» кластера: визиты людей на статьи кластера за 7 дней и изменение к предыдущим 7 (Метрика, страницы входа). */
function trafficCell(t: Traffic | null | undefined): { text: string; color: Color | null } {
  if (!t) return { text: "—", color: "x" };
  if (!t.n) return { text: t.young ? `ждём (${t.young} нов.)` : "—", color: "x" };
  const c = cmp(t.v7, t.p7);
  return { text: t.young ? `${c.text} · ${t.young} нов.` : c.text, color: c.color ?? (t.v7 === 0 && t.p7 === 0 ? "x" : null) };
}

/**
 * Вкладка-сетка для одной ниши. notes — ручные заметки владельца по домену; week — клики с Pinterest за 7 дней (первая колонка);
 * pinDay — до какого дня Pinterest отдал аналитику (в шапке первой колонки, чтобы было видно задержку самого Pinterest).
 */
export function buildGridTab(kind: Kind, title: string, all: GridSite[], today: string, notes: Map<string, string>, week: Map<string, WeekCell> = new Map(), pinDay: string | null = null): Tab {
  const mine = all.filter((x) => x.kind === kind);
  // Постоянные кластеры — всегда; сезонные — только те, что уже есть хотя бы у одного сайта вкладки.
  const dyn = [...new Set(mine.flatMap((x) => Object.keys(x.clusters)))].filter((k) => !BASE_KEYS.includes(k)).sort((a, b) => dynOrder(a) - dynOrder(b));
  const keys: ClusterKey[] = [...BASE_KEYS.slice(0, 2), ...dyn, ...BASE_KEYS.slice(2)];
  const lag = pinDay ? daysBetween(today, pinDay) : null;
  const h1: string[] = ["КЛИКИ С PINTEREST", "САЙТ"], h2: string[] = [pinDay ? `7 дней к прошлым 7 · Pinterest отдал до ${dm(pinDay)}${lag != null && lag > 2 ? ` (задержка ${lag} дн.)` : ""}` : "7 дней · к прошлым 7", ""], merges: number[][] = [];
  for (const k of keys) { merges.push([0, 1, h1.length, h1.length + 3]); h1.push(clusterTitle(k), "", ""); h2.push("статьи", "пины", "трафик, 7 дн"); }
  const oldC = h1.length; merges.push([0, 1, oldC, oldC + 2]); h1.push("СТАРЫЕ СТАТЬИ САЙТА", ""); h2.push("пины", "трафик, 7 дн");
  const t0 = h1.length; h1.push("ИТОГО ПО САЙТУ", "", "", "", ""); h2.push("пины расписаны до", "запас, дней", "последняя заливка", "что сделать", "заметка");
  merges.push([0, 1, t0, t0 + 5], [0, 2, 1, 2]);
  const values: (string | number)[][] = [h1, h2];
  const colors: [number, number, Color][] = [];
  const band = (left: number): Color => (left < 0 ? "r" : left <= 7 ? "y" : "g");
  for (const s of mine) {
    const r = values.length; const w = week.get(s.domain); const row: (string | number)[] = [w?.text ?? "—", s.domain]; const todo: string[] = [];
    colors.push([r, 0, w ? w.color ?? "x" : "x"]);
    const traffic = (t: Traffic | null | undefined) => { const c = trafficCell(t); if (c.color) colors.push([r, row.length, c.color]); row.push(c.text); };
    for (const k of keys) {
      const c = s.clusters[k]; const ci = row.length; const core = k !== "copy";
      // Нет кластера; блог и мешап с парой пробных статей тоже считаем «не писали».
      if (!c || ((k === "blog" || k === "copy") && c.pub < 5)) { row.push(core ? "нет" : "—", "—", "—"); colors.push([r, ci, core ? "r" : "x"], [r, ci + 1, "x"], [r, ci + 2, "x"]); continue; }
      if (c.pub === 0) { row.push(`пишется (${c.total})`, "—", "—"); colors.push([r, ci, "y"], [r, ci + 1, "x"], [r, ci + 2, "x"]); continue; }
      row.push(c.pub); colors.push([r, ci, "g"]);
      const miss = c.pub - c.pinned;
      if (c.pinned === 0 || !c.pinTo) { row.push("нет"); colors.push([r, ci + 1, "r"]); todo.push(`пины на ${clusterWord(k)}: ${miss} ст.`); }
      else if (miss >= MIN_RUN) { row.push(`нет на ${miss} ст.`); colors.push([r, ci + 1, "y"]); todo.push(`пины на ${clusterWord(k)}: ещё ${miss} ст.`); }
      else {
        const left = daysBetween(c.pinTo, today);
        row.push(left < 0 ? `кончились ${dm(c.pinTo)}` : left <= 7 ? `до ${dm(c.pinTo)} ⚠` : `до ${dmy(c.pinTo)}`);
        colors.push([r, ci + 1, band(left)]);
      }
      traffic(c.traffic);
    }
    if (s.old) { const left = daysBetween(s.old.pinTo, today); row.push(`${s.old.pages} стр., ${left < 0 ? `кончились ${dm(s.old.pinTo)}` : `до ${dmy(s.old.pinTo)}`}`); colors.push([r, oldC, left < 0 ? "x" : "g"]); traffic(s.old.traffic); }
    else { row.push("—", "—"); colors.push([r, oldC, "x"], [r, oldC + 1, "x"]); }
    const left = s.until ? daysBetween(s.until, today) : null;
    if (s.until && left != null) {
      row.push(s.until, `=${colLetter(t0)}${r + 1}-TODAY()`); colors.push([r, t0, band(left)], [r, t0 + 1, band(left)]);
      if (left < 0) todo.push(`пины закончились ${dm(s.until)}`); else if (left <= 7) todo.push(`пины кончаются ${dm(s.until)}`);
    } else { row.push("нет пинов", ""); colors.push([r, t0, "r"], [r, t0 + 1, "r"]); }
    const live = left != null && left >= 0;
    if (s.uploadLast) {
      const ago = daysBetween(today, s.uploadLast); const stale = ago >= 3 && live;
      row.push(s.uploadLast); colors.push([r, t0 + 2, stale ? "y" : ago < 3 ? "g" : "x"]);
      if (stale) todo.push(`заливка стоит с ${dm(s.uploadLast)}`);
    } else { row.push(live ? "не отмечена" : "—"); colors.push([r, t0 + 2, live ? "y" : "x"]); if (live) todo.push("нет отметок о заливке"); }
    row.push(todo.length ? todo.join("; ") : "ок");
    colors.push([r, t0 + 3, !todo.length ? "g" : todo.some((x) => x.startsWith("пины на") || x.startsWith("пины закончились")) ? "r" : "y"]);
    row.push(notes.get(s.domain) ?? "");
    values.push(row);
  }
  const widths: Record<number, number> = { 0: 150, 1: 200, [oldC]: 170, [oldC + 1]: 100, [t0]: 95, [t0 + 1]: 70, [t0 + 2]: 95, [t0 + 3]: 330, [t0 + 4]: 240 };
  keys.forEach((_, i) => { widths[2 + i * 3] = 80; widths[3 + i * 3] = 120; widths[4 + i * 3] = 100; });
  return { title, values, colors, merges, widths, dates: [t0, t0 + 2], groups: [...keys.map((_, i) => 2 + i * 3), oldC, t0], cols: h1.length, noteCol: t0 + 4, frozenCols: 2 };
}

const LEGEND: string[][] = [
  ["Как читать"], [""],
  ["Одна строка", "Один сайт. Всё, что по нему сделано и не сделано, — в этой одной строке. Женские, декор и кулинария — на разных вкладках."],
  ["Столбцы", "Кластеры: ПОДБОРКИ 2027, CHRISTMAS 2026, сезонные (если есть), БЛОГ, МЕШАП. У каждого две клетки: «статьи» и «пины»."],
  ["Клетка «статьи»", "Число = сколько статей этого кластера опубликовано. «нет» = кластер на этот сайт не писали."],
  ["Клетка «пины»", "«до 27.04.27» = пины на эти статьи сделаны и расписаны до этой даты. «нет» = статьи есть, а пинов на них нет."],
  ["Клетка «трафик, 7 дн»", "Визиты людей (без роботов) на статьи этого кластера за последние 7 дней по Яндекс Метрике (страницы входа) и изменение к предыдущим 7 дням: зелёное — рост от 5%, красное — падение от 5%, «≈» — без изменений. Статьи моложе 3 дней не считаются (на них в первые дни ходит наш робот и прямые заходы) — «· 5 нов.» = столько статей ещё ждут; «ждём» = все статьи кластера пока моложе 3 дней. «—» = у сайта нет счётчика Метрики или данных ещё нет (собираются ночью)."],
  ["Старые статьи сайта", "Пины на статьи, которые были на сайте раньше (написаны не через портал)."],
  ["Итого по сайту", "До какого дня вообще есть пины, сколько дней запаса, когда последний раз залили в Pinterest и что сделать."],
  [""],
  ["зелёное", "сделано"],
  ["жёлтое", "сделано не всё или скоро закончится (осталось 7 дней и меньше)"],
  ["красное", "не сделано: статей нет, пинов нет или пины закончились"],
  ["серое", "не относится к сайту или уже прошло"],
  [""],
  ["Сезоны и праздники (Winter, Valentine, Spring, Easter, Summer, Fall, Halloween, Thanksgiving, Christmas и др.) появляются сами: портал смотрит на слово и год в ключе, например SPRING 2027. Столбец добавится, когда на каком-то сайте вкладки наберётся 20 таких статей; до этого они считаются в ПОДБОРКАХ 2027. Так же появятся ПОДБОРКИ 2028."],
  ["Тестовые запуски меньше 20 статей не считаются. Таблицу заполняет портал zewex.tools сам, раз в час."],
  ["Колонку «заметка» ведёте вы — она сохраняется. Остальное портал перезаписывает, править там руками не нужно."],
  [""],
  ["Первая колонка на вкладках ниш", "Клики на сайт из Pinterest за последние 7 дней и изменение к предыдущим 7 дням. Зелёное — рост от 5%, ярко-зелёное — резкий рост (от +30%): на такой сайт стоит писать и пинить больше. Красное — падение от 5%. «—» — аналитика аккаунта ещё не собрана. Подробности — на вкладке «Трафик». В шапке колонки — до какого дня Pinterest отдал цифры: агент снимает аналитику каждую ночь, но сам Pinterest закрывает дни с задержкой (обычно 2 дня, бывает и 5) — раньше этого дня данных нет ни у кого."],
  ["Вкладка «Заливка»", "Все сайты команды × последние 7 дней: залито ли в этот день и сколько пинов, а если нет — почему: нет файла (пинов на день нет или все уже залиты), Dolphin выключен, прокси не работает, нет входа в Pinterest, Pinterest отклонил, профиль не найден, не запускалось. Зелёное — залито, красное — сбой, жёлтое — пропущено (нет файла, профиль другой команды), серое — пинов на день нет или сайт не в «Пинах». В конце строки — что сделать по последнему сбою."],
  ["Трафик: порядок и рейтинг", "Сайты идут по убыванию кликов на сайт из Pinterest за 30 дней. Слева место и стрелка — на сколько мест сайт поднялся или опустился за неделю. Ярко-зелёное название сайта = резкий рост кликов (за 7 дней от +30% или за день вдвое); что с ним делать — в колонке «что сделать» в конце строки."],
  ["Вкладка «Трафик»", "Показы и клики на сайт из аналитики аккаунта Pinterest и визиты из Яндекс Метрики. В клетке — число и изменение: 30 дней к предыдущим 30, 7 дней к предыдущим 7, день к тому же дню недели неделей раньше. Рост от 5% — зелёным, падение от 5% — красным, «≈» — без заметных изменений."],
  ["Pinterest", "Читает агент заливки, когда заходит в профиль (в визите заливки или отдельным ночным заходом). Считается до последнего закрытого дня: сегодня и вчера у Pinterest ещё оценка. Вовлечённость, save rate и CTR на сайт — доля от показов за 30 дней."],
  ["Метрика", "Портал забирает ночью по токену команды (Заливка в Pinterest → Настройки). «Визиты людей» — без роботов; «с Pinterest» — переходы из соцсети Pinterest и по ссылкам с меткой utm_source=Pinterest вместе (Метрика показывает их в двух разных отчётах); это только размеченные переходы — заметная часть кликов из приложения Pinterest приходит без источника и попадает в Метрике в «прямые заходы», поэтому цифра ниже, чем «клики на сайт» у Pinterest; «роботы» — доля роботов во всех визитах."],
];
const LEGEND_COLORS: Record<number, Color> = { 9: "g", 10: "y", 11: "r", 12: "x" };

const rgb = (r: number, g: number, b: number) => ({ red: r / 255, green: g / 255, blue: b / 255 });
const BG: Record<Color, ReturnType<typeof rgb>> = { g: rgb(183, 225, 205), r: rgb(244, 180, 180), y: rgb(255, 229, 153), x: rgb(239, 239, 239), b: rgb(0, 200, 83) };
type Meta = { sheets?: Array<{ properties?: { sheetId?: number; title?: string }; merges?: unknown[] }> };

let running = false;
const lastHash = new Map<string, string>();

/** Тик воркера: пересобрать сетки всех команд; сбой одной таблицы не мешает остальным. */
export async function prjGridTick(force = false): Promise<{ written: boolean; sites: number; errors: string[] }> {
  if (running) return { written: false, sites: 0, errors: [] };
  running = true;
  try {
    let written = false, total = 0; const errors: string[] = [];
    for (const t of TARGETS) {
      try { const r = await writeGrid(t, force); written ||= r.written; total += r.sites; }
      catch (e) { errors.push(`${t.team}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`); }
    }
    return { written, sites: total, errors };
  } finally {
    running = false;
  }
}

/** Сетка одной команды в её таблице; пишем, только если данные или заметки изменились. */
async function writeGrid(target: Target, force: boolean): Promise<{ written: boolean; sites: number }> {
  const SHEET_ID = target.sheet;
  const OLD = target.dropOld ? OLD_TABS : [];
  const batch = (requests: unknown[]) => (requests.length ? sheetsFetch(`/spreadsheets/${SHEET_ID}:batchUpdate`, { method: "POST", body: { requests } }) : Promise.resolve(null));
  const putValues = (range: string, values: unknown[][]) => sheetsFetch(`${rangePath(SHEET_ID, range)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values } });
  {
    const today = todayStr();
    const sites = await collectGrid(target.team, today, await urlWeeks(target.team));
    if (!sites.length) return { written: false, sites: 0 };
    const meta = () => sheetsFetch<Meta>(`/spreadsheets/${SHEET_ID}?fields=sheets(properties(sheetId,title),merges)`);
    let m = await meta();
    const find = (t: string) => (m.sheets ?? []).find((s) => s.properties?.title === t);
    // Женские и декор — всегда; кулинария — только если такие сайты у команды есть.
    const defs = KIND_TABS.filter(([k]) => k !== "food" || sites.some((x) => x.kind === k));
    const tabs: Tab[] = [];
    const [week, pinDay] = await Promise.all([weekClicks(target.team, today), pinReadyDay(target.team)]);
    for (const [kind, title] of defs) {
      const notes = new Map<string, string>();
      if (find(title)) {
        const cur = await sheetsFetch<{ values?: unknown[][] }>(rangePath(SHEET_ID, `${quoteTab(title)}!A1:AZ300`));
        const rows = cur.values ?? [];
        const nc = (rows[1] ?? []).findIndex((v) => String(v ?? "").trim().toLowerCase() === "заметка");
        const dc = Math.max(0, (rows[0] ?? []).findIndex((v) => String(v ?? "").trim() === "САЙТ"));
        if (nc >= 0) for (const r of rows.slice(2)) { const d = String(r?.[dc] ?? "").trim(); const n = String(r?.[nc] ?? "").trim(); if (d && n) notes.set(d, n); }
      }
      tabs.push(buildGridTab(kind, title, sites, today, notes, week, pinDay));
    }
    // «Заливка»: все сайты × последние 7 дней — залито или почему нет (src/lib/projects/uploads.ts).
    const kindOrder = new Map(defs.map(([k], i) => [k, i]));
    tabs.push(await buildUploadsTab(target.team, [...sites].sort((a, b) => (kindOrder.get(a.kind) ?? 9) - (kindOrder.get(b.kind) ?? 9) || a.domain.localeCompare(b.domain)).map((x) => ({ domain: x.domain, kind: (new Map(KIND_TABS).get(x.kind) ?? "").toLowerCase() })), today));
    // «Трафик»: показы и клики Pinterest, визиты Метрики — те же сайты в том же порядке (src/lib/projects/stats.ts).
    const kindTitle = new Map(KIND_TABS);
    const traffic = await buildTrafficTab(target.team, defs.flatMap(([k]) => sites.filter((x) => x.kind === k).map((x) => ({ domain: x.domain, kind: (kindTitle.get(k) ?? "").toLowerCase(), pinsLeft: x.until ? daysBetween(x.until, today) : null }))), today);
    if (traffic) tabs.push(traffic);
    const stamp = `Обновлено: ${new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" })}`;
    const hash = createHash("sha1").update(JSON.stringify(tabs.map((t) => [t.values, t.colors]))).digest("hex");
    const ready = !!find(LEGEND_TAB) && tabs.every((t) => find(t.title)) && !OLD.some((t) => find(t));
    if (!force && ready && hash === lastHash.get(SHEET_ID)) { await putValues(`${quoteTab(LEGEND_TAB)}!B1`, [[stamp]]); return { written: false, sites: sites.length }; }

    const pre: unknown[] = [];
    for (const t of [...tabs.map((x) => x.title), LEGEND_TAB]) if (!find(t)) pre.push({ addSheet: { properties: { title: t } } });
    // Вкладки первых вариантов (список сайтов и прогонов) заменены сеткой — убираем, чтобы не лежал устаревший снимок.
    for (const t of OLD) { const s = find(t); if (s) pre.push({ deleteSheet: { sheetId: s.properties!.sheetId } }); }
    if (pre.length) { await batch(pre); m = await meta(); }

    const req: unknown[] = [];
    [...tabs.map((x) => x.title), LEGEND_TAB].forEach((t, i) => req.push({ updateSheetProperties: { properties: { sheetId: find(t)!.properties!.sheetId, index: i }, fields: "index" } }));
    for (const t of tabs) {
      const sh = find(t.title)!; const sheetId = sh.properties!.sheetId!; const rows = t.values.length, cols = t.cols;
      const cell = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
      const all = cell(0, 300, 0, 52);
      await sheetsFetch(`${rangePath(SHEET_ID, quoteTab(t.title))}:clear`, { method: "POST", body: {} });
      await putValues(`${quoteTab(t.title)}!A1`, t.values);
      if ((sh.merges ?? []).length) req.push({ unmergeCells: { range: all } });
      req.push({ repeatCell: { range: all, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } });
      const none = { style: "NONE" };
      req.push({ updateBorders: { range: all, top: none, bottom: none, left: none, right: none, innerHorizontal: none, innerVertical: none } });
      for (const [c, px] of Object.entries(t.widths)) req.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: +c, endIndex: +c + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } });
      req.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2, frozenColumnCount: t.frozenCols ?? 1 } }, fields: "gridProperties(frozenRowCount,frozenColumnCount)" } });
      for (const [r0, r1, c0, c1] of t.merges) req.push({ mergeCells: { range: cell(r0, r1, c0, c1), mergeType: "MERGE_ALL" } });
      const head = (bg: ReturnType<typeof rgb>, fontSize: number) => ({ backgroundColor: bg, textFormat: { bold: true, fontSize, foregroundColor: rgb(255, 255, 255) }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" });
      req.push({ repeatCell: { range: cell(0, 1, 0, cols), cell: { userEnteredFormat: head(rgb(38, 50, 56), 11) }, fields: "userEnteredFormat" } });
      req.push({ repeatCell: { range: cell(1, 2, 0, cols), cell: { userEnteredFormat: head(rgb(84, 110, 122), 9) }, fields: "userEnteredFormat" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 2 }, properties: { pixelSize: 34 }, fields: "pixelSize" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: rows }, properties: { pixelSize: 30 }, fields: "pixelSize" } });
      const align = "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)";
      req.push({ repeatCell: { range: cell(2, rows, t.frozenCols === 2 ? 0 : 1, cols), cell: { userEnteredFormat: { horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } }, fields: align } });
      req.push({ repeatCell: { range: cell(2, rows, cols - 2, cols), cell: { userEnteredFormat: { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } }, fields: align } });
      req.push({ repeatCell: { range: cell(2, rows, 0, t.frozenCols ?? 1), cell: { userEnteredFormat: { textFormat: { bold: true }, verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat(textFormat,verticalAlignment)" } });
      for (const c of t.dates) req.push({ repeatCell: { range: cell(2, rows, c, c + 1), cell: { userEnteredFormat: { numberFormat: { type: "DATE", pattern: "dd.mm.yy" } } }, fields: "userEnteredFormat.numberFormat" } });
      for (const [r, c, k] of t.colors) req.push({ repeatCell: { range: cell(r, r + 1, c, c + 1), cell: { userEnteredFormat: { backgroundColor: BG[k] } }, fields: "userEnteredFormat.backgroundColor" } });
      const thin = { style: "SOLID", color: rgb(255, 255, 255) }, thick = { style: "SOLID_MEDIUM", color: rgb(38, 50, 56) };
      req.push({ updateBorders: { range: cell(2, rows, 0, cols), innerHorizontal: thin, innerVertical: thin } });
      for (const g of t.groups) req.push({ updateBorders: { range: cell(0, rows, g, g + 1), left: thick } });
    }
    {
      const sheetId = find(LEGEND_TAB)!.properties!.sheetId!; const rows = LEGEND.length;
      const cell = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
      await sheetsFetch(`${rangePath(SHEET_ID, quoteTab(LEGEND_TAB))}:clear`, { method: "POST", body: {} });
      await putValues(`${quoteTab(LEGEND_TAB)}!A1`, LEGEND.map((r, i) => (i === 0 ? [r[0], stamp] : r)));
      req.push({ repeatCell: { range: cell(0, 300, 0, 26), cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 210 }, fields: "pixelSize" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 780 }, fields: "pixelSize" } });
      req.push({ repeatCell: { range: cell(0, rows, 0, 2), cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat(wrapStrategy,verticalAlignment)" } });
      req.push({ repeatCell: { range: cell(1, rows, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: "OVERFLOW_CELL" } }, fields: "userEnteredFormat(textFormat,wrapStrategy)" } });
      req.push({ repeatCell: { range: cell(0, 1, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 }, wrapStrategy: "OVERFLOW_CELL" } }, fields: "userEnteredFormat(textFormat,wrapStrategy)" } });
      for (const [r, k] of Object.entries(LEGEND_COLORS)) req.push({ repeatCell: { range: cell(+r, +r + 1, 0, 1), cell: { userEnteredFormat: { backgroundColor: BG[k], textFormat: { bold: true } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } });
    }
    await batch(req);
    lastHash.set(SHEET_ID, hash);
    return { written: true, sites: sites.length };
  }
}
