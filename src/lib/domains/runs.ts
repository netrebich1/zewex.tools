/**
 * Подборы доменов: создание, доступ, выполнение в воркере, выбор доменов (вручную и ИИ).
 * Подбор видят автор, его команда и админы.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import type { DomainCandidate, DomainRun } from "@prisma/client";
import { buildCandidatesForBrand, cleanSuffix, dedupeTiers, normalizeTld, parseList, sanitizeLabel } from "./generator";
import { checkDomains } from "./availability";
import { DEFAULT_SETTINGS, getCountry, LIMITS, type DomainRunProgress, type DomainRunSettings, type MinedSuffix, type SerpSnapshot } from "./types";
import { rankDomainsWithAi, type AiPick } from "./ai";
import { balancePicks } from "./selection";
import { domainsOfBrand } from "./mining";

export const RUN_LEASE_SECONDS = 120;

/* ---------- Настройки ---------- */

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : d;
};

/** Разбор сохранённых настроек с подстановкой значений по умолчанию (старые записи не ломаются). */
export function parseSettings(json: unknown): DomainRunSettings {
  const s = (json ?? {}) as Partial<DomainRunSettings>;
  const tiers = Array.isArray(s.suffixTiers) ? s.suffixTiers : DEFAULT_SETTINGS.suffixTiers;
  return {
    brands: Array.isArray(s.brands) ? s.brands.map(String) : [],
    tlds: Array.isArray(s.tlds) ? s.tlds.map(String) : DEFAULT_SETTINGS.tlds,
    suffixTiers: [tiers[0] ?? [], tiers[1] ?? [], tiers[2] ?? []].map((t) => (Array.isArray(t) ? t.map(String) : [])) as [string[], string[], string[]],
    perBrand: num(s.perBrand, DEFAULT_SETTINGS.perBrand, 1, LIMITS.perBrandMax),
    extraPerBrand: num(s.extraPerBrand, DEFAULT_SETTINGS.extraPerBrand, 0, LIMITS.extraMax),
    allowHyphen: s.allowHyphen !== false,
    countryCode: typeof s.countryCode === "string" && s.countryCode ? s.countryCode : DEFAULT_SETTINGS.countryCode,
    serpKeyword: typeof s.serpKeyword === "string" ? s.serpKeyword : "",
    minedSuffixes: Array.isArray(s.minedSuffixes) ? (s.minedSuffixes as MinedSuffix[]) : [],
    serp: s.serp && typeof s.serp === "object" ? (s.serp as SerpSnapshot) : null,
  };
}

export type SettingsInput = {
  brands: string;
  tlds: string;
  tier1: string;
  tier2: string;
  tier3: string;
  perBrand: unknown;
  extraPerBrand: unknown;
  allowHyphen: boolean;
  countryCode: string;
  serpKeyword: string;
  minedSuffixes?: MinedSuffix[];
  serp?: SerpSnapshot | null;
};

/** Проверка и нормализация формы; бросает понятную ошибку. */
export function settingsFromInput(i: SettingsInput): DomainRunSettings {
  const brands = parseList(i.brands).map((b) => b.trim()).filter((b) => sanitizeLabel(b).replace(/[\s-]/g, "").length > 0);
  if (!brands.length) throw new Error("Добавьте хотя бы один бренд (латиницей, по одному в строке)");
  if (brands.length > LIMITS.brands) throw new Error(`Слишком много брендов: максимум ${LIMITS.brands}`);
  const tlds = Array.from(new Set(parseList(i.tlds).map(normalizeTld).filter(Boolean)));
  if (!tlds.length) throw new Error("Укажите хотя бы одну доменную зону, например com");
  if (tlds.length > LIMITS.tlds) throw new Error(`Слишком много зон: максимум ${LIMITS.tlds}`);
  const tiers = dedupeTiers([parseList(i.tier1), parseList(i.tier2), parseList(i.tier3)]);
  for (const t of tiers) if (t.length > LIMITS.suffixesPerTier) throw new Error(`В одном уровне не больше ${LIMITS.suffixesPerTier} приставок`);
  const countryCode = i.countryCode.trim().toLowerCase();
  if (!getCountry(countryCode)) throw new Error("Выберите страну из списка");
  return {
    brands,
    tlds,
    suffixTiers: tiers,
    perBrand: num(i.perBrand, DEFAULT_SETTINGS.perBrand, 1, LIMITS.perBrandMax),
    extraPerBrand: num(i.extraPerBrand, DEFAULT_SETTINGS.extraPerBrand, 0, LIMITS.extraMax),
    allowHyphen: i.allowHyphen,
    countryCode,
    serpKeyword: i.serpKeyword.trim().slice(0, 200),
    minedSuffixes: (i.minedSuffixes ?? []).slice(0, 100).map((m) => ({ suffix: cleanSuffix(String(m.suffix)), count: Number(m.count) || 0, examples: Array.isArray(m.examples) ? m.examples.slice(0, 3).map(String) : [] })).filter((m) => m.suffix),
    serp: i.serp ?? null,
  };
}

