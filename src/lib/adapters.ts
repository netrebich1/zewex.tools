import type { Adapter, AuthType } from "@prisma/client";

export type ProviderLike = { adapter: Adapter; authType: AuthType; baseUrl: string; modelsEndpoint?: string | null };

export type RunResult = {
  ok: boolean;
  status: number;
  data: unknown;
  inputTokens: number;
  outputTokens: number;
  units: number;
  error?: string;
};

export type FetchedModel = {
  modelId: string;
  name: string;
  inputPrice: number | null;
  outputPrice: number | null;
  contextLength: number | null;
  capabilities: string;
};

function joinUrl(base: string, path: string) {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

function authHeaders(p: ProviderLike, secret: string): Record<string, string> {
  if (p.authType === "BEARER") return { Authorization: `Bearer ${secret}` };
  if (p.authType === "BASIC") return { Authorization: `Basic ${Buffer.from(secret).toString("base64")}` };
  return {};
}

function withQueryKey(p: ProviderLike, url: string, secret: string) {
  if (p.authType !== "QUERY") return url;
  const u = new URL(url);
  u.searchParams.set("api_key", secret);
  return u.toString();
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

function errorMessage(data: unknown, status: number): string {
  const d = data as { error?: { message?: string } | string; message?: string; status_message?: string; raw?: string };
  if (typeof d?.error === "string") return d.error;
  const m = d?.error?.message ?? d?.message ?? d?.status_message ?? d?.raw;
  if (typeof m === "string") return m;
  if (m != null) return JSON.stringify(m).slice(0, 500);
  if (d?.error != null) return JSON.stringify(d.error).slice(0, 500);
  return `HTTP ${status}`;
}

/** Lightweight connectivity check for a key. */
export async function checkKey(p: ProviderLike, secret: string): Promise<{ ok: boolean; note: string }> {
  try {
    if (p.adapter === "OPENAI_COMPAT") {
      const res = await fetch(joinUrl(p.baseUrl, p.modelsEndpoint ?? "models"), {
        headers: authHeaders(p, secret),
        signal: AbortSignal.timeout(20000),
      });
      const data = await readJson(res);
      if (!res.ok) return { ok: false, note: errorMessage(data, res.status) };
      const n = Array.isArray((data as { data?: unknown[] }).data) ? (data as { data: unknown[] }).data.length : 0;
      return { ok: true, note: n ? `Ключ работает, доступно моделей: ${n}` : "Ключ работает" };
    }
    if (p.adapter === "DATAFORSEO") {
      const res = await fetch(joinUrl(p.baseUrl, "appendix/user_data"), {
        headers: authHeaders(p, secret),
        signal: AbortSignal.timeout(20000),
      });
      const data = (await readJson(res)) as { status_code?: number; status_message?: string; tasks?: Array<{ result?: Array<{ money?: { balance?: number } }> }> };
      if (!res.ok || data.status_code !== 20000) return { ok: false, note: data.status_message ?? `HTTP ${res.status}` };
      const bal = data.tasks?.[0]?.result?.[0]?.money?.balance;
      return { ok: true, note: bal != null ? `Ключ работает, баланс $${bal.toFixed(2)}` : "Ключ работает" };
    }
    if (p.adapter === "SERPAPI") {
      const res = await fetch(withQueryKey(p, joinUrl(p.baseUrl, "account.json"), secret), { signal: AbortSignal.timeout(20000) });
      const data = (await readJson(res)) as { error?: string; total_searches_left?: number; plan_searches_left?: number };
      if (!res.ok || data.error) return { ok: false, note: data.error ?? `HTTP ${res.status}` };
      const left = data.total_searches_left ?? data.plan_searches_left;
      return { ok: true, note: left != null ? `Ключ работает, осталось запросов: ${left}` : "Ключ работает" };
    }
    return { ok: false, note: "Неизвестный адаптер" };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

/** Pull the model catalog from an OpenAI-compatible provider. */
export async function fetchModels(p: ProviderLike, secret: string): Promise<FetchedModel[]> {
  if (p.adapter !== "OPENAI_COMPAT") return [];
  const res = await fetch(joinUrl(p.baseUrl, p.modelsEndpoint ?? "models"), {
    headers: authHeaders(p, secret),
    signal: AbortSignal.timeout(30000),
  });
  const data = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(data, res.status));
  const list = ((data as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>;
  return list
    .filter((m) => typeof m.id === "string")
    .map((m) => {
      const pricing = (m.pricing ?? {}) as { prompt?: string; completion?: string };
      const arch = (m.architecture ?? {}) as { modality?: string; output_modalities?: string[] };
      const caps: string[] = [];
      const modality = arch.modality ?? "";
      const out = arch.output_modalities ?? [];
      if (out.includes("image") || /image|dall-e|flux/i.test(String(m.id))) caps.push("IMAGE");
      if (/embedding/i.test(String(m.id))) caps.push("EMBEDDING");
      if (!caps.length || modality.includes("text")) caps.unshift("CHAT");
      const toPerM = (s?: string) => (s != null && s !== "" && Number.isFinite(Number(s)) ? Number(s) * 1_000_000 : null);
      return {
        modelId: String(m.id),
        name: typeof m.name === "string" ? m.name : String(m.id),
        inputPrice: toPerM(pricing.prompt),
        outputPrice: toPerM(pricing.completion),
        contextLength: typeof m.context_length === "number" ? m.context_length : null,
        capabilities: Array.from(new Set(caps)).join(","),
      };
    });
}

export type RunInput =
  | { kind: "chat"; model: string; body: Record<string, unknown> }
  | { kind: "image"; model: string; body: Record<string, unknown> }
  | { kind: "embedding"; model: string; body: Record<string, unknown> }
  | { kind: "serp"; params: Record<string, string> }
  | { kind: "seo_data"; endpoint: string; body: unknown };

export async function runProvider(p: ProviderLike, secret: string, input: RunInput): Promise<RunResult> {
  const base = { inputTokens: 0, outputTokens: 0, units: 1 };
  try {
    if (input.kind === "chat" || input.kind === "image" || input.kind === "embedding") {
      const path = input.kind === "chat" ? "chat/completions" : input.kind === "image" ? "images/generations" : "embeddings";
      const res = await fetch(joinUrl(p.baseUrl, path), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(p, secret) },
        body: JSON.stringify({ ...input.body, model: input.model, stream: false }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await readJson(res);
      if (!res.ok) return { ...base, ok: false, status: res.status, data, error: errorMessage(data, res.status) };
      const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage ?? {};
      return { ok: true, status: res.status, data, inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, units: 1 };
    }
    if (input.kind === "serp") {
      const u = new URL(joinUrl(p.baseUrl, "search.json"));
      for (const [k, v] of Object.entries(input.params)) u.searchParams.set(k, v);
      const res = await fetch(withQueryKey(p, u.toString(), secret), { signal: AbortSignal.timeout(60000) });
      const data = await readJson(res);
      const err = (data as { error?: unknown }).error;
      if (!res.ok || err) return { ...base, ok: false, status: res.status, data, error: errorMessage(data, res.status) };
      return { ...base, ok: true, status: res.status, data };
    }
    if (input.kind === "seo_data") {
      const res = await fetch(joinUrl(p.baseUrl, input.endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(p, secret) },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(120000),
      });
      const data = (await readJson(res)) as { status_code?: number; status_message?: string; cost?: number; tasks?: unknown[] };
      if (!res.ok || (data.status_code && data.status_code !== 20000)) {
        return { ...base, ok: false, status: res.status, data, error: data.status_message ?? `HTTP ${res.status}` };
      }
      return { ...base, ok: true, status: res.status, data, units: Array.isArray(data.tasks) ? data.tasks.length : 1 };
    }
    return { ...base, ok: false, status: 400, data: null, error: "Неизвестный тип запроса" };
  } catch (e) {
    return { ...base, ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e) };
  }
}
