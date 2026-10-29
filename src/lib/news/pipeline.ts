import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { activeProxies, fetchSource, type SourceLike } from "./sources";
import { canonicalUrl, filterText, hostOf, jaccard, keyTokens, makeEntityMatcher, makeMatcher, normText, normTitle, rubricTokens, sha1, tokens, type EntityHit, type EntityRow } from "./text";
import { classifyBatch, embedTexts, NewsAiError, type AiCtx } from "./llm";
import { addToCentroid, centroid, cos, pack, unpack } from "./vec";
import { priorityOf, scoreCluster } from "./score";
import { summaryStep } from "./work";
import { onSiteStep } from "./onsite";
import { heroSkeleton, mergeStep } from "./merge";
import { projectSpend } from "./runs";
import { alertText, sendTelegram } from "./telegram";
import { BASE_PATH, emptyStats, parseSettings, parseState, type NewsSettings, type ProjectState, type RunStats, type ScorePart } from "./types";
import { wellFormed, type FeedItem } from "./parse";

/**
 * Конвейер прогона (ТЗ, раздел 3): сбор → дедупликация → фильтр слов и рубрик → эмбеддинг и фильтр по нему →
 * классификация пачками → кластеры → балл → алерты. До LLM доходит только то, что прошло бесплатные фильтры.
 */

type Src = SourceLike & { name: string; tier: string; lang: string; weight: number; profile: boolean; includeCats: string[]; excludeCats: string[]; includeUrls: string[]; virtual?: boolean };
type Candidate = {
  src: Src;
  url: string;
  urlHash: string;
  domain: string;
  title: string;
  normTitle: string;
  keyToks: string[];
  lead: string;
  imageUrl: string | null;
  categories: string[];
  publishedAt: Date | null;
  /** Повторы этого же материала с других сайтов в том же прогоне. */
  extra?: unknown[];
};
type ProjectRow = Prisma.NewsProjectGetPayload<object>;

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GOOGLE = new Set(["gnews_query", "gnews_topic", "trends"]);
const HOUR = 3600_000;

function dayStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function mapLimit<T>(list: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  }));
}

/** Запросы Google News по сущностям: первый ряд — каждый прогон, остальные — ротацией по курсору. */
function entityQueries(entities: EntityRow[], s: NewsSettings, state: ProjectState): { queries: string[]; cursor: number } {
  const per = s.gnewsEntitiesPerQuery;
  const q = (names: string[]) => names.map((n) => `"${n}"`).join(" OR ");
  const top = entities.filter((e) => e.weight >= s.topEntityWeight);
  const rest = entities.filter((e) => e.weight < s.topEntityWeight);
  const groups = (list: EntityRow[]) => {
    const out: string[] = [];
    for (let i = 0; i < list.length; i += per) out.push(q(list.slice(i, i + per).map((e) => e.name)));
    return out;
  };
  const restGroups = groups(rest);
  let cursor = state.gnewsCursor ?? 0;
  const take: string[] = [];
  for (let i = 0; i < Math.min(s.gnewsGroupsPerRun, restGroups.length); i++) {
    take.push(restGroups[cursor % restGroups.length]);
    cursor++;
  }
  return { queries: [...groups(top), ...take], cursor: restGroups.length ? cursor % restGroups.length : 0 };
}

