/**
 * Промты ИИ-пинов: порт функции generate-pin-prompt (buildSystemPrompt + buildUserMessage
 * + батчи по 3 стиля с одиночным повтором). Формулировки сохранены; убраны кастомные
 * правила, ветка 9:16 (формат всегда 2:3, 1024x1536) и скриншоты-референсы.
 *
 * Какие теги (сезон/год/число/имя сайта/CTA) ставить на каждый стиль, решает вызывающий
 * (см. elements.ts). Исключение из оригинала сохранено: стили типа «listicle» всегда
 * получают число идей, если оно известно, — иначе модель выдумывает свой счётчик.
 */

import { aiChat, type AiCtx } from "@/lib/pins/ai/client";
import { AiError } from "@/lib/pins/ai/errors";
import { getAiStyle, type AiStyle } from "./aiStyles";
import type { ElementTags } from "./elements";

export const AI_PROMPT_BATCH_SIZE = 3;
export const AI_PROMPT_TEMPERATURE = 0.9;
export const AI_BATCH_TIMEOUT_MS = 55_000;
export const AI_SINGLE_TIMEOUT_MS = 35_000;
const BETWEEN_BATCH_DELAY_MS = 150;

export type Audience = "women" | "men" | "mix";

export type AiPromptStyleInput = {
  id: string;
  /** Личная правка стиля («зелёный вместо синего») — блок USER STYLE OVERRIDE. */
  overrideInstruction?: string;
  tags: ElementTags;
};

export type AiPromptInput = {
  /** Ключевая фраза страницы — становится TOPIC (заголовок пина строится из неё). */
  keyword: string;
  /** Тема/заголовок страницы — попадает в REFERENCE CONTEXT, если отличается от ключа. */
  topic: string;
  /** Жёсткая ниша (nails / hair / clothing / …) или "all" / "" — без блокировки. */
  niche: string;
  language: string;
  audience: Audience;
  siteName: string;
  brandColor?: string;
  ideaCount?: number;
  /** Идентификатор сезона (fall…) — используется, если нет seasonWord. */
  season?: string;
  /** Слово сезона на языке заголовков — именно оно попадает в промт. */
  seasonWord?: string;
  year?: string;
  styles: AiPromptStyleInput[];
};

export type AiPromptMessages = { system: string; user: string | Array<Record<string, unknown>> };
export type AiPromptResult = { styleId: string; prompt: string };

/* ------------------------------- system prompt ------------------------------- */

function buildGenderBlock(genderTarget: string): string {
  const g = (genderTarget || "women").toLowerCase();
  if (g === "men") {
    return `\n=== GENDER LOCK (HARD RULE) ===\nWhenever a HUMAN model, portrait, hands, body, silhouette, face or lifestyle figure appears in the pin, it MUST be MALE. Only men, only masculine hands, only male hair models, only male fashion looks. Never show women or feminine figures. If the style would normally show a woman, replace with a man of the appropriate aesthetic. For niches with no people (product, interior, macro), this rule is inert.\n=== end GENDER LOCK ===\n`;
  }
  if (g === "mix") {
    return `\n=== GENDER MIX ===\nWhenever a HUMAN model appears, freely choose men OR women (or both together) — vary across prompts so the batch feels inclusive. No exclusive lock either way.\n=== end GENDER MIX ===\n`;
  }
  return `\n=== GENDER LOCK (HARD RULE) ===\nWhenever a HUMAN model, portrait, hands, body, silhouette, face or lifestyle figure appears in the pin, it MUST be FEMALE. Only women, only feminine hands, only female hair models, only female fashion looks. Never show men or masculine figures. If the style would normally show a man, replace with a woman of the appropriate aesthetic. For niches with no people (product, interior, macro), this rule is inert.\n=== end GENDER LOCK ===\n`;
}

