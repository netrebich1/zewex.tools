/**
 * Экран «Автозапуск сайтов» сервиса «Статьи»: глобальные настройки (ArtSettings), строки сайтов со счётчиками
 * по шагам пути статьи и текстовая диагностика «что мешает сейчас».
 *
 * Оригинал: src/pages/SitesAutostartPage.tsx (счётчики, blockers), db/schema.sql site_autostart_diagnostics(),
 * queue-orchestrator/index.ts:779-840 (лимиты, idle auto-off). Здесь всё считается на сервере одним groupBy.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { ArtStatus, Prisma } from "@prisma/client";
import { artSiteWhere } from "./access";
import { mergeSiteSettings, SLOTS, type ArtSiteSettings, type SlotKey } from "./types";
import { phaseOf, type StagePhase } from "./stages";
import { slotAvailable } from "./ai";

/* ───────── Глобальные настройки (singleton ArtSettings id="main") ───────── */

export type ArtGlobalSettings = {
  photoMaster: boolean;
  writingMaster: boolean;
  publishMaster: boolean;
  aiModMaster: boolean;
  /** 0 — только ARTICLES_WORKER_CONCURRENCY */
  maxConcurrent: number;
  aiModAutoBatch: number;
};

export const DEFAULT_GLOBAL_SETTINGS: ArtGlobalSettings = { photoMaster: true, writingMaster: true, publishMaster: true, aiModMaster: true, maxConcurrent: 0, aiModAutoBatch: 20 };

export async function loadArtSettings(): Promise<ArtGlobalSettings> {
  const row = await prisma.artSettings.findUnique({ where: { id: "main" } });
  if (!row) return { ...DEFAULT_GLOBAL_SETTINGS };
  return { photoMaster: row.photoMaster, writingMaster: row.writingMaster, publishMaster: row.publishMaster, aiModMaster: row.aiModMaster, maxConcurrent: row.maxConcurrent, aiModAutoBatch: row.aiModAutoBatch };
}

export async function saveArtSettings(patch: Partial<ArtGlobalSettings>): Promise<ArtGlobalSettings> {
  const data: Partial<ArtGlobalSettings> = {};
  if (typeof patch.photoMaster === "boolean") data.photoMaster = patch.photoMaster;
  if (typeof patch.writingMaster === "boolean") data.writingMaster = patch.writingMaster;
  if (typeof patch.publishMaster === "boolean") data.publishMaster = patch.publishMaster;
  if (typeof patch.aiModMaster === "boolean") data.aiModMaster = patch.aiModMaster;
  if (typeof patch.maxConcurrent === "number" && Number.isFinite(patch.maxConcurrent)) data.maxConcurrent = Math.max(0, Math.min(300, Math.round(patch.maxConcurrent)));
  if (typeof patch.aiModAutoBatch === "number" && Number.isFinite(patch.aiModAutoBatch)) data.aiModAutoBatch = Math.max(1, Math.min(200, Math.round(patch.aiModAutoBatch)));
  await prisma.artSettings.upsert({ where: { id: "main" }, create: { id: "main", ...DEFAULT_GLOBAL_SETTINGS, ...data }, update: data });
  return loadArtSettings();
}

/* ───────── Счётчики по шагам ───────── */

/** Путь статьи: 1 поиск фото → 2 ручная проверка → 3 написание → 4 публикация; отдельно — пауза/ошибка. */
export type AutostartCounts = {
  /** PENDING в фазе photos */
  photoWait: number;
  /** RUNNING в фазе photos */
  photoRun: number;
  /** PHOTO_REVIEW */
  review: number;
  /** INSUFFICIENT_PHOTOS + WAITING_FOR_PHOTOS */
  few: number;
  /** PENDING в фазе writing */
  writeWait: number;
  /** RUNNING в фазе writing */
  writeRun: number;
  /** PUBLISH_QUEUED + REVIEW_PENDING + PENDING на этапе publish */
  publishWait: number;
  /** PUBLISHING + RUNNING на этапе publish */
  publishRun: number;
  /** PAUSED + FAILED + PUBLISH_ERROR + STOPPED */
  problems: number;
  paused: number;
  failed: number;
};

