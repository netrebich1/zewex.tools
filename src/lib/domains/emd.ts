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
};

export const EMD_DEFAULTS: Omit<EmdSettings, "sourceUrl" | "fileName" | "loadedAt"> = { minVolume: 300, maxLen: 30, matchPct: 60 };

export type EmdPattern = "emd" | "emd-short" | "emd-translit" | "emd-hyphen";

export const EMD_PATTERN_LABELS: Record<EmdPattern, string> = {
  emd: "точный",
  "emd-short": "без связок",
  "emd-translit": "транслит",
  "emd-hyphen": "дефис",
};
const PATTERN_WEIGHT: Record<EmdPattern, number> = { emd: 1, "emd-translit": 0.95, "emd-short": 0.85, "emd-hyphen": 0.6 };

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

export type EmdCandidate = { domain: string; tld: string; label: string; keyword: string; volume: number; pattern: EmdPattern; zone: EmdZoneKind; weight: number; tier: number };

/** Метки домена из ключа: слитно, без связок, транслитом (ä → ae), через дефис. */
export function emdLabels(phrase: string, country: string, opts: { allowHyphen: boolean; maxLen: number }): Array<{ label: string; pattern: EmdPattern }> {
  const out: Array<{ label: string; pattern: EmdPattern }> = [];
  const add = (label: string, pattern: EmdPattern) => {
    if (validLabel(label, opts.maxLen) && !out.some((x) => x.label === label)) out.push({ label, pattern });
  };
  const words = phraseWords(phrase);
  if (!words.length) return out;
  add(words.join(""), "emd");
  if (UMLAUT_AE.has(country) && /[äöü]/i.test(phrase)) add(phraseWords(phrase, true).join(""), "emd-translit");
  const short = words.filter((w) => !FILLER.has(w));
  if (short.length && short.length < words.length) add(short.join(""), "emd-short");
  if (opts.allowHyphen && words.length >= 2) add(words.join("-"), "emd-hyphen");
  return out;
}

/** Вес домена для порядка проверки и рекомендаций: частота × точность × зона × длина. */
export function emdWeight(volume: number, pattern: EmdPattern, zone: EmdZoneKind, labelLen: number): number {
  const len = labelLen <= 15 ? 1 : Math.max(0.6, 1 - (labelLen - 15) * 0.02);
  return Math.round(Math.max(volume, 10) * PATTERN_WEIGHT[pattern] * ZONE_WEIGHT[zone] * len);
}

/** Все домены кластера по убыванию веса. tier: 1 — из темы, 2 — из ключа темы. */
export function emdCandidates(c: EmdCluster, country: string, s: { tlds: string[]; autoZones: boolean; allowHyphen: boolean; minVolume: number; maxLen: number; matchPct: number }): EmdCandidate[] {
  const zones = emdZones(c, country, s);
  const byDomain = new Map<string, EmdCandidate>();
  for (const k of eligibleKeywords(c, s.minVolume)) {
    for (const { label, pattern } of emdLabels(k.phrase, country, s)) {
      for (const z of zones) {
        const domain = `${label}.${z.tld}`;
        const cand: EmdCandidate = { domain, tld: z.tld, label, keyword: k.phrase, volume: k.volume, pattern, zone: z.kind, weight: emdWeight(k.volume, pattern, z.kind, label.length), tier: k.theme ? 1 : 2 };
        const prev = byDomain.get(domain);
        if (!prev || cand.weight > prev.weight) byDomain.set(domain, cand);
      }
    }
  }
  return Array.from(byDomain.values()).sort((a, b) => b.weight - a.weight);
}
