"use server";
/**
 * Server actions модерации статей — обёртки над src/lib/articles/moderation.ts для форм (ActionForm).
 * Клиентские сетки ходят в /api/articles/moderation; здесь — кнопки на серверных страницах
 * (публикации, «Мало фото», карточка статьи).
 */
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  approveArticle,
  approvePhotos,
  markInsufficient,
  requestTopup,
  retryAllPublishErrors,
  retryPublish,
  returnToReview,
  reworkArticle,
  skipArticle,
} from "@/lib/articles/moderation";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

function refresh(id: string, extra: string[] = []) {
  revalidatePath(`/pinterest/articles/articles/${id}`);
  revalidatePath("/pinterest/articles/moderation/photos");
  revalidatePath("/pinterest/articles/moderation/articles");
  revalidatePath("/pinterest/articles/publications");
  revalidatePath("/pinterest/articles");
  for (const p of extra) revalidatePath(p);
}

export async function approvePhotosAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const r = await approvePhotos(me, id);
    refresh(id);
    return { ok: `Фото одобрены (${r.photos}) — статья ушла на написание` };
  } catch (e) {
    return fail(e);
  }
}

export async function topupAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    await requestTopup(me, id, str(f, "reason"));
    refresh(id);
    return { ok: "Статья ушла добирать фото и вернётся на модерацию с пополненным резервом" };
  } catch (e) {
    return fail(e);
  }
}

export async function insufficientAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    await markInsufficient(me, id, str(f, "reason"));
    refresh(id);
    return { ok: "Статья отмечена «Мало фото»" };
  } catch (e) {
    return fail(e);
  }
}

export async function returnToReviewAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    await returnToReview(me, id);
    refresh(id);
    return { ok: "Статья снова на модерации фото" };
  } catch (e) {
    return fail(e);
  }
}

export async function skipArticleAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    await skipArticle(me, id);
    refresh(id);
    return { ok: "Пропущено" };
  } catch (e) {
    return fail(e);
  }
}

export async function approveArticleAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const publishNow = f.get("publishNow") === "on" || f.get("publishNow") === "1";
    await approveArticle(me, id, { publishNow });
    refresh(id);
    return { ok: publishNow ? "Одобрено, публикация с приоритетом" : "Одобрено — статья в очереди публикации" };
  } catch (e) {
    return fail(e);
  }
}

export async function reworkArticleAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const reason = [str(f, "reasonKind"), str(f, "reason")].filter(Boolean).join(": ");
    await reworkArticle(me, id, reason);
    refresh(id);
    return { ok: "Отправлено в доработку" };
  } catch (e) {
    return fail(e);
  }
}

export async function retryPublishAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    await retryPublish(me, id);
    refresh(id);
    return { ok: "Публикация поставлена в очередь повторно" };
  } catch (e) {
    return fail(e);
  }
}

export async function retryAllPublishAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const n = await retryAllPublishErrors(me, str(f, "siteId") || undefined);
    revalidatePath("/pinterest/articles/publications");
    revalidatePath("/pinterest/articles");
    return { ok: n ? `Повторно в очереди публикации: ${n}` : "Ошибок публикации нет" };
  } catch (e) {
    return fail(e);
  }
}

/* ---------- Журнал: группы ошибок ---------- */
import { prisma } from "@/lib/db";
import { artSiteWhere } from "@/lib/articles/access";
import type { Prisma } from "@prisma/client";

/** Видимые мне ошибки: по сайтам моих доступов, либо без сайта — по моим командам. */
async function errorGroupWhere(me: Awaited<ReturnType<typeof requireUser>>, f: FormData): Promise<Prisma.ArtErrorWhereInput> {
  const signature = str(f, "signature");
  if (!signature) throw new Error("Нет сигнатуры группы");
  const siteId = str(f, "siteId");
  const days = Math.min(90, Math.max(1, Number(str(f, "days")) || 7));
  const base: Prisma.ArtErrorWhereInput = { signature, resolvedAt: null, createdAt: { gte: new Date(Date.now() - days * 86400_000) }, ...(siteId ? { siteId } : {}) };
  if (me.role === "ADMIN") return base;
  const sites = await prisma.artSite.findMany({ where: await artSiteWhere(me), select: { id: true } });
  return { ...base, OR: [{ siteId: { in: sites.map((s) => s.id) } }, { siteId: null, teamId: { in: me.teamIds } }] };
}

/** «Устранено»: скрыть группу ошибок (resolvedAt). */
export async function resolveErrorGroupAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const r = await prisma.artError.updateMany({ where: await errorGroupWhere(me, f), data: { resolvedAt: new Date() } });
    revalidatePath("/pinterest/articles/journal");
    return { ok: `Отмечено устранённым: ${r.count}` };
  } catch (e) {
    return fail(e);
  }
}

/** «Вернуть в работу»: статьи группы со статусом FAILED → PENDING с текущего этапа (оригинал ErrorsPage: без смены этапа). */
export async function requeueErrorGroupAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const errs = await prisma.artError.findMany({ where: await errorGroupWhere(me, f), select: { articleId: true } });
    const ids = [...new Set(errs.map((e) => e.articleId).filter((x): x is string => !!x))];
    if (!ids.length) return { error: "В группе нет статей" };
    const r = await prisma.article.updateMany({ where: { id: { in: ids }, status: "FAILED" }, data: { status: "PENDING", attempts: 0, error: null, errorStage: null, nextRunAt: null, stopRequested: false } });
    await prisma.artError.updateMany({ where: { articleId: { in: ids }, resolvedAt: null }, data: { resolvedAt: new Date() } });
    revalidatePath("/pinterest/articles/journal");
    revalidatePath("/pinterest/articles");
    return r.count ? { ok: `Снова в очереди: ${r.count} статей` } : { error: "Статей со статусом «Ошибка» в группе нет (возможно, уже перезапущены)" };
  } catch (e) {
    return fail(e);
  }
}
