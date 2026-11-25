/**
 * Подбор EMD-доменов по кластерам ключей (режим «EMD по ключам»).
 *
 * Источник — выгрузка «Наблюдение кластеры» (xlsx на Google Диске): строка = ключ, кластер = тема + страна,
 * у ключа частота, роль («тема» / «ключ темы»), маленькие сайты в топе и их зоны.
 * Из темы и ключей кластера с частотой не ниже порога строятся метки домена (слитно, без слов-связок, через дефис,
 * транслитом), на каждую метку — зоны кластера. Вес домена: частота ключа × точность совпадения × зона × длина.
 *
 * Модуль без серверных зависимостей: им пользуются и воркер, и карточка подбора.
 */
import { countryTld } from "./geo";
import { casinoGeoCodes, normalizeTld } from "./generator";
import { tldOf } from "./mining";
import type { Top10Entry } from "./types";

export type EmdKeyword = {
  phrase: string;
  /** Перевод на русский из выгрузки */
  ru: string;
  volume: number;
  /** Ключ — тема кластера */
  theme: boolean;
  kd: number | null;
  trend: string;
  /** Маленьких сайтов в топе по ключу (из выгрузки) */
  smallSites: number;
  /** Их зоны: [[".com", 2], …] */
  smallTlds: Array<[string, number]>;
  officialInTop: boolean;
  /** TOP-10 Google по ключу в стране кластера; match — сколько процентов ключа в домене */
  top10?: Top10Entry[];
  serpError?: string;
};

export type EmdCluster = {
  /** Номер кластера в выгрузке */
  id: string;
  theme: string;
  themeRu: string;
  themeVolume: number;
  /** Проекты выгрузки (project_name), где есть кластер */
  projects: string[];
  keywords: EmdKeyword[];
  serpAt?: string;
  serpCostUsd?: number;
};

export type EmdSettings = {
  /** Ссылка на таблицу Google Диска */
  sourceUrl: string;
  fileName: string;
  loadedAt: string;
  /** Ключи темы с частотой ниже не берём (тема кластера — всегда) */
  minVolume: number;
  /** Самая длинная метка домена (без зоны) */
  maxLen: number;
  /** С какого процента ключа в домене подсвечиваем домен выдачи */
  matchPct: number;
  /** Сколько вариантов на кластер проверять (без приписок и с ними вместе) */
  maxPerCluster: number;
  /** Уровень 2: перестановки, без связок, без casino, ед./мн. число, ключи ниже порога */
  variations: boolean;
  /** Уровень 3: метки EMD-доменов из TOP-10 Google как основы */
  serpVariants: boolean;
  /** Приписки из дополнительных слов ключей кластера (beste, online, nieuwe…) */
  keywordMods: boolean;
  /** Гео-приписка: код страны и alpha-3 (nl, nld) */
  geoMods: boolean;
  /** Свои приписки: в конце и в начале основы */
  suffixes: string[];
  prefixes: string[];
};

export const EMD_DEFAULTS: Omit<EmdSettings, "sourceUrl" | "fileName" | "loadedAt"> = {
  minVolume: 300, maxLen: 30, matchPct: 60, maxPerCluster: 300,
  variations: true, serpVariants: true, keywordMods: true, geoMods: true, suffixes: [], prefixes: [],
};

/** Настройки EMD из JSON подбора: старые подборы без новых полей получают умолчания. */
export function normalizeEmdSettings(raw: unknown): EmdSettings {
  const e = (raw ?? {}) as Partial<EmdSettings>;
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const n = (v: unknown, def: number) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : def);
  return {
    sourceUrl: String(e.sourceUrl ?? ""),
    fileName: String(e.fileName ?? ""),
    loadedAt: String(e.loadedAt ?? ""),
    minVolume: n(e.minVolume, EMD_DEFAULTS.minVolume),
    maxLen: n(e.maxLen, EMD_DEFAULTS.maxLen) || EMD_DEFAULTS.maxLen,
    matchPct: n(e.matchPct, EMD_DEFAULTS.matchPct) || EMD_DEFAULTS.matchPct,
    maxPerCluster: n(e.maxPerCluster, EMD_DEFAULTS.maxPerCluster) || EMD_DEFAULTS.maxPerCluster,
    variations: bool(e.variations, true),
    serpVariants: bool(e.serpVariants, true),
    keywordMods: bool(e.keywordMods, true),
    geoMods: bool(e.geoMods, true),
    suffixes: list(e.suffixes),
    prefixes: list(e.prefixes),
  };
}