export function emptyCounts(): AutostartCounts {
  return { photoWait: 0, photoRun: 0, review: 0, few: 0, writeWait: 0, writeRun: 0, publishWait: 0, publishRun: 0, problems: 0, paused: 0, failed: 0 };
}

/** В какой счётчик попадает группа статей; null — не показываем (COMPLETED, NEEDS_REWORK). */
export function countBucket(status: ArtStatus, stage: string): keyof AutostartCounts | null {
  const ph = phaseOf(stage);
  switch (status) {
    case "PENDING": return ph === "photos" ? "photoWait" : ph === "publish" ? "publishWait" : "writeWait";
    case "RUNNING": return ph === "photos" ? "photoRun" : ph === "publish" ? "publishRun" : "writeRun";
    case "PHOTO_REVIEW": return "review";
    case "INSUFFICIENT_PHOTOS": case "WAITING_FOR_PHOTOS": return "few";
    case "PUBLISH_QUEUED": case "REVIEW_PENDING": return "publishWait";
    case "PUBLISHING": return "publishRun";
    case "PAUSED": case "STOPPED": return "paused";
    case "FAILED": case "PUBLISH_ERROR": return "failed";
    default: return null;
  }
}

export function addCounts(a: AutostartCounts, b: AutostartCounts): AutostartCounts {
  const out = emptyCounts();
  for (const k of Object.keys(out) as Array<keyof AutostartCounts>) out[k] = a[k] + b[k];
  return out;
}

/* ───────── Ключи владельца сайта (кэш на минуту) ───────── */

/** Какие слоты нужны цепочке (формат «реальные фото»); photo_dfs/photo_serp — достаточно одного. */
const PHASE_SLOTS: Record<Exclude<StagePhase, "publish">, SlotKey[]> = {
  photos: [SLOTS.textFast, SLOTS.vision],
  writing: [SLOTS.textFast, SLOTS.textMain],
};
const SLOT_NAMES: Record<SlotKey, string> = {
  text_main: "Текст (основной)",
  text_fast: "Текст (быстрый)",
  vision: "Зрение (оценка фото)",
  image_main: "Генерация картинок",
  photo_dfs: "Поиск фото DataForSEO",
  photo_serp: "Поиск фото SerpAPI",
};

type SlotMap = Record<SlotKey, boolean>;
const slotCache = new Map<string, { at: number; slots: SlotMap }>();
const SLOT_CACHE_MS = 60_000;

/** Доступность всех слотов проекта для пользователя; не чаще раза в минуту на пользователя. */
export async function ownerSlots(userId: string): Promise<SlotMap> {
  const hit = slotCache.get(userId);
  if (hit && Date.now() - hit.at < SLOT_CACHE_MS) return hit.slots;
  const keys = Object.values(SLOTS) as SlotKey[];
  const flags = await Promise.all(keys.map((k) => slotAvailable(userId, k).catch(() => false)));
  const slots = Object.fromEntries(keys.map((k, i) => [k, flags[i]])) as SlotMap;
  slotCache.set(userId, { at: Date.now(), slots });
  return slots;
}

/** Слоты, которых не хватает цепочке. */
export function missingSlots(slots: SlotMap | null, phase: "photos" | "writing"): string[] {
  if (!slots) return [];
  const out = PHASE_SLOTS[phase].filter((k) => !slots[k]).map((k) => SLOT_NAMES[k]);
  if (phase === "photos" && !slots.photo_dfs && !slots.photo_serp) out.push("Поиск фото (DataForSEO или SerpAPI)");
  return out;
}

/* ───────── Строки сайтов ───────── */

export type Blocker = { text: string; bad?: boolean };

export type SiteAutostartRow = {
  id: string;
  name: string;
  isActive: boolean;
  teamId: string;
  autostart: ArtSiteSettings["autostart"];
  aiModeration: ArtSiteSettings["aiModeration"];
  counts: AutostartCounts;
  /** PHOTO_REVIEW без решения ИИ (не захвачены запуском ИИ-модерации) */
  aiUntouched: number;
  /** Идёт запуск ИИ-модерации по сайту */
  aiRunning: boolean;
  published24h: number;
  blockers: Blocker[];
};