/* ---------- Доступ ---------- */

export function domainRunWhere(me: CurrentUser): Prisma.DomainRunWhereInput {
  if (me.role === "ADMIN") return {};
  return { OR: [{ createdById: me.id }, ...(me.teamIds.length ? [{ teamId: { in: me.teamIds } }] : [])] };
}

export function canAccessDomainRun(me: CurrentUser, run: { createdById: string; teamId: string | null }): boolean {
  if (me.role === "ADMIN") return true;
  if (run.createdById === me.id) return true;
  return run.teamId != null && me.teamIds.includes(run.teamId);
}

export async function requireRun(me: CurrentUser, id: string): Promise<DomainRun> {
  const run = await prisma.domainRun.findUnique({ where: { id } });
  if (!run || !canAccessDomainRun(me, run)) throw new Error("Подбор не найден");
  return run;
}

/* ---------- Создание и управление ---------- */

export async function createDomainRun(me: CurrentUser, settings: DomainRunSettings, name: string): Promise<{ id: string }> {
  const run = await prisma.domainRun.create({
    data: {
      teamId: me.teamIds[0] ?? null,
      createdById: me.id,
      name: name.trim().slice(0, 120) || new Date().toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }),
      status: "QUEUED",
      settings: settings as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: run.id };
}

export async function requestStopRun(me: CurrentUser, id: string): Promise<void> {
  const run = await requireRun(me, id);
  if (run.status === "QUEUED") {
    await prisma.domainRun.update({ where: { id }, data: { status: "STOPPED", finishedAt: new Date() } });
    return;
  }
  if (run.status === "RUNNING") await prisma.domainRun.update({ where: { id }, data: { stopRequested: true } });
}

export async function deleteDomainRun(me: CurrentUser, id: string): Promise<void> {
  const run = await requireRun(me, id);
  if (run.status === "RUNNING") throw new Error("Сначала остановите подбор");
  await prisma.domainRun.delete({ where: { id } });
}

/** Запустить подбор заново с теми же настройками: результаты стираются, подбор снова в очереди. */
export async function restartDomainRun(me: CurrentUser, id: string): Promise<void> {
  const run = await requireRun(me, id);
  if (run.status === "RUNNING") throw new Error("Подбор ещё выполняется");
  await prisma.$transaction([
    prisma.domainCandidate.deleteMany({ where: { runId: id } }),
    prisma.domainRun.update({ where: { id }, data: { status: "QUEUED", stopRequested: false, progress: Prisma.JsonNull, error: null, totalChecked: 0, totalAvailable: 0, totalGenerated: 0, incompleteBrands: Prisma.JsonNull, workerId: null, leaseUntil: null, startedAt: null, finishedAt: null } }),
  ]);
}

/* ---------- Выполнение (воркер) ---------- */