export function buildSystemPrompt(topic: string, headlineLanguage: string, nicheLock: string, genderTarget: string): string {
  const lock = (nicheLock || "").trim();
  const nicheLockBlock = lock && lock.toLowerCase() !== "all"
    ? `\n=== NICHE LOCK (HARDEST RULE — overrides Step 0 niche detection) ===\nThe user has EXPLICITLY locked the niche to: ${lock.toUpperCase()}.\nThe subject of every prompt MUST be ${lock.toUpperCase()} regardless of how the topic reads.\nExample: if the topic is "ombre" and the lock is HAIR, the subject is HAIR ombre — NOT nail ombre, NOT outfit ombre. If the topic is "chrome" and the lock is NAILS, the subject is chrome NAILS — not chrome hair.\nAll labels, micro-icons, decorative objects and props MUST come from the ${lock.toUpperCase()} vocabulary defined below. The locked niche wins over any keyword in the topic that could suggest another niche.\n=== end NICHE LOCK ===\n`
    : "";
  const genderBlock = buildGenderBlock(genderTarget);
  return `You are an expert Pinterest FASHION & BEAUTY pin art director and image-prompt engineer.
You THINK FOR YOURSELF. The style block you receive is creative DIRECTION, not a template
to fill in. Your job is to make real art-director decisions for the SPECIFIC topic and write
ONE final, ready-to-paste image-generation prompt that works equally well in Ideogram and
ChatGPT / GPT-image. Plain descriptive English, all on-pin text in double quotes, spelled
correctly. NO Ideogram tags, NO Midjourney --parameters, NO weights, NO ratio codes.
${nicheLockBlock}${genderBlock}
STEP 0 — DETECT THE NICHE (do this first, silently):
The topic "${topic}" is arbitrary and custom. Infer its niche, then drive ALL imagery and
labels from that niche. Never default to hair.
- HAIR (haircut, color, bob, pixie, balayage, curls…) → portraits showing cut shape,
  texture, length, layers, movement, shine. Labels about cut/texture/maintenance.
- NAILS (manicure, almond, chrome, jelly, French…) → MACRO nail photography showing shape,
  length, finish, color, art. Elegant natural hands, never distorted fingers.
  Labels like "short almond", "milky gloss", "chrome finish".
- OUTFIT / FASHION (outfit, look, capsule, linen, coastal…) → full/half-body looks +
  accessory cutouts + color swatches. Labels about silhouette/fabric/occasion:
  "linen", "coastal prep", "office chic", "casual", "summer capsule". NEVER hair labels here.
- MAKEUP (smoky eye, blush, lip, glow…) → close-ups of skin/eyes/lips/glow.
  Labels like "glossy skin", "soft smoky eye", "cherry lip". Don't cover the face with type.
- SKINCARE (glow, hydration, glass skin, SPF…) → product + skin-result composition.
  Labels like "glow", "hydration", "glass skin", "summer routine".
- OTHER (fragrance, jewelry, brows, lashes…) → pick the most fitting subject and labels.
If a sub-type is named (e.g. "linen summer outfit"), specialize further. If ambiguous, choose
the most likely niche from the wording and commit.

GOAL: for each requested style, write ONE polished prompt for "${topic}" that authentically
carries that style's concept while being fully adapted to the detected niche — fresh, never a
copy of the style's example.

NON-NEGOTIABLE RULES (every prompt):
1. Vertical Pinterest pin in 2:3 aspect ratio, target canvas 1024x1536 px. State the exact
   aspect ratio AND the 1024x1536 px target in the prompt. High-resolution, professional
   editorial quality, sharp focus, mobile-first composition, readable typography.
2. The subject is always the hero AND must be clearly separated from the background
   (see SUBJECT–BACKGROUND SEPARATION below); decoration never overpowers it.
3. Clear, large, correctly-spelled headline (default = the topic; you may restyle casing or
   add one short accent word). Headline + labels in ${headlineLanguage}.
3a. KEYWORD FIDELITY (hard rule): the user-provided TOPIC is a keyword phrase. Every
    meaningful word in it (adjectives like "nice", "cozy", "easy", "best"; nouns;
    modifiers) MUST appear in the HEADLINE — same lemma/root, same language. You MAY:
    reorder words, inflect them (plural/singular, case endings, verb forms — e.g.
    "outfit" ↔ "outfits", "осінній" ↔ "осінні"), change casing, add 1–2 extra accent
    words, or wrap the phrase so it reads naturally. You MAY NOT drop a content word
    or silently swap it for a synonym. Readability wins over rigid word order — but
    the user's words must all be present in some inflected form. Examples for topic
    "nice fall outfits": OK → "Nice Fall Outfits 2026", "22 Nice Fall Outfit Ideas",
    "So Nice: Fall Outfits To Try", "Fall Outfits That Look Nice". NOT OK → "Cute
    Fall Looks", "Fall Outfit Ideas" (dropped "nice"). Stop-words (the/a/to/for) may
    be dropped; content words may not.
3b. NO DUPLICATES (hard rule): never repeat the same word/lemma twice in the same
    headline or pin. If the TOPIC already carries a word that also appears as a
    SEASON/YEAR/NUMBER/SITE-NAME tag (in any inflected form or close translation),
    the topic's instance counts — do NOT add it again. Forbidden examples:
    "fall fall outfits", "2026 2026 ideas", "22 22 nail looks",
    "summer літні looks". The tags are fine-tuning — they grant
    permission to add the tag, NOT an instruction to duplicate it.
4. Respect safe zones: keep key text off the extreme top/bottom edges.
5. End every prompt with this negative line, adapted naturally:
   "Avoid blurry images, distorted faces, warped anatomy, extra fingers, deformed hands,
   unreadable or misspelled text, fake logos, watermarks, cluttered layout, low-resolution
   stock-photo look, generic Canva-template feeling, overdecorated background, and any element
   that hides the subject."

=== ADAPTIVITY ENGINE (the core — this is what makes you good, not a template) ===

What is INVARIANT for a style (must always stay recognizable):
its emotional mood, its visual hierarchy logic, its typography behavior, its decorative
system, and its layout archetype. These are the style's signature — keep them every time.

What is VARIABLE (you adapt these to the topic, season and subject):
exact hues/palette · the imagery subject (per detected niche) · every label and micro-text ·
image count within the style's range · crop · accent color · CTA · background texture.

A) ADAPTIVE PALETTE:
Each style ships with a SIGNATURE palette in colorLogic — treat it as an ANCHOR, not a cage.
You MAY shift the palette to better fit the topic, season or subject (e.g. make a soft style
butter-yellow, sage, or icy if that suits the theme) AS LONG AS (1) the style's concept/mood
stays unmistakable, and (2) the contrast rule below still holds.
If the anchor palette (or a dark-mood style) would melt the subject into the background,
abandon it — subject separation always wins over the anchor and over default fonts.

SUBJECT–BACKGROUND SEPARATION (the #1 scroll-stop rule — apply to EVERY pin):
The subject MUST visibly separate from its background in value (light/dark), hue, or edge, so the
silhouette reads instantly at thumbnail size. A dark subject on a dark background — a black dress on
a black backdrop, dark hair on black, dark nails on charcoal, burgundy velvet on near-black — is a
FAILURE that melts and kills the scroll-stop. Never let it happen. Colorful TEXT/badges/frames do
NOT count as separation — the SUBJECT itself must pop.

When the subject is DARK, do at least one of these so its edges read:
- use a lighter or contrasting background, or a bright color-block / gradient panel behind the subject
- add strong rim / edge lighting or a soft glow/halo that outlines the subject against the dark
- give the subject a clean cutout with a light or bright separating edge
- shift part of the background to a brighter or complementary tone right behind the subject
When the subject is LIGHT/bright, make the background darker or contrasting in the same way.

HUE PAIRINGS (starting points, still honor them): pink → cream/icy blue/pearl/lavender/black ·
red → ivory+black / chocolate+cream / pale blue · blonde → black/cream/icy-silver/peach/sage ·
brunette → cream/ivory/hot pink/gold/icy blue · chrome/silver → black/icy blue/lavender/charcoal ·
neutral → cream/black/brown/gold/sage + one accent.

LOCKED-SUBJECT EXCEPTION (topic-defined color): when the TOPIC fixes the subject's color
(e.g. "black skirts 2026", "red nails", "platinum hair"), you may NOT recolor the subject — its
color is sacred. Instead change the BACKGROUND, lighting and surrounding color-blocks to create the
separation. Subject color is locked; the background bends to it.

DARK-MOOD STYLES still obey this. For Vamp, Dark Neon, Decadent Glam, Bold Black-Pink, Operacore,
Glitchy Glam, Wet Look, Chrome/Celestial — keep the moody concept, but guarantee separation via rim
light, glow, brighter accent panels, or a non-uniform background. The dark MOOD is the concept; a
flat all-black background that swallows a dark subject is a failure, not the concept.

Always STATE in the prompt exactly how the subject is separated from the background.

B) ADAPTIVE MICRO-COPY (labels, badges, tiny captions, numbers, CTA, footer):
Generate ALL on-pin micro-text fresh and RELEVANT to the detected niche and the exact topic.
Never carry a label from another niche. Match the style's voice.

B2) ADAPTIVE MICRO-ICONS / DECORATIVE OBJECTS (CRITICAL):
Any small icon, sticker, doodle, illustration, cutout or decorative micro-object MUST be
strictly relevant to the DETECTED niche. Never borrow icons from another niche.
- HAIR → scissors, comb, hair clip, blow dryer, curling iron, hair tie, brush, swatch ring.
- NAILS → nail polish bottle, nail file, cuticle pusher, color chip, ring, jewelry, hand cream.
- OUTFIT / FASHION → hanger, handbag, shoe, sunglasses, belt, fabric swatch, button,
  perfume, jewelry, shopping bag. NEVER scissors, comb, dryer, polish bottle or any hair/nail tool.
- MAKEUP → lipstick, mascara, brush, palette, mirror, blush compact, gloss tube.
- SKINCARE → serum dropper, cream jar, leaf, water droplet, SPF tube, cotton pad.
- INTERIOR → furniture cutout, plant, lamp, vase, fabric/wood swatch, paint chip.
If a style's decorative system suggests icons, translate them into the niche's own object
vocabulary. When in doubt, drop the icon rather than use an off-niche one.

C) THINK FOR YOURSELF / FRESHNESS:
Two prompts of the same style for different topics MUST look meaningfully different. Vary at
least THREE of: photo layout · headline wording · accent color · image count · decorative
system · crop · font pairing · CTA placement · background texture · label style. The gold
example in the style block is flavor only — never output a near-copy of it.

=== end Adaptivity Engine ===

STYLE FIDELITY: the style block is the authority for mood, hierarchy, typography behavior,
decorative system and layout archetype. Pull those from it faithfully; flex everything else.

USER STYLE OVERRIDE (per account + per style — HIGHEST creative priority):
Some styles arrive with a personal override written by this user for THIS style (e.g. "use green
instead of blue", "acid-bright letters", "this exact background", "more/less detail", "this font,
not that one"). Apply the override FAITHFULLY and above the style's default palette, fonts and
labels — it represents how this user wants this style tuned. The only things it cannot break are
the NON-NEGOTIABLE RULES (2:3, subject is hero, readable text, contrast safety). If the override
conflicts with the anchor palette, the override wins.

PRIORITY ORDER when assembling each prompt:
1) Non-negotiable rules  →  2) User style override (this style)  →  3) Style block defaults.
Niche detection + adaptivity apply throughout.

ENGINE-NEUTRAL PHRASING: write so any modern image model understands it. Describe text-in-image
in double quotes so text-rendering models place and spell it correctly.

LENGTH: 90–170 words per prompt.

OUTPUT: STRICT JSON only, no markdown, no commentary:
{"prompts":[{"styleId":"<id>","styleName":"<name>","category":"<category>","prompt":"<final prompt>"}]}
Exactly ONE object per requested style, in the given order.`;
}

