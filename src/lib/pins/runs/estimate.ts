import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import { resolveSlot } from "@/lib/run";
import { canSeeBalances, showsBalances } from "@/lib/permissions";
import { keyOwnerLabel, keyOwnerSelect, keyRemaining, manualBalanceProvider, manualBalances, providerBalances } from "@/lib/balances";
import { PROJECT_SLUG, SLOT_IMAGE_MAIN, SLOT_TEXT_FAST, SLOT_TEXT_MAIN, type RunReservation, type RunSettings } from "../types";

/**
 * Примерная стоимость прогона до запуска — по средним ценам прошлых завершённых прогонов из журнала расхода.
 *
 * Единицы учёта по слотам (так расход реально распределяется по этапам):
 *  - image_main — за ИИ-пин (OPENAI + PINORA): этап images;
 *  - text_main  — за любой пин (ИИ + Canvas + фото): промты, тексты и подписи Canvas идут на каждый пин;
 *  - text_fast  — за статью: ключи и доски, оценка фото для Canvas, дедупликация заголовков.
 * Цена берётся для провайдера, которого слот выдаст этому пользователю сейчас; если по нему истории нет —
 * средняя по всем провайдерам слота. Средние кэшируются на 10 минут.
 */

export const ESTIMATE_DAYS = 60;
const CACHE_MS = 10 * 60_000;

export type SlotUnit = "aiPin" | "pin" | "page";
const SLOT_UNIT: Record<string, SlotUnit> = { [SLOT_IMAGE_MAIN]: "aiPin", [SLOT_TEXT_MAIN]: "pin", [SLOT_TEXT_FAST]: "page" };
export const UNIT_LABEL: Record<SlotUnit, string> = { aiPin: "ИИ-пин", pin: "пин", page: "статья" };

export type SlotRates = { unit: SlotUnit; perUnit: number | null; byProvider: Record<string, number>; runs: number };
export type CostRates = { sinceDays: number; runs: number; bySlot: Record<string, SlotRates>; computedAt: string };

let cache: { at: number; value: CostRates } | null = null;

/** Средние цены по слотам и провайдерам из завершённых прогонов за `ESTIMATE_DAYS` дней. */
export async function costRates(force = false): Promise<CostRates> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const since = new Date(Date.now() - ESTIMATE_DAYS * 86_400_000);
  const runs = await prisma.pinRun.findMany({
    where: { status: "DONE", createdAt: { gte: since }, NOT: { name: "__system__" } },
    select: { id: true, _count: { select: { pages: true } } },
  });
  const bySlot: Record<string, { unit: SlotUnit; cost: number; units: number; runs: Set<string>; prov: Record<string, { cost: number; units: number }> }> = {};
  for (const r of runs) {
    const groups = await prisma.pinRunItem.groupBy({ by: ["engine"], where: { runId: r.id, kind: { in: ["pin", "photo"] }, status: { in: ["READY", "ERROR"] } }, _count: { _all: true } });
    const n = (e: string) => groups.find((g) => g.engine === e)?._count._all ?? 0;
    const unitsOf: Record<SlotUnit, number> = { aiPin: n("OPENAI") + n("PINORA"), pin: n("OPENAI") + n("PINORA") + n("CANVAS") + n("PHOTO"), page: r._count.pages };
    const usage = await prisma.$queryRaw<Array<{ slotKey: string | null; prov: string; cost: number | null }>>`
      SELECT s.\`key\` AS slotKey, p.slug AS prov, SUM(u.costUsd) AS cost
      FROM UsageLog u LEFT JOIN Slot s ON s.id = u.slotId JOIN Provider p ON p.id = u.providerId
      WHERE u.refId = ${r.id} GROUP BY s.\`key\`, p.slug`;
    for (const u of usage) {
      const key = u.slotKey ?? "";
      const unit = SLOT_UNIT[key];
      if (!unit) continue;
      const cost = Number(u.cost ?? 0);
      const units = unitsOf[unit];
      if (!(cost > 0) || !(units > 0)) continue;
      const s = (bySlot[key] ??= { unit, cost: 0, units: 0, runs: new Set(), prov: {} });
      s.cost += cost;
      s.units += units;
      s.runs.add(r.id);
      const pv = (s.prov[u.prov] ??= { cost: 0, units: 0 });
      pv.cost += cost;
      pv.units += units;
    }
  }
  const out: CostRates = { sinceDays: ESTIMATE_DAYS, runs: runs.length, bySlot: {}, computedAt: new Date().toISOString() };
  for (const [key, s] of Object.entries(bySlot)) {
    const byProvider: Record<string, number> = {};
    for (const [slug, pv] of Object.entries(s.prov)) if (pv.units > 0) byProvider[slug] = pv.cost / pv.units;
    out.bySlot[key] = { unit: s.unit, perUnit: s.units > 0 ? s.cost / s.units : null, byProvider, runs: s.runs.size };
  }
  for (const key of Object.keys(SLOT_UNIT)) out.bySlot[key] ??= { unit: SLOT_UNIT[key], perUnit: null, byProvider: {}, runs: 0 };
  cache = { at: Date.now(), value: out };
  return out;
}

