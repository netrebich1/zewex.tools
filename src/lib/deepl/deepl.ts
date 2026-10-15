/**
 * DeepL: пул ключей уровня инструмента (DeeplKey) с ротацией, кэш переводов (DeeplCache) и перевод статьи по фрагментам.
 * Порт runTranslate / deeplRequest / refreshDeeplUsage из article-jumble-maker. Отличия:
 * - фрагменты одной статьи уходят параллельно (DEEPL_CHUNK_CONCURRENCY), порядок сохраняется;
 * - ключ выбирается из общего пула процесса с резервом символов, чтобы параллельные запросы не перерасходовали лимит;
 * - исходный язык приводится к базовому коду (EN-GB → EN): DeepL принимает варианты только как целевой язык.
 */
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  chunkHtml, chunkIsFatal, protectHtml, repairPlaceholders, repairTagDrift, restoreHtml, validateChunk, visibleTextLength,
  type QualityIssue,
} from "./html";

const CHUNK_CONCURRENCY = Number(process.env.DEEPL_CHUNK_CONCURRENCY || 3);
/** Одновременных запросов на один ключ DeepL: нагрузка раскладывается по всем рабочим ключам параллельно. */
const PER_KEY_CONCURRENCY = Number(process.env.DEEPL_PER_KEY_CONCURRENCY || 2);
const REQUEST_TIMEOUT_MS = 90_000;
/** Ключи перечитываются из базы не чаще раза в 30 с (новые ключи, лимиты, включение/выключение на странице ключей). */
const POOL_TTL_MS = 30_000;

type PoolKey = { id: string; label: string; secret: string; sortOrder: number; charLimit: number | null; charUsed: number; reserved: number; inflight: number; dead: boolean };

let pool: PoolKey[] | null = null;
let poolAt = 0;

async function loadPool(force = false): Promise<PoolKey[]> {
  if (pool && !force && Date.now() - poolAt < POOL_TTL_MS) return pool;
  const rows = await prisma.deeplKey.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  const prev = new Map((pool ?? []).map((k) => [k.id, k]));
  pool = rows.map((r) => {
    const old = prev.get(r.id);
    return {
      id: r.id,
      label: r.label,
      secret: decryptSecret(r.secretEnc),
      sortOrder: r.sortOrder,
      charLimit: r.charLimit,
      // Расход пишется в базу сразу после каждого ответа, поэтому база — главный источник; в памяти только резерв идущих запросов.
      charUsed: r.charUsed,
      reserved: old?.reserved ?? 0,
      inflight: old?.inflight ?? 0,
      dead: false,
    };
  });
  poolAt = Date.now();
  return pool;
}

/** Учёт как в исходном сервисе: видимый текст фрагмента + 15% запаса на разметку. */
const billChars = (c: string) => Math.ceil(visibleTextLength(c) * 1.15);
const remaining = (k: PoolKey) => (k.charLimit == null ? Infinity : k.charLimit - k.charUsed - k.reserved);

/**
 * Ключ для фрагмента. Как в исходном сервисе: только активные ключи, у которых остатка лимита хватает на фрагмент
 * (проверка ДО платного запроса). В отличие от исходного (ключи строго по очереди), ключи работают параллельно:
 * берётся самый свободный ключ (меньше запросов в работе), при равенстве — по порядку из списка.
 * Все ключи заняты — ждём освобождения; ни у одного не хватает остатка — null.
 */
async function takeKey(chars: number, skip: Set<string>): Promise<PoolKey | null> {
  for (;;) {
    const keys = (await loadPool()).filter((k) => !k.dead && !skip.has(k.id) && remaining(k) >= chars);
    if (!keys.length) return null;
    const free = keys.filter((k) => k.inflight < PER_KEY_CONCURRENCY);
    if (free.length) {
      const k = free.reduce((best, x) => (x.inflight < best.inflight || (x.inflight === best.inflight && x.sortOrder < best.sortOrder) ? x : best));
      k.reserved += chars;
      k.inflight++;
      return k;
    }
    await sleep(150);
  }
}

function releaseKey(k: PoolKey, chars: number): void {
  k.reserved = Math.max(0, k.reserved - chars);
  k.inflight = Math.max(0, k.inflight - 1);
}

async function markDead(k: PoolKey, note: string): Promise<void> {
  k.dead = true;
  await prisma.deeplKey.update({ where: { id: k.id }, data: { isActive: false, lastError: note.slice(0, 500) } }).catch(() => {});
}

async function addUsage(k: PoolKey, chars: number): Promise<void> {
  k.charUsed += chars;
  await prisma.deeplKey.update({ where: { id: k.id }, data: { charUsed: { increment: chars }, lastError: null } }).catch(() => {});
}

export function deeplBase(secret: string): string {
  return secret.trim().endsWith(":fx") ? "https://api-free.deepl.com/v2" : "https://api.deepl.com/v2";
}

