/**
 * «Проекты» → Google-таблица владельца «Pinterest CRM»: сетка «сайт × кластер» по команде Zewex.
 * Вкладки «Женские» и «Декор»: одна строка = один сайт, столбцы = кластеры (подборки 2027, Christmas 2026, блог, мешап,
 * пины на старые статьи), у кластера две клетки — «статьи» (сколько опубликовано) и «пины» (до какого дня расписаны);
 * справа итог по сайту: пины до, запас, последняя заливка, что сделать и ручная колонка «заметка» (сохраняется при перезаписи).
 * Цвет клетки: зелёный — сделано, жёлтый — частично или кончается за 7 дней, красный — не сделано, серый — не относится.
 * Портал только читает свои таблицы; пишет воркер раз в час (prjGridTick из worker/cron.ts), целиком, если что-то изменилось.
 * Таблица — PRJ_GRID_SHEET_ID (.env) или таблица владельца по умолчанию; доступ у сервисного аккаунта «Статей».
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { sheetsFetch, quoteTab, rangePath } from "@/lib/articles/sheets";

const SHEET_ID = process.env.PRJ_GRID_SHEET_ID || "1XNNsdYRlPYkEGZ63XosMLECA7tsRbogCAvRZ9gRLZaA";
const TEAM_SLUG = process.env.PRJ_GRID_TEAM || "zewex";
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
const colLetter = (i: number) => String.fromCharCode(65 + i);

type ClusterKey = "y2027" | "xmas" | "blog" | "copy";
type Cluster = { total: number; pub: number; pinned: number; pinTo: string | null };
type GridSite = { domain: string; kind: "women" | "decor"; clusters: Partial<Record<ClusterKey, Cluster>>; old: { pages: number; pinTo: string } | null; until: string | null; uploadLast: string | null };

const CLUSTER_TITLE: Record<ClusterKey, string> = { y2027: "ПОДБОРКИ 2027", xmas: "CHRISTMAS 2026", blog: "БЛОГ", copy: "МЕШАП (Article Copy)" };
const CLUSTER_WORD: Record<ClusterKey, string> = { y2027: "подборки 2027", xmas: "christmas 2026", blog: "блог", copy: "мешап" };

/** Сводка по сайтам команды: кластеры статей, покрытие пинами (по URL страниц прогонов и истории), расписание, заливка. */
export async function collectGrid(): Promise<GridSite[]> {
  const team = await prisma.team.findUnique({ where: { slug: TEAM_SLUG }, select: { id: true } });
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
    prisma.article.findMany({ where: { teamId }, select: { id: true, siteId: true, runId: true, recipeId: true, status: true, keyword: true, wpUrl: true } }),
    prisma.blogPost.findMany({ where: { teamId }, select: { siteId: true, status: true, wpUrl: true } }),
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

  type Acc = { total: number; pub: number; pinned: number; pinRuns: Set<string> };
  type Site = { domain: string; niches: Record<string, number>; cl: Partial<Record<ClusterKey, Acc>>; histUrls: Set<string>; pinRunIds: string[]; uploads: string[] };
  const sites = new Map<string, Site>();
  const get = (d: string) => sites.get(d) ?? sites.set(d, { domain: d, niches: {}, cl: {}, histUrls: new Set(), pinRunIds: [], uploads: [] }).get(d)!;
  const bump = (s: Site, k: string) => { s.niches[k] = (s.niches[k] ?? 0) + 1; };

  const schedTo = new Map(itemAgg.map((i) => [i.runId, day(i._max.scheduledAt)]));
  const runDom = new Map<string, string>();
  for (const r of pinRuns) { const d = r.siteId ? pinDom.get(r.siteId) : null; if (d) { runDom.set(r.id, d); get(d).pinRunIds.push(r.id); } }
  const urlRuns = new Map<string, Set<string>>();
  const runPages = new Map<string, number>();
  for (const p of pages) {
    const d = runDom.get(p.runId); if (!d) continue;
    runPages.set(p.runId, (runPages.get(p.runId) ?? 0) + 1);
    if (p.niche) bump(get(d), "pin:" + p.niche);
    if (!schedTo.get(p.runId)) continue; // прогон без расписанных пинов покрытием не считается
    for (const u of [nurl(p.url), nurl(p.finalUrl)]) if (u) { const k = d + "|" + u; (urlRuns.get(k) ?? urlRuns.set(k, new Set()).get(k)!).add(p.runId); }
  }
  for (const h of hist) { const d = pinDom.get(h.siteId); if (d) get(d).histUrls.add(nurl(h.url)); }
  for (const u of uploads) { const d = pinDom.get(u.pinSiteId); if (d) get(d).uploads.push(u.day); }

  const used = new Set<string>();
  const add = (s: Site, key: ClusterKey, status: string, wpUrl: string | null) => {
    const c = (s.cl[key] ??= { total: 0, pub: 0, pinned: 0, pinRuns: new Set() });
    c.total++;
    if (status !== "COMPLETED" || !wpUrl) return;
    c.pub++;
    const u = nurl(wpUrl);
    const rs = urlRuns.get(s.domain + "|" + u);
    if (rs) { c.pinned++; for (const id of rs) { c.pinRuns.add(id); used.add(id); } } else if (s.histUrls.has(u)) c.pinned++;
  };
  const runSize = new Map<string, number>();
  for (const a of arts) if (a.runId) runSize.set(a.runId, (runSize.get(a.runId) ?? 0) + 1);
  for (const a of arts) {
    const d = artDom.get(a.siteId); if (!d) continue;
    const isCopy = copySet.has(a.id);
    if (!isCopy && (!a.runId || (runSize.get(a.runId) ?? 0) < MIN_RUN)) continue;
    const s = get(d);
    const n = a.recipeId ? recNiche.get(a.recipeId) : null; if (n) bump(s, "art:" + n);
    add(s, isCopy ? "copy" : XMAS.test(a.keyword) || (/2026/.test(a.keyword) && !/2027/.test(a.keyword)) ? "xmas" : "y2027", a.status, a.wpUrl);
  }
  for (const p of posts) { const d = blogDom.get(p.siteId); if (d) add(get(d), "blog", p.status, p.wpUrl); }

  const out: GridSite[] = [];
  for (const s of sites.values()) {
    const clusters: GridSite["clusters"] = {};
    for (const [k, c] of Object.entries(s.cl) as [ClusterKey, Acc][]) {
      const tos = [...c.pinRuns].map((id) => schedTo.get(id)).filter((x): x is string => !!x).sort();
      clusters[k] = { total: c.total, pub: c.pub, pinned: c.pinned, pinTo: tos[tos.length - 1] ?? null };
    }
    const oldRuns = s.pinRunIds.filter((id) => !used.has(id) && (runPages.get(id) ?? 0) >= MIN_RUN && schedTo.get(id));
    const old = oldRuns.length ? { pages: oldRuns.reduce((n, id) => n + (runPages.get(id) ?? 0), 0), pinTo: oldRuns.map((id) => schedTo.get(id)!).sort().pop()! } : null;
    if (!Object.keys(clusters).length && !old) continue;
    const until = s.pinRunIds.map((id) => schedTo.get(id)).filter((x): x is string => !!x).sort().pop() ?? null;
    const n = s.niches;
    const women = ["outfits", "hair", "nails"].some((k) => n["art:" + k]);
    const pinWomen = (n["pin:hair"] ?? 0) + (n["pin:outfit"] ?? 0) + (n["pin:nails"] ?? 0);
    const kind = n["art:interior"] ? "decor" : women ? "women" : (n["pin:decor"] ?? 0) > pinWomen ? "decor" : "women";
    out.push({ domain: s.domain, kind, clusters, old, until, uploadLast: s.uploads.sort().pop() ?? null });
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain));
}

