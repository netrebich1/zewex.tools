"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { askSync, assertSee, canManage, filterWhere, loadState, parseFilter, queueSites, saveSettings } from "@/lib/competitors/sites";
import { BASE_PATH, parseSettings } from "@/lib/competitors/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

/** Сколько площадок можно поставить в разбор одной кнопкой (около $0.06 за площадку). */
const MANUAL_BATCH = 100;

export async function saveCompSettings(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    if (!(await canManage(me))) throw new Error("Менять настройки может администратор или лидер команды WexOra");
    const settings = parseSettings({
      enabled: f.get("enabled") === "on",
      countries: f.getAll("countries").map(String),
      periodDays: str(f, "periodDays"),
      minDeals: str(f, "minDeals"),
      minClicks: str(f, "minClicks"),
      kwLimit: str(f, "kwLimit"),
      dailyLimit: str(f, "dailyLimit"),
    });
    if (settings.enabled && !settings.countries.length) throw new Error("Отметьте хотя бы одну страну или выключите авторазбор");
    await saveSettings(settings);
    revalidatePath(BASE_PATH, "layout");
    return { ok: "Сохранено. Новые правила применятся к очереди в течение минуты." };
  } catch (e) {
    return fail(e);
  }
}

export async function syncCompNow(_p: FormState, _f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    if (!(await canManage(me))) throw new Error("Запускать сбор может администратор или лидер команды WexOra");
    await askSync();
    revalidatePath(BASE_PATH);
    return { ok: "Сбор запущен: каталог обновится за 1–2 минуты, обновите страницу." };
  } catch (e) {
    return fail(e);
  }
}

/** Разбор одной площадки (site) или всех неразобранных из текущего фильтра (поля фильтра приходят скрытыми полями). */
export async function analyzeCompSites(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    await assertSee(me);
    let ids: string[];
    if (str(f, "site")) ids = [str(f, "site")];
    else {
      if (!(await canManage(me))) throw new Error("Разбор пачкой запускает администратор или лидер команды WexOra");
      const { settings } = await loadState();
      const filter = parseFilter((k) => (f.has(k) ? str(f, k) : undefined), settings);
      const rows = await prisma.compSite.findMany({ where: { AND: [filterWhere(filter), { status: { in: ["none", "error"] } }] }, orderBy: { gscClicks: "desc" }, take: MANUAL_BATCH, select: { id: true } });
      ids = rows.map((r) => r.id);
    }
    const n = await queueSites(ids);
    revalidatePath(BASE_PATH, "layout");
    return { ok: n ? `В очередь на разбор: ${n}. Одна площадка разбирается около минуты.` : "Нечего ставить в очередь" };
  } catch (e) {
    return fail(e);
  }
}
