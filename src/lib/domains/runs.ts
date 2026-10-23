/**
 * Подборы доменов: создание, доступ, выполнение в воркере, выбор доменов (вручную и ИИ).
 * Подбор видят автор, его команда и админы.
 */
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import type { DomainCandidate, DomainRun } from "@prisma/client";
import { brandTiers, brandTlds, buildCandidatesForBrand, cleanSuffix, dedupeTiers, modifierPool, normalizeTld, parseBrandLines, parseList } from "./generator";
import { checkDomains } from "./availability";
import { DEFAULT_SETTINGS, getCountry, itemKey, LIMITS, type BrandItem, type BrandModifier, type BrandResearchSummary, RESEARCH_SOURCE_LABELS, type ResearchSourceKind, type CountryPreset, type DomainRunProgress, type DomainRunSettings, type LetterMode, type MinedSuffix, type SerpSnapshot } from "./types";
import { rankDomainsWithAi, type AiPick } from "./ai";
import { balancePicks } from "./selection";
import { researchBrand, type BrandResearch } from "./research";
import { keptModifiers, researchSummary } from "./researchSummary";
import { domainsKeyTeamId } from "./keyTeam";
import { domainsOfBrand } from "./mining";
import { defaultCountryPreset, normalizePreset } from "./presets";

export const RUN_LEASE_SECONDS = 120;

/* ---------- Настройки ---------- */

const num = (v: unknown, d: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : d;
};

const LETTER_MODES: LetterMode[] = ["off", "after1", "last"];

function normalizeModifiers(raw: unknown): BrandModifier[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: BrandModifier[] = [];
  for (const m of raw as Array<Partial<BrandModifier>>) {
    const suffix = cleanSuffix(String(m?.suffix ?? ""));
    if (!suffix || suffix.length > 20 || seen.has(suffix)) continue;
    seen.add(suffix);
    const tier = m?.tier === 1 || m?.tier === 2 || m?.tier === 3 ? m.tier : 3;
    const sources = Array.isArray(m?.sources) ? m.sources.filter((x): x is ResearchSourceKind => x in RESEARCH_SOURCE_LABELS) : [];
    out.push({
      suffix,
      tier,
      volume: Math.max(0, Number(m?.volume) || 0),
      ...(m?.query ? { query: String(m.query).slice(0, 120) } : {}),
      ...(sources.length ? { sources } : {}),
      ...(m?.reason ? { reason: String(m.reason).slice(0, 120) } : {}),
    });
    if (out.length >= LIMITS.modifiersPerBrand) break;
  }
  return out;
}

function normalizeResearch(raw: unknown): BrandResearchSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<BrandResearchSummary>;
  const arr = <T,>(v: unknown, n: number): T[] => (Array.isArray(v) ? (v as T[]).slice(0, n) : []);
  return {
    origin: r.origin === "form" ? "form" : "auto",
    at: typeof r.at === "string" ? r.at : "",
    queries: Math.max(0, Number(r.queries) || 0),
    competitorDomains: arr<unknown>(r.competitorDomains, 20).map(String),
    competitorTlds: arr<{ value?: unknown; count?: unknown }>(r.competitorTlds, 10).map((t) => ({ value: String(t?.value ?? ""), count: Number(t?.count) || 0 })).filter((t) => t.value),
    rejected: arr<{ suffix?: unknown; word?: unknown; volume?: unknown; reason?: unknown }>(r.rejected, 40).map((x) => ({ suffix: String(x?.suffix ?? ""), word: String(x?.word ?? x?.suffix ?? ""), volume: Number(x?.volume) || 0, reason: String(x?.reason ?? "").slice(0, 120) })).filter((x) => x.suffix),
    errors: arr<unknown>(r.errors, 5).map((e) => String(e).slice(0, 300)),
    costUsd: Number(r.costUsd) || 0,
  };
}

/** Бренд пачки из JSON: модификаторы и итог сбора ключей (если был). */
function normalizeItem(it: Partial<BrandItem> | undefined, fallbackCountry: string): BrandItem {
  const research = normalizeResearch(it?.research);
  const tlds = Array.isArray(it?.tlds) ? Array.from(new Set(it.tlds.map((t) => normalizeTld(String(t))).filter(Boolean))).slice(0, 20) : [];
  return { brand: String(it?.brand ?? ""), country: typeof it?.country === "string" && it.country ? it.country : fallbackCountry, modifiers: normalizeModifiers(it?.modifiers), ...(research ? { research } : {}), ...(tlds.length ? { tlds } : {}) };
}

