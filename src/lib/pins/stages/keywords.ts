import { aiChat, type AiCtx } from "@/lib/pins/ai/client";
import { detectNiche, type NicheId } from "@/lib/pins/stages/niche";
import { PAGE_TOPICS } from "@/lib/pins/stages/topics";

/**
 * Ключ, тема, сезон и доски для страниц (порт edge-функции bulk-detect-keyword
 * + клиентского detectKeywords из bulkEngine.ts). Один вызов ИИ на 8 страниц,
 * слот text_fast, ответ в JSON. Ниша считается локально (niche.ts).
 */

export type KeywordPage = { url: string; title: string; h1: string };

export type KeywordInput = {
  pages: KeywordPage[];
  siteNiche: string;
  language: string;
  boards: string[];
  multiBoard: boolean;
};

export type KeywordResult = {
  keyword: string;
  boards: string[];
  topic: string;
  niche: string;
  season: string;
  seasonWord: string;
};

export type KeywordOpts = {
  signal?: AbortSignal;
  concurrency?: number;
  onBatch?: (done: number, total: number) => Promise<void>;
};

const CHUNK = 8;
const CONCURRENCY = 4;
const SEASONS = ["summer", "autumn", "winter", "spring"];
const TOPIC_IDS = PAGE_TOPICS.map((t) => t.id);
const NICHE_IDS: NicheId[] = ["decor", "nails", "hair", "outfit", "cooking"];

/** Ключ из H1 / заголовка / адреса, если ИИ не ответил — страница не должна остаться без пинов. */
export function fallbackKeyword(p: { url: string; h1?: string; title?: string }): string {
  const clean = (t: string) => t.replace(/\s*[|–—-]\s*[^|–—-]*$/, "").replace(/\s+/g, " ").trim();
  const fromText = clean(p.h1 || "") || clean(p.title || "");
  if (fromText) return fromText.toLowerCase().slice(0, 80);
  try {
    const slug = new URL(p.url).pathname.split("/").filter(Boolean).pop() || "";
    return slug.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").trim().toLowerCase().slice(0, 80);
  } catch {
    return "";
  }
}

