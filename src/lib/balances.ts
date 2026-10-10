import { prisma } from "./db";
import { decryptSecret } from "./crypto";
import { monthStart } from "./utils";

/**
 * Балансы провайдеров ИИ для меню администратора.
 * Запрашиваются по всем активным ключам провайдера, ответы кэшируются в памяти на несколько минут,
 * чтобы открытие меню не дёргало внешние API каждый раз.
 */
export const BALANCE_PROVIDERS = ["openrouter", "laozhang", "openai"] as const;

export type KeyBalance = {
  keyId: string;
  label: string;
  hint: string;
  /** Остаток в долларах; null — провайдер не отдал. */
  remaining: number | null;
  /** Пополнено/лимит и потрачено по данным провайдера, если есть. */
  total: number | null;
  used: number | null;
  note: string | null;
  checkedAt: string;
};

export type ProviderBalance = {
  slug: string;
  name: string;
  docsUrl: string | null;
  /** Расход за текущий месяц по журналу портала (все ключи провайдера). */
  monthSpendUsd: number;
  keys: KeyBalance[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: Omit<KeyBalance, "keyId" | "label" | "hint"> }>();

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function getJson(url: string, secret: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15000), cache: "no-store" });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

function errText(data: unknown, status: number): string {
  const d = data as { error?: { message?: string } | string; message?: string } | null;
  const msg = typeof d?.error === "string" ? d.error : d?.error?.message ?? d?.message;
  return msg ? `${msg}` : `HTTP ${status}`;
}

type Probe = Omit<KeyBalance, "keyId" | "label" | "hint" | "checkedAt">;

/** OpenRouter: GET /credits → total_credits, total_usage. */
async function probeOpenRouter(baseUrl: string, secret: string): Promise<Probe> {
  const r = await getJson(joinUrl(baseUrl, "credits"), secret);
  if (!r.ok) return { remaining: null, total: null, used: null, note: errText(r.data, r.status) };
  const d = (r.data as { data?: { total_credits?: number; total_usage?: number } }).data ?? {};
  const total = typeof d.total_credits === "number" ? d.total_credits : null;
  const used = typeof d.total_usage === "number" ? d.total_usage : null;
  return { remaining: total != null && used != null ? total - used : null, total, used, note: null };
}

/**
 * OpenAI-совместимые релеи (laozhang — форк New API): /dashboard/billing/subscription даёт лимит,
 * /dashboard/billing/usage — потрачено в центах. Остаток = лимит − потрачено.
 * У самого OpenAI эти адреса для API-ключей закрыты — тогда честно говорим об этом.
 */
async function probeBillingDashboard(baseUrl: string, secret: string, slug: string): Promise<Probe> {
  const sub = await getJson(joinUrl(baseUrl, "dashboard/billing/subscription"), secret);
  if (!sub.ok) {
    const note = slug === "openai"
      ? "OpenAI не отдаёт баланс по API-ключу — смотрите в кабинете platform.openai.com"
      : errText(sub.data, sub.status);
    return { remaining: null, total: null, used: null, note };
  }
  const limit = (sub.data as { hard_limit_usd?: number }).hard_limit_usd;
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
  const usage = await getJson(joinUrl(baseUrl, `dashboard/billing/usage?start_date=${start}&end_date=${end}`), secret);
  const usedCents = usage.ok ? (usage.data as { total_usage?: number }).total_usage : undefined;
  const total = typeof limit === "number" ? limit : null;
  const used = typeof usedCents === "number" ? usedCents / 100 : null;
  return { remaining: total != null ? total - (used ?? 0) : null, total, used, note: null };
}

async function probe(slug: string, baseUrl: string, secret: string): Promise<Probe> {
  try {
    if (slug === "openrouter") return await probeOpenRouter(baseUrl, secret);
    return await probeBillingDashboard(baseUrl, secret, slug);
  } catch (e) {
    return { remaining: null, total: null, used: null, note: e instanceof Error ? e.message : String(e) };
  }
}

export async function providerBalances(force = false): Promise<ProviderBalance[]> {
  const providers = await prisma.provider.findMany({
    where: { slug: { in: [...BALANCE_PROVIDERS] } },
    include: { apiKeys: { where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" }, take: 5 } },
  });
  const since = monthStart();
  const spend = await prisma.usageLog.groupBy({
    by: ["providerId"],
    where: { providerId: { in: providers.map((p) => p.id) }, createdAt: { gte: since }, ok: true },
    _sum: { costUsd: true },
  });
  const spendBy = new Map(spend.map((s) => [s.providerId, s._sum.costUsd ?? 0]));
  const order = new Map(BALANCE_PROVIDERS.map((s, i) => [s, i]));

  const out = await Promise.all(providers.map(async (p): Promise<ProviderBalance> => {
    const keys = await Promise.all(p.apiKeys.map(async (k): Promise<KeyBalance> => {
      const hit = cache.get(k.id);
      if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { keyId: k.id, label: k.label, hint: k.secretHint, ...hit.value };
      const res = await probe(p.slug, p.baseUrl, decryptSecret(k.secretEnc));
      const value = { ...res, checkedAt: new Date().toISOString() };
      cache.set(k.id, { at: Date.now(), value });
      return { keyId: k.id, label: k.label, hint: k.secretHint, ...value };
    }));
    return { slug: p.slug, name: p.name, docsUrl: p.docsUrl, monthSpendUsd: spendBy.get(p.id) ?? 0, keys };
  }));
  return out.sort((a, b) => (order.get(a.slug as typeof BALANCE_PROVIDERS[number]) ?? 9) - (order.get(b.slug as typeof BALANCE_PROVIDERS[number]) ?? 9));
}