/** Разбор сохранённых настроек с подстановкой значений по умолчанию (старые записи не ломаются). */
export function parseSettings(json: unknown): DomainRunSettings {
  const s = (json ?? {}) as Partial<DomainRunSettings>;
  const tiers = Array.isArray(s.suffixTiers) ? s.suffixTiers : DEFAULT_SETTINGS.suffixTiers;
  const countryCode = typeof s.countryCode === "string" && s.countryCode ? s.countryCode : DEFAULT_SETTINGS.countryCode;
  const brands = Array.isArray(s.brands) ? s.brands.map(String) : [];
  // Старые подборы: одна страна на всю пачку, без модификаторов
  const items: BrandItem[] = Array.isArray(s.items) && s.items.length
    ? (s.items as Array<Partial<BrandItem>>).map((it) => normalizeItem(it, countryCode)).filter((it) => it.brand)
    : brands.map((brand) => ({ brand, country: countryCode, modifiers: [] }));
  const presets: Record<string, CountryPreset> = {};
  if (s.countryPresets && typeof s.countryPresets === "object") for (const [k, v] of Object.entries(s.countryPresets)) presets[k] = normalizePreset(v);
  return {
    brands: items.map((it) => it.brand),
    items,
    countryPresets: presets,
    // У старых подборов буквы и запаса не было — не включаем их задним числом
    letterMode: LETTER_MODES.includes(s.letterMode as LetterMode) ? (s.letterMode as LetterMode) : "off",
    usePool: s.usePool === true,
    // У старых подборов сбора ключей перед проверкой не было
    autoResearch: s.autoResearch === true,
    // Старые подборы останавливались на perBrand + запас и брали только общие зоны
    checkAll: s.checkAll === true,
    autoZones: s.autoZones === true,
    tlds: Array.isArray(s.tlds) ? s.tlds.map(String) : DEFAULT_SETTINGS.tlds,
    suffixTiers: [tiers[0] ?? [], tiers[1] ?? [], tiers[2] ?? []].map((t) => (Array.isArray(t) ? t.map(String) : [])) as [string[], string[], string[]],
    perBrand: num(s.perBrand, DEFAULT_SETTINGS.perBrand, 1, LIMITS.perBrandMax),
    extraPerBrand: num(s.extraPerBrand, DEFAULT_SETTINGS.extraPerBrand, 0, LIMITS.extraMax),
    allowHyphen: s.allowHyphen !== false,
    countryCode,
    serpKeyword: typeof s.serpKeyword === "string" ? s.serpKeyword : "",
    minedSuffixes: Array.isArray(s.minedSuffixes) ? (s.minedSuffixes as MinedSuffix[]) : [],
    serp: s.serp && typeof s.serp === "object" ? (s.serp as SerpSnapshot) : null,
  };
}

export type SettingsInput = {
  /** Поле «Бренды» как есть: строки «бренд ; FR» */
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
  letterMode?: string;
  usePool?: boolean;
  /** Собрать ключи и выдачу по брендам перед проверкой */
  autoResearch?: boolean;
  /** Проверять все варианты бренда */
  checkAll?: boolean;
  /** Добавлять зону страны и зоны конкурентов из выдачи */
  autoZones?: boolean;
  /** Модификаторы брендов и итог сбора ключей из формы */
  items?: Array<{ brand: string; country: string; modifiers: unknown; research?: unknown }>;
  /** Наборы стран из формы: берутся только доп. зоны, гео-приставки — из встроенной базы */
  countryPresets?: Record<string, unknown>;
  minedSuffixes?: MinedSuffix[];
  serp?: SerpSnapshot | null;
};

