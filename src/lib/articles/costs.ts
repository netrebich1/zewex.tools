/**
 * Учёт расходов сервиса «Статьи» по фазам: по сайтам, запускам, дням и статьям.
 *
 * Источник правды — UsageLog (refId = id статьи): каждый платный вызов (ИИ, DataForSEO, SerpAPI) пишется туда
 * с точной ценой (OpenRouter usage.cost / цена DataForSEO). Article.costUsd = сумма UsageLog по refId,
 * поэтому разбивка по фазам всегда сходится с суммой по статьям до копейки.
 *
 * Как вызов попадает в фазу (по времени, а не по слоту — один слот работает в разных фазах):
 *  1. vision-вызов внутри окна ИИ-модерации статьи (прочие слоты — если вне окон этапов) (ArtAiModerationResult createdAt…updatedAt) → «ИИ-модерация».
 *     ArtAiModerationResult.costUsd НЕ прибавляем отдельно: это те же вызовы UsageLog, иначе был бы двойной счёт.
 *     Проверено на проде: запуск 2f7e7129 — vision в окнах ИИ-модерации = $0.0712638 = сумма ArtAiModerationResult.costUsd.
 *  2. Иначе — окно этапа воркера (ArtStageLog startedAt…finishedAt) → фаза этапа (search/filter → «Поиск фото» и т.д.).
 *     ArtStageLog.costUsd не используем: при временной ошибке этап закрывается без суммы, и деньги «теряются».
 *  3. Иначе (ручные действия вне воркера, старые записи) — по слоту: photo_dfs/photo_serp → поиск, text_main → текст,
 *     image_main → картинки, vision → ИИ-модерация (если у статьи были проверки ИИ) или оценка фото, прочее → «Вне этапов».
 */
import { prisma } from "@/lib/db";
import type { ArtStatus, Prisma } from "@prisma/client";
import { PROJECT_SLUG } from "./types";

export type CostPhase = "search" | "rate" | "ai_moderation" | "images" | "text" | "publish" | "other";

export const COST_PHASES: Array<{ key: CostPhase; label: string; hint: string }> = [
  { key: "search", label: "Поиск фото", hint: "Запросы ИИ (text_fast) и выдача Google Images (DataForSEO / SerpAPI) на этапах поиска и фильтра" },
  { key: "rate", label: "Оценка фото", hint: "Зрение ИИ (vision): сравнение кадров, оценка, отбор" },
  { key: "ai_moderation", label: "ИИ-модерация", hint: "Проверка фото ИИ вместо человека (vision в окне проверки)" },
  { key: "images", label: "Картинки ИИ", hint: "Генерация картинок и концепт (формат «сгенерированные фото»)" },
  { key: "text", label: "Текст", hint: "План, секции, вступление, мета (text_main / text_fast)" },
  { key: "publish", label: "Публикация", hint: "Проверка качества и категория перед постом в WordPress" },
  { key: "other", label: "Вне этапов", hint: "Вызовы вне воркера: ручные действия модераторов, старые записи" },
];

export const phaseLabel = (p: CostPhase) => COST_PHASES.find((x) => x.key === p)?.label ?? p;

/** Этап воркера → фаза расходов. */
const STAGE_PHASE: Record<string, CostPhase> = {
  search: "search", filter: "search",
  rank: "rate", rate: "rate", select: "rate",
  concept: "images", images: "images",
  image_seo: "text", plan: "text", section_plan: "text", blueprint: "text", intro_outro: "text", sections: "text", meta: "text", assemble: "text",
  publish: "publish",
};
export const stageCostPhase = (stage: string): CostPhase => STAGE_PHASE[stage] ?? "other";

export type PhaseSums = Record<CostPhase, number>;
export const emptyPhases = (): PhaseSums => ({ search: 0, rate: 0, ai_moderation: 0, images: 0, text: 0, publish: 0, other: 0 });

