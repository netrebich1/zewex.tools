/**
 * Сеть «Стилиста». Часть магазинов (Zara) не открывается с адреса сервера, поэтому запрос идёт через SOCKS5-прокси
 * из общего списка портала («Прокси» в DeepL Articler). Счётчики сбоев прокси здесь не трогаем: отказ магазина — не вина прокси.
 * Магазины, которые открываются напрямую (Parfois), ходят без прокси — трафик прокси не тратится.
 */
import { fetch as ufetch, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let cache: { at: number; list: Dispatcher[] } | null = null;

async function proxies(): Promise<Dispatcher[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  const rows = await prisma.deeplProxy.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
  const list = rows.map((r) => socksDispatcher({ type: 5, host: r.host, port: r.port, ...(r.username ? { userId: r.username, password: r.passwordEnc ? decryptSecret(r.passwordEnc) : "" } : {}) }));
  cache = { at: Date.now(), list };
  return list;
}

export class BlockedError extends Error {}

/**
 * Страница или JSON магазина текстом. `proxy: true` — через прокси (по очереди, до 3 попыток на разных);
 * без рабочих прокси пробуем напрямую. 403/429 — магазин не пускает: BlockedError с понятным текстом.
 */
export async function shopGet(url: string, opts: { proxy?: boolean; accept?: string; lang?: string } = {}): Promise<string> {
  const list = opts.proxy ? await proxies() : [];
  const tries: Array<Dispatcher | null> = list.length ? shuffle(list).slice(0, 3) : [null];
  let last: Error = new Error("нет ответа");
  for (const d of tries) {
    try {
      const res = await ufetch(url, {
        ...(d ? { dispatcher: d } : {}),
        headers: { "user-agent": UA, accept: opts.accept ?? "application/json,text/html;q=0.9,*/*;q=0.8", "accept-language": opts.lang ?? "en-GB,en;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 403 || res.status === 429) {
        await res.body?.cancel().catch(() => {});
        last = new BlockedError(`магазин не пускает автоматические запросы (ответ ${res.status})`);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`ответ ${res.status}`);
      }
      return await res.text();
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      last = e instanceof BlockedError ? e : new Error(`${e instanceof Error ? e.message : String(e)}${cause}`);
    }
  }
  throw last;
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
