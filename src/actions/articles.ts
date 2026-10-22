"use server";
/**
 * Server actions сервиса «Статьи»: включение сайта, настройки сайта, синхронизация категорий WordPress,
 * запуск, действия над статьями (повтор с этапа / стоп / в очередь / удалить, массово), правка меты и секций.
 * Все мутации проверяют доступ (canAccessArtSite / canAccessArticle). Формы — через components/ActionForm.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { forSitesTab } from "@/lib/permissions";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { canAccessSiteAccess } from "@/lib/sites/access";
import { canAccessArtSite, canAccessArticle } from "@/lib/articles/access";
import { DEFAULT_SITE_SETTINGS, PROJECT_SLUG, PUBLISH_MODES, SITE_LIMITS, mergeSiteSettings, type ArtRunSettings, type ArtSiteSettings, type KeywordInput, type PhotoCountSetting, type PublishMode } from "@/lib/articles/types";
import { findDuplicateKeywords, launchArticles } from "@/lib/articles/launch";
import { failedKeywordHints, type FailedHint } from "@/lib/articles/failedKeywordsView";
import { updateSiteSettings } from "@/lib/articles/automation";
import { fetchAccessToken, markRows, parseServiceKey, planSheetImport, type SheetPlan } from "@/lib/articles/sheets";
import { purgeArticleFiles } from "@/lib/articles/storage";
import { firstStage, stageLabel, stagesFor, type StageKey } from "@/lib/articles/stages";
import { syncCategories } from "@/lib/articles/wp/categories";

export type FormState = { error?: string; ok?: string };
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const has = (f: FormData, k: string) => f.has(k);
const flag = (f: FormData, k: string) => { const v = f.get(k); return v === "on" || v === "1" || v === "true"; };
const num = (f: FormData, k: string, def: number, min = 0, max = 1_000_000) => {
  const raw = String(f.get(k) ?? "").replace(",", ".").trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};
const fail = (e: unknown): FormState => ({ error: e instanceof Error ? e.message : String(e) });
const ART = "/pinterest/articles";

/* ───────── Сайты ───────── */

async function siteForUser(me: CurrentUser, id: string) {
  const site = await prisma.artSite.findUnique({ where: { id }, include: { access: true } });
  if (!site || !(await canAccessArtSite(me, site))) throw new Error("Сайт не найден");
  return site;
}

/** Включить сервис «Статьи» для сайта системы: создаёт ArtSite с настройками по умолчанию, привязанный к доступу WordPress. */
export async function enableArticlesForSite(_p: FormState, f: FormData): Promise<FormState> {
  // Вызывается с вкладки «Сайты»: право «все сайты только там» действует как «все сайты».
  const me = forSitesTab(await requireUser());
  const accessId = str(f, "accessId");
  try {
    const access = await prisma.siteAccess.findUnique({ where: { id: accessId } });
    if (!access || !(await canAccessSiteAccess(me, accessId))) throw new Error("Сайт не найден");
    const pr = (access.projects as string[] | null) ?? [];
    if (pr.length && !pr.includes(PROJECT_SLUG)) throw new Error("В настройках доступа сайта не отмечен инструмент «Статьи»");
    const exists = await prisma.artSite.findFirst({ where: { accessId } });
    if (exists) throw new Error("Сервис «Статьи» уже включён для этого сайта");
    const base = access.name.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "site";
    const taken = await prisma.artSite.count({ where: { teamId: access.teamId, slug: base } });
    const slug = taken ? `${base}-${Date.now().toString(36)}` : base;
    await prisma.artSite.create({ data: { teamId: access.teamId, accessId, name: access.name, slug, nicheCode: null, settings: DEFAULT_SITE_SETTINGS as unknown as Prisma.InputJsonValue, createdById: me.id } });
  } catch (e) { return fail(e); }
  revalidatePath(`/sites/${accessId}`);
  revalidatePath("/sites");
  revalidatePath(ART);
  revalidatePath(`${ART}/sites`);
  return { ok: "Сервис «Статьи» включён. Задайте нишу и сценарий по умолчанию в настройках сайта." };
}

