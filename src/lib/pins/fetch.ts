import { lookup } from "dns/promises";
import { isIP } from "net";

/**
 * Безопасная загрузка внешних адресов (статьи, фото): таймаут, лимит размера,
 * запрет приватных сетей и адресов-литералов (защита от SSRF).
 */

const UA = "Mozilla/5.0 (compatible; ZewexPins/1.0; +https://zewex.tools)";

function isPrivateIp(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
  const m = low.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    // IPv4-mapped IPv6: ::ffff:127.0.0.1 или ::ffff:7f00:1
    const mapped = low.match(/^::ffff:([0-9a-f:.]+)$/);
    if (!mapped) return false;
    const rest = mapped[1];
    if (rest.includes(".")) return isPrivateIp(rest);
    const hex = rest.split(":");
    if (hex.length !== 2) return true;
    const n = (parseInt(hex[0], 16) << 16) | parseInt(hex[1], 16);
    return isPrivateIp(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Некорректный адрес: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Недопустимый протокол: ${u.protocol}`);
  if (u.username || u.password) throw new Error("Адрес с логином и паролем не допускается");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error(`Недопустимый хост: ${host}`);
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Недопустимый адрес: ${host}`);
    return u;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error(`Хост не найден: ${host}`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error(`Хост ${host} указывает на приватную сеть`);
  return u;
}

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: "GET" | "HEAD";
};

export type SafeFetchResult = { status: number; ok: boolean; headers: Headers; body: Buffer; finalUrl: string };

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 12 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted");
  await assertPublicUrl(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  const onOuter = () => ac.abort(opts.signal?.reason ?? new Error("aborted"));
  opts.signal?.addEventListener("abort", onOuter, { once: true });
  try {
    // Редиректы проходим вручную: каждый хоп проверяется до запроса (иначе редирект на 127.0.0.1 уже выполнится).
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 6; hop++) {
      const r = await fetch(current, {
        method: opts.method ?? "GET",
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: opts.accept ?? "*/*", ...(opts.headers ?? {}) },
        signal: ac.signal,
      });
      const loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) {
        try { await r.body?.cancel(); } catch { /* noop */ }
        const nextUrl = new URL(loc, current).toString();
        await assertPublicUrl(nextUrl);
        current = nextUrl;
        continue;
      }
      res = r;
      break;
    }
    if (!res) throw new Error("Слишком много редиректов");
    Object.defineProperty(res, "url", { value: current });
    const len = Number(res.headers.get("content-length") || 0);
    if (len > maxBytes) throw new Error(`Файл больше лимита ${Math.round(maxBytes / 1048576)} МБ`);
    if (opts.method === "HEAD" || !res.body) {
      return { status: res.status, ok: res.ok, headers: res.headers, body: Buffer.alloc(0), finalUrl: res.url || url };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Файл больше лимита ${Math.round(maxBytes / 1048576)} МБ`);
      }
      chunks.push(Buffer.from(value));
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body: Buffer.concat(chunks), finalUrl: res.url || url };
  } finally {
    clearTimeout(t);
    opts.signal?.removeEventListener("abort", onOuter);
  }
}
