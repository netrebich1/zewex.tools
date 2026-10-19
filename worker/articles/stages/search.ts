/**
 * Этап search (оригинал: шаг 11, stage-photo-search/index.ts + добор из stage-photo-filter/index.ts:247-342).
 *
 * Первый запуск: один вызов ИИ (rp_photo_search) → 3 primary + 3 secondary запроса, keyword_ru, тренд-справка;
 * контракты темы в facts; затем запросы Google Images (DataForSEO, резерв SerpApi): ключ статьи и primary-варианты,
 * пока кандидатов меньше резерва фильтра. Режим добора (cursor.topup от filter/rate/select/модерации): следующий
 * неиспользованный запрос (остаток primary → secondary → один раз «другое гео»), не больше PHOTO_LOOPS.maxTopups.
 * Исчерпание → ожидание человека (PHOTO_REVIEW, если фото уже отобраны, иначе WAITING_FOR_PHOTOS).
 */
import { prisma } from "@/lib/db";
import type { Article, Prisma } from "@prisma/client";
import { PHOTO_LOOPS, type ArticleCursor, type ArticleFacts } from "@/lib/articles/types";
import { getNicheProfile, specializeProfile } from "@/lib/articles/photo/profile";
import { buildSearchQuery, hostOf, isBlockedDomain, nextGeo, normalizeSearchConfig, searchImagesWithFallback, searchSerpApi, type PhotoCandidateInput, type SearchCfg, type SearchResult } from "@/lib/articles/photo/search";
import { fallbackTrendBrief, generateTopupQueries, languageName, translateSearchQueries } from "@/lib/articles/photo/queries";
import { buildFashionContract, buildInteriorContract, buildTopicContract, isInteriorNiche } from "@/lib/articles/photo/contracts";
import { audienceFacts } from "@/lib/articles/photo/audience";
import { parseKeywordAttributes } from "@/lib/articles/photo/keyword";
import { AiError } from "@/lib/pins/ai/errors";
import type { ArtStageHandler, ArtStageCtx, ArtStageResult } from "./index";

export type TopupRequest = { from: "filter" | "rate" | "select" | "moderation"; needed: number; reason: string };

export type SearchLogEntry = {
  engine: string;
  query: string;
  keywordEn: string;
  translated: boolean;
  geo: string;
  language: string;
  freshness: string;
  fetched: number;
  added: number;
  error: string | null;
  at: string;
};

/** Поля курсора, которыми пользуется фото-цепочка (поверх ArticleCursor). */
export type PhotoCursor = ArticleCursor & {
  topup?: TopupRequest | null;
  /** rate вернул статью в filter доделать непроверенных кандидатов (без раннего стопа и без добора) */
  filterPending?: boolean;
  /** Исходный английский ключ поиска (шаблон primary[0] профиля) */
  searchKeyword?: string;
  searchLog?: SearchLogEntry[];
  usedGeos?: string[];
  geoTopupDone?: boolean;
  /** Сколько раз запрос (в нижнем регистре) не выполнился из-за временного сбоя провайдера. */
  queryFails?: Record<string, number>;
};

/**
 * После стольких временных сбоев на одном запросе он считается использованным и поиск идёт к следующему.
 * DataForSEO 40101 «Internal SE Server Error» стабильно повторяется на одних и тех же странных формулировках
 * (zorvianix 2026-10-15: 6 из 182 запросов, все — длинные доборы ИИ), пауза их не лечит.
 */
const QUERY_FAIL_LIMIT = 2;

/** Единый источник ключа для поиска фото (оригинал: resolveSearchKeyword, photoSearch.ts:228-233). */
export function articleKeyword(article: Pick<Article, "focusKeyword" | "keyword" | "seoKeyword">): string {
  return String(article.focusKeyword || article.keyword || article.seoKeyword || "").trim();
}

/**
 * Резерв технически годных кадров до ИИ-оценки (оригинал: stage-photo-filter/index.ts:193 — ×5).
 * Для больших статей ×5 избыточен (40 фото → 200 кандидатов на поиск и vision-оценку, zorvianix 2026-10-15):
 * при нехватке после оценки/отбора всё равно срабатывает добор (rate/select → search), поэтому от 16 фото — ×3, не меньше 75.
 */
export function reserveTargetFor(needed: number): number {
  if (needed <= 15) return Math.max(needed * 5, needed + 40);
  return Math.max(needed * 3, 75);
}

const lower = (s: string) => s.trim().toLowerCase();

