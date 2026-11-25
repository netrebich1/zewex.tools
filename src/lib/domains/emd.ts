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
import { countryTld, geoTiers } from "./geo";
import { normalizeTld } from "./generator";
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
  /** Дополнительные ключи темы: запросы с частотой, подсказки и «похожие запросы» Google (как в основной версии) */
  found?: EmdFound[];
  foundAt?: string;
  foundCostUsd?: number;
  foundError?: string;
};

export type EmdFound = { phrase: string; volume: number; source: "keywords" | "autocomplete" | "related" };

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
  /** Гео в конце основы: уровни 1–3 страны, как в подборе под бренды (nl, nederland / netherlands / nld, holland…) */
  geoMods: boolean;
  /** Свои приписки: в конце и в начале основы */
  suffixes: string[];
  prefixes: string[];
  /** Искать дополнительные ключи темы (DataForSEO: запросы с частотой и подсказки) */
  findKeywords: boolean;
  /** Зоны, добавленные второй пачкой из карточки подбора */
  extraZones: string[];
  /** Зоны, которые воркер сейчас проверяет второй пачкой */
  pendingZones: string[];
};

export const EMD_DEFAULTS: Omit<EmdSettings, "sourceUrl" | "fileName" | "loadedAt"> = {
  minVolume: 300, maxLen: 30, matchPct: 60, maxPerCluster: 600,
  variations: true, serpVariants: true, keywordMods: true, geoMods: true, suffixes: [], prefixes: [],
  findKeywords: true, extraZones: [], pendingZones: [],
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
    findKeywords: bool(e.findKeywords, false),
    extraZones: list(e.extraZones),
    pendingZones: list(e.pendingZones),
  };
}

export type EmdPattern =
  | "emd" | "emd-translit" | "emd-hyphen"
  | "emd-short" | "emd-perm" | "emd-plural" | "emd-core" | "emd-swap" | "emd-list" | "emd-found"
  | "emd-serp"
  | "emd-mod" | "emd-mod-hyphen"
  | "emd-geo" | "emd-geo-hyphen";

export const EMD_PATTERN_LABELS: Record<EmdPattern, string> = {
  emd: "точный",
  "emd-translit": "транслит",
  "emd-hyphen": "дефис",
  "emd-short": "без связок",
  "emd-perm": "перестановка",
  "emd-plural": "ед./мн. число",
  "emd-core": "без casino",
  "emd-swap": "casino ↔ kasino",
  "emd-list": "ключ ниже порога",
  "emd-found": "найденный ключ",
  "emd-serp": "из выдачи",
  "emd-mod": "приписка",
  "emd-mod-hyphen": "приписка, дефис",
  "emd-geo": "гео",
  "emd-geo-hyphen": "гео, дефис",
};
const PATTERN_WEIGHT: Record<EmdPattern, number> = {
  emd: 1, "emd-translit": 0.95, "emd-short": 0.85, "emd-list": 0.8, "emd-found": 0.75, "emd-plural": 0.75, "emd-perm": 0.7, "emd-core": 0.7, "emd-swap": 0.65,
  "emd-serp": 0.65, "emd-hyphen": 0.6, "emd-mod": 0.45, "emd-mod-hyphen": 0.3, "emd-geo": 0.45, "emd-geo-hyphen": 0.3,
};

/**
 * Группа основы (колонка tier): 1 — тема точно, 2 — вариации темы, 3 — ключи таблицы точно (и ниже порога),
 * 4 — вариации ключей таблицы, 5 — найденные ключи (DataForSEO, подсказки, похожие запросы), 6 — основы из выдачи.
 * Приписки и гео — отдельные вкладки по шаблону (emd-mod*, emd-geo*), tier у них — группа основы.
 */
