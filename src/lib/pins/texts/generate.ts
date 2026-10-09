import { aiChat, type AiCtx } from "@/lib/pins/ai/client";
import { LIMITS } from "@/lib/pins/types";
import {
  applyLimits,
  cleanTitle,
  inShare,
  makeHashtags,
  normalizeHashtags,
  requireTerms,
  seasonalTerms,
  stripAiMentions,
  stripEmoji,
  stripHashtags,
  type PinTexts,
} from "@/lib/pins/texts/rules";

/**
 * Тексты пинов: title / description / alt (порт edge-функции bulk-generate-descriptions
 * и этапа stageTexts воркера). Слот text_main, чанки по 10, JSON-ответ.
 * Эмодзи нет совсем: модель их не просим, а всё пришедшее вырезаем.
 */

export type TextItem = {
  id: string;
  keyword: string;
  topic: string;
  pageTitle: string;
  h1: string;
  url: string;
  boardName: string;
  kind: "pin" | "photo";
  engine: string;
  prompt?: string;
  season?: string;
  seasonWord?: string;
};

export type TextInput = {
  items: TextItem[];
  language: string;
  hashtags: boolean;
  /** Доля элементов с хэштегами, 0–100 (variety рецепта). По умолчанию 100 при hashtags=true. */
  hashtagShare?: number;
  audience: string;
  siteName: string;
};

export type TextOpts = {
  signal?: AbortSignal;
  concurrency?: number;
  onBatch?: (done: number, total: number) => void | Promise<void>;
};

const CHUNK = 10;
const CONCURRENCY = 3;
const MAX_TAGS = 5;

/** Системный промт (текст правил legacy; блок эмодзи заменён запретом, добавлены аудитория/сайт/ИИ). */
export function buildSystemPrompt(input: Pick<TextInput, "language" | "audience" | "siteName">): string {
  const language = input.language.trim();
  const audience = input.audience.trim();
  const siteName = input.siteName.trim();
  return `You are a senior Pinterest SEO copywriter.
For every input item you get: the article's main KEYWORD, the pin/photo CONTEXT
(visual style or article section), the target BOARD and the HASHTAGS flag.

Write, per item:
- "title": Pinterest pin title, max ${LIMITS.title} characters, keyword-led, natural, no clickbait spam, no quotes, no hashtags.
- "description": 2-3 short sentences, keyword + close variants woven naturally, ends with a soft save/read prompt.
  If HASHTAGS=yes -> append 3-5 relevant lowercase hashtags at the very end (max ${LIMITS.descriptionWithTags} chars total).
  Hashtags MUST be written in the SAME language as the description itself (Ukrainian copy -> Ukrainian hashtags,
  e.g. #манікюр #короткінігті; never transliterate or switch to English). Single words or joined words, no spaces inside a tag.
  if HASHTAGS=no -> no hashtags at all (max ${LIMITS.description} chars total).

HASHTAGS=no items must be 100% clean of "#" symbols.
The flag is set per item on purpose — respect it exactly, do not "improve" an item by adding what is turned off.
- "alt": plain literal description of what is visible, max ${LIMITS.alt} characters, no hashtags.

NO EMOJI — MANDATORY: never use emojis, pictograms, kaomoji or decorative symbols anywhere (title, description, alt).

NEVER mention that the image is AI-generated, never name image generators or neural networks
(no "AI", "AI art", "Midjourney", "нейросеть" etc.) — the copy is about the idea shown, not about how the image was made.

SEASONAL KEYWORD RULE — MANDATORY:
- Analyze SOURCE TITLE and REQUIRED SEASONAL TERMS for every item.
- If REQUIRED SEASONAL TERMS is not "none", include every listed term naturally in BOTH title and description.
- Never replace, translate, omit, or generalize a required seasonal term. For example, "winter" must remain present as "winter".
- This requirement has priority over stylistic variation, but all character limits still apply.

${audience ? `Audience: ${audience === "women" ? "women" : audience === "men" ? "men" : "mixed (men and women)"} — choose tone, examples and wording accordingly without stating the audience explicitly.\n` : ""}${siteName ? `Site name: "${siteName}" — may be mentioned at most once in the description's closing read prompt, never in the title or alt.\n` : ""}Language: ${
    language
      ? `write all copy strictly in ${language} (override the keyword language).`
      : "match the language of the KEYWORD (Ukrainian keyword -> Ukrainian copy, Russian -> Russian, otherwise English)."
  }
Vary sentence structure, openings and tone between items — every item must be UNIQUE.

