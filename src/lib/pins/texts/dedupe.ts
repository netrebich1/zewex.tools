import { aiChat, type AiCtx } from "@/lib/pins/ai/client";
import { AiError } from "@/lib/pins/ai/errors";
import { LIMITS } from "@/lib/pins/types";
import { cleanTitle, stripAiMentions, stripEmoji, truncateAtWord } from "@/lib/pins/texts/rules";

/**
 * Дубли заголовков в одном CSV Pinterest отклоняет. Повторы переписывает ИИ
 * (порт rewrite-duplicate-titles + titleDedupe.ts); что ИИ не исправил —
 * получает гарантированно уникальную приписку (Ideas, Inspo, Looks…).
 */

export type DedupeRow = { id: string; title: string; keyword: string; description?: string };

export type DedupeOpts = {
  signal?: AbortSignal;
  /** Заголовки, уже занятые вне этого набора (например, другой файл того же дня). */
  taken?: string[];
  /** false — без ИИ, только приписки. */
  ai?: boolean;
};

const SUFFIXES = ["Ideas", "Inspo", "Looks", "Inspiration", "Must-Try", "Favorites", "Picks", "Guide"];
/** Legacy отправлял в ИИ не больше 60 повторов за вызов и не больше 500 занятых заголовков. */
const AI_CHUNK = 60;
const MAX_TAKEN = 500;

/** Ключ сравнения: без регистра и лишних пробелов. */
export function normTitle(s: string): string {
  return (s || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

/** Уникальная приписка: «Title - Ideas», «Title - Inspo», …, «Title - Idea N». */
export function suffixedTitle(title: string, n: number): string {
  const sfx = n < SUFFIXES.length ? SUFFIXES[n] : `Idea ${n - SUFFIXES.length + 2}`;
  return `${title.slice(0, LIMITS.title - sfx.length - 3).trim()} - ${sfx}`;
}

type AiTitle = { i: number; title: string };

function parseTitles(json: unknown): AiTitle[] {
  const obj = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  const list: unknown[] = Array.isArray(json) ? json : obj && Array.isArray(obj.titles) ? obj.titles : obj && Array.isArray(obj.results) ? obj.results : [];
  const out: AiTitle[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const i = Number(r.i);
    if (!Number.isInteger(i) || typeof r.title !== "string") continue;
    const title = truncateAtWord(cleanTitle(stripAiMentions(stripEmoji(r.title))), LIMITS.title);
    if (title) out.push({ i, title });
  }
  return out;
}

/** Один вызов ИИ: до 60 дублей, ответ {"titles":[{"i","title"}]} (text_fast, t=0.9, 40 с). */
async function rewriteWithAi(ctx: AiCtx, items: DedupeRow[], taken: string[], signal?: AbortSignal): Promise<AiTitle[]> {
  const list = items.map((it, i) => ({
    i,
    title: it.title.slice(0, 120),
    keyword: it.keyword.slice(0, 80),
    description: (it.description || "").slice(0, 300),
  }));
  const system = 'You write Pinterest pin titles. Return JSON only: {"titles":[{"i":number,"title":string}]}.';
  const user = `Rewrite each title so it is unique: different wording from the original and from every title in TAKEN and from each other. Same language as original, keep the keyword phrase naturally, max 90 characters, no emojis, no quotes, no hashtags, no ':' or '|' or '-' suffix tricks.\nTAKEN:\n${taken.join("\n")}\nITEMS:\n${JSON.stringify(list)}`;
  const res = await aiChat({ ...ctx, signal: signal ?? ctx.signal }, "text_fast", {
    system,
    user,
    json: true,
    temperature: 0.9,
    maxTokens: 3000,
    timeoutMs: 40_000,
  });
  return parseTitles(res.json);
}

/**
 * Возвращает карту id → новый заголовок только для изменённых строк.
 * Первое вхождение остаётся как есть. AiError вида fatal_run (нет кредитов, плохой ключ)
 * пробрасывается; остальные сбои ИИ → приписки без ИИ.
 */
export async function dedupeTitles(ctx: AiCtx, rows: DedupeRow[], opts: DedupeOpts = {}): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const seen = new Set<string>((opts.taken ?? []).map(normTitle).filter(Boolean));
  const dupIdx: number[] = [];
  rows.forEach((r, i) => {
    const k = normTitle(r.title);
    if (!k) return;
    if (seen.has(k)) dupIdx.push(i);
    else seen.add(k);
  });
  if (!dupIdx.length) return result;

  const current = rows.map((r) => r.title.trim());

  if (opts.ai !== false) {
    for (let start = 0; start < dupIdx.length; start += AI_CHUNK) {
      if (opts.signal?.aborted) break;
      const slice = dupIdx.slice(start, start + AI_CHUNK);
      try {
        const titles = await rewriteWithAi(ctx, slice.map((i) => rows[i]), [...seen].slice(0, MAX_TAKEN), opts.signal);
        for (const t of titles) {
          const row = slice[t.i];
          const k = normTitle(t.title);
          if (row === undefined || !k || seen.has(k)) continue;
          current[row] = t.title;
          seen.add(k);
          result.set(rows[row].id, t.title);
        }
      } catch (e) {
        if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
        /* иначе — приписки ниже */
      }
    }
  }

  // всё, что ИИ не исправил, — гарантированно уникальная приписка
  const finalSeen = new Set<string>((opts.taken ?? []).map(normTitle).filter(Boolean));
  rows.forEach((r, i) => {
    const title = current[i];
    let next = title;
    for (let n = 0; next && finalSeen.has(normTitle(next)); n++) next = suffixedTitle(title, n);
    if (next) finalSeen.add(normTitle(next));
    if (next !== r.title.trim()) result.set(r.id, next);
  });
  return result;
}
