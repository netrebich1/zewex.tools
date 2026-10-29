"use server";
/**
 * Server actions сервиса инфо-статей: подключение сайта, настройки сайта, категории WordPress, запуск, действия над
 * постами (повтор с этапа / стоп / в очередь / удалить, массово), правка меты, секций и слотов фото, проверка перед
 * публикацией (одобрить / в доработку / заменить фото). Все мутации проверяют доступ (canAccessBlogSite / canAccessBlogPost).
 */
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { requireUser, type CurrentUser } from "@/lib/auth";
import { forSitesTab } from "@/lib/permissions";
import { decryptSecret } from "@/lib/crypto";
import { canAccessSiteAccess } from "@/lib/sites/access";
import { canAccessBlogPost, canAccessBlogSite } from "@/lib/blog/access";
import { BLOG, DEFAULT_SITE_SETTINGS, PROJECT_SLUG, PUBLISH_MODES, SITE_LIMITS, mergeSiteSettings, type BlogRunSettings, type BlogSiteSettings, type KeywordInput, type PublishMode, type ReviewMode } from "@/lib/blog/types";
import { findDuplicateKeywords } from "@/lib/blog/recipes";
import { launchPosts } from "@/lib/blog/launch";
import { markBlogRows, planBlogSheetImport, type BlogSheetPlan } from "@/lib/blog/sheets";
import type { SheetSite } from "@/lib/articles/sheets";
import { absPath, makeThumb, photoRel, photoThumbRel, publicUrl, purgePostFiles, removePath, toWpJpeg, writeFileAtomic } from "@/lib/blog/storage";
import { firstStage, isStage, stageLabel, type StageKey } from "@/lib/blog/stages";
import { syncBlogCategories } from "@/lib/blog/wp/categories";
import { buildCaption } from "@/lib/articles/photo/caption";

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

/* ───────── Сайты ───────── */

async function siteForUser(me: CurrentUser, id: string) {
  const site = await prisma.blogSite.findUnique({ where: { id }, include: { access: true } });
  if (!site || !(await canAccessBlogSite(me, site))) throw new Error("Сайт не найден");
  return site;
}

/** Включить сервис для сайта системы: BlogSite с настройками по умолчанию, привязанный к доступу WordPress. */
export async function enableBlogForSite(_p: FormState, f: FormData): Promise<FormState> {
  // Вызывается с вкладки «Сайты»: право «все сайты только там» действует как «все сайты».
  const me = forSitesTab(await requireUser());
  const accessId = str(f, "accessId");
  try {
    const access = await prisma.siteAccess.findUnique({ where: { id: accessId } });
    if (!access || !(await canAccessSiteAccess(me, accessId))) throw new Error("Сайт не найден");
    const pr = (access.projects as string[] | null) ?? [];
    if (pr.length && !pr.includes(PROJECT_SLUG)) throw new Error("В настройках доступа сайта не отмечен инструмент «Pin Blog Article»");
    const exists = await prisma.blogSite.findFirst({ where: { accessId } });
    if (exists) throw new Error("Сервис уже включён для этого сайта");
    const base = access.name.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "site";
    const taken = await prisma.blogSite.count({ where: { teamId: access.teamId, slug: base } });
    const slug = taken ? `${base}-${Date.now().toString(36)}` : base;
    const def = await prisma.blogRecipe.findFirst({ where: { isActive: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }], select: { id: true } });
    await prisma.blogSite.create({ data: { teamId: access.teamId, accessId, name: access.name, slug, defaultRecipeId: def?.id ?? null, settings: DEFAULT_SITE_SETTINGS as unknown as Prisma.InputJsonValue, createdById: me.id } });
  } catch (e) { return fail(e); }
  revalidatePath(`/sites/${accessId}`);
  revalidatePath("/sites");
  revalidatePath(BLOG);
  revalidatePath(`${BLOG}/sites`);
  return { ok: "Сервис инфо-статей включён. Проверьте сценарий по умолчанию и режим проверки в настройках сайта." };
}

