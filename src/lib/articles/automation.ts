/**
 * Экран «Автозапуск сайтов» сервиса «Статьи»: глобальные настройки (ArtSettings), строки сайтов со счётчиками
 * по шагам пути статьи и текстовая диагностика «что мешает сейчас».
 *
 * Оригинал: src/pages/SitesAutostartPage.tsx (счётчики, blockers), db/schema.sql site_autostart_diagnostics(),
 * queue-orchestrator/index.ts:779-840 (лимиты). Здесь всё считается на сервере одним groupBy.
 *
 * С 2026-10-15 цепочки сами не выключаются (автовыключение после 15 мин простоя убрано по просьбе владельца):
 * включено/выключено — только переключатели сайта и мастер-выключатели. Настройки сайта пишутся через
 * updateSiteSettings (сравнение по updatedAt), чтобы экран «Автозапуск» и форма настроек не затирали друг друга.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { ArtStatus, Prisma } from "@prisma/client";
import { artSiteWhere } from "./access";
import { mergeSiteSettings, SITE_LIMITS, SLOTS, type ArtSiteSettings, type SlotKey } from "./types";
import { phaseOf, type StagePhase } from "./stages";
import { slotAvailable } from "./ai";
import { undecidedArticleIds } from "./aiModeration";

/* ───────── Глобальные настройки (singleton ArtSettings id="main") ───────── */

export type ArtGlobalSettings = {
  photoMaster: boolean;
  writingMaster: boolean;
  publishMaster: boolean;
  /** Мастер ИИ-проверки фото: выключен — ИИ не проверяет ни на одном сайте (статьи ждут сотрудника), включён — там, где включено у сайта */
  aiModMaster: boolean;
  /** 0 — только ARTICLES_WORKER_CONCURRENCY */
  maxConcurrent: number;
  /** Устарело: автозапуск ИИ берёт «Запуск от» сайта (по умолчанию 1); поле оставлено для совместимости */
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
  /** Проверка фото ИИ по сайту (из статей PHOTO_REVIEW) */
  ai: AiReviewBrief;
  /** Устарело (= ai.waiting): совместимость со старыми клиентами */
  aiUntouched: number;
  /** Идёт запуск ИИ-модерации по сайту */
  aiRunning: boolean;
  published24h: number;
  blockers: Blocker[];
};

/**
 * Статьи на проверке фото по отношению к ИИ: checking — у идущего запуска ИИ (проверяются или стоят в его очереди),
 * waiting — свободны и ещё не проверены ИИ (автозапуск заберёт их за ~20 с, если ничего не мешает),
 * staff — у сотрудника: ИИ уже решил «людям», предложение ждёт решения, статья закреплена сотрудником или ИИ дважды не смог.
 * checking + waiting + staff = counts.review.
 */
export type AiReviewBrief = { on: boolean; checking: number; waiting: number; staff: number };

export type WorkerBrief = {
  /** Есть RUNNING с живой арендой — воркер отвечает */
  alive: boolean;
  /** Всего RUNNING с живой арендой (для общего потолка) */
  runningTotal: number;
  pending: number;
  /** RUNNING всего (в т.ч. с истёкшей арендой) */
  running: number;
  /** Потолок воркера ARTICLES_WORKER_CONCURRENCY (0 — воркер ещё не сообщил) */
  cap: number;
  /** Место на диске, МБ (null — воркер ещё не измерил) */
  disk: { storageMb: number; freeMb: number; totalMb: number; at: string } | null;
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
  ai: AiReviewBrief;
  aiRunning: boolean;
  published24h: number;
  /** Есть PENDING старше 3 мин в фазе */
  stale: Record<StagePhase, boolean>;
};

/**
 * Текст «что мешает сейчас» по сайту. Порядок — от самого важного: архив, выключатели, лимиты, ключи,
 * воркер, проверка фото (ИИ или сотрудник), проблемы, опубликовано за сутки. Пустой список невозможен: в конце — счётчик за сутки.
 */