export type WorkerBrief = {
  /** Есть RUNNING с живой арендой — воркер отвечает */
  alive: boolean;
  /** Всего RUNNING с живой арендой (для общего потолка) */
  runningTotal: number;
  pending: number;
  /** RUNNING всего (в т.ч. с истёкшей арендой) */
  running: number;
};

export type AutomationPayload = {
  sites: SiteAutostartRow[];
  totals: AutostartCounts;
  global: ArtGlobalSettings;
  worker: WorkerBrief;
  canEditGlobal: boolean;
  at: string;
};

/** Глобальные настройки меняют админ и лидер команды. */
export function canEditGlobalSettings(me: CurrentUser): boolean {
  return me.role === "ADMIN" || me.leadTeamIds.length > 0;
}

/** PENDING старше этого срока при включённых цепочках и молчащем воркере — «воркер не отвечает». */
const STALE_PENDING_MS = 3 * 60_000;

export type DiagSite = {
  isActive: boolean;
  autostart: ArtSiteSettings["autostart"];
  aiModeration: ArtSiteSettings["aiModeration"];
  /** null — владелец сайта неизвестен, ключи не проверяем */
  slots: SlotMap | null;
  aiUntouched: number;
  aiRunning: boolean;
  published24h: number;
  /** Есть PENDING старше 3 мин в фазе */
  stale: Record<StagePhase, boolean>;
};

/**
 * Текст «что мешает сейчас» по сайту. Порядок — от самого важного: архив, выключатели, лимиты, ключи,
 * воркер, ИИ-модерация, проблемы, опубликовано за сутки. Пустой список невозможен: в конце — «Всё в порядке».
 */