/** DeepL принимает варианты (EN-GB, PT-BR) только как целевой язык; исходный — базовый код. */
export function sourceCode(lang?: string | null): string | null {
  const l = (lang ?? "").trim().toUpperCase();
  if (!l || l === "AUTO") return null;
  return l.split("-")[0]!;
}

type DeeplResult = { ok: true; text: string } | { ok: false; status: number; body: string };

async function deeplRequest(secret: string, text: string, target: string, source: string | null): Promise<DeeplResult> {
  const body: Record<string, unknown> = { text: [text], target_lang: target, tag_handling: "html", ignore_tags: ["code", "pre", "x-ph"] };
  if (source) body.source_lang = source;
  try {
    const res = await fetch(`${deeplBase(secret)}/translate`, {
      method: "POST",
      headers: { Authorization: `DeepL-Auth-Key ${secret.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, body: (await res.text()).slice(0, 300) };
    const data = (await res.json()) as { translations?: Array<{ text?: string }> };
    return { ok: true, text: data?.translations?.[0]?.text ?? "" };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

function cacheKey(text: string, target: string, source: string | null): string {
  return createHash("sha256").update(`${source || "auto"}>${target}\n${text}`).digest("hex");
}

/** Перевод одного фрагмента: кэш → ключи по порядку → проверка качества (до 2 повторов). */
async function translateChunk(
  chunk: string,
  target: string,
  source: string | null,
  label: string,
): Promise<{ html: string; warnings: QualityIssue[]; cached: boolean; rolledBack: boolean; chars: number; keyLabel?: string }> {
  const hash = cacheKey(chunk, target, source);
  const hit = await prisma.deeplCache.findUnique({ where: { hash }, select: { result: true } });
  if (hit) return { html: hit.result, warnings: [], cached: true, rolledBack: false, chars: 0 };
  if (!visibleTextLength(chunk)) return { html: chunk, warnings: [], cached: false, rolledBack: false, chars: 0 };

  const warnings: QualityIssue[] = [];
  const need = billChars(chunk);
  const skip = new Set<string>();
  let attempts = 0;
  let quality = 0;
  let spent = 0;
  for (;;) {
    const key = await takeKey(need, skip);
    if (!key) {
      throw new Error((await loadPool()).length ? "Нет доступных ключей DeepL: у всех рабочих ключей не хватает лимита символов — добавьте ключи или обновите расход" : "Нет активных ключей DeepL — добавьте ключи на вкладке «Ключи DeepL»");
    }
    let res: DeeplResult;
    try {
      res = await deeplRequest(key.secret, chunk, target, source);
    } finally {
      releaseKey(key, need);
    }
    if (!res.ok) {
      if (res.status === 456 || res.status === 403 || res.status === 401) {
        await markDead(key, `${res.status}: ${res.body}`);
        warnings.push({ code: "key_switch", detail: `${label}: ключ «${key.label}» недоступен (${res.status === 456 ? "лимит исчерпан" : res.status}), переключение` });
        skip.add(key.id);
        continue;
      }
      if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempts < 4) {
        attempts++;
        await sleep(2000 * attempts);
        continue;
      }
      throw new Error(`DeepL ${res.status}: ${res.body}`);
    }
    // DeepL списывает символы за любой успешный ответ, даже если мы его отбросим.
    await addUsage(key, need);
    spent += need;
    const cleaned = repairTagDrift(chunk, repairPlaceholders(chunk, res.text ?? ""));
    const issues = validateChunk(chunk, cleaned);
    if (chunkIsFatal(issues)) {
      if (quality < 2) {
        quality++;
        await sleep(1000);
        continue;
      }
      // Не прошёл проверку и после повторов: оставляем исходный текст и не кэшируем битый перевод.
      warnings.push({ code: "chunk_rollback", detail: `${label}: результат не прошёл проверку (${issues.map((x) => x.detail).join("; ")}) — оставлен исходный фрагмент` });
      return { html: chunk, warnings, cached: false, rolledBack: true, chars: spent, keyLabel: key.label };
    }
    warnings.push(...issues.map((x) => ({ ...x, detail: `${label}: ${x.detail}` })));
    await prisma.deeplCache
      .upsert({ where: { hash }, update: { result: cleaned }, create: { hash, sourceLang: source, targetLang: target, srcChars: chunk.length, result: cleaned } })
      .catch(() => {});
    return { html: cleaned, warnings, cached: false, rolledBack: false, chars: spent, keyLabel: key.label };
  }
}

export type TranslateResult = { html: string; warnings: QualityIssue[]; rolledBack: number; chars: number; keysUsed: string[] };

/**
 * Перевод HTML. preProtected — html уже защищён плейсхолдерами на весь прогон статьи (так делает воркер),
 * иначе защищаем и восстанавливаем здесь.
 */
export async function runTranslate(html: string, target: string, source?: string | null, preProtected = false): Promise<TranslateResult> {
  const src = sourceCode(source);
  const tgt = target.trim().toUpperCase();
  const { text: protectedHtml, tokens } = preProtected ? { text: html, tokens: [] as string[] } : protectHtml(html);
  const chunks = chunkHtml(protectedHtml, 8000);
  const results = await mapLimit(chunks, CHUNK_CONCURRENCY, (c, i) => translateChunk(c, tgt, src, `фрагмент ${i + 1}/${chunks.length}`));
  const warnings: QualityIssue[] = results.flatMap((r) => r.warnings);
  const cached = results.filter((r) => r.cached).length;
  if (cached) warnings.push({ code: "cache_hit", detail: `из кэша без запроса в DeepL: ${cached}/${chunks.length} фрагментов` });
  const joined = results.map((r) => r.html).join("");
  return {
    html: preProtected ? joined : restoreHtml(joined, tokens),
    warnings,
    rolledBack: results.filter((r) => r.rolledBack).length,
    chars: results.reduce((a, r) => a + r.chars, 0),
    keysUsed: [...new Set(results.map((r) => r.keyLabel).filter((x): x is string => !!x))],
  };
}

/** Перевод списка ключей на язык итогового текста одним запросом; при сбое — исходный список. */
export async function translateKeywords(keys: string[], target?: string | null, source?: string | null): Promise<string[]> {
  const clean = keys.map((k) => k.trim()).filter(Boolean);
  if (!clean.length || !target) return clean;
  try {
    const payload = clean.map((k) => `<p>${k}</p>`).join("");
    const r = await runTranslate(payload, target, source ?? null, true);
    const out = [...r.html.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
    return out.length === clean.length && out.every(Boolean) ? out : clean;
  } catch {
    return clean;
  }
}

/**
 * Обновить расход всех ключей по /v2/usage (кнопка на странице ключей; ключи опрашиваются параллельно).
 * Лимит, заданный вручную (limitManual), не перезаписывается — как «Лимит символов» в исходном сервисе.
 * Ключ, выключенный из-за исчерпания (456), снова включается, если DeepL показывает свободный остаток (новый месяц).
 */
export async function refreshDeeplUsage(): Promise<{ ok: number; failed: number; revived: number }> {
  const keys = await prisma.deeplKey.findMany();
  let ok = 0;
  let failed = 0;
  let revived = 0;
  await mapLimit(keys, 8, async (k) => {
    const secret = decryptSecret(k.secretEnc);
    try {
      const res = await fetch(`${deeplBase(secret)}/usage`, { headers: { Authorization: `DeepL-Auth-Key ${secret.trim()}` }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        failed++;
        await prisma.deeplKey.update({
          where: { id: k.id },
          data: { lastError: `usage ${res.status}: ${(await res.text()).slice(0, 200)}`, usageAt: new Date(), ...(res.status === 403 || res.status === 401 ? { isActive: false } : {}) },
        });
        return;
      }
      const u = (await res.json()) as { character_count?: number; character_limit?: number };
      ok++;
      const dlLimit = typeof u.character_limit === "number" && u.character_limit > 0 && u.character_limit < 1e12 ? u.character_limit : null;
      const used = typeof u.character_count === "number" ? u.character_count : k.charUsed;
      const limit = k.limitManual ? k.charLimit : dlLimit;
      const exhaustedOff = !k.isActive && /^456/.test(k.lastError ?? "");
      const revive = exhaustedOff && (limit == null || used < limit);
      if (revive) revived++;
      await prisma.deeplKey.update({
        where: { id: k.id },
        data: { charUsed: used, charLimit: limit, usageAt: new Date(), ...(revive ? { isActive: true, lastError: null } : k.isActive ? { lastError: null } : {}) },
      });
    } catch (e) {
      failed++;
      await prisma.deeplKey.update({ where: { id: k.id }, data: { lastError: e instanceof Error ? e.message : String(e), usageAt: new Date() } });
    }
  });
  pool = null;
  return { ok, failed, revived };
}

/** Проверка ключа перед сохранением: /v2/usage отвечает 200. */
export async function checkDeeplKey(secret: string): Promise<{ ok: boolean; note: string; used?: number; limit?: number | null }> {
  try {
    const res = await fetch(`${deeplBase(secret)}/usage`, { headers: { Authorization: `DeepL-Auth-Key ${secret.trim()}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, note: res.status === 403 ? "DeepL отклонил ключ (403)" : `DeepL ответил ${res.status}` };
    const u = (await res.json()) as { character_count?: number; character_limit?: number };
    const limit = typeof u.character_limit === "number" && u.character_limit > 0 && u.character_limit < 1e12 ? u.character_limit : null;
    return { ok: true, note: "ключ работает", used: u.character_count ?? 0, limit };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

/** Сбросить кэш пула (после правки ключей в настройках — в процессе сайта; воркер перечитает сам через минуту). */
export function resetDeeplPool(): void {
  pool = null;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