/** Ещё есть чем добирать: неиспользованные запросы или неиспользованный гео-вариант, и лимит доборов не исчерпан. */
export function topupAvailable(cursor: PhotoCursor): boolean {
  if ((cursor.topups ?? 0) >= PHOTO_LOOPS.maxTopups) return false;
  const used = new Set((cursor.usedQueries ?? []).map(lower));
  const all = [...(cursor.searchQueries?.primary ?? []), ...(cursor.searchQueries?.secondary ?? [])];
  if (all.some((q) => !used.has(lower(q)))) return true;
  return !cursor.geoTopupDone;
}

type RunOutcome = { fetched: number; added: number; error?: string; notConfigured?: boolean; transient?: boolean; keyProblem?: string; engine: string; burned?: boolean };

export const search: ArtStageHandler = async (ctx) => {
  const { article, recipe } = ctx;
  const cursor = ctx.cursor as PhotoCursor;
  const facts: ArticleFacts = ctx.facts;
  const cfg = normalizeSearchConfig(recipe.photoSearch);
  const keyword = articleKeyword(article);
  if (!keyword) return { fatal: "Не найдено ключевое слово статьи" };
  const niche = recipe.nicheCode;
  const needed = Math.max(1, article.photoCount || 20);
  const reserveTarget = reserveTargetFor(needed);
  const profile = specializeProfile(await getNicheProfile(niche, recipe.subnicheCode), keyword);
  const notes: string[] = [];

  // ── Первый запуск: разметка ключа, контракты, один вызов ИИ за запросами ──
  if (!cursor.searchQueries) {
    await ctx.tick("Поиск фото: вариации запроса");
    const attrs = (facts.keywordAttributes && Object.keys(facts.keywordAttributes).length ? facts.keywordAttributes : parseKeywordAttributes(keyword, profile)) as Record<string, unknown>;
    const gen = await generateTopupQueries(ctx.ai, recipe, keyword, cfg, profile, attrs);
    if (gen.error) notes.push(`вариации (${gen.source}): ${gen.error}`);
    const primaryTemplate = (profile.search_templates?.primary || [])[0] || "{keyword}";
    const searchKeyword = primaryTemplate.replace(/\{keyword\}/g, keyword).replace(/\s+/g, " ").trim() || keyword;

    const topicContract = buildTopicContract(profile, attrs, keyword);
    const fashion = profile.niche_code === "outfits" ? gen.fashion_contract || buildFashionContract(keyword, attrs) : undefined;
    const interior = isInteriorNiche(profile.niche_code, recipe.subnicheCode) ? gen.interior_contract || buildInteriorContract(keyword, attrs) : undefined;
    const trend = gen.trend_brief || fallbackTrendBrief(niche, keyword);

    const nextFacts: ArticleFacts = {
      ...facts,
      keywordAttributes: attrs,
      topicContract: topicContract as unknown as Record<string, unknown>,
      fashionContract: fashion ? (fashion as unknown as Record<string, unknown>) : undefined,
      interiorContract: interior ? (interior as unknown as Record<string, unknown>) : undefined,
      audience: audienceFacts(keyword, niche) as unknown as Record<string, unknown>,
      trendBrief: trend ? ({ ...trend, ru: gen.trend_brief_ru, source: gen.trend_brief ? "ai" : "fallback" } as Record<string, unknown>) : undefined,
      keywordRu: gen.keyword_ru || facts.keywordRu,
    };
    const nextCursor: PhotoCursor = {
      ...cursor,
      searchQueries: { primary: gen.primary, secondary: gen.secondary },
      usedQueries: cursor.usedQueries ?? [],
      topups: cursor.topups ?? 0,
      searchKeyword,
      searchLog: cursor.searchLog ?? [],
      usedGeos: cursor.usedGeos ?? [],
    };
    await ctx.save({ cursor: nextCursor, facts: nextFacts, note: `Запросы: ${gen.source}` });
    if (gen.keyword_ru && !article.keywordRu) {
      await prisma.article.update({ where: { id: article.id }, data: { keywordRu: gen.keyword_ru } }).catch(() => {});
    }
    ctx.log(`queries (${gen.source}): primary=${gen.primary.join(" | ")}; secondary=${gen.secondary.join(" | ")}`);
  }

  const cur = ctx.cursor as PhotoCursor;
  const searchKeyword = cur.searchKeyword || keyword;
  const knownUrls = new Set((await prisma.artPhotoCandidate.findMany({ where: { articleId: article.id }, select: { url: true } })).map((c) => c.url));
  let candidatesTotal = knownUrls.size;

  /** Выполнить один запрос: перевод (не-en гео), кэш по тексту запроса, провайдеры, фильтры доменов/размеров, запись кандидатов. */
  const runQuery = async (englishQuery: string, limit: number, queryIndex: number, runCfg: SearchCfg, label: string): Promise<RunOutcome> => {
    let searchText = englishQuery;
    let translated = false;
    if (runCfg.language.slice(0, 2) !== "en") {
      const tr = await translateSearchQueries(ctx.ai, recipe, [englishQuery], runCfg.language);
      searchText = tr.queries[0] || englishQuery;
      translated = tr.translated;
      notes.push(tr.translated ? `Поиск на ${languageName(runCfg.language)}: «${englishQuery}» → «${searchText}»` : `Перевод не выполнен${tr.error ? ` (${tr.error})` : ""} — ищем на английском`);
    }
    const query = buildSearchQuery(searchText, runCfg);
    await ctx.tick(`Поиск фото: ${label}`);

    // Кэш поиска: тот же запрос уже искали для другой статьи — берём готовых кандидатов (оригинал :145-167).
    // Аудит 02, п.7.8: отбракованные чужие кандидаты в кэш не берём.
    let items: PhotoCandidateInput[] = [];
    let engine = "";
    let result: SearchResult | null = null;
    const cached = await prisma.artPhotoCandidate.findMany({
      where: { searchQuery: query, articleId: { not: article.id }, status: { not: "rejected" } },
      select: { url: true, thumbUrl: true, pageUrl: true, domain: true, title: true, width: true, height: true },
      take: limit,
    });
    if (cached.length >= Math.min(limit, 40)) {
      items = cached.map((c) => ({ source: "cache", searchQuery: query, url: c.url, thumbUrl: c.thumbUrl || null, pageUrl: c.pageUrl || null, domain: c.domain || null, title: c.title || null, width: c.width, height: c.height }));
      engine = "кэш";
      notes.push(`Кэш поиска «${query}»: ${items.length} кандидатов без запросов к API`);
    } else {
      const r = await searchImagesWithFallback(ctx.ai, query, runCfg, limit);
      result = r;
      items = r.items;
      engine = r.engine;
      if (r.error) notes.push(r.error);
    }

    // Ссылки на посты (instagram.com/p/…): Google индексирует сам пост — ищем по ссылке как по запросу (только SerpApi).
    if (queryIndex === 0) {
      for (const postUrl of runCfg.include_urls.slice(0, 10)) {
        const r = await searchSerpApi(ctx.ai, postUrl, runCfg, 15);
        items = items.concat(r.items);
        notes.push(`Пост ${postUrl}: найдено ${r.items.length}${r.error ? ` (${r.error})` : ""}`);
      }
    }

    // Фильтры, которые провайдеры не гарантируют: дубли, include/exclude доменов, размеры и ориентация (если известны).
    const rows: Prisma.ArtPhotoCandidateCreateManyInput[] = [];
    let position = 0;
    for (const it of items) {
      position++;
      if (!it.url || knownUrls.has(it.url)) continue;
      const domain = it.domain || hostOf(it.pageUrl) || hostOf(it.url) || "";
      const fromListedPost = runCfg.include_urls.some((u) => (it.pageUrl || "").toLowerCase().startsWith(u.replace(/\/+$/, "")));
      if (runCfg.include_domains.length && !fromListedPost && (!domain || !runCfg.include_domains.some((d) => domain.endsWith(d)))) continue;
      if (isBlockedDomain(domain, runCfg.exclude_domains)) continue;
      if (it.width && it.height) {
        if (it.width < runCfg.min_width || it.height < runCfg.min_height) continue;
        const ratio = it.width / it.height;
        const ok = runCfg.orientation.includes("any") || runCfg.orientation.some((o) => (o === "tall" ? ratio <= 1.05 : o === "wide" ? ratio >= 0.95 : o === "square" ? ratio >= 0.7 && ratio <= 1.4 : false));
        if (!ok) continue;
      }
      knownUrls.add(it.url);
      rows.push({
        articleId: article.id,
        url: it.url.slice(0, 2000),
        pageUrl: (it.pageUrl || "").slice(0, 2000),
        domain: domain.slice(0, 190),
        thumbUrl: (it.thumbUrl || "").slice(0, 2000),
        title: (it.title || "").slice(0, 2000),
        searchQuery: query.slice(0, 190),
        position,
        queryIndex,
        width: it.width ?? null,
        height: it.height ?? null,
        status: "found",
      });
    }
    for (let i = 0; i < rows.length; i += 200) await prisma.artPhotoCandidate.createMany({ data: rows.slice(i, i + 200) });
    candidatesTotal += rows.length;

    const c = ctx.cursor as PhotoCursor;
    const entry: SearchLogEntry = { engine: `${label} (${engine})`, query, keywordEn: englishQuery, translated, geo: runCfg.country, language: runCfg.language, freshness: runCfg.freshness, fetched: items.length, added: rows.length, error: result?.error || null, at: new Date().toISOString() };
    // Запрос, который не выполнился из-за провайдера (сбой, нет ключа/денег), не считается использованным:
    // иначе после повтора этапа он пропускается, и статья падает с «не найдено ни одного фото».
    const providerFailed = !!result && items.length === 0 && (!!result.transient || !!result.notConfigured || !!result.keyProblem);
    // Временный сбой на конкретном запросе: считаем; после QUERY_FAIL_LIMIT запрос сжигается, чтобы не упираться в него.
    const fails = { ...(c.queryFails ?? {}) };
    let burned = false;
    if (providerFailed && result?.transient && !result.keyProblem && !result.notConfigured) {
      fails[lower(englishQuery)] = (fails[lower(englishQuery)] ?? 0) + 1;
      burned = fails[lower(englishQuery)] >= QUERY_FAIL_LIMIT;
    }
    const usedQueries = providerFailed && !burned ? (c.usedQueries ?? []) : [...new Set([...(c.usedQueries ?? []), englishQuery])];
    await ctx.save({ cursor: { ...c, usedQueries, queryFails: fails, searchLog: [...(c.searchLog ?? []), entry].slice(-40) } });
    ctx.log(`${label}: «${query}» → fetched ${items.length}, added ${rows.length}${result?.error ? `, ${result.error}` : ""}`);
    return { fetched: items.length, added: rows.length, error: result?.error, notConfigured: result?.notConfigured, transient: result?.transient, keyProblem: result?.keyProblem, engine, burned };
  };

  /**
   * Поиск не выполнился из-за провайдера. Нет ключа / нет денег → статья ждёт рабочий ключ (раннер: проверка раз в
   * 10–30 мин, продолжит сама); временный сбой → повтор с растущей паузой, около часа, затем ошибка.
   * Раньше: «нет ключа» — сразу FAILED, временный сбой — повтор каждые 90 с без предела (аудит 2026-10-14).
   */
  const failureResult = (o: RunOutcome, when: string): ArtStageResult | null => {
    if (o.notConfigured) {
      throw new AiError({ code: "no_binding", kind: "fatal_run", message: `Не подключены ключи поиска картинок: нужен DataForSEO (слот «photo_dfs») или SerpAPI («photo_serp») для проекта «Статьи». ${o.error || ""}`.trim() }, 409);
    }
    if (o.keyProblem && !o.transient) {
      throw new AiError({ code: "no_credits", kind: "fatal_run", message: `Поиск картинок: ${o.keyProblem}` }, 402);
    }
    if (o.transient) return { retryInMs: 90_000, retryKind: "transient", summary: `${when}: поиск картинок временно недоступен (${o.error || "ошибка провайдера"})`, giveUp: `Поиск картинок недоступен около часа: ${o.error || "ошибка провайдера"}` };
    return null;
  };

  // ── Режим добора ──
  if (cur.topup) {
    const topup = cur.topup;
    const used = new Set((cur.usedQueries ?? []).map(lower));
    const queue = [...(cur.searchQueries?.primary ?? []), ...(cur.searchQueries?.secondary ?? [])];
    const nextQuery = queue.find((q) => !used.has(lower(q)));
    const topups = cur.topups ?? 0;
    const limit = Math.max(40, needed * 4); // оригинал: stage-photo-filter/index.ts:276

    let outcome: RunOutcome | null = null;
    let label = "";
    const unusedQuery = () => { const u = new Set(((ctx.cursor as PhotoCursor).usedQueries ?? []).map(lower)); return queue.find((x) => !u.has(lower(x))); };
    let burnedAll = false;
    if (topups < PHOTO_LOOPS.maxTopups && nextQuery) {
      // Запрос «сгорел» (повторный временный сбой) — сразу следующий из очереди, без паузы; не больше 3 за проход.
      let q: string | undefined = nextQuery;
      for (let attempt = 0; q && attempt < 3; attempt++) {
        const idx = queue.indexOf(q) + 1;
        label = `добор ${topups + 1} (${idx <= (cur.searchQueries?.primary.length ?? 0) ? "primary" : "secondary"})`;
        outcome = await runQuery(q, limit, idx, cfg, label);
        if (!outcome.burned || outcome.added > 0) break;
        q = unusedQuery();
      }
      if (outcome?.burned && outcome.added === 0) {
        outcome = null;
        burnedAll = true;
        // Остались несожжённые запросы — короткая пауза и следующий проход, а не «добор исчерпан».
        if (unusedQuery()) return { retryInMs: 10_000, retryKind: "planned", summary: `${label}: запросы не выполнились у поисковика, пробуем следующие` };
      }
    }
    if (!outcome && (burnedAll || !nextQuery) && topups < PHOTO_LOOPS.maxTopups && !cur.geoTopupDone) {
      // Запасной добор: просто ключ статьи в соседнем гео (короткий запрос без ИИ-формулировок).
      const geo = nextGeo(cfg.country, cur.usedGeos ?? []);
      if (geo) {
        label = `добор ${topups + 1} (гео ${geo})`;
        outcome = await runQuery(searchKeyword, limit, 99, { ...cfg, country: geo }, label);
        const c = ctx.cursor as PhotoCursor;
        await ctx.save({ cursor: { ...c, usedGeos: [...(c.usedGeos ?? []), geo], geoTopupDone: true } });
      } else {
        await ctx.save({ cursor: { ...(ctx.cursor as PhotoCursor), geoTopupDone: true } });
      }
    }

    if (!outcome) {
      // Запросы кончились или доборов было достаточно — ждём человека.
      const c = ctx.cursor as PhotoCursor;
      await ctx.save({ cursor: { ...c, topup: null } });
      const photos = await prisma.artPhoto.count({ where: { articleId: article.id, excluded: false } });
      const note = `Добор фото исчерпан (${topups} доборов, запрос от «${topup.from}»: ${topup.reason}). ${photos ? `Отобрано ${photos} фото — нужно решение модератора.` : "Подходящих фото не хватает."}`;
      return { summary: note, next: { wait: article.photoReview && photos > 0 ? "PHOTO_REVIEW" : "WAITING_FOR_PHOTOS", note } };
    }

    const fail = outcome.added === 0 ? failureResult(outcome, label) : null;
    if (fail) return fail;
    const c = ctx.cursor as PhotoCursor;
    await ctx.save({ cursor: { ...c, topups: topups + 1, topup: null } });
    return {
      summary: `${label}: +${outcome.added} кандидатов (всего ${candidatesTotal}); запрос от «${topup.from}», нужно ещё ${topup.needed}`,
      details: { topup, fetched: outcome.fetched, added: outcome.added, engine: outcome.engine, notes },
    };
  }

  // ── Основной поиск: ключ статьи, затем primary-варианты, пока кандидатов меньше резерва ──
  const used = new Set((cur.usedQueries ?? []).map(lower));
  const plan = [searchKeyword, ...(cur.searchQueries?.primary ?? [])].filter((q, i, arr) => arr.findIndex((x) => lower(x) === lower(q)) === i);
  let lastOutcome: RunOutcome | null = null;
  let ran = 0;
  for (let i = 0; i < plan.length; i++) {
    if (candidatesTotal >= reserveTarget) break;
    const q = plan[i];
    if (used.has(lower(q))) continue;
    const limit = i === 0 ? Math.max(20, cfg.candidates_total) : Math.max(40, needed * 4);
    const label = i === 0 ? "основной запрос" : `primary ${i}`;
    lastOutcome = await runQuery(q, limit, i, cfg, label);
    ran++;
    if (lastOutcome.notConfigured || (lastOutcome.keyProblem && lastOutcome.fetched === 0)) break;
    if (lastOutcome.transient && lastOutcome.fetched === 0 && candidatesTotal === 0) break;
  }

  if (candidatesTotal === 0) {
    const fail = lastOutcome ? failureResult(lastOutcome, "основной поиск") : null;
    if (fail) return fail;
    return { fatal: `Не найдено ни одного фото по запросу «${searchKeyword}». ${notes.join("; ")}`.trim() };
  }

  return {
    summary: ran ? `Найдено кандидатов: ${candidatesTotal} (запросов: ${ran}, цель резерва ${reserveTarget})` : `Кандидаты уже найдены (${candidatesTotal}) — продолжаем`,
    details: { candidates: candidatesTotal, reserveTarget, queries: cur.searchQueries, usedQueries: (ctx.cursor as PhotoCursor).usedQueries, notes, geo: cfg.country, language: cfg.language, freshness: cfg.freshness, sizeFilter: cfg.size_filter },
  };
};

/** Для соседних этапов: поставить запрос на добор и вернуть переход в search. */
export async function requestTopup(ctx: ArtStageCtx, req: TopupRequest): Promise<void> {
  const c = ctx.cursor as PhotoCursor;
  await ctx.save({ cursor: { ...c, topup: req } });
}