/** `teamId` — команда сайта: ключи (и остатки) берутся по её правилам, как при самом прогоне. */
export type EstimateInput = { pages: number; mix: { ai: number; photos: number; canvas: number; pinora: number }; teamId?: string | null };

export type EstimatePart = { slot: string; slotName: string; unit: SlotUnit; units: number; rate: number | null; costUsd: number | null; providerSlug: string; providerName: string; keyLabel: string; keyOwner: string; keyId: string; note: string | null };
export type EstimateProvider = {
  slug: string; name: string;
  /** Ключи системы для этого прогона и чьи они (команда / личный / общий). */
  keys: Array<{ label: string; owner: string }>;
  /** Этот прогон. */
  costUsd: number;
  /** Остаток на счёте (по ключу) и пояснение, если цифры нет. */
  remainingUsd: number | null; balanceNote: string | null;
  /** Уже занято идущими прогонами на тех же ключах (остаток их резерва) и сколько их. */
  inWorkUsd: number; inWorkRuns: number;
  /** Остаток минус «в работе»: столько реально свободно под этот прогон. */
  availableUsd: number | null;
  /** Хватает ли свободного с запасом 20 %; null — остаток неизвестен. */
  enough: boolean | null;
};
export type RunEstimate = {
  pages: number;
  pins: { ai: number; canvas: number; photos: number; total: number };
  parts: EstimatePart[];
  providers: EstimateProvider[];
  totalUsd: number | null;
  basis: { runs: number; sinceDays: number };
  /** Слоты без правила (ключ + модель) — прогон на них встанет. */
  errors: string[];
  /** Предупреждения о нехватке денег с учётом идущих прогонов — показываются до запуска и после него. */
  risks: string[];
  /** Что записать в прогон при запуске (`RunSettings.estimate`). */
  reservation: RunReservation;
};

/** Прогон занимает деньги, пока не закончился: ждёт очереди, идёт, ждёт модерацию или временно заблокирован (ключи поднимутся). */
const RESERVING_STATUSES = ["QUEUED", "RUNNING", "WAITING_MODERATION", "BLOCKED"] as const;

export type ActiveReservation = { reservedUsd: number; runs: Array<{ id: string; name: string }> };

/**
 * Сколько денег по каждому ключу уже «в работе»: у каждого незавершённого прогона с резервом берём оценку по ключу
 * минус то, что он по этому ключу уже потратил (журнал расхода). Прогоны без резерва (старые) не учитываются.
 */