export function autostartDiagnostics(site: DiagSite, counts: AutostartCounts, settings: ArtGlobalSettings, worker: WorkerBrief): Blocker[] {
  const out: Blocker[] = [];
  const a = site.autostart;
  const anyWait = counts.photoWait + counts.writeWait + counts.publishWait > 0;

  if (!site.isActive) {
    out.push({ bad: true, text: "Сайт в архиве — статьи не запускаются" });
    return out;
  }

  const offReason = (r?: "idle" | "manual") => (r === "idle" ? " (очередь была пуста)" : r === "manual" ? " (вручную)" : "");

  // 1. Поиск фото
  if (counts.photoWait > 0) {
    if (!settings.photoMaster) out.push({ bad: true, text: `Мастер-выключатель «Поиск фото» выключен — ждут ${counts.photoWait}` });
    else if (!a.photoEnabled) out.push({ bad: true, text: `Поиск фото выключен${offReason(a.photoOffReason)}, ждут ${counts.photoWait}` });
    else if (counts.photoRun >= a.photoLimit) out.push({ text: `Лимит поиска фото исчерпан (${counts.photoRun} из ${a.photoLimit}), ждут ${counts.photoWait}` });
    else {
      const miss = missingSlots(site.slots, "photos");
      if (miss.length) out.push({ bad: true, text: `Нет ключей для слота: ${miss.join(", ")} — назначьте ключ владельцу сайта` });
    }
  }
  // 3. Написание
  if (counts.writeWait > 0) {
    if (!settings.writingMaster) out.push({ bad: true, text: `Мастер-выключатель «Написание» выключен — ждут ${counts.writeWait}` });
    else if (!a.writingEnabled) out.push({ bad: true, text: `Написание выключено${offReason(a.writingOffReason)}, ждут ${counts.writeWait}` });
    else if (counts.writeRun >= a.writingLimit) out.push({ text: `Лимит написания исчерпан (${counts.writeRun} из ${a.writingLimit}), ждут ${counts.writeWait}` });
    else {
      const miss = missingSlots(site.slots, "writing");
      if (miss.length) out.push({ bad: true, text: `Нет ключей для слота: ${miss.join(", ")} — назначьте ключ владельцу сайта` });
    }
  }
  // 4. Публикация
  if (counts.publishWait > 0) {
    if (!settings.publishMaster) out.push({ bad: true, text: `Мастер-выключатель «Публикация» выключен — ждут ${counts.publishWait}` });
    else if (counts.publishRun >= a.publishLimit) out.push({ text: `Лимит публикации исчерпан (${counts.publishRun} из ${a.publishLimit}), ждут ${counts.publishWait}` });
    else if (counts.publishRun > 0) out.push({ text: `Публикуются сейчас: ${counts.publishRun}` });
  }
  // Общий потолок
  if (settings.maxConcurrent > 0 && worker.runningTotal >= settings.maxConcurrent && anyWait) {
    out.push({ text: `Общий потолок ${settings.maxConcurrent} статей достигнут (в работе ${worker.runningTotal})` });
  }
  // Воркер: цепочка включена, есть старые PENDING, а живых аренд нет вовсе
  const chainsOn = (a.photoEnabled && settings.photoMaster && site.stale.photos) || (a.writingEnabled && settings.writingMaster && site.stale.writing) || (settings.publishMaster && site.stale.publish);
  if (!worker.alive && chainsOn) {
    out.push({ bad: true, text: "Воркер не отвечает: статьи ждут в очереди дольше 3 минут. Проверьте службу zewex-worker" });
  }
  // 2. Ручная проверка фото и ИИ-модерация
  if (counts.review > 0) {
    const m = site.aiModeration;
    if (!settings.aiModMaster) out.push({ text: `ИИ-проверка фото выключена мастер-выключателем — ${counts.review} ждут сотрудника` });
    else if (!m.enabled) out.push({ text: `ИИ-проверка выключена — ${counts.review} ждут сотрудника` });
    else {
      const done = counts.review - site.aiUntouched;
      if (done > 0) out.push({ text: `${done} уже проверены ИИ и отданы сотруднику` });
      if (site.aiRunning) out.push({ text: "ИИ проверяет фото сейчас" });
      else if (m.backlogThreshold > 0 && counts.publishWait >= m.backlogThreshold && site.aiUntouched > 0) out.push({ bad: true, text: `ИИ-проверка ждёт: в публикации ${counts.publishWait} ≥ ${m.backlogThreshold}` });
      else if (site.aiUntouched > 0 && site.aiUntouched < m.batchFrom) out.push({ text: `Ждёт пачку ИИ-модерации: ${site.aiUntouched} из ${m.batchFrom} — уменьшите «Запуск от»` });
    }
  }
  if (counts.few > 0) out.push({ bad: true, text: `Мало фото: ${counts.few} ждут решения модератора (добрать или закрыть)` });
  if (counts.failed > 0) out.push({ bad: true, text: `С ошибкой: ${counts.failed} — подробности в Журнале` });
  if (counts.paused > 0) out.push({ text: `На паузе или остановлены: ${counts.paused}` });
  out.push({ text: `Опубликовано за 24 ч: ${site.published24h}` });
  return out;
}