export async function runPipeline(runId: string, shouldStop: () => boolean = () => false): Promise<void> {
  const run = await prisma.newsRun.findUniqueOrThrow({ where: { id: runId } });
  const project = await prisma.newsProject.findUniqueOrThrow({ where: { id: run.projectId } });
  const s = parseSettings(project.settings);
  const state = parseState(project.state);
  const stats: RunStats = emptyStats();
  let cost = 0;
  const log = (m: string) => {
    stats.log = [...(stats.log ?? []), m].slice(-60);
  };
  const step = async (name: string) => {
    await prisma.newsRun.update({ where: { id: runId }, data: { step: name, stats: stats as unknown as Prisma.InputJsonValue, costUsd: cost } });
  };
  const userId = run.userId ?? project.createdById;
  try {
    if (!userId) throw new Error("У проекта нет автора — некому списывать расход. Откройте настройки проекта и сохраните их.");
    const ctx: AiCtx = { userId, teamId: project.teamId, runId, classifyModel: s.classifyModel, embedModel: s.embedModel, onCost: (u) => (cost += u) };

    // Бюджет: при 100% платные шаги не идут, материалы ждут в очереди; при 80% — алерт раз в сутки.
    const spend = await projectSpend(project.id);
    const dayLimit = (s.monthlyBudgetUsd / 30) * 1.5;
    let paid = true;
    if (s.monthlyBudgetUsd > 0 && spend.month >= s.monthlyBudgetUsd) {
      paid = false;
      stats.budgetStop = `месячный лимит $${s.monthlyBudgetUsd} исчерпан ($${spend.month.toFixed(2)})`;
    } else if (s.monthlyBudgetUsd > 0 && spend.day >= dayLimit) {
      paid = false;
      stats.budgetStop = `дневной лимит $${dayLimit.toFixed(2)} исчерпан ($${spend.day.toFixed(2)})`;
    }
    const today = new Date().toISOString().slice(0, 10);
    if (s.monthlyBudgetUsd > 0 && spend.month >= s.monthlyBudgetUsd * 0.8 && state.budgetAlertDay !== today) {
      await alertProject(project, `⚠️ Модуль «Новости», ${project.name}: потрачено $${spend.month.toFixed(2)} из $${s.monthlyBudgetUsd} за месяц.`);
      state.budgetAlertDay = today;
    }

    const [sourceRows, entityRows, proxies] = await Promise.all([
      prisma.newsSource.findMany({ where: { projectId: project.id, isActive: true } }),
      prisma.newsEntity.findMany({ where: { projectId: project.id, isActive: true } }),
      activeProxies(),
    ]);
    const entities: EntityRow[] = entityRows.map((e) => ({ id: e.id, name: e.name, weight: e.weight, type: e.type, aliases: asList(e.aliases) }));
    const matchEntities = makeEntityMatcher(entities);

    // ── 1. Сбор ──
    await step("Сбор");
    const sources = pickSources(sourceRows, run.scope, run.kind, s);
    if (run.scope.startsWith("query:")) {
      // Прогон по тренду или запросу редактора: один запрос Google News за 2 дня, остальные источники не трогаем.
      const q = run.scope.slice(6);
      sources.push({ id: `q:${sha1(q).slice(0, 12)}`, kind: "gnews_query", url: `${q} when:2d`, viaProxy: false, name: `Google News: ${q.slice(0, 80)}`, tier: "competitor", lang: s.hl, weight: 1, profile: true, includeCats: [], excludeCats: [], includeUrls: [], virtual: true });
    }
    if (run.scope === "all" || run.scope === "gnews") {
      const eq = entityQueries(entities, s, state);
      state.gnewsCursor = eq.cursor;
      for (const q of [...s.gnewsQueries, ...eq.queries]) {
        sources.push({ id: `q:${sha1(q).slice(0, 12)}`, kind: "gnews_query", url: q, viaProxy: false, name: `Google News: ${q.slice(0, 80)}`, tier: "competitor", lang: s.hl, weight: 1, profile: false, includeCats: [], excludeCats: [], includeUrls: [], virtual: true });
      }
    }
    stats.sources = sources.length;
    const candidates: Candidate[] = [];
    const trendRows: { title: string; traffic: string; news: { title: string; url: string; source: string }[] }[] = [];
    const perSource = new Map<string, { items: number; fresh: number; passed: number; proxy: boolean }>();
    const handle = async (src: Src) => {
      if (shouldStop()) return;
      const r = await fetchSource(src, s, proxies);
      if (r.viaProxy) stats.proxied++;
      if (r.error) {
        stats.sourceErrors++;
        log(`${src.name}: ${r.error}`);
      }
      perSource.set(src.id, { items: r.items.length + r.trends.length, fresh: 0, passed: 0, proxy: r.viaProxy });
      if (!src.virtual) {
        await prisma.newsSource.update({
          where: { id: src.id },
          data: r.error
            ? { lastFetchAt: new Date(), lastError: r.error.slice(0, 1000), errorStreak: { increment: 1 } }
            : { lastFetchAt: new Date(), lastOkAt: new Date(), lastError: null, errorStreak: 0 },
        }).catch(() => {});
      }
      for (const t of r.trends) {
        trendRows.push(t);
        for (const n of t.news) if (/^https?:/.test(n.url)) candidates.push(toCandidate({ url: n.url, title: n.title, lead: "", imageUrl: null, categories: [], publishedAt: t.publishedAt, sourceName: n.source }, src));
      }
      for (const it of r.items) {
        const c = toCandidate(it, src);
        if (c) candidates.push(c);
      }
    };
    const google = sources.filter((x) => GOOGLE.has(x.kind));
    const sites = sources.filter((x) => !GOOGLE.has(x.kind));
    // Сайты параллельно; Google — по одному с паузой 3–5 с, чтобы не получить 429 на IP сервера.
    await Promise.all([
      mapLimit(sites, 6, handle),
      (async () => {
        for (const g of google) {
          if (shouldStop()) break;
          await handle(g);
          await sleep(3000 + Math.random() * 2000);
        }
      })(),
    ]);
    stats.fetched = candidates.length;

    // Тренды: стоп-фильтр до LLM; войну и политику не храним как релевантные.
    const stop = makeMatcher(s.stopWords, s.stopExceptions);
    const niche = makeMatcher(s.nicheWords);
    for (const t of trendRows) {
      const toks = tokens([t.title, ...t.news.map((n) => n.title)].join(" "));
      const relevant = !stop.match(toks) && (!!niche.match(toks) || matchEntities(toks).length > 0);
      const nt = normText(t.title).slice(0, 300);
      if (!nt) continue;
      await prisma.newsTrend.upsert({
        where: { projectId_normTitle: { projectId: project.id, normTitle: nt } },
        update: { lastSeenAt: new Date(), traffic: t.traffic, news: t.news.slice(0, 5) as unknown as Prisma.InputJsonValue, relevant },
        create: { projectId: project.id, title: t.title.slice(0, 190), normTitle: nt, traffic: t.traffic, news: t.news.slice(0, 5) as unknown as Prisma.InputJsonValue, relevant },
      });
      stats.trends++;
    }

    // ── 2. Дедупликация ──
    await step("Дедупликация");
    const fresh = await dedup(project.id, runId, candidates, s, stats, perSource);

    // ── 3. Фильтр слов и рубрик ──
    await step("Фильтр слов и рубрик");
    const rubricStop = makeMatcher(s.stopRubrics, s.stopExceptions);
    for (const c of fresh) {
      const hits: EntityHit[] = matchEntities(tokens(`${c.title} ${c.lead.slice(0, 300)}`));
      // Звезда первого ряда в заголовке: стоп-слова ищем только в заголовке (лид о ней часто упоминает спорт или войну мимоходом).
      const topInTitle = matchEntities(tokens(c.title)).some((h) => h.weight >= s.topEntityWeight);
      const toks = filterText(c.title, c.lead, c.src.profile || topInTitle, s.stopExceptions);
      let cutStep: string | null = null;
      let cutReason: string | null = null;
      const stopHit = stop.match(toks);
      const catText = c.categories.join(" | ");
      const srcCatOk = c.src.includeCats.length > 0 && c.src.includeCats.some((x) => catText.toLowerCase().includes(x));
      if (c.src.includeUrls.length && !c.src.includeUrls.some((x) => c.url.toLowerCase().includes(x))) {
        cutStep = "rubric";
        cutReason = "раздел сайта не из списка источника";
      } else if (c.src.includeCats.length && !srcCatOk) {
        cutStep = "rubric";
        cutReason = `рубрика «${catText || "нет"}» не из списка источника`;
      } else if (c.src.excludeCats.some((x) => catText.toLowerCase().includes(x))) {
        cutStep = "rubric";
        cutReason = `рубрика «${catText}» исключена у источника`;
      } else if (stopHit) {
        cutStep = "words";
        cutReason = `стоп-слово «${stopHit}»`;
      } else if (!srcCatOk && !c.src.profile && c.categories.length && rubricStop.match(rubricTokens(c.categories))) {
        cutStep = "rubric";
        cutReason = `стоп-рубрика «${rubricStop.match(rubricTokens(c.categories))}» в «${catText}»`;
      } else if (!hits.length && !c.src.profile && c.src.tier !== "primary" && !niche.match(tokens(`${c.title} ${c.lead.slice(0, 300)}`))) {
        cutStep = "whitelist";
        cutReason = "нет сущности из списка и нишевых слов";
      }
      if (cutStep === "words") stats.cutWords++;
      else if (cutStep === "rubric") stats.cutRubric++;
      else if (cutStep === "whitelist") stats.cutWhitelist++;
      else {
        const ps = perSource.get(c.src.id);
        if (ps) ps.passed++;
      }
      await prisma.newsItem.create({
        data: {
          projectId: project.id, sourceId: c.src.virtual ? null : c.src.id, urlHash: c.urlHash, url: c.url.slice(0, 1990), domain: c.domain, title: wellFormed(c.title.slice(0, 2000)), normTitle: wellFormed(c.normTitle.slice(0, 480)),
          lead: c.lead || null, imageUrl: c.imageUrl?.slice(0, 1990) ?? null, categories: c.categories as unknown as Prisma.InputJsonValue, tier: c.src.tier, lang: c.src.lang,
          publishedAt: c.publishedAt, status: cutStep ? "cut" : "queued", cutStep, cutReason, matched: hits.length ? (hits as unknown as Prisma.InputJsonValue) : Prisma.DbNull, runId,
          extraSources: c.extra?.length ? (c.extra as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      }).catch((e) => {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      });
    }
    for (const [id, ps] of perSource) {
      if (id.startsWith("q:")) continue;
      await prisma.newsSource.update({ where: { id }, data: { lastStats: ps as unknown as Prisma.InputJsonValue, ...(ps.fresh ? { lastNewAt: new Date() } : {}) } }).catch(() => {});
    }

    // ── 4. Эмбеддинги и фильтр по ним ──
    if (paid && !shouldStop()) {
      await step("Эмбеддинги");
      await embedStep(project.id, ctx, s, stats, log);
    }

    // ── 5. Классификация ──
    if (paid && !shouldStop()) {
      await step("Классификация");
      await classifyStep(project, ctx, s, stats, log);
    }
    stats.waiting = await prisma.newsItem.count({ where: { projectId: project.id, status: "queued" } });

    // ── 6–7. Кластеры и балл ──
    await step("Кластеры");
    await clusterStep(project.id, s, stats);
    if (paid && !shouldStop()) {
      await step("Склейка дублей");
      await mergeStep(project.id, ctx, s, stats, log);
    }
    await step("Балл");
    await scoreStep(project, s, stats, entities);
    await step("Є на сайті");
    await onSiteStep(project, s, stats, log);
    if (paid && !shouldStop()) {
      await step("Суть карточек");
      await summaryStep(project, ctx, s, stats, log);
    }

    await prisma.newsRun.update({ where: { id: runId }, data: { status: "done", step: null, finishedAt: new Date(), stats: stats as unknown as Prisma.InputJsonValue, costUsd: cost } });
  } catch (e) {
    const msg = e instanceof NewsAiError || e instanceof Error ? e.message : String(e);
    log(`ошибка: ${msg}`);
    await prisma.newsRun.update({ where: { id: runId }, data: { status: "failed", step: null, finishedAt: new Date(), error: msg.slice(0, 2000), stats: stats as unknown as Prisma.InputJsonValue, costUsd: cost } });
  } finally {
    await prisma.newsProject.update({ where: { id: project.id }, data: { state: state as unknown as Prisma.InputJsonValue, nextRunAt: new Date(Date.now() + s.intervalMin * 60_000) } });
  }
}

function pickSources(rows: Prisma.NewsSourceGetPayload<object>[], scope: string, kind: string, s: NewsSettings): Src[] {
  const now = Date.now();
  const due = (r: Prisma.NewsSourceGetPayload<object>) => kind === "manual" || !r.lastFetchAt || now - r.lastFetchAt.getTime() >= ((r.intervalMin ?? s.intervalMin) - 3) * 60_000;
  const inScope = (r: Prisma.NewsSourceGetPayload<object>) => {
    if (scope === "all") return true;
    if (scope === "sites") return (r.kind === "rss" || r.kind === "sitemap") && r.tier !== "world";
    if (scope === "gnews") return r.kind === "gnews_query" || r.kind === "gnews_topic";
    if (scope === "world") return r.tier === "world";
    if (scope === "trends") return r.kind === "trends";
    if (scope.startsWith("source:")) return r.id === scope.slice(7);
    if (scope.startsWith("query:")) return false;
    return true;
  };
  return rows.filter((r) => inScope(r) && due(r)).map((r) => ({
    id: r.id, kind: r.kind, url: r.url, viaProxy: r.viaProxy, name: r.name, tier: r.tier, lang: r.lang, weight: r.weight, profile: r.profile,
    includeCats: asList(r.includeCats), excludeCats: asList(r.excludeCats), includeUrls: asList(r.includeUrls),
  }));
}

function toCandidate(it: FeedItem, src: Src): Candidate {
  const url = canonicalUrl(it.url);
  const domain = it.sourceUrl ? hostOf(it.sourceUrl) : hostOf(url);
  const title = it.title.trim();
  return {
    src, url, urlHash: sha1(url), domain, title, normTitle: normTitle(title), keyToks: [...new Set(keyTokens(title))], lead: it.lead ?? "", imageUrl: it.imageUrl,
    categories: it.categories ?? [], publishedAt: it.publishedAt && it.publishedAt.getTime() <= Date.now() + HOUR ? it.publishedAt : null,
  };
}

/** Дедупликация: по адресу, затем по заголовку (точное совпадение или ≥75% общих слов). Повтор — ещё один источник оригинала. */
async function dedup(projectId: string, runId: string, list: Candidate[], s: NewsSettings, stats: RunStats, perSource: Map<string, { fresh: number }>): Promise<Candidate[]> {
  const byHash = new Map<string, Candidate>();
  for (const c of list) if (c.title && !byHash.has(c.urlHash)) byHash.set(c.urlHash, c);
  const hashes = [...byHash.keys()];
  const known = new Set<string>();
  for (let i = 0; i < hashes.length; i += 500) {
    const rows = await prisma.newsItem.findMany({ where: { projectId, urlHash: { in: hashes.slice(i, i + 500) } }, select: { urlHash: true } });
    for (const r of rows) known.add(r.urlHash);
  }
  const since = new Date(Date.now() - Math.max(s.maxAgeHours, s.clusterWindowHours) * HOUR);
  const recent = await prisma.newsItem.findMany({ where: { projectId, foundAt: { gte: since }, status: { not: "dup" } }, select: { id: true, normTitle: true, title: true, clusterId: true, extraSources: true } });
  type Ref = { id: string | null; normTitle: string; toks: string[]; cand?: Candidate; clusterId?: string | null; extra?: unknown };
  const index = new Map<string, Ref[]>();
  const exact = new Map<string, Ref>();
  const add = (ref: Ref) => {
    exact.set(ref.normTitle, ref);
    for (const t of ref.toks) {
      const arr = index.get(t) ?? [];
      arr.push(ref);
      index.set(t, arr);
    }
  };
  for (const r of recent) add({ id: r.id, normTitle: r.normTitle, toks: [...new Set(keyTokens(r.title))], clusterId: r.clusterId, extra: r.extraSources });
  const fresh: Candidate[] = [];
  const maxAge = Date.now() - s.maxAgeHours * HOUR;
  const extraUpdates = new Map<string, unknown[]>();
  for (const c of byHash.values()) {
    if (known.has(c.urlHash)) continue;
    if (c.publishedAt && c.publishedAt.getTime() < maxAge) {
      stats.old++;
      continue;
    }
    let dupOf: Ref | undefined = c.normTitle.length >= 12 ? exact.get(c.normTitle) : undefined;
    if (!dupOf && c.keyToks.length >= 4) {
      const seen = new Set<Ref>();
      for (const t of c.keyToks) for (const ref of index.get(t) ?? []) seen.add(ref);
      for (const ref of seen) if (jaccard(c.keyToks, ref.toks) >= 0.75) {
        dupOf = ref;
        break;
      }
    }
    if (dupOf) {
      stats.dup++;
      const entry = { sourceId: c.src.virtual ? null : c.src.id, domain: c.domain, url: c.url, at: new Date().toISOString(), tier: c.src.tier, weight: c.src.weight };
      if (dupOf.id) {
        const arr = extraUpdates.get(dupOf.id) ?? (Array.isArray(dupOf.extra) ? [...(dupOf.extra as unknown[])] : []);
        if (!arr.some((x) => (x as { domain?: string }).domain === c.domain)) arr.push(entry);
        extraUpdates.set(dupOf.id, arr);
      } else if (dupOf.cand && dupOf.cand.domain !== c.domain) {
        // Повтор внутри одного прогона: оригинал ещё не записан — запоминаем на кандидате.
        dupOf.cand.extra = [...(dupOf.cand.extra ?? []), entry];
      }
      await prisma.newsItem.create({ data: { projectId, sourceId: c.src.virtual ? null : c.src.id, urlHash: c.urlHash, url: c.url.slice(0, 1990), domain: c.domain, title: wellFormed(c.title.slice(0, 2000)), normTitle: wellFormed(c.normTitle.slice(0, 480)), tier: c.src.tier, lang: c.src.lang, publishedAt: c.publishedAt, status: "dup", cutReason: dupOf.id ?? "в этом же прогоне", runId } }).catch(() => {});
      continue;
    }
    fresh.push(c);
    const ps = perSource.get(c.src.id);
    if (ps) ps.fresh++;
    add({ id: null, normTitle: c.normTitle, toks: c.keyToks, cand: c });
  }
  for (const [id, arr] of extraUpdates) {
    await prisma.newsItem.update({ where: { id }, data: { extraSources: arr.slice(-40) as unknown as Prisma.InputJsonValue } }).catch(() => {});
  }
  stats.fresh = fresh.length;
  return fresh;
}

/** Центроиды «нашего» по категориям и «не нашего» из уже размеченных LLM материалов за 30 дней. */
async function embedCentroids(projectId: string, targets: string[]) {
  const since = new Date(Date.now() - 30 * 24 * HOUR);
  const [pos, neg] = await Promise.all([
    prisma.newsItem.findMany({ where: { projectId, foundAt: { gte: since }, status: "classified", category: { in: targets }, embedding: { not: null } }, select: { category: true, embedding: true }, orderBy: { foundAt: "desc" }, take: 500 }),
    prisma.newsItem.findMany({ where: { projectId, foundAt: { gte: since }, status: "cut", cutStep: "llm", embedding: { not: null } }, select: { embedding: true }, orderBy: { foundAt: "desc" }, take: 400 }),
  ]);
  const byCat = new Map<string, Float32Array[]>();
  for (const p of pos) {
    const v = unpack(p.embedding);
    if (!v || !p.category) continue;
    byCat.set(p.category, [...(byCat.get(p.category) ?? []), v]);
  }
  const posC = [...byCat.values()].filter((l) => l.length >= 8).map((l) => centroid(l)!).filter(Boolean);
  const negV = neg.map((n) => unpack(n.embedding)).filter((v): v is Float32Array => !!v);
  return { ready: pos.length >= 40 && negV.length >= 40 && posC.length > 0, posC, negC: centroid(negV) };
}

async function embedStep(projectId: string, ctx: AiCtx, s: NewsSettings, stats: RunStats, log: (m: string) => void) {
  const items = await prisma.newsItem.findMany({ where: { projectId, status: "queued", embedding: null }, orderBy: { foundAt: "desc" }, take: 400, select: { id: true, title: true, lead: true, matched: true, tier: true } });
  if (!items.length) return;
  let vecs: Float32Array[];
  try {
    vecs = await embedTexts(ctx, items.map((i) => `${i.title}. ${(i.lead ?? "").slice(0, 300)}`));
  } catch (e) {
    log(`эмбеддинги не получены: ${e instanceof Error ? e.message : e}`);
    return;
  }
  stats.embedded = vecs.length;
  const cent = s.embedFilter ? await embedCentroids(projectId, s.targetCategories) : null;
  stats.embedFilterOn = !!cent?.ready;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const v = vecs[i];
    let cut: string | null = null;
    const strongEntity = Array.isArray(it.matched) && (it.matched as { weight?: number }[]).some((m) => (m.weight ?? 0) >= s.topEntityWeight);
    if (cent?.ready && cent.negC && !strongEntity && it.tier !== "primary") {
      const sp = Math.max(...cent.posC.map((c) => cos(v, c)));
      const sn = cos(v, cent.negC);
      if (sn - sp > s.embedMargin) cut = `ближе к «не нашему»: ${sn.toFixed(2)} против ${sp.toFixed(2)}`;
    }
    if (cut) stats.cutEmbed++;
    await prisma.newsItem.update({ where: { id: it.id }, data: { embedding: pack(v), ...(cut ? { status: "cut", cutStep: "embed", cutReason: cut } : {}) } });
  }
}

async function classifyStep(project: ProjectRow, ctx: AiCtx, s: NewsSettings, stats: RunStats, log: (m: string) => void) {
  const todayRuns = await prisma.newsRun.findMany({ where: { projectId: project.id, createdAt: { gte: dayStart() } }, select: { stats: true } });
  const done = todayRuns.reduce((a, r) => a + (Number((r.stats as { classified?: number } | null)?.classified) || 0), 0);
  const allowed = Math.max(0, Math.min(300, s.classifyPerDay - done));
  if (!allowed) {
    log(`дневной лимит классификаций ${s.classifyPerDay} исчерпан — материалы ждут завтра`);
    return;
  }
  const queue = await prisma.newsItem.findMany({ where: { projectId: project.id, status: "queued" }, orderBy: { foundAt: "desc" }, take: 400, select: { id: true, title: true, lead: true, domain: true, matched: true, tier: true, foundAt: true, cutReason: true } });
  const prio = (x: (typeof queue)[number]) => (Array.isArray(x.matched) ? Math.max(0, ...(x.matched as { weight?: number }[]).map((m) => m.weight ?? 0)) : 0) + (x.tier === "primary" ? 1 : 0);
  queue.sort((a, b) => prio(b) - prio(a) || b.foundAt.getTime() - a.foundAt.getTime());
  const pick = queue.slice(0, allowed);
  const site = project.siteUrl ? hostOf(project.siteUrl) || project.name : project.name;
  const RETRY = "повторная классификация";
  const batches: (typeof pick)[] = [];
  for (let i = 0; i < pick.length; i += 10) batches.push(pick.slice(i, i + 10));
  let fatal = false;
  // Пачки идут по 4 одновременно: прогон с бэклогом не растягивается на 10 минут.
  await mapLimit(batches, 4, async (batch) => {
    if (fatal) return;
    let res;
    try {
      res = await classifyBatch(ctx, site, batch.map((b) => ({ id: b.id, title: b.title, lead: b.lead ?? "", domain: b.domain })));
    } catch (e) {
      log(`классификация: ${e instanceof Error ? e.message : e}`);
      if (e instanceof NewsAiError && e.fatal) fatal = true;
      return;
    }
    for (const b of batch) {
      const r = res.find((x) => x.id === b.id);
      // Нет ответа или категория не из списка — один повтор в следующем прогоне, потом ошибка.
      if (!r || r.category === "unknown") {
        const again = b.cutReason !== RETRY;
        await prisma.newsItem.update({ where: { id: b.id }, data: again ? { cutReason: RETRY } : { status: "error", cutReason: r ? `модель вернула категорию «${r.rawCategory}»` : "модель не вернула ответ по материалу" } });
        continue;
      }
      stats.classified++;
      const target = s.targetCategories.includes(r.category);
      if (!target) stats.cutLlm++;
      await prisma.newsItem.update({
        where: { id: b.id },
        data: {
          status: target ? "classified" : "cut", cutStep: target ? null : "llm", cutReason: target ? null : `категория ${r.rawCategory || r.category}${r.subcategory ? ` (${r.subcategory})` : ""}`,
          category: r.category, subcategory: r.subcategory || null, entities: r.entities as unknown as Prisma.InputJsonValue, sensitive: r.sensitive, visual: r.visual, isNews: r.isNews, hasPrice: r.hasPriceUa,
        },
      });
    }
  });
}

const entKey = (e: { name: string; orig?: string }) => normText(e.orig && /[a-z]/i.test(e.orig) ? e.orig : e.name);

/** Герой кластера: персона/бренд, которую модель отметила главной (с привязкой к нашему списку, если имя совпало); иначе первое совпадение со списком. */
function mainEntityOf(it: { matched: unknown; entities: unknown }): { key: string; name: string } | null {
  const m = Array.isArray(it.matched) ? (it.matched as EntityHit[]) : [];
  const ents = Array.isArray(it.entities) ? (it.entities as { name: string; orig: string; role: string; type?: string }[]) : [];
  const main = ents.find((e) => e.role === "main" && (e.name || e.orig)) ?? ents.find((e) => e.name || e.orig);
  if (main) {
    const nm = normText(main.name || main.orig);
    const inList = m.find((x) => {
      const a = normText(x.name);
      return a === nm || nm.includes(a.split(" ").pop() ?? "\u0000") || a.includes(nm.split(" ").pop() ?? "\u0000");
    });
    return inList ? { key: `e:${inList.id}`, name: inList.name } : { key: `n:${entKey(main)}`, name: main.name || main.orig };
  }
  if (m.length) return { key: `e:${m[0].id}`, name: m[0].name };
  return null;
}

async function clusterStep(projectId: string, s: NewsSettings, stats: RunStats) {
  const items = await prisma.newsItem.findMany({ where: { projectId, status: "classified", clusterId: null }, orderBy: [{ publishedAt: "asc" }, { foundAt: "asc" }], take: 500 });
  if (!items.length) return;
  const since = new Date(Date.now() - s.clusterWindowHours * HOUR);
  const clusters = await prisma.newsCluster.findMany({ where: { projectId, lastItemAt: { gte: since } } });
  type C = { row: (typeof clusters)[number]; vec: Float32Array | null; toks: string[]; n: number; dirty: boolean; isNew: boolean; uaTitle: boolean | null };
  const live: C[] = clusters.map((c) => ({ row: c, vec: unpack(c.centroid), toks: [...new Set(keyTokens(c.title))], n: c.itemCount, dirty: false, isNew: false, uaTitle: null }));
  for (const it of items) {
    const v = unpack(it.embedding);
    const me = mainEntityOf(it);
    const toks = [...new Set(keyTokens(it.title))];
    let best: C | null = null;
    let bestSim = 0;
    for (const c of live) {
      const sim = v && c.vec ? cos(v, c.vec) : jaccard(toks, c.toks) + 0.3;
      const sameHero = !!me && (c.row.mainEntity === me.key || (heroSkeleton(me.name).length >= 3 && heroSkeleton(me.name) === heroSkeleton(c.row.mainEntityName)));
      const need = sameHero ? s.clusterSimEntity : s.clusterSim;
      if (sim >= need && sim > bestSim) {
        best = c;
        bestSim = sim;
      }
    }
    const at = it.publishedAt ?? it.foundAt;
    if (best) {
      if (v) best.vec = best.vec ? addToCentroid(best.vec, best.n, v) : v;
      best.n++;
      best.dirty = true;
      // Заголовок кластера — украинский: мировой заменяем первой украинской публикацией.
      if (it.tier !== "world") {
        if (best.uaTitle === null) best.uaTitle = (await prisma.newsItem.count({ where: { clusterId: best.row.id, tier: { not: "world" } } })) > 0;
        if (!best.uaTitle) {
          best.row.title = it.title;
          best.toks = toks;
          best.uaTitle = true;
        }
      }
      if (!best.row.imageUrl && it.imageUrl) best.row.imageUrl = it.imageUrl;
      if (at < best.row.firstPublishedAt) best.row.firstPublishedAt = at;
      if (at > best.row.lastItemAt) best.row.lastItemAt = at;
      await prisma.newsItem.update({ where: { id: it.id }, data: { clusterId: best.row.id } });
    } else {
      const row = await prisma.newsCluster.create({
        data: {
          projectId, title: wellFormed(it.title.slice(0, 2000)), imageUrl: it.imageUrl, category: it.category, subcategory: it.subcategory, mainEntity: me?.key ?? null, mainEntityName: me?.name ?? null,
          entities: it.entities ?? Prisma.DbNull, centroid: v ? pack(v) : null, itemCount: 1, firstPublishedAt: at, lastItemAt: at, sensitive: it.sensitive, hasPrice: it.hasPrice, visual: it.visual,
        },
      });
      await prisma.newsItem.update({ where: { id: it.id }, data: { clusterId: row.id } });
      live.push({ row, vec: v, toks, n: 1, dirty: true, isNew: true, uaTitle: it.tier !== "world" });
      stats.clustersNew++;
    }
  }
  for (const c of live.filter((x) => x.dirty)) {
    if (!c.isNew) stats.clustersUpdated++;
    await prisma.newsCluster.update({
      where: { id: c.row.id },
      data: { title: c.row.title, imageUrl: c.row.imageUrl, firstPublishedAt: c.row.firstPublishedAt, lastItemAt: c.row.lastItemAt, centroid: c.vec ? pack(c.vec) : null, itemCount: c.n },
    });
  }
}

type SourceInfo = { domain: string; tier: string; weight: number; at: number };

async function scoreStep(project: ProjectRow, s: NewsSettings, stats: RunStats, entities: EntityRow[]) {
  const now = new Date();
  const clusters = await prisma.newsCluster.findMany({ where: { projectId: project.id, lastItemAt: { gte: new Date(now.getTime() - 26 * HOUR) } } });
  if (!clusters.length) return;
  const [items, sources, trends] = await Promise.all([
    prisma.newsItem.findMany({ where: { clusterId: { in: clusters.map((c) => c.id) } }, orderBy: { foundAt: "asc" }, select: { clusterId: true, sourceId: true, url: true, domain: true, tier: true, foundAt: true, publishedAt: true, imageUrl: true, matched: true, visual: true, hasPrice: true, sensitive: true, category: true, entities: true, extraSources: true } }),
    prisma.newsSource.findMany({ where: { projectId: project.id }, select: { id: true, weight: true } }),
    prisma.newsTrend.findMany({ where: { projectId: project.id, relevant: true, lastSeenAt: { gte: new Date(now.getTime() - 6 * HOUR) } } }),
  ]);
  const weightOf = new Map(sources.map((x) => [x.id, x.weight]));
  const byCluster = new Map<string, typeof items>();
  for (const it of items) if (it.clusterId) byCluster.set(it.clusterId, [...(byCluster.get(it.clusterId) ?? []), it]);
  const entWeight = new Map(entities.map((e) => [e.id, e]));
  const recentWindow = 2 * s.intervalMin * 60_000;
  const tokenUser = project.tgTokenEnc ? safeDecrypt(project.tgTokenEnc) : null;
  for (const c of clusters) {
    const list = byCluster.get(c.id) ?? [];
    if (!list.length) continue;
    const srcs = new Map<string, SourceInfo>();
    for (const it of list) {
      const w = (it.sourceId && weightOf.get(it.sourceId)) || 1;
      const prev = srcs.get(it.domain);
      // Время источника — публикация (не позже, чем мы её нашли): иначе первый прогон считает всё «за последний час».
      const at = Math.min(it.foundAt.getTime(), it.publishedAt?.getTime() ?? Infinity);
      if (!prev || at < prev.at) srcs.set(it.domain, { domain: it.domain, tier: it.tier, weight: w, at });
      for (const x of Array.isArray(it.extraSources) ? (it.extraSources as { domain: string; tier: string; weight?: number; at: string }[]) : []) {
        const t = Date.parse(x.at);
        const p2 = srcs.get(x.domain);
        if (!p2 || t < p2.at) srcs.set(x.domain, { domain: x.domain, tier: x.tier, weight: x.weight ?? 1, at: t });
      }
    }
    const all = [...srcs.values()];
    const recent = all.filter((x) => now.getTime() - x.at <= recentWindow);
    let best: { name: string; weight: number } | null = null;
    for (const it of list) for (const m of Array.isArray(it.matched) ? (it.matched as EntityHit[]) : []) {
      const e = entWeight.get(m.id);
      if (e && (!best || e.weight > best.weight)) best = { name: e.name, weight: e.weight };
    }
    const names = new Set<string>();
    for (const it of list) for (const e of Array.isArray(it.entities) ? (it.entities as { name: string; orig: string }[]) : []) {
      if (e.name) names.add(normText(e.name));
      if (e.orig) names.add(normText(e.orig));
    }
    if (best) names.add(normText(best.name));
    const titleToks = [...new Set([...keyTokens(c.title), ...[...names].flatMap((n) => n.split(" "))])];
    const trend = trends.find((t) => names.has(t.normTitle) || trendInTitle(t.normTitle, titleToks));
    const category = c.category ?? list.find((x) => x.category)?.category ?? null;
    const facts = {
      category, isTarget: !!category && s.targetCategories.includes(category), recentWeighted: recent.reduce((a, x) => a + x.weight, 0), recentCount: recent.length,
      recentUa: recent.filter((x) => now.getTime() - x.at <= 3600_000 && x.tier !== "world").length, sourceCount: all.length,
      uaCount: all.filter((x) => x.tier !== "world").length, worldCount: all.filter((x) => x.tier === "world").length, worldStrong: all.filter((x) => x.tier === "world" && x.weight >= 0.7).length, entityName: best?.name ?? null, entityWeight: best?.weight ?? 0,
      trend: trend ? { title: trend.title, traffic: trend.traffic } : null, visual: Math.max(0, ...list.map((x) => x.visual ?? 0)) || null, hasImage: list.some((x) => !!x.imageUrl) || !!c.imageUrl,
      hasPrice: list.some((x) => x.hasPrice), sensitive: list.some((x) => x.sensitive), firstPublishedAt: c.firstPublishedAt, now,
    };
    const { score, parts } = scoreCluster(facts);
    const pr = priorityOf(facts, score, s.urgentScore, s.topEntityWeight);
    const hist = (Array.isArray(c.scoreHistory) ? (c.scoreHistory as { at: string; score: number }[]) : []).concat({ at: now.toISOString(), score }).slice(-48);
    const urgent = score >= s.urgentScore;
    await prisma.newsCluster.update({
      where: { id: c.id },
      data: {
        priority: pr.priority, priorityWhy: pr.why as unknown as Prisma.InputJsonValue,
        score, scoreParts: parts as unknown as Prisma.InputJsonValue, scoreHistory: hist as unknown as Prisma.InputJsonValue, urgent, sourceCount: all.length, itemCount: list.length,
        uaCount: all.filter((x) => x.tier !== "world").length, worldCount: all.filter((x) => x.tier === "world").length, mainEntityName: (list.map((x) => mainEntityOf(x)?.name).find(Boolean) as string | undefined) ?? c.mainEntityName ?? best?.name ?? null,
        visual: Math.max(0, ...list.map((x) => x.visual ?? 0)) || null, hasPrice: list.some((x) => x.hasPrice), sensitive: list.some((x) => x.sensitive), category,
      },
    });
    if (urgent && !c.alertedAt && c.status === "new" && s.telegramAlerts && tokenUser && project.tgChatId) {
      const why = (parts as ScorePart[]).filter((p) => p.points > 0).sort((a, b) => b.points - a.points).map((p) => `${p.label}: ${p.why}`);
      const base = process.env.APP_URL || "https://zewex.tools";
      const firstUrl = (list.find((x) => x.tier !== "world") ?? list[0]).url;
      const r = await sendTelegram(tokenUser, project.tgChatId, alertText({ title: c.title, score, category, sourceCount: all.length, why, url: firstUrl, link: `${base}${BASE_PATH}?project=${project.id}#c-${c.id}` }));
      if (r.ok) {
        await prisma.newsCluster.update({ where: { id: c.id }, data: { alertedAt: new Date() } });
        stats.alerts++;
      } else stats.log = [...(stats.log ?? []), `Telegram: ${r.error}`].slice(-60);
    }
  }
}

/** Тренд «в заголовке»: каждое значимое слово тренда есть среди слов кластера (сравнение по основе). */
function trendInTitle(trend: string, toks: string[]): boolean {
  const words = trend.split(" ").filter((w) => w.length >= 3);
  if (!words.length) return false;
  return words.every((w) => {
    const stem = w.slice(0, Math.max(3, w.length - 2));
    return toks.some((x) => x.startsWith(stem));
  });
}

function safeDecrypt(enc: string): string | null {
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

async function alertProject(project: ProjectRow, text: string) {
  const s = parseSettings(project.settings);
  if (!s.telegramAlerts || !project.tgTokenEnc || !project.tgChatId) return;
  const token = safeDecrypt(project.tgTokenEnc);
  if (token) await sendTelegram(token, project.tgChatId, text.replace(/[<>&]/g, ""));
}

export async function testTelegram(projectId: string): Promise<{ ok: boolean; error?: string }> {
  const p = await prisma.newsProject.findUniqueOrThrow({ where: { id: projectId } });
  if (!p.tgTokenEnc || !p.tgChatId) return { ok: false, error: "Не заданы токен бота и чат" };
  const token = safeDecrypt(p.tgTokenEnc);
  if (!token) return { ok: false, error: "Токен не расшифровался — впишите его заново" };
  return sendTelegram(token, p.tgChatId, `✅ Модуль «Новости» (${p.name}) подключён: сюда будут приходить срочные новости с баллом от ${parseSettings(p.settings).urgentScore}.`);
}

