/**
 * Уникальность фото между сайтами (оригинал: таблица photo_usage_fingerprints, stage-photo-select/index.ts:386-445, :723-779).
 * Отпечатки выбранных фото пишутся в `ArtPhotoFingerprint` (sha256 + phash + sourceUrl) и живут 30 дней
 * (оригинал: cleanup_photo_data). При отборе кадр считается использованным, если совпал sha256/URL файла
 * (любая статья команды) или phash на расстоянии ≤10 среди статей с тем же ключом (оригинал: keyword_norm).
 * Режим `recipe.photoSearch.uniqueMode`: strict — только свежие; soft — свежие, затем повторы с других сайтов,
 * затем повторы с этого же сайта; off — отпечатки не пишутся, порядок как в soft.
 */
import { prisma } from "@/lib/db";
import { phashDistance } from "@/lib/articles/photo/vision";

/** насколько близкими могут быть отпечатки двух кадров (оригинал: stage-photo-select:30) */
export const NEAR_DUPLICATE_DISTANCE = 10;
/** срок жизни отпечатка (оригинал: cleanup_photo_data — 30 дней) */
export const FINGERPRINT_TTL_DAYS = 30;
/** сколько phash-строк по ключу сравниваем (оригинал: :403 limit 2000) */
const PHASH_LOOKUP_LIMIT = 2000;

export type UniqueMode = "soft" | "strict" | "off";

export type PhotoUsage = {
  usedCount: number;
  /** ISO-дата самого раннего использования ("" — не использован) */
  usedOldest: string;
  sameSite: boolean;
};

/** оригинал: photoSearch.ts:629-631 */
export function normalizeKeyword(kw?: string | null): string {
  return String(kw || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function cutoffDate(): Date {
  return new Date(Date.now() - FINGERPRINT_TTL_DAYS * 86_400_000);
}

export type UsageCandidate = { id: string; sha256?: string | null; phash?: string | null; url?: string | null };

/**
 * Сколько раз и где уже использованы кандидаты (оригинал: stage-photo-select:386-445).
 * Точные совпадения — по sha256 и URL файла среди всех статей команды; «тот же кадр в другом размере» —
 * по phash среди статей с тем же ключом (keyword / focusKeyword), не старше 30 дней.
 */
export async function loadPhotoUsage(opts: {
  teamId: string;
  siteId: string;
  articleId: string;
  keywords: string[];
  candidates: UsageCandidate[];
}): Promise<Map<string, PhotoUsage>> {
  const since = cutoffDate();
  const notThisArticle = { OR: [{ articleId: null }, { articleId: { not: opts.articleId } }] };
  const shas = [...new Set(opts.candidates.map((c) => c.sha256).filter((v): v is string => !!v))];
  const urls = [...new Set(opts.candidates.map((c) => c.url).filter((v): v is string => !!v))];

  const exactRows = shas.length || urls.length
    ? await prisma.artPhotoFingerprint.findMany({
        where: {
          teamId: opts.teamId,
          createdAt: { gte: since },
          AND: [notThisArticle, { OR: [...(shas.length ? [{ sha256: { in: shas } }] : []), ...(urls.length ? [{ sourceUrl: { in: urls } }] : [])] }],
        },
        select: { sha256: true, sourceUrl: true, phash: true, siteId: true, createdAt: true },
      })
    : [];

  // Статьи команды с тем же ключом → их phash (оригинал: keyword_norm).
  const kws = [...new Set(opts.keywords.map(normalizeKeyword).filter(Boolean))];
  const sameKeyword = kws.length
    ? await prisma.article.findMany({
        where: { teamId: opts.teamId, id: { not: opts.articleId }, OR: [{ keyword: { in: kws } }, { focusKeyword: { in: kws } }] },
        select: { id: true },
      })
    : [];
  const byKeyword = sameKeyword.length
    ? await prisma.artPhotoFingerprint.findMany({
        where: { articleId: { in: sameKeyword.map((a) => a.id) }, phash: { not: null }, createdAt: { gte: since } },
        select: { sha256: true, phash: true, siteId: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: PHASH_LOOKUP_LIMIT,
      })
    : [];

  type Agg = { count: number; oldest: Date; sameSite: boolean };
  const bySha = new Map<string, Agg>();
  const byUrl = new Map<string, Agg>();
  const bump = (map: Map<string, Agg>, key: string, row: { createdAt: Date; siteId: string }) => {
    const cur = map.get(key) || { count: 0, oldest: row.createdAt, sameSite: false };
    cur.count++;
    if (row.createdAt < cur.oldest) cur.oldest = row.createdAt;
    if (row.siteId === opts.siteId) cur.sameSite = true;
    map.set(key, cur);
  };
  for (const r of exactRows) {
    if (r.sha256) bump(bySha, r.sha256, r);
    if (r.sourceUrl) bump(byUrl, r.sourceUrl, r);
  }
  const exactShas = new Set(exactRows.map((r) => r.sha256).filter(Boolean));
  const priorPhashes = byKeyword
    .filter((r) => r.phash && !(r.sha256 && exactShas.has(r.sha256)))
    .map((r) => ({ phash: r.phash as string, createdAt: r.createdAt, siteId: r.siteId }));

  const out = new Map<string, PhotoUsage>();
  for (const c of opts.candidates) {
    const u = (c.sha256 && bySha.get(c.sha256)) || (c.url && byUrl.get(c.url)) || null;
    let usedCount = u?.count || 0;
    let oldest: Date | null = u?.oldest ?? null;
    let sameSite = u?.sameSite || false;
    if (c.phash) {
      for (const prior of priorPhashes) {
        if (phashDistance(prior.phash, c.phash) <= NEAR_DUPLICATE_DISTANCE) {
          usedCount++;
          if (!oldest || prior.createdAt < oldest) oldest = prior.createdAt;
          if (prior.siteId === opts.siteId) sameSite = true;
        }
      }
    }
    out.set(c.id, { usedCount, usedOldest: oldest ? oldest.toISOString() : "", sameSite });
  }
  return out;
}

export type FingerprintRow = { sha256?: string | null; phash?: string | null; sourceUrl?: string | null };

/**
 * Записать отпечатки выбранных фото статьи. Повтор этапа не должен плодить дубли (оригинал: :772-779 —
 * DELETE по проекту, затем INSERT). При uniqueMode = off ничего не пишем (оригинал: :723).
 */
export async function recordPhotoFingerprints(opts: { teamId: string; siteId: string; articleId: string; uniqueMode: UniqueMode; rows: FingerprintRow[] }): Promise<number> {
  await prisma.artPhotoFingerprint.deleteMany({ where: { articleId: opts.articleId } });
  if (opts.uniqueMode === "off") return 0;
  const data = opts.rows
    .filter((r) => r.sha256 || r.phash || r.sourceUrl)
    .map((r) => ({ teamId: opts.teamId, siteId: opts.siteId, articleId: opts.articleId, sha256: r.sha256 ?? null, phash: r.phash ?? null, sourceUrl: (r.sourceUrl ?? "").slice(0, 2000) }));
  if (!data.length) return 0;
  await prisma.artPhotoFingerprint.createMany({ data });
  return data.length;
}

/** Чистка отпечатков старше 30 дней (замена cleanup_photo_data; зовётся из этапа отбора по случаю). */
export async function purgeOldFingerprints(): Promise<number> {
  const r = await prisma.artPhotoFingerprint.deleteMany({ where: { createdAt: { lt: cutoffDate() } } });
  return r.count;
}
