/**
 * Article Copy → Google-таблица публикаций: каждая опубликованная мешап-статья дописывается строкой на вкладку
 * своего сайта (вкладка = домен; создаётся, если нет). Таблица — CopySettings.sheetUrl, доступ «Редактор» выдаётся
 * сервисному аккаунту «Статей» (ArtSettings.sheetsEmail). Колонки: Keyword | Niche | Class | Volume | Publish URL |
 * Data Publish | Photos | Batch | Site. Нужна для работы с пинами. Запускает воркер раз в 5 минут (copySheetTick).
 */
import { prisma } from "@/lib/db";
import { sheetsFetch, quoteTab, rangePath } from "@/lib/articles/sheets";
import { copySettings } from "./build";
import { VOL_LABEL, nicheLabel } from "./keys";

const HEADER = ["Keyword", "Niche", "Class", "Volume", "Publish URL", "Data Publish", "Photos", "Batch", "Site"];
const STAMP_TZ = process.env.SHEETS_TZ || "Europe/Kyiv";
let running = false;

export const spreadsheetIdOf = (url: string) => /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url)?.[1] ?? null;
const domainOf = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const stamp = (d: Date) => d.toLocaleString("ru-RU", { timeZone: STAMP_TZ, dateStyle: "short", timeStyle: "short" });

/** Вкладка сайта; создаётся с заголовком, если её нет. */
async function ensureTab(spreadsheetId: string, title: string): Promise<string> {
  const meta = await sheetsFetch<{ sheets?: Array<{ properties?: { title?: string } }> }>(`/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`);
  const titles = (meta?.sheets ?? []).map((s) => s.properties?.title ?? "");
  const hit = titles.find((t) => domainOf(t) === title);
  if (hit) return hit;
  await sheetsFetch(`/spreadsheets/${spreadsheetId}:batchUpdate`, { method: "POST", body: { requests: [{ addSheet: { properties: { title } } }] } });
  await sheetsFetch(`${rangePath(spreadsheetId, `${quoteTab(title)}!A1`)}?valueInputOption=USER_ENTERED`, { method: "PUT", body: { values: [HEADER] } });
  return title;
}

/** Дописать опубликованные, ещё не выгруженные статьи. */
export async function copySheetTick(limit = 100): Promise<{ written: number; error?: string }> {
  if (running) return { written: 0 };
  const st = await copySettings();
  const spreadsheetId = st.sheetUrl ? spreadsheetIdOf(st.sheetUrl) : null;
  if (!spreadsheetId) return { written: 0 };
  running = true;
  try {
    const rows = await prisma.copyArticle.findMany({ where: { sheetAt: null }, orderBy: { createdAt: "asc" }, take: limit * 2 });
    if (!rows.length) return { written: 0 };
    const arts = await prisma.article.findMany({ where: { id: { in: rows.map((r) => r.articleId) }, status: "COMPLETED", wpUrl: { not: null } }, select: { id: true, wpUrl: true, publishedAt: true } });
    const art = new Map(arts.map((a) => [a.id, a]));
    const ready = rows.filter((r) => art.has(r.articleId)).slice(0, limit);
    if (!ready.length) return { written: 0 };
    const [sites, cores, batches] = await Promise.all([
      prisma.artSite.findMany({ where: { id: { in: [...new Set(ready.map((r) => r.siteId))] } }, select: { id: true, name: true } }),
      prisma.copyCore.findMany({ where: { OR: ready.map((r) => ({ niche: r.niche, core: r.core })) }, select: { niche: true, core: true, volume: true, volClass: true } }),
      prisma.copyBatch.findMany({ where: { id: { in: ready.map((r) => r.batchId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    const siteName = new Map(sites.map((s) => [s.id, s.name]));
    const vol = new Map(cores.map((c) => [`${c.niche}|${c.core}`, c]));
    const batchName = new Map(batches.map((b) => [b.id, b.name]));
    let written = 0;
    const bySite = new Map<string, typeof ready>();
    for (const r of ready) { const k = r.siteId; (bySite.get(k) ?? bySite.set(k, []).get(k)!).push(r); }
    for (const [siteId, list] of bySite) {
      const title = domainOf(siteName.get(siteId) ?? siteId);
      const tab = await ensureTab(spreadsheetId, title);
      const values = list.map((r) => {
        const a = art.get(r.articleId)!;
        const c = vol.get(`${r.niche}|${r.core}`);
        return [r.keyword, nicheLabel(r.niche), c?.volClass ? VOL_LABEL[c.volClass] : "", c?.volume != null ? String(c.volume) : "", a.wpUrl ?? "", stamp(a.publishedAt ?? new Date()), String(r.photos), r.batchId ? batchName.get(r.batchId) ?? "" : "автосборка", title];
      });
      await sheetsFetch(`${rangePath(spreadsheetId, `${quoteTab(tab)}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: "POST", body: { values } });
      await prisma.copyArticle.updateMany({ where: { id: { in: list.map((r) => r.id) } }, data: { sheetAt: new Date() } });
      written += list.length;
    }
    return { written };
  } catch (e) {
    return { written: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    running = false;
  }
}
