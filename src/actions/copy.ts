"use server";
/**
 * Server actions Article Copy: общие правила (администратор; общий банк — только главный админ), привязка сайтов,
 * запрос пересчёта карты ключей (считает воркер, см. src/lib/copy/build.ts).
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { artSiteWhere } from "@/lib/articles/access";
import { copySettings } from "@/lib/copy/build";
import { COPY } from "@/lib/copy/keys";

export type FormState = { error?: string; ok?: string };
const flag = (f: FormData, k: string) => { const v = f.get(k); return v === "on" || v === "1" || v === "true"; };
const num = (f: FormData, k: string, def: number, min: number, max: number) => {
  const n = Number(String(f.get(k) ?? "").replace(",", ".").trim());
  return Number.isFinite(n) && String(f.get(k) ?? "").trim() ? Math.min(max, Math.max(min, n)) : def;
};
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const refresh = () => { revalidatePath(COPY); revalidatePath(`${COPY}/settings`); };

export async function saveCopyRules(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { error: "Правила меняет только администратор" };
  try {
    const cur = await copySettings();
    const sharedBank = me.superAdmin ? flag(f, "sharedBank") : cur.sharedBank;
    await prisma.copySettings.update({
      where: { id: "main" },
      data: {
        sharedBank,
        photosPerArticle: Math.round(num(f, "photosPerArticle", cur.photosPerArticle, 5, 100)),
        maxOverlapPct: Math.round(num(f, "maxOverlapPct", cur.maxOverlapPct, 0, 100)),
        maxPerSite: Math.round(num(f, "maxPerSite", cur.maxPerSite, 1, 10)),
        minReserveScore: num(f, "minReserveScore", cur.minReserveScore, 0, 10),
        minPhotos: Math.round(num(f, "minPhotos", cur.minPhotos, 5, 100)),
        reservePct: Math.round(num(f, "reservePct", cur.reservePct, 0, 100)),
        rebuildRequestedAt: new Date(),
      },
    });
  } catch (e) { return fail(e); }
  refresh();
  return { ok: "Правила сохранены. Запас пересчитается за 4–5 минут." };
}

/** Привязка сайтов: отмеченные публикуют мешап-статьи. Меняются только сайты, которые человек видит. */
export async function saveCopySites(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const visible = await prisma.artSite.findMany({ where: { ...(await artSiteWhere(me)), isActive: true }, select: { id: true, teamId: true } });
    const checked = new Set(f.getAll("site").map(String));
    for (const s of visible) {
      if (checked.has(s.id)) await prisma.copySite.upsert({ where: { artSiteId: s.id }, update: { publish: true, teamId: s.teamId }, create: { artSiteId: s.id, teamId: s.teamId, publish: true, createdById: me.id } });
      else await prisma.copySite.deleteMany({ where: { artSiteId: s.id } });
    }
    await copySettings();
    await prisma.copySettings.update({ where: { id: "main" }, data: { rebuildRequestedAt: new Date() } });
  } catch (e) { return fail(e); }
  refresh();
  return { ok: `Сайтов привязано: ${f.getAll("site").length}. Запас пересчитается за 4–5 минут.` };
}

/** Автосборка: включение, суточная норма на сайт, нужна ли проверка статьи перед публикацией. */
export async function saveCopyAuto(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { error: "Автосборку включает только администратор" };
  let on = false;
  try {
    const cur = await copySettings();
    on = flag(f, "autoEnabled");
    await prisma.copySettings.update({ where: { id: "main" }, data: { autoEnabled: on, dailyPerSite: Math.round(num(f, "dailyPerSite", cur.dailyPerSite, 1, 50)), reviewBeforePublish: flag(f, "reviewBeforePublish") } });
  } catch (e) { return fail(e); }
  refresh();
  revalidatePath(`${COPY}/articles`);
  return { ok: on ? "Автосборка включена: первые статьи появятся в течение пары минут." : "Автосборка выключена. Уже собранные статьи допишутся и опубликуются." };
}

export async function requestCopyRebuild(_p: FormState, _f: FormData): Promise<FormState> {
  await requireUser();
  try {
    await copySettings();
    await prisma.copySettings.update({ where: { id: "main" }, data: { rebuildRequestedAt: new Date() } });
  } catch (e) { return fail(e); }
  refresh();
  return { ok: "Пересчёт запрошен, обновите страницу через 4–5 минут." };
}
