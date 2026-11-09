"use server";
/**
 * Server actions ИИ-модерации фото — обёртки над src/lib/articles/aiModeration.ts для форм (ActionForm)
 * на серверных страницах (карточка статьи, настройки сайта). Клиентский экран /pinterest/articles/moderation/ai
 * ходит в /api/articles/ai напрямую.
 */
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { insufficientAction, rerunArticles, resolveResult, startAiRun, stopAiRun, type AiResolveOp } from "@/lib/articles/aiModeration";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

function refresh(extra: string[] = []) {
  revalidatePath("/pinterest/articles/moderation/ai");
  revalidatePath("/pinterest/articles/moderation/articles");
  revalidatePath("/pinterest/articles/automation");
  revalidatePath("/pinterest/articles");
  for (const p of extra) revalidatePath(p);
}

/** Поля: siteId, limit (число), mode (auto|test), articleIds (через запятую, необязательно). */
export async function startAiRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const ids = str(f, "articleIds").split(",").map((s) => s.trim()).filter(Boolean);
    const r = await startAiRun(me, { siteId: str(f, "siteId"), limit: Number(str(f, "limit")) || 10, mode: str(f, "mode") === "test" ? "test" : "auto", articleIds: ids.length ? ids : undefined });
    refresh(ids.map((id) => `/pinterest/articles/articles/${id}`));
    return { ok: `ИИ-проверка запущена: ${r.count} статей` };
  } catch (e) {
    return fail(e);
  }
}

export async function stopAiRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await stopAiRun(me, str(f, "runId"));
    refresh();
    return { ok: "Запуск остановлен, непроверенные статьи снова доступны сотрудникам" };
  } catch (e) {
    return fail(e);
  }
}

/** Поля: resultId, op (approve|human|insufficient|exclude). */
export async function resolveAiResultAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const op = str(f, "op") as AiResolveOp;
    if (!["approve", "human", "insufficient", "exclude"].includes(op)) return { error: "Неизвестное действие" };
    const r = await resolveResult(me, str(f, "resultId"), op);
    refresh();
    if (r.error) return { error: `Не применено: ${r.error}` };
    const text: Record<string, string> = { applied: "Применено", sent_to_human: "Правки применены, статья отдана сотруднику", excluded: "Исключено — статья отдана сотруднику без правок", failed: "Не удалось применить" };
    return { ok: text[r.status] ?? r.status };
  } catch (e) {
    return fail(e);
  }
}

/** Поля: resultIds (через запятую). */
export async function rerunAiResultsAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const r = await rerunArticles(me, str(f, "resultIds").split(",").map((s) => s.trim()).filter(Boolean));
    refresh();
    return { ok: `Перепроверка запущена: ${r.count}` };
  } catch (e) {
    return fail(e);
  }
}

/** Поля: id (статья), op (topup|return|close). */
export async function insufficientAiAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const op = str(f, "op");
    if (op !== "topup" && op !== "return" && op !== "close") return { error: "Неизвестное действие" };
    await insufficientAction(me, id, op);
    refresh([`/pinterest/articles/articles/${id}`]);
    return { ok: op === "topup" ? "Добор запущен" : op === "return" ? "Возвращено на модерацию" : "Статья закрыта" };
  } catch (e) {
    return fail(e);
  }
}