/** Строки таблицы «Автозапуск сайтов» по видимым сайтам + итоги + состояние воркера. */
export async function siteAutostartRows(me: CurrentUser, global?: ArtGlobalSettings): Promise<{ sites: SiteAutostartRow[]; totals: AutostartCounts; worker: WorkerBrief }> {
  const settings = global ?? (await loadArtSettings());
  const sites = await prisma.artSite.findMany({
    where: await artSiteWhere(me),
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, isActive: true, teamId: true, createdById: true, settings: true },
  });
  const ids = sites.map((s) => s.id);
  const now = new Date();
  const since24h = new Date(now.getTime() - 86_400_000);
  const staleCut = new Date(now.getTime() - STALE_PENDING_MS);
  const siteIn: Prisma.ArticleWhereInput = ids.length ? { siteId: { in: ids } } : { siteId: "none" };

  const [groups, aiUntouched, aiRuns, pub, stale, workerRows] = await Promise.all([
    prisma.article.groupBy({ by: ["siteId", "status", "stage"], where: { ...siteIn, status: { not: "COMPLETED" } }, _count: { _all: true } }),
    prisma.article.groupBy({ by: ["siteId"], where: { ...siteIn, status: "PHOTO_REVIEW", aiRunId: null }, _count: { _all: true } }),
    prisma.artAiModerationRun.findMany({ where: { ...(ids.length ? { siteId: { in: ids } } : { siteId: "none" }), status: "running" }, select: { siteId: true }, distinct: ["siteId"] }),
    prisma.article.groupBy({ by: ["siteId"], where: { ...siteIn, status: "COMPLETED", publishedAt: { gte: since24h } }, _count: { _all: true } }),
    prisma.article.groupBy({ by: ["siteId", "stage"], where: { ...siteIn, status: "PENDING", updatedAt: { lt: staleCut }, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] }, _count: { _all: true } }),
    // Воркер общий для всех сайтов, поэтому считаем по всей таблице, а не по видимым.
    Promise.all([
      prisma.article.count({ where: { status: "RUNNING" } }),
      prisma.article.count({ where: { status: "RUNNING", leaseUntil: { gt: now } } }),
      prisma.article.count({ where: { status: "PENDING" } }),
    ]),
  ]);
  const worker: WorkerBrief = { running: workerRows[0], runningTotal: workerRows[1], alive: workerRows[1] > 0, pending: workerRows[2] };

  const counts = new Map<string, AutostartCounts>();
  for (const id of ids) counts.set(id, emptyCounts());
  for (const g of groups) {
    const c = counts.get(g.siteId);
    if (!c) continue;
    const b = countBucket(g.status, g.stage);
    if (b) c[b] += g._count._all;
  }
  for (const c of counts.values()) c.problems = c.paused + c.failed;

  const staleMap = new Map<string, Record<StagePhase, boolean>>();
  for (const s of stale) {
    const m = staleMap.get(s.siteId) ?? { photos: false, writing: false, publish: false };
    m[phaseOf(s.stage)] = true;
    staleMap.set(s.siteId, m);
  }
  const untouched = new Map(aiUntouched.map((r) => [r.siteId, r._count._all]));
  const running = new Set(aiRuns.map((r) => r.siteId));
  const pub24 = new Map(pub.map((r) => [r.siteId, r._count._all]));

  // Ключи владельцев — по уникальным пользователям, с кэшем на минуту.
  const owners = [...new Set(sites.map((s) => s.createdById).filter((x): x is string => !!x))];
  const slotsByOwner = new Map<string, SlotMap>();
  await Promise.all(owners.map(async (u) => slotsByOwner.set(u, await ownerSlots(u))));

  const rows: SiteAutostartRow[] = sites.map((s) => {
    const st = mergeSiteSettings(s.settings);
    const c = counts.get(s.id)!;
    const diag: DiagSite = {
      isActive: s.isActive, autostart: st.autostart, aiModeration: st.aiModeration,
      slots: s.createdById ? slotsByOwner.get(s.createdById) ?? null : null,
      aiUntouched: untouched.get(s.id) ?? 0, aiRunning: running.has(s.id), published24h: pub24.get(s.id) ?? 0,
      stale: staleMap.get(s.id) ?? { photos: false, writing: false, publish: false },
    };
    return {
      id: s.id, name: s.name, isActive: s.isActive, teamId: s.teamId, autostart: st.autostart, aiModeration: st.aiModeration, counts: c,
      aiUntouched: diag.aiUntouched, aiRunning: diag.aiRunning, published24h: diag.published24h,
      blockers: autostartDiagnostics(diag, c, settings, worker),
    };
  });
  const totals = rows.reduce((acc, r) => addCounts(acc, r.counts), emptyCounts());
  return { sites: rows, totals, worker };
}

export async function automationPayload(me: CurrentUser): Promise<AutomationPayload> {
  const global = await loadArtSettings();
  const { sites, totals, worker } = await siteAutostartRows(me, global);
  return { sites, totals, global, worker, canEditGlobal: canEditGlobalSettings(me), at: new Date().toISOString() };
}

/* ───────── Правка настроек сайта ───────── */

export type SiteAutomationPatch = {
  autostart?: Partial<Pick<ArtSiteSettings["autostart"], "photoEnabled" | "photoLimit" | "writingEnabled" | "writingLimit" | "publishLimit" | "autoRestart">>;
  aiModeration?: Partial<Pick<ArtSiteSettings["aiModeration"], "enabled" | "batchFrom" | "concurrency" | "backlogThreshold" | "autoApply">>;
};