/** Системный промт классификации (текст правил сохранён из legacy; формат ответа — объект {"results":[...]}). */
export function buildSystemPrompt(boardList: string[], multiBoard: boolean): string {
  const boardsRule = boardList.length
    ? multiBoard
      ? `   MULTI-BOARD MODE. Default is 1 board — the single best match, always first in the array.
   Add a 2nd board (and only very rarely a 3rd) ONLY when ALL of these are true for that extra board:
     - it is in the SAME category as the keyword (never mix nails/hair/outfit/makeup/skincare/home/food),
     - a Pinterest user browsing that board would expect exactly this article,
     - the extra board adds a DIFFERENT angle that is really present in the article
       (e.g. the item board + the audience board: "Капрі" + "Образи для повних жінок",
        or the item board + the occasion/season board when the title states that occasion),
     - it is NOT a broader parent of the first board with no extra angle,
     - it is NOT about a different item, different body type, different gender or different age.
   If the second-best board is merely "related", "similar" or "also nice" — return ONE board.
   A wrong second board is worse than a missing one: better 1 precise board than 2 loose ones.
   Rank the array by relevance: boards[0] must always be the strongest match.`
      : `   Pick EXACTLY 1 board — the single best match.`
    : `   No board list was provided — return an empty array for boards.`;

  return `You classify blog articles for Pinterest. Be precise: a wrong keyword or a wrong board ruins the pin.
For each input page you receive an index, the page URL/slug, the page <title> and the page <h1>.
Work silently and answer with JSON only — no explanations, no markdown fences.

Return STRICT JSON — an object with a "results" array, one object per input index, no prose, no markdown:
{"results":[{"i":0,"subject":"summer outfits for plus size women","keyword":"plus size outfits","season":"summer","seasonWord":"summer","topic":"outfit","boards":["Plus Size Outfits"]}]}

RULES
1. "subject" = one short sentence describing WHO the article is for and WHAT exactly it covers
   (audience, body type, age, season, garment/item, occasion). Think here first, then build the keyword.
2. "keyword" = the main Pinterest search keyword, 2-5 words, lowercase, no year, no brand names.
   Digits: KEEP a number only when it changes the search intent and is part of the item itself
   (age "over 50", "40+", "size 16", "5 minute recipe"); DROP decorative counts and years
   ("10 ideas", "2026", "top 7"). Keep the language of the source page (Ukrainian stays Ukrainian, etc.).
   CRITICAL — the keyword MUST keep every qualifier that changes search intent:
   body type (plus size / повненькі / petite), age (over 50 / 40+), gender, occasion,
   and the concrete item when the article is about one item (capri pants, midi skirt, bob haircut).
   Dropping such a qualifier is a hard error: "Образи для повненьких жінок" is
   "образи для повних жінок", NEVER just "образи".
   Do not generalize, do not shorten to a generic head term, do not swap the item for a different one.
   SEASON IS THE ONLY EXCEPTION: the season word must be REMOVED from "keyword" and reported
   separately (see rule 2b). "Літні образи для повненьких жінок" -> keyword "образи для повних жінок",
   season "summer", seasonWord "літні". "Летние купальники для полных" -> keyword
   "купальники для полных", season "summer", seasonWord "летние".
2b. SEASON DETECTION — works in ANY language and ANY inflected form (літній/літні/літня, летний/летние/
   летом, summer/summertime, verano, été, Sommer; осінь/осенние/fall/autumn; зимові/зимние/winter;
   весняні/весенние/spring). Also treat clearly seasonal synonyms as their season
   (back to school -> autumn, holiday/christmas/new year -> winter, beach/vacation heat -> summer).
   "season" = EXACTLY one of: summer, autumn, winter, spring, or "" when the article is not seasonal.
   "seasonWord" = the season word EXACTLY as it appeared in the source title, in the source language
   and in the grammatical form that fits the keyword (e.g. "літні", "летние", "summer").
   Leave both empty when there is no season. Never guess a season that is not in the title/h1.
3. "boards" = names picked ONLY from the provided board list, copied VERBATIM.
   The board must match the SAME item/audience as the keyword. An article about capri pants
   must not go to a "tank tops" board. If no board is truly about this item/audience,
   pick the closest broader board of the same category (e.g. a general outfit board),
   never a board about a different garment or a different topic.
${boardsRule}
4. "topic" = the page type, EXACTLY one id from this list:
   ${TOPIC_IDS.join(", ")}.
   Use "other" when nothing fits.
5. Never invent a board name that is not in the list. If nothing fits, return [].
6. Output exactly one object per input index, in the same order.

HOW TO PICK THE BOARD (follow in order, do not skip):
 a. Extract from the keyword: ITEM (garment/service/object), AUDIENCE (body type, age, gender),
    OCCASION and CATEGORY (nails / hair / outfit / makeup / skincare / home / food).
 b. Discard every board from a different CATEGORY. Never mix categories
    (a nails board can never hold an outfit article).
 c. Among the remaining boards prefer, in this order:
    1) a board about the SAME item AND the same audience,
    2) a board about the same item,
    3) a board about the same audience,
    4) the most general board of that category.
 d. Never pick a board naming a DIFFERENT item than the article
    ("капрі" -> never a "майки/топи" board; if there is no trousers/капрі board, use the general outfit board).
 e. Do not pick a board just because a word looks similar or the season matches.

WORKED EXAMPLES (format and depth expected):
- TITLE "Літні образи для повненьких жінок: легкі поєднання"
  -> subject "summer everyday outfit ideas for plus size women",
     keyword "образи для повних жінок", season "summer", seasonWord "літні",
     topic "outfit", board = a plus-size/outfit board (never a generic "тренди" board if a plus-size one exists).
- TITLE "Капрі 2026: з чим носити"
  -> keyword "капрі", season "", seasonWord "", topic "outfit",
     board = trousers/capri board, or the general outfit board — NEVER a tops/tank-tops board.
- TITLE "Осінній манікюр у бордових відтінках"
  -> keyword "бордовий манікюр", season "autumn", seasonWord "осінній", topic "nails",
     board = a nails board only.

SELF-CHECK before answering (silently):
 - does the keyword still contain every audience/item qualifier from the title?
 - is the season word removed from the keyword and reported separately?
 - is every board name copied character-for-character from the list?
 - is the board about the SAME item/category as the keyword?`;
}