export async function activeReservations(excludeRunId?: string): Promise<Map<string, ActiveReservation>> {
  const runs = await prisma.pinRun.findMany({
    where: { status: { in: [...RESERVING_STATUSES] }, NOT: { name: "__system__" }, ...(excludeRunId ? { id: { not: excludeRunId } } : {}) },
    select: { id: true, name: true, settings: true },
  });
  const out = new Map<string, ActiveReservation>();
  for (const r of runs) {
    const est = (r.settings as RunSettings | null)?.estimate;
    if (!est?.byKey?.length) continue;
    const spent = await prisma.usageLog.groupBy({ by: ["apiKeyId"], where: { refId: r.id }, _sum: { costUsd: true } });
    for (const k of est.byKey) {
      const used = spent.find((s) => s.apiKeyId === k.keyId)?._sum.costUsd ?? 0;
      const left = Math.max(0, k.costUsd - used);
      if (left <= 0) continue;
      const row = out.get(k.keyId) ?? { reservedUsd: 0, runs: [] };
      row.reservedUsd += left;
      row.runs.push({ id: r.id, name: r.name });
      out.set(k.keyId, row);
    }
  }
  return out;
}

/**
 * Оценка для конкретного пользователя: ключи по слотам проекта «pins» по команде сайта, цены по истории,
 * остатки на счетах по ключу и деньги, уже занятые идущими прогонами на тех же ключах.
 */