/** Атомарно берёт один подбор из очереди. */
export async function claimDomainRun(workerId: string): Promise<DomainRun | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM DomainRun WHERE status = 'QUEUED' ORDER BY createdAt ASC LIMIT 5`;
  for (const r of rows) {
    const n = await prisma.$executeRaw`UPDATE DomainRun SET status = 'RUNNING', workerId = ${workerId}, startedAt = COALESCE(startedAt, NOW(3)), leaseUntil = DATE_ADD(NOW(3), INTERVAL ${RUN_LEASE_SECONDS} SECOND) WHERE id = ${r.id} AND status = 'QUEUED'`;
    if (n === 1) return prisma.domainRun.findUniqueOrThrow({ where: { id: r.id } });
  }
  return null;
}

/** Подборы, чей воркер умер (lease истёк) или остались от прошлого процесса этого хоста, возвращаются в очередь. */
export async function requeueStaleDomainRuns(hostPrefix?: string): Promise<number> {
  const n = await prisma.$executeRaw`UPDATE DomainRun SET status = 'QUEUED', workerId = NULL, leaseUntil = NULL WHERE status = 'RUNNING' AND (leaseUntil < NOW(3) ${hostPrefix ? Prisma.sql`OR workerId LIKE ${hostPrefix + "-%"}` : Prisma.empty})`;
  return n;
}

type Row = Omit<DomainCandidate, "id" | "createdAt" | "aiScore" | "aiReason" | "selected">;

/**
 * Проверяет кандидатов бренд за брендом, пока не наберётся perBrand + запас свободных.
 * Все проверенные (в т.ч. занятые) сохраняются. При перезапуске готовые бренды пропускаются.
 */
export async function processDomainRun(run: DomainRun, workerId: string, shouldStop: () => boolean): Promise<void> {
  const settings = parseSettings(run.settings);
  const target = settings.perBrand + settings.extraPerBrand;
  const prev = (run.progress ?? null) as DomainRunProgress | null;
  const startAt = prev && prev.brandIndex > 0 && prev.brandIndex <= settings.brands.length ? prev.brandIndex : 0;
  // Бренд, на котором прервались: его частичные результаты стираем и проверяем заново.
  if (startAt < settings.brands.length) await prisma.domainCandidate.deleteMany({ where: { runId: run.id, brand: settings.brands[startAt] } });
  const agg = await prisma.domainCandidate.groupBy({ by: ["status"], where: { runId: run.id }, _count: { _all: true } });
  let totalChecked = agg.reduce((a, g) => a + g._count._all, 0);
  let totalAvailable = agg.find((g) => g.status === "available")?._count._all ?? 0;
  const incomplete: string[] = Array.isArray(run.incompleteBrands) ? (run.incompleteBrands as string[]) : [];
  let lastLease = Date.now();

  const stopped = async () => prisma.domainRun.update({ where: { id: run.id }, data: { status: "STOPPED", stopRequested: false, finishedAt: new Date(), workerId: null, leaseUntil: null, totalChecked, totalAvailable, incompleteBrands: incomplete } });
  // Воркер останавливается (деплой): подбор возвращается в очередь и продолжится с текущего бренда.
  const released = async () => prisma.domainRun.update({ where: { id: run.id }, data: { status: "QUEUED", workerId: null, leaseUntil: null, totalChecked, totalAvailable, incompleteBrands: incomplete } });

  const touch = async (brand: string, brandIndex: number): Promise<"go" | "stop" | "release" | "lost"> => {
    const rows = await prisma.$queryRaw<Array<{ stopRequested: number | boolean; workerId: string | null }>>`SELECT stopRequested, workerId FROM DomainRun WHERE id = ${run.id}`;
    const r = rows[0];
    if (!r || r.workerId !== workerId) return "lost";
    const progress: DomainRunProgress = { brand, brandIndex, brandsTotal: settings.brands.length, checked: totalChecked, available: totalAvailable, updatedAt: new Date().toISOString() };
    await prisma.$executeRaw`UPDATE DomainRun SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${RUN_LEASE_SECONDS} SECOND), progress = ${JSON.stringify(progress)}, totalChecked = ${totalChecked}, totalAvailable = ${totalAvailable} WHERE id = ${run.id}`;
    lastLease = Date.now();
    if (Boolean(r.stopRequested)) return "stop";
    if (shouldStop()) return "release";
    return "go";
  };

  for (let bi = startAt; bi < settings.brands.length; bi++) {
    const brand = settings.brands[bi]!;
    const state = await touch(brand, bi);
    if (state === "lost") return;
    if (state === "stop") { await stopped(); return; }
    if (state === "release") { await released(); return; }
    const candidates = buildCandidatesForBrand(brand, settings.suffixTiers, settings.tlds, { allowHyphen: settings.allowHyphen });
    // Пачка не больше 60: прогресс виден чаще, а аренда продлевается изнутри пачки (реестры .nl отвечают ~1 раз в секунду).
    const batchSize = Math.min(60, Math.max(12, target * 2));
    let found = 0;
    let order = 0;
    for (let i = 0; i < candidates.length && found < target; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      let renewing: Promise<unknown> | null = null;
      const results = await checkDomains(batch.map((c) => c.domain), {
        onResult: () => {
          if (Date.now() - lastLease < 20_000 || renewing) return;
          lastLease = Date.now();
          renewing = prisma.$executeRaw`UPDATE DomainRun SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${RUN_LEASE_SECONDS} SECOND) WHERE id = ${run.id} AND workerId = ${workerId}`.catch(() => {}).finally(() => { renewing = null; });
        },
      });
      if (renewing) await renewing;
      const byDomain = new Map(results.map((r) => [r.domain, r]));
      const now = new Date();
      const rows: Row[] = [];
      for (const c of batch) {
        const r = byDomain.get(c.domain);
        if (!r) continue;
        rows.push({ runId: run.id, brand: c.brand, domain: c.domain, tld: c.tld, suffix: c.suffix, tier: c.tier, pattern: c.pattern, status: r.status, source: r.source, checkedAt: now, sortOrder: order++ });
        if (r.status === "available") found++;
      }
      if (rows.length) await prisma.domainCandidate.createMany({ data: rows, skipDuplicates: true });
      totalChecked += rows.length;
      totalAvailable += rows.filter((r) => r.status === "available").length;
      if (Date.now() - lastLease > 20_000 || shouldStop()) {
        const s = await touch(brand, bi);
        if (s === "lost") return;
        if (s === "stop") { await stopped(); return; }
        if (s === "release") { await released(); return; }
      }
    }
    if (found < settings.perBrand && !incomplete.includes(brand)) incomplete.push(brand);
    await prisma.domainRun.update({ where: { id: run.id }, data: { incompleteBrands: incomplete, totalGenerated: { increment: candidates.length } } });
  }

  const progress: DomainRunProgress = { brand: "", brandIndex: settings.brands.length, brandsTotal: settings.brands.length, checked: totalChecked, available: totalAvailable, updatedAt: new Date().toISOString() };
  await prisma.domainRun.update({
    where: { id: run.id },
    data: { status: "DONE", finishedAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false, progress: progress as unknown as Prisma.InputJsonValue, totalChecked, totalAvailable, incompleteBrands: incomplete },
  });
}

export async function failDomainRun(id: string, error: string): Promise<void> {
  await prisma.domainRun.update({ where: { id }, data: { status: "FAILED", error: error.slice(0, 4000), finishedAt: new Date(), workerId: null, leaseUntil: null } });
}

/* ---------- Чтение и выбор ---------- */

export type RunDomainRow = {
  id: string;
  brand: string;
  domain: string;
  tld: string;
  suffix: string | null;
  tier: number;
  pattern: string;
  status: string;
  source: string;
  selected: boolean;
  aiScore: number | null;
  aiReason: string | null;
  sortOrder: number;
};

export async function runDomains(runId: string): Promise<RunDomainRow[]> {
  return prisma.domainCandidate.findMany({
    where: { runId },
    orderBy: [{ brand: "asc" }, { sortOrder: "asc" }],
    select: { id: true, brand: true, domain: true, tld: true, suffix: true, tier: true, pattern: true, status: true, source: true, selected: true, aiScore: true, aiReason: true, sortOrder: true },
  });
}

/** Отметить/снять домены вручную. */
export async function setSelection(me: CurrentUser, runId: string, changes: Array<{ id: string; selected: boolean }>): Promise<number> {
  await requireRun(me, runId);
  let n = 0;
  const on = changes.filter((c) => c.selected).map((c) => c.id);
  const off = changes.filter((c) => !c.selected).map((c) => c.id);
  if (on.length) n += (await prisma.domainCandidate.updateMany({ where: { runId, id: { in: on }, status: "available" }, data: { selected: true } })).count;
  if (off.length) n += (await prisma.domainCandidate.updateMany({ where: { runId, id: { in: off } }, data: { selected: false } })).count;
  return n;
}

export type AiSelectResult = { brand: string; picked: number; note: string | null; error: string | null; costUsd: number | null };

/**
 * ИИ-отбор для брендов: кандидаты — только свободные домены бренда (до 200); выбор заменяет текущий выбор бренда.
 * Балансировка: модель ранжирует больше вариантов, затем balancePicks выравнивает зоны/приставки.
 */
export async function aiSelectBrands(me: CurrentUser, runId: string, brands: string[], opts: { balanceZones: boolean; balanceSuffixes: boolean; take?: number }): Promise<AiSelectResult[]> {
  const run = await requireRun(me, runId);
  const settings = parseSettings(run.settings);
  const take = Math.max(1, Math.min(opts.take ?? settings.perBrand, 30));
  const balance = opts.balanceZones || opts.balanceSuffixes;
  const out: AiSelectResult[] = [];
  const wanted = brands.length ? settings.brands.filter((b) => brands.includes(b)) : settings.brands;
  for (const brand of wanted) {
    const rows = await prisma.domainCandidate.findMany({ where: { runId, brand, status: "available" }, orderBy: { sortOrder: "asc" }, take: LIMITS.aiCandidates });
    if (!rows.length) {
      out.push({ brand, picked: 0, note: "Нет свободных доменов", error: null, costUsd: null });
      continue;
    }
    const topDomains = settings.serp ? domainsOfBrand(settings.serp.domains, brand) : [];
    try {
      const askFor = balance ? Math.min(rows.length, Math.max(take * 3, 15)) : Math.min(rows.length, take);
      const r = await rankDomainsWithAi({ userId: me.id, teamId: run.teamId, refId: run.id }, {
        brand,
        take: askFor,
        countryCode: settings.countryCode,
        keyword: settings.serpKeyword || undefined,
        candidates: rows.map((x) => ({ domain: x.domain, suffix: x.suffix, tier: x.tier, pattern: x.pattern })),
        topDomains,
      });
      const byDomain = new Map(rows.map((x) => [x.domain, x]));
      const ranked = r.picks.map((p: AiPick) => ({ ...byDomain.get(p.domain)!, score: p.score, reason: p.reason })).filter((x) => x.id);
      const final = balance ? balancePicks(ranked, take, { zones: opts.balanceZones, suffixes: opts.balanceSuffixes }) : ranked.slice(0, take);
      const finalIds = new Set(final.map((x) => x.id));
      await prisma.$transaction([
        prisma.domainCandidate.updateMany({ where: { runId, brand }, data: { selected: false } }),
        ...ranked.map((x) => prisma.domainCandidate.update({ where: { id: x.id }, data: { aiScore: x.score, aiReason: x.reason, selected: finalIds.has(x.id) } })),
      ]);
      out.push({ brand, picked: final.length, note: r.note, error: null, costUsd: r.costUsd });
    } catch (e) {
      out.push({ brand, picked: 0, note: null, error: e instanceof Error ? e.message : String(e), costUsd: null });
      // Ключ отклонён/нет кредитов — дальше нет смысла гонять остальные бренды
      if (/кредит|не подключён|отклон/i.test(out[out.length - 1]!.error ?? "")) break;
    }
  }
  return out;
}

/** Сводка для списка подборов. */
export type RunListRow = { id: string; name: string; status: string; brands: number; tlds: number; perBrand: number; totalChecked: number; totalAvailable: number; selected: number; createdAt: Date; finishedAt: Date | null; progress: DomainRunProgress | null; error: string | null; countryCode: string };

export async function listRuns(me: CurrentUser, limit = 50): Promise<RunListRow[]> {
  const runs = await prisma.domainRun.findMany({ where: domainRunWhere(me), orderBy: { createdAt: "desc" }, take: limit });
  const selected = runs.length ? await prisma.domainCandidate.groupBy({ by: ["runId"], where: { runId: { in: runs.map((r) => r.id) }, selected: true }, _count: { _all: true } }) : [];
  const selMap = new Map(selected.map((s) => [s.runId, s._count._all]));
  return runs.map((r) => {
    const s = parseSettings(r.settings);
    return { id: r.id, name: r.name, status: r.status, brands: s.brands.length, tlds: s.tlds.length, perBrand: s.perBrand, totalChecked: r.totalChecked, totalAvailable: r.totalAvailable, selected: selMap.get(r.id) ?? 0, createdAt: r.createdAt, finishedAt: r.finishedAt, progress: (r.progress ?? null) as DomainRunProgress | null, error: r.error, countryCode: s.countryCode };
  });
}
