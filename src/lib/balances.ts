import type { BindingScope } from "@prisma/client";
import { prisma } from "./db";
import { decryptSecret } from "./crypto";
import { levelCandidates } from "./resolve";
import { monthStart } from "./utils";

/**
 * Балансы провайдеров для плашки в шапке (только админам).
 * Запрашиваем только то, что провайдер реально отдаёт:
 *  - OpenRouter: GET /credits по API-ключу;
 *  - laozhang: GET /api/user/self по отдельному системному токену аккаунта (Provider.balanceTokenEnc), не по API-ключу;
 *  - DataForSEO: appendix/user_data по логину и паролю API;
 *  - OpenAI и другие LLM без баланса по API: остаток вписывают вручную на странице ключа (ApiKey.balanceUsd/balanceAt),
 *    портал вычитает из него расход по журналу через этот ключ — по всем инструментам и командам сразу.
 * Ответы провайдеров кэшируются в памяти на несколько минут; ручные остатки считаются по базе каждый раз.
 * Сотрудник (балансы «свои») видит только ключи своей команды в открытых ему инструментах (`myKeyBalances`).
 */
export const BALANCE_PROVIDERS = ["openrouter", "laozhang", "openai", "dataforseo"] as const;

/** Чей ключ: команда («WexOra»), личный («личный · Имя») или общий — подпись рядом с ключом, чтобы не перепутать, с чьих денег идёт работа. */
export type KeyOwnerRef = { team: { name: string } | null; owner: { name: string; email: string } | null };
export function keyOwnerLabel(k: KeyOwnerRef): string {
  if (k.team) return k.team.name;
  if (k.owner) return `личный · ${k.owner.name || k.owner.email}`;
  return "общий";
}
export const keyOwnerSelect = { team: { select: { name: true } }, owner: { select: { name: true, email: true } } } as const;

export type KeyBalance = { keyId: string; label: string; hint: string; owner: string; remaining: number | null; note: string | null };

export type ProviderBalance = {
  slug: string;
  name: string;
  /** Остаток в долларах; null — провайдер не отдаёт или не настроено. */
  remaining: number | null;
  /** Пополнено/лимит и потрачено по данным провайдера, если он их сообщает. */
  total: number | null;
  used: number | null;
  /** Почему остатка нет или что нужно настроить. */
  note: string | null;
  /** Расход за текущий месяц по журналу портала. */
  monthSpendUsd: number;
  /** Разбивка по ключам, когда остаток считается по ключам и их несколько. */
  keys: KeyBalance[];
  checkedAt: string | null;
};

type Probe = { remaining: number | null; total: number | null; used: number | null; note: string | null };

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: Probe }>();

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function getJson(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000), cache: "no-store" });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

function errText(data: unknown, status: number): string {
  const d = data as { error?: { message?: string } | string; message?: string; status_message?: string } | null;
  const msg = typeof d?.error === "string" ? d.error : d?.error?.message ?? d?.message ?? d?.status_message;
  return msg ? `${msg}` : `HTTP ${status}`;
}

async function cached(id: string, force: boolean, run: () => Promise<Probe>): Promise<Probe> {
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value: Probe;
  try { value = await run(); } catch (e) { value = { remaining: null, total: null, used: null, note: e instanceof Error ? e.message : String(e) }; }
  cache.set(id, { at: Date.now(), value });
  return value;
}

/** OpenRouter: /credits → total_credits, total_usage. */
async function probeOpenRouter(baseUrl: string, secret: string): Promise<Probe> {
  const r = await getJson(joinUrl(baseUrl, "credits"), { Authorization: `Bearer ${secret}` });
  if (!r.ok) return { remaining: null, total: null, used: null, note: errText(r.data, r.status) };
  const d = (r.data as { data?: { total_credits?: number; total_usage?: number } }).data ?? {};
  const total = typeof d.total_credits === "number" ? d.total_credits : null;
  const used = typeof d.total_usage === "number" ? d.total_usage : null;
  return { remaining: total != null && used != null ? total - used : null, total, used, note: null };
}

/** laozhang: /api/user/self по системному токену (заголовок Authorization без Bearer); quota / 500 000 ≈ $. */
async function probeLaozhang(baseUrl: string, token: string): Promise<Probe> {
  const origin = new URL(baseUrl).origin;
  const r = await getJson(`${origin}/api/user/self`, { Authorization: token });
  if (!r.ok) return { remaining: null, total: null, used: null, note: r.status === 401 ? "Системный токен laozhang не принят: обновите его на странице провайдера" : errText(r.data, r.status) };
  const d = (r.data as { success?: boolean; message?: string; data?: { quota?: number; used_quota?: number } });
  if (d.success === false) return { remaining: null, total: null, used: null, note: d.message ?? "laozhang вернул ошибку" };
  const quota = d.data?.quota;
  const usedQ = d.data?.used_quota;
  const remaining = typeof quota === "number" ? quota / 500_000 : null;
  const used = typeof usedQ === "number" ? usedQ / 500_000 : null;
  return { remaining, total: remaining != null && used != null ? remaining + used : null, used, note: remaining == null ? "laozhang не вернул поле quota" : null };
}

