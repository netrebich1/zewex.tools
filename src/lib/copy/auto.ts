/**
 * Article Copy, автосборка: воркер сам выбирает сайт, ядро, свободную формулировку и кадры и создаёт обычную статью
 * сервиса «Статьи» сразу на этапе «План по фото» — текст, сборку и публикацию дальше делает конвейер статей.
 *
 * Правила владельца (CopySettings): ядро, уже стоящее на сайте в любой формулировке, на него не идёт; с любой
 * существующей статьёй — не больше maxOverlapPct общих кадров; одно фото на сайте — не больше maxPerSite раз;
 * резерв (оценка ИИ от minReserveScore) — доля reservePct, он хранится ссылкой на источник и скачивается при сборке:
 * что не скачалось, заменяется следующим кадром. Меньше minPhotos кадров — ядро пропускается.
 * Таблицы статей только читаются, новая статья и её фото создаются одной транзакцией.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { buildSnapshot, recipeShape } from "@/lib/articles/launch";
import { articleDir, makeThumb, photoRel, photoThumbRel, publicUrl, removePath, toWpJpeg, writeFileAtomic } from "@/lib/articles/storage";
import { downloadImage } from "@/lib/articles/photo/download";
import { getNicheProfile, specializeProfile } from "@/lib/articles/photo/profile";
import { parseKeywordAttributes } from "@/lib/articles/photo/keyword";
import { buildFashionContract, buildInteriorContract, buildTopicContract, isInteriorNiche } from "@/lib/articles/photo/contracts";
import { audienceFacts } from "@/lib/articles/photo/audience";
import { fallbackTrendBrief } from "@/lib/articles/photo/queries";
import { buildCaption } from "@/lib/articles/photo/caption";
import { recordPhotoFingerprints } from "@/lib/articles/photo/fingerprints";
import { mergeSiteSettings, type ArtRunSettings, type PhotoSearchConfig } from "@/lib/articles/types";
import { loadTeamAutostart, teamAutostart } from "@/lib/articles/teamQueue";
import type { CopySettings } from "@prisma/client";
import { copySettings, type CoreForm } from "./build";
import { SHARED_TEAM, clusterWords, groupOf, pickModifier, splitKeyword, swapModifier } from "./keys";

const SKIP_MS = 6 * 60 * 60_000;
const MAX_PER_TICK = 2;
const CORES_PER_SITE_TRY = 4;
const BATCH = 6;
const MIN_SIDE = 400;
/** Ядра, из которых недавно не получилось собрать статью (в памяти воркера): team|niche|core → когда пробовать снова. */
const skipped = new Map<string, number>();
/** Сайты, которым в прошлый проход ничего не собралось: siteId → когда пробовать снова (30 минут). */
const siteWait = new Map<string, number>();
let running = false;

type Site = { id: string; teamId: string; name: string; nicheCode: string | null };
type Cand = {
  sha: string; phash: string | null; kind: "pub" | "res"; donorId: string; urls: string[]; used: number; score: number;
  sourceUrl: string; sourcePageUrl: string; sourceDomain: string; altText: string; caption: string | null;
  facts: unknown; description: string | null;
};
type Stored = { c: Cand; photoId: string; path: string; thumbPath: string; width: number | null; height: number | null };

export type CopyPlanResult =
  | { ok: true; articleId: string | null; keyword: string; core: string; niche: string; modifier: string; site: string; photos: number; fromReserve: number; fromPublished: number; donors: number; lost: number; /** Кадров без слова темы в описании (добраны до минимума). */ offTopic: number }
  | { ok: false; core: string; reason: string };

