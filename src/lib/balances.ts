import { prisma } from "./db";
import { decryptSecret } from "./crypto";
import { monthStart } from "./utils";

/**
 * Балансы провайдеров для плашки в шапке (только админам).
 * Запрашиваем только то, что провайдер реально отдаёт:
 *  - OpenRouter: GET /credits по API-ключу;
 *  - laozhang: GET /api/user/self по отдельному системному токену аккаунта (Provider.balanceTokenEnc), не по API-ключу;
 *  - DataForSEO: appendix/user_data по логину и паролю API;
 *  - OpenAI: баланса по API нет — только расход за месяц по журналу портала, без запросов.
 * Ответы кэшируются в памяти на несколько минут.
 */
export const BALANCE_PROVIDERS = ["openrouter", "laozhang", "openai", "dataforseo"] as const;

export type KeyBalance = { keyId: string; label: string; hint: string; remaining: number | null; note: string | null };

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

export async function providerBalances(force = false): Promise<ProviderBalance[]> {
  const providers = await prisma.provider.findMany({
    where: { slug: { in: [...BALANCE_PROVIDERS] } },
    include: { apiKeys: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 5, select: { id: true, label: true, secretHint: true, secretEnc: true } } },
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

    if (p.slug === "openai") {
      return { ...base, remaining: null, total: null, used: null, note: "OpenAI не отдаёт остаток по API-ключу: смотрите в кабинете platform.openai.com", checkedAt: null };
    }
    if (p.slug === "laozhang") {
      if (!p.balanceTokenEnc) return { ...base, remaining: null, total: null, used: null, note: "Нужен системный токен laozhang: страница провайдера → «Токен для баланса»", checkedAt: null };
      const r = await cached(`provider:${p.id}`, force, () => probeLaozhang(p.baseUrl, decryptSecret(p.balanceTokenEnc!)));
      return { ...base, ...r };
    }
    if (p.apiKeys.length === 0) return { ...base, remaining: null, total: null, used: null, note: "Нет активных ключей", checkedAt: null };

    const keys = await Promise.all(p.apiKeys.map(async (k): Promise<KeyBalance & Probe> => {
      const r = await cached(`key:${k.id}`, force, () => (p.slug === "dataforseo" ? probeDataForSeo(p.baseUrl, decryptSecret(k.secretEnc)) : probeOpenRouter(p.baseUrl, decryptSecret(k.secretEnc))));
      return { keyId: k.id, label: k.label, hint: k.secretHint, ...r };
    }));
    const known = keys.filter((k) => k.remaining != null);
    const sum = (f: (k: KeyBalance & Probe) => number | null) => { const v = known.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
    return {
      ...base,
      remaining: sum((k) => k.remaining),
      total: sum((k) => k.total),
      used: sum((k) => k.used),
      note: known.length ? null : keys.find((k) => k.note)?.note ?? null,
      keys: keys.length > 1 ? keys.map(({ keyId, label, hint, remaining, note }) => ({ keyId, label, hint, remaining, note })) : [],
    };
  }));
  return out.sort((a, b) => (order.get(a.slug) ?? 9) - (order.get(b.slug) ?? 9));
}