/** DataForSEO: appendix/user_data → money.balance. */
async function probeDataForSeo(baseUrl: string, secret: string): Promise<Probe> {
  const r = await getJson(joinUrl(baseUrl, "appendix/user_data"), { Authorization: `Basic ${Buffer.from(secret).toString("base64")}` });
  const d = r.data as { status_code?: number; status_message?: string; tasks?: Array<{ result?: Array<{ money?: { balance?: number; total?: number } }> }> } | null;
  if (!r.ok || d?.status_code !== 20000) return { remaining: null, total: null, used: null, note: d?.status_message ?? `HTTP ${r.status}` };
  const money = d.tasks?.[0]?.result?.[0]?.money;
  const bal = typeof money?.balance === "number" ? money.balance : null;
  return { remaining: bal, total: null, used: null, note: bal == null ? "DataForSEO не вернул баланс" : null };
}

export type KeyForProbe = { id: string; secretEnc: string; provider: { id: string; slug: string; baseUrl: string; balanceTokenEnc: string | null } };

/**
 * Остаток по одному ключу у провайдера с балансом по API (OpenRouter — по самому ключу, laozhang — по системному токену,
 * DataForSEO — по логину ключа). null — провайдер не отдаёт остаток или это ручной провайдер. Кэш как у плашки.
 */
export async function keyRemaining(k: KeyForProbe, force = false): Promise<number | null> {
  const p = k.provider;
  let probe: Probe | null = null;
  if (p.slug === "laozhang") {
    if (p.balanceTokenEnc) probe = await cached(`provider:${p.id}`, force, () => probeLaozhang(p.baseUrl, decryptSecret(p.balanceTokenEnc!)));
  } else if (p.slug === "dataforseo") probe = await cached(`key:${k.id}`, force, () => probeDataForSeo(p.baseUrl, decryptSecret(k.secretEnc)));
  else if (p.slug === "openrouter") probe = await cached(`key:${k.id}`, force, () => probeOpenRouter(p.baseUrl, decryptSecret(k.secretEnc)));
  return probe?.remaining ?? null;
}

/** Провайдеры, у которых остаток ведётся вручную на ключе: LLM без баланса по API (OpenAI, Perplexity, свои OpenAI-совместимые). */
export function manualBalanceProvider(p: { slug: string; kind: string }): boolean {
  return p.kind === "LLM" && p.slug !== "openrouter" && p.slug !== "laozhang";
}

export type ManualBalance = {
  /** Сумма, вписанная со счёта провайдера, и когда её вписали. */
  startUsd: number;
  at: Date;
  /** Расход через портал с этого момента: все инструменты, команды и сотрудники. */
  spentUsd: number;
  calls: number;
  /** Успешные вызовы без посчитанной стоимости (у модели не заданы цены): на них остаток завышен. */
  unpriced: number;
  remaining: number;
};

/** Ручные остатки ключей: вписанная сумма минус расход по журналу портала с момента ввода. */
export async function manualBalances(keys: { id: string; balanceUsd: number | null; balanceAt: Date | null }[]): Promise<Map<string, ManualBalance>> {
  const out = new Map<string, ManualBalance>();
  await Promise.all(keys.map(async (k) => {
    if (k.balanceUsd == null || !k.balanceAt) return;
    const since = { apiKeyId: k.id, createdAt: { gte: k.balanceAt } };
    const [agg, unpriced] = await Promise.all([
      prisma.usageLog.aggregate({ _sum: { costUsd: true }, _count: true, where: since }),
      prisma.usageLog.count({ where: { ...since, ok: true, costUsd: null } }),
    ]);
    const spentUsd = agg._sum.costUsd ?? 0;
    out.set(k.id, { startUsd: k.balanceUsd, at: k.balanceAt, spentUsd, calls: agg._count, unpriced, remaining: k.balanceUsd - spentUsd });
  }));
  return out;
}

const UNPRICED_NOTE = "Часть вызовов без цены модели: настоящий остаток меньше";

