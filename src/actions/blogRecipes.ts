"use server";
/**
 * Server actions раздела «Рецепты» инфо-статей (BlogRecipe + BlogRecipeVersion). Рецепты общие для всех команд:
 * смотреть и править может любой вошедший, удалять — администратор. Сохранение промта или параметров пишет версию.
 */
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { BLOG, ACTIVE_STATUSES, DEFAULT_PARAMS, DEFAULT_PHOTO_SEARCH, DEFAULT_PUBLISH, PUBLISH_MODES, type BlogPhotoSearch, type BlogRecipeParams, type Tri, type Voice } from "@/lib/blog/types";
import { mergeParams, mergePhotoSearch, mergePublish, recipeShape } from "@/lib/blog/recipes";
import { PROMPT_KEY_LABELS } from "@/lib/blog/stages";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const has = (f: FormData, k: string) => f.has(k);
const num = (f: FormData, k: string, def: number, min: number, max: number) => {
  const n = Number(String(f.get(k) ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const json = (v: unknown) => v as Prisma.InputJsonValue;
const tri = (v: string, d: Tri): Tri => (v === "always" || v === "never" || v === "auto" ? v : d);

function refresh(id?: string) {
  revalidatePath(`${BLOG}/recipes`);
  if (id) revalidatePath(`${BLOG}/recipes/${id}`);
}

async function recipeOrFail(id: string) {
  const r = await prisma.blogRecipe.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" }, take: 1, select: { version: true } } } });
  if (!r) throw new Error("Рецепт не найден");
  return r;
}

async function writeVersion(recipeId: string, prompts: unknown, params: unknown, summary: string, userId: string, lastVersion: number) {
  await prisma.blogRecipeVersion.create({ data: { recipeId, version: lastVersion + 1, prompts: json(prompts), params: json(params), changeSummary: summary.slice(0, 300) || null, createdById: userId } });
}

export async function createBlogRecipe(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const name = str(f, "name");
  const fromId = str(f, "fromId");
  if (!name) return { error: "Введите название рецепта" };
  let id: string;
  try {
    const last = await prisma.blogRecipe.aggregate({ _max: { number: true } });
    const from = fromId ? await prisma.blogRecipe.findUnique({ where: { id: fromId } }) : await prisma.blogRecipe.findFirst({ where: { isDefault: true } });
    id = randomUUID();
    await prisma.blogRecipe.create({
      data: {
        id, number: (last._max.number ?? 0) + 1, name, description: str(f, "description") || null, isActive: true, isDefault: false,
        models: json(from?.models ?? {}), prompts: json(from?.prompts ?? {}), params: json(from ? mergeParams(from.params) : DEFAULT_PARAMS), photoSearch: json(from ? mergePhotoSearch(from.photoSearch) : DEFAULT_PHOTO_SEARCH), publish: json(from ? mergePublish(from.publish) : DEFAULT_PUBLISH),
      },
    });
    await writeVersion(id, from?.prompts ?? {}, from ? mergeParams(from.params) : DEFAULT_PARAMS, from ? `копия «${from.name}»` : "создан", me.id, 0);
  } catch (e) { return fail(e); }
  refresh(id);
  redirect(`${BLOG}/recipes/${id}`);
}

/** Вкладка «Основное»: название, описание, активность, параметры (объём, картинки, голос, блоки, FAQ, ссылки), публикация. */
export async function saveBlogRecipeMain(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const r = await recipeOrFail(id);
    const cur = recipeShape(r);
    const p = cur.params;
    const allow = str(f, "linksAllow").split(/[\s,;]+/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean);
    const lmin = num(f, "lengthMin", p.length.min, 300, 6000);
    const imin = num(f, "imagesMin", p.images.min, 1, 12);
    const fmin = num(f, "faqMin", p.faqCount.min, 2, 10);
    const voice = str(f, "voice");
    const params: BlogRecipeParams = {
      length: { min: lmin, max: Math.max(lmin, num(f, "lengthMax", p.length.max, 300, 6000)) },
      images: { min: imin, max: Math.max(imin, num(f, "imagesMax", p.images.max, 1, 12)), heroOrientation: (["tall", "square", "any"].includes(str(f, "heroOrientation")) ? str(f, "heroOrientation") : p.images.heroOrientation) as "tall" | "square" | "any" },
      voice: (["blogger_first_person", "expert_neutral", "warm_guide"].includes(voice) ? voice : p.voice) as Voice,
      persona: str(f, "persona").slice(0, 300) || p.persona,
      blocks: { takeaways: tri(str(f, "blockTakeaways"), p.blocks.takeaways), faq: tri(str(f, "blockFaq"), p.blocks.faq), disclaimer: tri(str(f, "blockDisclaimer"), p.blocks.disclaimer), closingImage: tri(str(f, "blockClosing"), p.blocks.closingImage) },
      faqCount: { min: fmin, max: Math.max(fmin, num(f, "faqMax", p.faqCount.max, 2, 10)) },
      links: { mode: str(f, "linksMode") === "allowlist" ? "allowlist" : "none", allow },
      research: { serp: f.get("researchSerp") === "on" },
      review: { aiEditor: f.get("aiEditor") === "on" },
      language: str(f, "language").toLowerCase().slice(0, 5) || p.language,
      country: str(f, "country").toUpperCase().slice(0, 2) || p.country,
    };
    const mode = PUBLISH_MODES.find((m) => m.value === str(f, "publishMode"))?.value ?? cur.publish.mode;
    const publish = { mode, seoYearUrlPercent: num(f, "seoYearUrlPercent", cur.publish.seoYearUrlPercent, 0, 100), schema: str(f, "schema") === "off" ? "off" : "inline" };
    const isDefault = f.get("isDefault") === "on";
    await prisma.$transaction(async (tx) => {
      if (isDefault) await tx.blogRecipe.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      await tx.blogRecipe.update({ where: { id }, data: { name: str(f, "name") || r.name, description: str(f, "description") || null, isDefault, isActive: f.get("isActive") === "on", params: json(params), publish: json(publish) } });
    });
    if (JSON.stringify(params) !== JSON.stringify(p)) await writeVersion(id, cur.prompts, params, str(f, "changeSummary") || "параметры рецепта", me.id, r.versions[0]?.version ?? 0);
  } catch (e) { return fail(e); }
  refresh(id);
  return { ok: "Рецепт сохранён" };
}

/** Вкладка «Поиск фото». */
export async function saveBlogPhotoSearch(_p: FormState, f: FormData): Promise<FormState> {
  await requireUser();
  const id = str(f, "id");
  try {
    const r = await recipeOrFail(id);
    const cur = recipeShape(r).photoSearch;
    const orientation = f.getAll("orientation").map(String).filter((o): o is "tall" | "square" | "wide" => ["tall", "square", "wide"].includes(o));
    const next: BlogPhotoSearch = {
      source: str(f, "source") === "serpapi" ? "serpapi" : "dataforseo",
      country: str(f, "country").toLowerCase().slice(0, 2) || cur.country,
      language: str(f, "language").toLowerCase().slice(0, 5) || cur.language,
      freshness: str(f, "freshness") || cur.freshness,
      imageType: str(f, "imageType") === "any" ? "any" : "photo",
      orientation: orientation.length ? orientation.slice(0, 2) : cur.orientation,
      minSide: num(f, "minSide", cur.minSide, 300, 4000),
      minScore: num(f, "minScore", cur.minScore, 1, 10),
      perSlot: num(f, "perSlot", cur.perSlot, 20, 200),
      excludeDomains: str(f, "excludeDomains").split(/[\n,;\s]+/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean),
      uniqueMode: (["soft", "strict", "off"].includes(str(f, "uniqueMode")) ? str(f, "uniqueMode") : cur.uniqueMode) as BlogPhotoSearch["uniqueMode"],
      captionMode: (["domain_link", "domain", "none"].includes(str(f, "captionMode")) ? str(f, "captionMode") : cur.captionMode) as BlogPhotoSearch["captionMode"],
      captionTemplate: str(f, "captionTemplate") || "{credit} {domain}",
    };
    await prisma.blogRecipe.update({ where: { id }, data: { photoSearch: json(next) } });
  } catch (e) { return fail(e); }
  refresh(id);
  return { ok: "Настройки поиска фото сохранены" };
}

/** Сохранить промт шага: prompts[stageKey] + новая версия. */
export async function saveBlogPrompt(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "recipeId");
  const stageKey = str(f, "stageKey");
  try {
    const r = await recipeOrFail(id);
    const cur = recipeShape(r);
    if (!PROMPT_KEY_LABELS[stageKey]) throw new Error("Неизвестный шаг");
    const text = String(f.get("text") ?? "");
    const system = String(f.get("system") ?? "");
    const prev = cur.prompts[stageKey] ?? { system: "", text: "" };
    if (prev.text === text && prev.system === system) return { ok: "Изменений нет" };
    const prompts = { ...cur.prompts, [stageKey]: { system, text } };
    await prisma.blogRecipe.update({ where: { id }, data: { prompts: json(prompts) } });
    await writeVersion(id, prompts, cur.params, str(f, "changeSummary") || `промт «${PROMPT_KEY_LABELS[stageKey]}»`, me.id, r.versions[0]?.version ?? 0);
  } catch (e) { return fail(e); }
  refresh(id);
  return { ok: "Промт сохранён, записана новая версия" };
}

/** Модель шага `provider:model` (пусто — модель правила слота портала). */
export async function setBlogStageModel(_p: FormState, f: FormData): Promise<FormState> {
  await requireUser();
  const id = str(f, "recipeId");
  const stageKey = str(f, "stageKey");
  const model = str(f, "model");
  try {
    if (model && !/^[a-z0-9_-]+:[^\s]+$/i.test(model)) throw new Error("Формат модели: provider:model, например openrouter:google/gemini-2.5-flash-lite");
    const r = await recipeOrFail(id);
    const models = { ...recipeShape(r).models };
    if (model) models[stageKey] = model; else delete models[stageKey];
    await prisma.blogRecipe.update({ where: { id }, data: { models: json(models) } });
  } catch (e) { return fail(e); }
  refresh(id);
  return { ok: model ? `Модель шага: ${model}` : "Модель шага — из правила ключа" };
}

/** Вернуть промты и параметры из версии (пишется новая версия «откат»). */
export async function restoreBlogVersion(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "recipeId");
  const versionId = str(f, "versionId");
  try {
    const r = await recipeOrFail(id);
    const v = await prisma.blogRecipeVersion.findUnique({ where: { id: versionId } });
    if (!v || v.recipeId !== id) throw new Error("Версия не найдена");
    await prisma.blogRecipe.update({ where: { id }, data: { prompts: json(v.prompts), params: json(v.params) } });
    await writeVersion(id, v.prompts, v.params, `откат к версии ${v.version}`, me.id, r.versions[0]?.version ?? 0);
  } catch (e) { return fail(e); }
  refresh(id);
  return { ok: "Версия восстановлена" };
}