/**
 * Поля автозапуска и ИИ-модерации меняются и здесь, и на экране «Автозапуск». Форма присылает рядом исходное значение
 * (orig_<имя>): если пользователь поле не трогал, берём свежее значение из базы (prev), а не то, что было при открытии формы.
 */
const touched = (f: FormData, k: string, v: string) => !f.has(`orig_${k}`) || String(f.get(`orig_${k}`)) !== v;
const pickFlag = (f: FormData, k: string, prev: boolean) => { const v = flag(f, k); return touched(f, k, v ? "1" : "0") ? v : prev; };
const pickNum = (f: FormData, k: string, prev: number, [min, max]: readonly [number, number]) => { const v = num(f, k, prev, min, max); return touched(f, k, String(v)) ? v : prev; };

/** Настройки сайта из формы (components/articles/SiteSettingsForm). Имена полей — там же. prev — свежие настройки из базы. */
function settingsFromForm(f: FormData, prev: ArtSiteSettings): ArtSiteSettings {
  const mode = str(f, "photoCountMode") === "range" ? "range" : "exact";
  const min = num(f, "photoMin", prev.photoCount.min, 1, 60);
  const max = mode === "range" ? Math.max(min, num(f, "photoMax", prev.photoCount.max, 1, 60)) : min;
  const publishMode = PUBLISH_MODES.some((m) => m.value === str(f, "publishMode")) ? (str(f, "publishMode") as PublishMode) : prev.publishMode;
  const patterns = f.getAll("ruleP").map(String);
  const cats = f.getAll("ruleC").map(String);
  const rules = patterns.map((p, i) => ({ pattern: p.trim(), categoryId: Number(cats[i]) })).filter((r) => r.pattern && Number.isFinite(r.categoryId) && r.categoryId > 0);
  const yearRaw = str(f, "yearInUrlPercent");
  return {
    photoCount: { mode, min, max },
    photoReview: flag(f, "photoReview"),
    publishMode,
    categories: { defaultId: str(f, "catDefaultId") ? num(f, "catDefaultId", 0, 0) || null : null, rules, useAi: flag(f, "catUseAi") },
    // Группы без полей в форме (старая форма, другая страница) не трогаем.
    autostart: has(f, "autoPhotoLimit") ? {
      photoEnabled: pickFlag(f, "autoPhotoEnabled", prev.autostart.photoEnabled), photoLimit: pickNum(f, "autoPhotoLimit", prev.autostart.photoLimit, SITE_LIMITS.photoLimit),
      writingEnabled: pickFlag(f, "autoWritingEnabled", prev.autostart.writingEnabled), writingLimit: pickNum(f, "autoWritingLimit", prev.autostart.writingLimit, SITE_LIMITS.writingLimit),
      publishLimit: pickNum(f, "autoPublishLimit", prev.autostart.publishLimit, SITE_LIMITS.publishLimit),
    } : prev.autostart,
    aiModeration: has(f, "aiModConcurrency") ? {
      enabled: pickFlag(f, "aiModEnabled", prev.aiModeration.enabled),
      batchFrom: pickNum(f, "aiModBatchFrom", prev.aiModeration.batchFrom, SITE_LIMITS.batchFrom),
      concurrency: pickNum(f, "aiModConcurrency", prev.aiModeration.concurrency, SITE_LIMITS.concurrency),
      backlogThreshold: pickNum(f, "aiModBacklog", prev.aiModeration.backlogThreshold, SITE_LIMITS.backlogThreshold),
      autoApply: pickFlag(f, "aiModAutoApply", prev.aiModeration.autoApply),
    } : prev.aiModeration,
    search: { country: str(f, "searchCountry").toLowerCase().slice(0, 8), language: str(f, "searchLanguage").toLowerCase().slice(0, 8), freshness: str(f, "searchFreshness").slice(0, 8) },
    yearInUrlPercent: yearRaw === "" ? null : num(f, "yearInUrlPercent", 0, 0, 100),
    sheetUrl: str(f, "sheetUrl").slice(0, 1000),
  };
}