function settingsFromForm(f: FormData, prev: BlogSiteSettings): BlogSiteSettings {
  const publishMode = PUBLISH_MODES.some((m) => m.value === str(f, "publishMode")) ? (str(f, "publishMode") as PublishMode) : prev.publishMode;
  const patterns = f.getAll("ruleP").map(String);
  const cats = f.getAll("ruleC").map(String);
  const rules = patterns.map((p, i) => ({ pattern: p.trim(), categoryId: Number(cats[i]) })).filter((r) => r.pattern && Number.isFinite(r.categoryId) && r.categoryId > 0);
  const yearRaw = str(f, "yearInUrlPercent");
  return {
    concurrency: num(f, "concurrency", prev.concurrency, SITE_LIMITS.concurrency[0], SITE_LIMITS.concurrency[1]),
    review: (str(f, "review") === "none" ? "none" : "before_publish") as ReviewMode,
    publishMode,
    categories: { section: has(f, "catSection") ? str(f, "catSection").slice(0, 100) : prev.categories.section, defaultId: str(f, "catDefaultId") ? num(f, "catDefaultId", 0, 0) || null : null, rules, useAi: flag(f, "catUseAi") },
    search: { country: str(f, "searchCountry").toLowerCase().slice(0, 8), language: str(f, "searchLanguage").toLowerCase().slice(0, 8) },
    yearInUrlPercent: yearRaw === "" ? null : num(f, "yearInUrlPercent", 0, 0, 100),
    sheetUrl: has(f, "sheetUrl") ? str(f, "sheetUrl").slice(0, 1000) : prev.sheetUrl,
  };
}

export async function saveBlogSiteSettings(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  try {
    const site = await siteForUser(me, id);
    const recipeId = str(f, "defaultRecipeId");
    if (recipeId && !(await prisma.blogRecipe.findUnique({ where: { id: recipeId }, select: { id: true } }))) throw new Error("Сценарий по умолчанию не найден");
    const settings = settingsFromForm(f, mergeSiteSettings(site.settings));
    await prisma.blogSite.update({ where: { id }, data: { name: has(f, "name") ? str(f, "name") || site.name : site.name, defaultRecipeId: has(f, "defaultRecipeId") ? recipeId || null : site.defaultRecipeId, settings: settings as unknown as Prisma.InputJsonValue } });
  } catch (e) { return fail(e); }
  revalidatePath(`${BLOG}/sites/${id}`);
  revalidatePath(`${BLOG}/sites`);
  revalidatePath(BLOG);
  return { ok: "Настройки сайта сохранены" };
}

export async function toggleBlogSiteActive(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  let active = false;
  try {
    const site = await siteForUser(me, id);
    active = !site.isActive;
    await prisma.blogSite.update({ where: { id }, data: { isActive: active } });
    if (site.accessId) revalidatePath(`/sites/${site.accessId}`);
  } catch (e) { return fail(e); }
  revalidatePath(`${BLOG}/sites/${id}`);
  revalidatePath(`${BLOG}/sites`);
  revalidatePath(BLOG);
  return { ok: active ? "Сайт возвращён из архива" : "Сайт убран в архив: новые посты не будут запускаться" };
}