export function autostartDiagnostics(site: DiagSite, counts: AutostartCounts, settings: ArtGlobalSettings, worker: WorkerBrief): Blocker[] {
  const out: Blocker[] = [];
  const a = site.autostart;
  const anyWait = counts.photoWait + counts.writeWait + counts.publishWait > 0;

  if (!site.isActive) {
    out.push({ bad: true, text: "Сайт в архиве — статьи не запускаются" });
    return out;
  }

  // 1. Поиск фото
  if (counts.photoWait > 0) {
    if (!settings.photoMaster) out.push({ bad: true, text: `Мастер-выключатель «Поиск фото» выключен — ждут ${counts.photoWait}` });
    else if (!a.photoEnabled) out.push({ bad: true, text: `Поиск фото на сайте выключен — ждут ${counts.photoWait}. Включите переключатель` });
    else if (counts.photoRun >= a.photoLimit) out.push({ text: `Поиск фото: занято ${counts.photoRun} из ${a.photoLimit}, ждут ${counts.photoWait}` });
    // Автобаланс очереди (worker/articles/queue.ts): перед написанием больше статей, чем лимит написания, — новые подборы ждут.
    else if (a.writingEnabled && settings.writingMaster && counts.writeWait > a.writingLimit) out.push({ text: `Новые подборы фото на паузе: перед написанием ждут ${counts.writeWait} (больше лимита написания ${a.writingLimit}) — места отданы написанию` });
    else {
      const miss = missingSlots(site.slots, "photos");
      if (miss.length) out.push({ bad: true, text: `Нет ключей для слота: ${miss.join(", ")} — назначьте ключ владельцу сайта` });
    }
  }
  // 3. Написание
  if (counts.writeWait > 0) {
    if (!settings.writingMaster) out.push({ bad: true, text: `Мастер-выключатель «Написание» выключен — ждут ${counts.writeWait}` });
    else if (!a.writingEnabled) out.push({ bad: true, text: `Написание на сайте выключено — ждут ${counts.writeWait}. Включите переключатель` });
    else if (counts.writeRun >= a.writingLimit) out.push({ text: `Написание: занято ${counts.writeRun} из ${a.writingLimit}, ждут ${counts.writeWait}` });
    else {
      const miss = missingSlots(site.slots, "writing");
      if (miss.length) out.push({ bad: true, text: `Нет ключей для слота: ${miss.join(", ")} — назначьте ключ владельцу сайта` });
    }
  }
  // 4. Публикация
  if (counts.publishWait > 0) {
    if (!settings.publishMaster) out.push({ bad: true, text: `Мастер-выключатель «Публикация» выключен — ждут ${counts.publishWait}` });
    else if (counts.publishRun >= a.publishLimit) out.push({ text: `Публикация: занято ${counts.publishRun} из ${a.publishLimit}, ждут ${counts.publishWait}` });
    else if (counts.publishRun > 0) out.push({ text: `Публикуются сейчас: ${counts.publishRun}` });
  }
  // Общий потолок
  if (settings.maxConcurrent > 0 && worker.runningTotal >= settings.maxConcurrent && anyWait) {
    out.push({ text: `Общий потолок ${settings.maxConcurrent} статей достигнут (в работе ${worker.runningTotal})` });
  }
  // Потолок воркера: больше cap статей сразу не идёт, какие бы ни были лимиты сайтов
  if (worker.cap > 0 && worker.runningTotal >= worker.cap && anyWait) {
    out.push({ text: `Потолок воркера ${worker.cap} статей занят (в работе ${worker.runningTotal}) — лимиты сайтов выше него не действуют` });
  }
  // Воркер: цепочка включена, есть старые PENDING, а живых аренд нет вовсе
  const chainsOn = (a.photoEnabled && settings.photoMaster && site.stale.photos) || (a.writingEnabled && settings.writingMaster && site.stale.writing) || (settings.publishMaster && site.stale.publish);
  if (!worker.alive && chainsOn) {
    out.push({ bad: true, text: "Воркер не отвечает: статьи ждут в очереди дольше 3 минут. Проверьте службу zewex-worker" });
  }
  // 2. Проверка фото: ИИ и сотрудники
  const m = site.aiModeration;
  const ai = site.ai;
  if (m.enabled && !settings.aiModMaster) {
    out.push({ bad: true, text: `ИИ-проверка фото включена на сайте, но выключена мастер-выключателем${counts.review ? ` — ${counts.review} ждут сотрудника` : ""}` });
  } else if (m.enabled) {
    if (site.slots && !site.slots.vision) out.push({ bad: true, text: "Для ИИ-проверки нет ключа «Зрение (оценка фото)» у владельца сайта" });
    if (ai.checking > 0) out.push({ text: `ИИ проверяет фото: ${ai.checking}` });
    if (ai.waiting > 0) {
      if (m.backlogThreshold > 0 && counts.publishWait >= m.backlogThreshold) out.push({ bad: true, text: `ИИ-проверка ждёт: в публикации ${counts.publishWait} ≥ ${m.backlogThreshold} (настройка «Ждать, если в публикации ≥»), ждут ${ai.waiting}` });
      else if (!site.aiRunning && m.batchFrom > 1 && ai.waiting < m.batchFrom) out.push({ text: `ИИ ждёт ${m.batchFrom} статей для запуска (сейчас ${ai.waiting}, не дольше 30 мин) — поставьте «Запуск от» 1, чтобы проверять сразу` });
      else out.push({ text: `Ждут ИИ: ${ai.waiting} — запуск в течение ~20 секунд` });
    }
    if (ai.staff > 0) out.push({ text: `Ждут сотрудника после ИИ: ${ai.staff}` });
  } else if (counts.review > 0) {
    out.push({ text: `Ждут проверки фото сотрудником: ${counts.review} (ИИ-проверка на сайте выключена)` });
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

  const [groups, aiRuns, pub, stale, workerRows] = await Promise.all([
    prisma.article.groupBy({ by: ["siteId", "status", "stage"], where: { ...siteIn, status: { not: "COMPLETED" } }, _count: { _all: true } }),
    prisma.artAiModerationRun.findMany({ where: { ...(ids.length ? { siteId: { in: ids } } : { siteId: "none" }), status: "running" }, select: { id: true, siteId: true } }),
    prisma.article.groupBy({ by: ["siteId"], where: { ...siteIn, status: "COMPLETED", publishedAt: { gte: since24h } }, _count: { _all: true } }),
    prisma.article.groupBy({ by: ["siteId", "stage"], where: { ...siteIn, status: "PENDING", updatedAt: { lt: staleCut }, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] }, _count: { _all: true } }),
    // Воркер общий для всех сайтов, поэтому считаем по всей таблице, а не по видимым.
    Promise.all([
      prisma.article.count({ where: { status: "RUNNING" } }),
      prisma.article.count({ where: { status: "RUNNING", leaseUntil: { gt: now } } }),
      prisma.article.count({ where: { status: "PENDING" } }),
      prisma.artSettings.findUnique({ where: { id: "main" }, select: { workerCap: true, storageMb: true, diskFreeMb: true, diskTotalMb: true, storageAt: true } }),
    ]),
  ]);
  const worker: WorkerBrief = { running: workerRows[0], runningTotal: workerRows[1], alive: workerRows[1] > 0, pending: workerRows[2], cap: workerRows[3]?.workerCap ?? 0,
    disk: workerRows[3]?.storageAt ? { storageMb: workerRows[3].storageMb, freeMb: workerRows[3].diskFreeMb, totalMb: workerRows[3].diskTotalMb, at: workerRows[3].storageAt.toISOString() } : null,
  };

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
  const running = new Set(aiRuns.map((r) => r.siteId));
  const aiBySite = await aiReviewBriefs(sites.map((s) => ({ id: s.id, on: mergeSiteSettings(s.settings).aiModeration.enabled && settings.aiModMaster })), aiRuns.map((r) => r.id), counts);
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
      ai: aiBySite.get(s.id)!, aiRunning: running.has(s.id), published24h: pub24.get(s.id) ?? 0,
      stale: staleMap.get(s.id) ?? { photos: false, writing: false, publish: false },
    };
    return {
      id: s.id, name: s.name, isActive: s.isActive, teamId: s.teamId, autostart: st.autostart, aiModeration: st.aiModeration, counts: c,
      ai: diag.ai, aiUntouched: diag.ai.waiting, aiRunning: diag.aiRunning, published24h: diag.published24h,
      blockers: autostartDiagnostics(diag, c, settings, worker),
    };
  });
  const totals = rows.reduce((acc, r) => addCounts(acc, r.counts), emptyCounts());
  return { sites: rows, totals, worker };
}