export async function providerBalances(force = false): Promise<ProviderBalance[]> {
  const providers = await prisma.provider.findMany({
    where: { OR: [{ slug: { in: [...BALANCE_PROVIDERS] } }, { apiKeys: { some: { status: "ACTIVE", balanceUsd: { not: null } } } }] },
    include: { apiKeys: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 5, select: { id: true, label: true, secretHint: true, secretEnc: true, balanceUsd: true, balanceAt: true, ...keyOwnerSelect } } },
  });
  const spend = await prisma.usageLog.groupBy({
    by: ["providerId"],
    where: { providerId: { in: providers.map((p) => p.id) }, createdAt: { gte: monthStart() }, ok: true },
    _sum: { costUsd: true },
  });
  const spendBy = new Map(spend.map((s) => [s.providerId, s._sum.costUsd ?? 0]));
  const order = new Map<string, number>(BALANCE_PROVIDERS.map((s, i) => [s, i]));
  const now = new Date().toISOString();

  const out = await Promise.all(providers.map(async (p): Promise<ProviderBalance> => {
    const base = { slug: p.slug, name: p.name, monthSpendUsd: spendBy.get(p.id) ?? 0, keys: [] as KeyBalance[], checkedAt: now };

    if (manualBalanceProvider(p)) {
      const manual = await manualBalances(p.apiKeys);
      const tracked = p.apiKeys.filter((k) => manual.has(k.id)).map((k) => ({ key: k, m: manual.get(k.id)! }));
      if (!tracked.length) return { ...base, remaining: null, total: null, used: null, note: `${p.name} не отдаёт остаток по API: впишите сумму со счёта на странице ключа, портал будет вычитать расход`, checkedAt: null };
      const sum = (f: (m: ManualBalance) => number) => tracked.reduce((a, t) => a + f(t.m), 0);
      return {
        ...base,
        remaining: sum((m) => m.remaining),
        total: sum((m) => m.startUsd),
        used: sum((m) => m.spentUsd),
        note: tracked.some((t) => t.m.unpriced > 0) ? UNPRICED_NOTE : "Расчёт портала: сумма, вписанная на ключе, минус расход через портал",
        keys: tracked.length > 1 ? tracked.map(({ key, m }) => ({ keyId: key.id, label: key.label, hint: key.secretHint, owner: keyOwnerLabel(key), remaining: m.remaining, note: m.unpriced > 0 ? UNPRICED_NOTE : null })) : [],
      };
    }
    if (p.slug === "laozhang") {
      if (!p.balanceTokenEnc) return { ...base, remaining: null, total: null, used: null, note: "Нужен системный токен laozhang: страница провайдера → «Токен для баланса»", checkedAt: null };
      const r = await cached(`provider:${p.id}`, force, () => probeLaozhang(p.baseUrl, decryptSecret(p.balanceTokenEnc!)));
      return { ...base, ...r };
    }
    if (p.apiKeys.length === 0) return { ...base, remaining: null, total: null, used: null, note: "Нет активных ключей", checkedAt: null };

    const keys = await Promise.all(p.apiKeys.map(async (k): Promise<KeyBalance & Probe> => {
      const r = await cached(`key:${k.id}`, force, () => (p.slug === "dataforseo" ? probeDataForSeo(p.baseUrl, decryptSecret(k.secretEnc)) : probeOpenRouter(p.baseUrl, decryptSecret(k.secretEnc))));
      return { keyId: k.id, label: k.label, hint: k.secretHint, owner: keyOwnerLabel(k), ...r };
    }));
    const known = keys.filter((k) => k.remaining != null);
    const sum = (f: (k: KeyBalance & Probe) => number | null) => { const v = known.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
    return {
      ...base,
      remaining: sum((k) => k.remaining),
      total: sum((k) => k.total),
      used: sum((k) => k.used),
      note: known.length ? null : keys.find((k) => k.note)?.note ?? null,
      keys: keys.length > 1 ? keys.map(({ keyId, label, hint, owner, remaining, note }) => ({ keyId, label, hint, owner, remaining, note })) : [],
    };
  }));
  return out.sort((a, b) => (order.get(a.slug) ?? 9) - (order.get(b.slug) ?? 9));
}

export type MyKeyBalance = {
  keyId: string;
  label: string;
  /** Чей ключ: команда / личный / общий. */
  owner: string;
  provider: string;
  providerSlug: string;
  /** Инструменты, в которых этот ключ работает для сотрудника. */
  tools: string[];
  remaining: number | null;
  /** Один счёт на несколько ключей (laozhang): в общей сумме считается один раз. */
  account: string;
  note: string | null;
};

const SCOPE_ORDER: BindingScope[] = ["USER_PROJECT", "TEAM_PROJECT", "PROJECT", "TEAM", "GLOBAL"];