const yearOf = (k: string) => Math.max(0, ...(k.match(/20\d\d/g) ?? []).map(Number));
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Ниши, которые сайт реально ведёт (от 5 % его статей и не меньше 3); у пустого сайта — любые ниши его группы. */
export async function siteNiches(siteId: string): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ n: string | null; c: bigint }>>`SELECT r.nicheCode n, COUNT(*) c FROM Article a JOIN ArtRecipe r ON r.id = a.recipeId WHERE a.siteId = ${siteId} GROUP BY r.nicheCode`;
  const total = rows.reduce((s, r) => s + Number(r.c), 0);
  const out = new Map<string, number>();
  for (const r of rows) if (r.n && Number(r.c) >= Math.max(3, total * 0.05)) out.set(r.n, Number(r.c));
  return out;
}

/** Собрать одну статью по ядру для сайта. dry — без скачивания и записи (проверка подбора). */
export type BuildOpts = { dry?: boolean; review?: boolean; /** Фото в статье вместо правила по умолчанию. */ photos?: number; /** Партия, в которой собирается статья, и имя её запуска в «Статьях». */ batchId?: string; runName?: string; /** Год в ключе вместо года статьи-донора. */ year?: number; /** Модель писателя (секции, вступление/заключение) вместо модели сценария — A/B тесты. */ writerModel?: string };
/** Этапы, которые пишет «писатель»: их модель подменяет BuildOpts.writerModel. */
const WRITER_STAGES = ["stage_7_writer_system", "stage_7_writer_user", "stage_7_intro_outro"];
/** Слова темы для фильтра кадров: всё, кроме служебных слов ниши; «s» на конце и дефис не мешают совпадению. */
const topicRe = (core: string): RegExp | null => {
  const words = clusterWords(core).map((w) => w.replace(/s$/, "")).filter((w) => w.length > 2);
  return words.length ? new RegExp(`\\b(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i") : null;
};
/** Кадр подходит к теме: слово темы встречается в его описании, фактах, alt или подписи. */
const onTopic = (c: Cand, re: RegExp) => re.test(`${c.description ?? ""} ${c.altText} ${c.caption ?? ""} ${c.facts ? JSON.stringify(c.facts) : ""}`);

export async function buildCopyArticle(site: Site, st: CopySettings, coreRow: { niche: string; core: string; formulations: unknown }, opts: BuildOpts = {}): Promise<CopyPlanResult> {
  const { niche, core } = coreRow;
  const fail = (reason: string): CopyPlanResult => ({ ok: false, core, reason });

  // ── Свежий срез ядра: карта CopyCore может отставать на часы ──
  const formIds = ((coreRow.formulations as CoreForm[] | null) ?? []).map((f) => f.a);
  const all = (await prisma.article.findMany({
    where: { OR: [{ id: { in: formIds } }, { keyword: { contains: core } }] },
    select: { id: true, teamId: true, siteId: true, keyword: true, wpUrl: true, publishedAt: true, recipeId: true, createdById: true, recipeRef: { select: { nicheCode: true } }, site: { select: { nicheCode: true } } },
  })).filter((a) => splitKeyword(a.keyword).core === core && (a.recipeRef?.nicheCode || a.site.nicheCode || "other") === niche);
  if (all.some((a) => a.siteId === site.id)) return fail("тема уже есть на сайте");
  const [mashups, notDonorRows] = await Promise.all([
    prisma.copyArticle.findMany({ where: { articleId: { in: all.map((a) => a.id) } }, select: { articleId: true } }),
    prisma.copySite.findMany({ where: { donor: false }, select: { artSiteId: true } }),
  ]);
  const mashupIds = new Set(mashups.map((m) => m.articleId));
  const notDonor = new Set(notDonorRows.map((r) => r.artSiteId));
  const donors = all.filter((a) => a.publishedAt && a.wpUrl && !mashupIds.has(a.id) && !notDonor.has(a.siteId) && (st.sharedBank || a.teamId === site.teamId)).sort((a, b) => yearOf(b.keyword) - yearOf(a.keyword) || b.publishedAt!.getTime() - a.publishedAt!.getTime());
  if (!donors.length) return fail("нет опубликованных статей по ядру");

  // ── Формулировка и ключ ──
  const used = new Set(all.map((a) => splitKeyword(a.keyword).modifier));
  const haveKeywords = new Set(all.map((a) => a.keyword.toLowerCase()));
  let modifier: string | null = null;
  let keyword = "";
  for (;;) {
    modifier = pickModifier(used);
    if (modifier === null) return fail("свободных формулировок не осталось");
    keyword = swapModifier(donors[0].keyword, modifier);
    // Год — всегда в конце ключа («Haircuts 2026 for Older Women» → «Haircuts for Older Women 2027»).
    if (opts.year) keyword = `${keyword.replace(/\s*20\d\d(-20\d\d)?\s*/g, " ").replace(/\s+/g, " ").trim()} ${opts.year}`;
    if (!haveKeywords.has(keyword.toLowerCase()) && splitKeyword(keyword).core === core) break;
    used.add(modifier);
  }

  // ── Сценарий и автор: как у статьи-донора (ключи ИИ — той же команды) ──
  const recipeIds = [...new Set(donors.filter((d) => d.teamId === site.teamId).map((d) => d.recipeId).filter((x): x is string => !!x))];
  // Сценарий мешапа этой ниши (свои промпты, forCopy) — если есть; иначе сценарий статьи-донора.
  const recipes = await prisma.artRecipe.findMany({ where: { id: { in: recipeIds }, isActive: true, format: "REAL_PHOTO" } });
  let recipeRow = (await prisma.artRecipe.findFirst({ where: { forCopy: true, nicheCode: niche, isActive: true, format: "REAL_PHOTO" } }))
    ?? recipeIds.map((id) => recipes.find((r) => r.id === id)).find(Boolean) ?? null;
  if (!recipeRow) {
    const mine = await prisma.article.findFirst({ where: { teamId: site.teamId, recipeRef: { nicheCode: niche, isActive: true, format: "REAL_PHOTO" } }, orderBy: { createdAt: "desc" }, select: { recipeRef: true } });
    recipeRow = mine?.recipeRef ?? null;
  }
  if (!recipeRow) return fail("нет включённого сценария этой ниши");
  const createdById = donors.find((d) => d.teamId === site.teamId && d.createdById)?.createdById
    ?? (await prisma.article.findFirst({ where: { siteId: site.id, createdById: { not: null } }, orderBy: { createdAt: "desc" }, select: { createdById: true } }))?.createdById
    ?? (await prisma.copySite.findUnique({ where: { artSiteId: site.id }, select: { createdById: true } }))?.createdById;
  if (!createdById) return fail("не найден автор для ключей ИИ");

  // ── Кадры доноров ──
  const donorIds = donors.map((d) => d.id);
  const [pub, excluded, res] = await Promise.all([
    prisma.artPhoto.findMany({ where: { articleId: { in: donorIds }, excluded: false, sha256: { not: null }, wpUrl: { not: null } }, select: { articleId: true, sha256: true, phash: true, wpUrl: true, sourceUrl: true, sourcePageUrl: true, sourceDomain: true, altText: true, caption: true, facts: true, description: true, aiScore: true } }),
    prisma.artPhoto.findMany({ where: { articleId: { in: donorIds }, excluded: true, sha256: { not: null } }, select: { sha256: true } }),
    prisma.artPhotoCandidate.findMany({ where: { articleId: { in: donorIds }, status: { in: ["reserve", "keep"] }, sha256: { not: null }, aiScore: { gte: st.minReserveScore } }, orderBy: { aiScore: "desc" }, take: 3000, select: { articleId: true, sha256: true, phash: true, url: true, pageUrl: true, domain: true, title: true, aiFacts: true, aiDescription: true, aiScore: true } }),
  ]);
  const bad = new Set(excluded.map((e) => e.sha256!));
  const bySha = new Map<string, Cand>();
  for (const p of pub) {
    if (bad.has(p.sha256!) || bySha.has(p.sha256!)) continue;
    bySha.set(p.sha256!, { sha: p.sha256!, phash: p.phash, kind: "pub", donorId: p.articleId, urls: [p.wpUrl!, p.sourceUrl], used: 0, score: p.aiScore ?? 0, sourceUrl: p.sourceUrl, sourcePageUrl: p.sourcePageUrl, sourceDomain: p.sourceDomain, altText: p.altText, caption: p.caption, facts: p.facts, description: p.description });
  }
  for (const c of res) {
    if (bad.has(c.sha256!) || bySha.has(c.sha256!)) continue;
    bySha.set(c.sha256!, { sha: c.sha256!, phash: c.phash, kind: "res", donorId: c.articleId, urls: [c.url], used: 0, score: c.aiScore ?? 0, sourceUrl: c.url.slice(0, 2000), sourcePageUrl: (c.pageUrl || "").slice(0, 2000), sourceDomain: c.domain || "", altText: c.title || "", caption: null, facts: c.aiFacts, description: c.aiDescription });
  }

  // ── Где эти кадры уже стоят: любые статьи (и прошлые мешапы), отдельно — на целевом сайте ──
  const articlesOf = new Map<string, Set<string>>();
  const onSite = new Map<string, number>();
  const shas = [...bySha.keys()];
  for (let i = 0; i < shas.length; i += 500) {
    const rows = await prisma.artPhoto.findMany({ where: { sha256: { in: shas.slice(i, i + 500) }, excluded: false }, select: { sha256: true, articleId: true, article: { select: { siteId: true } } } });
    for (const r of rows) {
      let s = articlesOf.get(r.sha256!);
      if (!s) articlesOf.set(r.sha256!, (s = new Set()));
      s.add(r.articleId);
      if (r.article.siteId === site.id) onSite.set(r.sha256!, (onSite.get(r.sha256!) ?? 0) + 1);
    }
  }
  for (const c of bySha.values()) c.used = articlesOf.get(c.sha)?.size ?? 0;

  // ── Очереди: резерв — сначала нигде не стоявший и лучше оценённый; опубликованные — по кругу между донорами ──
  const order = (a: Cand, b: Cand) => a.used - b.used || b.score - a.score;
  const resQ = [...bySha.values()].filter((c) => c.kind === "res").sort(order);
  const byDonor = new Map<string, Cand[]>();
  for (const c of [...bySha.values()].filter((x) => x.kind === "pub").sort(order)) byDonor.set(c.donorId, [...(byDonor.get(c.donorId) ?? []), c]);
  const pubQ: Cand[] = [];
  const lists = shuffle([...byDonor.values()]);
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) pubQ.push(l[i]);

  const n = Math.max(1, opts.photos ?? st.photosPerArticle);
  const cap = Math.max(1, Math.floor((n * st.maxOverlapPct) / 100));
  const perArticle = new Map<string, number>();
  const taken = new Set<string>();
  const phashes = new Set<string>();
  // Лимит на тему: сколько статей этого ядра уже содержат кадр (исходная считается).
  const coreIds = new Set(all.map((a) => a.id));
  const usedInCore = (c: Cand) => { let n = 0; for (const a of articlesOf.get(c.sha) ?? []) if (coreIds.has(a)) n++; return n; };
  const canTake = (c: Cand) => !taken.has(c.sha) && !(c.phash && phashes.has(c.phash)) && (onSite.get(c.sha) ?? 0) < st.maxPerSite && c.used < st.maxUsesTotal && usedInCore(c) < st.maxUsesPerCore && [...(articlesOf.get(c.sha) ?? [])].every((a) => (perArticle.get(a) ?? 0) < cap);
  const mark = (c: Cand, d: 1 | -1) => {
    if (d > 0) { taken.add(c.sha); if (c.phash) phashes.add(c.phash); } else { if (c.phash) phashes.delete(c.phash); }
    for (const a of articlesOf.get(c.sha) ?? []) perArticle.set(a, (perArticle.get(a) ?? 0) + d);
  };

  const articleId = randomUUID();
  const picked: Stored[] = [];
  let lost = 0;
  const store = async (c: Cand): Promise<Stored | null> => {
    const photoId = randomUUID();
    if (opts.dry) return { c, photoId, path: "", thumbPath: "", width: null, height: null };
    try {
      const d = await downloadImage(c.urls);
      if (!d.ok) return null;
      const jpeg = await toWpJpeg(d.bytes);
      if (Math.min(jpeg.width, jpeg.height) < MIN_SIDE) return null;
      const path = photoRel(articleId, photoId);
      const thumbPath = photoThumbRel(articleId, photoId);
      await writeFileAtomic(path, jpeg.bytes);
      await writeFileAtomic(thumbPath, await makeThumb(jpeg.bytes));
      return { c, photoId, path, thumbPath, width: jpeg.width, height: jpeg.height };
    } catch {
      return null;
    }
  };
  const cursor = new Map<Cand[], number>();
  const fill = async (queue: Cand[], want: number) => {
    let i = cursor.get(queue) ?? 0;
    while (picked.length < want && i < queue.length) {
      const batch: Cand[] = [];
      while (batch.length < Math.min(BATCH, want - picked.length) && i < queue.length) {
        const c = queue[i++];
        if (canTake(c)) { mark(c, 1); batch.push(c); }
      }
      if (!batch.length) break;
      const got = await Promise.all(batch.map(store));
      got.forEach((g, k) => { if (g) picked.push(g); else { mark(batch[k], -1); lost++; } });
    }
    cursor.set(queue, i);
  };
  // Мягкий фильтр по теме (аудит 07.11: в «balayage hair» попали кудри без балаяжа): сначала кадры, в описании которых
  // есть слово темы; остальными добираем только до минимума статьи.
  const re = topicRe(core);
  const [resOn, resOff] = re ? [resQ.filter((c) => onTopic(c, re)), resQ.filter((c) => !onTopic(c, re))] : [resQ, []];
  const [pubOn, pubOff] = re ? [pubQ.filter((c) => onTopic(c, re)), pubQ.filter((c) => !onTopic(c, re))] : [pubQ, []];
  await fill(resOn, Math.round((n * st.reservePct) / 100));
  await fill(pubOn, n);
  await fill(resOn, n);
  const onTopicCount = picked.length;
  if (picked.length < Math.min(n, st.minPhotos)) {
    await fill(pubOff, Math.min(n, st.minPhotos));
    await fill(resOff, Math.min(n, st.minPhotos));
  }
  const offTopic = picked.length - onTopicCount;

  const fromReserve = picked.filter((p) => p.c.kind === "res").length;
  const usedDonors = new Set(picked.map((p) => p.c.donorId)).size;
  if (picked.length < Math.min(n, st.minPhotos)) {
    if (!opts.dry) await removePath(articleDir(articleId)).catch(() => {});
    return fail(`набралось ${picked.length} кадров из ${n} (минимум ${st.minPhotos}; не скачалось ${lost})`);
  }
  const summary = { keyword, core, niche, modifier, site: site.name, photos: picked.length, fromReserve, fromPublished: picked.length - fromReserve, donors: usedDonors, lost, offTopic };
  if (opts.dry) return { ok: true, articleId: null, ...summary };

  // ── Статья: снимок сценария, факты темы без вызова ИИ, старт с этапа «План по фото» ──
  const shape = recipeShape(recipeRow);
  const review = opts.review ?? st.reviewBeforePublish;
  const runSettings: ArtRunSettings = { recipeId: shape.id, photoCount: { mode: "exact", min: picked.length, max: picked.length }, photoReview: false, publishMode: "auto", search: { country: "", language: "", freshness: "" }, yearInUrlPercent: null, testLabel: "" };
  const snapshot = buildSnapshot(shape, runSettings);
  if (opts.writerModel) snapshot.stageModels = { ...snapshot.stageModels, ...Object.fromEntries(WRITER_STAGES.map((k) => [k, opts.writerModel!])) };
  const profile = specializeProfile(await getNicheProfile(shape.nicheCode, shape.subnicheCode), keyword);
  const attrs = parseKeywordAttributes(keyword, profile) as Record<string, unknown>;
  const donorFacts = ((await prisma.article.findUnique({ where: { id: donors[0].id }, select: { facts: true } }))?.facts ?? {}) as Record<string, unknown>;
  const trend = donorFacts.trendBrief ?? (() => { const t = fallbackTrendBrief(shape.nicheCode, keyword); return t ? { ...t, source: "fallback" } : undefined; })();
  const facts = clean({
    keywordAttributes: attrs,
    topicContract: buildTopicContract(profile, attrs, keyword),
    fashionContract: profile.niche_code === "outfits" ? buildFashionContract(keyword, attrs) : undefined,
    interiorContract: isInteriorNiche(profile.niche_code, shape.subnicheCode) ? buildInteriorContract(keyword, attrs) : undefined,
    audience: audienceFacts(keyword, shape.nicheCode),
    trendBrief: trend,
  });
  const cfg = (shape.photoSearch ?? {}) as PhotoSearchConfig;
  const uniqueMode = cfg.uniqueMode === "strict" || cfg.uniqueMode === "off" ? cfg.uniqueMode : "soft";

  const day = new Date().toLocaleDateString("ru-RU");
  const runName = opts.runName ?? `Article Copy · ${day}`;
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const run = (await prisma.artRun.findFirst({ where: { siteId: site.id, name: runName, createdAt: { gte: since } }, select: { id: true } }))
    ?? (await prisma.artRun.create({ data: { teamId: site.teamId, siteId: site.id, recipeId: shape.id, createdById, name: runName, settings: runSettings as unknown as Prisma.InputJsonValue }, select: { id: true } }));

  const rows: Prisma.ArtPhotoCreateManyInput[] = shuffle(picked).map((s, i) => ({
    id: s.photoId, articleId, candidateId: null, position: i + 1, path: s.path, thumbPath: s.thumbPath, publicUrl: publicUrl(s.path),
    sourceUrl: s.c.sourceUrl, sourcePageUrl: s.c.sourcePageUrl, sourceDomain: s.c.sourceDomain, width: s.width, height: s.height, sha256: s.c.sha, phash: s.c.phash,
    altText: s.c.altText, caption: s.c.caption ?? buildCaption(cfg, s.c.sourceDomain || null, s.c.sourcePageUrl || null) ?? "",
    // Описание и факты донора не переносим: аудит 07.11 показал, что часть описаний в банке относится к другим кадрам.
    // Этап плана опишет каждый файл заново (describeLatePhotos, по одному кадру), ~$0.01 на статью.
    fileName: `${i + 1}-${s.c.sha.slice(0, 12)}.jpg`, facts: Prisma.DbNull, description: null, aiScore: s.c.score || null,
  }));
  try {
    await prisma.$transaction([
      prisma.article.create({
        data: {
          id: articleId, teamId: site.teamId, siteId: site.id, runId: run.id, recipeId: shape.id, createdById, keyword, format: "REAL_PHOTO", photoCount: picked.length,
          photoReview: false, publishMode: "auto", recipe: snapshot as unknown as Prisma.InputJsonValue, status: "PENDING", stage: "plan",
          cursor: { ...(review ? {} : { reviewApproved: true }), copy: { core, modifier, donors: [...new Set(picked.map((p) => p.c.donorId))] } } as Prisma.InputJsonValue,
          facts: facts as unknown as Prisma.InputJsonValue, note: "Article Copy: собрана из готовых фото",
        },
      }),
      prisma.artPhoto.createMany({ data: rows }),
      prisma.copyArticle.create({ data: { articleId, teamId: site.teamId, siteId: site.id, niche, core, modifier, keyword, photos: picked.length, fromReserve, fromPublished: picked.length - fromReserve, donors: usedDonors, lost, batchId: opts.batchId ?? null } }),
    ]);
  } catch (e) {
    await removePath(articleDir(articleId)).catch(() => {});
    throw e;
  }
  await recordPhotoFingerprints({ teamId: site.teamId, siteId: site.id, articleId, uniqueMode, rows: picked.map((p) => ({ sha256: p.c.sha, phash: p.c.phash, sourceUrl: p.c.sourceUrl })) }).catch(() => 0);
  return { ok: true, articleId, ...summary };
}

/** Выбрать ядро для сайта и собрать статью: пробует несколько ядер, неудачные откладывает на 6 часов. */
export async function buildForSite(site: Site, st: CopySettings, opts: { dry?: boolean; review?: boolean; core?: string } = {}): Promise<{ result: CopyPlanResult | null; tried: CopyPlanResult[] }> {
  const niches = await siteNiches(site.id);
  // Пустой сайт без указанной ниши: неизвестно, женский он или интерьерный — автоматически на него не ставим.
  if (!site.nicheCode && !niches.size) return { result: null, tried: [{ ok: false, core: "—", reason: "у сайта нет статей и не указана ниша — неизвестно, какие темы ему подходят" }] };
  const grp = groupOf(site.nicheCode ?? [...niches.keys()][0]);
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [cores, recent] = await Promise.all([
    prisma.copyCore.findMany({ where: { teamId: st.sharedBank ? SHARED_TEAM : site.teamId, grp, byPhotos: { gt: 0 }, ...(opts.core ? { core: opts.core } : {}) }, orderBy: [{ photosReserve: "desc" }, { photosPublished: "desc" }], take: 500, select: { niche: true, core: true, siteIds: true, formulations: true } }),
    prisma.copyArticle.findMany({ where: { ...(st.sharedBank ? {} : { teamId: site.teamId }), createdAt: { gte: since } }, select: { niche: true, core: true } }),
  ]);
  const recentSet = new Set(recent.map((r) => `${r.niche}|${r.core}`));
  const now = Date.now();
  // Ядро из одного слова («outfits», «style») — не тема: у таких статей темой была сама приставка, их не смешиваем.
  const fit = cores.filter((c) => (opts.core || c.core.includes(" ")) && !((c.siteIds as string[] | null) ?? []).includes(site.id) && (!niches.size || niches.has(c.niche)) && (opts.core || (!recentSet.has(`${c.niche}|${c.core}`) && (skipped.get(`${site.teamId}|${c.niche}|${c.core}`) ?? 0) < now)));
  // Ниша — случайно, пропорционально тому, сколько сайт о ней пишет; внутри ниши — ядра с самым большим запасом.
  const nicheList = [...new Set(fit.map((c) => c.niche))];
  const weight = (x: string) => niches.get(x) ?? 1;
  let roll = Math.random() * nicheList.reduce((s, x) => s + weight(x), 0);
  const first = nicheList.find((x) => (roll -= weight(x)) <= 0) ?? nicheList[0];
  const ordered = [...fit.filter((c) => c.niche === first), ...fit.filter((c) => c.niche !== first)];
  const tried: CopyPlanResult[] = [];
  for (const c of ordered.slice(0, CORES_PER_SITE_TRY)) {
    const r = await buildCopyArticle(site, st, c, opts);
    tried.push(r);
    if (r.ok) return { result: r, tried };
    if (!opts.dry) skipped.set(`${site.teamId}|${c.niche}|${c.core}`, now + SKIP_MS);
  }
  return { result: null, tried };
}

/** Привязанные сайты: сколько статей каждому собрано сегодня, включено ли написание и сколько собранных ещё не дописано. */
export async function copySitesToday(): Promise<Array<Site & { today: number; writingOn: boolean; backlog: number }>> {
  const bound = await prisma.copySite.findMany({ where: { publish: true }, select: { artSiteId: true } });
  if (!bound.length) return [];
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const [sites, counts, waiting, g, teams] = await Promise.all([
    prisma.artSite.findMany({ where: { id: { in: bound.map((b) => b.artSiteId) }, isActive: true }, select: { id: true, teamId: true, name: true, nicheCode: true, settings: true } }),
    prisma.copyArticle.groupBy({ by: ["siteId"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ siteId: string; c: bigint }>>`SELECT c.siteId, COUNT(*) c FROM CopyArticle c JOIN Article a ON a.id = c.articleId WHERE a.status IN ('PENDING','RUNNING') GROUP BY c.siteId`,
    prisma.artSettings.findUnique({ where: { id: "main" }, select: { writingMaster: true } }),
    loadTeamAutostart(prisma),
  ]);
  const by = new Map(counts.map((c) => [c.siteId, c._count._all]));
  const wait = new Map(waiting.map((w) => [w.siteId, Number(w.c)]));
  return sites.map(({ settings, ...s }) => ({
    ...s,
    today: by.get(s.id) ?? 0,
    // Те же выключатели, что смотрит очередь статей (worker/articles/queue.ts): система, команда, сайт.
    writingOn: (g?.writingMaster ?? true) && teamAutostart(teams, s.teamId).writingMaster && mergeSiteSettings(settings).autostart.writingEnabled,
    backlog: wait.get(s.id) ?? 0,
  }));
}

/** Тик воркера (раз в минуту): до двух статей за проход, сайтам с меньшим числом сегодняшних статей — раньше. */
export async function copyAutoTick(): Promise<{ created: number; note: string }> {
  if (running) return { created: 0, note: "" };
  const st = await copySettings();
  if (!st.autoEnabled || !st.builtAt) return { created: 0, note: "" };
  running = true;
  try {
    const all = await copySitesToday();
    const notes: string[] = [];
    // Написание выключено или собранные не дописываются — новые не собираем, чтобы статьи не копились молча.
    const maxBacklog = Math.max(4, st.dailyPerSite * 2);
    for (const s of all) {
      if (!s.writingOn) notes.push(`${s.name}: написание выключено (сайт, команда или общий выключатель в «Статьях») — не собираем`);
      else if (s.backlog >= maxBacklog) notes.push(`${s.name}: ${s.backlog} собранных статей ещё не дописаны — новые ждут`);
    }
    const sites = all.filter((s) => s.writingOn && s.backlog < maxBacklog && s.today < st.dailyPerSite && (siteWait.get(s.id) ?? 0) < Date.now()).sort((a, b) => a.today - b.today);
    let created = 0;
    for (const s of sites) {
      if (created >= MAX_PER_TICK) break;
      const { result, tried } = await buildForSite(s, st);
      if (result?.ok) { created++; notes.push(`${s.name}: «${result.keyword}» — ${result.photos} фото (резерв ${result.fromReserve}, не скачалось ${result.lost})`); }
      else siteWait.set(s.id, Date.now() + 30 * 60_000);
      if (!result?.ok) notes.push(`${s.name}: ${tried.length ? tried.map((t) => (t.ok ? "" : `${t.core} — ${t.reason}`)).join("; ") : "подходящих ядер нет"}`);
    }
    const note = notes.join("\n").slice(0, 4000);
    if (sites.length || note !== (st.autoNote ?? "")) await prisma.copySettings.update({ where: { id: "main" }, data: { autoAt: new Date(), autoNote: note } });
    return { created, note };
  } finally {
    running = false;
  }
}