export type EmdLevel = 1 | 2 | 3 | 4 | 5 | 6;
export const EMD_LEVEL_LABELS: Record<EmdLevel, string> = { 1: "Тема точно", 2: "Вариации темы", 3: "Ключи таблицы", 4: "Вариации ключей", 5: "Найденные ключи", 6: "Из выдачи" };
export const isModPattern = (p: string) => p.startsWith("emd-mod");
export const isGeoPattern = (p: string) => p.startsWith("emd-geo");

/** Гео страны по уровням (как в подборе под бренды): [[nl, nederland], [netherlands], [nld, holland, dutch…]] */
export function emdGeo(country: string): Array<{ mod: string; tier: 1 | 2 | 3 }> {
  const t = geoTiers(country);
  const out: Array<{ mod: string; tier: 1 | 2 | 3 }> = [];
  t.forEach((list, i) => { for (const m of list) if (!out.some((x) => x.mod === m)) out.push({ mod: m, tier: (i + 1) as 1 | 2 | 3 }); });
  return out;
}

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
    ...(Array.isArray(c.found) ? { found: (c.found as EmdFound[]).filter((f) => f && typeof f.phrase === "string").map((f) => ({ phrase: f.phrase, volume: Number(f.volume) || 0, source: f.source })) } : {}),
    ...(c.foundAt ? { foundAt: String(c.foundAt) } : {}),
    ...(c.foundCostUsd ? { foundCostUsd: Number(c.foundCostUsd) } : {}),
    ...(c.foundError ? { foundError: String(c.foundError) } : {}),
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
/** Приписки и гео ставим к стольким лучшим основам и в столько первых зон */
const MOD_CORES = 6;
const MOD_ZONES = 3;
const KEYWORD_MODS_MAX = 12;

/** Ключи кластера, из которых строим домены: тема всегда, остальные — от порога частоты. */
export function eligibleKeywords(c: EmdCluster, minVolume: number): EmdKeyword[] {
  return c.keywords.filter((k) => k.theme || k.volume >= minVolume);
}

/** Зоны кластера с источником: общие зоны формы, зона страны, зоны маленьких сайтов из выдачи и зоны EMD-доменов TOP-10. */
export function emdZones(c: EmdCluster, country: string, s: { tlds: string[]; autoZones: boolean; matchPct: number; extraZones?: string[] }): Array<{ tld: string; kind: EmdZoneKind; detail: string }> {
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
  for (const t of s.extraZones ?? []) add(t, "common", "добавлена второй пачкой");
  return out;
}

/**
 * Зоны, которые есть в выдаче и у маленьких сайтов таблицы, но ещё не проверялись: подсказка для второй пачки.
 * hits — доменов с ключом от порога в этой зоне (сильный сигнал), all — всех доменов TOP-10 в зоне.
 */