/** Закрепление статьи сотрудником, после которого она снова свободна (как CLAIM_TTL_MIN в types.ts). */
const CLAIM_STALE_MS = 15 * 60_000;

/** Разбивка PHOTO_REVIEW по сайтам: у ИИ / ждут ИИ / у сотрудника (см. AiReviewBrief). */
async function aiReviewBriefs(sites: Array<{ id: string; on: boolean }>, runningRunIds: string[], counts: Map<string, AutostartCounts>): Promise<Map<string, AiReviewBrief>> {
  const out = new Map<string, AiReviewBrief>();
  for (const s of sites) out.set(s.id, { on: s.on, checking: 0, waiting: 0, staff: counts.get(s.id)?.review ?? 0 });
  const onIds = sites.filter((s) => s.on && (counts.get(s.id)?.review ?? 0) > 0).map((s) => s.id);
  if (!onIds.length) return out;
  const claimCut = new Date(Date.now() - CLAIM_STALE_MS);
  const [held, free] = await Promise.all([
    runningRunIds.length
      ? prisma.article.groupBy({ by: ["siteId"], where: { siteId: { in: onIds }, status: "PHOTO_REVIEW", aiRunId: { in: runningRunIds } }, _count: { _all: true } })
      : Promise.resolve([] as Array<{ siteId: string; _count: { _all: number } }>),
    prisma.article.findMany({
      where: { siteId: { in: onIds }, status: "PHOTO_REVIEW", aiRunId: null, OR: [{ claimedById: null }, { claimedAt: null }, { claimedAt: { lt: claimCut } }] },
      select: { id: true, siteId: true },
      take: 5000,
    }),
  ]);
  const undecided = new Set(await undecidedArticleIds(free.map((f) => f.id)));
  for (const h of held) { const b = out.get(h.siteId); if (b) b.checking = h._count._all; }
  for (const f of free) { const b = out.get(f.siteId); if (b && undecided.has(f.id)) b.waiting++; }
  for (const b of out.values()) b.staff = Math.max(0, b.staff - b.checking - b.waiting);
  return out;
}

