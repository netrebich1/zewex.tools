"use server";
/**
 * Server actions раздела «Сценарии» (ArtRecipe + ArtPromptSet/ArtPrompt/ArtPromptVersion).
 * Сценарии общие для всех команд: смотреть и править может любой вошедший, удалять — администратор.
 * Сохранение промта всегда пишет ArtPromptVersion (version+1, changeSummary) — оригинал prompt_versions не вёл.
 */
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, type ArtFormat } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { ACTIVE_STATUSES } from "@/lib/articles/labels";
import { DEFAULT_IMAGES, DEFAULT_PHOTO_SEARCH, DEFAULT_PUBLISH, DEFAULT_TEXT, recipeShape } from "@/lib/articles/recipes";
import { PERSONALITIES, PUBLISH_MODES, WORD_COUNTS, type PhotoSearchConfig, type PublishMode, type WordCount } from "@/lib/articles/types";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const has = (f: FormData, k: string) => f.has(k);
const num = (f: FormData, k: string, def: number, min: number, max: number) => {
  const n = Number(String(f.get(k) ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const json = (v: unknown) => v as Prisma.InputJsonValue;

function refresh(id?: string) {
  revalidatePath("/pinterest/articles/scenarios");
  if (id) revalidatePath(`/pinterest/articles/scenarios/${id}`);
}

async function recipeOrFail(id: string) {
  const r = await prisma.artRecipe.findUnique({ where: { id } });
  if (!r) throw new Error("Сценарий не найден");
  return r;
}

export async function createRecipe(_p: FormState, f: FormData): Promise<FormState> {
  await requireUser();
  const name = str(f, "name");
  const nicheCode = str(f, "nicheCode");
  const format = (str(f, "format") === "GENERATED_PHOTO" ? "GENERATED_PHOTO" : "REAL_PHOTO") as ArtFormat;
  const promptSetId = str(f, "promptSetId") || null;
  if (!name) return { error: "Введите название сценария" };
  if (!nicheCode) return { error: "Выберите нишу" };
  let id: string;
  try {
    if (promptSetId) {
      const set = await prisma.artPromptSet.findUnique({ where: { id: promptSetId }, select: { format: true } });
      if (!set) return { error: "Набор промтов не найден" };
      if (set.format !== format) return { error: "Набор промтов другого формата" };
    }
    const subnicheCode = str(f, "subnicheCode") || null;
    const last = await prisma.artRecipe.aggregate({ _max: { number: true } });
    id = randomUUID();
    await prisma.artRecipe.create({
      data: { id, number: (last._max.number ?? 0) + 1, name, nicheCode, subnicheCode, format, promptSetId, isActive: true, isDefault: false, stagePromptIds: json({}), stageModels: json({}), text: json(DEFAULT_TEXT), images: json(DEFAULT_IMAGES), photoSearch: json(DEFAULT_PHOTO_SEARCH), publish: json(DEFAULT_PUBLISH) },
    });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  redirect(`/pinterest/articles/scenarios/${id}?tab=prompts`);
}

/** Вкладка «Основное»: название, описание, ниша, набор, по умолчанию/активен, text, publish. */
export async function saveRecipeMain(_p: FormState, f: FormData): Promise<FormState> {
  await requireUser();
  const id = str(f, "id");
  try {
    const r = await recipeOrFail(id);
    const shape = recipeShape(r);
    const name = str(f, "name") || r.name;
    const nicheCode = str(f, "nicheCode") || r.nicheCode;
    const subnicheCode = str(f, "subnicheCode") || null;
    const promptSetId = str(f, "promptSetId") || null;
    if (promptSetId) {
      const set = await prisma.artPromptSet.findUnique({ where: { id: promptSetId }, select: { format: true } });
      if (!set) return { error: "Набор промтов не найден" };
      if (set.format !== r.format) return { error: "Набор промтов другого формата" };
    }
    // Смена набора: выбранные варианты из прежнего набора больше не подходят (резолвер проверит, но чистим сразу).
    const stagePromptIds = promptSetId === r.promptSetId ? shape.stagePromptIds : {};
    const isDefault = f.get("isDefault") === "on";
    const isActive = f.get("isActive") === "on";
    const wordCount = (WORD_COUNTS.find((w) => w.value === str(f, "wordCount"))?.value ?? shape.text.wordCount) as WordCount;
    const personality = str(f, "personality");
    const text = { batchSize: Math.round(num(f, "batchSize", shape.text.batchSize, 1, 10)), personality: (PERSONALITIES as readonly string[]).includes(personality) ? personality : null, wordCount, schemaEnabled: f.get("schemaEnabled") === "on" };
    const mode = (PUBLISH_MODES.find((m) => m.value === str(f, "publishMode"))?.value ?? shape.publish.mode) as PublishMode;
    const publish = { mode, seoYearUrlPercent: Math.round(num(f, "seoYearUrlPercent", shape.publish.seoYearUrlPercent, 0, 100)) };
    await prisma.$transaction(async (tx) => {
      if (isDefault) await tx.artRecipe.updateMany({ where: { nicheCode, format: r.format, id: { not: id } }, data: { isDefault: false } });
      await tx.artRecipe.update({ where: { id }, data: { name, description: str(f, "description") || null, nicheCode, subnicheCode, promptSetId, isDefault, isActive, stagePromptIds: json(stagePromptIds), text: json(text), publish: json(publish) } });
    });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { ok: "Сценарий сохранён" };
}

/** Вкладка «Поиск фото»: все поля PhotoSearchConfig. */
export async function savePhotoSearch(_p: FormState, f: FormData): Promise<FormState> {
  await requireUser();
  const id = str(f, "id");
  try {
    const r = await recipeOrFail(id);
    const cur = recipeShape(r).photoSearch;
    const list = (k: string) => str(f, k).split(/[\n,;\s]+/).map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean);
    const orientation = f.getAll("orientation").map(String).filter((o): o is "tall" | "square" | "wide" => ["tall", "square", "wide"].includes(o));
    const side = Math.round(num(f, "minSide", cur.minWidth, 200, 4000));
    const next: PhotoSearchConfig = {
      source: str(f, "source") === "serpapi" ? "serpapi" : "dataforseo",
      country: str(f, "country").toLowerCase().slice(0, 2) || cur.country,
      language: str(f, "language").toLowerCase().slice(0, 5) || cur.language,
      freshness: str(f, "freshness") || cur.freshness,
      license: str(f, "license") || cur.license,
      imageType: str(f, "imageType") || cur.imageType,
      orientation: orientation.length ? orientation.slice(0, 2) : cur.orientation,
      minWidth: side,
      minHeight: side,
      minScore: Math.round(num(f, "minScore", cur.minScore, 1, 10)),
      candidatesTotal: Math.round(num(f, "candidatesTotal", cur.candidatesTotal, 20, 1000)),
      ratingBatchSize: Math.round(num(f, "ratingBatchSize", cur.ratingBatchSize, 2, 12)),
      includeDomains: list("includeDomains"),
      excludeDomains: list("excludeDomains"),
      uniqueMode: (["soft", "strict", "off"].includes(str(f, "uniqueMode")) ? str(f, "uniqueMode") : cur.uniqueMode) as PhotoSearchConfig["uniqueMode"],
      writerMode: str(f, "writerMode") === "vision" ? "vision" : "description",
      captionMode: (["domain_link", "domain", "none"].includes(str(f, "captionMode")) ? str(f, "captionMode") : cur.captionMode) as PhotoSearchConfig["captionMode"],
      captionTemplate: str(f, "captionTemplate") || "{credit} {domain}",
      querySuffix: str(f, "querySuffix").slice(0, 200),
    };
    await prisma.artRecipe.update({ where: { id }, data: { photoSearch: json(next) } });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { ok: "Настройки поиска фото сохранены" };
}

/** Сохранить текст промта: ArtPrompt + новая ArtPromptVersion. */
export async function savePrompt(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const promptId = str(f, "promptId");
  const recipeId = str(f, "recipeId");
  try {
    const p = await prisma.artPrompt.findUnique({ where: { id: promptId }, include: { versions: { orderBy: { version: "desc" }, take: 1, select: { version: true } } } });
    if (!p) throw new Error("Промт не найден");
    const text = String(f.get("text") ?? "");
    const systemRaw = String(f.get("system") ?? "");
    const system = has(f, "system") ? (systemRaw.trim() ? systemRaw : null) : p.system;
    const name = str(f, "name") || p.name;
    if (!text.trim()) throw new Error("Текст промта пустой");
    const unchanged = text === p.text && (system ?? "") === (p.system ?? "") && name === p.name;
    if (unchanged) return { ok: "Изменений нет" };
    const version = (p.versions[0]?.version ?? 0) + 1;
    await prisma.$transaction([
      prisma.artPrompt.update({ where: { id: promptId }, data: { text, system, name, isActive: has(f, "isActivePresent") ? f.get("isActive") === "on" : p.isActive } }),
      prisma.artPromptVersion.create({ data: { promptId, version, system, text, changeSummary: str(f, "changeSummary").slice(0, 300) || null, createdById: me.id } }),
    ]);
  } catch (e) {
    return fail(e);
  }
  refresh(recipeId);
  return { ok: "Промт сохранён, записана новая версия" };
}

/** Новый вариант промта шага в наборе (пустой или копия выбранного). Сразу становится активным вариантом сценария. */
export async function createPromptVariant(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const recipeId = str(f, "recipeId");
  const setId = str(f, "setId");
  const stageKey = str(f, "stageKey");
  const fromId = str(f, "fromId");
  let id: string;
  try {
    const set = await prisma.artPromptSet.findUnique({ where: { id: setId }, select: { id: true } });
    if (!set) throw new Error("Набор промтов не найден");
    if (!stageKey) throw new Error("Не указан шаг");
    const from = fromId ? await prisma.artPrompt.findUnique({ where: { id: fromId } }) : null;
    const count = await prisma.artPrompt.count({ where: { setId, stageKey } });
    id = randomUUID();
    const name = str(f, "name") || (from ? `${from.name} (копия)` : `Вариант ${count + 1}`);
    await prisma.$transaction(async (tx) => {
      await tx.artPrompt.create({ data: { id, setId, stageKey, name, system: from?.system ?? null, text: from?.text ?? "", isActive: true } });
      await tx.artPromptVersion.create({ data: { promptId: id, version: 1, system: from?.system ?? null, text: from?.text ?? "", changeSummary: from ? `копия «${from.name}»` : "создан", createdById: me.id } });
      if (recipeId) {
        const r = await tx.artRecipe.findUnique({ where: { id: recipeId }, select: { stagePromptIds: true, promptSetId: true } });
        if (r && r.promptSetId === setId) await tx.artRecipe.update({ where: { id: recipeId }, data: { stagePromptIds: json({ ...((r.stagePromptIds ?? {}) as Record<string, string>), [stageKey]: id }) } });
      }
    });
  } catch (e) {
    return fail(e);
  }
  refresh(recipeId);
  redirect(`/pinterest/articles/scenarios/${recipeId}?tab=prompts&stage=${encodeURIComponent(stageKey)}&prompt=${id}`);
}

/** Выбрать активный вариант промта шага для сценария (пусто — первый вариант набора). */
export async function setStagePrompt(_p: FormState, f: FormData): Promise<FormState> {
  await requireUser();
  const recipeId = str(f, "recipeId");
  const stageKey = str(f, "stageKey");
  const promptId = str(f, "promptId");
  try {
    const r = await recipeOrFail(recipeId);
    const ids = { ...recipeShape(r).stagePromptIds };
    if (promptId) {
      const p = await prisma.artPrompt.findUnique({ where: { id: promptId }, select: { stageKey: true, setId: true } });
      if (!p || p.stageKey !== stageKey) throw new Error("Вариант не относится к этому шагу");
      if (r.promptSetId && p.setId !== r.promptSetId) throw new Error("Вариант из другого набора промтов");
      ids[stageKey] = promptId;
    } else delete ids[stageKey];
    await prisma.artRecipe.update({ where: { id: recipeId }, data: { stagePromptIds: json(ids) } });
  } catch (e) {
    return fail(e);
  }
  refresh(recipeId);
  return { ok: promptId ? "Вариант выбран" : "Используется первый вариант набора" };
}

/** Модель шага `provider:model` (пусто — модель правила слота портала). */
export async function setStageModel(_p: FormState, f: FormData): Promise<FormState> {
  await requireUser();
  const recipeId = str(f, "recipeId");
  const stageKey = str(f, "stageKey");
  const model = str(f, "model");
  try {
    if (model && !/^[a-z0-9_-]+:[^\s]+$/i.test(model)) throw new Error("Формат модели: provider:model, например openrouter:google/gemini-2.5-flash-lite");
    const r = await recipeOrFail(recipeId);
    const models = { ...recipeShape(r).stageModels };
    if (model) models[stageKey] = model;
    else delete models[stageKey];
    await prisma.artRecipe.update({ where: { id: recipeId }, data: { stageModels: json(models) } });
  } catch (e) {
    return fail(e);
  }
  refresh(recipeId);
  return { ok: model ? `Модель шага: ${model}` : "Модель шага — из правила ключа" };
}

/** Копия сценария вместе с набором промтов (все варианты, новые id, remap stagePromptIds) — одной транзакцией. */
export async function copyRecipe(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  let newId: string;
  try {
    const r = await recipeOrFail(id);
    const shape = recipeShape(r);
    const prompts = r.promptSetId ? await prisma.artPrompt.findMany({ where: { setId: r.promptSetId } }) : [];
    const set = r.promptSetId ? await prisma.artPromptSet.findUnique({ where: { id: r.promptSetId } }) : null;
    const last = await prisma.artRecipe.aggregate({ _max: { number: true } });
    newId = randomUUID();
    const newSetId = set ? randomUUID() : null;
    const map = new Map<string, string>();
    for (const p of prompts) map.set(p.id, randomUUID());
    const stagePromptIds: Record<string, string> = {};
    for (const [k, v] of Object.entries(shape.stagePromptIds)) if (map.has(v)) stagePromptIds[k] = map.get(v)!;
    await prisma.$transaction(async (tx) => {
      if (set && newSetId) {
        await tx.artPromptSet.create({ data: { id: newSetId, name: `${set.name} (копия)`, description: set.description, nicheCode: set.nicheCode, subnicheCode: set.subnicheCode, format: set.format, isActive: false } });
        for (const p of prompts) {
          const pid = map.get(p.id)!;
          await tx.artPrompt.create({ data: { id: pid, setId: newSetId, stageKey: p.stageKey, name: p.name, system: p.system, text: p.text, model: p.model, isActive: p.isActive } });
          await tx.artPromptVersion.create({ data: { promptId: pid, version: 1, system: p.system, text: p.text, changeSummary: `копия из сценария «${r.name}»`, createdById: me.id } });
        }
      }
      await tx.artRecipe.create({
        data: { id: newId, number: (last._max.number ?? 0) + 1, name: `${r.name} (копия)`, description: r.description, nicheCode: r.nicheCode, subnicheCode: r.subnicheCode, format: r.format, promptSetId: newSetId, isActive: false, isDefault: false, stagePromptIds: json(stagePromptIds), stageModels: json(shape.stageModels), text: json(shape.text), images: json(shape.images), photoSearch: json(shape.photoSearch), publish: json(shape.publish) },
      });
    });
  } catch (e) {
    return fail(e);
  }
  refresh(newId);
  redirect(`/pinterest/articles/scenarios/${newId}`);
}

/** Удалить сценарий (только администратор; нельзя, пока есть активные статьи с этим сценарием). Набор промтов остаётся. */
export async function deleteRecipe(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { error: "Удалять сценарии может только администратор" };
  const id = str(f, "id");
  try {
    await recipeOrFail(id);
    const active = await prisma.article.count({ where: { recipeId: id, status: { in: ACTIVE_STATUSES } } });
    if (active) return { error: `Нельзя удалить: ${active} статей с этим сценарием ещё в работе` };
    const sites = await prisma.artSite.count({ where: { defaultRecipeId: id } });
    if (sites) return { error: `Сценарий назначен по умолчанию у ${sites} сайтов — сначала смените его в настройках сайтов` };
    await prisma.artRecipe.delete({ where: { id } });
  } catch (e) {
    return fail(e);
  }
  refresh();
  redirect("/pinterest/articles/scenarios");
}
