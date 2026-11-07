import { safeFetch, type SafeFetchResult } from "@/lib/pins/fetch";

/**
 * Проверка редиректов списка URL (порт edge-функции check-redirects).
 * safeFetch сам следует редиректам и перепроверяет конечный хост, поэтому
 * цепочка не обходится вручную: hops = 1, если адрес изменился, иначе 0.
 */

export type RedirectResult = { finalUrl: string; status: number; hops: number; error?: string };

const HOP_TIMEOUT_MS = 12_000;
const MAX_HOPS = 8;
const UA = "Mozilla/5.0 (compatible; Pinterestbot/1.0)";

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/redirect count exceeded|too many redirects|maximum redirect/i.test(m)) return "too many redirects";
  return m || "fetch failed";
}

async function attempt(url: string, method: "HEAD" | "GET", signal?: AbortSignal): Promise<SafeFetchResult> {
  return safeFetch(url, {
    method,
    // один таймаут на всю цепочку вместо 12 с на прыжок
    timeoutMs: HOP_TIMEOUT_MS * Math.min(MAX_HOPS, 3),
    maxBytes: 4 * 1024 * 1024,
    accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    headers: { "User-Agent": UA },
    signal,
  });
}

/** Некоторые серверы не умеют HEAD — тогда повторяем GET. */
function needsGet(res: SafeFetchResult): boolean {
  return res.status === 405 || res.status === 403 || res.status === 404 || res.status === 501 || res.status >= 500;
}

async function resolveOne(url: string, signal?: AbortSignal): Promise<RedirectResult> {
  let res: SafeFetchResult | null = null;
  let headError = "";
  try {
    res = await attempt(url, "HEAD", signal);
  } catch (e) {
    headError = errMsg(e);
  }
  if (!res || needsGet(res)) {
    if (signal?.aborted) return { finalUrl: url, status: 0, hops: 0, error: "aborted" };
    try {
      res = await attempt(url, "GET", signal);
    } catch (e) {
      const err = errMsg(e);
      return { finalUrl: res?.finalUrl ?? url, status: res?.status ?? 0, hops: 0, error: err || headError };
    }
  }
  if (!res) return { finalUrl: url, status: 0, hops: 0, error: headError || "fetch failed" };
  const finalUrl = res.finalUrl || url;
  return { finalUrl, status: res.status, hops: finalUrl !== url ? 1 : 0 };
}

/** Возвращает конечный адрес и статус для каждого уникального URL; ошибки — в поле error, не бросаются. */
export async function checkRedirects(
  urls: string[],
  opts: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<Map<string, RedirectResult>> {
  const list = Array.from(new Set(urls.map((u) => String(u || "").trim()).filter(Boolean)));
  const out = new Map<string, RedirectResult>();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, list.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      if (opts.signal?.aborted) return;
      const u = list[cursor++];
      out.set(u, await resolveOne(u, opts.signal));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