/** Пользовательское сообщение для пачки страниц: контекст сайта, список досок и страницы с индексами. */
export function buildUserPrompt(chunk: KeywordPage[], input: KeywordInput, boardList: string[]): string {
  const boardsBlock = boardList.length
    ? `AVAILABLE BOARDS (copy names verbatim):\n${boardList.map((b) => `- ${b}`).join("\n")}`
    : `AVAILABLE BOARDS: (none)`;
  const site = [
    input.siteNiche ? `SITE NICHE: ${input.siteNiche}` : "",
    input.language ? `SITE LANGUAGE (expected, but always follow the page's own language): ${input.language}` : "",
  ].filter(Boolean).join("\n");
  return `${site ? `${site}\n\n` : ""}${boardsBlock}

PAGES:
${chunk.map((p, k) => `${k}. URL: ${p.url || "(none)"}\n   TITLE: ${p.title || "(none)"}\n   H1: ${p.h1 || "(none)"}`).join("\n")}

Return the JSON object now.`;
}

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Достаёт массив строк из ответа модели: [...], {results:[...]}, {pages:[...]} . */
export function rowsFromJson(json: unknown): Row[] {
  if (Array.isArray(json)) return json.filter(isRow);
  if (isRow(json)) {
    for (const key of ["results", "pages", "items", "data"]) {
      const v = json[key];
      if (Array.isArray(v)) return v.filter(isRow);
    }
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

/** Нормализует одну строку ответа под список досок и допустимые значения. */
export function normalizeRow(hit: Row | undefined, page: KeywordPage, boardList: string[], multiBoard: boolean, fallbackNiche: NicheId): KeywordResult {
  const boardsRaw: unknown = hit?.boards;
  const boardRaw: unknown = hit?.board;
  const rawBoards: unknown[] = Array.isArray(boardsRaw) ? boardsRaw : boardRaw ? [boardRaw] : [];
  const validBoards = rawBoards
    .map((b) => str(b))
    .map((b) => boardList.find((x) => x.toLowerCase() === b.toLowerCase()))
    .filter((b): b is string => typeof b === "string");
  const rawSeason = str(hit?.season).toLowerCase();
  const season = SEASONS.includes(rawSeason) ? rawSeason : "";
  const seasonWord = season ? str(hit?.seasonWord) : "";
  const keyword = str(hit?.keyword);
  const rawTopic = str(hit?.topic);
  const topic = TOPIC_IDS.includes(rawTopic) ? rawTopic : "";
  const niche = detectNiche([keyword, page.title, page.h1, topic, page.url].filter(Boolean).join(" "), fallbackNiche).niche;
  return {
    keyword,
    boards: Array.from(new Set(multiBoard ? validBoards.slice(0, 3) : validBoards.slice(0, 1))),
    topic,
    niche,
    season,
    seasonWord,
  };
}

/**
 * Определяет ключ/тему/сезон/доски для всех страниц: чанки по 8, до 4 параллельно.
 * AiError пробрасывается наверх (повторы — на стороне вызывающего); страницы без ответа
 * модели получают keyword "" — вызывающий подставляет fallbackKeyword().
 */
export async function detectKeywords(
  ctx: AiCtx,
  input: KeywordInput,
  opts: KeywordOpts = {},
): Promise<Map<string, KeywordResult>> {
  const boardList = input.boards.map((b) => String(b || "").trim()).filter(Boolean);
  const siteNiche = input.siteNiche.trim().toLowerCase();
  const fallbackNiche: NicheId = (NICHE_IDS as string[]).includes(siteNiche) ? (siteNiche as NicheId) : "decor";
  const system = buildSystemPrompt(boardList, input.multiBoard);

  const chunks: KeywordPage[][] = [];
  for (let i = 0; i < input.pages.length; i += CHUNK) chunks.push(input.pages.slice(i, i + CHUNK));

  const out = new Map<string, KeywordResult>();
  const total = input.pages.length;
  let done = 0;
  let cursor = 0;
  let failure: unknown = null;

  const worker = async (): Promise<void> => {
    while (cursor < chunks.length && failure === null) {
      if (opts.signal?.aborted) return;
      const chunk = chunks[cursor++];
      try {
        const res = await aiChat({ ...ctx, signal: opts.signal ?? ctx.signal }, "text_fast", {
          system,
          user: buildUserPrompt(chunk, input, boardList),
          json: true,
          temperature: 0.2,
          maxTokens: 4000,
          timeoutMs: 60_000,
        });
        const rows = rowsFromJson(res.json);
        chunk.forEach((p, k) => {
          const hit = rows.find((r) => Number(r.i) === k) ?? rows[k];
          out.set(p.url, normalizeRow(hit, p, boardList, input.multiBoard, fallbackNiche));
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