/* -------------------------------- user message -------------------------------- */

type ResolvedStyle = { style: AiStyle; input: AiPromptStyleInput };

function tagValues(input: AiPromptInput, rs: ResolvedStyle): { season: string; year: string; num: string; siteName: string; cta: boolean } {
  const t = rs.input.tags;
  const seasonValue = (input.seasonWord || input.season || "").trim();
  const yearValue = (input.year || "").trim();
  const numValue = input.ideaCount && input.ideaCount > 0 ? String(input.ideaCount) : "";
  const siteValue = (input.siteName || "").trim();
  // Listicle-стили всегда получают число идей, если оно известно (как в оригинале).
  const forceNumber = rs.style.type === "listicle" && numValue !== "";
  return {
    season: t.season ? seasonValue : "",
    year: t.year ? yearValue : "",
    num: t.number || forceNumber ? numValue : "",
    siteName: t.siteName ? siteValue : "",
    cta: !!t.cta,
  };
}

function buildStyleBlock(input: AiPromptInput, rs: ResolvedStyle): string {
  const s = rs.style;
  const headlineLanguage = input.language || "en";
  const { season, year, num, siteName, cta } = tagValues(input, rs);
  const overrideLine = (rs.input.overrideInstruction || "").trim() || "none";
  const formatLine = `FORMAT (required): vertical 2:3 aspect ratio, target canvas 1024x1536 px. State this aspect explicitly in the prompt.`;
  const seasonLine = season
    ? `SEASON TAG TO WEAVE IN (required for this prompt): "${season}". Mention it ONCE, naturally, in the headline, a label, or a small badge. IMPORTANT: if the TOPIC already contains this season word in ANY inflected form, translation, or close variant (e.g. "fall" vs "autumn", "літо" vs "літня" vs "summer"), do NOT add a second mention — the topic's word counts as the season tag. Never write the season twice (e.g. "fall fall outfits" is forbidden).`
    : `SEASON TAG: (skip for this prompt — do not mention any season)`;
  const yearLine = year
    ? `YEAR TAG TO WEAVE IN (required for this prompt): "${year}". Place it ONCE in the headline or a small accent label/badge. IMPORTANT: if the TOPIC already contains this year (or a close variant like "'26"), do NOT add a second mention — the topic's year counts. Never write the year twice (e.g. "2026 2026" is forbidden).`
    : `YEAR TAG: (skip for this prompt — do not mention any year)`;
  const numberLine = num
    ? `NUMBER TAG TO WEAVE IN (required for this prompt): "${num}". Use it as a count prefix in the HEADLINE, e.g. "${num} <topic noun>" — typical listicle/idea-count framing. IMPORTANT: if the TOPIC already starts with this exact number (digits OR spelled-out form), do NOT add a second one — the existing one counts. Never repeat the number twice in the same prompt.`
    : `NUMBER TAG: (skip for this prompt — do NOT invent any numeral, count, digit or quantity in the headline, badges, labels, or anywhere else. No "8 Ideas", no "Top 5", no numbered grid labels like "1./2./3.". The pin must read without any leading count.)`;
  const siteNameLine = siteName
    ? `SITE-NAME ON PIN (required for this prompt): place the wordmark "${siteName}" once as a small, refined wordmark — corner, footer, or sleek sidebar. Style it ON-BRAND with the pin's typography (matching font weight, harmonized color), neither bold-shouting nor invisible — clearly readable but quieter than the headline. Never decorate it as a logo, never claim it is a brand/shop/sale.`
    : `SITE-NAME ON PIN: (skip — do not add any site name or wordmark)`;
  const ctaLine = cta
    ? `CALL-TO-ACTION (required for this prompt): add ONE short informational CTA in ${headlineLanguage} (2–4 words) that fits the pin's tone. This is an INFORMATIONAL site — NEVER use commerce wording ("shop now", "buy", "order", "$"/prices, "sale", "free shipping", "limited offer"). Choose naturally from inspiration / save-for-later / read-more language: e.g. "Save for later", "Read the guide", "See more ideas", "Tap for details", "Get inspired", "Full guide inside", "More on the blog". Place it as a tiny pill/badge/footer line — small, never competing with the headline.`
    : `CALL-TO-ACTION: (skip — do not add any CTA, button, or "tap here"-style text)`;
  const examples = Array.isArray(s.examples) && s.examples.length
    ? `\nFEW-SHOT EXAMPLES (structure & quality reference — adapt to TOPIC, do NOT copy wording):\n${s.examples.map((ex, i) => `Example ${i + 1}: ${ex}`).join("\n")}`
    : "";
  return `### styleId: ${s.id} | ${s.name} | category: ${s.category}
CONCEPT (invariant): ${s.concept}
LAYOUT (archetype): ${s.layout}
TYPOGRAPHY (behavior): ${s.typography}
COLOR LOGIC (anchor — may adapt to topic): ${s.colorLogic}
DECORATIVE (system): ${s.decorative}
AVOID: ${s.avoid}
${formatLine}
${seasonLine}
${yearLine}
${numberLine}
${siteNameLine}
${ctaLine}
USER STYLE OVERRIDE (this account — highest creative priority, faithfully apply): ${overrideLine}
GOLD EXAMPLE (flavor only — do NOT copy): ${s.gold}${examples}`;
}

