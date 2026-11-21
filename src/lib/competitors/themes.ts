/**
 * Темы: кластеры разных площадок называются по-разному («Поздравления с юбилеем 20 лет», «Привітання доньці»),
 * поэтому модель относит каждый кластер к общей теме (тип контента, 2–4 слова) — так видно, что повторяется
 * у многих новых площадок. Список тем копится: модели каждый раз дают уже существующие темы, чтобы не плодить синонимы.
 * Размечаются только кластеры с пустой темой; после повторного разбора площадки её кластеры размечаются заново.
 */
import { prisma } from "@/lib/db";
import { runSlot } from "@/lib/run";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { resolveCompSlot } from "./analyze";
import { filterWhere, type ListFilter } from "./sites";
import { CLUSTER_MODEL, PROJECT_SLUG, SLOT_TEXT, type ClusterTop } from "./types";

export const OTHER_THEME = "Прочее";
const BATCH = 100;
const JUNK = new Set(["прочее", "не распределено", "без названия", "другое", "разное"]);

const SYSTEM = `Ты SEO-аналитик. Тебе дают кластеры запросов с разных сайтов (номер, название, тип, примеры запросов) и список уже существующих тем.
Отнеси каждый кластер к теме. Тема — это тип контента, который можно повторить на другом сайте: 2–4 слова по-русски, с заглавной буквы, без названий городов, имён, возрастов, дат и брендов.
Примеры тем: «Поздравления и пожелания», «Расписание транспорта», «Рецепты», «Погода», «Праздники и календарь», «Сказки и стихи для детей», «Значение имён», «Адреса и режим работы», «Чем отличается X от Y».
Правила: если подходит существующая тема — используй её дословно; новую тему создавай, только когда ни одна не подходит; не дроби («Поздравления с днём рождения» и «Поздравления с юбилеем» — одна тема «Поздравления и пожелания»), но и не сливай разное по смыслу; брендовые, навигационные и мусорные кластеры — тема «${OTHER_THEME}».
Ответ — только JSON: {"themes": {"<номер>": "<тема>", …}} — по одной записи на каждый номер.`;