export async function runEstimate(me: CurrentUser, input: EstimateInput): Promise<RunEstimate> {
  const pages = Math.max(0, Math.floor(input.pages || 0));
  const m = input.mix;
  const ai = pages * (Math.max(0, m.ai) + Math.max(0, m.pinora));
  const canvas = pages * Math.max(0, m.canvas);
  const photos = pages * Math.max(0, m.photos);
  const pins = { ai, canvas, photos, total: ai + canvas + photos };
  const unitsOf: Record<SlotUnit, number> = { aiPin: ai, pin: pins.total, page: pages };

  const rates = await costRates();
  const parts: EstimatePart[] = [];
  const errors: string[] = [];
  const keyIds = new Map<string, { providerSlug: string; providerKind: string }>();
  const owners = new Map<string, string>();
  const ownerOf = async (keyId: string) => {
    if (!owners.has(keyId)) {
      const k = await prisma.apiKey.findUnique({ where: { id: keyId }, select: keyOwnerSelect });
      owners.set(keyId, k ? keyOwnerLabel(k) : "?");
    }
    return owners.get(keyId)!;
  };
  for (const slotKey of [SLOT_IMAGE_MAIN, SLOT_TEXT_MAIN, SLOT_TEXT_FAST]) {
    const unit = SLOT_UNIT[slotKey];
    const units = unitsOf[unit];
    if (units <= 0) continue;
    const r = await resolveSlot(me.id, PROJECT_SLUG, slotKey, input.teamId);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    const b = r.value.binding;
    const sr = rates.bySlot[slotKey];
    const rate = sr?.byProvider[b.provider.slug] ?? sr?.perUnit ?? null;
    const note = rate == null ? "нет истории расхода — цена неизвестна" : sr.byProvider[b.provider.slug] == null ? `по этому провайдеру истории нет, взята средняя по слоту` : null;
    parts.push({ slot: slotKey, slotName: r.value.slot.name, unit, units, rate, costUsd: rate == null ? null : rate * units, providerSlug: b.provider.slug, providerName: b.provider.name, keyLabel: b.apiKey.label, keyOwner: await ownerOf(b.apiKey.id), keyId: b.apiKey.id, note });
    keyIds.set(b.apiKey.id, { providerSlug: b.provider.slug, providerKind: b.provider.kind });
  }

  // Остатки: OpenRouter / laozhang / DataForSEO — по ключу, который выдал слот (сотрудник видит остаток именно своего ключа);
  // админу для OpenRouter — счёт провайдера. OpenAI и прочие — ручной остаток ключа минус расход по журналу.
  const seeAll = canSeeBalances(me);
  const seeAny = showsBalances(me);
  const provBal = seeAll && parts.some((p) => !manualBalanceProvider({ slug: p.providerSlug, kind: keyIds.get(p.keyId)?.providerKind ?? "LLM" })) ? await providerBalances().catch(() => []) : [];
  const keyRows = seeAny ? await prisma.apiKey.findMany({ where: { id: { in: [...keyIds.keys()] } }, select: { id: true, balanceUsd: true, balanceAt: true, secretEnc: true, provider: { select: { id: true, slug: true, baseUrl: true, balanceTokenEnc: true } } } }) : [];
  const manual = await manualBalances(keyRows);
  const inWork = await activeReservations();

  const providers = new Map<string, EstimateProvider>();
  for (const p of parts) {
    const kind = keyIds.get(p.keyId)?.providerKind ?? "LLM";
    const row = providers.get(p.providerSlug) ?? { slug: p.providerSlug, name: p.providerName, keys: [], costUsd: 0, remainingUsd: null, balanceNote: null, inWorkUsd: 0, inWorkRuns: 0, availableUsd: null, enough: null };
    const firstKey = !row.keys.some((k) => k.label === p.keyLabel);
    if (firstKey) row.keys.push({ label: p.keyLabel, owner: p.keyOwner });
    row.costUsd += p.costUsd ?? 0;
    if (firstKey) {
      const res = inWork.get(p.keyId);
      if (res) { row.inWorkUsd += res.reservedUsd; row.inWorkRuns += res.runs.length; }
    }
    if (row.remainingUsd == null && row.balanceNote == null) {
      if (!seeAny) row.balanceNote = "остаток скрыт";
      else if (manualBalanceProvider({ slug: p.providerSlug, kind })) {
        const mb = manual.get(p.keyId);
        if (mb) row.remainingUsd = mb.remaining;
        else row.balanceNote = "остаток ключа не вписан (страница ключа)";
      } else {
        const pb = seeAll ? provBal.find((x) => x.slug === p.providerSlug) : null;
        const key = keyRows.find((k) => k.id === p.keyId);
        const byKey = key ? await keyRemaining(key).catch(() => null) : null;
        if (pb?.remaining != null) row.remainingUsd = pb.remaining;
        else if (byKey != null) row.remainingUsd = byKey;
        else row.balanceNote = pb?.note ?? "провайдер не отдал остаток";
      }
    }
    providers.set(p.providerSlug, row);
  }
  const risks: string[] = [];
  for (const row of providers.values()) {
    if (row.remainingUsd == null) continue;
    row.availableUsd = row.remainingUsd - row.inWorkUsd;
    row.enough = row.availableUsd >= row.costUsd * 1.2;
    if (!row.enough) {
      const need = Math.max(0, row.costUsd * 1.2 - row.availableUsd);
      risks.push(
        `${row.name}: на счёте ${money(row.remainingUsd)}` +
        (row.inWorkRuns ? `, уже в работе ${money(row.inWorkUsd)} (прогонов: ${row.inWorkRuns})` : "") +
        `, этот прогон ≈ ${money(row.costUsd)} — есть риск остановки, не хватает ≈ ${money(need)} с запасом 20 %. Попросите администратора пополнить баланс.`,
      );
    }
  }

  const priced = parts.filter((p) => p.costUsd != null);
  const totalUsd = priced.length ? priced.reduce((s, p) => s + (p.costUsd ?? 0), 0) : null;
  const byKey = new Map<string, RunReservation["byKey"][number]>();
  for (const p of parts) {
    const k = byKey.get(p.keyId) ?? { keyId: p.keyId, keyLabel: p.keyLabel, keyOwner: p.keyOwner, providerSlug: p.providerSlug, providerName: p.providerName, costUsd: 0 };
    k.costUsd += p.costUsd ?? 0;
    byKey.set(p.keyId, k);
  }
  const reservation: RunReservation = { at: new Date().toISOString(), totalUsd, byKey: [...byKey.values()] };
  return { pages, pins, parts, providers: [...providers.values()], totalUsd, basis: { runs: rates.runs, sinceDays: rates.sinceDays }, errors, risks, reservation };
}

const money = (v: number) => `$${v.toFixed(2)}`;
