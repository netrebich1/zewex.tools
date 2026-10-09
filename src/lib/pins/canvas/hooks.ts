/**
 * Тексты для Canvas-пинов («хуки»): порт supabase/functions/canvas-generate-hooks.
 *
 * Что сохранено из легаси: смысловое правило (заголовок = тот же запрос страницы,
 * расширенный LSI-словами), запрет цифр и годов (их подставляет шаблон, кроме цифр
 * из ключа/H1), пачки по 3 страницы, 4 параллельных запроса, 3 попытки, второй проход
 * по одной странице для «недобранных», фолбэк из заголовка страницы.
 * Что изменилось: заголовок ≤ 36 знаков (цель — 3 строки), без эмодзи, язык из входа,
 * вызов идёт через aiChat (слот text_main), ключ выбирает портал — ротация на повторе
 * происходит сама, если предыдущий ключ отключён.
 */

import { aiChat, type AiCtx } from "@/lib/pins/ai/client";
import { AiError } from "@/lib/pins/ai/errors";
import { SLOT_TEXT_MAIN } from "@/lib/pins/types";

export interface HookPageInput {
  id: string;
  keyword: string;
  title: string;
  topic: string;
  niche: string;
  season?: string;
  ideaCount?: number;
}

export interface GenerateHooksInput {
  pages: HookPageInput[];
  language: string;
  audience: string;
  perPage: number;
}

export interface CanvasHook {
  title: string;
  kicker?: string;
  cta?: string;
}

export interface GenerateHooksOptions {
  signal?: AbortSignal;
}

export const HOOK_TITLE_MAX = 36;
export const HOOK_KICKER_MAX = 22;
export const HOOK_CTA_MAX = 18;

const BATCH = 3;
const CONCURRENCY = 4;
const ATTEMPTS = 3;
const CALL_TIMEOUT_MS = 30_000;

/* ---------- чистка текста ---------- */

const EMOJI_RE = /\p{Extended_Pictographic}|️|‍|[\u{1F1E6}-\u{1F1FF}]/gu;

function clean(s: unknown, max: number): string {
  const base = String(s ?? "")
    .replace(EMOJI_RE, "")
    .replace(/[«»"“”]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[.!]+$/, "")
    .trim();
  if (base.length <= max) return base;
  // Режем по границе слова, чтобы не оставлять обрубков.
  const cut = base.slice(0, max + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : base.slice(0, max)).replace(/[\s,:;—–-]+$/, "").trim();
}

/** Цифры в текст не пускаем: число идей и год подставляет движок шаблона.
 *  Исключение: цифры из ключевого слова/заголовка (возраст «Over 40», размер) сохраняем. */
function stripDigits(s: string, allowed: readonly string[]): string {
  const keep = new Set(allowed);
  return s
    .replace(/\d+/g, (digit) => (keep.has(digit) ? digit : " "))
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:—–-]+|[\s:—–-]+$/g, "")
    .trim();
}

/** Цифры, встречающиеся в ключевом слове или заголовке страницы. */
function keywordDigits(...parts: Array<string | undefined>): string[] {
  const found = new Set<string>();
  for (const p of parts) for (const m of String(p ?? "").matchAll(/\d+/g)) found.add(m[0]);
  return Array.from(found).sort((a, b) => b.length - a.length);
}

/* ---------- промт ---------- */

function systemPrompt(language: string, audience: string, perPage: number): string {
  return [
    `Ти — копірайтер Pinterest-пінів. Пишеш ТІЛЬКИ мовою: ${language}.`,
    audience ? `Аудиторія сайту: ${audience}.` : "",
    `Для кожної сторінки дай ${perPage} варіантів тексту для картинки піна.`,
    "Тематика сайту і ніша вказані у кожній сторінці (поля topic, niche).",
    "ГОЛОВНЕ ПРАВИЛО СМИСЛУ: кожен заголовок — це той самий запит сторінки, лише трохи розширений",
    "LSI-словами і тематичними ключами (синоніми, уточнення, аудиторія, сезон, привід, довжина/тип).",
    "Заборонено підміняти тему або звужувати її до іншого підвиду: якщо стаття про «короткі стрижки»,",
    "не можна писати «стрижка піксі», «каре» чи будь-який інший конкретний підвид, якого немає в keyword/title.",
    "Ключове слово (або його очевидний синонім/словоформа) має бути присутнє в кожному title.",
    "Не додавай фактів, яких немає в keyword/title (бренди, імена, конкретні техніки, ціни, локації).",
    "Варіанти різняться формулюванням і акцентом, а не темою.",
    "Правила форми:",
    `- title: 3-6 слів, до ${HOOK_TITLE_MAX} знаків (читається у 3 короткі рядки), чіпляючий хук; БЕЗ крапки в кінці, без лапок.`,
    "- Жодних емодзі та спецсимволів у жодному полі.",
    "- СУВОРО ЗАБОРОНЕНО використовувати будь-які цифри та роки в title, kicker, cta",
    "  (кількість ідей і рік підставляє шаблон автоматично). Не пиши «7 ідей», «2025» тощо.",
    "- ВИНЯТОК: цифри, що вже є в keyword/title сторінки (вік «Over 40», розмір, номер моделі),",
    "  ЗБЕРІГАЙ у title обов'язково — це частина теми, а не лічильник ідей.",
    `- kicker: коротка плашка до ${HOOK_KICKER_MAX} знаків (рубрика/сезон), теж у межах теми, без цифр.`,
    `- cta: до ${HOOK_CTA_MAX} знаків, дієслово-заклик.`,
    "- Не повторювати назву бренду або домен у тексті.",
    "- Не дублювати однакові заголовки між варіантами.",
    'Формат відповіді — суворо JSON: {"results":[{"id":"<id сторінки>","hooks":[{"title":"","kicker":"","cta":""}]}]}',
  ].filter(Boolean).join("\n");
}

