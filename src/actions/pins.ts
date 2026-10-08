"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createRun, continueRun, deleteRun, parseUrls, redoMissing, skipFailed, stopRun } from "@/lib/pins/runs/actions";
import type { ModerationMode } from "@/lib/pins/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });

export async function launchRun(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const { urls, invalid } = parseUrls(str(f, "urls"));
  if (invalid.length) return { error: `Не похоже на ссылки: ${invalid.slice(0, 3).join(", ")}${invalid.length > 3 ? "…" : ""}` };
  const mode = str(f, "moderationMode") as ModerationMode;
  let runId: string;
  try {
    const r = await createRun(me, { siteId: str(f, "siteId"), urls, name: str(f, "name"), moderationMode: ["required", "auto", "sample"].includes(mode) ? mode : undefined, stepByStep: f.get("stepByStep") === "on" });
    runId = r.runId;
  } catch (e) { return fail(e); }
  redirect(`/pinterest/pins/runs/${runId}`);
}

export async function continueRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const stage = await continueRun(me, id);
    revalidatePath(`/pinterest/pins/runs/${id}`);
    return { ok: stage === "moderation" ? "Прогон ждёт модерации" : stage === "ready" ? "Прогон завершён" : `Запущен этап «${stage}»` };
  } catch (e) { return fail(e); }
}

export async function stopRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const ok = await stopRun(me, id);
    revalidatePath(`/pinterest/pins/runs/${id}`);
    return ok ? { ok: "Остановка запрошена: воркер завершит текущую порцию" } : { error: "Сейчас ничего не выполняется" };
  } catch (e) { return fail(e); }
}

export async function redoMissingAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const n = await redoMissing(me, id);
    revalidatePath(`/pinterest/pins/runs/${id}`);
    return { ok: `Снова в работе: ${n} пинов` };
  } catch (e) { return fail(e); }
}

export async function skipFailedAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const n = await skipFailed(me, id);
    revalidatePath(`/pinterest/pins/runs/${id}`);
    return { ok: `Пропущено: ${n} пинов без картинки` };
  } catch (e) { return fail(e); }
}

export async function deleteRunAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try { await deleteRun(me, id); } catch (e) { return fail(e); }
  redirect("/pinterest/pins");
}

/* ---------- Сайт: рецепт, доски ---------- */
import { prisma } from "@/lib/db";
import { canAccessTeam } from "@/lib/pins/runs/actions";
import { mergeRecipe, type Recipe } from "@/lib/pins/types";