export async function syncBlogSiteCategories(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  const id = str(f, "id");
  let count = 0;
  try {
    const site = await siteForUser(me, id);
    const a = site.access;
    if (!a || !a.username || !a.appPasswordEnc) throw new Error("У сайта нет доступа WordPress: укажите логин и Application Password в разделе «Сайты».");
    try {
      count = (await syncBlogCategories(site.id, { baseUrl: a.baseUrl, username: a.username, appPassword: decryptSecret(a.appPasswordEnc) })).length;
    } catch (e) {
      throw new Error(`WordPress не отдал категории: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) { return fail(e); }
  revalidatePath(`${BLOG}/sites/${id}`);
  return { ok: count ? `Категории обновлены: ${count}` : "Категорий на сайте не найдено" };
}

/* ───────── Запуск ───────── */

function runSettingsFromForm(f: FormData, fallback: BlogSiteSettings): BlogRunSettings {
  const publishMode = PUBLISH_MODES.some((m) => m.value === str(f, "publishMode")) ? (str(f, "publishMode") as PublishMode) : fallback.publishMode;
  const yearRaw = str(f, "yearInUrlPercent");
  const lmin = str(f, "lengthMin") ? num(f, "lengthMin", 0, 300, 6000) : 0;
  const lmax = str(f, "lengthMax") ? num(f, "lengthMax", 0, 300, 6000) : 0;
  const imin = str(f, "imagesMin") ? num(f, "imagesMin", 0, 1, 12) : 0;
  const imax = str(f, "imagesMax") ? num(f, "imagesMax", 0, 1, 12) : 0;
  return {
    recipeId: str(f, "recipeId"),
    review: (str(f, "review") === "none" ? "none" : "before_publish") as ReviewMode,
    publishMode,
    search: { country: str(f, "searchCountry").toLowerCase().slice(0, 8), language: str(f, "searchLanguage").toLowerCase().slice(0, 8) },
    yearInUrlPercent: yearRaw === "" ? null : num(f, "yearInUrlPercent", 0, 0, 100),
    length: lmin && lmax ? { min: lmin, max: lmax } : null,
    images: imin && imax ? { min: imin, max: imax } : null,
    testLabel: str(f, "testLabel").slice(0, 60),
  };
}

function parseKeywordsJson(raw: string): KeywordInput[] {
  if (!raw) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { throw new Error("Список ключей повреждён: обновите страницу и вставьте его снова"); }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => x as Record<string, unknown>).filter((x) => typeof x.keyword === "string").map((x) => ({ keyword: String(x.keyword), topic: typeof x.topic === "string" ? x.topic : undefined, focusKeyword: typeof x.focusKeyword === "string" ? x.focusKeyword : undefined }));
}

/** Сайт сервиса в форме, нужной модулю таблиц: домены из доступа WordPress (вкладка = домен). */
async function sheetSiteOf(site: { id: string; name: string; settings: unknown; accessId: string | null }): Promise<SheetSite> {
  const access = site.accessId ? await prisma.siteAccess.findUnique({ where: { id: site.accessId }, select: { baseUrl: true, linkDomain: true, name: true } }) : null;
  return { id: site.id, name: site.name, settings: site.settings, access };
}

/**
 * Запуск. source=sheet — ключи и темы из Google Таблицы: вкладка читается заново на сервере, взятые строки получают
 * «в работе», ссылка на таблицу сохраняется в настройках сайта (lib/blog/sheets.ts).
 */
export async function launchBlogAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let runId = "";
  let skipped: string[] = [];
  let sheetWarn = "";
  try {
    const siteId = str(f, "siteId");
    const site = await siteForUser(me, siteId);
    const siteSettings = mergeSiteSettings(site.settings);
    const settings = runSettingsFromForm(f, siteSettings);
    if (!settings.recipeId) throw new Error("Выберите сценарий");
    if (str(f, "source") === "sheet") {
      const sheetUrl = str(f, "sheetUrl").slice(0, 1000) || siteSettings.sheetUrl;
      if (!sheetUrl) throw new Error("Укажите ссылку на Google Таблицу");
      const plan = await planBlogSheetImport(await sheetSiteOf(site), sheetUrl);
      if (!plan.ready.length) throw new Error(plan.skipped.length ? `Нечего запускать: ${plan.skipped.slice(0, 5).map((s) => `строка ${s.row} — ${s.reason}`).join("; ")}` : "Новых строк к запуску нет: у всех строк вкладки уже есть статус или ссылка на публикацию");
      if (sheetUrl !== siteSettings.sheetUrl) {
        const fresh = await prisma.blogSite.findUniqueOrThrow({ where: { id: site.id }, select: { settings: true } });
        await prisma.blogSite.update({ where: { id: site.id }, data: { settings: { ...(fresh.settings as object ?? {}), sheetUrl } as Prisma.InputJsonValue } });
      }
      const r = await launchPosts(me, { siteId, settings, keywords: plan.ready, name: str(f, "name") || `${new Date().toLocaleDateString("ru-RU")} · таблица «${plan.tab}» · ${plan.ready.length}`, sheet: { tab: plan.tab } });
      runId = r.runId; skipped = [...r.skipped, ...plan.skipped.map((s) => `строка ${s.row}: ${s.keyword} — ${s.reason}`)];
      try { await markBlogRows(plan.spreadsheetId, plan.tab, r.sheetRows, "queued"); }
      catch (e) { sheetWarn = `Статьи поставлены в очередь, но статус «в работе» в таблицу не записался: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500); }
    } else {
      const keywords = parseKeywordsJson(str(f, "keywords"));
      if (!keywords.length) throw new Error("Добавьте хотя бы один ключ");
      const r = await launchPosts(me, { siteId, settings, keywords, name: str(f, "name") });
      runId = r.runId; skipped = r.skipped;
    }
  } catch (e) { return fail(e); }
  revalidatePath(BLOG);
  const q = new URLSearchParams();
  if (sheetWarn) q.set("sheetWarn", sheetWarn);
  if (skipped.length) q.set("skipped", skipped.slice(0, 50).map((x) => x.slice(0, 160)).join("\n"));
  const qs = q.toString();
  redirect(`${BLOG}/runs/${runId}${qs ? `?${qs}` : ""}`);
}