export type EmdPattern =
  | "emd" | "emd-translit" | "emd-hyphen"
  | "emd-short" | "emd-perm" | "emd-plural" | "emd-core" | "emd-list"
  | "emd-serp"
  | "emd-mod" | "emd-mod-hyphen";

export const EMD_PATTERN_LABELS: Record<EmdPattern, string> = {
  emd: "точный",
  "emd-translit": "транслит",
  "emd-hyphen": "дефис",
  "emd-short": "без связок",
  "emd-perm": "перестановка",
  "emd-plural": "ед./мн. число",
  "emd-core": "без casino",
  "emd-list": "ключ ниже порога",
  "emd-serp": "из выдачи",
  "emd-mod": "приписка",
  "emd-mod-hyphen": "приписка, дефис",
};
const PATTERN_WEIGHT: Record<EmdPattern, number> = {
  emd: 1, "emd-translit": 0.95, "emd-short": 0.85, "emd-list": 0.8, "emd-plural": 0.75, "emd-perm": 0.7, "emd-core": 0.7,
  "emd-serp": 0.65, "emd-hyphen": 0.6, "emd-mod": 0.45, "emd-mod-hyphen": 0.3,
};

/** Уровни вариантов: 1 — точный ключ, 2 — вариации ключа из таблицы, 3 — основы, найденные в выдаче. */
export type EmdLevel = 1 | 2 | 3;
export const EMD_LEVEL_LABELS: Record<EmdLevel, string> = { 1: "Точный ключ", 2: "Вариации ключа", 3: "Из выдачи" };
export const isModPattern = (p: string) => p.startsWith("emd-mod");

/** Слова-связки: в домене их можно опустить, смысл запроса не меняется. Отрицания (zonder, ohne, utan, non…) сюда не входят. */
export const FILLER = new Set(["online", "met", "med", "mit", "with", "con", "for", "the", "and", "och", "og", "und", "in", "im", "i", "a", "of"]);

/** Страны, где ä/ö/ü принято писать как ae/oe/ue */
const UMLAUT_AE = new Set(["de", "at", "ch", "li", "lu"]);

const SPECIAL: Record<string, string> = { ß: "ss", æ: "ae", ø: "o", œ: "oe", đ: "d", ð: "d", ł: "l", ı: "i", þ: "th" };

