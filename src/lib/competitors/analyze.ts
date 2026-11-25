/**
 * Разбор площадки: запросы в топ-30 Google по базе её страны (DataForSEO Labs ranked_keywords, слот seo_dfs),
 * затем модель (слот text_main) группирует их в тематические кластеры и пишет вывод.
 * Суммы по кластерам (число запросов, трафик, доля, страницы) считает код, а не модель.
 * Ключи — только команды WexOra: расход пишется на неё, refId записи расхода = id площадки.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveSlot, runSlot, type ResolvedSlot } from "@/lib/run";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { CLUSTER_MODEL, DFS_LOCATIONS, MAX_ATTEMPTS, PROJECT_SLUG, SLOT_DFS, SLOT_TEXT, kwCountryOf, splitList, type ClusterTop, type CompSettings } from "./types";

export const KEY_TEAM_SLUG = "wexora";
export const KEY_TEAM_NAME = "WexOra";

let teamCache: string | null = null;
export async function compKeyTeamId(): Promise<string> {
  if (teamCache) return teamCache;
  const team = await prisma.team.findUnique({ where: { slug: KEY_TEAM_SLUG }, select: { id: true } });
  if (!team) throw new Error(`Команда ${KEY_TEAM_NAME} не найдена — «Анализ конкурентов» работает только на её ключах`);
  teamCache = team.id;
  return team.id;
}

let userCache: string | null = null;
/** От чьего имени идут фоновые вызовы: первый администратор. */
export async function systemUserId(): Promise<string> {
  if (userCache) return userCache;
  const user = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!user) throw new Error("Нет администратора");
  userCache = user.id;
  return user.id;
}

/** Правило слота строго с ключом WexOra: чужой или общий ключ не берётся. */
export async function resolveCompSlot(slotKey: string): Promise<{ userId: string; teamId: string; pre: ResolvedSlot }> {
  const [userId, teamId] = [await systemUserId(), await compKeyTeamId()];
  const r = await resolveSlot(userId, PROJECT_SLUG, slotKey, teamId);
  if (!r.ok) throw new Error(`${r.error} «Анализ конкурентов» работает только на ключах команды ${KEY_TEAM_NAME}.`);
  const key = await prisma.apiKey.findUnique({ where: { id: r.value.binding.apiKey.id }, select: { teamId: true } });
  if (key?.teamId !== teamId) throw new Error(`Для «${r.value.slot.name}» нет ключа команды ${KEY_TEAM_NAME}: подключите её ключ к инструменту на странице ключа.`);
  return { userId, teamId, pre: r.value };
}

export type KwRow = { kw: string; vol: number; pos: number | null; etv: number; url: string | null };
export type RankedResult = { total: number; top10: number; etv: number; rows: KwRow[]; costUsd: number };

type DfsItem = {
  keyword_data?: { keyword?: string; keyword_info?: { search_volume?: number | null } };
  ranked_serp_element?: { serp_item?: { rank_group?: number; etv?: number; relative_url?: string; url?: string } };
};
type DfsTask = { status_code?: number; status_message?: string; result?: Array<{ total_count?: number; metrics?: { organic?: Record<string, number | null> }; items?: DfsItem[] | null }> };

/** Самые трафиковые запросы домена в топ-30 по базе страны. */
export async function rankedKeywords(siteId: string, domain: string, country: string, limit: number): Promise<RankedResult> {
  const location = DFS_LOCATIONS[country];
  if (!location) throw new Error(`Страну «${country}» DataForSEO не поддерживает`);
  const { userId, teamId, pre } = await resolveCompSlot(SLOT_DFS);
  const res = await runSlot({
    userId, projectSlug: PROJECT_SLUG, slotKey: SLOT_DFS, pre, timeoutMs: 150_000, meta: { teamId, refId: siteId },
    payload: { endpoint: "dataforseo_labs/google/ranked_keywords/live", body: [{ target: domain, location_code: location, limit, order_by: ["ranked_serp_element.serp_item.etv,desc"], filters: ["ranked_serp_element.serp_item.rank_group", "<=", 30] }] },
  });
  const costUsd = res.meta?.costUsd ?? 0;
  const task = (res.data as { tasks?: DfsTask[] } | undefined)?.tasks?.[0];
  if (!res.ok || !task || task.status_code !== 20000) throw Object.assign(new Error(`DataForSEO: ${res.error ?? task?.status_message ?? `HTTP ${res.status}`}`), { costUsd });
  const r = task.result?.[0];
  const org = r?.metrics?.organic ?? {};
  const rows: KwRow[] = [];
  for (const i of r?.items ?? []) {
    const kw = String(i.keyword_data?.keyword ?? "").trim();
    if (!kw) continue;
    const item = i.ranked_serp_element?.serp_item;
    rows.push({ kw: kw.slice(0, 300), vol: Number(i.keyword_data?.keyword_info?.search_volume) || 0, pos: item?.rank_group ?? null, etv: Number(item?.etv) || 0, url: item?.relative_url ?? item?.url ?? null });
  }
  return { total: r?.total_count ?? 0, top10: (org.pos_1 ?? 0) + (org.pos_2_3 ?? 0) + (org.pos_4_10 ?? 0), etv: Math.round(org.etv ?? 0), rows, costUsd };
}

