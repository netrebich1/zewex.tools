"use server";
/** Server actions партий Article Copy: создать (планирует темы и запускает), пауза / продолжить / отменить остаток. */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { QUOTA_CLASSES, planBatch, type Quotas } from "@/lib/copy/batch";
import { COPY } from "@/lib/copy/keys";
import type { FormState } from "./copy";

const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

export async function createCopyBatch(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { error: "Партии запускает только администратор" };
  const siteIds = f.getAll("site").map(String);
  const quotas: Quotas = {};
  let total = 0;
  for (const [k, v] of f.entries()) {
    const m = /^q\.([a-z_]+)\.(hi|mid|low|any)$/.exec(k);
    if (!m) continue;
    const n = Math.max(0, Math.min(5000, Math.floor(Number(String(v).trim() || 0))));
    if (!Number.isFinite(n) || !n) continue;
    (quotas[m[1]] ??= {})[m[2] as (typeof QUOTA_CLASSES)[number]] = n;
    total += n;
  }
  if (!siteIds.length) return { error: "Отметьте хотя бы один сайт" };
  if (!total) return { error: "Впишите, сколько статей собрать, хотя бы в одну клетку" };
  if (total > 5000) return { error: "Не больше 5000 статей в одной партии" };
  const photos = Math.max(5, Math.min(100, Math.floor(Number(String(f.get("photos") ?? "").trim() || 0)) || 25));
  const pm = Math.floor(Number(String(f.get("photosMax") ?? "").trim() || 0));
  const photosMax = pm > photos ? Math.min(100, pm) : null;
  const mw = Math.floor(Number(String(f.get("maxPerWord") ?? "").trim() || 0));
  let id = "";
  try {
    const y = Math.floor(Number(String(f.get("year") ?? "").trim()));
    const r = await planBatch({ name: String(f.get("name") ?? ""), siteIds, quotas, word: String(f.get("word") ?? ""), photos, photosMax, maxPerWord: mw >= 1 && mw <= 50 ? mw : 3, review: f.get("review") === "on", noSeason: f.get("noSeason") === "on", year: y >= 2024 && y <= 2035 ? y : null, createdById: me.id });
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath(`${COPY}/batches`);
  redirect(`${COPY}/batches/${id}`);
}

/** Пауза, продолжение и отмена остатка партии. */
export async function setCopyBatchStatus(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { error: "Партиями управляет только администратор" };
  const id = String(f.get("id") ?? "");
  const op = String(f.get("op") ?? "");
  try {
    const b = await prisma.copyBatch.findUnique({ where: { id }, select: { status: true } });
    if (!b) return { error: "Партия не найдена" };
    if (op === "pause" && b.status === "running") await prisma.copyBatch.update({ where: { id }, data: { status: "paused" } });
    else if (op === "resume" && b.status === "paused") await prisma.copyBatch.update({ where: { id }, data: { status: "running" } });
    else if (op === "cancel" && b.status !== "done") {
      const n = await prisma.copyBatchItem.updateMany({ where: { batchId: id, status: "pending" }, data: { status: "failed", reason: "отменено с экрана", doneAt: new Date() } });
      await prisma.copyBatch.update({ where: { id }, data: { status: "done", finishedAt: new Date(), failed: { increment: n.count } } });
    } else return { error: "Это действие сейчас недоступно" };
  } catch (e) { return fail(e); }
  revalidatePath(`${COPY}/batches`);
  revalidatePath(`${COPY}/batches/${id}`);
  return { ok: op === "pause" ? "Партия на паузе: собранные статьи дописываются, новые не собираются." : op === "resume" ? "Партия продолжена." : "Остаток партии отменён." };
}