const LIMITS = { photoLimit: [1, 50], writingLimit: [1, 50], publishLimit: [1, 50], batchFrom: [1, 200], concurrency: [1, 50], backlogThreshold: [0, 1000] } as const;

function clampInt(v: unknown, [min, max]: readonly [number, number]): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Проверить и нормализовать патч из API; ошибка — текст на русском. */
export function validateSitePatch(raw: unknown): { ok: true; patch: SiteAutomationPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Пустой патч" };
  const r = raw as { autostart?: Record<string, unknown>; aiModeration?: Record<string, unknown> };
  const patch: SiteAutomationPatch = {};
  if (r.autostart && typeof r.autostart === "object") {
    const a: NonNullable<SiteAutomationPatch["autostart"]> = {};
    for (const k of ["photoEnabled", "writingEnabled", "autoRestart"] as const) if (k in r.autostart) { if (typeof r.autostart[k] !== "boolean") return { ok: false, error: `Поле ${k} должно быть да/нет` }; a[k] = r.autostart[k] as boolean; }
    for (const k of ["photoLimit", "writingLimit", "publishLimit"] as const) if (k in r.autostart) { const n = clampInt(r.autostart[k], LIMITS[k]); if (n === null) return { ok: false, error: `Лимит ${k} — число от ${LIMITS[k][0]} до ${LIMITS[k][1]}` }; a[k] = n; }
    patch.autostart = a;
  }
  if (r.aiModeration && typeof r.aiModeration === "object") {
    const m: NonNullable<SiteAutomationPatch["aiModeration"]> = {};
    for (const k of ["enabled", "autoApply"] as const) if (k in r.aiModeration) { if (typeof r.aiModeration[k] !== "boolean") return { ok: false, error: `Поле ${k} должно быть да/нет` }; m[k] = r.aiModeration[k] as boolean; }
    for (const k of ["batchFrom", "concurrency", "backlogThreshold"] as const) if (k in r.aiModeration) { const n = clampInt(r.aiModeration[k], LIMITS[k]); if (n === null) return { ok: false, error: `Поле ${k} — число от ${LIMITS[k][0]} до ${LIMITS[k][1]}` }; m[k] = n; }
    patch.aiModeration = m;
  }
  if (!patch.autostart && !patch.aiModeration) return { ok: false, error: "В патче нет известных полей" };
  return { ok: true, patch };
}

/**
 * Применить патч к настройкам сайта. Ручное включение/выключение цепочки сбрасывает служебные пометки простоя:
 * выключили вручную — offReason="manual" (автовключение такую цепочку не трогает, как триггер оригинала),
 * включили — пометки снимаются.
 */
export function applySitePatch(current: ArtSiteSettings, patch: SiteAutomationPatch): ArtSiteSettings {
  const next: ArtSiteSettings = { ...current, autostart: { ...current.autostart }, aiModeration: { ...current.aiModeration } };
  if (patch.autostart) {
    const a = next.autostart;
    Object.assign(a, patch.autostart);
    const nowIso = new Date().toISOString();
    if (typeof patch.autostart.photoEnabled === "boolean") {
      delete a.photoIdleSince;
      if (patch.autostart.photoEnabled) { delete a.photoOffReason; delete a.photoOffAt; } else { a.photoOffReason = "manual"; a.photoOffAt = nowIso; }
    }
    if (typeof patch.autostart.writingEnabled === "boolean") {
      delete a.writingIdleSince;
      if (patch.autostart.writingEnabled) { delete a.writingOffReason; delete a.writingOffAt; } else { a.writingOffReason = "manual"; a.writingOffAt = nowIso; }
    }
  }
  if (patch.aiModeration) Object.assign(next.aiModeration, patch.aiModeration);
  return next;
}

/** Сохранить патч на сайте (без проверки прав — её делает вызывающий). */
export async function patchSiteAutomation(siteId: string, patch: SiteAutomationPatch): Promise<void> {
  const site = await prisma.artSite.findUnique({ where: { id: siteId }, select: { settings: true } });
  if (!site) throw new Error("Сайт не найден");
  const next = applySitePatch(mergeSiteSettings(site.settings), patch);
  await prisma.artSite.update({ where: { id: siteId }, data: { settings: next as unknown as Prisma.InputJsonValue } });
}
