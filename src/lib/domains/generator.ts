/**
 * Чистая логика генерации доменных имён из брендов, приставок и зон.
 * Правило: приставка ставится ТОЛЬКО после бренда (brand + suffix), никогда перед ним.
 * Порядок = приоритет: бренд → уровень 1 → (бренд через дефис) → [бренд + буква] → [casino → casinos] → уровни 2…6 → [бренд + буква];
 * каждая метка × каждая зона.
 */
import { RESEARCH_SOURCE_LABELS, type BrandItem, type CandidatePattern, type CountryPreset, type LetterMode, type SuffixSource, type TldSource } from "./types";
import { countryTld } from "./geo";
import { countryByCode } from "./countries";

export type DomainCandidateInput = {
  brand: string;
  label: string;
  tld: string;
  domain: string;
  suffix: string | null;
  tier: number;
  pattern: CandidatePattern;
};

export function sanitizeLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTld(value: string): string {
  return value.toLowerCase().trim().replace(/^\./, "").replace(/[^a-z0-9.-]/g, "");
}

export function brandWords(brand: string): string[] {
  return sanitizeLabel(brand).split(/[\s-]+/).filter(Boolean);
}

/** Приставка: только a-z0-9, без пробелов и дефисов внутри. */
export function cleanSuffix(s: string): string {
  return sanitizeLabel(s).replace(/[\s-]+/g, "");
}

/** Убирает дубли между уровнями: приставка остаётся в первом уровне, где встретилась. */
export function dedupeTiers(tiers: string[][], count = 3): string[][] {
  const used = new Set<string>();
  const out: string[][] = [];
  for (let i = 0; i < count; i++) {
    const list: string[] = [];
    for (const raw of tiers[i] ?? []) {
      const s = cleanSuffix(raw);
      if (!s || used.has(s)) continue;
      used.add(s);
      list.push(s);
    }
    out.push(list);
  }
  return out;
}

/** Список через перенос строки / запятую / точку с запятой, без дублей и пустых. */
export function parseList(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean)));
}

/* ---------- Тематические слова в бренде ---------- */

/**
 * Группы тематических слов. Если слово группы уже есть в бренде («Alibaba Casino»), приставки этой группы
 * к бренду не добавляются (alibabacasinocasino не нужен); допускается только форма с «s» (alibabacasinos).
 */
export const THEME_GROUPS: string[][] = [
  ["casino", "casinos", "kasino", "kasinos", "casinoonline", "onlinecasino"],
  ["bet", "bets", "betting"],
  ["slot", "slots", "slotsonline"],
  ["game", "games", "gaming"],
  ["spin", "spins"],
  ["poker"],
  ["bingo"],
  ["lotto", "lottery", "loterij"],
  ["sport", "sports", "sportsbook"],
  ["gokken", "gokkasten"],
  ["apuestas"],
  ["wetten"],
];

const GROUP_OF = new Map<string, number>(THEME_GROUPS.flatMap((g, i) => g.map((w) => [w, i] as [string, number])));

/** Слово бренда тематическое (точное совпадение или склейка вида winzoriacasino для слов от 4 букв). */
function themeOfWord(word: string): { group: number; root: string; glued: boolean } | null {
  const exact = GROUP_OF.get(word);
  if (exact != null) return { group: exact, root: word, glued: false };
  for (const [w, g] of GROUP_OF) {
    if (w.length < 4 || word.length < w.length + 3) continue;
    if (word.endsWith(w)) return { group: g, root: w, glued: true };
  }
  return null;
}

/** Номера тематических групп, которые уже есть в бренде. */
export function brandThemeGroups(brand: string): Set<number> {
  const out = new Set<number>();
  for (const w of brandWords(brand)) {
    const t = themeOfWord(w);
    if (t) out.add(t.group);
  }
  return out;
}

export function isThemeWord(word: string): boolean {
  return GROUP_OF.has(cleanSuffix(word));
}

/** Убирает из уровней приставки групп, которые уже есть в бренде. */
export function dropThemeSuffixes(brand: string, tiers: string[][]): string[][] {
  const groups = brandThemeGroups(brand);
  if (groups.size === 0) return tiers;
  return tiers.map((t) => t.filter((s) => {
    const g = GROUP_OF.get(s);
    return g == null || !groups.has(g);
  }));
}