const SYSTEM = `Ты SEO-аналитик. Тебе дают ключевые слова, по которым сайт стоит в топ-30 Google: номер, запрос, частота в месяц, позиция, оценка трафика в месяц, страница.
Сгруппируй запросы в тематические кластеры (от 3 до 12): кластер — одна тема контента, а не одно слово. Каждый номер запроса — ровно в один кластер; мусор и брендовые запросы чужих сайтов — в кластер «Прочее».
Ответ — только JSON:
{"site": "одним предложением, что это за сайт и на чём он получает трафик",
 "clusters": [{"name": "название кластера по-русски, 2–5 слов", "type": "информационный | коммерческий | новостной | справочный | навигационный", "idx": [номера запросов], "what": "какой контент собирает этот трафик, одним предложением, с примером формата статьи"}],
 "takeaway": "2–3 предложения: что у сайта реально работает и что из этого стоит повторить на своём сайте"}
Пиши по-русски, без воды и общих слов. Названия кластеров конкретные («Рецепты заготовок на зиму», а не «Кулинария»).`;

export type ClusterOut = { name: string; type: string; what: string; count: number; etv: number; volume: number; share: number; top: ClusterTop[]; pages: string[]; idx: number[] };
export type ClusterResult = { site: string; takeaway: string; clusters: ClusterOut[]; costUsd: number };

/** Сборка кластеров из ответа модели: номера → строки, суммы и доли. Чистая функция. */
export function buildClusters(rows: KwRow[], raw: Array<{ name?: string; type?: string; idx?: unknown; what?: string }>, domain: string): ClusterOut[] {
  const seen = new Set<number>();
  const abs = (u: string) => (u.startsWith("/") ? `https://${domain}${u}` : u);
  const list = raw.map((c) => {
    const idx = (Array.isArray(c.idx) ? c.idx : []).map((i) => Number(i)).filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length && !seen.has(i) && (seen.add(i), true));
    const own = idx.map((i) => rows[i]);
    const pages = new Map<string, number>();
    for (const r of own) if (r.url) pages.set(r.url, (pages.get(r.url) ?? 0) + r.etv);
    return {
      name: String(c.name ?? "").trim().slice(0, 190) || "Без названия", type: String(c.type ?? "").trim().slice(0, 32), what: String(c.what ?? "").trim(),
      count: own.length, etv: Math.round(own.reduce((s, r) => s + r.etv, 0)), volume: own.reduce((s, r) => s + r.vol, 0), share: 0,
      top: [...own].sort((a, b) => b.etv - a.etv).slice(0, 8).map((r) => ({ kw: r.kw, vol: r.vol, pos: r.pos })),
      pages: [...pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([u]) => abs(u)),
      idx,
    };
  }).filter((c) => c.count > 0);
  // Запросы, которые модель никуда не отнесла, не теряем.
  const rest = rows.map((_, i) => i).filter((i) => !seen.has(i));
  if (rest.length) {
    const own = rest.map((i) => rows[i]);
    list.push({ name: "Не распределено", type: "", what: "", count: own.length, etv: Math.round(own.reduce((s, r) => s + r.etv, 0)), volume: own.reduce((s, r) => s + r.vol, 0), share: 0, top: own.slice(0, 8).map((r) => ({ kw: r.kw, vol: r.vol, pos: r.pos })), pages: [], idx: rest });
  }
  const total = list.reduce((s, c) => s + c.etv, 0) || 1;
  for (const c of list) c.share = Math.round((c.etv / total) * 100);
  return list.sort((a, b) => b.etv - a.etv);
}

export const mainClustersLine = (clusters: ClusterOut[]) => clusters.filter((c) => c.name !== "Не распределено" && c.name !== "Прочее").slice(0, 4).map((c) => `${c.name} — ${c.share}%`).join("; ");