export async function automationPayload(me: CurrentUser): Promise<AutomationPayload> {
  const global = await loadArtSettings();
  const { sites, totals, worker } = await siteAutostartRows(me, global);
  return { sites, totals, global, worker, canEditGlobal: canEditGlobalSettings(me), at: new Date().toISOString() };
}

/* ───────── Правка настроек сайта ───────── */

export type SiteAutomationPatch = {
  autostart?: Partial<Pick<ArtSiteSettings["autostart"], "photoEnabled" | "photoLimit" | "writingEnabled" | "writingLimit" | "publishLimit">>;
  aiModeration?: Partial<Pick<ArtSiteSettings["aiModeration"], "enabled" | "batchFrom" | "concurrency" | "backlogThreshold" | "autoApply">>;
};

function clampInt(v: unknown, [min, max]: readonly [number, number]): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Проверить и нормализовать патч из API; ошибка — текст на русском. Старое поле autoRestart молча игнорируется. */
export function validateSitePatch(raw: unknown): { ok: true; patch: SiteAutomationPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Пустой патч" };
  const r = raw as { autostart?: Record<string, unknown>; aiModeration?: Record<string, unknown> };
  const patch: SiteAutomationPatch = {};
  const L = SITE_LIMITS;
  if (r.autostart && typeof r.autostart === "object") {
    const a: NonNullable<SiteAutomationPatch["autostart"]> = {};
    for (const k of ["photoEnabled", "writingEnabled"] as const) if (k in r.autostart) { if (typeof r.autostart[k] !== "boolean") return { ok: false, error: `Поле ${k} должно быть да/нет` }; a[k] = r.autostart[k] as boolean; }
    for (const k of ["photoLimit", "writingLimit", "publishLimit"] as const) if (k in r.autostart) { const n = clampInt(r.autostart[k], L[k]); if (n === null) return { ok: false, error: `Лимит ${k} — число от ${L[k][0]} до ${L[k][1]}` }; a[k] = n; }
    if (Object.keys(a).length) patch.autostart = a;
  }
  if (r.aiModeration && typeof r.aiModeration === "object") {
    const m: NonNullable<SiteAutomationPatch["aiModeration"]> = {};
    for (const k of ["enabled", "autoApply"] as const) if (k in r.aiModeration) { if (typeof r.aiModeration[k] !== "boolean") return { ok: false, error: `Поле ${k} должно быть да/нет` }; m[k] = r.aiModeration[k] as boolean; }
    for (const k of ["batchFrom", "concurrency", "backlogThreshold"] as const) if (k in r.aiModeration) { const n = clampInt(r.aiModeration[k], L[k]); if (n === null) return { ok: false, error: `Поле ${k} — число от ${L[k][0]} до ${L[k][1]}` }; m[k] = n; }
    if (Object.keys(m).length) patch.aiModeration = m;
  }
  if (!patch.autostart && !patch.aiModeration) return { ok: false, error: "В патче нет известных полей" };
  return { ok: true, patch };
}