export type BlogSheetPreview = { tab: string; total: number; taken: number; ready: Array<{ row: number; keyword: string; topic: string; expectedType: string }>; skipped: BlogSheetPlan["skipped"]; warnings: string[] };

/** Предпросмотр импорта из Google Таблицы (вызывается из BlogSheetImport напрямую): что пойдёт в работу. Ничего не пишет. */
export async function previewBlogSheet(siteId: string, sheetUrl: string): Promise<{ preview?: BlogSheetPreview; error?: string }> {
  const me = await requireUser();
  try {
    const site = await siteForUser(me, siteId);
    const url = String(sheetUrl ?? "").trim().slice(0, 1000) || mergeSiteSettings(site.settings).sheetUrl;
    if (!url) throw new Error("Укажите ссылку на Google Таблицу");
    const plan = await planBlogSheetImport(await sheetSiteOf(site), url);
    return { preview: { tab: plan.tab, total: plan.total, taken: plan.taken, ready: plan.ready.map((r) => ({ row: r.sheetRow, keyword: r.keyword, topic: r.topic ?? "", expectedType: r.expectedType })), skipped: plan.skipped, warnings: plan.warnings } };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** Проверка дубликатов ключей по сайту до запуска (вызывается из формы напрямую). */
export async function checkBlogDuplicates(siteId: string, keywords: string[]): Promise<{ duplicates: string[]; error?: string }> {
  const me = await requireUser();
  try {
    await siteForUser(me, siteId);
    return { duplicates: await findDuplicateKeywords(siteId, Array.isArray(keywords) ? keywords.map(String).slice(0, 2000) : []) };
  } catch (e) { return { duplicates: [], error: e instanceof Error ? e.message : String(e) }; }
}

/* ───────── Посты ───────── */

async function postForUser(me: CurrentUser, id: string) {
  if (!(await canAccessBlogPost(me, id))) throw new Error("Статья не найдена");
  const p = await prisma.blogPost.findUnique({ where: { id }, select: { id: true, siteId: true, runId: true, status: true, stage: true, errorStage: true, stopRequested: true, cursor: true } });
  if (!p) throw new Error("Статья не найдена");
  return p;
}
type Post = Awaited<ReturnType<typeof postForUser>>;

async function retryPost(a: Post, fromStage?: string): Promise<string> {
  if (a.status === "RUNNING") throw new Error("Статья сейчас выполняется: сначала нажмите «Остановить»");
  let stage = (fromStage || a.errorStage || a.stage) as StageKey;
  if (!isStage(stage)) stage = a.stage === "done" ? "publish" : firstStage();
  if (a.stage === "done" && !fromStage) stage = "publish";
  await prisma.blogPost.update({ where: { id: a.id }, data: { status: "PENDING", stage, attempts: 0, error: null, errorStage: null, note: null, nextRunAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false, finishedAt: null } });
  return stage;
}

async function stopPost(a: Post): Promise<string> {
  if (a.status === "RUNNING") {
    await prisma.blogPost.update({ where: { id: a.id }, data: { stopRequested: true } });
    return "Остановка запрошена: воркер завершит текущий шаг и остановит статью";
  }
  if (a.status === "PENDING") {
    await prisma.blogPost.update({ where: { id: a.id }, data: { status: "STOPPED", workerId: null, leaseUntil: null, stopRequested: false } });
    return "Статья остановлена";
  }
  throw new Error("Статья сейчас не выполняется и не ждёт очереди");
}

async function requeuePost(a: Post): Promise<void> {
  if (a.status === "RUNNING") throw new Error("Статья уже выполняется");
  if (a.status === "COMPLETED") throw new Error("Статья уже опубликована. Чтобы опубликовать заново — «Повторить этап» → Публикация");
  const stage = isStage(a.stage) ? a.stage : firstStage();
  await prisma.blogPost.update({ where: { id: a.id }, data: { status: "PENDING", stage, attempts: 0, error: null, errorStage: null, nextRunAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false } });
}

async function deletePost(a: Post): Promise<void> {
  if (a.status === "RUNNING") throw new Error("Статья выполняется: сначала остановите её");
  await prisma.blogPost.delete({ where: { id: a.id } });
  await purgePostFiles(a.id).catch(() => {});
}

function revalidatePost(a: Pick<Post, "id" | "siteId" | "runId">) {
  revalidatePath(`${BLOG}/posts/${a.id}`);
  revalidatePath(`${BLOG}/sites/${a.siteId}`);
  if (a.runId) revalidatePath(`${BLOG}/runs/${a.runId}`);
  revalidatePath(`${BLOG}/review`);
  revalidatePath(BLOG);
}

export async function retryPostAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "id"));
    const stage = await retryPost(a, str(f, "stage") || undefined);
    revalidatePost(a);
    return { ok: `Статья снова в очереди с этапа «${stageLabel(stage)}»` };
  } catch (e) { return fail(e); }
}