export async function clusterKeywords(siteId: string, domain: string, total: number, rows: KwRow[]): Promise<ClusterResult> {
  const { userId, teamId, pre } = await resolveCompSlot(SLOT_TEXT);
  const lines = rows.map((r, i) => `${i}\t${r.kw}\t${r.vol}\t${r.pos ?? ""}\t${Math.round(r.etv)}\t${(r.url ?? "").slice(0, 90)}`).join("\n");
  let costUsd = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runSlot({
      userId, projectSlug: PROJECT_SLUG, slotKey: SLOT_TEXT, model: CLUSTER_MODEL, pre, timeoutMs: 180_000, meta: { teamId, refId: siteId },
      payload: { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `Сайт: ${domain}. Всего запросов в топ-30: ${total}, ниже ${rows.length} самых трафиковых.\n№\tзапрос\tчастота\tпозиция\tтрафик\tстраница\n${lines}` }], temperature: 0.2, max_tokens: 12000, response_format: { type: "json_object" } },
    });
    costUsd += res.meta?.costUsd ?? 0;
    if (!res.ok) {
      lastError = `ИИ: ${res.error ?? `HTTP ${res.status}`}`;
      continue;
    }
    const text = String((res.data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? "");
    const parsed = parseJsonLenient<{ site?: string; takeaway?: string; clusters?: Array<{ name?: string; type?: string; idx?: unknown; what?: string }> }>(text);
    if (!parsed?.clusters?.length) {
      lastError = "ИИ вернул ответ без кластеров";
      continue;
    }
    return { site: String(parsed.site ?? "").trim(), takeaway: String(parsed.takeaway ?? "").trim(), clusters: buildClusters(rows, parsed.clusters, domain), costUsd };
  }
  throw Object.assign(new Error(lastError), { costUsd });
}

/** Запись результата разбора: старые запросы и кластеры площадки заменяются. */
export async function saveAnalysis(siteId: string, domain: string, kwCountry: string, ranked: Omit<RankedResult, "costUsd">, cl: Omit<ClusterResult, "costUsd">, costUsd: number): Promise<void> {
  const clusterOf = new Map<number, string>();
  for (const c of cl.clusters) for (const i of c.idx) clusterOf.set(i, c.name);
  const abs = (u: string | null) => (u && u.startsWith("/") ? `https://${domain}${u}` : u);
  await prisma.$transaction([
    prisma.compKeyword.deleteMany({ where: { siteId } }),
    prisma.compCluster.deleteMany({ where: { siteId } }),
    prisma.compKeyword.createMany({ data: ranked.rows.map((r, i) => ({ siteId, kw: r.kw, volume: r.vol, pos: r.pos, etv: Math.round(r.etv * 10) / 10, url: abs(r.url), cluster: clusterOf.get(i) ?? "" })) }),
    prisma.compCluster.createMany({ data: cl.clusters.map((c, i) => ({ siteId, position: i, name: c.name, type: c.type, what: c.what, count: c.count, etv: c.etv, volume: c.volume, share: c.share, top: c.top as unknown as Prisma.InputJsonValue, pages: c.pages as unknown as Prisma.InputJsonValue })) }),
    prisma.compSite.update({
      where: { id: siteId },
      data: { status: "done", kwTotal: ranked.total, kwTop10: ranked.top10, etv: ranked.etv, kwCountry, summary: cl.site, takeaway: cl.takeaway, mainClusters: mainClustersLine(cl.clusters), costUsd: { increment: costUsd }, error: null, analyzedAt: new Date(), workerId: null, leaseUntil: null },
    }),
  ]);
}

/** Полный разбор одной площадки. Меньше 20 запросов в базе — «мало данных», модель не вызывается. */
export async function analyzeSite(siteId: string, settings: CompSettings): Promise<void> {
  const site = await prisma.compSite.findUnique({ where: { id: siteId }, select: { id: true, domain: true, countries: true } });
  if (!site) return;
  let spent = 0;
  try {
    const country = kwCountryOf(splitList(site.countries), settings.countries);
    if (!country) throw new Error(`Страны площадки (${splitList(site.countries).join(", ") || "не указаны"}) нет в базах DataForSEO`);
    const ranked = await rankedKeywords(site.id, site.domain, country, settings.kwLimit);
    spent += ranked.costUsd;
    if (ranked.rows.length < 20) {
      await prisma.compSite.update({ where: { id: site.id }, data: { status: "empty", kwTotal: ranked.total, kwTop10: ranked.top10, etv: ranked.etv, kwCountry: country, costUsd: { increment: spent }, error: null, analyzedAt: new Date(), workerId: null, leaseUntil: null } });
      return;
    }
    const cl = await clusterKeywords(site.id, site.domain, ranked.total, ranked.rows);
    spent += cl.costUsd;
    await saveAnalysis(site.id, site.domain, country, ranked, cl, spent);
  } catch (e) {
    spent += Number((e as { costUsd?: number }).costUsd) || 0;
    const message = e instanceof Error ? e.message : String(e);
    const cur = await prisma.compSite.findUnique({ where: { id: site.id }, select: { attempts: true } });
    // Нет ключа или страна не поддерживается — повтор не поможет.
    const final = /ключ|правил|не поддерживает|нет в базах/i.test(message) || (cur?.attempts ?? 0) >= MAX_ATTEMPTS;
    await prisma.compSite.update({ where: { id: site.id }, data: { status: final ? "error" : "queued", error: message.slice(0, 1000), costUsd: { increment: spent }, workerId: null, leaseUntil: final ? null : new Date(Date.now() + 5 * 60_000) } });
  }
}
