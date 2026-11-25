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

type Proxy = { key: string; dispatcher: Dispatcher };

let cache: { at: number; list: Proxy[] } | null = null;

async function proxies(): Promise<Proxy[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.list;
  const rows = await prisma.deeplProxy.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
  const list = rows.map((r) => ({ key: r.id, dispatcher: socksDispatcher({ type: 5, host: r.host, port: r.port, ...(r.username ? { userId: r.username, password: r.passwordEnc ? decryptSecret(r.passwordEnc) : "" } : {}) }) as Dispatcher }));
  cache = { at: Date.now(), list };
  return list;
}

export class BlockedError extends Error {}

/**
 * Память «какой прокси пускает какой магазин» (22.11.2026: из пяти прокси бренды Inditex пускали два, ещё два получали 403,
 * один не отвечал; случайный выбор на каждый запрос ронял сбор). good — прокси, через который сайт ответил в прошлый раз:
 * им и ходим весь сбор (один адрес на сессию); bad — прокси, получивший отказ или сбой, до времени, когда его можно пробовать снова.
 */
const good = new Map<string, string>();
const bad = new Map<string, number>();
const BAD_MS = 2 * 3600_000;
const siteOf = (url: string) => new URL(url).hostname.split(".").slice(-2).join(".");

/**
 * Страница или JSON магазина текстом. `proxy: true` — через прокси: сначала тот, что уже сработал для этого сайта,
 * затем остальные по очереди (все, а не три случайных); без рабочих прокси пробуем напрямую.
 * 403/429 от всех — магазин не пускает: BlockedError с понятным текстом.
 */
export async function shopGet(url: string, opts: { proxy?: boolean; accept?: string; lang?: string } = {}): Promise<string> {
  const site = siteOf(url);
  const all = opts.proxy ? await proxies() : [];
  const now = Date.now();
  const rank = (p: Proxy) => (good.get(site) === p.key ? 0 : (bad.get(`${site}|${p.key}`) ?? 0) > now ? 2 : 1);
  const tries: Array<Proxy | null> = all.length ? shuffle(all).sort((x, y) => rank(x) - rank(y)) : [null];
  let last: Error = new Error("нет ответа");
  for (const p of tries) {
    try {
      const res = await ufetch(url, {
        ...(p ? { dispatcher: p.dispatcher } : {}),
        headers: { "user-agent": UA, accept: opts.accept ?? "application/json,text/html;q=0.9,*/*;q=0.8", "accept-language": opts.lang ?? "en-GB,en;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 403 || res.status === 429) {
        await res.body?.cancel().catch(() => {});
        if (p) {
          bad.set(`${site}|${p.key}`, now + BAD_MS);
          if (good.get(site) === p.key) good.delete(site);
        }
        last = new BlockedError(`магазин не пускает автоматические запросы (ответ ${res.status})`);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        // 404 и подобное — ответ самого сайта, другой прокси его не изменит.
        throw Object.assign(new Error(`ответ ${res.status}`), { final: true });
      }
      const text = await res.text();
      if (p) good.set(site, p.key);
      return text;
    } catch (e) {
      if (e instanceof Error && (e as { final?: boolean }).final) throw e;
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      last = e instanceof BlockedError ? e : new Error(`${e instanceof Error ? e.message : String(e)}${cause}`);
      // Прокси не ответил (сеть) — на полчаса в конец очереди для этого сайта.
      if (p && !(e instanceof BlockedError)) bad.set(`${site}|${p.key}`, now + 30 * 60_000);
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