export async function deleteBlogRecipe(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { error: "Удалять рецепты может только администратор" };
  const id = str(f, "id");
  try {
    await recipeOrFail(id);
    const active = await prisma.blogPost.count({ where: { recipeId: id, status: { in: ACTIVE_STATUSES } } });
    if (active) return { error: `Нельзя удалить: ${active} статей с этим рецептом ещё в работе` };
    const sites = await prisma.blogSite.count({ where: { defaultRecipeId: id } });
    if (sites) return { error: `Рецепт назначен по умолчанию у ${sites} сайтов — сначала смените его в настройках сайтов` };
    await prisma.blogRecipe.delete({ where: { id } });
  } catch (e) { return fail(e); }
  refresh();
  redirect(`${BLOG}/recipes`);
}

/** Копия рецепта (промты, параметры, модели, поиск, публикация). */
export async function copyBlogRecipe(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  let newId: string;
  try {
    const r = await recipeOrFail(id);
    const last = await prisma.blogRecipe.aggregate({ _max: { number: true } });
    newId = randomUUID();
    await prisma.blogRecipe.create({ data: { id: newId, number: (last._max.number ?? 0) + 1, name: `${r.name} (копия)`, description: r.description, isActive: false, isDefault: false, models: json(r.models), prompts: json(r.prompts), params: json(r.params), photoSearch: json(r.photoSearch), publish: json(r.publish) } });
    await writeVersion(newId, r.prompts, r.params, `копия «${r.name}»`, me.id, 0);
  } catch (e) { return fail(e); }
  refresh(newId);
  redirect(`${BLOG}/recipes/${newId}`);
}