export function emdZoneSuggestions(items: Array<{ country: string; emd?: EmdCluster }>, s: { tlds: string[]; autoZones: boolean; matchPct: number; extraZones?: string[]; pendingZones?: string[] }): Array<{ tld: string; all: number; hits: number; small: number; clusters: number }> {
  const used = new Set<string>([...(s.pendingZones ?? [])]);
  const stat = new Map<string, { tld: string; all: number; hits: number; small: number; clusters: Set<string> }>();
  for (const it of items) {
    const c = it.emd;
    if (!c) continue;
    for (const z of emdZones(c, it.country, s)) used.add(z.tld);
    const bump = (tld: string, f: "all" | "hits" | "small", n = 1) => {
      const e = stat.get(tld) ?? { tld, all: 0, hits: 0, small: 0, clusters: new Set<string>() };
      e[f] += n;
      e.clusters.add(c.id + it.country);
      stat.set(tld, e);
    };
    for (const k of c.keywords) {
      for (const e of k.top10 ?? []) { const t = tldOf(e.domain); bump(t, "all"); if ((e.match ?? 0) >= s.matchPct) bump(t, "hits"); }
      for (const [t, n] of k.smallTlds) bump(normalizeTld(t), "small", n);
    }
  }
  return [...stat.values()]
    .filter((e) => e.tld && !used.has(e.tld))
    .map((e) => ({ tld: e.tld, all: e.all, hits: e.hits, small: e.small, clusters: e.clusters.size }))
    .sort((a, b) => b.hits - a.hits || b.small - a.small || b.all - a.all)
    .slice(0, 30);
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

/** Ед./мн. число общих слов; у некоторых стран своя форма (SE casinon, FI kasinot, DK/NO casinoer). */
const PLURAL: Record<string, string[]> = {
  casino: ["casinos"], casinos: ["casino"], kasino: ["kasinos"], kasinos: ["kasino"], slot: ["slots"], slots: ["slot"],
  game: ["games"], games: ["game"], bet: ["bets"], bets: ["bet"], bonus: ["bonuses"], bonuses: ["bonus"], spin: ["spins"], spins: ["spin"],
  site: ["sites"], sites: ["site"], bookmaker: ["bookmakers"], bookmakers: ["bookmaker"],
};
const PLURAL_BY_COUNTRY: Record<string, Record<string, string[]>> = {
  se: { casino: ["casinon"], casinon: ["casino"], kasino: ["kasinon"], kasinon: ["kasino"], spelbolag: ["spelbolagen"] },
  fi: { kasino: ["kasinot"], kasinot: ["kasino"], casino: ["casinot"], casinot: ["casino"] },
  dk: { casino: ["casinoer"], casinoer: ["casino"] },
  no: { casino: ["casinoer"], casinoer: ["casino"] },
  de: { spielothek: ["spielotheken"], spielotheken: ["spielothek"] },
};
function pluralForms(w: string, country: string): string[] {
  return Array.from(new Set([...(PLURAL_BY_COUNTRY[country]?.[w] ?? []), ...(PLURAL[w] ?? [])]));
}
/** Страны, где рядом с casino в запросах встречается kasino */
const KASINO_COUNTRIES = new Set(["se", "fi", "no", "dk", "de", "at", "ch", "pl", "cz", "sk", "ee", "lt", "lv", "hr", "si", "hu", "rs", "ba"]);
/** Общие слова, без которых основа остаётся осмысленной: «casino zonder cruks» → zondercruks */
const GENERIC = new Set(["casino", "casinos", "casinon", "casinot", "casinoer", "kasino", "kasinos", "kasinon", "kasinot", "online", "onlinecasino", "spielothek", "spielotheken"]);
const YEAR = /^(19|20)\d\d$/;
/** Слова, которые не годятся в приписку */
const JUNK = new Set(["reddit", "flashback", "forum", "wiki", "wikipedia", "youtube", "facebook", "twitter", "instagram", "pdf", "apk", "yahoo", "google", "bing", "trustpilot", "quora", "that", "take", "takes", "which", "who", "where", "when", "why", "are", "can", "does", "list", "ten", "zijn", "toekomst", "omtrent"]);
const MONTHS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "januari", "februari", "maart", "mei", "juni", "juli", "augustus", "oktober",
  "mars", "augusti", "januar", "februar", "marz", "dezember", "oktober", "tammikuu", "joulukuu",
]);
/** Слова-адреса: запрос с ними — навигационный (www antoncasinos com), в ключи и приписки не берём */
const WEB = new Set(["www", "com", "net", "org", "http", "https", "html"]);
/** Слово похоже на бренд/сайт: casino внутри чужого слова (antoncasinos, casinonisse) */
const brandish = (w: string, own: Set<string>) => /casino|kasino/.test(w) && !GENERIC.has(w) && !own.has(w);