export async function saveArtSiteSettings(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    await siteForUser(me, id);
    const recipeId = str(f, "defaultRecipeId");
    if (recipeId) {
      const r = await prisma.artRecipe.findUnique({ where: { id: recipeId }, select: { id: true } });
      if (!r) throw new Error("Сценарий по умолчанию не найден");
    }
    const nicheCode = str(f, "nicheCode");
    if (nicheCode && !(await prisma.artNiche.findUnique({ where: { code: nicheCode }, select: { code: true } }))) throw new Error("Ниша не найдена");
    // Запись со сравнением по updatedAt: настройки берутся свежими из базы прямо перед записью (экран «Автозапуск»
    // мог поменять переключатели, пока форма была открыта), неизвестные поля JSON сохраняются.
    await updateSiteSettings(
      id,
      (raw) => ({ ...raw, ...settingsFromForm(f, mergeSiteSettings(raw)) }),
      (row) => ({ name: has(f, "name") ? str(f, "name") || row.name : row.name, nicheCode: has(f, "nicheCode") ? nicheCode || null : row.nicheCode, defaultRecipeId: has(f, "defaultRecipeId") ? recipeId || null : row.defaultRecipeId }),
    );
  } catch (e) { return fail(e); }
  revalidatePath(`${ART}/sites/${id}`);
  revalidatePath(`${ART}/sites`);
  revalidatePath(ART);
  revalidatePath(`${ART}/automation`);
  return { ok: "Настройки сайта сохранены" };
}

/** Архив сайта в сервисе: статьи не захватываются воркером, настройки и история остаются. */
export async function toggleArtSiteActive(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  let active = false;
  try {
    const site = await siteForUser(me, id);
    active = !site.isActive;
    await prisma.artSite.update({ where: { id }, data: { isActive: active } });
    if (site.accessId) revalidatePath(`/sites/${site.accessId}`);
  } catch (e) { return fail(e); }
  revalidatePath(`${ART}/sites/${id}`);
  revalidatePath(`${ART}/sites`);
  revalidatePath(ART);
  return { ok: active ? "Сайт возвращён из архива" : "Сайт убран в архив: новые статьи не будут запускаться" };
}

/** Подтянуть категории WordPress по REST API в кэш сайта (ArtSite.wpCategories) — lib/articles/wp/categories.syncCategories. */
export async function syncSiteCategories(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  let count = 0;
  try {
    const site = await siteForUser(me, id);
    const a = site.access;
    if (!a || !a.username || !a.appPasswordEnc) throw new Error("У сайта нет доступа WordPress: укажите логин и Application Password в разделе «Сайты».");
    try {
      const cats = await syncCategories(site.id, { baseUrl: a.baseUrl, username: a.username, appPassword: decryptSecret(a.appPasswordEnc) });
      count = cats.length;
    } catch (e) {
      throw new Error(`WordPress не отдал категории: ${e instanceof Error ? e.message : String(e)}. Проверьте адрес сайта и доступ REST API на странице сайта.`);
    }
  } catch (e) { return fail(e); }
  revalidatePath(`${ART}/sites/${id}`);
  return { ok: count ? `Категории обновлены: ${count}` : "Категорий на сайте не найдено" };
}

/* ───────── Запуск ───────── */

function runSettingsFromForm(f: FormData, fallback: ArtSiteSettings): ArtRunSettings {
  const mode = str(f, "photoCountMode") === "range" ? "range" : "exact";
  const min = num(f, "photoMin", fallback.photoCount.min, 1, 60);
  const max = mode === "range" ? Math.max(min, num(f, "photoMax", fallback.photoCount.max, 1, 60)) : min;
  const photoCount: PhotoCountSetting = { mode, min, max };
  const publishMode = PUBLISH_MODES.some((m) => m.value === str(f, "publishMode")) ? (str(f, "publishMode") as PublishMode) : fallback.publishMode;
  const yearRaw = str(f, "yearInUrlPercent");
  return {
    recipeId: str(f, "recipeId"),
    photoCount,
    photoReview: flag(f, "photoReview"),
    publishMode,
    search: { country: str(f, "searchCountry").toLowerCase().slice(0, 8), language: str(f, "searchLanguage").toLowerCase().slice(0, 8), freshness: str(f, "searchFreshness").slice(0, 8) },
    yearInUrlPercent: yearRaw === "" ? null : num(f, "yearInUrlPercent", 0, 0, 100),
    testLabel: str(f, "testLabel").slice(0, 60),
  };
}