/** Исход статьи для расходов: опубликована / потеряна (ошибка или остановлена) / ещё в работе или ждёт людей. */
export type CostOutcome = "published" | "wasted" | "open";
export function outcomeOf(s: ArtStatus): CostOutcome {
  if (s === "COMPLETED") return "published";
  if (s === "FAILED" || s === "PUBLISH_ERROR" || s === "STOPPED") return "wasted";
  return "open";
}

export type CostFilter = {
  /** Видимые пользователю сайты (обязательно — права проверяет вызывающий) */
  siteIds: string[];
  /** Сузить до одного сайта */
  siteId?: string;
  runId?: string;
  /** Расход, сделанный в этот период (по времени вызова). Без периода — весь расход статей. */
  since?: Date;
  until?: Date;
  /** Вернуть таблицу по статьям */
  withArticles?: boolean;
};

export type ArticleCostRow = {
  id: string; keyword: string; siteId: string; runId: string | null; status: ArtStatus; outcome: CostOutcome;
  total: number; calls: number; phases: PhaseSums;
};

export type CostGroup = { id: string; total: number; phases: PhaseSums; articles: number };

export type CostBreakdown = {
  total: number;
  calls: number;
  phases: PhaseSums;
  bySite: CostGroup[];
  byRun: CostGroup[];
  /** По дням (UTC, YYYY-MM-DD), только дни с расходом */
  byDay: Array<{ day: string; total: number; phases: PhaseSums }>;
  /** По сайтам и дням: siteId → день → сумма */
  bySiteDay: Array<{ siteId: string; day: string; total: number }>;
  outcome: Record<CostOutcome, { articles: number; cost: number }>;
  /** Средняя стоимость самой опубликованной статьи (её собственные вызовы) */
  avgPublished: number | null;
  /** Полная цена одной публикации: весь расход (с потерянными и незаконченными) / число опубликованных */
  fullPerPublished: number | null;
  articles: ArticleCostRow[];
  /**
   * Сверка: без периода сумма разбивки обязана совпасть с Σ Article.costUsd этих статей.
   * С периодом сверяем только с UsageLog (Article.costUsd копится за всё время).
   */
  check: { articleCostSum: number | null; diff: number | null; ok: boolean };
};