export function buildUserMessage(input: AiPromptInput, styles: ResolvedStyle[]): string {
  const topic = input.keyword.trim();
  const headlineLanguage = input.language || "en";
  const reference = input.topic.trim() && input.topic.trim().toLowerCase() !== topic.toLowerCase() ? input.topic.trim() : "";
  const brand = (input.brandColor || "").trim();
  const brandLine = brand
    ? `\nBRAND COLOR (optional): ${brand} — you MAY use it as one accent color (labels, badge, CTA, underline) where the style allows; never recolor the subject with it and never let it break the contrast rule.`
    : "";
  const stylesBlock = styles.map((rs) => buildStyleBlock(input, rs)).join("\n\n");
  return `TOPIC: ${topic}
HEADLINE LANGUAGE: ${headlineLanguage}
SUBJECT COLOR HINT: infer from topic
REFERENCE CONTEXT (optional): ${reference || "(none)"}${brandLine}

GENERATE ONE PROMPT FOR EACH OF THESE STYLES:

${stylesBlock}`;
}

function resolveStyles(input: AiPromptInput): ResolvedStyle[] {
  const out: ResolvedStyle[] = [];
  for (const st of input.styles) {
    const style = getAiStyle(st.id);
    if (style) out.push({ style, input: st });
  }
  return out;
}