/** Вариант бренда с тематическим словом во множественном числе: alibaba casino → alibaba casinos. */
export function pluralThemeVariant(brand: string): string[] | null {
  const words = brandWords(brand);
  for (let i = words.length - 1; i >= 0; i--) {
    const t = themeOfWord(words[i]!);
    if (!t) continue;
    const plural = `${t.root}s`;
    if (t.root.endsWith("s") || GROUP_OF.get(plural) !== t.group) return null;
    const next = [...words];
    next[i] = t.glued ? words[i]!.slice(0, -t.root.length) + plural : plural;
    return next;
  }
  return null;
}

/* ---------- Бренд + одна буква ---------- */

/**
 * Правила «одной буквы»:
 * - меняется только отличительное слово бренда (не casino/bet/slots и не цифры), от 5 букв;
 * - первые две и последняя буква не трогаются — по ним бренд узнают;
 * - удваивается только согласная между двумя гласными (winzoria → winzorria, alibaba → alibbaba):
 *   так слово читается так же; подходят l n r s t m p f g d b;
 * - не удваиваются гласные и h j k q v w x y z c (меняют чтение или похожи на другие буквы: vv → w);
 * - не появляются сочетания, которые глаз путает с другими буквами (rn → m, vv → w, cl → d, ii → u);
 * - если в слове уже есть двойная буква, вторую не добавляем;
 * - отдельный вариант — «s» в конце (winzorias), если это последнее слово бренда и оно не кончается на s/x/z.
 * Юридически это тайпосквоттинг (UDRP считает разницу в одну букву «сходной до смешения»), поэтому режим выключаемый.
 */
const DOUBLE_OK = new Set(["l", "n", "r", "s", "t", "m", "p", "f", "g", "d", "b"]);
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
const CONFUSABLE = ["rn", "vv", "cl", "ii", "lll", "nnn"];
export const LETTER_VARIANTS_MAX = 4;

function wordLetterVariants(word: string, allowPlural: boolean): string[] {
  if (word.length < 5 || /\d/.test(word) || /(.)\1/.test(word)) return [];
  const preferred = ["r", "l", "n", "s", "t"];
  const doubles: Array<{ v: string; rank: number }> = [];
  for (let i = 2; i < word.length - 1; i++) {
    const ch = word[i]!;
    if (!DOUBLE_OK.has(ch) || !VOWELS.has(word[i - 1]!) || !VOWELS.has(word[i + 1]!)) continue;
    const v = word.slice(0, i + 1) + ch + word.slice(i + 1);
    if (CONFUSABLE.some((c) => v.includes(c) && !word.includes(c))) continue;
    const r = preferred.indexOf(ch);
    doubles.push({ v, rank: r === -1 ? preferred.length : r });
  }
  doubles.sort((a, b) => a.rank - b.rank);
  const out = doubles.map((d) => d.v);
  if (allowPlural && !/[sxz]$/.test(word)) out.push(`${word}s`);
  return Array.from(new Set(out));
}

/** Варианты бренда с одной добавленной буквой (списки слов); меняется самое длинное отличительное слово. */
export function letterVariants(brand: string, max = LETTER_VARIANTS_MAX): string[][] {
  const words = brandWords(brand);
  let idx = -1;
  words.forEach((w, i) => {
    if (themeOfWord(w) || /^\d+$/.test(w)) return;
    if (idx === -1 || w.length > words[idx]!.length) idx = i;
  });
  if (idx === -1) return [];
  // «s» — только на конце бренда: winzorias да, alibabas casino нет
  return wordLetterVariants(words[idx]!, idx === words.length - 1).slice(0, max).map((v) => {
    const next = [...words];
    next[idx] = v;
    return next;
  });
}

/* ---------- Кандидаты ---------- */

export type BuildOptions = { allowHyphen: boolean; letterMode?: LetterMode };