/** Слова ключа латиницей: диакритика снята, апостроф убран (casino's → casinos), прочее — разделитель. */
export function phraseWords(phrase: string, umlautAe = false): string[] {
  let s = phrase.toLowerCase().replace(/['’`´]/g, "");
  if (umlautAe) s = s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
  s = s.replace(/[ßæøœđðłıþ]/g, (ch) => SPECIAL[ch] ?? ch);
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return s.split(/[^a-z0-9]+/).filter(Boolean);
}

const validLabel = (l: string, maxLen: number) => l.length >= 3 && l.length <= maxLen && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) && !l.includes("--");

/* ---------- Разбор выгрузки ---------- */

const num = (v: string | undefined) => {
  const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** «.com x2, .org x1» → [[".com", 2], [".org", 1]] */
export function parseSmallTlds(raw: string): Array<[string, number]> {
  return raw
    .split(",")
    .map((p) => /(\.?[a-z0-9.-]+)\s*x\s*(\d+)/i.exec(p.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [`.${normalizeTld(m[1]!)}`, Number(m[2])] as [string, number]);
}

const REQUIRED = ["theme", "original_keyword", "country_code", "search_volume"] as const;

/** Строки листа → кластеры (тема + страна). Кластеры с одной темой и страной из разных проектов сливаются. */
export function parseEmdRows(rows: string[][]): { clusters: Array<EmdCluster & { country: string }>; problems: string[] } {
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const missing = REQUIRED.filter((n) => col(n) < 0);
  if (missing.length) return { clusters: [], problems: [`В таблице нет колонок: ${missing.join(", ")} (первая строка — заголовки, как в выгрузке «Наблюдение кластеры»)`] };
  const get = (r: string[], name: string) => {
    const i = col(name);
    return i >= 0 ? String(r[i] ?? "").trim() : "";
  };
  const problems: string[] = [];
  const map = new Map<string, EmdCluster & { country: string }>();
  rows.slice(1).forEach((r, i) => {
    const theme = get(r, "theme");
    const phrase = get(r, "original_keyword");
    const country = get(r, "country_code").toLowerCase();
    if (!theme && !phrase) return;
    if (!theme || !phrase || !/^[a-z]{2}$/.test(country)) {
      if (problems.length < 20) problems.push(`строка ${i + 2}: нет темы, ключа или кода страны`);
      return;
    }
    const key = `${theme.toLowerCase()}|${country}`;
    const c = map.get(key) ?? { id: get(r, "cluster") || String(map.size + 1), theme, themeRu: get(r, "theme_ru"), themeVolume: num(get(r, "theme_volume")), projects: [], country, keywords: [] };
    const role = get(r, "role").toLowerCase();
    const isTheme = role === "тема" || role === "theme" || phrase.toLowerCase() === theme.toLowerCase();
    const kd = get(r, "keyword_difficulty");
    const kw: EmdKeyword = {
      phrase,
      ru: get(r, "ru"),
      volume: num(get(r, "search_volume")),
      theme: isTheme,
      kd: kd === "" ? null : num(kd),
      trend: get(r, "trend"),
      smallSites: num(get(r, "small_sites_count")),
      smallTlds: parseSmallTlds(get(r, "small_tlds")),
      officialInTop: /^(true|1|да|yes)$/i.test(get(r, "official_in_top")),
    };
    const same = c.keywords.find((k) => k.phrase.toLowerCase() === phrase.toLowerCase());
    if (same) { if (kw.volume > same.volume) Object.assign(same, kw); }
    else c.keywords.push(kw);
    c.themeVolume = Math.max(c.themeVolume, num(get(r, "theme_volume")));
    const project = get(r, "project_name");
    if (project && !c.projects.includes(project)) c.projects.push(project);
    map.set(key, c);
  });
  const clusters = Array.from(map.values());
  for (const c of clusters) c.keywords.sort((a, b) => Number(b.theme) - Number(a.theme) || b.volume - a.volume);
  // Сильные кластеры — первыми: общий .com одного ключа в разных странах достаётся кластеру с большей частотой
  clusters.sort((a, b) => b.themeVolume - a.themeVolume);
  return { clusters, problems };
}

/** Мягкая проверка кластера, прочитанного из настроек подбора. */
export function normalizeEmdCluster(raw: unknown): EmdCluster | undefined {
  const c = raw as Partial<EmdCluster> | null;
  if (!c || typeof c !== "object" || !Array.isArray(c.keywords)) return undefined;
  return {
    id: String(c.id ?? ""),
    theme: String(c.theme ?? ""),
    themeRu: String(c.themeRu ?? ""),
    themeVolume: Number(c.themeVolume) || 0,
    projects: Array.isArray(c.projects) ? c.projects.map(String) : [],
    keywords: (c.keywords as EmdKeyword[]).filter((k) => k && typeof k.phrase === "string").map((k) => ({
      ...k,
      volume: Number(k.volume) || 0,
      smallSites: Number(k.smallSites) || 0,
      smallTlds: Array.isArray(k.smallTlds) ? k.smallTlds : [],
      ...(Array.isArray(k.top10) ? { top10: k.top10 } : {}),
    })),
    ...(c.serpAt ? { serpAt: String(c.serpAt) } : {}),
    ...(c.serpCostUsd ? { serpCostUsd: Number(c.serpCostUsd) } : {}),
  };
}

/* ---------- Совпадение ключа с доменом ---------- */

/** Сколько процентов ключа есть в домене (0–100). Слова-связки весят мало, окончание множественного числа прощается. */
export function emdMatch(domain: string, phrase: string, country = ""): number {
  const host = domain.toLowerCase().replace(/^www\./, "");
  const zone = tldOf(host);
  const s = host.slice(0, Math.max(0, host.length - zone.length - 1)).replace(/[.-]/g, "");
  if (!s) return 0;
  let best = 0;
  for (const umlaut of UMLAUT_AE.has(country) ? [false, true] : [false]) {
    const words = phraseWords(phrase, umlaut);
    let total = 0;
    let found = 0;
    for (const w of words) {
      const weight = (FILLER.has(w) ? 0.3 : 1) * w.length;
      total += weight;
      const hit = s.includes(w) || (w.length >= 5 && s.includes(w.slice(0, -1))) || (w.length >= 7 && s.includes(w.slice(0, -2)));
      if (hit) found += weight;
    }
    if (total) best = Math.max(best, Math.round((found / total) * 100));
  }
  return best;
}

/* ---------- Кандидаты ---------- */

export type EmdZoneKind = "cctld" | "com" | "common" | "table" | "serp";
export const EMD_ZONE_LABELS: Record<EmdZoneKind, string> = { cctld: "зона страны", com: ".com", common: "общая", table: "маленькие сайты в топе", serp: "EMD в выдаче" };
const ZONE_WEIGHT: Record<EmdZoneKind, number> = { cctld: 1, com: 1, table: 0.8, serp: 0.8, common: 0.6 };
const SERP_ZONES_MAX = 6;
/** Приписки ставим к стольким лучшим основам и в столько первых зон */
const MOD_CORES = 6;
const MOD_ZONES = 3;
const KEYWORD_MODS_MAX = 12;
/** Доля вариантов без приписок в лимите кластера; остаток — приписки (недобор одной части отдаётся другой) */
const PLAIN_SHARE = 0.6;

/** Ключи кластера, из которых строим домены: тема всегда, остальные — от порога частоты. */
export function eligibleKeywords(c: EmdCluster, minVolume: number): EmdKeyword[] {
  return c.keywords.filter((k) => k.theme || k.volume >= minVolume);
}

/** Зоны кластера с источником: общие зоны формы, зона страны, зоны маленьких сайтов из выдачи и зоны EMD-доменов TOP-10. */
export function emdZones(c: EmdCluster, country: string, s: { tlds: string[]; autoZones: boolean; matchPct: number }): Array<{ tld: string; kind: EmdZoneKind; detail: string }> {
  const out: Array<{ tld: string; kind: EmdZoneKind; detail: string }> = [];
  const add = (raw: string, kind: EmdZoneKind, detail: string) => {
    const tld = normalizeTld(raw);
    if (tld && !out.some((z) => z.tld === tld)) out.push({ tld, kind, detail });
  };
  const own = countryTld(country);
  if (own) add(own, "cctld", `зона страны ${country.toUpperCase()}`);
  if (country === "gb") add("co.uk", "cctld", "зона страны GB");
  for (const t of s.tlds) add(t, t === "com" ? "com" : "common", "общие зоны формы");
  if (s.autoZones) {
    const small = new Map<string, number>();
    for (const k of c.keywords) for (const [t, n] of k.smallTlds) small.set(t, (small.get(t) ?? 0) + n);
    for (const [t, n] of [...small.entries()].sort((a, b) => b[1] - a[1])) add(t, "table", `маленькие сайты в топе: ${n}`);
    const serp = new Map<string, number>();
    for (const k of c.keywords) for (const e of k.top10 ?? []) if ((e.match ?? 0) >= s.matchPct) serp.set(tldOf(e.domain), (serp.get(tldOf(e.domain)) ?? 0) + 1);
    for (const [t, n] of [...serp.entries()].sort((a, b) => b[1] - a[1]).slice(0, SERP_ZONES_MAX)) add(t, "serp", `доменов с ключом в TOP-10: ${n}`);
  }
  return out;
}

export type EmdCandidate = {
  domain: string; tld: string; label: string;
  /** Ключ-источник; у вариантов с припиской — «ключ + приписка» */
  keyword: string;
  volume: number; pattern: EmdPattern; zone: EmdZoneKind; weight: number;
  /** Уровень основы: 1 точный, 2 вариация, 3 из выдачи */
  tier: EmdLevel;
  mod?: string;
};

/** Основа домена (метка без зоны) с уровнем и ключом-источником. */
export type EmdCore = { label: string; pattern: EmdPattern; level: EmdLevel; keyword: string; volume: number; weight: number };

/** Ед./мн. число: casino ↔ casinos и т. п. */
const PLURAL: Record<string, string> = {
  casino: "casinos", kasino: "kasinos", slot: "slots", game: "games", bet: "bets", bonus: "bonuses", spin: "spins",
  site: "sites", bookmaker: "bookmakers", casinos: "casino", kasinos: "kasino", slots: "slot", games: "game", bets: "bet",
  bonuses: "bonus", spins: "spin", sites: "site", bookmakers: "bookmaker", casinot: "casino", kasinot: "kasino",
};
/** Общие слова, без которых основа остаётся осмысленной: «casino zonder cruks» → zondercruks */
const GENERIC = new Set(["casino", "casinos", "kasino", "kasinos", "kasinot", "casinot", "online", "onlinecasino", "spielothek"]);
const YEAR = /^(19|20)\d\d$/;

/** Основы кластера по уровням: точный ключ → вариации ключа → метки EMD-доменов из выдачи. */
export function emdCores(c: EmdCluster, country: string, s: { allowHyphen: boolean; minVolume: number; maxLen: number; matchPct: number; variations: boolean; serpVariants: boolean }): EmdCore[] {
  const out = new Map<string, EmdCore>();
  const add = (label: string, pattern: EmdPattern, level: EmdLevel, k: EmdKeyword) => {
    if (!validLabel(label, s.maxLen) || out.has(label)) return;
    out.set(label, { label, pattern, level, keyword: k.phrase, volume: k.volume, weight: Math.round(Math.max(k.volume, 10) * PATTERN_WEIGHT[pattern]) });
  };
  const eligible = eligibleKeywords(c, s.minVolume);
  // 1. Точный ключ
  for (const k of eligible) {
    const words = phraseWords(k.phrase);
    if (!words.length) continue;
    add(words.join(""), "emd", 1, k);
    if (UMLAUT_AE.has(country) && /[äöü]/i.test(k.phrase)) add(phraseWords(k.phrase, true).join(""), "emd-translit", 1, k);
    if (s.allowHyphen && words.length >= 2) add(words.join("-"), "emd-hyphen", 1, k);
  }
  // 2. Вариации ключа
  if (s.variations) {
    for (const k of eligible) {
      const words = phraseWords(k.phrase);
      const content = words.filter((w) => !FILLER.has(w) && !YEAR.test(w));
      if (!content.length) continue;
      if (content.length < words.length) add(content.join(""), "emd-short", 2, k);
      const plural = content.map((w) => PLURAL[w] ?? w);
      if (plural.join("") !== content.join("")) add(plural.join(""), "emd-plural", 2, k);
      const core = content.filter((w) => !GENERIC.has(w));
      if (core.length && core.length < content.length && core.join("").length >= 6) add(core.join(""), "emd-core", 2, k);
      // Перестановка: общее слово (casino) переезжает в другой конец, смысловая часть остаётся в своём порядке —
      // «casino zonder cruks» → zondercrukscasino, но не crukszondercasino
      const gen = content.filter((w) => GENERIC.has(w));
      if (core.length && gen.length) {
        for (const g of [gen, gen.map((w) => PLURAL[w] ?? w)]) {
          add([...core, ...g].join(""), "emd-perm", 2, k);
          add([...g, ...core].join(""), "emd-perm", 2, k);
        }
      }
    }
    // Ключи из таблицы ниже порога частоты — тоже вариации ключа
    for (const k of c.keywords) if (!eligible.includes(k)) {
      const words = phraseWords(k.phrase).filter((w) => !YEAR.test(w));
      if (words.length) add(words.join(""), "emd-list", 2, k);
    }
  }
  // 3. Из выдачи: метки доменов TOP-10, где ключа не меньше порога
  if (s.serpVariants) {
    for (const k of c.keywords) for (const e of k.top10 ?? []) {
      if ((e.match ?? 0) < s.matchPct) continue;
      const host = e.domain.toLowerCase().replace(/^www\./, "");
      const zone = tldOf(host);
      const label = host.slice(0, Math.max(0, host.length - zone.length - 1)).split(".").pop() ?? "";
      add(label, "emd-serp", 3, k);
    }
  }
  return Array.from(out.values()).sort((a, b) => a.level - b.level || b.weight - a.weight);
}

export type EmdModifier = { mod: string; pos: "end" | "start"; source: "keyword" | "geo" | "form"; score: number };
export const EMD_MOD_SOURCE_LABELS: Record<EmdModifier["source"], string> = { keyword: "из ключей", geo: "гео", form: "свои" };

/**
 * Приписки кластера. Из ключей: слова, которых нет в теме (beste casino zonder cruks → beste, в начале),
 * вес — сумма частот ключей. Гео — код страны и alpha-3 в конце. Свои — из формы.
 */
export function emdModifiers(c: EmdCluster, country: string, s: { keywordMods: boolean; geoMods: boolean; suffixes: string[]; prefixes: string[] }): EmdModifier[] {
  const out: EmdModifier[] = [];
  const has = (mod: string, pos: string) => out.some((m) => m.mod === mod && m.pos === pos);
  const clean = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  for (const raw of s.suffixes) { const m = clean(raw); if (m && !has(m, "end")) out.push({ mod: m, pos: "end", source: "form", score: Infinity }); }
  for (const raw of s.prefixes) { const m = clean(raw); if (m && !has(m, "start")) out.push({ mod: m, pos: "start", source: "form", score: Infinity }); }
  if (s.geoMods) for (const g of casinoGeoCodes(country)) if (!has(g, "end")) out.push({ mod: g, pos: "end", source: "geo", score: 0 });
  if (s.keywordMods) {
    const themeWords = new Set<string>();
    for (const w of phraseWords(c.theme)) { themeWords.add(w); if (PLURAL[w]) themeWords.add(PLURAL[w]!); }
    const must = phraseWords(c.theme).filter((w) => !FILLER.has(w) && !YEAR.test(w));
    const found = new Map<string, EmdModifier>();
    for (const k of c.keywords) {
      const words = phraseWords(k.phrase);
      // Приписка — только из ключа, где тема целиком: «gokken zonder cruks» — это замена casino, а не приписка
      if (!must.every((w) => words.includes(w) || (PLURAL[w] !== undefined && words.includes(PLURAL[w]!)))) continue;
      const first = words.findIndex((w) => themeWords.has(w));
      if (first < 0) continue;
      words.forEach((w, i) => {
        if (themeWords.has(w) || FILLER.has(w) || YEAR.test(w) || w.length < 2 || w.length > 12) return;
        const pos: "end" | "start" = i < first ? "start" : "end";
        const key = `${pos}:${w}`;
        const prev = found.get(key);
        found.set(key, { mod: w, pos, source: "keyword", score: (prev?.score ?? 0) + Math.max(k.volume, 1) });
      });
    }
    for (const m of [...found.values()].sort((a, b) => b.score - a.score).slice(0, KEYWORD_MODS_MAX)) if (!has(m.mod, m.pos)) out.push(m);
  }
  return out;
}

/** Вес домена: вес основы × зона × длина. */
function zoneLenWeight(base: number, zone: EmdZoneKind, labelLen: number): number {
  const len = labelLen <= 15 ? 1 : Math.max(0.6, 1 - (labelLen - 15) * 0.02);
  return Math.round(base * ZONE_WEIGHT[zone] * len);
}

export type EmdCandidateSettings = { tlds: string[]; autoZones: boolean; allowHyphen: boolean } & Omit<EmdSettings, "sourceUrl" | "fileName" | "loadedAt">;

/**
 * Домены кластера: основы всех уровней во всех зонах + лучшие основы с приписками в первых зонах.
 * В лимит кластера идёт ~60% без приписок и ~40% с приписками; итог — по убыванию веса.
 */
export function emdCandidates(c: EmdCluster, country: string, s: EmdCandidateSettings): EmdCandidate[] {
  const zones = emdZones(c, country, s);
  const cores = emdCores(c, country, s);
  const plain = new Map<string, EmdCandidate>();
  for (const core of cores) for (const z of zones) {
    const domain = `${core.label}.${z.tld}`;
    if (!plain.has(domain)) plain.set(domain, { domain, tld: z.tld, label: core.label, keyword: core.keyword, volume: core.volume, pattern: core.pattern, zone: z.kind, weight: zoneLenWeight(core.weight, z.kind, core.label.length), tier: core.level });
  }
  const mods = emdModifiers(c, country, s);
  const withMod = new Map<string, EmdCandidate>();
  const modBases = cores.filter((x) => !x.label.includes("-") && x.pattern !== "emd-list").slice(0, MOD_CORES);
  for (const core of modBases) for (const m of mods) {
    const srcW = m.source === "geo" ? 0.9 : 1;
    const labels: Array<[string, EmdPattern]> = m.pos === "end"
      ? [[`${core.label}${m.mod}`, "emd-mod"], ...(s.allowHyphen ? [[`${core.label}-${m.mod}`, "emd-mod-hyphen"] as [string, EmdPattern]] : [])]
      : [[`${m.mod}${core.label}`, "emd-mod"], ...(s.allowHyphen ? [[`${m.mod}-${core.label}`, "emd-mod-hyphen"] as [string, EmdPattern]] : [])];
    for (const [label, pattern] of labels) {
      if (!validLabel(label, s.maxLen)) continue;
      for (const z of zones.slice(0, MOD_ZONES)) {
        // zondercruksnl.nl — гео дважды, не берём
        if (m.source === "geo" && z.kind === "cctld") continue;
        const domain = `${label}.${z.tld}`;
        if (plain.has(domain) || withMod.has(domain)) continue;
        const base = Math.max(core.volume, 10) * PATTERN_WEIGHT[pattern] * srcW;
        withMod.set(domain, { domain, tld: z.tld, label, keyword: `${core.keyword} + ${m.mod}`, volume: core.volume, pattern, zone: z.kind, weight: zoneLenWeight(base, z.kind, label.length), tier: core.level, mod: m.mod });
      }
    }
  }
  const byWeight = (a: EmdCandidate, b: EmdCandidate) => b.weight - a.weight;
  const a = Array.from(plain.values()).sort(byWeight);
  const b = Array.from(withMod.values()).sort(byWeight);
  const cap = Math.max(1, s.maxPerCluster);
  let takeA = Math.min(a.length, Math.ceil(cap * PLAIN_SHARE));
  const takeB = Math.min(b.length, cap - takeA);
  takeA = Math.min(a.length, cap - takeB);
  return [...a.slice(0, takeA), ...b.slice(0, takeB)].sort(byWeight);
}

/** Ключ-источник из колонки suffix: «casino zonder cruks + beste» → «casino zonder cruks». */
export const emdSourceKeyword = (suffix: string | null) => (suffix ?? "").split(" + ")[0] ?? "";