/** Чистый билдер: system + user для одного вызова модели по всем стилям из input. */
export function buildAiPromptMessages(input: AiPromptInput): AiPromptMessages {
  const styles = resolveStyles(input);
  return {
    system: buildSystemPrompt(input.keyword.trim(), input.language || "en", input.niche, input.audience),
    user: buildUserMessage(input, styles),
  };
}

/* ---------------------------------- generation ---------------------------------- */

type RawPromptRow = { styleId?: unknown; prompt?: unknown };

function extractRows(json: unknown): RawPromptRow[] {
  if (Array.isArray(json)) return json as RawPromptRow[];
  if (json && typeof json === "object") {
    const p = (json as { prompts?: unknown }).prompts;
    if (Array.isArray(p)) return p as RawPromptRow[];
  }
  return [];
}

async function callBatch(ctx: AiCtx, input: AiPromptInput, batch: ResolvedStyle[], timeoutMs: number): Promise<AiPromptResult[]> {
  const system = buildSystemPrompt(input.keyword.trim(), input.language || "en", input.niche, input.audience);
  const user = buildUserMessage(input, batch);
  const res = await aiChat(ctx, "text_main", {
    system,
    user,
    json: true,
    maxTokens: batch.length * 450 + 1500,
    temperature: AI_PROMPT_TEMPERATURE,
    timeoutMs,
  });
  const allowed = new Set(batch.map((b) => b.style.id));
  const out: AiPromptResult[] = [];
  const seen = new Set<string>();
  for (const row of extractRows(res.json)) {
    const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
    if (!prompt) continue;
    let styleId = typeof row.styleId === "string" ? row.styleId.trim() : "";
    // одиночный вызов: модель иногда теряет styleId — он однозначен
    if (!allowed.has(styleId) && batch.length === 1) styleId = batch[0].style.id;
    if (!allowed.has(styleId) || seen.has(styleId)) continue;
    seen.add(styleId);
    out.push({ styleId, prompt });
  }
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

function abortError(): Error {
  const e = new Error("Генерация промтов остановлена");
  e.name = "AbortError";
  return e;
}

/** Повторять ли батч по одному стилю: только временные ошибки (сеть, 5xx, таймаут, 429). */
function isRetryable(err: unknown): boolean {
  if (err instanceof AiError) return err.cls.kind === "transient";
  return false;
}

/**
 * Промты для всех стилей из input: батчи по 3, упавший батч (временная ошибка или
 * усечённый JSON) добирается по одному стилю. Возвращает только удавшиеся стили
 * в порядке input.styles; фатальные ошибки (ключ, кредиты, safety) пробрасываются.
 */
export async function generateAiPrompts(ctx: AiCtx, input: AiPromptInput, opts?: { signal?: AbortSignal }): Promise<AiPromptResult[]> {
  const signal = opts?.signal ?? ctx.signal;
  const aiCtx: AiCtx = signal ? { ...ctx, signal } : ctx;
  const selected = resolveStyles(input);
  if (!selected.length) return [];

  const batches: ResolvedStyle[][] = [];
  for (let i = 0; i < selected.length; i += AI_PROMPT_BATCH_SIZE) batches.push(selected.slice(i, i + AI_PROMPT_BATCH_SIZE));

  const got = new Map<string, string>();
  for (let i = 0; i < batches.length; i++) {
    if (signal?.aborted) throw abortError();
    try {
      for (const r of await callBatch(aiCtx, input, batches[i], AI_BATCH_TIMEOUT_MS)) got.set(r.styleId, r.prompt);
    } catch (err) {
      if (!isRetryable(err)) throw err;
      console.error("[pins] prompt batch failed; retrying styles individually", batches[i].map((s) => s.style.id), err instanceof Error ? err.message : err);
    }
    if (i < batches.length - 1) await sleep(BETWEEN_BATCH_DELAY_MS, signal);
  }

  // Добор по одному: спасает усечённый JSON и одиночные сбои.
  const missing = selected.filter((s) => !got.has(s.style.id));
  for (const s of missing) {
    if (signal?.aborted) throw abortError();
    try {
      for (const r of await callBatch(aiCtx, input, [s], AI_SINGLE_TIMEOUT_MS)) got.set(r.styleId, r.prompt);
    } catch (err) {
      if (!isRetryable(err)) throw err;
      console.error("[pins] prompt retry failed for style", s.style.id, err instanceof Error ? err.message : err);
    }
    await sleep(BETWEEN_BATCH_DELAY_MS, signal);
  }

  const out: AiPromptResult[] = [];
  for (const s of selected) {
    const prompt = got.get(s.style.id);
    if (prompt) out.push({ styleId: s.style.id, prompt });
  }
  return out;
}
