import { NextResponse } from "next/server";
import type { ArtStatus } from "@prisma/client";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";
import {
  activeClaims,
  addFromReserve,
  approveArticle,
  approvePhotos,
  claimArticle,
  excludePhoto,
  markInsufficient,
  markOutdated,
  ModerationError,
  nextForReview,
  photoState,
  releaseClaim,
  removePhoto,
  reorderPhotos,
  requestTopup,
  restorePhoto,
  retryPublish,
  returnToReview,
  reviewState,
  reworkArticle,
  skipArticle,
  updateReviewFields,
} from "@/lib/articles/moderation";

export const dynamic = "force-dynamic";

/** Режим конвейера: модерация фото (PHOTO_REVIEW) или готовых статей (REVIEW_PENDING / NEEDS_REWORK). */
const MODES: Record<string, ArtStatus[]> = { photos: ["PHOTO_REVIEW"], articles: ["REVIEW_PENDING"], rework: ["NEEDS_REWORK"] };

const noStore = { headers: { "Cache-Control": "no-store" } };

function fail(e: unknown) {
  if (e instanceof ModerationError) return NextResponse.json({ error: e.message, stale: e.stale }, { status: e.status, ...noStore });
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: msg }, { status: 500, ...noStore });
}

async function stateFor(me: CurrentUser, articleId: string, review: boolean) {
  try {
    return review ? await reviewState(me, articleId) : await photoState(me, articleId);
  } catch {
    return null;
  }
}

/**
 * GET
 *  ?article=<id>[&review=1]           — состояние фото (и секций/мета при review=1)
 *  ?next=1&mode=photos|articles|rework[&site=<id>][&exclude=a,b] — следующая свободная статья (закрепляется)
 *  ?claims=1                           — кто сейчас модерирует
 */
export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const u = new URL(req.url);
  try {
    if (u.searchParams.get("claims")) return NextResponse.json({ claims: await activeClaims(me) }, noStore);
    const review = u.searchParams.get("review") === "1" || (u.searchParams.get("mode") ?? "photos") !== "photos";
    if (u.searchParams.get("next")) {
      const mode = u.searchParams.get("mode") ?? "photos";
      const statuses = MODES[mode] ?? MODES.photos;
      const exclude = (u.searchParams.get("exclude") ?? "").split(",").filter(Boolean);
      const articleId = await nextForReview(me, { siteId: u.searchParams.get("site") || undefined, statuses, exclude });
      if (!articleId) return NextResponse.json({ articleId: null, state: null }, noStore);
      return NextResponse.json({ articleId, state: await stateFor(me, articleId, review) }, noStore);
    }
    const articleId = u.searchParams.get("article");
    if (!articleId) return NextResponse.json({ error: "Нужен article" }, { status: 400 });
    const state = review ? await reviewState(me, articleId) : await photoState(me, articleId);
    return NextResponse.json({ state }, noStore);
  } catch (e) {
    return fail(e);
  }
}

type Body = {
  action: string;
  articleId: string;
  mode?: string;
  photoId?: string;
  candidateId?: string;
  order?: string[];
  reason?: string;
  publishNow?: boolean;
  fields?: { h1?: string; metaTitle?: string; metaDescription?: string; slug?: string; wpCategoryId?: number | null };
};

/**
 * POST { action, articleId, … } — одно действие модерации. В ответе — свежее состояние статьи,
 * если она ещё редактируется (иначе state=null: статья ушла дальше по конвейеру).
 */
export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  let b: Body;
  try {
    b = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Нужен JSON" }, { status: 400 });
  }
  if (!b?.articleId || typeof b.articleId !== "string") return NextResponse.json({ error: "Нужен articleId" }, { status: 400 });
  const id = b.articleId;
  const review = (b.mode ?? "photos") !== "photos";
  let result: unknown = null;
  try {
    switch (b.action) {
      case "claim":
        result = await claimArticle(me, id, MODES[b.mode ?? "photos"] ?? MODES.photos);
        break;
      case "release":
        await releaseClaim(me, id);
        break;
      case "skip":
        await skipArticle(me, id);
        break;
      case "exclude":
        await excludePhoto(me, id, String(b.photoId ?? ""));
        break;
      case "outdated":
        await markOutdated(me, id, String(b.photoId ?? ""));
        break;
      case "restore":
        await restorePhoto(me, id, String(b.photoId ?? ""));
        break;
      case "remove":
        await removePhoto(me, id, String(b.photoId ?? ""));
        break;
      case "add":
        result = await addFromReserve(me, id, String(b.candidateId ?? ""));
        break;
      case "reorder":
        await reorderPhotos(me, id, Array.isArray(b.order) ? b.order.map(String) : []);
        break;
      case "approve":
        result = await approvePhotos(me, id);
        break;
      case "topup":
        await requestTopup(me, id, String(b.reason ?? ""));
        break;
      case "insufficient":
        await markInsufficient(me, id, String(b.reason ?? ""));
        break;
      case "return_review":
        await returnToReview(me, id);
        break;
      case "save_meta":
        await updateReviewFields(me, id, b.fields ?? {});
        break;
      case "review_approve":
        await approveArticle(me, id, { publishNow: !!b.publishNow });
        break;
      case "rework":
        await reworkArticle(me, id, String(b.reason ?? ""));
        break;
      case "retry_publish":
        await retryPublish(me, id);
        break;
      default:
        return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
    }
  } catch (e) {
    return fail(e);
  }
  const final = ["approve", "topup", "insufficient", "review_approve", "rework", "retry_publish", "skip", "release", "return_review"].includes(b.action);
  const state = final ? null : await stateFor(me, id, review);
  return NextResponse.json({ ok: true, result, state }, noStore);
}
