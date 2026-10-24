/**
 * Pinora — вторая технология промтов: конструктор «ниша × тип пина × 7 групп параметров».
 * Порт pinoraStyles.ts (StyleBag, интенсивность auto 40/40/20, рандомные группы,
 * совместимость, SUBJECT OVERRIDE, OVERRIDE-строки) и функции pinora-generate-prompts.
 * Библиотека: src/data/pins/pinora-styles.json — код её только читает.
 */

import pinoraLib from "@/data/pins/pinora-styles.json";
import { aiChat, type AiCtx } from "@/lib/pins/ai/client";
import { AiError } from "@/lib/pins/ai/errors";
import type { ElementTags } from "./elements";

/* --------------------------------- типы --------------------------------- */

export type { PinoraType } from "./pinoraTypes";
import type { PinoraType } from "./pinoraTypes";

export type GroupKey = "g1" | "g2" | "g3" | "g4" | "g5" | "g6" | "g7";
export const ALL_GROUPS: GroupKey[] = ["g1", "g2", "g3", "g4", "g5", "g6", "g7"];

export const GROUP_LABEL: Record<GroupKey, string> = {
  g1: "Стиль заголовка",
  g2: "Число идей",
  g3: "Год / хук",
  g4: "Декор-акценты",
  g5: "CTA элемент",
  g6: "Цветовая палитра",
  g7: "Атмосфера съёмки",
};

export {
  PINORA_NICHES, nicheScope, nicheLabel, PINORA_TYPES, typesForNiche, isPinoraType,
  type PinoraScope,
} from "./pinoraTypes";
import { PINORA_NICHES, nicheScope, nicheLabel, PINORA_TYPES, isPinoraType, type PinoraScope } from "./pinoraTypes";

/* ------------------------------ библиотека ------------------------------ */

export interface PinoraParam {
  id: string;
  code: string;
  group: GroupKey;
  groupLabel: string;
  scope: PinoraScope;
  nameRu: string;
  promptFragment: string;
}

export interface PinoraComposition {
  id: string;
  type: PinoraType;
  name?: string;
  layout: string;
  typography?: string;
  colorLogic?: string;
  decorative?: string;
  avoid?: string;
  promptTemplate?: string;
}

export interface PinoraLibrary {
  styleParameters: PinoraParam[];
  styles: PinoraComposition[];
  ctaPhrasePools: { general: string[]; cooking: string[] };
}

type RawLib = {
  styleParameters?: Array<Record<string, unknown>>;
  styles?: Array<Record<string, unknown>>;
  ctaPhrasePools?: Record<string, unknown>;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isGroup = (v: string): v is GroupKey => (ALL_GROUPS as string[]).includes(v);
const isScope = (v: string): v is PinoraScope => v === "general" || v === "cooking" || v === "decor";

function loadLibrary(): PinoraLibrary {
  const raw = pinoraLib as unknown as RawLib;
  const styleParameters: PinoraParam[] = [];
  for (const p of raw.styleParameters ?? []) {
    const group = str(p.group);
    const scope = str(p.scope);
    const code = str(p.code);
    if (!isGroup(group) || !isScope(scope) || !code) continue;
    styleParameters.push({
      id: str(p.id) || `${scope}-${group}-${code}`,
      code,
      group,
      groupLabel: str(p.groupLabel) || GROUP_LABEL[group],
      scope,
      nameRu: str(p.nameRu) || code,
      promptFragment: str(p.promptFragment),
    });
  }
  const styles: PinoraComposition[] = [];
  for (const s of raw.styles ?? []) {
    const id = str(s.id);
    const type = str(s.type);
    if (!id || !isPinoraType(type)) continue;
    styles.push({
      id,
      type,
      name: str(s.name) || undefined,
      layout: str(s.layout),
      typography: str(s.typography) || undefined,
      colorLogic: str(s.colorLogic) || undefined,
      decorative: str(s.decorative) || undefined,
      avoid: str(s.avoid) || undefined,
      promptTemplate: str(s.promptTemplate) || undefined,
    });
  }
  const pools = raw.ctaPhrasePools ?? {};
  const general = strList(pools.general).length ? strList(pools.general) : strList(pools.default);
  return { styleParameters, styles, ctaPhrasePools: { general, cooking: strList(pools.cooking) } };
}

const LIB: PinoraLibrary = loadLibrary();

export function getPinoraLibrary(): PinoraLibrary {
  return LIB;
}

/**
 * Композиция + признак того, что она «родная» для ниши.
 * Если родной нет, берём любой шаблон этого типа, но его предметные строки
 * (SUBJECT / что снимать) вычищаются — сюжет задаёт ниша страницы.
 */
export function compositionForNiche(niche: string, type: PinoraType): { comp: PinoraComposition | null; exact: boolean } {
  const wanted = `${niche}-${type.replace(/_/g, "-")}`;
  const exactHit = LIB.styles.find((s) => s.id === wanted);
  return { comp: exactHit ?? LIB.styles.find((s) => s.type === type) ?? null, exact: !!exactHit };
}

export function compositionText(c: PinoraComposition | null): string {
  if (!c) return "";
  return [c.layout, c.typography, c.colorLogic, c.decorative, c.avoid ? `AVOID: ${c.avoid}` : ""]
    .filter((x): x is string => !!x)
    .join("\n");
}

/**
 * Плейсхолдеры композиции ([YEAR], [COUNT], [TOPIC_COUNT], [SITE_NAME], [CTA_PHRASE]…) заполняются
 * фактическими значениями; строки, которые ссылаются на выключенный элемент (нет года/числа/имени сайта), убираются,
 * чтобы модель не получала «год отключён» и тут же «[YEAR] курсивом».
 */
export function fillComposition(text: string, v: { year: string; count: number | null; season: string; siteName: string; keyword: string; ctaPhrase: string }): string {
  if (!text) return "";
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if ((/\[YEAR\]/.test(line) && !v.year) || (/\[(TOPIC_)?COUNT\]/.test(line) && !v.count) || (/\[SITE_NAME\]/.test(line) && !v.siteName) || (/\[CTA_PHRASE\]/.test(line) && !v.ctaPhrase)) continue;
    out.push(line
      .replace(/\[YEAR\]/g, v.year)
      .replace(/\[(TOPIC_)?COUNT\]/g, v.count ? String(v.count) : "")
      .replace(/\[SEASON\]/g, v.season)
      .replace(/\[CTA_PHRASE\]/g, v.ctaPhrase)
      .replace(/\[SITE_NAME\]/g, v.siteName)
      .replace(/\[TOPIC_KEYWORD\]/g, v.keyword)
      .replace(/\[SUBTEXT\]/g, ""));
  }
  return out.join("\n");
}