/** Кандидаты одного бренда в порядке приоритета (дубли доменов и метки длиннее 63 символов отброшены). */
export function buildCandidatesForBrand(brand: string, suffixTiers: string[][], tlds: string[], options: BuildOptions): DomainCandidateInput[] {
  const words = brandWords(brand);
  if (words.length === 0 || tlds.length === 0) return [];
  const tiers = dropThemeSuffixes(brand, dedupeTiers(suffixTiers, Math.max(3, suffixTiers.length)));
  const joined = words.join("");
  const split = words.length > 1 ? words.join("-") : null;
  const letterMode = options.letterMode ?? "off";

  type Item = { label: string; suffix: string | null; tier: number; pattern: CandidatePattern };
  const labels: Item[] = [{ label: joined, suffix: null, tier: 0, pattern: "brand" }];

  const pushGroup = (list: string[], tier: number) => {
    for (const s of list) labels.push({ label: `${joined}${s}`, suffix: s, tier, pattern: "brand+suffix" });
    if (options.allowHyphen) {
      for (const s of list) labels.push({ label: `${joined}-${s}`, suffix: s, tier, pattern: "brand-suffix" });
      if (split) for (const s of list) labels.push({ label: `${split}-${s}`, suffix: s, tier, pattern: "brand-split+suffix" });
    }
  };
  const pushWords = (list: string[][], pattern: CandidatePattern, tier: number) => {
    for (const w of list) {
      labels.push({ label: w.join(""), suffix: null, tier, pattern });
      if (options.allowHyphen && w.length > 1) labels.push({ label: w.join("-"), suffix: null, tier, pattern });
    }
  };
  const letters = letterMode === "off" ? [] : letterVariants(brand);
  const plural = pluralThemeVariant(brand);

  tiers.forEach((tier, index) => {
    if (index === 1 && plural) pushWords([plural], "brand-plural", 2);
    pushGroup(tier, index + 1);
    if (index === 0) {
      if (options.allowHyphen && split) labels.push({ label: split, suffix: null, tier: 0, pattern: "brand-split" });
      if (letterMode === "after1") pushWords(letters, "brand-letter", 0);
    }
  });
  if (letterMode === "last") pushWords(letters, "brand-letter", 0);

  const seen = new Set<string>();
  const out: DomainCandidateInput[] = [];
  const zones = Array.from(new Set(tlds.map(normalizeTld).filter(Boolean)));
  for (const item of labels) {
    const label = item.label.replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!label || label.length > 63) continue;
    for (const tld of zones) {
      const domain = `${label}.${tld}`;
      if (seen.has(domain)) continue;
      seen.add(domain);
      out.push({ brand: brand.trim(), label, tld, domain, suffix: item.suffix, tier: item.tier, pattern: item.pattern });
    }
  }
  return out;
}

/** Сколько кандидатов будет на бренд при таких настройках (для подсказки в форме, оценка сверху). */
export function candidatesPerBrand(suffixTiers: string[][], tldCount: number, allowHyphen: boolean, multiWord: boolean, letterMode: LetterMode = "off"): number {
  const tiers = dedupeTiers(suffixTiers, Math.max(3, suffixTiers.length));
  const n = tiers.reduce((a, t) => a + t.length, 0);
  const perSuffix = 1 + (allowHyphen ? 1 : 0) + (allowHyphen && multiWord ? 1 : 0);
  const letters = letterMode === "off" ? 0 : LETTER_VARIANTS_MAX * (allowHyphen && multiWord ? 2 : 1);
  const labels = 1 + (allowHyphen && multiWord ? 1 : 0) + n * perSuffix + letters;
  return labels * tldCount;
}

/* ---------- План бренда: набор страны + общие приставки + модификаторы + запас ---------- */

export type PlanSettings = { suffixTiers: string[][]; tlds: string[]; countryPresets: Record<string, CountryPreset>; usePool: boolean; autoZones?: boolean };
export type ModifierPool = Map<string, [string[], string[], string[]]>;

/** Запас модификаторов по стране: модификаторы всех брендов страны по уровням, по убыванию суммарной частоты. */
export function modifierPool(items: BrandItem[]): ModifierPool {
  const acc = new Map<string, Map<string, { tier: number; volume: number }>>();
  for (const it of items) {
    const m = acc.get(it.country) ?? new Map<string, { tier: number; volume: number }>();
    for (const mod of it.modifiers) {
      const prev = m.get(mod.suffix);
      m.set(mod.suffix, { tier: Math.min(prev?.tier ?? 3, mod.tier), volume: (prev?.volume ?? 0) + mod.volume });
    }
    acc.set(it.country, m);
  }
  const out: ModifierPool = new Map();
  for (const [country, m] of acc) {
    const sorted = Array.from(m.entries()).sort((a, b) => b[1].volume - a[1].volume);
    out.set(country, [1, 2, 3].map((t) => sorted.filter(([, v]) => v.tier === t).map(([s]) => s)) as [string[], string[], string[]]);
  }
  return out;
}