const CHUNK = 1000;
const chunks = <T,>(list: T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

type ArtRow = { id: string; keyword: string; siteId: string; runId: string | null; status: ArtStatus; costUsd: number };
type UseRow = { refId: string | null; createdAt: Date; costUsd: number | null; slot: { key: string } | null };

/** Главная функция: разбивка расходов по фазам для фильтра (сайт / запуск / период). */
export async function costBreakdown(f: CostFilter): Promise<CostBreakdown> {
  const siteIds = f.siteId ? f.siteIds.filter((s) => s === f.siteId) : f.siteIds;
  const empty = blank();
  if (!siteIds.length) return empty;
  const project = await prisma.project.findUnique({ where: { slug: PROJECT_SLUG }, select: { id: true } });
  if (!project) return empty;
  const period: Prisma.DateTimeFilter | undefined = f.since || f.until ? { ...(f.since ? { gte: f.since } : {}), ...(f.until ? { lt: f.until } : {}) } : undefined;
  const artSelect = { id: true, keyword: true, siteId: true, runId: true, status: true, costUsd: true } as const;
  const useSelect = { refId: true, createdAt: true, costUsd: true, slot: { select: { key: true } } } as const;

  let arts: ArtRow[];
  let uses: UseRow[] = [];
  if (period) {
    // С периодом: сначала вызовы за период, потом их статьи (с проверкой видимости) — статей может быть много.
    const raw = await prisma.usageLog.findMany({ where: { projectId: project.id, refId: { not: null }, createdAt: period }, select: useSelect });
    const ids = [...new Set(raw.map((u) => u.refId!))];
    arts = [];
    for (const part of chunks(ids)) {
      arts.push(...(await prisma.article.findMany({ where: { id: { in: part }, siteId: { in: siteIds }, ...(f.runId ? { runId: f.runId } : {}) }, select: artSelect })));
    }
    const keep = new Set(arts.map((a) => a.id));
    uses = raw.filter((u) => keep.has(u.refId!));
  } else {
    arts = await prisma.article.findMany({ where: { siteId: { in: siteIds }, ...(f.runId ? { runId: f.runId } : {}) }, select: artSelect });
    for (const part of chunks(arts.map((a) => a.id))) {
      uses.push(...(await prisma.usageLog.findMany({ where: { projectId: project.id, refId: { in: part } }, select: useSelect })));
    }
  }
  if (!arts.length) return empty;

  // Окна этапов и ИИ-модерации по статьям, где были вызовы.
  const withUse = [...new Set(uses.map((u) => u.refId!))];
  const stageWin = new Map<string, Array<{ from: number; to: number; phase: CostPhase }>>();
  const aiWin = new Map<string, Array<{ from: number; to: number }>>();
  for (const part of chunks(withUse)) {
    const [logs, ai] = await Promise.all([
      prisma.artStageLog.findMany({ where: { articleId: { in: part } }, select: { articleId: true, stage: true, startedAt: true, finishedAt: true }, orderBy: { startedAt: "asc" } }),
      prisma.artAiModerationResult.findMany({ where: { articleId: { in: part } }, select: { articleId: true, createdAt: true, updatedAt: true } }),
    ]);
    const byArt = new Map<string, typeof logs>();
    for (const l of logs) { const list = byArt.get(l.articleId) ?? []; list.push(l); byArt.set(l.articleId, list); }
    for (const [aid, list] of byArt) {
      // Незакрытое окно (воркер упал) — до начала следующего этапа или максимум час, чтобы не «съесть» чужие вызовы.
      stageWin.set(aid, list.map((l, i) => ({
        from: l.startedAt.getTime(),
        to: l.finishedAt ? l.finishedAt.getTime() : Math.min(list[i + 1]?.startedAt.getTime() ?? Infinity, l.startedAt.getTime() + 3_600_000),
        phase: stageCostPhase(l.stage),
      })));
    }
    for (const r of ai) { const list = aiWin.get(r.articleId) ?? []; list.push({ from: r.createdAt.getTime(), to: r.updatedAt.getTime() }); aiWin.set(r.articleId, list); }
  }

  const phaseOfUse = (u: UseRow): CostPhase => {
    const t = u.createdAt.getTime();
    const key = u.slot?.key ?? "";
    const aid = u.refId!;
    const inAi = aiWin.get(aid)?.some((w) => t >= w.from && t <= w.to);
    if (key === "vision" && inAi) return "ai_moderation";
    const st = stageWin.get(aid)?.find((w) => t >= w.from && t <= w.to);
    if (st) return st.phase;
    // Вне этапов воркера, но в окне проверки ИИ (статья стоит в PHOTO_REVIEW) — описание ключа «MUST show» через text_fast.
    // Окна этапов проверяются раньше: updatedAt результата может сдвинуться позже (применение, аудит) и накрыть написание.
    if (inAi) return "ai_moderation";
    if (key === "photo_dfs" || key === "photo_serp") return "search";
    if (key === "text_main") return "text";
    if (key === "image_main") return "images";
    if (key === "vision") return aiWin.has(aid) ? "ai_moderation" : "rate";
    return "other";
  };

  const artMap = new Map(arts.map((a) => [a.id, a]));
  const perArt = new Map<string, { total: number; calls: number; phases: PhaseSums }>();
  const res = blank();
  const day = new Map<string, PhaseSums>();
  const siteDay = new Map<string, number>();
  for (const u of uses) {
    const c = u.costUsd ?? 0;
    const p = phaseOfUse(u);
    const a = artMap.get(u.refId!)!;
    const pa = perArt.get(a.id) ?? { total: 0, calls: 0, phases: emptyPhases() };
    pa.total += c; pa.calls++; pa.phases[p] += c;
    perArt.set(a.id, pa);
    res.total += c; res.calls++; res.phases[p] += c;
    const d = u.createdAt.toISOString().slice(0, 10);
    const dp = day.get(d) ?? emptyPhases(); dp[p] += c; day.set(d, dp);
    const sk = `${a.siteId}|${d}`; siteDay.set(sk, (siteDay.get(sk) ?? 0) + c);
  }

  const group = (keyOf: (a: ArtRow) => string | null) => {
    const m = new Map<string, CostGroup>();
    for (const a of arts) {
      const k = keyOf(a); if (!k) continue;
      const pa = perArt.get(a.id);
      if (period && !pa) continue;
      const g = m.get(k) ?? { id: k, total: 0, phases: emptyPhases(), articles: 0 };
      g.articles++;
      if (pa) { g.total += pa.total; for (const ph of COST_PHASES) g.phases[ph.key] += pa.phases[ph.key]; }
      m.set(k, g);
    }
    return [...m.values()].sort((x, y) => y.total - x.total);
  };
  res.bySite = group((a) => a.siteId);
  res.byRun = group((a) => a.runId);
  res.byDay = [...day.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([d, phases]) => ({ day: d, phases, total: sumPhases(phases) }));
  res.bySiteDay = [...siteDay.entries()].map(([k, total]) => { const [siteId, d] = k.split("|"); return { siteId, day: d, total }; });

  let pubCost = 0;
  for (const a of arts) {
    const pa = perArt.get(a.id);
    if (period && !pa) continue;
    const o = outcomeOf(a.status);
    res.outcome[o].articles++;
    res.outcome[o].cost += pa?.total ?? 0;
    if (o === "published") pubCost += pa?.total ?? 0;
    if (f.withArticles) res.articles.push({ id: a.id, keyword: a.keyword, siteId: a.siteId, runId: a.runId, status: a.status, outcome: o, total: pa?.total ?? 0, calls: pa?.calls ?? 0, phases: pa?.phases ?? emptyPhases() });
  }
  const pub = res.outcome.published.articles;
  res.avgPublished = pub ? pubCost / pub : null;
  res.fullPerPublished = pub ? res.total / pub : null;
  res.articles.sort((x, y) => y.total - x.total);

  if (!period) {
    const sum = arts.reduce((s, a) => s + a.costUsd, 0);
    const diff = res.total - sum;
    // Article.costUsd пересчитывается после каждого этапа; расход ИИ-модерации и ручных действий дописывается сразу —
    // расхождение больше доли цента значит, что статья ещё в работе или счётчик не обновлён.
    res.check = { articleCostSum: sum, diff, ok: Math.abs(diff) < 0.000_01 };
  } else {
    res.check = { articleCostSum: null, diff: null, ok: true };
  }
  return res;
}

export const sumPhases = (p: PhaseSums) => COST_PHASES.reduce((s, x) => s + p[x.key], 0);

/** Фазы, по которым есть расход (чтобы не рисовать пустые колонки). Порядок — как в COST_PHASES. */
export function activePhases(...list: PhaseSums[]): CostPhase[] {
  return COST_PHASES.map((p) => p.key).filter((k) => list.some((x) => x[k] > 0));
}

function blank(): CostBreakdown {
  return {
    total: 0, calls: 0, phases: emptyPhases(), bySite: [], byRun: [], byDay: [], bySiteDay: [],
    outcome: { published: { articles: 0, cost: 0 }, wasted: { articles: 0, cost: 0 }, open: { articles: 0, cost: 0 } },
    avgPublished: null, fullPerPublished: null, articles: [], check: { articleCostSum: null, diff: null, ok: true },
  };
}
