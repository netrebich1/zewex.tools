/**
 * Постановка статей в очередь: запуск (ArtRun) + статья на каждый ключ со снимком сценария.
 * Снимок (ArticleRecipeSnapshot) = поля сценария + настройки запуска (модерация фото, режим публикации, год в URL,
 * переопределения поиска). Правка сценария после запуска на уже созданные статьи не влияет — их исполняет воркер по снимку.
 * Готовность сценария (все промты этапов есть, у пользователя есть правила слотов) считается здесь же для шага «Сценарий».
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { ArtFormat, ArtRecipe, Prisma } from "@prisma/client";
import { canAccessArtSite } from "./access";
import { slotAvailable } from "./ai";
import { loadArtSettings } from "./automation";
import { innerDuplicates, sanitizeTopic, infoIntent } from "./keywords";
import { resolvePromptSetId } from "./prompts";
import { STAGE_INFO, firstStage, stagesFor } from "./stages";
import {
  SLOTS, aiModerationOn, pickPhotoCount, type ArtRunSettings, type ArticleRecipeSnapshot, type KeywordInput, type PhotoSearchConfig, type RecipeImages, type RecipePublish, type RecipeShape, type RecipeText, type SlotKey,
} from "./types";

/** Сценарий из строки базы в типизированную форму. */
export function recipeShape(r: ArtRecipe): RecipeShape {
  return {
    id: r.id, name: r.name, nicheCode: r.nicheCode, subnicheCode: r.subnicheCode, format: r.format, promptSetId: r.promptSetId,
    stagePromptIds: (r.stagePromptIds as Record<string, string> | null) ?? {},
    stageModels: (r.stageModels as Record<string, string> | null) ?? {},
    text: (r.text as RecipeText | null) ?? { batchSize: 5, personality: null, wordCount: "compact3", schemaEnabled: true },
    images: (r.images as RecipeImages | null) ?? { provider: "openai", model: "gpt-image-2", quality: "low", size: "1024x1536", mode: "single", groupId: null, promptId: null, promptWriterModel: "" },
    photoSearch: (r.photoSearch as PhotoSearchConfig | null) ?? ({} as PhotoSearchConfig),
    publish: (r.publish as RecipePublish | null) ?? { mode: "publish_then_edit", seoYearUrlPercent: 0 },
  };
}

/** Снимок сценария для статьи с учётом настроек запуска. */
export function buildSnapshot(recipe: RecipeShape, s: ArtRunSettings): ArticleRecipeSnapshot {
  const yearPct = s.yearInUrlPercent ?? recipe.publish.seoYearUrlPercent ?? 0;
  return {
    ...recipe,
    photoSearch: {
      ...recipe.photoSearch,
      ...(s.search.country ? { country: s.search.country } : {}),
      ...(s.search.language ? { language: s.search.language } : {}),
      ...(s.search.freshness ? { freshness: s.search.freshness } : {}),
    },
    publish: { ...recipe.publish, mode: s.publishMode, seoYearUrlPercent: yearPct },
    run: { photoReview: s.photoReview, publishMode: s.publishMode, yearInUrlPercent: yearPct, testLabel: s.testLabel ?? "" },
  };
}

/* ───────── Готовность сценария ───────── */

export type RecipeReadiness = {
  /** Каких промтов нет ни в сценарии, ни в наборе (ключи шагов) */
  missingPrompts: string[];
  /** Нет набора промтов вообще */
  noPromptSet: boolean;
  /** Слоты ключей без правила у пользователя (подписи) */
  missingSlots: string[];
  ok: boolean;
};

const SLOT_LABELS: Record<SlotKey, string> = {
  text_main: "Тексты статьи", text_fast: "Быстрые шаги текста", vision: "Оценка фото (vision)", image_main: "Генерация картинок", photo_dfs: "Поиск фото (DataForSEO)", photo_serp: "Поиск фото (SerpAPI)",
};

/** Правила слотов пользователя для проекта: один раз на страницу. */
export async function userSlots(me: CurrentUser): Promise<Record<SlotKey, boolean>> {
  const keys = Object.values(SLOTS) as SlotKey[];
  const flags = await Promise.all(keys.map((k) => slotAvailable(me.id, k).catch(() => false)));
  return Object.fromEntries(keys.map((k, i) => [k, flags[i]])) as Record<SlotKey, boolean>;
}