const num = (f: FormData, k: string, def: number, min = 0, max = 1000) => {
  const n = Number(String(f.get(k) ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

async function siteForUser(me: Awaited<ReturnType<typeof requireUser>>, id: string) {
  const site = await prisma.pinSite.findUnique({ where: { id } });
  if (!site || !canAccessTeam(me, site.teamId)) throw new Error("Сайт не найден");
  return site;
}

export async function saveRecipe(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const site = await siteForUser(me, id);
    const r = mergeRecipe(site.recipe);
    const next: Recipe = {
      ...r,
      mix: { ai: num(f, "mixAi", r.mix.ai, 0, 20), photos: num(f, "mixPhotos", r.mix.photos, 0, 20), canvas: num(f, "mixCanvas", r.mix.canvas, 0, 20), pinora: num(f, "mixPinora", r.mix.pinora, 0, 20) },
      photosMode: str(f, "photosMode") === "featured_only" ? "featured_only" : "all",
      sets: { ...r.sets, aiSetIds: f.getAll("aiSetIds").map(String), canvasSetIds: f.getAll("canvasSetIds").map(String), pinoraTypes: f.getAll("pinoraTypes").map(String) },
      text: {
        ...r.text,
        language: str(f, "language") || r.text.language,
        hashtags: f.get("hashtags") === "on",
        variety: num(f, "variety", r.text.variety, 0, 100),
        elements: { season: f.get("elSeason") === "on", year: f.get("elYear") === "on", number: f.get("elNumber") === "on", cta: f.get("elCta") === "on", siteName: f.get("elSiteName") === "on" },
        audience: (["women", "men", "mix"] as const).find((a) => a === str(f, "audience")) ?? r.text.audience,
        brandColor: str(f, "brandColor") || undefined,
      },
      publishing: { wpConnectionId: str(f, "wpConnectionId") || null, linkDomain: str(f, "linkDomain"), photoLinkPercent: num(f, "photoLinkPercent", r.publishing.photoLinkPercent, 0, 100) },
      schedule: {
        pinsPerDay: num(f, "pinsPerDay", r.schedule.pinsPerDay, 1, 100),
        startFrom: /^\d{4}-\d{2}-\d{2}$/.test(str(f, "startFrom")) ? str(f, "startFrom") : "next_free_day",
        moderationMode: str(f, "moderationMode") === "auto" ? "auto" : "required",
        samplePercent: r.schedule.samplePercent,
      },
      boards: { multiBoard: f.get("multiBoard") === "on" },
    };
    await prisma.pinSite.update({ where: { id }, data: { recipe: next, name: str(f, "name") || site.name, niche: str(f, "niche"), wpConnectionId: next.publishing.wpConnectionId } });
    if (next.publishing.wpConnectionId) revalidatePath(`/sites/${next.publishing.wpConnectionId}`);
  } catch (e) { return fail(e); }
  revalidatePath(`/sites/${id}`);
  revalidatePath("/sites");
  revalidatePath(`/pinterest/pins/sites/${id}`);
  return { ok: "Рецепт сохранён" };
}

export async function saveBoards(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    await siteForUser(me, id);
    const names = [...new Set(str(f, "boards").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
    await prisma.$transaction(async (tx) => {
      await tx.pinBoard.deleteMany({ where: { siteId: id } });
      if (names.length) await tx.pinBoard.createMany({ data: names.map((name, i) => ({ siteId: id, name, sortOrder: i })) });
    });
  } catch (e) { return fail(e); }
  revalidatePath(`/sites/${id}`);
  revalidatePath(`/pinterest/pins/sites/${id}`);
  return { ok: "Доски сохранены" };
}

/** Включить Pinterest Pins для сайта: создаёт PinSite с рецептом по умолчанию, привязанный к доступу WordPress. */
export async function enablePinsForSite(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const accessId = str(f, "accessId");
  try {
    const access = await prisma.siteAccess.findUnique({ where: { id: accessId } });
    if (!access || !canAccessTeam(me, access.teamId)) throw new Error("Сайт не найден");
    const exists = await prisma.pinSite.findFirst({ where: { wpConnectionId: accessId } });
    if (exists) throw new Error("Pinterest Pins уже включён");
    const base = access.name.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "site";
    const taken = await prisma.pinSite.count({ where: { teamId: access.teamId, slug: base } });
    const slug = taken ? `${base}-${Date.now().toString(36)}` : base;
    const recipe = mergeRecipe({ publishing: { wpConnectionId: accessId, linkDomain: access.linkDomain ?? "", photoLinkPercent: 40 } });
    await prisma.pinSite.create({ data: { teamId: access.teamId, name: access.name, slug, recipe, wpConnectionId: accessId, createdById: me.id } });
  } catch (e) { return fail(e); }
  revalidatePath(`/sites/${accessId}`);
  revalidatePath("/sites");
  revalidatePath("/pinterest/pins");
  return { ok: "Pinterest Pins включён" };
}

/** Архив сайта: isActive=false прячет его из сервиса, прогоны и настройки сохраняются. */
export async function toggleSiteActive(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  let active = false;
  try {
    const site = await siteForUser(me, id);
    active = !site.isActive;
    await prisma.pinSite.update({ where: { id }, data: { isActive: active } });
    if (site.wpConnectionId) revalidatePath(`/sites/${site.wpConnectionId}`);
  } catch (e) { return fail(e); }
  revalidatePath(`/sites/${id}`);
  revalidatePath("/sites");
  revalidatePath("/pinterest/pins");
  return { ok: active ? "Сайт возвращён из архива" : "Сайт убран в архив" };
}

/* ---------- Стили: наборы ИИ, скрытие стилей ---------- */
export async function saveAiSet(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const siteId = str(f, "siteId");
  const id = str(f, "id");
  const name = str(f, "name");
  const styleIds = [...new Set(f.getAll("styleIds").map(String))];
  if (!name) return { error: "Укажите название набора" };
  if (!styleIds.length) return { error: "Отметьте хотя бы один стиль" };
  try {
    await siteForUser(me, siteId);
    if (id) await prisma.pinSet.update({ where: { id }, data: { name, topic: str(f, "topic"), styleIds, pinCount: styleIds.length } });
    else await prisma.pinSet.create({ data: { siteId, name, topic: str(f, "topic"), setKind: "ai", styleIds, pinCount: styleIds.length } });
  } catch (e) { return fail(e); }
  revalidatePath("/pinterest/pins/styles");
  return { ok: "Набор сохранён" };
}

export async function deleteSet(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  const set = await prisma.pinSet.findUnique({ where: { id } });
  if (!set) return { error: "Набор не найден" };
  try {
    await siteForUser(me, set.siteId);
    await prisma.pinSet.delete({ where: { id } });
  } catch (e) { return fail(e); }
  revalidatePath("/pinterest/pins/styles");
  return { ok: "Набор удалён" };
}

/** Скрыть / вернуть стиль для сайта (исключение без темы). */
export async function toggleStyleHidden(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const siteId = str(f, "siteId");
  const styleId = str(f, "styleId");
  const kind = str(f, "kind") === "canvas" ? "canvas" : "ai";
  try {
    const site = await siteForUser(me, siteId);
    const ex = await prisma.pinStyleExclusion.findUnique({ where: { siteId_topic_styleId: { siteId, topic: "", styleId } } });
    if (ex) await prisma.pinStyleExclusion.delete({ where: { id: ex.id } });
    else await prisma.pinStyleExclusion.create({ data: { teamId: site.teamId, siteId, topic: "", styleId, kind, styleName: str(f, "styleName") } });
  } catch (e) { return fail(e); }
  revalidatePath("/pinterest/pins/styles");
  return {};
}

/** Одна «заметка к стилю» для команды (бывшие style_overrides). */
export async function saveStyleNote(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const teamId = str(f, "teamId");
  const styleId = str(f, "styleId");
  if (!canAccessTeam(me, teamId)) return { error: "Нет доступа" };
  const instruction = str(f, "instruction");
  try {
    const existing = await prisma.pinStyleOverride.findFirst({ where: { teamId, styleId, siteId: null } });
    if (existing) await prisma.pinStyleOverride.update({ where: { id: existing.id }, data: { instruction, isActive: !!instruction } });
    else if (instruction) await prisma.pinStyleOverride.create({ data: { teamId, styleId, instruction, isActive: true } });
  } catch (e) { return fail(e); }
  revalidatePath("/pinterest/pins/styles");
  return { ok: "Заметка сохранена" };
}

/* ---------- Canvas-каталог ---------- */
import { enqueueJob } from "@/lib/pins/jobs";

/** Служебный прогон команды для задач без прогона (превью каталога). */
async function systemRun(teamId: string): Promise<string> {
  const existing = await prisma.pinRun.findFirst({ where: { teamId, name: "__system__" } });
  if (existing) return existing.id;
  const r = await prisma.pinRun.create({ data: { teamId, name: "__system__", autopilot: false, status: "DRAFT", settings: {} } });
  return r.id;
}

export async function buildCanvasCatalog(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const teamId = str(f, "teamId");
  if (!canAccessTeam(me, teamId)) return { error: "Нет доступа" };
  try {
    const runId = await systemRun(teamId);
    await enqueueJob(runId, "previews", { harvest: true, force: f.get("force") === "1" });
  } catch (e) { return fail(e); }
  revalidatePath("/pinterest/pins/styles");
  return { ok: "Сборка каталога запущена: кандидаты и превью появятся по мере готовности (несколько минут)" };
}

export async function decideCanvasStyle(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN" && !me.leadTeamIds.length) return { error: "Утверждать стили может администратор или лидер команды" };
  const id = str(f, "id");
  const decision = str(f, "decision");
  try {
    if (decision === "approve") await prisma.pinCanvasStyle.update({ where: { id }, data: { isApproved: true, isActive: true } });
    else if (decision === "reject") await prisma.pinCanvasStyle.update({ where: { id }, data: { isApproved: false, isActive: false } });
    else await prisma.pinCanvasStyle.update({ where: { id }, data: { isApproved: false, isActive: true } });
  } catch (e) { return fail(e); }
  revalidatePath("/pinterest/pins/styles");
  return {};
}

export async function saveCanvasSet(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const siteId = str(f, "siteId");
  const id = str(f, "id");
  const name = str(f, "name");
  const styleIds = [...new Set(f.getAll("styleIds").map(String))];
  if (!name) return { error: "Укажите название набора" };
  if (!styleIds.length) return { error: "Отметьте хотя бы один стиль" };
  try {
    await siteForUser(me, siteId);
    if (id) await prisma.pinSet.update({ where: { id }, data: { name, styleIds, pinCount: styleIds.length } });
    else await prisma.pinSet.create({ data: { siteId, name, setKind: "canvas", styleIds, pinCount: styleIds.length } });
  } catch (e) { return fail(e); }
  revalidatePath("/pinterest/pins/styles");
  return { ok: "Canvas-набор сохранён" };
}