/** Найденный запрос годится: без адресов, брендов-сайтов, мусора, не длиннее 5 слов. */
function usableQuery(words: string[], own: Set<string>): boolean {
  return words.length > 0 && words.length <= 5 && !words.some((w) => WEB.has(w) || JUNK.has(w) || brandish(w, own));
}
function themeOwnWords(theme: string, country: string): Set<string> {
  const own = new Set<string>();
  for (const w of phraseWords(theme)) { own.add(w); for (const f of pluralForms(w, country)) own.add(f); }
  return own;
}
/** Найденные ключи после фильтра (фильтр применяется и к уже собранным в старых подборах). */
export function usableFound(c: EmdCluster, country: string): EmdFound[] {
  const own = themeOwnWords(c.theme, country);
  return (c.found ?? []).filter((f) => usableQuery(phraseWords(f.phrase), own));
}
export const MOD_STOP = new Set([
  "the", "a", "an", "for", "in", "on", "and", "with", "to", "is", "how", "what", "of", "my", "me", "at", "or", "vs", "com", "www",
  "de", "het", "een", "van", "voor", "op", "en", "met", "bij", "te", "wat", "hoe", "la", "el", "los", "las", "y", "para", "con", "que", "como", "del", "por",
  "der", "die", "das", "und", "mit", "fur", "ist", "wie", "im", "zu", "von", "le", "les", "des", "du", "et", "pour", "avec", "au", "aux", "sur",
  "il", "di", "da", "per", "lo", "gli", "e", "do", "dos", "em", "i", "w", "z", "na", "och", "med", "som", "pa", "ja", "ilman", "og", "pa", "uden", "uten",
]);

/**
 * Вариации одного ключа: без связок, ед./мн. число, casino ↔ kasino, без casino, casino в другом конце.
 * Смысловая часть (zonder cruks) не переставляется: crukszondercasino — не вариант.
 */
function keywordVariants(phrase: string, country: string): Array<{ label: string; pattern: EmdPattern; words: string[] }> {
  const out: Array<{ label: string; pattern: EmdPattern; words: string[] }> = [];
  const add = (words: string[], pattern: EmdPattern) => { const label = words.join(""); if (label && !out.some((x) => x.label === label)) out.push({ label, pattern, words }); };
  const words = phraseWords(phrase);
  const content = words.filter((w) => !FILLER.has(w) && !YEAR.test(w));
  if (!content.length) return out;
  if (content.length < words.length) add(content, "emd-short");
  // Ед./мн. число: каждое слово по очереди и все сразу
  content.forEach((w, i) => { for (const f of pluralForms(w, country)) add(content.map((x, j) => (j === i ? f : x)), "emd-plural"); });
  // casino ↔ kasino
  if (KASINO_COUNTRIES.has(country)) {
    const swapped = content.map((w) => (w.startsWith("casino") ? `k${w.slice(1)}` : w.startsWith("kasino") ? `c${w.slice(1)}` : w));
    if (swapped.join("") !== content.join("")) add(swapped, "emd-swap");
  }
  const core = content.filter((w) => !GENERIC.has(w));
  const gen = content.filter((w) => GENERIC.has(w));
  if (core.length && gen.length && core.join("").length >= 6) add(core, "emd-core");
  if (core.length && gen.length) {
    const forms = [gen, ...gen.flatMap((g, i) => pluralForms(g, country).map((f) => gen.map((x, j) => (j === i ? f : x))))];
    for (const g of forms) { add([...core, ...g], "emd-perm"); add([...g, ...core], "emd-perm"); }
  }
  return out;
}