function parseKeywordsJson(raw: string): KeywordInput[] {
  if (!raw) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { throw new Error("Список ключей повреждён: обновите страницу и вставьте его снова"); }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x.keyword === "string")
    .map((x) => ({
      keyword: String(x.keyword), seoKeyword: typeof x.seoKeyword === "string" ? x.seoKeyword : undefined, focusKeyword: typeof x.focusKeyword === "string" ? x.focusKeyword : undefined,
      photoCount: typeof x.photoCount === "number" && Number.isFinite(x.photoCount) ? Math.min(60, Math.max(1, Math.round(x.photoCount))) : undefined,
    }));
}

/**
 * Запуск партии статей (страница «Новый запуск»). Пропущенные дубликаты показываются на карточке запуска через ?skipped=.
 * source=sheet — ключи из Google Таблицы: вкладка читается заново на сервере, сценарий и режим каждой статьи берутся из строки,
 * взятые строки получают статус «в работе» (lib/articles/sheets.ts).
 */
export async function launchArticlesAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let runId = "";
  let skipped: string[] = [];
  let sheetWarn = "";
  try {
    const siteId = str(f, "siteId");
    const site = await siteForUser(me, siteId);
    const siteSettings = mergeSiteSettings(site.settings);
    const settings = runSettingsFromForm(f, siteSettings);
    if (str(f, "source") === "sheet") {
      const sheetUrl = str(f, "sheetUrl").slice(0, 1000) || siteSettings.sheetUrl;
      if (!sheetUrl) throw new Error("Укажите ссылку на Google Таблицу");
      const plan = await planSheetImport(site, sheetUrl);
      if (!plan.ready.length) {
        const why = plan.skipped[0];
        throw new Error(why ? `Новых строк к запуску нет. Пропущено ${plan.skipped.length}: строка ${why.row} — ${why.reason}` : `Во вкладке «${plan.tab}» нет новых тем: у всех строк уже есть статус или ссылка на публикацию`);
      }
      // Запоминаем ссылку в настройках сайта — иначе обратная запись ссылок и дат после публикации будет пропущена
      if (sheetUrl !== siteSettings.sheetUrl) {
        // Только поле sheetUrl: остальные настройки берутся свежими из базы (не затираем параллельные правки).
        await updateSiteSettings(site.id, (raw) => ({ ...raw, sheetUrl }));
      }
      const r = await launchArticles(me, { siteId, settings: { ...settings, recipeId: "", sheet: { url: sheetUrl, tab: plan.tab } }, keywords: plan.ready, name: str(f, "name") });
      runId = r.runId;
      skipped = plan.skipped.map((x) => `строка ${x.row}: ${x.keyword} — ${x.reason}`);
      // Отмечаем взятые строки, чтобы не подтянуть их снова. Сбой отметки запуск не отменяет: статьи уже привязаны к строкам.
      try { await markRows(plan.spreadsheetId, plan.tab, r.sheetRows, "queued"); }
      catch (e) { sheetWarn = `Статьи поставлены в очередь, но статус «в работе» в таблицу не записался: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500); }
    } else {
      if (!settings.recipeId) throw new Error("Выберите сценарий");
      const keywords = parseKeywordsJson(str(f, "keywords"));
      if (!keywords.length) throw new Error("Добавьте хотя бы один ключ");
      const r = await launchArticles(me, { siteId, settings, keywords, name: str(f, "name") });
      runId = r.runId; skipped = r.skipped;
    }
  } catch (e) { return fail(e); }
  revalidatePath(ART);
  const q = new URLSearchParams();
  if (skipped.length) q.set("skipped", skipped.slice(0, 50).map((x) => x.slice(0, 160)).join("\n"));
  if (sheetWarn) q.set("sheetWarn", sheetWarn);
  const qs = q.toString();
  redirect(`${ART}/runs/${runId}${qs ? `?${qs}` : ""}`);
}

/* ───────── Google Таблицы ───────── */

export type SheetPreview = { tab: string; total: number; taken: number; ready: Array<{ row: number; keyword: string; recipe: string; photoReview: boolean; extras: string }>; skipped: SheetPlan["skipped"]; /** Ключи из «Неудачных ключей» сайта — только предупреждение */ failed?: FailedHint[] };

function previewOf(plan: SheetPlan): SheetPreview {
  return {
    tab: plan.tab, total: plan.total, taken: plan.taken, skipped: plan.skipped,
    ready: plan.ready.map((r) => ({
      row: r.sheetRow, keyword: r.keyword, recipe: `№${r.recipeNumber} · ${r.recipeName}`, photoReview: !!r.photoReview,
      extras: [r.yearInUrlPercent != null && `год в URL ${r.yearInUrlPercent}%`, r.search?.country && `гео ${r.search.country}`, r.search?.language && `язык ${r.search.language}`, r.search?.freshness && `свежесть ${r.search.freshness}`].filter(Boolean).join(", "),
    })),
  };
}

/** Предпросмотр импорта из Google Таблицы (вызывается из SheetImport напрямую): что пойдёт в работу и что пропустим. Ничего не пишет. */
export async function previewSheetImport(siteId: string, sheetUrl: string): Promise<{ preview?: SheetPreview; error?: string }> {
  const me = await requireUser();
  try {
    const site = await siteForUser(me, String(siteId));
    const url = String(sheetUrl ?? "").trim().slice(0, 1000) || mergeSiteSettings(site.settings).sheetUrl;
    if (!url) throw new Error("Укажите ссылку на Google Таблицу");
    const preview = previewOf(await planSheetImport(site, url));
    // Предупреждение «уже был неудачным» не блокирует запуск; сбой подсказки не мешает предпросмотру
    preview.failed = await failedKeywordHints(site.id, preview.ready.map((r) => r.keyword)).catch(() => []);
    return { preview };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Проверка таблицы сайта из настроек: доступ, вкладка с доменом сайта, сколько строк готово к запуску. */
export async function checkSiteSheet(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const site = await siteForUser(me, str(f, "id"));
    const url = mergeSiteSettings(site.settings).sheetUrl;
    if (!url) throw new Error("Сначала сохраните ссылку на Google Таблицу в настройках сайта (блок «Прочее»)");
    const plan = await planSheetImport(site, url);
    const why = plan.skipped.length ? ` Пропустим ${plan.skipped.length}: строка ${plan.skipped[0].row} — ${plan.skipped[0].reason}${plan.skipped.length > 1 ? " и другие" : ""}.` : "";
    return { ok: `Таблица доступна. Вкладка «${plan.tab}»: строк с ключом — ${plan.total}, уже в работе или опубликовано — ${plan.taken}, готово к запуску — ${plan.ready.length}.${why}` };
  } catch (e) { return fail(e); }
}

/** Ключ сервисного аккаунта Google для таблиц (общий для всех сайтов сервиса). Только администратор. Перед сохранением проверяем, что Google его принимает. */
export async function saveSheetsKey(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let email = "";
  try {
    if (me.role !== "ADMIN") throw new Error("Ключ Google Таблиц меняет только администратор");
    const raw = String(f.get("serviceKey") ?? "").trim();
    if (!raw) throw new Error("Вставьте содержимое JSON-файла ключа сервисного аккаунта");
    const key = parseServiceKey(raw);
    await fetchAccessToken(key);
    email = key.client_email;
    const data = { sheetsKeyEnc: encryptSecret(JSON.stringify(key)), sheetsEmail: email };
    await prisma.artSettings.upsert({ where: { id: "main" }, create: { id: "main", ...data }, update: data });
  } catch (e) { return fail(e); }
  revalidatePath(ART, "layout");
  return { ok: `Google Таблицы подключены. Дайте доступ «Редактор» к таблице для ${email}` };
}

export async function removeSheetsKey(_p: FormState, _f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    if (me.role !== "ADMIN") throw new Error("Ключ Google Таблиц меняет только администратор");
    await prisma.artSettings.updateMany({ where: { id: "main" }, data: { sheetsKeyEnc: null, sheetsEmail: null } });
  } catch (e) { return fail(e); }
  revalidatePath(ART, "layout");
  return { ok: "Ключ удалён: импорт из таблиц и запись отчётов отключены" };
}

/** Проверка дубликатов ключей по сайту до запуска (вызывается из KeywordsInput напрямую). */
export async function checkKeywordDuplicates(siteId: string, keywords: string[]): Promise<{ duplicates: string[]; failed?: FailedHint[]; error?: string }> {
  const me = await requireUser();
  try {
    await siteForUser(me, siteId);
    const list = Array.isArray(keywords) ? keywords.map(String).slice(0, 2000) : [];
    // «Неудачные ключи» сайта — только предупреждение; сбой подсказки не мешает проверке дубликатов
    const [duplicates, failed] = await Promise.all([findDuplicateKeywords(siteId, list), failedKeywordHints(siteId, list).catch(() => [])]);
    return { duplicates, failed };
  } catch (e) { return { duplicates: [], error: e instanceof Error ? e.message : String(e) }; }
}

/* ───────── Статьи: повтор / стоп / в очередь / удалить ───────── */

async function articleForUser(me: CurrentUser, id: string) {
  if (!(await canAccessArticle(me, id))) throw new Error("Статья не найдена");
  const a = await prisma.article.findUnique({ where: { id }, select: { id: true, siteId: true, runId: true, status: true, stage: true, format: true, errorStage: true, stopRequested: true } });
  if (!a) throw new Error("Статья не найдена");
  return a;
}

type Art = Awaited<ReturnType<typeof articleForUser>>;

/** Повторить с этапа: по умолчанию — с этапа ошибки или текущего. Для RUNNING — нельзя (сначала «Стоп»). */
async function retryArticle(a: Art, fromStage?: string): Promise<string> {
  if (a.status === "RUNNING") throw new Error("Статья сейчас выполняется: сначала нажмите «Остановить»");
  const list = stagesFor(a.format);
  let stage = (fromStage || a.errorStage || a.stage) as StageKey;
  if (!list.includes(stage)) stage = a.stage === "done" ? list[list.length - 1] : firstStage(a.format);
  if (a.stage === "done" && !fromStage) stage = list[list.length - 1];
  await prisma.article.update({
    where: { id: a.id },
    data: { status: "PENDING", stage, attempts: 0, error: null, errorStage: null, note: null, nextRunAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false, finishedAt: null },
  });
  return stage;
}

async function stopArticle(a: Art): Promise<string> {
  if (a.status === "RUNNING") {
    await prisma.article.update({ where: { id: a.id }, data: { stopRequested: true } });
    return "Остановка запрошена: воркер завершит текущий шаг и остановит статью";
  }
  if (a.status === "PENDING" || a.status === "PUBLISH_QUEUED") {
    await prisma.article.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
    return "Статья остановлена";
  }
  throw new Error("Статья сейчас не выполняется и не ждёт очереди");
}

/** В очередь с текущего этапа (без сброса этапа) — для остановленных, упавших и зависших. */
async function requeueArticle(a: Art): Promise<void> {
  if (a.status === "RUNNING") throw new Error("Статья уже выполняется");
  if (a.status === "COMPLETED") throw new Error("Статья уже опубликована. Если нужно опубликовать заново — «Повторить этап» → Публикация");
  const stage = stagesFor(a.format).includes(a.stage as StageKey) ? a.stage : firstStage(a.format);
  await prisma.article.update({
    where: { id: a.id },
    data: { status: "PENDING", stage, attempts: 0, error: null, errorStage: null, nextRunAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false },
  });
}

async function deleteArticle(a: Art): Promise<void> {
  if (a.status === "RUNNING") throw new Error("Статья выполняется: сначала остановите её");
  await prisma.article.delete({ where: { id: a.id } });
  await purgeArticleFiles(a.id).catch(() => {});
}

function revalidateArticle(a: Pick<Art, "id" | "siteId" | "runId">) {
  revalidatePath(`${ART}/articles/${a.id}`);
  revalidatePath(`${ART}/sites/${a.siteId}`);
  if (a.runId) revalidatePath(`${ART}/runs/${a.runId}`);
  revalidatePath(ART);
}

export async function retryArticleAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await articleForUser(me, str(f, "id"));
    const stage = await retryArticle(a, str(f, "stage") || undefined);
    revalidateArticle(a);
    return { ok: `Статья снова в очереди с этапа «${stageLabel(stage)}»` };
  } catch (e) { return fail(e); }
}

export async function stopArticleAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await articleForUser(me, str(f, "id"));
    const msg = await stopArticle(a);
    revalidateArticle(a);
    return { ok: msg };
  } catch (e) { return fail(e); }
}

export async function requeueArticleAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await articleForUser(me, str(f, "id"));
    await requeueArticle(a);
    revalidateArticle(a);
    return { ok: "Статья возвращена в очередь" };
  } catch (e) { return fail(e); }
}

export async function deleteArticleAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let a: Art | null = null;
  try {
    a = await articleForUser(me, str(f, "id"));
    await deleteArticle(a);
  } catch (e) { return fail(e); }
  if (!a) return { error: "Статья не найдена" };
  revalidateArticle(a);
  redirect(str(f, "back") || `${ART}/sites/${a.siteId}?tab=queue`);
}

export type BulkOp = "retry" | "stop" | "requeue" | "delete";

/** Массовое действие над отмеченными статьями (очередь сайта, карточка запуска). Ошибки по отдельным статьям — в сводке. */
export async function bulkArticlesAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const ids = [...new Set(f.getAll("ids").map(String).filter(Boolean))].slice(0, 500);
  const op = str(f, "op") as BulkOp;
  if (!ids.length) return { error: "Отметьте хотя бы одну статью" };
  if (!["retry", "stop", "requeue", "delete"].includes(op)) return { error: "Неизвестное действие" };
  let ok = 0;
  const problems: string[] = [];
  const touched = new Set<string>();
  for (const id of ids) {
    try {
      const a = await articleForUser(me, id);
      if (op === "retry") await retryArticle(a);
      else if (op === "stop") await stopArticle(a);
      else if (op === "requeue") await requeueArticle(a);
      else await deleteArticle(a);
      ok++;
      touched.add(`${a.siteId}|${a.runId ?? ""}`);
    } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  }
  for (const t of touched) { const [siteId, runId] = t.split("|"); revalidatePath(`${ART}/sites/${siteId}`); if (runId) revalidatePath(`${ART}/runs/${runId}`); }
  revalidatePath(ART);
  const verb = op === "retry" ? "снова в очереди" : op === "stop" ? "остановлено" : op === "requeue" ? "возвращено в очередь" : "удалено";
  const summary = `${verb}: ${ok} из ${ids.length}`;
  if (!ok) return { error: `Ничего не сделано. ${[...new Set(problems)].slice(0, 3).join("; ")}` };
  return { ok: problems.length ? `${summary}. Пропущено ${problems.length}: ${[...new Set(problems)].slice(0, 3).join("; ")}` : summary };
}

/* ───────── Правка текста ───────── */

export async function saveArticleMeta(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await articleForUser(me, str(f, "id"));
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const slug = str(f, "slug").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 190);
    await prisma.article.update({ where: { id: a.id }, data: { h1: str(f, "h1").slice(0, 300), metaTitle: str(f, "metaTitle").slice(0, 300), metaDescription: str(f, "metaDescription").slice(0, 1000), slug } });
    revalidateArticle(a);
    return { ok: "Мета сохранена. Если статья уже собрана, при публикации будут использованы новые значения." };
  } catch (e) { return fail(e); }
}

export async function saveSectionHtml(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const sectionId = str(f, "sectionId");
    const s = await prisma.artSection.findUnique({ where: { id: sectionId }, select: { id: true, articleId: true } });
    if (!s) throw new Error("Секция не найдена");
    const a = await articleForUser(me, s.articleId);
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const html = String(f.get("html") ?? "").trim();
    const words = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    await prisma.artSection.update({ where: { id: s.id }, data: { heading: has(f, "heading") ? str(f, "heading").slice(0, 500) : undefined, html, wordCount: words, status: html ? "written" : "planned" } });
    revalidateArticle(a);
    return { ok: "Секция сохранена. HTML статьи пересоберётся на этапе «Сборка HTML» (Повторить этап → Сборка)." };
  } catch (e) { return fail(e); }
}