/**
 * Ключи, на которых сотрудник работает в открытых ему инструментах `tools` (тот же порядок правил, что в resolveBinding),
 * с остатком на счёте. Только свои: правила его команд и личные; если слот обслуживает общий ключ сервиса
 * (уровни PROJECT / GLOBAL), он не показывается — чужие балансы сотруднику не видны.
 * Остаток общий для ключа: в нём учтён расход всех инструментов и команд.
 * `scopeTeamIds` — команды, по которым считать (у сотрудника с активной командой в шапке — только она); без них — все команды из базы.
 */
export async function myKeyBalances(userId: string, tools: "all" | string[], force = false, scopeTeamIds?: string[]): Promise<MyKeyBalance[]> {
  const teamIds = scopeTeamIds ?? (await prisma.teamMember.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, select: { teamId: true } })).map((m) => m.teamId);
  const [slots, bindings] = await Promise.all([
    prisma.slot.findMany({ where: tools === "all" ? {} : { project: { slug: { in: tools } } }, select: { id: true, capability: true, preferProviders: true, project: { select: { name: true, order: true } } } }),
    prisma.binding.findMany({
      where: {
        apiKey: { status: "ACTIVE" },
        OR: [{ scope: "USER_PROJECT", userId }, { scope: "TEAM_PROJECT", teamId: { in: teamIds } }, { scope: "PROJECT" }, { scope: "TEAM", teamId: { in: teamIds } }, { scope: "GLOBAL" }],
      },
      orderBy: { createdAt: "asc" },
      select: { scope: true, slotId: true, teamId: true, capability: true, apiKeyId: true, provider: { select: { slug: true } } },
    }),
  ]);
  const toolsByKey = new Map<string, Map<string, number>>();
  for (const slot of slots) {
    for (const scope of SCOPE_ORDER) {
      const level = bindings.filter((b) => b.scope === scope && (scope === "TEAM" || scope === "GLOBAL" ? b.capability === slot.capability : b.slotId === slot.id));
      if (!level.length) continue;
      if (scope === "PROJECT" || scope === "GLOBAL") break;
      for (const b of levelCandidates(level, scope, teamIds, slot.preferProviders)) {
        const tools = toolsByKey.get(b.apiKeyId) ?? new Map<string, number>();
        tools.set(slot.project.name, slot.project.order);
        toolsByKey.set(b.apiKeyId, tools);
      }
      break;
    }
  }
  if (!toolsByKey.size) return [];

  const keys = await prisma.apiKey.findMany({
    where: { id: { in: [...toolsByKey.keys()] } },
    orderBy: [{ provider: { order: "asc" } }, { label: "asc" }],
    select: { id: true, label: true, secretEnc: true, balanceUsd: true, balanceAt: true, ...keyOwnerSelect, provider: { select: { id: true, slug: true, name: true, kind: true, baseUrl: true, balanceTokenEnc: true } } },
  });
  const manual = await manualBalances(keys.filter((k) => manualBalanceProvider(k.provider)));
  return Promise.all(keys.map(async (k): Promise<MyKeyBalance> => {
    const p = k.provider;
    const tools = [...toolsByKey.get(k.id)!.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    const base = { keyId: k.id, label: k.label, owner: keyOwnerLabel(k), provider: p.name, providerSlug: p.slug, tools, account: `key:${k.id}` };
    if (manualBalanceProvider(p)) {
      const m = manual.get(k.id);
      return { ...base, remaining: m?.remaining ?? null, note: !m ? "Остаток не задан" : m.unpriced > 0 ? UNPRICED_NOTE : null };
    }
    let probe: Probe | null = null;
    if (p.slug === "laozhang") {
      if (p.balanceTokenEnc) probe = await cached(`provider:${p.id}`, force, () => probeLaozhang(p.baseUrl, decryptSecret(p.balanceTokenEnc!)));
    } else if (p.slug === "dataforseo") probe = await cached(`key:${k.id}`, force, () => probeDataForSeo(p.baseUrl, decryptSecret(k.secretEnc)));
    else if (p.slug === "openrouter") probe = await cached(`key:${k.id}`, force, () => probeOpenRouter(p.baseUrl, decryptSecret(k.secretEnc)));
    // Текст ошибки провайдера — для админа (плашка провайдеров); сотруднику достаточно знать, что цифры нет.
    return { ...base, account: p.slug === "laozhang" ? `provider:${p.id}` : base.account, remaining: probe?.remaining ?? null, note: probe?.remaining != null ? null : "Остаток недоступен" };
  }));
}