Return STRICT JSON only — an object with a "results" array in input order, no prose, no markdown:
{"results":[{"i":0,"title":"...","description":"...","alt":"..."}]}`;
}

/** Контекст элемента как в воркере: графика (с темой) или фото из статьи. */
function contextOf(it: TextItem): string {
  if (it.kind === "pin") {
    const topic = it.topic.trim();
    return `Pinterest graphic${topic ? `, topic: ${topic}` : ""}`;
  }
  return `Photo from the article "${it.pageTitle || it.h1 || ""}"`;
}

function sourceTitleOf(it: TextItem): string {
  return [it.pageTitle, it.h1].map((s) => (s || "").trim()).filter(Boolean).join(" · ");
}

/** Обязательные сезонные термины: сохранённое seasonWord + найденные в заголовке/ключе/промте (≤3). */
export function requiredSeasonalTerms(it: TextItem): string[] {
  const stored = (it.seasonWord || "").trim();
  const detected = seasonalTerms(sourceTitleOf(it), it.keyword, it.prompt);
  return [...new Map([stored, ...detected].filter(Boolean).map((t) => [t.toLocaleLowerCase(), t])).values()].slice(0, 3);
}

export function buildUserPrompt(chunk: TextItem[], flags: Map<string, boolean>): string {
  const lines = chunk.map((it, k) => {
    const terms = requiredSeasonalTerms(it);
    return `${k}. KEYWORD: ${it.keyword.trim() || "(none)"}
   SOURCE TITLE: ${sourceTitleOf(it) || "(none)"}
   REQUIRED SEASONAL TERMS: ${terms.join(", ") || "none"}
   CONTEXT: ${contextOf(it).slice(0, 400) || "(none)"}
   BOARD: ${it.boardName.trim() || "(none)"}
   HASHTAGS: ${flags.get(it.id) ? "yes" : "no"}`;
  });
  return `ITEMS:\n${lines.join("\n")}\n\nReturn the JSON object now.`;
}

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Массив строк из ответа: [...], {results:[...]}, {items:[...]}. */
export function rowsFromJson(json: unknown): Row[] {
  if (Array.isArray(json)) return json.filter(isRow);
  if (isRow(json)) {
    for (const key of ["results", "items", "data", "pins"]) {
      const v = json[key];
      if (Array.isArray(v)) return v.filter(isRow);
    }
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/**
 * Пост-обработка одного элемента: эмодзи и упоминания ИИ вырезаются, сезонные термины
 * гарантируются, хэштеги по флагу (при «да» и отсутствии — из ключа и доски), лимиты.
 */
export function finalizeTexts(raw: { title: string; description: string; alt: string }, it: TextItem, withHashtags: boolean): PinTexts {
  const terms = requiredSeasonalTerms(it);
  const clean = (s: string) => stripAiMentions(stripEmoji(s));

  const title = requireTerms(cleanTitle(clean(raw.title)), terms, "dash");

  let description = requireTerms(clean(raw.description), terms, "sentence");
  description = normalizeHashtags(description, withHashtags, MAX_TAGS);
  if (withHashtags && !description.includes("#")) {
    const tags = makeHashtags(it.keyword, it.boardName);
    if (tags) description = description ? `${description} ${tags}` : tags;
  }

  const altText = stripHashtags(clean(raw.alt));
  return applyLimits({ title, description, altText }, withHashtags);
}

/** Кому из элементов достаются хэштеги: стабильно по хэшу id, доля hashtagShare. */
export function hashtagFlags(input: TextInput): Map<string, boolean> {
  const share = input.hashtags ? (input.hashtagShare ?? 100) : 0;
  return new Map(input.items.map((it) => [it.id, inShare(it.id, share)]));
}

/**
 * Генерирует тексты для всех элементов: чанки по 10, до 3 параллельно, text_main,
 * temperature 0.85, maxTokens 8000, таймаут 100 с. AiError пробрасывается (повторы — у воркера).
 * Элементы, для которых модель не вернула заголовок, в карту не попадают.
 */
export async function generatePinTexts(ctx: AiCtx, input: TextInput, opts: TextOpts = {}): Promise<Map<string, PinTexts>> {
  const system = buildSystemPrompt(input);
  const flags = hashtagFlags(input);

  const chunks: TextItem[][] = [];
  for (let i = 0; i < input.items.length; i += CHUNK) chunks.push(input.items.slice(i, i + CHUNK));

  const out = new Map<string, PinTexts>();
  const total = input.items.length;
  let done = 0;
  let cursor = 0;
  let failure: unknown = null;

  const worker = async (): Promise<void> => {
    while (cursor < chunks.length && failure === null) {
      if (opts.signal?.aborted) return;
      const chunk = chunks[cursor++];
      try {
        const res = await aiChat({ ...ctx, signal: opts.signal ?? ctx.signal }, "text_main", {
          system,
          user: buildUserPrompt(chunk, flags),
          json: true,
          temperature: 0.85,
          maxTokens: 8000,
          timeoutMs: 100_000,
        });
        const rows = rowsFromJson(res.json);
        chunk.forEach((it, k) => {
          const hit = rows.find((r) => Number(r.i) === k) ?? rows[k];
          if (!hit) return;
          const raw = { title: str(hit.title), description: str(hit.description), alt: str(hit.alt ?? hit.altText ?? hit.alt_text) };
          if (!raw.title) return;
          const texts = finalizeTexts(raw, it, flags.get(it.id) ?? false);
          if (texts.title) out.set(it.id, texts);
        });
        done += chunk.length;
        if (opts.onBatch) await opts.onBatch(done, total);
      } catch (e) {
        failure = e;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? CONCURRENCY, chunks.length || 1)) }, worker));
  if (failure !== null) throw failure;
  return out;
}