export async function stopPostAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "id"));
    const msg = await stopPost(a);
    revalidatePost(a);
    return { ok: msg };
  } catch (e) { return fail(e); }
}

export async function requeuePostAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "id"));
    await requeuePost(a);
    revalidatePost(a);
    return { ok: "Статья возвращена в очередь" };
  } catch (e) { return fail(e); }
}

export async function deletePostAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  let a: Post | null = null;
  try {
    a = await postForUser(me, str(f, "id"));
    await deletePost(a);
  } catch (e) { return fail(e); }
  if (!a) return { error: "Статья не найдена" };
  revalidatePost(a);
  redirect(str(f, "back") || `${BLOG}/sites/${a.siteId}?tab=queue`);
}

export type BulkOp = "retry" | "stop" | "requeue" | "delete";

export async function bulkPostsAction(_p: FormState, f: FormData): Promise<FormState> {
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
      const a = await postForUser(me, id);
      if (op === "retry") await retryPost(a);
      else if (op === "stop") await stopPost(a);
      else if (op === "requeue") await requeuePost(a);
      else await deletePost(a);
      ok++;
      touched.add(`${a.siteId}|${a.runId ?? ""}`);
    } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  }
  for (const t of touched) { const [siteId, runId] = t.split("|"); revalidatePath(`${BLOG}/sites/${siteId}`); if (runId) revalidatePath(`${BLOG}/runs/${runId}`); }
  revalidatePath(BLOG);
  const verb = op === "retry" ? "снова в очереди" : op === "stop" ? "остановлено" : op === "requeue" ? "возвращено в очередь" : "удалено";
  const summary = `${verb}: ${ok} из ${ids.length}`;
  if (!ok) return { error: `Ничего не сделано. ${[...new Set(problems)].slice(0, 3).join("; ")}` };
  return { ok: problems.length ? `${summary}. Пропущено ${problems.length}: ${[...new Set(problems)].slice(0, 3).join("; ")}` : summary };
}

