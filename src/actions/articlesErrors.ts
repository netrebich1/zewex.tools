"use server";
/**
 * Действия над группами ошибок сервиса «Статьи» (журнал, страница запуска и сайта):
 * отметить устранённой / вернуть в открытые / вернуть статьи группы в работу. Фильтры — те же, что в списке
 * (сайт, запуск, этап, период), поэтому кнопка на странице запуска не трогает ошибки других запусков.
 */
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorWhere, type ErrorFilter } from "@/lib/articles/errorsView";

type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

function filterOf(f: FormData, state: ErrorFilter["state"]): ErrorFilter {
  const signature = str(f, "signature");
  if (!signature) throw new Error("Нет сигнатуры группы");
  const days = Number(str(f, "days"));
  return {
    signature, state,
    siteId: str(f, "siteId") || undefined,
    runId: str(f, "runId") || undefined,
    stage: str(f, "stage") || undefined,
    since: days > 0 ? new Date(Date.now() - Math.min(365, days) * 86400_000) : undefined,
  };
}

function refresh(f: FormData) {
  revalidatePath("/pinterest/articles/journal");
  const runId = str(f, "runId");
  const siteId = str(f, "siteId");
  if (runId) revalidatePath(`/pinterest/articles/runs/${runId}`);
  if (siteId) revalidatePath(`/pinterest/articles/sites/${siteId}`);
}

/** «Устранено»: открытые ошибки группы получают resolvedAt. */
export async function resolveErrorsAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const r = await prisma.artError.updateMany({ where: await errorWhere(me, filterOf(f, "open")), data: { resolvedAt: new Date() } });
    refresh(f);
    return { ok: `Отмечено устранённым: ${r.count}` };
  } catch (e) {
    return fail(e);
  }
}

/** «Вернуть в открытые»: снять отметку «устранено» (если ошибку закрыли по ошибке или она вернулась). */
export async function unresolveErrorsAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const r = await prisma.artError.updateMany({ where: await errorWhere(me, filterOf(f, "resolved")), data: { resolvedAt: null } });
    refresh(f);
    return { ok: `Снова открыто: ${r.count}` };
  } catch (e) {
    return fail(e);
  }
}

/** «Вернуть в работу»: статьи группы со статусом «Ошибка» → в очередь с текущего этапа, их ошибки — устранены. */
export async function requeueErrorsAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const errs = await prisma.artError.findMany({ where: await errorWhere(me, filterOf(f, "all")), select: { articleId: true } });
    const ids = [...new Set(errs.map((e) => e.articleId).filter((x): x is string => !!x))];
    if (!ids.length) return { error: "В группе нет статей" };
    const failed = await prisma.article.findMany({ where: { id: { in: ids }, status: "FAILED" }, select: { id: true } });
    const fids = failed.map((a) => a.id);
    if (!fids.length) return { error: "Статей со статусом «Ошибка» в группе нет (возможно, уже перезапущены)" };
    await prisma.article.updateMany({ where: { id: { in: fids }, status: "FAILED" }, data: { status: "PENDING", attempts: 0, error: null, errorStage: null, nextRunAt: null, stopRequested: false } });
    await prisma.artError.updateMany({ where: { articleId: { in: fids }, resolvedAt: null }, data: { resolvedAt: new Date() } });
    refresh(f);
    revalidatePath("/pinterest/articles");
    return { ok: `Снова в очереди: ${fids.length} статей` };
  } catch (e) {
    return fail(e);
  }
}