/** Слоты, нужные формату: фото-поиск — достаточно одного из DataForSEO/SerpAPI. */
export function missingSlotsFor(format: ArtFormat, have: Record<SlotKey, boolean>): string[] {
  const need = new Set<string>();
  for (const st of stagesFor(format)) for (const s of STAGE_INFO[st].slots) need.add(s);
  const out: string[] = [];
  const photo = need.has(SLOTS.photoDfs) || need.has(SLOTS.photoSerp);
  need.delete(SLOTS.photoDfs); need.delete(SLOTS.photoSerp);
  if (photo && !have.photo_dfs && !have.photo_serp) out.push("Поиск фото (DataForSEO или SerpAPI)");
  for (const s of need) if (!have[s as SlotKey]) out.push(SLOT_LABELS[s as SlotKey] ?? s);
  return out;
}

export async function recipeReadiness(recipe: RecipeShape, have: Record<SlotKey, boolean>): Promise<RecipeReadiness> {
  const needKeys = new Set<string>();
  for (const st of stagesFor(recipe.format)) for (const k of STAGE_INFO[st].promptKeys) needKeys.add(k);
  const setId = await resolvePromptSetId(recipe);
  const inSet = setId ? new Set((await prisma.artPrompt.findMany({ where: { setId, isActive: true }, select: { stageKey: true } })).map((p) => p.stageKey)) : new Set<string>();
  const chosenIds = Object.values(recipe.stagePromptIds).filter(Boolean);
  const chosen = chosenIds.length ? await prisma.artPrompt.findMany({ where: { id: { in: chosenIds }, isActive: true }, select: { id: true, stageKey: true } }) : [];
  const missing: string[] = [];
  for (const k of needKeys) {
    const picked = recipe.stagePromptIds[k];
    const okPicked = picked && chosen.some((p) => p.id === picked && p.stageKey === k);
    if (!okPicked && !inSet.has(k)) missing.push(k);
  }
  const missingSlots = missingSlotsFor(recipe.format, have);
  return { missingPrompts: missing, noPromptSet: !setId, missingSlots, ok: !missing.length && !!setId && !missingSlots.length };
}

/* ───────── Дубликаты ───────── */

/** Ключи, по которым у сайта уже есть статья (кроме FAILED/STOPPED). Возвращает в нижнем регистре. */
export async function findDuplicateKeywords(siteId: string, keywords: string[]): Promise<string[]> {
  const list = [...new Set(keywords.map((k) => sanitizeTopic(k)).filter(Boolean))];
  if (!list.length) return [];
  const rows = await prisma.article.findMany({ where: { siteId, status: { notIn: ["FAILED", "STOPPED"] }, keyword: { in: list } }, select: { keyword: true } });
  const have = new Set(rows.map((r) => r.keyword.toLowerCase()));
  return list.filter((k) => have.has(k.toLowerCase())).map((k) => k.toLowerCase());
}

/* ───────── Запуск ───────── */

export type LaunchInput = { siteId: string; settings: ArtRunSettings; keywords: KeywordInput[]; name?: string };
export type LaunchResult = { runId: string; created: number; skipped: string[]; invalid: string[]; sheetRows: number[] };