/* ───────── Правка текста и фото ───────── */

export async function savePostMeta(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "id"));
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const slug = str(f, "slug").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 190);
    await prisma.blogPost.update({ where: { id: a.id }, data: { h1: str(f, "h1").slice(0, 300), metaTitle: str(f, "metaTitle").slice(0, 300), metaDescription: str(f, "metaDescription").slice(0, 1000), slug } });
    revalidatePost(a);
    return { ok: "Мета сохранена. Чтобы она попала в HTML, пересоберите статью (Повторить этап → Сборка HTML) или опубликуйте повторно." };
  } catch (e) { return fail(e); }
}

export async function saveBlogSectionHtml(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const sectionId = str(f, "sectionId");
    const s = await prisma.blogSection.findUnique({ where: { id: sectionId }, select: { id: true, postId: true } });
    if (!s) throw new Error("Секция не найдена");
    const a = await postForUser(me, s.postId);
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const html = String(f.get("html") ?? "").trim();
    const words = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
    await prisma.blogSection.update({ where: { id: s.id }, data: { heading: has(f, "heading") ? str(f, "heading").slice(0, 500) : undefined, html, wordCount: words, status: html ? "written" : "planned", error: null } });
    revalidatePost(a);
    return { ok: "Секция сохранена. HTML статьи пересоберётся на этапе «Сборка HTML»." };
  } catch (e) { return fail(e); }
}

/** Вступление / выводы / заключение / дисклеймер в карточке статьи. */
export async function savePostParts(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "id"));
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const v = (k: string) => { const s = String(f.get(k) ?? "").trim(); return s || null; };
    await prisma.blogPost.update({ where: { id: a.id }, data: { introHtml: v("introHtml"), takeawaysHtml: v("takeawaysHtml"), conclusionHtml: v("conclusionHtml"), disclaimerHtml: v("disclaimerHtml") } });
    revalidatePost(a);
    return { ok: "Сохранено. Пересоберите статью, чтобы правки попали в HTML." };
  } catch (e) { return fail(e); }
}

/** Запрос слота картинки (для повторного поиска фото). */
export async function saveSlotQuery(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const slotId = str(f, "slotId");
    const slot = await prisma.blogImageSlot.findUnique({ where: { id: slotId }, select: { id: true, postId: true } });
    if (!slot) throw new Error("Слот не найден");
    const a = await postForUser(me, slot.postId);
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const query = str(f, "query").slice(0, 300);
    if (!query) throw new Error("Запрос пустой");
    await prisma.blogImageSlot.update({ where: { id: slot.id }, data: { query, altQuery: str(f, "altQuery").slice(0, 300) || null, mustShow: str(f, "mustShow").slice(0, 300) || null, avoid: str(f, "avoid").slice(0, 300) || null, searches: 0, status: "pending", chosenPhotoId: null } });
    revalidatePost(a);
    return { ok: "Слот обновлён. Нажмите «Повторить этап» → «Поиск фото», чтобы найти кадры по новому запросу." };
  } catch (e) { return fail(e); }
}

/** Заменить фото слота кандидатом из резерва: файл статьи и строка BlogPhoto пересоздаются. */
/** Видео статьи: «Убрать» (videoId пустой) или «Поставить другое» из кандидатов, прошедших правила. Сборка — при одобрении. */
export async function setPostVideo(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "postId"));
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const row = await prisma.blogPost.findUniqueOrThrow({ where: { id: a.id }, select: { video: true } });
    const st = (row.video ?? null) as { candidates?: Array<{ id: string; decision?: string }>; chosen?: unknown } | null;
    if (!st) throw new Error("Видео для статьи не подбиралось");
    const videoId = str(f, "videoId");
    const next = videoId ? st.candidates?.find((c) => c.id === videoId && c.decision === "embed") : null;
    if (videoId && !next) throw new Error("Это видео не прошло проверку — поставить нельзя");
    await prisma.blogPost.update({ where: { id: a.id }, data: { video: { ...st, chosen: next ?? null, manual: true } as Prisma.InputJsonValue } });
    revalidatePost(a);
    return { ok: next ? "Видео заменено. Одобрите статью — сборка пройдёт заново." : "Видео убрано. Одобрите статью — сборка пройдёт заново." };
  } catch (e) { return fail(e); }
}