/** Основы кластера по группам: точный ключ → вариации темы → вариации ключей (+ найденные) → метки EMD-доменов из выдачи. */
export function emdCores(c: EmdCluster, country: string, s: { allowHyphen: boolean; minVolume: number; maxLen: number; matchPct: number; variations: boolean; serpVariants: boolean }): EmdCore[] {
  const out = new Map<string, EmdCore>();
  const add = (label: string, pattern: EmdPattern, level: EmdLevel, phrase: string, volume: number) => {
    if (!validLabel(label, s.maxLen) || out.has(label)) return;
    out.set(label, { label, pattern, level, keyword: phrase, volume, weight: Math.round(Math.max(volume, 10) * PATTERN_WEIGHT[pattern]) });
  };
  const eligible = eligibleKeywords(c, s.minVolume);
  const exact = (phrase: string, volume: number, level: EmdLevel, pattern: EmdPattern = "emd") => {
    const words = phraseWords(phrase).filter((w) => !YEAR.test(w));
    if (!words.length) return;
    add(words.join(""), pattern, level, phrase, volume);
    if (UMLAUT_AE.has(country) && /[äöü]/i.test(phrase)) add(phraseWords(phrase, true).filter((w) => !YEAR.test(w)).join(""), "emd-translit", level, phrase, volume);
    if (s.allowHyphen && words.length >= 2) add(words.join("-"), "emd-hyphen", level, phrase, volume);
  };
  const themes = eligible.filter((x) => x.theme);
  const others = c.keywords.filter((x) => !x.theme);
  // 1. Тема точно
  for (const k of themes) exact(k.phrase, k.volume, 1);
  // 2. Вариации темы (и через дефис)
  if (s.variations) for (const k of themes) for (const v of keywordVariants(k.phrase, country)) {
    add(v.label, v.pattern, 2, k.phrase, k.volume);
    if (s.allowHyphen && v.words.length >= 2) add(v.words.join("-"), "emd-hyphen", 2, k.phrase, k.volume);
  }
  // 3. Ключи таблицы точно: от порога — как есть, ниже порога — «ключ ниже порога»
  for (const k of others) exact(k.phrase, k.volume, 3, eligible.includes(k) ? "emd" : "emd-list");
  // 4. Вариации ключей таблицы (от порога)
  if (s.variations) for (const k of others.filter((x) => eligible.includes(x))) for (const v of keywordVariants(k.phrase, country)) add(v.label, v.pattern, 4, k.phrase, k.volume);
  // 5. Найденные ключи точно
  for (const f of usableFound(c, country)) exact(f.phrase, f.volume, 5, "emd-found");
  // 6. Из выдачи: метки доменов TOP-10, где ключа не меньше порога
  if (s.serpVariants) {
    for (const k of c.keywords) for (const e of k.top10 ?? []) {
      if ((e.match ?? 0) < s.matchPct) continue;
      const host = e.domain.toLowerCase().replace(/^www\./, "");
      const zone = tldOf(host);
      const label = host.slice(0, Math.max(0, host.length - zone.length - 1)).split(".").pop() ?? "";
      add(label, "emd-serp", 6, k.phrase, k.volume);
    }
  }
  return Array.from(out.values()).sort((a, b) => a.level - b.level || b.weight - a.weight);
}

/** Найденные ключи кластера: запросы, где есть смысловая часть темы (без casino и связок). */
export function filterFound(theme: string, country: string, queries: EmdFound[], existing: string[], max = 25): EmdFound[] {
  const words = phraseWords(theme).filter((w) => !FILLER.has(w) && !YEAR.test(w));
  const core = words.filter((w) => !GENERIC.has(w));
  const need = core.length ? core : words;
  const has = (list: string[], w: string) => list.includes(w) || pluralForms(w, country).some((f) => list.includes(f));
  const seen = new Set(existing.map((e) => phraseWords(e).join(" ")));
  const own = themeOwnWords(theme, country);
  const out = new Map<string, EmdFound>();
  for (const q of queries) {
    const qw = phraseWords(q.phrase);
    const key = qw.join(" ");
    if (!usableQuery(qw, own) || seen.has(key) || !need.every((w) => has(qw, w))) continue;
    const prev = out.get(key);
    if (!prev || q.volume > prev.volume) out.set(key, { ...q, phrase: q.phrase.toLowerCase().trim() });
  }
  return [...out.values()].sort((a, b) => b.volume - a.volume).slice(0, max);
}

export type EmdModifier = { mod: string; pos: "end" | "start"; source: "keyword" | "found" | "form"; score: number; example?: string };
export const EMD_MOD_SOURCE_LABELS: Record<EmdModifier["source"], string> = { keyword: "из ключей таблицы", found: "из найденных ключей", form: "свои" };