/** Строки блока композиции, которые описывают ЧТО снимать, а не КАК строить пин. */
const SUBJECT_LINE_RE = /^\s*(SUBJECT|SUBJECTS|PHOTO SUBJECT|WHAT TO SHOOT|CONTENT)\b/i;

/** Структурная часть шаблона; предметные строки убираются, когда шаблон из чужой ниши. */
export function compositionStructure(c: PinoraComposition | null, exact: boolean): string {
  const raw = compositionText(c);
  if (!raw) return "";
  if (exact) return raw;
  return raw.split("\n").filter((l) => !SUBJECT_LINE_RE.test(l)).join("\n");
}

/** Что должно быть на фото для каждой ниши — источник правды вместо шаблона. */
export const NICHE_SUBJECT: Record<string, string> = {
  decor:
    "Real interior or exterior home spaces and decor details (living room, bedroom, kitchen, patio, styling vignettes). No people in frame.",
  nails:
    "Close-up manicured hands and nail designs — polish, nail art, textures, salon-quality detail shots. Hands and nails must be the hero of every photo; NEVER show rooms, furniture or interiors as the subject.",
  hair:
    "Real women's hairstyles and haircuts — head-and-shoulders or three-quarter portraits showing hair length, texture and color. Hair is the hero of every photo; NEVER show rooms, furniture or interiors as the subject.",
  outfit:
    "Real women wearing complete outfits — full-body or three-quarter fashion shots showing clothing, fabric and styling. Clothing is the hero of every photo; NEVER show rooms, furniture or interiors as the subject.",
  cooking:
    "Real prepared food and drinks — plated dishes, ingredients, cooking process, appetizing food photography. Food is the hero of every photo; NEVER show rooms or furniture as the subject.",
};

/** Блок SUBJECT OVERRIDE — приоритетнее любых предметов из шаблона. */
export function subjectBlock(niche: string, opts: { keyword?: string; pageTitle?: string; h1?: string } = {}): string {
  const base = NICHE_SUBJECT[niche] ?? NICHE_SUBJECT.decor;
  const topic = [opts.keyword, opts.h1 || opts.pageTitle].filter((x): x is string => !!x && x.trim() !== "").join(" — ");
  return [
    `SUBJECT OVERRIDE (highest priority — overrides any subject mentioned in the composition block):`,
    `- NICHE: ${niche}. ${base}`,
    topic ? `- The photo must literally illustrate: ${topic}.` : "",
    `- If the composition block names a different subject (interiors, food, nails, hair, clothing), IGNORE that subject and keep only its layout, typography, color logic and decor rules.`,
  ].filter((l) => l !== "").join("\n");
}

export const paramsOf = (scope: PinoraScope, group: GroupKey): PinoraParam[] =>
  LIB.styleParameters.filter((p) => p.scope === scope && p.group === group);

/** Коды «ничего не показывать» — их нужно проговаривать в промте явно. */
export const NONE_CODES: Partial<Record<GroupKey, string>> = { g2: "Б10", g3: "В9", g5: "Д10" };

/* ------------------------------ случайность ------------------------------ */

export type Rand = () => number;