const clean = (s: unknown) => String(s ?? "").replace(/[«»"]/g, "").replace(/\s+/g, " ").trim().slice(0, 100);

/** Размечает до maxBatches пачек кластеров без темы. Возвращает число размеченных и расход. */
export async function assignThemes(maxBatches = 10): Promise<{ assigned: number; costUsd: number; error?: string }> {
  // Служебные кластеры — без модели.
  const junk = await prisma.compCluster.findMany({ where: { theme: "" }, select: { id: true, name: true } });
  const junkIds = junk.filter((c) => JUNK.has(c.name.trim().toLowerCase())).map((c) => c.id);
  if (junkIds.length) await prisma.compCluster.updateMany({ where: { id: { in: junkIds } }, data: { theme: OTHER_THEME } });
  let assigned = junkIds.length;
  let costUsd = 0;
  for (let b = 0; b < maxBatches; b++) {
    const batch = await prisma.compCluster.findMany({ where: { theme: "" }, orderBy: { etv: "desc" }, take: BATCH, select: { id: true, name: true, type: true, top: true } });
    if (!batch.length) break;
    const known = (await prisma.compCluster.groupBy({ by: ["theme"], where: { theme: { not: "" } }, _count: true })).sort((x, y) => y._count - x._count).map((t) => t.theme).filter((t) => t !== OTHER_THEME).slice(0, 150);
    const lines = batch.map((c, i) => `${i}\t${c.name}\t${c.type}\t${((c.top as ClusterTop[] | null) ?? []).slice(0, 4).map((t) => t.kw).join("; ")}`).join("\n");
    const { userId, teamId, pre } = await resolveCompSlot(SLOT_TEXT);
    const res = await runSlot({
      userId, projectSlug: PROJECT_SLUG, slotKey: SLOT_TEXT, model: CLUSTER_MODEL, pre, timeoutMs: 180_000, meta: { teamId, refId: "themes" },
      payload: { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Существующие темы: ${known.length ? known.join("; ") : "пока нет"}\n\n№\tкластер\tтип\tпримеры запросов\n${lines}` }], temperature: 0, max_tokens: 8000, response_format: { type: "json_object" } },
    });
    costUsd += res.meta?.costUsd ?? 0;
    if (!res.ok) return { assigned, costUsd, error: `ИИ: ${res.error ?? `HTTP ${res.status}`}` };
    const text = String((res.data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "");
    const map = parseJsonLenient<{ themes?: Record<string, unknown> }>(text)?.themes ?? {};
    // Регистр и «ё» не должны плодить двойники существующих тем.
    const canon = new Map(known.map((t) => [t.toLowerCase().replace(/ё/g, "е"), t]));
    const byTheme = new Map<string, string[]>();
    batch.forEach((c, i) => {
      const raw = clean(map[String(i)]);
      // Модель пропустила номер — «Прочее», иначе кластер будет возвращаться в каждую пачку.
      const theme = raw ? (canon.get(raw.toLowerCase().replace(/ё/g, "е")) ?? raw) : OTHER_THEME;
      if (raw && !canon.has(raw.toLowerCase().replace(/ё/g, "е"))) canon.set(raw.toLowerCase().replace(/ё/g, "е"), raw);
      byTheme.set(theme, [...(byTheme.get(theme) ?? []), c.id]);
    });
    for (const [theme, ids] of byTheme) await prisma.compCluster.updateMany({ where: { id: { in: ids } }, data: { theme } });
    assigned += batch.length;
  }
  return { assigned, costUsd };
}

export type ThemeRow = {
  theme: string;
  sites: number;
  etv: number;
  /** Трафик типичной площадки в теме — медиана, чтобы один гигант не искажал картину */
  medianEtv: number;
  keywords: number;
  topSites: Array<{ id: string; domain: string; etv: number }>;
  examples: string[];
};

/** Сводка тем по площадкам текущего фильтра: сколько площадок получают трафик на теме и сколько. */
export async function themeRows(f: ListFilter): Promise<{ rows: ThemeRow[]; sites: number; pending: number }> {
  const where = { site: { AND: [filterWhere({ ...f, status: "all" }), { status: "done" }] } };
  const clusters = await prisma.compCluster.findMany({ where, select: { theme: true, etv: true, count: true, top: true, site: { select: { id: true, domain: true } } } });
  const siteIds = new Set(clusters.map((c) => c.site.id));
  type Acc = { etv: number; keywords: number; bySite: Map<string, { domain: string; etv: number }>; kws: Array<{ kw: string; vol: number }> };
  const acc = new Map<string, Acc>();
  let pending = 0;
  for (const c of clusters) {
    if (!c.theme) { pending++; continue; }
    if (c.theme === OTHER_THEME) continue;
    const a: Acc = acc.get(c.theme) ?? { etv: 0, keywords: 0, bySite: new Map(), kws: [] };
    a.etv += c.etv;
    a.keywords += c.count;
    const s = a.bySite.get(c.site.id) ?? { domain: c.site.domain, etv: 0 };
    s.etv += c.etv;
    a.bySite.set(c.site.id, s);
    for (const t of ((c.top as ClusterTop[] | null) ?? []).slice(0, 3)) a.kws.push({ kw: t.kw, vol: t.vol ?? 0 });
    acc.set(c.theme, a);
  }
  const rows: ThemeRow[] = [...acc.entries()].map(([theme, a]) => {
    const sites = [...a.bySite.entries()].map(([id, s]) => ({ id, ...s })).sort((x, y) => y.etv - x.etv);
    const sorted = sites.map((s) => s.etv).sort((x, y) => x - y);
    const seen = new Set<string>();
    const examples = a.kws.sort((x, y) => y.vol - x.vol).filter((k) => !seen.has(k.kw) && (seen.add(k.kw), true)).slice(0, 6).map((k) => k.kw);
    return { theme, sites: sites.length, etv: a.etv, medianEtv: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0, keywords: a.keywords, topSites: sites.slice(0, 5), examples };
  });
  rows.sort((x, y) => y.sites - x.sites || y.etv - x.etv);
  return { rows, sites: siteIds.size, pending };
}