/**
 * Приписки кластера. Из ключей таблицы и найденных ключей: слова сверх темы
 * (beste casino zonder cruks → beste в начале), вес — сумма частот. Гео — код страны и alpha-3 в конце. Свои — из формы.
 */
export function emdModifiers(c: EmdCluster, country: string, s: { keywordMods: boolean; suffixes: string[]; prefixes: string[] }): EmdModifier[] {
  const out: EmdModifier[] = [];
  const has = (mod: string, pos: string) => out.some((m) => m.mod === mod && m.pos === pos);
  const clean = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
  for (const raw of s.suffixes) { const m = clean(raw); if (m && !has(m, "end")) out.push({ mod: m, pos: "end", source: "form", score: Infinity }); }
  for (const raw of s.prefixes) { const m = clean(raw); if (m && !has(m, "start")) out.push({ mod: m, pos: "start", source: "form", score: Infinity }); }
  if (s.keywordMods) {
    const themeAll = phraseWords(c.theme);
    const themeWords = new Set<string>();
    for (const w of themeAll) { themeWords.add(w); for (const f of pluralForms(w, country)) themeWords.add(f); }
    if (KASINO_COUNTRIES.has(country)) for (const w of [...themeWords]) if (w.startsWith("casino")) themeWords.add(`k${w.slice(1)}`);
    // В ключе должна быть вся смысловая часть темы; casino может быть заменено на kasino/множественное
    const must = themeAll.filter((w) => !FILLER.has(w) && !YEAR.test(w) && !GENERIC.has(w));
    const geoWords = new Set(emdGeo(country).map((g) => g.mod));
    const found = new Map<string, EmdModifier>();
    const take = (phrase: string, volume: number, source: "keyword" | "found") => {
      const words = phraseWords(phrase);
      if (!must.every((w) => words.includes(w) || pluralForms(w, country).some((f) => words.includes(f)))) return;
      const first = words.findIndex((w) => themeWords.has(w));
      if (first < 0) return;
      if (!usableQuery(words, themeWords)) return;
      const extraIdx = words.map((w, i) => (themeWords.has(w) || FILLER.has(w) || MOD_STOP.has(w) || YEAR.test(w) ? -1 : i)).filter((i) => i >= 0);
      if (!extraIdx.length || extraIdx.length > 2) return;
      const put = (mod: string, i: number) => {
        if (mod.length < 3 || mod.length > 16 || /^\d+$/.test(mod) || geoWords.has(mod) || MONTHS.has(mod) || JUNK.has(mod)) return;
        const pos: "end" | "start" = i < first ? "start" : "end";
        const key = `${pos}:${mod}`;
        const prev = found.get(key);
        found.set(key, { mod, pos, source: prev?.source === "keyword" ? "keyword" : source, score: (prev?.score ?? 0) + Math.max(volume, 1), example: prev && prev.score >= volume ? prev.example : phrase });
      };
      // Два слова рядом — одна приписка: no deposit → nodeposit, snabba uttag → snabbauttag
      if (extraIdx.length === 2 && extraIdx[1]! === extraIdx[0]! + 1) put(words[extraIdx[0]!]! + words[extraIdx[1]!]!, extraIdx[0]!);
      for (const i of extraIdx) if (words[i]!.length >= 3) put(words[i]!, i);
    };
    for (const k of c.keywords) take(k.phrase, k.volume, "keyword");
    for (const f of usableFound(c, country)) take(f.phrase, f.volume, "found");
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
export function emdCandidates(c: EmdCluster, country: string, s: EmdCandidateSettings, onlyZones?: string[]): EmdCandidate[] {
  // Вторая пачка: те же основы и приписки, но только в новых зонах
  const zones = onlyZones?.length ? onlyZones.map((tld) => ({ tld, kind: "common" as EmdZoneKind, detail: "вторая пачка" })) : emdZones(c, country, s);
  const cores = emdCores(c, country, s);
  const plain = new Map<string, EmdCandidate>();
  for (const core of cores) for (const z of zones) {
    const domain = `${core.label}.${z.tld}`;
    if (!plain.has(domain)) plain.set(domain, { domain, tld: z.tld, label: core.label, keyword: core.keyword, volume: core.volume, pattern: core.pattern, zone: z.kind, weight: zoneLenWeight(core.weight, z.kind, core.label.length), tier: core.level });
  }
  const mods = emdModifiers(c, country, s);
  const geo = s.geoMods ? emdGeo(country) : [];
  const withMod = new Map<string, EmdCandidate>();
  const withGeo = new Map<string, EmdCandidate>();
  // Приписки и гео — к лучшим основам темы (точно и вариации), затем к лучшим ключам
  const modBases = cores.filter((x) => !x.label.includes("-") && x.pattern !== "emd-list" && x.level !== 6).slice(0, MOD_CORES);
  const push = (bucket: Map<string, EmdCandidate>, core: EmdCore, mod: string, pos: "end" | "start", joined: EmdPattern, hyphen: EmdPattern, factor: number, skipZone: (z: { tld: string; kind: EmdZoneKind }) => boolean) => {
    const labels: Array<[string, EmdPattern]> = pos === "end"
      ? [[`${core.label}${mod}`, joined], ...(s.allowHyphen ? [[`${core.label}-${mod}`, hyphen] as [string, EmdPattern]] : [])]
      : [[`${mod}${core.label}`, joined], ...(s.allowHyphen ? [[`${mod}-${core.label}`, hyphen] as [string, EmdPattern]] : [])];
    for (const [label, pattern] of labels) {
      if (!validLabel(label, s.maxLen)) continue;
      for (const z of zones.slice(0, MOD_ZONES)) {
        if (skipZone(z)) continue;
        const domain = `${label}.${z.tld}`;
        if (plain.has(domain) || withMod.has(domain) || withGeo.has(domain)) continue;
        const base = Math.max(core.volume, 10) * PATTERN_WEIGHT[pattern] * factor;
        bucket.set(domain, { domain, tld: z.tld, label, keyword: `${core.keyword} + ${mod}`, volume: core.volume, pattern, zone: z.kind, weight: zoneLenWeight(base, z.kind, label.length), tier: core.level, mod });
      }
    }
  };
  for (const core of modBases) for (const m of mods) push(withMod, core, m.mod, m.pos, "emd-mod", "emd-mod-hyphen", 1, () => false);
  // Гео: уровень 1 весит больше; короткий код страны в зоне страны (zondercruksnl.nl) не берём
  for (const core of modBases) for (const g of geo) push(withGeo, core, g.mod, "end", "emd-geo", "emd-geo-hyphen", g.tier === 1 ? 1 : g.tier === 2 ? 0.85 : 0.7, (z) => z.tld === g.mod || (z.kind === "cctld" && g.mod.length <= 3));
  const byWeight = (a: EmdCandidate, b: EmdCandidate) => b.weight - a.weight;
  // Лимит кластера: половина — без приписок, по четверти — приписки и гео; недобор одной корзины отдаётся другим
  const buckets = [Array.from(plain.values()).sort(byWeight), Array.from(withMod.values()).sort(byWeight), Array.from(withGeo.values()).sort(byWeight)];
  const cap = Math.max(1, s.maxPerCluster);
  const quota = [Math.ceil(cap * 0.5), Math.floor(cap * 0.25), Math.floor(cap * 0.25)];
  const take = buckets.map((b, i) => Math.min(b.length, quota[i]!));
  let left = cap - take.reduce((x, y) => x + y, 0);
  for (let i = 0; i < 3 && left > 0; i++) { const more = Math.min(left, buckets[i]!.length - take[i]!); take[i]! += more; left -= more; }
  return buckets.flatMap((b, i) => b.slice(0, take[i])).sort(byWeight);
}

/** Ключ-источник из колонки suffix: «casino zonder cruks + beste» → «casino zonder cruks». */
export const emdSourceKeyword = (suffix: string | null) => (suffix ?? "").split(" + ")[0] ?? "";