/** xorshift32 от целого seed — детерминированный генератор (как в pinoraPlanner). */
export function prng(seed: number): Rand {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function shuffleArr<T>(a: readonly T[], rand: Rand = Math.random): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** Мешок без возврата: пока пул не исчерпан, повторов не будет. */
export class StyleBag {
  private bags: Record<string, string[]> = {};
  constructor(private readonly rand: Rand = Math.random) {}
  pick(key: string, pool: readonly string[]): string {
    if (pool.length === 0) return "";
    let bag = this.bags[key];
    if (!bag || bag.length === 0) {
      bag = shuffleArr(pool, this.rand);
      this.bags[key] = bag;
    }
    return bag.shift() ?? "";
  }
}

export type PinoraRng = { rand: Rand; bag: StyleBag };

/** Общий генератор на страницу/прогон: один мешок на все пины, чтобы параметры не повторялись. */
export function createPinoraRng(seed: number): PinoraRng {
  const rand = prng(seed);
  return { rand, bag: new StyleBag(rand) };
}

/* ---------------------------- режимы стилей ---------------------------- */

export type Intensity = "minimum" | "low" | "medium" | "maximum" | "auto";
export type StyleMode = Exclude<Intensity, "auto"> | "random";

export const INTENSITY_GROUPS: Record<Exclude<Intensity, "auto">, GroupKey[]> = {
  minimum: ["g1", "g7"],
  low: ["g1", "g6", "g7"],
  medium: ["g1", "g2", "g5", "g6", "g7"],
  maximum: ["g1", "g2", "g3", "g4", "g5", "g6", "g7"],
};

const AUTO_DISTRIBUTION: ReadonlyArray<{ mode: Exclude<Intensity, "auto">; weight: number }> = [
  { mode: "low", weight: 40 },
  { mode: "medium", weight: 40 },
  { mode: "maximum", weight: 20 },
];

/** Баланс 40/40/20: low / medium / maximum. */
export function rollAutoMode(rand: Rand): Exclude<Intensity, "auto"> {
  const total = AUTO_DISTRIBUTION.reduce((a, d) => a + d.weight, 0);
  let t = rand() * total;
  for (const d of AUTO_DISTRIBUTION) { t -= d.weight; if (t <= 0) return d.mode; }
  return "medium";
}

/** g1 + 1..4 случайных группы — режим «Рандомные стили». */
export function pickRandomGroups(rand: Rand = Math.random): GroupKey[] {
  const optional: GroupKey[] = ["g2", "g3", "g4", "g5", "g6", "g7"];
  const count = Math.floor(rand() * 4) + 1;
  return ["g1", ...shuffleArr(optional, rand).slice(0, count)];
}

/* ------------------------- правила совместимости ------------------------- */

const INCOMPATIBLE: ReadonlyArray<[string, string]> = [
  ["Е4", "Ж7"], // тёмная палитра + тёмная ночная атмосфера
  ["Е4", "Ж9"],
  ["А9", "Г5"], // обводка заголовка + текст прямо на фото
  ["Г14", "А11"], // «без фона» + цветной блок за текстом
];

/** Если пара несовместима — второй слот перевыбирается из мешка. */
export function applyCompatibility(
  chosen: Partial<Record<GroupKey, PinoraParam>>,
  redraw: (g: GroupKey) => PinoraParam | null,
  niche: string,
): Partial<Record<GroupKey, PinoraParam>> {
  if (niche === "cooking") return chosen;
  for (const [a, b] of INCOMPATIBLE) {
    const keys = Object.keys(chosen).filter(isGroup);
    const ga = keys.find((g) => chosen[g]?.code === a);
    const gb = keys.find((g) => chosen[g]?.code === b);
    if (ga && gb) {
      for (let i = 0; i < 4; i++) {
        const next = redraw(gb);
        if (!next) break;
        chosen[gb] = next;
        if (next.code !== b) break;
      }
    }
  }
  return chosen;
}

/* ---------------------- сборка стиля одного пина ---------------------- */

type StyleContext = {
  niche: string;
  bag: StyleBag;
  rand: Rand;
  intensity: Intensity;
  randomStyles: boolean;
  year: string;
  yearEnabled: boolean;
  count: number | null;
  season: string;
  ctaEnabled: boolean;
  ctaText: string;
  siteName: string;
  topicKeyword: string;
};

type PinStyleSelection = {
  groups: GroupKey[];
  mode: StyleMode;
  codes: Record<string, string>;
  ctaPhrase: string;
  styleBlock: string;
};

function buildPinStyle(ctx: StyleContext, type: PinoraType): PinStyleSelection {
  const scope = nicheScope(ctx.niche);
  // «Аппетит» — только стиль заголовка, остальное задаёт макро-кадр еды.
  const custom: GroupKey[] | null = type === "appetite" ? ["g1"] : null;
  const hasCustom = custom !== null;

  let mode: StyleMode = "medium";
  let groups: GroupKey[];
  if (ctx.randomStyles && custom === null) {
    groups = pickRandomGroups(ctx.rand);
    mode = "random";
  } else if (custom !== null) {
    groups = custom;
    mode = ctx.intensity === "auto" ? rollAutoMode(ctx.rand) : ctx.intensity;
  } else {
    mode = ctx.intensity === "auto" ? rollAutoMode(ctx.rand) : ctx.intensity;
    groups = INTENSITY_GROUPS[mode];
  }
  if (!ctx.yearEnabled) groups = groups.filter((g) => g !== "g3");

  const suffix = `${type}|${hasCustom ? "custom" : "global"}`;
  const chosen: Partial<Record<GroupKey, PinoraParam>> = {};
  const drawFrom = (g: GroupKey): PinoraParam | null => {
    const pool = paramsOf(scope, g);
    if (!pool.length) return null;
    const code = ctx.bag.pick(`${g}|${suffix}`, pool.map((p) => p.code));
    return pool.find((p) => p.code === code) ?? pool[0];
  };
  groups.forEach((g) => { const p = drawFrom(g); if (p) chosen[g] = p; });
  applyCompatibility(chosen, drawFrom, ctx.niche);

  // Если цифры идей нет — группа «число» бессмысленна, ставим явное «без числа».
  if (chosen.g2 && !ctx.count) {
    const none = paramsOf(scope, "g2").find((p) => p.code === NONE_CODES.g2);
    if (none) chosen.g2 = none;
  }
  // CTA выключен тегом — явное «без CTA», чтобы модель не дорисовала кнопку сама.
  if (chosen.g5 && !ctx.ctaEnabled) {
    const none = paramsOf(scope, "g5").find((p) => p.code === NONE_CODES.g5);
    if (none) chosen.g5 = none;
  }

  const ctaPool = scope === "cooking" ? LIB.ctaPhrasePools.cooking : LIB.ctaPhrasePools.general;
  const ctaActive = !!chosen.g5 && chosen.g5.code !== NONE_CODES.g5;
  const ctaPhrase = ctaActive ? (ctx.ctaText || ctx.bag.pick(`cta|${scope}`, ctaPool)) : "";

  const fill = (s: string): string => s
    .replace(/\[YEAR\]/g, ctx.year)
    .replace(/\[COUNT\]/g, ctx.count ? String(ctx.count) : "")
    .replace(/\[TOPIC_COUNT\]/g, ctx.count ? String(ctx.count) : "")
    .replace(/\[SUBTEXT\]/g, "")
    .replace(/\[SEASON\]/g, ctx.season)
    .replace(/\[CTA_PHRASE\]/g, ctaPhrase)
    .replace(/\[SITE_NAME\]/g, ctx.siteName)
    .replace(/\[TOPIC_KEYWORD\]/g, ctx.topicKeyword);

  const lines: string[] = [];
  const add = (label: string, g: GroupKey): void => {
    const p = chosen[g];
    if (!p) return;
    lines.push(`- ${label}: ${fill(p.promptFragment)}`);
  };
  add("HEADLINE STYLE", "g1");
  if (chosen.g2) {
    lines.push(chosen.g2.code === NONE_CODES.g2
      ? "- NUMBER OVERRIDE: Do NOT show any standalone number element on the pin."
      : `- NUMBER OVERRIDE: Number display: ${fill(chosen.g2.promptFragment)}`);
    if (chosen.g2.code !== NONE_CODES.g2 && ctx.count) {
      lines.push(`- HEADLINE OVERRIDE: The headline text MUST NOT contain the digits "${ctx.count}" — the number element owns the count.`);
    }
  }
  if (chosen.g3) {
    lines.push(chosen.g3.code === NONE_CODES.g3
      ? "- YEAR OVERRIDE: Do NOT show any year anywhere on the pin."
      : `- YEAR OVERRIDE: ${fill(chosen.g3.promptFragment)}`);
  }
  add("DECOR ACCENT", "g4");
  if (chosen.g5) {
    lines.push(chosen.g5.code === NONE_CODES.g5
      ? "- CTA OVERRIDE: Do NOT add any button, link or call-to-action element."
      : `- CTA OVERRIDE: ${fill(chosen.g5.promptFragment)}. Use ONLY this CTA element. Do NOT add any additional buttons, links, or calls-to-action. Only one CTA allowed on the entire pin.`);
  }
  add("COLOR PALETTE", "g6");
  add("PHOTO ATMOSPHERE", "g7");
  lines.push(ctx.season
    ? `- SEASON OVERRIDE: The pin is seasonal — the headline must naturally mention "${ctx.season}" and the photo styling, props and palette must read as that season.`
    : "- SEASON OVERRIDE: Do NOT mention any season word on the pin and keep the styling season-neutral.");
  lines.push(ctx.siteName
    ? `- SITE NAME OVERRIDE: place the wordmark "${ctx.siteName}" exactly once as a small, quiet footer or corner label in the pin's own typography — readable, never a logo, never louder than the headline.`
    : "- SITE NAME OVERRIDE: Do NOT add any site name, domain or wordmark anywhere on the pin.");

  const codes: Record<string, string> = {};
  for (const g of Object.keys(chosen).filter(isGroup)) {
    const p = chosen[g];
    if (p) codes[g] = p.code;
  }
  return { groups, mode, codes, ctaPhrase, styleBlock: lines.join("\n") };
}

/** Человекочитаемая расшифровка выбранных параметров для карточки пина. */
export function describeCodes(niche: string, codes: Record<string, string>): Array<{ group: GroupKey; code: string; label: string; name: string }> {
  const scope = nicheScope(niche);
  return Object.entries(codes)
    .filter((e): e is [GroupKey, string] => isGroup(e[0]))
    .map(([g, code]) => {
      const p = LIB.styleParameters.find((x) => x.scope === scope && x.group === g && x.code === code);
      return { group: g, code, label: GROUP_LABEL[g], name: p?.nameRu ?? code };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

/* ------------------------------ параметры пина ------------------------------ */

export const PINORA_ASPECT = "2:3" as const;

/** Всё, что нужно генератору промтов, — хранится в элементе прогона (бывшее style_params + auto). */
export type PinoraParams = {
  niche: string;
  type: PinoraType;
  themeLabel: string;
  mode: StyleMode;
  groups: GroupKey[];
  codes: Record<string, string>;
  ctaPhrase: string;
  count: number | null;
  season: string;
  year: string;
  yearEnabled: boolean;
  siteName: string;
  /** Структура композиции (раскладка, типографика, цвет, декор, запреты). */
  instructions: string;
  /** Блок SUBJECT OVERRIDE — что снимать. */
  subject: string;
  /** STYLE BLOCK с OVERRIDE-строками. */
  styleBlock: string;
  aspect: typeof PINORA_ASPECT;
};

export type BuildPinoraParamsArgs = {
  type: string;
  niche: string;
  /** Seed пина; если не передан `rng`, из него строится свой генератор и мешок. */
  seed: number;
  tags: ElementTags;
  ideaCount?: number;
  year?: string;
  season?: string;
  /** Готовая CTA-фраза; если нет — берётся из пула библиотеки. */
  ctaText?: string;
  siteName?: string;
  /** Ключ и заголовок страницы — для SUBJECT OVERRIDE и подстановки [TOPIC_KEYWORD]. */
  keyword?: string;
  pageTitle?: string;
  /** "auto" — баланс 40/40/20 (по умолчанию); "random" — g1 + 1..4 случайных группы. */
  styleMode?: "auto" | "random";
  /** Общий генератор на страницу — чтобы мешок не повторял параметры между пинами. */
  rng?: PinoraRng;
};

export function buildPinoraParams(args: BuildPinoraParamsArgs): PinoraParams {
  const type: PinoraType = isPinoraType(args.type) ? args.type : "tobi";
  const niche = PINORA_NICHES.some((n) => n.id === args.niche) ? args.niche : "decor";
  const { rand, bag } = args.rng ?? createPinoraRng(args.seed);
  const count = args.tags.number && args.ideaCount && args.ideaCount > 0 ? Math.floor(args.ideaCount) : null;
  const season = args.tags.season ? (args.season || "").trim() : "";
  const year = (args.year || "").trim();
  const yearEnabled = args.tags.year && year !== "";
  const siteName = args.tags.siteName ? (args.siteName || "").trim() : "";
  const keyword = (args.keyword || "").trim();

  const sel = buildPinStyle({
    niche,
    bag,
    rand,
    intensity: "auto",
    randomStyles: args.styleMode === "random",
    year,
    yearEnabled,
    count,
    season,
    ctaEnabled: !!args.tags.cta,
    ctaText: (args.ctaText || "").replace(/\d+/g, "").replace(/\s{2,}/g, " ").trim(),
    siteName,
    topicKeyword: keyword,
  }, type);

  const { comp, exact } = compositionForNiche(niche, type);
  return {
    niche,
    type,
    themeLabel: nicheLabel(niche),
    mode: sel.mode,
    groups: sel.groups,
    codes: sel.codes,
    ctaPhrase: sel.ctaPhrase,
    count,
    season,
    year,
    yearEnabled,
    siteName,
    instructions: fillComposition(compositionStructure(comp, exact), { year: yearEnabled ? year : "", count, season, siteName, keyword, ctaPhrase: sel.ctaPhrase }),
    subject: subjectBlock(niche, { keyword, pageTitle: args.pageTitle || "" }),
    styleBlock: sel.styleBlock,
    aspect: PINORA_ASPECT,
  };
}

/* ------------------------------ генерация промтов ------------------------------ */

export const PINORA_TEMPERATURE = 0.9;
export const PINORA_MAX_TOKENS = 8000;
const PINORA_BUDGET_MS = 130_000;
const PINORA_CALL_TIMEOUT_MS = 55_000;
const PINORA_ATTEMPTS = 3;
/** Пинов в одном вызове модели (старый сервис слал всю страницу разом). */
const PINORA_GROUP_SIZE = 6;

export type PinoraAudience = "women" | "men" | "mix";

export type PinoraItem = {
  id: string;
  params: PinoraParams;
  keyword: string;
  /** Заголовок/тема страницы — контекст для живых заголовков. */
  topic: string;
  language: string;
  audience: PinoraAudience;
};

export type PinoraPromptResult = { prompt: string; title?: string };

const YEAR_TOKEN_RE = /\b20\d{2}\b/g;

function sanitize(s: string): string {
  return String(s || "")
    .replace(/[«»""„”]/g, "")
    .replace(/[’‘']/g, "")
    .replace(/\s*:\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const normalizeYears = (s: string, year: string): string => String(s || "").replace(YEAR_TOKEN_RE, year);
const stripYears = (s: string): string => String(s || "").replace(YEAR_TOKEN_RE, "").replace(/\s{2,}/g, " ").trim();

const TEXT_POSITIONS = [
  "text block centered in the middle of the pin",
  "text block in the top third of the pin",
  "text block in the bottom third of the pin",
  "text block on a solid band across the middle",
];

/** Шаблон чужой ниши иногда «протаскивает» свой предмет (интерьер на пин про маникюр). */
const FOREIGN: Record<string, RegExp> = {
  nails: /\b(living room|bedroom|interior|sofa|couch|furniture|dining table|plated dish|hairstyle|haircut)\b/i,
  hair: /\b(living room|bedroom|interior|sofa|couch|furniture|manicure|nail art|plated dish)\b/i,
  outfit: /\b(living room|bedroom|interior|sofa|couch|furniture|manicure|nail art|plated dish)\b/i,
  cooking: /\b(living room|bedroom|sofa|couch|manicure|nail art|hairstyle|haircut)\b/i,
  decor: /\b(manicure|nail art|hairstyle|haircut)\b/i,
};

function peopleRule(niche: string, audience: PinoraAudience): string {
  if (niche === "decor") return "- Theme is home / decor: there are NO people in the pin at all. This overrides any gender rule.";
  if (audience === "men") return "- Show men or stay gender-neutral. Women only when the topic explicitly says Women / Woman / Female.";
  if (audience === "mix") return "- Freely show women OR men (or both together) — vary across pins so the batch feels inclusive. No exclusive lock either way.";
  return "- Show women or stay gender-neutral. Men only when the topic explicitly says Men / Man / Male.";
}

type PinoraGroup = {
  niche: string;
  themeLabel: string;
  keyword: string;
  topic: string;
  language: string;
  audience: PinoraAudience;
  year: string;
  yearEnabled: boolean;
  count: number | null;
  items: PinoraItem[];
};

function buildSystem(g: PinoraGroup): string {
  const { year, yearEnabled, count } = g;
  return `You are an expert Pinterest pin art-director writing image-generation prompts.
Every pin is one complete standalone Pinterest poster, ultra-realistic DSLR photography.

REALISM
- Photorealistic DSLR photography only. No illustration, no cartoon, no 3D render, no AI artifacts,
  no meaningless icons, no distorted text, no watermarks, no logos.

PEOPLE
${peopleRule(g.niche, g.audience)}

HEADLINE LANGUAGE: ${g.language}. All visible text on the pin is in that language, horizontal only,
never rotated, never vertical.

THEME: ${g.themeLabel}

=== SUBJECT RULE (HIGHEST PRIORITY) ===
- The SUBJECT OVERRIDE block of each pin decides WHAT is photographed. It always wins.
- The COMPOSITION INSTRUCTIONS block is a STRUCTURAL template only: layout, text placement,
  typography, color logic, decorative elements, forbidden elements.
- If the composition template mentions a subject from another niche (interiors, furniture, food,
  nails, hair, clothing), IGNORE that subject completely and photograph the SUBJECT OVERRIDE instead.
- A pin whose photo subject does not match the SUBJECT OVERRIDE is a failed pin — rewrite it.


=== YEAR CONTRACT (NON-NEGOTIABLE) ===
${yearEnabled
  ? `- Target year is exactly ${year}.
- If any 4-digit year appears anywhere in name, description, headline, prompt, badge, sticker, CTA
  or visual text, it MUST be exactly ${year}.
- Never infer a year from training data or examples. Never output any other 20xx year.`
  : `- Year display is disabled. Do not include any 4-digit 20xx year anywhere.`}

=== COUNT CONTRACT (NON-NEGOTIABLE, HARD RULE) ===
- The quantity number from the topic${count ? ` (here: "${count}")` : ""} MUST appear EXACTLY ONCE on the
  entire pin — one single visual element, never two, never three.
- Decide which SINGLE element owns the count: (a) the NUMBER DISPLAY element if the style has one,
  or (b) the HEADLINE text if there is no NUMBER DISPLAY. Never both.
- If a NUMBER DISPLAY element is present, the HEADLINE MUST be written WITHOUT the count digits.
- CTA text, arrow tags, pill buttons, hook labels, badges, stickers and corner counters MUST use
  non-numeric wording — never echo the count digits.
- Any pin where the count digits appear in two different elements is a failed pin — rewrite it.

OUTPUT
Return STRICT JSON only, no markdown:
{"templates":[{"name":"short english name","description":"короткое описание пина на русском","type":"<pin type>","photoCount":1,"prompt":"<full image generation prompt in english>"}]}
Return exactly ${g.items.length} templates, in the same order as the requested pins.
Each "prompt" is a single self-contained paragraph block that fully describes the finished pin:
composition, photo subject, text content, typography, colors and decorative elements.`;
}

function buildUser(g: PinoraGroup): string {
  const safeTopic = g.yearEnabled ? normalizeYears(g.keyword, g.year) : stripYears(g.keyword);
  const pageTopic = g.topic.trim() && g.topic.trim().toLowerCase() !== g.keyword.trim().toLowerCase()
    ? (g.yearEnabled ? normalizeYears(g.topic.trim(), g.year) : stripYears(g.topic.trim()))
    : "";
  const seasonAny = g.items.find((it) => it.params.season)?.params.season ?? "";
  const ctxLines = [
    pageTopic ? `PAGE TITLE: ${pageTopic}` : "",
    seasonAny ? `PAGE SEASON: ${seasonAny}` : "",
  ].filter((l) => l !== "").join("\n");

  const pins = g.items.map((it, i) => {
    const p = it.params;
    return `--- PIN ${i + 1} · TYPE: ${p.type} ---
${p.count ? `COUNT FOR THIS PIN: ${p.count} (must appear exactly once, on one element only)` : "COUNT FOR THIS PIN: none — do not show any quantity number"}
${p.season ? `SEASON FOR THIS PIN: ${p.season} — the headline mentions this season and the styling matches it` : "SEASON FOR THIS PIN: none — keep wording and styling season-neutral"}
${p.subject || ""}
COMPOSITION INSTRUCTIONS (structure only — layout, typography, colors, decor; NOT the photo subject):
${p.instructions || "(use the standard composition of this pin type)"}
STYLE BLOCK (apply exactly, do not add elements that are not listed):
${p.styleBlock || "(no extra style overrides)"}`;
  }).join("\n\n");

  return `TOPIC: ${safeTopic}
${g.count ? `COUNT OF IDEAS: ${g.count}\n` : ""}ASPECT RATIO: ${PINORA_ASPECT}
${ctxLines ? `\nPAGE CONTEXT (use it to write natural, specific headlines — never copy it word for word, never put a URL on the pin):\n${ctxLines}\n` : ""}
HEADLINE QUALITY
- Headlines must sound like a real Pinterest creator wrote them: concrete, benefit-driven, scannable.
- Use the page title and season above for wording and specificity, not the raw keyword.
- No URLs, no domain names, no SEO keyword stuffing, no ALL-CAPS walls.

PINS TO WRITE (${g.items.length}):
${pins}


Return the JSON object now.`;
}

type RawTemplate = { name?: unknown; prompt?: unknown; photoCount?: unknown };

function extractTemplates(json: unknown): RawTemplate[] | null {
  if (Array.isArray(json)) return json as RawTemplate[];
  if (json && typeof json === "object") {
    const t = (json as { templates?: unknown }).templates;
    if (Array.isArray(t)) return t as RawTemplate[];
  }
  return null;
}

function groupItems(items: PinoraItem[]): PinoraGroup[] {
  const map = new Map<string, PinoraGroup>();
  for (const it of items) {
    const p = it.params;
    const key = [p.niche, it.keyword, it.topic, it.language, it.audience, p.year, p.yearEnabled ? 1 : 0, p.count ?? ""].join("|");
    let g = map.get(key);
    if (!g) {
      g = {
        niche: p.niche, themeLabel: p.themeLabel, keyword: it.keyword, topic: it.topic,
        language: it.language || "en", audience: it.audience, year: p.year, yearEnabled: p.yearEnabled, count: p.count, items: [],
      };
      map.set(key, g);
    }
    g.items.push(it);
  }
  const out: PinoraGroup[] = [];
  for (const g of map.values()) {
    for (let i = 0; i < g.items.length; i += PINORA_GROUP_SIZE) out.push({ ...g, items: g.items.slice(i, i + PINORA_GROUP_SIZE) });
  }
  return out;
}

function abortError(): Error {
  const e = new Error("Генерация промтов остановлена");
  e.name = "AbortError";
  return e;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

async function callModel(ctx: AiCtx, system: string, user: string, timeoutMs: number): Promise<RawTemplate[] | null> {
  const res = await aiChat(ctx, "text_main", {
    system,
    user,
    json: true,
    maxTokens: PINORA_MAX_TOKENS,
    temperature: PINORA_TEMPERATURE,
    timeoutMs,
  });
  return extractTemplates(res.json);
}

async function generateGroup(ctx: AiCtx, g: PinoraGroup, out: Map<string, PinoraPromptResult>, signal?: AbortSignal): Promise<void> {
  const system = buildSystem(g);
  const user = buildUser(g);
  const startedAt = Date.now();
  const budgetLeft = (): number => PINORA_BUDGET_MS - (Date.now() - startedAt);

  let templates: RawTemplate[] | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < PINORA_ATTEMPTS && !templates; attempt++) {
    if (signal?.aborted) throw abortError();
    const left = budgetLeft();
    if (left < 15_000) break;
    try {
      templates = await callModel(ctx, system, user, Math.min(PINORA_CALL_TIMEOUT_MS, left - 5_000));
      if (!templates) lastErr = new Error("AI вернул некорректный ответ");
    } catch (e) {
      if (e instanceof AiError && e.cls.kind !== "transient") throw e;
      lastErr = e;
    }
    if (!templates && attempt < PINORA_ATTEMPTS - 1) await sleep(1_500 * (attempt + 1), signal);
  }
  if (!templates) {
    if (lastErr instanceof Error) throw lastErr;
    throw new Error("AI вернул некорректный ответ");
  }
  const tpl: RawTemplate[] = templates;

  const yearLock = (year: string): string =>
    `YEAR LOCK: every visible year/date text on this pin must be the exact digits "${year}". If the prompt says to show a year, render "${year}" specifically; never invent, infer, or render any other year.`;

  const finish = (it: PinoraItem, raw: string): string => {
    const p = it.params;
    let prompt = sanitize(raw);
    prompt = p.yearEnabled ? `${normalizeYears(prompt, p.year)} ${yearLock(p.year)}` : stripYears(prompt);
    // CTA: одна фраза из пула, без цифр количества.
    if (p.ctaPhrase) {
      const phrase = p.ctaPhrase.replace(/\d+/g, "").replace(/\s{2,}/g, " ").trim();
      if (phrase) prompt = `${prompt} CTA text reads exactly: ${phrase}.`;
    }
    if (p.type === "collage") {
      const photoCount = 2 + Math.floor(Math.random() * 5);
      const pos = TEXT_POSITIONS[Math.floor(Math.random() * TEXT_POSITIONS.length)];
      prompt = `${prompt} TEXT POSITION: ${pos}, horizontal text only, never rotated or vertical. Collage of ${photoCount} photos.`;
    }
    return `${prompt} Generate image with aspect ratio - ${PINORA_ASPECT}`;
  };

  const results: Array<{ item: PinoraItem; prompt: string; title: string } | null> = g.items.map((it, i) => {
    const t: RawTemplate | undefined = tpl[i];
    const raw = t && typeof t.prompt === "string" ? t.prompt : "";
    if (!raw.trim()) return null;
    const title = sanitize(t && typeof t.name === "string" ? t.name : `${it.params.type} pin ${i + 1}`).slice(0, 90);
    return { item: it, prompt: finish(it, raw), title };
  });

  // Пост-проверка сюжета: пины с предметом чужой ниши переписываем один раз.
  const badIdx = results
    .map((r, i) => {
      if (!r) return -1;
      const re = FOREIGN[r.item.params.niche];
      return re && re.test(r.prompt) ? i : -1;
    })
    .filter((i) => i >= 0);

  if (badIdx.length && budgetLeft() > 25_000 && !signal?.aborted) {
    const fixUser = `${user}

CRITICAL FIX: pins ${badIdx.map((i) => i + 1).join(", ")} were rewritten because their photo subject
did not match the SUBJECT OVERRIDE. Rewrite ALL pins again, keeping the composition structure but
photographing ONLY the subject named in each pin's SUBJECT OVERRIDE block.`;
    try {
      const fixed = await callModel(ctx, system, fixUser, Math.max(10_000, budgetLeft() - 5_000));
      const list = fixed ?? [];
      for (const i of badIdx) {
        const r = results[i];
        const t = list[i];
        const raw = t && typeof t.prompt === "string" ? t.prompt : "";
        if (r && raw.trim()) r.prompt = finish(r.item, raw);
      }
    } catch (e) {
      if (e instanceof AiError && e.cls.kind === "fatal_run") throw e;
      console.error("[pins] pinora subject retry failed", e instanceof Error ? e.message : String(e));
    }
  }

  for (const r of results) {
    if (r) out.set(r.item.id, { prompt: r.prompt, title: r.title || undefined });
  }
}

/**
 * Промты Pinora-пинов. Пины группируются по странице (ключ, ниша, язык, год, число),
 * каждая группа — один вызов модели (до 6 пинов), 3 попытки в бюджете 130 с.
 * Возвращает Map id → { prompt, title }; пины без промта в Map отсутствуют.
 * Фатальные ошибки (ключ, кредиты, safety) и исчерпание попыток пробрасываются.
 */
export async function generatePinoraPrompts(
  ctx: AiCtx,
  items: PinoraItem[],
  opts?: { signal?: AbortSignal },
): Promise<Map<string, PinoraPromptResult>> {
  const signal = opts?.signal ?? ctx.signal;
  const aiCtx: AiCtx = signal ? { ...ctx, signal } : ctx;
  const out = new Map<string, PinoraPromptResult>();
  if (!items.length) return out;
  for (const g of groupItems(items)) {
    if (signal?.aborted) throw abortError();
    await generateGroup(aiCtx, g, out, signal);
  }
  return out;
}