/** Проверка и нормализация формы; бросает понятную ошибку. */
export function settingsFromInput(i: SettingsInput): DomainRunSettings {
  const parsed = parseBrandLines(i.brands);
  if (parsed.problems.length) throw new Error(`Исправьте список брендов (формат «бренд ; FR»): ${parsed.problems.slice(0, 3).join(" · ")}${parsed.problems.length > 3 ? ` · и ещё ${parsed.problems.length - 3}` : ""}`);
  if (!parsed.items.length) throw new Error("Добавьте хотя бы один бренд в формате «бренд ; FR»");
  const picked = i.countryCode.trim().toLowerCase();
  // Страна пачки из формы — только подсказка для следующего подбора; у каждого бренда своя страна из строки
  const countryCode = getCountry(picked) ? picked : parsed.items[0]!.country;
  if (parsed.items.length > LIMITS.brands) throw new Error(`Слишком много брендов: максимум ${LIMITS.brands}`);
  const tlds = Array.from(new Set(parseList(i.tlds).map(normalizeTld).filter(Boolean)));
  if (!tlds.length) throw new Error("Укажите хотя бы одну доменную зону, например com");
  if (tlds.length > LIMITS.tlds) throw new Error(`Слишком много зон: максимум ${LIMITS.tlds}`);
  const tiers = dedupeTiers([parseList(i.tier1), parseList(i.tier2), parseList(i.tier3)], 3) as [string[], string[], string[]];
  for (const t of tiers) if (t.length > LIMITS.suffixesPerTier) throw new Error(`В одном уровне не больше ${LIMITS.suffixesPerTier} приставок`);
  const fromForm = new Map((i.items ?? []).map((x) => [itemKey(String(x.brand), String(x.country)), x]));
  const items: BrandItem[] = parsed.items.map((p) => normalizeItem({ ...(fromForm.get(itemKey(p.brand, p.country)) as Partial<BrandItem> | undefined), brand: p.brand, country: p.country, tlds: p.tlds }, p.country));
  const countryPresets: Record<string, CountryPreset> = {};
  for (const c of new Set(items.map((it) => it.country))) countryPresets[c] = defaultCountryPreset(c, (i.countryPresets?.[c] as { tlds?: unknown } | undefined)?.tlds);
  return {
    brands: items.map((it) => it.brand),
    items,
    countryPresets,
    letterMode: LETTER_MODES.includes(i.letterMode as LetterMode) ? (i.letterMode as LetterMode) : "off",
    usePool: i.usePool === true,
    autoResearch: i.autoResearch === true,
    checkAll: i.checkAll === true,
    autoZones: i.autoZones === true,
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

/** Подпись бренда пачки: «winzoria · ES». */
export function itemLabel(it: { brand: string; country: string }): string {
  return it.country ? `${it.brand} · ${it.country.toUpperCase()}` : it.brand;
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
  // Перезапуск — в режиме «максимум»: ключи и выдача для брендов без них, все варианты, зона страны и зоны конкурентов
  const settings: DomainRunSettings = { ...parseSettings(run.settings), autoResearch: true, checkAll: true, autoZones: true };
  await prisma.$transaction([
    prisma.domainCandidate.deleteMany({ where: { runId: id } }),
    prisma.domainRun.update({ where: { id }, data: { settings: settings as unknown as Prisma.InputJsonValue, status: "QUEUED", stopRequested: false, progress: Prisma.JsonNull, error: null, totalChecked: 0, totalAvailable: 0, totalGenerated: 0, incompleteBrands: Prisma.JsonNull, workerId: null, leaseUntil: null, startedAt: null, finishedAt: null } }),
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
 * Проверяет кандидатов бренд за брендом (бренд = бренд + страна пачки), пока не наберётся perBrand + запас свободных.
 * Уровни бренда: набор страны + общие приставки + модификаторы бренда, 4–6 — запас модификаторов страны.
 * Все проверенные (в т.ч. занятые) сохраняются. При перезапуске готовые бренды пропускаются.
 */
export async function processDomainRun(run: DomainRun, workerId: string, shouldStop: () => boolean): Promise<void> {
  const settings = parseSettings(run.settings);
  const items = settings.items;
  const target = settings.perBrand + settings.extraPerBrand;
  const prev = (run.progress ?? null) as DomainRunProgress | null;
  const startAt = prev && prev.brandIndex > 0 && prev.brandIndex <= items.length ? prev.brandIndex : 0;
  // Бренд, на котором прервались: его частичные результаты стираем и проверяем заново.
  if (startAt < items.length) await prisma.domainCandidate.deleteMany({ where: { runId: run.id, brand: items[startAt]!.brand, country: items[startAt]!.country } });
  const agg = await prisma.domainCandidate.groupBy({ by: ["status"], where: { runId: run.id }, _count: { _all: true } });
  let totalChecked = agg.reduce((a, g) => a + g._count._all, 0);
  let totalAvailable = agg.find((g) => g.status === "available")?._count._all ?? 0;
  // Один и тот же домен может выпасть двум брендам (бренд в двух странах) — проверяем и сохраняем его один раз.
  const known = new Set((await prisma.domainCandidate.findMany({ where: { runId: run.id }, select: { domain: true } })).map((r) => r.domain));
  const incomplete: string[] = Array.isArray(run.incompleteBrands) ? (run.incompleteBrands as string[]) : [];
  let lastLease = Date.now();

  const stopped = async () => prisma.domainRun.update({ where: { id: run.id }, data: { status: "STOPPED", stopRequested: false, finishedAt: new Date(), workerId: null, leaseUntil: null, totalChecked, totalAvailable, incompleteBrands: incomplete } });
  // Воркер останавливается (деплой): подбор возвращается в очередь и продолжится с текущего бренда.
  const released = async () => prisma.domainRun.update({ where: { id: run.id }, data: { status: "QUEUED", workerId: null, leaseUntil: null, totalChecked, totalAvailable, incompleteBrands: incomplete } });

  const touch = async (brand: string, brandIndex: number): Promise<"go" | "stop" | "release" | "lost"> => {
    const rows = await prisma.$queryRaw<Array<{ stopRequested: number | boolean; workerId: string | null }>>`SELECT stopRequested, workerId FROM DomainRun WHERE id = ${run.id}`;
    const r = rows[0];
    if (!r || r.workerId !== workerId) return "lost";
    const progress: DomainRunProgress = { brand, brandIndex, brandsTotal: items.length, checked: totalChecked, available: totalAvailable, updatedAt: new Date().toISOString() };
    await prisma.$executeRaw`UPDATE DomainRun SET leaseUntil = DATE_ADD(NOW(3), INTERVAL ${RUN_LEASE_SECONDS} SECOND), progress = ${JSON.stringify(progress)}, totalChecked = ${totalChecked}, totalAvailable = ${totalAvailable} WHERE id = ${run.id}`;
    lastLease = Date.now();
    if (Boolean(r.stopRequested)) return "stop";
    if (shouldStop()) return "release";
    return "go";
  };

  if (settings.autoResearch) {
    const r = await researchStage(run, settings, touch);
    if (r === "lost") return;
    if (r === "stop") { await stopped(); return; }
    if (r === "release") { await released(); return; }
  }
  const pool = settings.usePool ? modifierPool(items) : undefined;

  for (let bi = startAt; bi < items.length; bi++) {
    const item = items[bi]!;
    const label = itemLabel(item);
    const state = await touch(label, bi);
    if (state === "lost") return;
    if (state === "stop") { await stopped(); return; }
    if (state === "release") { await released(); return; }
    const all = buildCandidatesForBrand(item.brand, brandTiers(item, settings, pool), brandTlds(item, settings), { allowHyphen: settings.allowHyphen, letterMode: settings.letterMode });
    const candidates = (settings.checkAll ? all.slice(0, LIMITS.checkAllMax) : all).filter((c) => !known.has(c.domain));
    // «Все варианты» — проверяем всё; иначе останавливаемся, когда набралось perBrand + запас свободных
    const enough = (n: number) => !settings.checkAll && n >= target;
    // Пачка не больше 60: прогресс виден чаще, а аренда продлевается изнутри пачки (реестры .nl отвечают ~1 раз в секунду).
    const batchSize = settings.checkAll ? 60 : Math.min(60, Math.max(12, target * 2));
    let found = 0;
    let order = 0;
    for (let i = 0; i < candidates.length && !enough(found); i += batchSize) {
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
        known.add(c.domain);
        rows.push({ runId: run.id, brand: item.brand, country: item.country, domain: c.domain, tld: c.tld, suffix: c.suffix, tier: c.tier, pattern: c.pattern, status: r.status, source: r.source, checkedAt: now, sortOrder: order++ });
        if (r.status === "available") found++;
      }
      if (rows.length) await prisma.domainCandidate.createMany({ data: rows, skipDuplicates: true });
      totalChecked += rows.length;
      totalAvailable += rows.filter((r) => r.status === "available").length;
      if (Date.now() - lastLease > 20_000 || shouldStop()) {
        const st = await touch(label, bi);
        if (st === "lost") return;
        if (st === "stop") { await stopped(); return; }
        if (st === "release") { await released(); return; }
      }
    }
    if (found < settings.perBrand && !incomplete.includes(label)) incomplete.push(label);
    await prisma.domainRun.update({ where: { id: run.id }, data: { incompleteBrands: incomplete, totalGenerated: { increment: candidates.length } } });
  }

  const progress: DomainRunProgress = { brand: "", brandIndex: items.length, brandsTotal: items.length, checked: totalChecked, available: totalAvailable, updatedAt: new Date().toISOString() };
  await prisma.domainRun.update({
    where: { id: run.id },
    data: { status: "DONE", finishedAt: new Date(), workerId: null, leaseUntil: null, stopRequested: false, progress: progress as unknown as Prisma.InputJsonValue, totalChecked, totalAvailable, incompleteBrands: incomplete },
  });
}

/** Брендов исследуется одновременно (у каждого 3 запроса DataForSEO и один к ИИ). */
const RESEARCH_PARALLEL = 3;

/**
 * Этап перед проверкой: ключи бренда и выдача Google (researchBrand) для каждого бренда без ключей.
 * Бренды, для которых ключи уже собраны (в форме или прошлым запуском), пропускаются. Итог сохраняется в settings.items
 * после каждой пачки — при перезапуске этап продолжается с несобранных брендов.
 */
async function researchStage(run: DomainRun, settings: DomainRunSettings, touch: (label: string, index: number) => Promise<"go" | "stop" | "release" | "lost">): Promise<"go" | "stop" | "release" | "lost"> {
  const items = settings.items;
  const todo = items.map((it, i) => (it.research || it.modifiers.length ? -1 : i)).filter((i) => i >= 0);
  const ctx = { userId: run.createdById, teamId: await domainsKeyTeamId() };
  for (let k = 0; k < todo.length; k += RESEARCH_PARALLEL) {
    const chunk = todo.slice(k, k + RESEARCH_PARALLEL);
    const st = await touch(`ключи и выдача: ${chunk.map((i) => itemLabel(items[i]!)).join(", ")} (${k + chunk.length} из ${todo.length})`, 0);
    if (st !== "go") return st;
    const results = await Promise.all(
      chunk.map((i) =>
        researchBrand(ctx, items[i]!.brand, items[i]!.country, { useAi: true }).catch((e): BrandResearch => ({
          brand: items[i]!.brand, country: items[i]!.country, modifiers: [], queries: 0, competitorDomains: [], tlds: [], costUsd: 0,
          errors: [e instanceof Error ? e.message : String(e)],
        })),
      ),
    );
    chunk.forEach((i, j) => {
      const r = results[j]!;
      const modifiers = keptModifiers(r);
      items[i] = { ...items[i]!, modifiers, research: researchSummary(r, new Set(modifiers.map((m) => m.suffix)), "auto") };
    });
    await prisma.domainRun.update({ where: { id: run.id }, data: { settings: settings as unknown as Prisma.InputJsonValue } });
  }
  return "go";
}

export async function failDomainRun(id: string, error: string): Promise<void> {
  await prisma.domainRun.update({ where: { id }, data: { status: "FAILED", error: error.slice(0, 4000), finishedAt: new Date(), workerId: null, leaseUntil: null } });
}

/* ---------- Чтение и выбор ---------- */

export type RunDomainRow = {
  id: string;
  brand: string;
  country: string;
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
    select: { id: true, brand: true, country: true, domain: true, tld: true, suffix: true, tier: true, pattern: true, status: true, source: true, selected: true, aiScore: true, aiReason: true, sortOrder: true },
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

export type AiSelectResult = { brand: string; key: string; picked: number; note: string | null; error: string | null; costUsd: number | null };

/** Строки бренда пачки; у подборов до разбивки по странам country пустой. */
const itemWhere = (runId: string, it: BrandItem) => ({ runId, brand: it.brand, country: { in: [it.country, ""] } });

/**
 * ИИ-отбор для брендов (ключи itemKey; пусто — все): кандидаты — только свободные домены бренда (до 200); выбор заменяет текущий выбор бренда.
 * Балансировка: модель ранжирует больше вариантов, затем balancePicks выравнивает зоны/приставки.
 */
export async function aiSelectBrands(me: CurrentUser, runId: string, keys: string[], opts: { balanceZones: boolean; balanceSuffixes: boolean; take?: number }): Promise<AiSelectResult[]> {
  const run = await requireRun(me, runId);
  const settings = parseSettings(run.settings);
  const take = Math.max(1, Math.min(opts.take ?? settings.perBrand, 30));
  const balance = opts.balanceZones || opts.balanceSuffixes;
  const out: AiSelectResult[] = [];
  // Ключ — itemKey; для совместимости принимаем и просто имя бренда
  const wanted = keys.length ? settings.items.filter((it) => keys.includes(itemKey(it.brand, it.country)) || keys.includes(it.brand)) : settings.items;
  for (const item of wanted) {
    const key = itemKey(item.brand, item.country);
    const label = itemLabel(item);
    const rows = await prisma.domainCandidate.findMany({ where: { ...itemWhere(runId, item), status: "available" }, orderBy: { sortOrder: "asc" }, take: LIMITS.aiCandidates });
    if (!rows.length) {
      out.push({ brand: label, key, picked: 0, note: "Нет свободных доменов", error: null, costUsd: null });
      continue;
    }
    const topDomains = settings.serp ? domainsOfBrand(settings.serp.domains, item.brand) : [];
    try {
      const askFor = balance ? Math.min(rows.length, Math.max(take * 3, 15)) : Math.min(rows.length, take);
      const r = await rankDomainsWithAi({ userId: me.id, teamId: await domainsKeyTeamId(), refId: run.id }, {
        brand: item.brand,
        take: askFor,
        countryCode: item.country,
        keyword: settings.serpKeyword || undefined,
        candidates: rows.map((x) => ({ domain: x.domain, suffix: x.suffix, tier: x.tier, pattern: x.pattern })),
        topDomains,
      });
      const byDomain = new Map(rows.map((x) => [x.domain, x]));
      const ranked = r.picks.map((p: AiPick) => ({ ...byDomain.get(p.domain)!, score: p.score, reason: p.reason })).filter((x) => x.id);
      const final = balance ? balancePicks(ranked, take, { zones: opts.balanceZones, suffixes: opts.balanceSuffixes }) : ranked.slice(0, take);
      const finalIds = new Set(final.map((x) => x.id));
      await prisma.$transaction([
        prisma.domainCandidate.updateMany({ where: itemWhere(runId, item), data: { selected: false } }),
        ...ranked.map((x) => prisma.domainCandidate.update({ where: { id: x.id }, data: { aiScore: x.score, aiReason: x.reason, selected: finalIds.has(x.id) } })),
      ]);
      out.push({ brand: label, key, picked: final.length, note: r.note, error: null, costUsd: r.costUsd });
    } catch (e) {
      out.push({ brand: label, key, picked: 0, note: null, error: e instanceof Error ? e.message : String(e), costUsd: null });
      // Ключ отклонён/нет кредитов — дальше нет смысла гонять остальные бренды
      if (/кредит|не подключён|отклон/i.test(out[out.length - 1]!.error ?? "")) break;
    }
  }
  return out;
}

/** Сводка для списка подборов. */
export type RunListRow = { id: string; name: string; status: string; countries: string[]; brands: number; tlds: number; perBrand: number; totalChecked: number; totalAvailable: number; selected: number; createdAt: Date; finishedAt: Date | null; progress: DomainRunProgress | null; error: string | null; countryCode: string };

export async function listRuns(me: CurrentUser, limit = 50): Promise<RunListRow[]> {
  const runs = await prisma.domainRun.findMany({ where: domainRunWhere(me), orderBy: { createdAt: "desc" }, take: limit });
  const selected = runs.length ? await prisma.domainCandidate.groupBy({ by: ["runId"], where: { runId: { in: runs.map((r) => r.id) }, selected: true }, _count: { _all: true } }) : [];
  const selMap = new Map(selected.map((s) => [s.runId, s._count._all]));
  return runs.map((r) => {
    const s = parseSettings(r.settings);
    return { id: r.id, name: r.name, status: r.status, countries: Array.from(new Set(s.items.map((it) => it.country))), brands: s.items.length, tlds: s.tlds.length, perBrand: s.perBrand, totalChecked: r.totalChecked, totalAvailable: r.totalAvailable, selected: selMap.get(r.id) ?? 0, createdAt: r.createdAt, finishedAt: r.finishedAt, progress: (r.progress ?? null) as DomainRunProgress | null, error: r.error, countryCode: s.countryCode };
  });
}
