import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";

/**
 * Загрузка лент: обычный fetch или через HTTP-прокси (CONNECT-туннель для https), без внешних пакетов.
 * Ответ ограничен по размеру и времени; редиректы — до 5.
 */

export const NEWS_UA = "Mozilla/5.0 (compatible; ZewexNews/1.0; +https://zewex.tools)";
const MAX_BYTES = 4 * 1024 * 1024;

export type FetchResult = { ok: boolean; status: number; text: string; finalUrl: string; error?: string; viaProxy: boolean };

export async function fetchText(url: string, opts: { proxyUrl?: string | null; timeoutMs?: number; accept?: string } = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const headers = { "User-Agent": NEWS_UA, Accept: opts.accept ?? "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5", "Accept-Language": "uk,ru;q=0.8,en;q=0.6" };
  if (opts.proxyUrl) return viaProxy(url, opts.proxyUrl, headers, timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const text = await readLimited(res);
    return { ok: res.ok, status: res.status, text, finalUrl: res.url || url, viaProxy: false, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, text: "", finalUrl: url, viaProxy: false, error: errText(e) };
  }
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const errText = (e: unknown) => {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "не ответил вовремя";
  return err?.cause?.code || err?.cause?.message || err?.message || String(e);
};

/** Запрос через HTTP-прокси: для https — туннель CONNECT, для http — абсолютный адрес. */
async function viaProxy(url: string, proxyUrl: string, headers: Record<string, string>, timeoutMs: number): Promise<FetchResult> {
  const deadline = Date.now() + timeoutMs;
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    try {
      const r = await oneRequest(current, proxyUrl, headers, Math.max(1000, deadline - Date.now()));
      if (r.status >= 300 && r.status < 400 && r.location) {
        current = new URL(r.location, current).toString();
        continue;
      }
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.body, finalUrl: current, viaProxy: true, error: r.status >= 400 ? `HTTP ${r.status}` : undefined };
    } catch (e) {
      return { ok: false, status: 0, text: "", finalUrl: current, viaProxy: true, error: `прокси: ${errText(e)}` };
    }
  }
  return { ok: false, status: 0, text: "", finalUrl: current, viaProxy: true, error: "слишком много перенаправлений" };
}

function oneRequest(target: string, proxyUrl: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; location?: string; body: string }> {
  const t = new URL(target);
  const p = new URL(proxyUrl);
  const auth = p.username ? "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString("base64") : undefined;
  const proxyPort = Number(p.port || (p.protocol === "https:" ? 443 : 80));
  const reqHeaders: Record<string, string> = { ...headers, Host: t.host, "Accept-Encoding": "gzip, deflate, br", Connection: "close" };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("не ответил вовремя")), timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const onResponse = (res: http.IncomingMessage) => {
      const enc = String(res.headers["content-encoding"] ?? "");
      let stream: NodeJS.ReadableStream = res;
      if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_BYTES) chunks.push(c);
      });
      stream.on("end", () => done(() => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString("utf8") })));
      stream.on("error", (e) => done(() => reject(e)));
    };

    if (t.protocol === "http:") {
      const req = http.request({ host: p.hostname, port: proxyPort, method: "GET", path: target, headers: { ...reqHeaders, ...(auth ? { "Proxy-Authorization": auth } : {}) } }, onResponse);
      req.on("error", (e) => done(() => reject(e)));
      req.end();
      return;
    }
    const connect = http.request({ host: p.hostname, port: proxyPort, method: "CONNECT", path: `${t.hostname}:${t.port || 443}`, headers: { Host: `${t.hostname}:${t.port || 443}`, ...(auth ? { "Proxy-Authorization": auth } : {}) } });
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(() => reject(new Error(`CONNECT ${res.statusCode}`)));
        return;
      }
      const secure = tls.connect({ socket, servername: t.hostname });
      const req = https.request({ host: t.hostname, path: t.pathname + t.search, method: "GET", headers: reqHeaders, createConnection: () => secure }, onResponse);
      req.on("error", (e) => done(() => reject(e)));
      req.end();
    });
    connect.on("error", (e) => done(() => reject(e)));
    connect.end();
  });
}