/** Применить патч к настройкам сайта: меняются только присланные поля автозапуска и ИИ-модерации. */
export function applySitePatch(current: ArtSiteSettings, patch: SiteAutomationPatch): ArtSiteSettings {
  return {
    ...current,
    autostart: { ...current.autostart, ...(patch.autostart ?? {}) },
    aiModeration: { ...current.aiModeration, ...(patch.aiModeration ?? {}) },
  };
}

type RawSettings = Record<string, unknown>;

/**
 * Безопасная запись ArtSite.settings без потерянных обновлений: читаем строку, считаем новое значение и пишем,
 * только если updatedAt не изменился (иначе — заново, до 5 раз). mutate получает копию сырого JSON и возвращает
 * новый JSON целиком или null — «ничего не менять». extra — другие поля строки, которые пишутся вместе с настройками.
 * Возвращает true, если запись произошла.
 */
export async function updateSiteSettings(
  siteId: string,
  mutate: (raw: RawSettings) => RawSettings | null,
  extra?: (row: { name: string; nicheCode: string | null; defaultRecipeId: string | null }) => Omit<Prisma.ArtSiteUncheckedUpdateManyInput, "settings">,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await prisma.artSite.findUnique({ where: { id: siteId }, select: { settings: true, updatedAt: true, name: true, nicheCode: true, defaultRecipeId: true } });
    if (!row) throw new Error("Сайт не найден");
    const raw = row.settings && typeof row.settings === "object" && !Array.isArray(row.settings) ? (JSON.parse(JSON.stringify(row.settings)) as RawSettings) : {};
    const next = mutate(raw);
    if (!next) return false;
    const r = await prisma.artSite.updateMany({
      where: { id: siteId, updatedAt: row.updatedAt },
      data: { ...(extra ? extra(row) : {}), settings: next as Prisma.InputJsonValue } as Prisma.ArtSiteUncheckedUpdateManyInput,
    });
    if (r.count) return true;
  }
  throw new Error("Настройки сайта сейчас меняются в другом месте — обновите страницу и повторите");
}

/** Сохранить патч на сайте (без проверки прав — её делает вызывающий). Меняются только подобъекты autostart и aiModeration. */
export async function patchSiteAutomation(siteId: string, patch: SiteAutomationPatch): Promise<void> {
  await updateSiteSettings(siteId, (raw) => {
    const next = applySitePatch(mergeSiteSettings(raw), patch);
    return { ...raw, autostart: next.autostart, aiModeration: next.aiModeration };
  });
}