export async function launchArticles(me: CurrentUser, input: LaunchInput): Promise<LaunchResult> {
  const site = await prisma.artSite.findUnique({ where: { id: input.siteId }, select: { id: true, teamId: true, accessId: true, isActive: true, name: true, settings: true } });
  if (!site || !(await canAccessArtSite(me, site))) throw new Error("Сайт не найден");
  if (!site.isActive) throw new Error("Сайт в архиве: верните его из архива на вкладке «Настройки»");
  // ИИ-модерация фото сайта включена (и мастер-выключатель тоже) → фото каждой статьи с реальными фото проверяются до текста,
  // какой бы ни была галочка «Модерация фото до текста» в запуске или колонка «Режим» в таблице: проверку делает ИИ.
  // Для ИИ-картинок не меняем: у них нет отбора фото, а photoReview=true там отключил бы модерацию готовой статьи.
  const aiMod = aiModerationOn(site.settings, await loadArtSettings());
  const reviewFor = (k: KeywordInput, recipe: RecipeShape): boolean => (aiMod && recipe.format === "REAL_PHOTO" ? true : k.photoReview ?? input.settings.photoReview);

  // Чистим ключи, отбрасываем пустые и повторы внутри списка
  const invalid: string[] = [];
  const cleaned: KeywordInput[] = [];
  for (const k of input.keywords) {
    const keyword = sanitizeTopic(k.keyword);
    if (!keyword || keyword.length < 3) { invalid.push(k.keyword); continue; }
    cleaned.push({ ...k, keyword, seoKeyword: k.seoKeyword?.trim() || undefined, focusKeyword: k.focusKeyword?.trim() || undefined });
  }
  const inner = innerDuplicates(cleaned);
  const seen = new Set<string>();
  const unique = cleaned.filter((k) => { const l = k.keyword.toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; });
  const dup = new Set(await findDuplicateKeywords(site.id, unique.map((k) => k.keyword)));
  const info = new Map(unique.map((k) => [k.keyword, infoIntent(k.keyword)] as const).filter((x): x is readonly [string, string] => !!x[1]));
  const skipped = [
    ...unique.filter((k) => dup.has(k.keyword.toLowerCase())).map((k) => k.keyword),
    ...[...inner].map((k) => `${k} (повтор в списке)`),
    ...[...info].filter(([k]) => !dup.has(k.toLowerCase())).map(([k, why]) => `${k} (${why})`),
  ];
  const fresh = unique.filter((k) => !dup.has(k.keyword.toLowerCase()) && !info.has(k.keyword));
  if (!fresh.length) throw new Error(skipped.length ? `Все ключи уже есть у этого сайта: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}` : "Добавьте хотя бы один ключ");

  // Сценарий запуска + сценарии отдельных строк (импорт из Google Таблицы: у каждой строки свой номер сценария)
  const recipeIds = [...new Set(fresh.map((k) => k.recipeId || input.settings.recipeId).filter(Boolean))];
  if (!recipeIds.length) throw new Error("Выберите сценарий");
  const recipeRows = await prisma.artRecipe.findMany({ where: { id: { in: recipeIds }, isActive: true } });
  const recipes = new Map(recipeRows.map((r) => [r.id, recipeShape(r)]));
  const recipeOf = (k: KeywordInput) => recipes.get(k.recipeId || input.settings.recipeId);
  if (fresh.some((k) => !recipeOf(k))) throw new Error("Сценарий не найден или выключен");

  // Снимок сценария на статью: параметры запуска + переопределения строки (одинаковые строки делят один снимок)
  const snapshots = new Map<string, ArticleRecipeSnapshot>();
  const snapshotOf = (k: KeywordInput, recipe: RecipeShape): ArticleRecipeSnapshot => {
    const s: ArtRunSettings = {
      ...input.settings,
      recipeId: recipe.id,
      photoReview: reviewFor(k, recipe),
      yearInUrlPercent: k.yearInUrlPercent ?? input.settings.yearInUrlPercent,
      search: {
        country: k.search?.country || input.settings.search.country,
        language: k.search?.language || input.settings.search.language,
        freshness: k.search?.freshness || input.settings.search.freshness,
      },
    };
    const key = JSON.stringify([recipe.id, s.photoReview, s.yearInUrlPercent, s.search]);
    let snap = snapshots.get(key);
    if (!snap) { snap = buildSnapshot(recipe, s); snapshots.set(key, snap); }
    return snap;
  };

  const first = recipeOf(fresh[0])!;
  const sheet = input.settings.sheet;
  const runName = input.name?.trim() || `${new Date().toLocaleDateString("ru-RU")} · ${sheet ? `Google Таблица «${sheet.tab}»` : first.name} · ${fresh.length} ключей`;

  // В карточке запуска «Модерация фото до текста: да», если её включила ИИ-модерация сайта.
  const runSettings: ArtRunSettings = aiMod && [...recipes.values()].every((r) => r.format === "REAL_PHOTO") ? { ...input.settings, photoReview: true } : input.settings;
  const run = await prisma.artRun.create({
    data: { teamId: site.teamId, siteId: site.id, recipeId: recipes.size === 1 ? first.id : null, createdById: me.id, name: runName.slice(0, 190), settings: runSettings as unknown as Prisma.InputJsonValue },
  });
  const data: Prisma.ArticleCreateManyInput[] = fresh.map((k) => {
    const recipe = recipeOf(k)!;
    const photoReview = reviewFor(k, recipe);
    return {
      teamId: site.teamId, siteId: site.id, runId: run.id, recipeId: recipe.id, createdById: me.id,
      keyword: k.keyword, seoKeyword: k.seoKeyword ?? "", focusKeyword: k.focusKeyword ?? "",
      format: recipe.format, photoCount: k.photoCount ?? pickPhotoCount(input.settings.photoCount), photoReview, publishMode: input.settings.publishMode,
      recipe: snapshotOf(k, recipe) as unknown as Prisma.InputJsonValue, status: "PENDING", stage: firstStage(recipe.format), attempts: 0, priority: 0,
      ...(sheet && k.sheetRow ? { sheetRow: k.sheetRow, sheetTab: sheet.tab } : {}),
    };
  });
  // Пачками, чтобы не упереться в лимит размера запроса (снимок сценария в каждой строке)
  for (let i = 0; i < data.length; i += 50) await prisma.article.createMany({ data: data.slice(i, i + 50) });
  return { runId: run.id, created: fresh.length, skipped, invalid, sheetRows: sheet ? fresh.map((k) => k.sheetRow).filter((r): r is number => !!r) : [] };
}