type Color = "g" | "r" | "y" | "x";
type Tab = { title: string; values: (string | number)[][]; colors: [number, number, Color][]; merges: number[][]; widths: Record<number, number>; dates: number[]; groups: number[]; cols: number; noteCol: number };

/** Вкладка-сетка для одной ниши. notes — ручные заметки владельца по домену. */
export function buildGridTab(kind: "women" | "decor", title: string, all: GridSite[], today: string, notes: Map<string, string>): Tab {
  const keys: ClusterKey[] = kind === "women" ? ["y2027", "xmas", "blog", "copy"] : ["y2027", "xmas", "blog"];
  const h1: string[] = ["САЙТ"], h2: string[] = [""], merges: number[][] = [];
  for (const k of keys) { merges.push([0, 1, h1.length, h1.length + 2]); h1.push(CLUSTER_TITLE[k], ""); h2.push("статьи", "пины"); }
  const oldC = h1.length; h1.push("СТАРЫЕ СТАТЬИ САЙТА"); h2.push("пины");
  const t0 = h1.length; h1.push("ИТОГО ПО САЙТУ", "", "", "", ""); h2.push("пины расписаны до", "запас, дней", "последняя заливка", "что сделать", "заметка");
  merges.push([0, 1, t0, t0 + 5], [0, 2, 0, 1]);
  const values: (string | number)[][] = [h1, h2];
  const colors: [number, number, Color][] = [];
  const band = (left: number): Color => (left < 0 ? "r" : left <= 7 ? "y" : "g");
  for (const s of all.filter((x) => x.kind === kind)) {
    const r = values.length; const row: (string | number)[] = [s.domain]; const todo: string[] = [];
    for (const k of keys) {
      const c = s.clusters[k]; const ci = row.length; const core = k !== "copy";
      // Нет кластера; блог и мешап с парой пробных статей тоже считаем «не писали».
      if (!c || ((k === "blog" || k === "copy") && c.pub < 5)) { row.push(core ? "нет" : "—", "—"); colors.push([r, ci, core ? "r" : "x"], [r, ci + 1, "x"]); continue; }
      if (c.pub === 0) { row.push(`пишется (${c.total})`, "—"); colors.push([r, ci, "y"], [r, ci + 1, "x"]); continue; }
      row.push(c.pub); colors.push([r, ci, "g"]);
      const miss = c.pub - c.pinned;
      if (c.pinned === 0 || !c.pinTo) { row.push("нет"); colors.push([r, ci + 1, "r"]); todo.push(`пины на ${CLUSTER_WORD[k]}: ${miss} ст.`); }
      else if (miss >= MIN_RUN) { row.push(`нет на ${miss} ст.`); colors.push([r, ci + 1, "y"]); todo.push(`пины на ${CLUSTER_WORD[k]}: ещё ${miss} ст.`); }
      else {
        const left = daysBetween(c.pinTo, today);
        row.push(left < 0 ? `кончились ${dm(c.pinTo)}` : left <= 7 ? `до ${dm(c.pinTo)} ⚠` : `до ${dmy(c.pinTo)}`);
        colors.push([r, ci + 1, band(left)]);
      }
    }
    if (s.old) { const left = daysBetween(s.old.pinTo, today); row.push(`${s.old.pages} стр., ${left < 0 ? `кончились ${dm(s.old.pinTo)}` : `до ${dmy(s.old.pinTo)}`}`); colors.push([r, oldC, left < 0 ? "x" : "g"]); }
    else { row.push("—"); colors.push([r, oldC, "x"]); }
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
  const widths: Record<number, number> = { 0: 200, [oldC]: 170, [t0]: 95, [t0 + 1]: 70, [t0 + 2]: 95, [t0 + 3]: 330, [t0 + 4]: 240 };
  keys.forEach((_, i) => { widths[1 + i * 2] = 90; widths[2 + i * 2] = 125; });
  return { title, values, colors, merges, widths, dates: [t0, t0 + 2], groups: [...keys.map((_, i) => 1 + i * 2), oldC, t0], cols: h1.length, noteCol: t0 + 4 };
}

const LEGEND: string[][] = [
  ["Как читать"], [""],
  ["Одна строка", "Один сайт. Всё, что по нему сделано и не сделано, — в этой одной строке. Женские и декор — на разных вкладках."],
  ["Столбцы", "Кластеры: ПОДБОРКИ 2027, CHRISTMAS 2026, БЛОГ, МЕШАП. У каждого две клетки: «статьи» и «пины»."],
  ["Клетка «статьи»", "Число = сколько статей этого кластера опубликовано. «нет» = кластер на этот сайт не писали."],
  ["Клетка «пины»", "«до 27.04.27» = пины на эти статьи сделаны и расписаны до этой даты. «нет» = статьи есть, а пинов на них нет."],
  ["Старые статьи сайта", "Пины на статьи, которые были на сайте раньше (написаны не через портал)."],
  ["Итого по сайту", "До какого дня вообще есть пины, сколько дней запаса, когда последний раз залили в Pinterest и что сделать."],
  [""],
  ["зелёное", "сделано"],
  ["жёлтое", "сделано не всё или скоро закончится (осталось 7 дней и меньше)"],
  ["красное", "не сделано: статей нет, пинов нет или пины закончились"],
  ["серое", "не относится к сайту или уже прошло"],
  [""],
  ["Новые кластеры (Winter, Spring и т. д.) добавятся новыми столбцами, когда их начнём писать."],
  ["Тестовые запуски меньше 20 статей не считаются. Таблицу заполняет портал zewex.tools сам, раз в час."],
  ["Колонку «заметка» ведёте вы — она сохраняется. Остальное портал перезаписывает, править там руками не нужно."],
];
const LEGEND_COLORS: Record<number, Color> = { 9: "g", 10: "y", 11: "r", 12: "x" };

const rgb = (r: number, g: number, b: number) => ({ red: r / 255, green: g / 255, blue: b / 255 });
const BG: Record<Color, ReturnType<typeof rgb>> = { g: rgb(183, 225, 205), r: rgb(244, 180, 180), y: rgb(255, 229, 153), x: rgb(239, 239, 239) };
type Meta = { sheets?: Array<{ properties?: { sheetId?: number; title?: string }; merges?: unknown[] }> };
const batch = (requests: unknown[]) => (requests.length ? sheetsFetch(`/spreadsheets/${SHEET_ID}:batchUpdate`, { method: "POST", body: { requests } }) : Promise.resolve(null));
const putValues = (range: string, values: unknown[][]) => sheetsFetch(`${rangePath(SHEET_ID, range)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values } });

let running = false;
let lastHash = "";

/** Тик воркера: пересобрать сетку; в таблицу пишем, только если данные или заметки изменились. */
export async function prjGridTick(force = false): Promise<{ written: boolean; sites: number }> {
  if (running) return { written: false, sites: 0 };
  running = true;
  try {
    const today = todayStr();
    const sites = await collectGrid();
    if (!sites.length) return { written: false, sites: 0 };
    const meta = () => sheetsFetch<Meta>(`/spreadsheets/${SHEET_ID}?fields=sheets(properties(sheetId,title),merges)`);
    let m = await meta();
    const find = (t: string) => (m.sheets ?? []).find((s) => s.properties?.title === t);
    const defs: Array<["women" | "decor", string]> = [["women", "Женские"], ["decor", "Декор"]];
    const tabs: Tab[] = [];
    for (const [kind, title] of defs) {
      const notes = new Map<string, string>();
      if (find(title)) {
        const cur = await sheetsFetch<{ values?: unknown[][] }>(rangePath(SHEET_ID, `${quoteTab(title)}!A1:Z300`));
        const rows = cur.values ?? [];
        const nc = (rows[1] ?? []).findIndex((v) => String(v ?? "").trim().toLowerCase() === "заметка");
        if (nc >= 0) for (const r of rows.slice(2)) { const d = String(r?.[0] ?? "").trim(); const n = String(r?.[nc] ?? "").trim(); if (d && n) notes.set(d, n); }
      }
      tabs.push(buildGridTab(kind, title, sites, today, notes));
    }
    const stamp = `Обновлено: ${new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" })}`;
    const hash = createHash("sha1").update(JSON.stringify(tabs.map((t) => [t.values, t.colors]))).digest("hex");
    const ready = !!find(LEGEND_TAB) && tabs.every((t) => find(t.title)) && !OLD_TABS.some((t) => find(t));
    if (!force && ready && hash === lastHash) { await putValues(`${quoteTab(LEGEND_TAB)}!B1`, [[stamp]]); return { written: false, sites: sites.length }; }

    const pre: unknown[] = [];
    for (const t of [...tabs.map((x) => x.title), LEGEND_TAB]) if (!find(t)) pre.push({ addSheet: { properties: { title: t } } });
    // Вкладки первых вариантов (список сайтов и прогонов) заменены сеткой — убираем, чтобы не лежал устаревший снимок.
    for (const t of OLD_TABS) { const s = find(t); if (s) pre.push({ deleteSheet: { sheetId: s.properties!.sheetId } }); }
    if (pre.length) { await batch(pre); m = await meta(); }

    const req: unknown[] = [];
    [...tabs.map((x) => x.title), LEGEND_TAB].forEach((t, i) => req.push({ updateSheetProperties: { properties: { sheetId: find(t)!.properties!.sheetId, index: i }, fields: "index" } }));
    for (const t of tabs) {
      const sh = find(t.title)!; const sheetId = sh.properties!.sheetId!; const rows = t.values.length, cols = t.cols;
      const cell = (r0: number, r1: number, c0: number, c1: number) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
      const all = cell(0, 300, 0, 26);
      await sheetsFetch(`${rangePath(SHEET_ID, quoteTab(t.title))}:clear`, { method: "POST", body: {} });
      await putValues(`${quoteTab(t.title)}!A1`, t.values);
      if ((sh.merges ?? []).length) req.push({ unmergeCells: { range: all } });
      req.push({ repeatCell: { range: all, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } });
      const none = { style: "NONE" };
      req.push({ updateBorders: { range: all, top: none, bottom: none, left: none, right: none, innerHorizontal: none, innerVertical: none } });
      for (const [c, px] of Object.entries(t.widths)) req.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: +c, endIndex: +c + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } });
      req.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2, frozenColumnCount: 1 } }, fields: "gridProperties(frozenRowCount,frozenColumnCount)" } });
      for (const [r0, r1, c0, c1] of t.merges) req.push({ mergeCells: { range: cell(r0, r1, c0, c1), mergeType: "MERGE_ALL" } });
      const head = (bg: ReturnType<typeof rgb>, fontSize: number) => ({ backgroundColor: bg, textFormat: { bold: true, fontSize, foregroundColor: rgb(255, 255, 255) }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" });
      req.push({ repeatCell: { range: cell(0, 1, 0, cols), cell: { userEnteredFormat: head(rgb(38, 50, 56), 11) }, fields: "userEnteredFormat" } });
      req.push({ repeatCell: { range: cell(1, 2, 0, cols), cell: { userEnteredFormat: head(rgb(84, 110, 122), 9) }, fields: "userEnteredFormat" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 2 }, properties: { pixelSize: 34 }, fields: "pixelSize" } });
      req.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: rows }, properties: { pixelSize: 30 }, fields: "pixelSize" } });
      const align = "userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy)";
      req.push({ repeatCell: { range: cell(2, rows, 1, cols), cell: { userEnteredFormat: { horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } }, fields: align } });
      req.push({ repeatCell: { range: cell(2, rows, cols - 2, cols), cell: { userEnteredFormat: { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } }, fields: align } });
      req.push({ repeatCell: { range: cell(2, rows, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true }, verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat(textFormat,verticalAlignment)" } });
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
    lastHash = hash;
    return { written: true, sites: sites.length };
  } finally {
    running = false;
  }
}