export async function swapSlotPhoto(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const candId = str(f, "candidateId");
    const cand = await prisma.blogPhotoCandidate.findUnique({ where: { id: candId }, include: { slot: true } });
    if (!cand) throw new Error("Кандидат не найден");
    const a = await postForUser(me, cand.postId);
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    const post = await prisma.blogPost.findUniqueOrThrow({ where: { id: a.id }, select: { recipe: true, keyword: true } });
    const ps = ((post.recipe as { photoSearch?: { captionMode?: "domain_link" | "domain" | "none"; captionTemplate?: string } })?.photoSearch) ?? {};
    const bytes = cand.path ? await readFile(absPath(cand.path)).catch(() => null) : null;
    if (!bytes) throw new Error("Файл кандидата уже удалён — повторите этап «Поиск фото»");
    const old = await prisma.blogPhoto.findFirst({ where: { postId: a.id, slotKey: cand.slot.key } });
    const photoId = randomUUID();
    const jpeg = await toWpJpeg(bytes);
    const path = photoRel(a.id, photoId);
    const thumbPath = photoThumbRel(a.id, photoId);
    await writeFileAtomic(path, jpeg.bytes);
    await writeFileAtomic(thumbPath, await makeThumb(jpeg.bytes));
    await prisma.$transaction(async (tx) => {
      if (old) {
        await tx.blogPhoto.delete({ where: { id: old.id } });
        if (old.candidateId) await tx.blogPhotoCandidate.updateMany({ where: { id: old.candidateId }, data: { status: "reserve" } });
      }
      await tx.blogPhoto.create({
        data: {
          id: photoId, postId: a.id, slotKey: cand.slot.key, candidateId: cand.id, position: old?.position ?? 99, path, thumbPath, publicUrl: publicUrl(path),
          sourceUrl: cand.url.slice(0, 2000), sourcePageUrl: (cand.pageUrl || "").slice(0, 2000), sourceDomain: cand.domain || "", width: jpeg.width, height: jpeg.height, sha256: cand.sha256, phash: cand.phash,
          altText: (cand.aiDescription || cand.slot.query).slice(0, 300), caption: buildCaption({ captionMode: ps.captionMode ?? "domain_link", captionTemplate: ps.captionTemplate ?? "{credit} {domain}" }, cand.domain || null, cand.pageUrl || null) ?? "",
          description: cand.aiDescription, fileName: `${old?.position ?? 99}-${(cand.sha256 || "x").slice(0, 12)}.jpg`, aiScore: cand.aiScore,
        },
      });
      await tx.blogPhotoCandidate.update({ where: { id: cand.id }, data: { status: "chosen" } });
      await tx.blogImageSlot.update({ where: { id: cand.slotId }, data: { chosenPhotoId: photoId, status: "chosen" } });
    });
    if (old?.path) await removePath(old.path).catch(() => {});
    if (old?.thumbPath) await removePath(old.thumbPath).catch(() => {});
    revalidatePost(a);
    return { ok: `Фото слота «${cand.slot.key}» заменено. Пересоберите статью (Повторить этап → Сборка HTML) или одобрите — сборка пройдёт сама.` };
  } catch (e) { return fail(e); }
}

/** Убрать фото из статьи (слот остаётся пустым). Главное фото убрать нельзя. */
export async function excludeSlotPhoto(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const photoId = str(f, "photoId");
    const photo = await prisma.blogPhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw new Error("Фото не найдено");
    const a = await postForUser(me, photo.postId);
    if (a.status === "RUNNING") throw new Error("Статья выполняется: дождитесь окончания этапа или остановите её");
    if (photo.slotKey === "hero") throw new Error("Главное фото убрать нельзя — замените его кадром из резерва");
    await prisma.$transaction([
      prisma.blogPhoto.update({ where: { id: photo.id }, data: { excluded: true } }),
      prisma.blogImageSlot.updateMany({ where: { postId: photo.postId, key: photo.slotKey }, data: { chosenPhotoId: null, status: "empty" } }),
    ]);
    revalidatePost(a);
    return { ok: "Фото убрано из статьи. Пересоберите статью или одобрите — сборка пройдёт сама." };
  } catch (e) { return fail(e); }
}