/**
 * Уровни приставок конкретного бренда:
 * 1–3 = набор страны + свои модификаторы бренда + общие приставки; 4–6 = запас (модификаторы других брендов той же страны).
 */
export function brandTiers(item: BrandItem, s: PlanSettings, pool?: ModifierPool): string[][] {
  return brandTierEntries(item, s, pool).map((t) => t.map((e) => e.suffix));
}

/**
 * Уровни бренда с источником каждой приставки (тот же порядок и те же дубли, что у brandTiers).
 * Внутри уровня: гео-база страны → ключи бренда (подтверждены запросами) → общие приставки; 4–6 — запас страны.
 */
export function brandTierEntries(item: BrandItem, s: PlanSettings, pool?: ModifierPool, items: BrandItem[] = []): Array<Array<{ suffix: string; source: SuffixSource }>> {
  const preset = s.countryPresets[item.country];
  const cc = item.country.toUpperCase();
  const used = new Set<string>();
  const out: Array<Array<{ suffix: string; source: SuffixSource }>> = [];
  const push = (list: Array<{ suffix: string; source: SuffixSource }>, raw: string, source: SuffixSource) => {
    const suffix = cleanSuffix(raw);
    if (!suffix || used.has(suffix)) return;
    used.add(suffix);
    list.push({ suffix, source });
  };
  for (let i = 0; i < 3; i++) {
    const tier = i + 1;
    const list: Array<{ suffix: string; source: SuffixSource }> = [];
    for (const g of preset?.tiers[i] ?? []) push(list, g, { kind: "geo", tier, detail: `гео-база страны ${cc}` });
    for (const m of item.modifiers.filter((x) => x.tier === tier).sort((a, b) => b.volume - a.volume)) {
      const where = (m.sources ?? []).map((k) => RESEARCH_SOURCE_LABELS[k] ?? k).join(", ");
      const detail = ["ключ бренда", where, m.volume ? `частота ${m.volume}/мес` : "", m.query ? `запрос «${m.query}»` : "", m.reason ? `ИИ: ${m.reason}` : ""].filter(Boolean).join(" · ");
      push(list, m.suffix, { kind: "brand", tier, detail, ...(m.volume ? { volume: m.volume } : {}) });
    }
    for (const c of s.suffixTiers[i] ?? []) push(list, c, { kind: "common", tier, detail: `общие приставки формы, уровень ${tier}` });
    out.push(list);
  }
  const extra = s.usePool && pool ? (pool.get(item.country) ?? [[], [], []]) : [[], [], []];
  for (let i = 0; i < 3; i++) {
    const list: Array<{ suffix: string; source: SuffixSource }> = [];
    for (const p of extra[i] ?? []) {
      const from = items.filter((it) => it.country === item.country && it !== item && it.modifiers.some((m) => m.suffix === p)).map((it) => it.brand);
      push(list, p, { kind: "pool", tier: i + 4, detail: `запас: ключ ${from.length ? `бренда ${from.slice(0, 3).join(", ")}` : "другого бренда"} той же страны` });
    }
    out.push(list);
  }
  return out;
}

/** Зоны бренда: общие + зоны набора страны (+ домен страны и зоны конкурентов из выдачи, если autoZones). */
export function brandTlds(item: BrandItem, s: PlanSettings): string[] {
  return brandTldEntries(item, s).map((e) => e.tld);
}

/** Зон конкурентов из выдачи на бренд — не больше. */
const SERP_ZONES_MAX = 6;

/** Зоны бренда с источником: общая → своя зона бренда из списка → набор страны → домен страны (.fr) → зоны доменов конкурентов в TOP-10. */
export function brandTldEntries(item: BrandItem, s: PlanSettings): Array<{ tld: string; source: TldSource }> {
  const out: Array<{ tld: string; source: TldSource }> = [];
  const add = (raw: string, source: TldSource) => {
    const tld = normalizeTld(raw);
    if (tld && !out.some((e) => e.tld === tld)) out.push({ tld, source });
  };
  const cc = item.country.toUpperCase();
  for (const t of s.tlds) add(t, { kind: "common", detail: "общие зоны формы" });
  for (const t of item.tlds ?? []) add(t, { kind: "list", detail: "зона бренда из списка брендов" });
  for (const t of s.countryPresets[item.country]?.tlds ?? []) add(t, { kind: "country", detail: `доп. зоны набора страны ${cc}` });
  if (s.autoZones) {
    const own = countryTld(item.country);
    if (own) add(own, { kind: "cctld", detail: `доменная зона страны ${cc}` });
    for (const z of (item.research?.competitorTlds ?? []).slice(0, SERP_ZONES_MAX)) add(z.value, { kind: "serp", detail: `у конкурентов в TOP-10 Google: ${z.count} дом.` });
  }
  return out;
}