function userPayload(chunk: HookPageInput[]): string {
  return JSON.stringify(chunk.map((p) => ({
    id: p.id,
    title: p.title || "",
    keyword: p.keyword || "",
    topic: p.topic || "",
    niche: p.niche || "",
    season: p.season || "",
    ideas: p.ideaCount ?? null,
  })));
}

/* ---------- разбор ответа ---------- */

type RawHook = { title?: unknown; kicker?: unknown; cta?: unknown };
type RawRow = { id?: unknown; hooks?: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseResults(json: unknown): RawRow[] {
  if (!isRecord(json)) return [];
  const arr = json.results;
  return Array.isArray(arr) ? arr.filter(isRecord) : [];
}

function toHooks(row: RawRow, src: HookPageInput): CanvasHook[] {
  const allow = keywordDigits(src.keyword, src.title);
  const list = Array.isArray(row.hooks) ? row.hooks.filter(isRecord) : [];
  const out: CanvasHook[] = [];
  const seen = new Set<string>();
  for (const h of list as RawHook[]) {
    const title = stripDigits(clean(h.title, HOOK_TITLE_MAX), allow);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const kicker = stripDigits(clean(h.kicker, HOOK_KICKER_MAX), allow);
    const cta = stripDigits(clean(h.cta, HOOK_CTA_MAX), allow);
    out.push({ title, ...(kicker ? { kicker } : {}), ...(cta ? { cta } : {}) });
  }
  return out;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/* ---------- основной вызов ---------- */

export async function generateHooks(
  ctx: AiCtx,
  input: GenerateHooksInput,
  opts: GenerateHooksOptions = {},
): Promise<Map<string, CanvasHook[]>> {
  const signal = opts.signal ?? ctx.signal;
  const aiCtx: AiCtx = { ...ctx, signal };
  const perPage = Math.max(1, Math.min(5, Math.floor(input.perPage) || 1));
  const system = systemPrompt(input.language || "українська", input.audience || "", perPage);
  const results = new Map<string, CanvasHook[]>();
  const errors: string[] = [];

  async function runChunk(chunk: HookPageInput[]): Promise<void> {
    const user = userPayload(chunk);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (signal?.aborted) return;
      try {
        const res = await aiChat(aiCtx, SLOT_TEXT_MAIN, {
          system, user, json: true, temperature: 0.8, maxTokens: 4000, timeoutMs: CALL_TIMEOUT_MS,
        });
        for (const row of parseResults(res.json)) {
          const id = String(row.id ?? "");
          const src = chunk.find((p) => p.id === id);
          if (!src) continue;
          const hooks = toHooks(row, src);
          if (hooks.length && hooks.length >= (results.get(id)?.length ?? 0)) results.set(id, hooks.slice(0, perPage));
        }
        return;
      } catch (e) {
        if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
        if (e instanceof AiError && e.cls.kind === "permanent") { errors.push(e.message); return; }
        if (attempt === ATTEMPTS - 1) errors.push(e instanceof Error ? e.message : String(e));
        else await sleep(1200 * (attempt + 1), signal);
      }
    }
  }

  async function runPool(list: HookPageInput[], size: number): Promise<void> {
    const chunks: HookPageInput[][] = [];
    for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
      while (cursor < chunks.length && !signal?.aborted) {
        const chunk = chunks[cursor++];
        await runChunk(chunk);
      }
    });
    await Promise.all(workers);
  }

  // 1-й проход — пачками, параллельно.
  await runPool(input.pages, BATCH);
  // 2-й проход — добираем страницы, где вариантов меньше запрошенного.
  const incomplete = input.pages.filter((p) => (results.get(p.id)?.length ?? 0) < perPage);
  if (incomplete.length && !signal?.aborted) await runPool(incomplete, 1);

  // Фолбэк: страницы без хуков получают заголовок/ключ страницы.
  for (const p of input.pages) {
    if (results.get(p.id)?.length) continue;
    const base = (p.title || p.keyword || "").trim();
    if (!base) continue;
    const allow = keywordDigits(p.keyword, p.title);
    const kicker = stripDigits(clean(p.season || p.topic || "", HOOK_KICKER_MAX), allow);
    results.set(p.id, [{ title: stripDigits(clean(base, HOOK_TITLE_MAX), allow), ...(kicker ? { kicker } : {}) }]);
  }

  if (errors.length && results.size === 0) throw new Error(`Хуки не сгенерированы: ${errors[0]}`);
  return results;
}