/* ───────── Проверка перед публикацией ───────── */

/** Одобрить: пересборка (с учётом правок) и публикация. */
export async function approvePostAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "id"));
    if (!["REVIEW_PENDING", "NEEDS_REWORK", "FAILED", "PUBLISH_ERROR", "STOPPED"].includes(a.status)) throw new Error("Статья сейчас не ждёт проверки");
    const cursor = { ...((a.cursor ?? {}) as Record<string, unknown>), reviewApproved: true };
    await prisma.blogPost.update({ where: { id: a.id }, data: { status: "PENDING", stage: "pin_images", cursor: cursor as Prisma.InputJsonValue, reviewedById: me.id, reviewedAt: new Date(), reviewNote: str(f, "note").slice(0, 1000) || null, attempts: 0, error: null, errorStage: null, note: null, nextRunAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false } });
    revalidatePost(a);
    return { ok: "Статья одобрена: пересборка и публикация в очереди" };
  } catch (e) { return fail(e); }
}

/** В доработку: план заново (outline) или только текст (write). */
export async function reworkPostAction(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  try {
    const a = await postForUser(me, str(f, "id"));
    if (a.status === "RUNNING") throw new Error("Статья выполняется: сначала остановите её");
    const what = str(f, "what") === "outline" ? "outline" : "write";
    const note = str(f, "note").slice(0, 1000) || null;
    await prisma.$transaction(async (tx) => {
      if (what === "outline") {
        await tx.blogSection.deleteMany({ where: { postId: a.id } });
        await tx.blogPhoto.deleteMany({ where: { postId: a.id } });
        await tx.blogImageSlot.deleteMany({ where: { postId: a.id } });
        await tx.blogPhotoCandidate.deleteMany({ where: { postId: a.id } });
      } else {
        await tx.blogSection.updateMany({ where: { postId: a.id }, data: { html: null, wordCount: 0, status: "planned", error: null } });
      }
      const cursor = { ...((a.cursor ?? {}) as Record<string, unknown>) };
      delete cursor.reviewApproved; delete cursor.qualityRewritten; delete cursor.wrapRewritten;
      await tx.blogPost.update({ where: { id: a.id }, data: { status: "PENDING", stage: what, cursor: cursor as Prisma.InputJsonValue, introHtml: null, takeawaysHtml: null, conclusionHtml: null, disclaimerHtml: null, faq: Prisma.DbNull, html: null, reviewNote: note, reviewedAt: null, reviewedById: me.id, attempts: 0, error: null, errorStage: null, note: note ? `Доработка: ${note}` : null, nextRunAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false } });
    });
    if (what === "outline") await purgePostFiles(a.id).catch(() => {});
    revalidatePost(a);
    return { ok: what === "outline" ? "Статья отправлена на новый план: фото и текст будут сделаны заново" : "Текст секций будет написан заново по тому же плану и с теми же фото" };
  } catch (e) { return fail(e); }
}

/* ───────── Глобальные настройки ───────── */

export async function saveBlogSettings(_p: FormState, f: FormData): Promise<FormState> {
  const me = await requireUser();
  if (me.role !== "ADMIN") return { error: "Общие настройки меняет только администратор" };
  try {
    await prisma.blogSettings.upsert({ where: { id: "main" }, update: { master: flag(f, "master"), maxConcurrent: num(f, "maxConcurrent", 0, 0, 200) }, create: { id: "main", master: flag(f, "master"), maxConcurrent: num(f, "maxConcurrent", 0, 0, 200) } });
  } catch (e) { return fail(e); }
  revalidatePath(BLOG);
  return { ok: "Общие настройки сохранены" };
}