/* ---------- Пачка брендов с разными странами ---------- */

export type ParsedBrand = { brand: string; country: string; tlds: string[] };
export type ParsedBrands = { items: ParsedBrand[]; problems: string[] };

const cleanBrand = (b: string) => b.trim().replace(/\s+/g, " ");
const isBrand = (b: string) => !!b && sanitizeLabel(b).replace(/[\s-]/g, "").length > 0;
/** Доменная зона: com, co.uk, com.mx */
const isZone = (z: string) => /^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/.test(z);

/** Зоны из строки: «bet, ca, .co.uk» → [bet, ca, co.uk]; неверные — в bad. */
export function parseZones(raw: string): { tlds: string[]; bad: string[] } {
  const tlds: string[] = [];
  const bad: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    if (!part.trim()) continue;
    const z = normalizeTld(part);
    if (!isZone(z)) bad.push(part.trim());
    else if (!tlds.includes(z)) tlds.push(z);
  }
  return { tlds, bad };
}

/** Строка списка брендов: «winzoria ; FR» или с зонами бренда «winzoria ; FR ; fr, bet». */
export function brandLine(brand: string, country: string, tlds: string[] = []): string {
  return `${cleanBrand(brand)} ; ${country.toUpperCase()}${tlds.length ? ` ; ${tlds.join(", ")}` : ""}`;
}

/**
 * Разбор поля «Бренды». Формат строки: «бренд ; КОД» или «бренд ; КОД ; зона, зона», где КОД — ISO 3166-1 alpha-2 (FR, NL, DE),
 * а зоны — дополнительные зоны этого бренда (общие зоны формы не повторяются). Вместо «;» можно TAB (колонки из Excel).
 * Строки без кода или с неизвестным кодом не берутся — они попадают в problems. Повтор бренда+страны сливает зоны.
 */
export function parseBrandLines(raw: string): ParsedBrands {
  const items: ParsedBrand[] = [];
  const problems: string[] = [];
  const seen = new Map<string, ParsedBrand>();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s*[;\t]\s*/);
    if (parts.length < 2) {
      problems.push(`Нет кода страны: «${line}» — допишите « ; FR»`);
      continue;
    }
    const brand = cleanBrand(parts[0]!);
    const code = parts[1]!.trim().toLowerCase();
    if (!isBrand(brand)) {
      problems.push(`Нет бренда в строке «${line}»`);
      continue;
    }
    if (!/^[a-z]{2}$/.test(code) || !countryByCode(code)) {
      problems.push(`«${parts[1]!.trim()}» — не код страны (нужны две буквы ISO: FR, NL, DE) в строке «${line}»`);
      continue;
    }
    const zones = parseZones(parts.slice(2).join(","));
    if (zones.bad.length) problems.push(`Не похоже на доменную зону: ${zones.bad.map((b) => `«${b}»`).join(", ")} в строке «${line}»`);
    const key = `${brand.toLowerCase()}|${code}`;
    const prev = seen.get(key);
    if (prev) {
      for (const z of zones.tlds) if (!prev.tlds.includes(z)) prev.tlds.push(z);
      continue;
    }
    const item = { brand, country: code, tlds: zones.tlds };
    seen.set(key, item);
    items.push(item);
  }
  return { items, problems };
}

/** Бренды пачки для пакетного добавления: по одному в строке (или через запятую); код страны в строке, если есть, отбрасывается. */
export function parseBatchBrands(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/\r?\n|,/)) {
    const brand = cleanBrand(part.split(/[;\t]/)[0] ?? "");
    if (!isBrand(brand) || seen.has(brand.toLowerCase())) continue;
    seen.add(brand.toLowerCase());
    out.push(brand);
  }
  return out;
}
