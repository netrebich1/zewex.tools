"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { canAccessPinSite } from "@/lib/sites/access";
import { applyReschedule, previewReschedule, type ReschedulePlan, type ReschedulePreview } from "@/lib/pins/runs/reschedule";
import { cleanGrowth, type GrowthStep } from "@/lib/pins/schedule/growth";
import { MAX_DAY_PINS } from "@/lib/pins/types";

export type RescheduleInput = { siteId: string; from: string; mode: "flat" | "growth"; perDay: number; steps: GrowthStep[]; withUndated: boolean };
export type RescheduleResult = { error?: string; preview?: ReschedulePreview; applied?: boolean };

function planOf(i: RescheduleInput): ReschedulePlan {
  if (i.mode === "growth") {
    const steps = cleanGrowth(i.steps);
    if (!steps.length) throw new Error("Добавьте хотя бы одну ступень роста");
    return { mode: "growth", steps };
  }
  const perDay = Math.floor(Number(i.perDay));
  if (!(perDay >= 1 && perDay <= MAX_DAY_PINS)) throw new Error(`Пинов в день: от 1 до ${MAX_DAY_PINS}`);
  return { mode: "flat", perDay };
}

async function guard(siteId: string) {
  const me = await requireUser();
  const site = await prisma.pinSite.findUnique({ where: { id: siteId }, select: { id: true, teamId: true, wpConnectionId: true } });
  if (!site || !(await canAccessPinSite(me, site))) throw new Error("Сайт не найден");
}

/** Предпросмотр: что станет с графиком сайта, без записи. */
export async function previewRescheduleAction(i: RescheduleInput): Promise<RescheduleResult> {
  try {
    await guard(i.siteId);
    return { preview: await previewReschedule({ siteId: i.siteId, from: i.from, plan: planOf(i), withUndated: i.withUndated }) };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Перераспределить и записать новые даты. */
export async function applyRescheduleAction(i: RescheduleInput): Promise<RescheduleResult> {
  try {
    await guard(i.siteId);
    const preview = await applyReschedule({ siteId: i.siteId, from: i.from, plan: planOf(i), withUndated: i.withUndated });
    revalidatePath(`/pinterest/pins/sites/${i.siteId}`);
    return { preview, applied: true };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
