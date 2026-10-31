/**
 * Ключевые слова бренда → модификаторы для доменов (winzoria + bonus, winzoria + freespins).
 * Источники (DataForSEO, слот serp_dfs): запросы с брендом и частотой (Labs keyword_suggestions),
 * подсказки Google (autocomplete), «похожие запросы» и домены конкурентов из TOP-10.
 * Затем дешёвая модель (OpenRouter, слот text_main с заменой модели) решает, какие слова годятся аффилиату:
 * «вывод средств», «поддержка», «жалобы» и т.п. отбрасываются.
 */
import { runSlot, type ResolvedSlot } from "@/lib/run";
import { resolveDomainsSlot } from "./keyTeam";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { brandWords, cleanSuffix, isThemeWord, sanitizeLabel } from "./generator";
import { domainHasBrand, mineSuffixes, tldOf } from "./mining";
import { getCountry, isGeoSuffix, LIMITS, PROJECT_SLUG, SLOT_AI, SLOT_SERP_DFS, type ResearchSourceKind } from "./types";

/** Самая дешёвая модель, которой хватает на классификацию слов. */
export const RESEARCH_MODEL = "openrouter:google/gemini-2.5-flash-lite";

export type ResearchSource = ResearchSourceKind;

export type ResearchModifier = {
  /** Как слово пойдёт в домен (a-z0-9) */
  suffix: string;
  /** Исходное слово/фраза из запросов */
  word: string;
  volume: number;
  count: number;
  query: string;
  sources: ResearchSource[];
  keep: boolean;
  tier: 1 | 2 | 3;
  reason: string;
};

export type BrandResearch = {
  brand: string;
  country: string;
  modifiers: ResearchModifier[];
  queries: number;
  /** Домены TOP-10 с брендом и их зоны — подсказка, какие зоны добавить */
  competitorDomains: string[];
  tlds: Array<{ value: string; count: number }>;
  errors: string[];
  costUsd: number;
};

type Ctx = { userId: string; teamId?: string | null };
type Query = { q: string; volume: number; source: ResearchSource };

const STOP = new Set([
  "the", "a", "an", "for", "in", "on", "and", "with", "to", "is", "how", "what", "of", "my", "me", "at", "or", "vs", "com", "www", "http", "https",
  "de", "het", "een", "van", "voor", "op", "en", "met", "bij", "te", "is", "wat", "hoe",
  "la", "el", "los", "las", "y", "para", "con", "que", "como", "del", "por",
  "der", "die", "das", "und", "mit", "fur", "ist", "wie", "im", "zu", "von",
  "le", "les", "des", "du", "et", "pour", "avec", "au", "aux", "sur",
  // «no» не стоп-слово: no deposit → nodeposit
  "il", "di", "da", "per", "lo", "gli", "e", "do", "dos", "em", "i", "w", "z", "na",
]);

async function dfs(ctx: Ctx, pre: ResolvedSlot, endpoint: string, body: unknown[]): Promise<{ ok: boolean; data: unknown; error?: string; cost: number }> {
  const res = await runSlot({ userId: ctx.userId, projectSlug: PROJECT_SLUG, slotKey: SLOT_SERP_DFS, payload: { endpoint, body }, timeoutMs: 90_000, meta: { teamId: ctx.teamId ?? undefined }, pre });
  const cost = res.meta?.costUsd ?? 0;
  if (!res.ok) return { ok: false, data: null, error: res.error ?? `HTTP ${res.status}`, cost };
  const task = (res.data as { tasks?: Array<{ status_code?: number; status_message?: string }> })?.tasks?.[0];
  if (!task || (task.status_code && task.status_code !== 20000)) return { ok: false, data: null, error: task?.status_message ?? "пустой ответ", cost };
  return { ok: true, data: task, cost };
}

type Task<T> = { result?: Array<T> };

/** Запросы с брендом и частотой. */
async function keywordSuggestions(ctx: Ctx, pre: ResolvedSlot, brand: string, loc: number, lang: string) {
  const r = await dfs(ctx, pre, "dataforseo_labs/google/keyword_suggestions/live", [{ keyword: brand, location_code: loc, language_code: lang, limit: 200, include_seed_keyword: false, order_by: ["keyword_info.search_volume,desc"] }]);
  const items = r.ok ? ((r.data as Task<{ items?: Array<{ keyword?: string; keyword_info?: { search_volume?: number | null } }> }>).result?.[0]?.items ?? []) : [];
  return { ...r, queries: items.map((i) => ({ q: String(i.keyword ?? ""), volume: Number(i.keyword_info?.search_volume) || 0, source: "keywords" as const })) };
}

/** Подсказки Google по бренду. */
async function autocomplete(ctx: Ctx, pre: ResolvedSlot, brand: string, loc: number, lang: string) {
  const r = await dfs(ctx, pre, "serp/google/autocomplete/live/advanced", [{ keyword: `${brand} `, location_code: loc, language_code: lang }]);
  const items = r.ok ? ((r.data as Task<{ items?: Array<{ suggestion?: string }> }>).result?.[0]?.items ?? []) : [];
  return { ...r, queries: items.map((i) => ({ q: String(i.suggestion ?? ""), volume: 0, source: "autocomplete" as const })) };
}

/** TOP-10: домены конкурентов с брендом и «похожие запросы». */
async function serp(ctx: Ctx, pre: ResolvedSlot, brand: string, loc: number, lang: string) {
  const r = await dfs(ctx, pre, "serp/google/organic/live/advanced", [{ keyword: brand, location_code: loc, language_code: lang, depth: 10 }]);
  type Item = { type?: string; domain?: string; items?: Array<string | { title?: string }> };
  const items = r.ok ? ((r.data as Task<{ items?: Item[] }>).result?.[0]?.items ?? []) : [];
  const domains: string[] = [];
  const related: Query[] = [];
  for (const it of items) {
    if (it.type === "organic" && it.domain) {
      const d = it.domain.toLowerCase().replace(/^www\./, "");
      if (!domains.includes(d)) domains.push(d);
    }
    if (it.type === "related_searches" || it.type === "people_also_search") {
      for (const x of it.items ?? []) {
        const q = typeof x === "string" ? x : x?.title ?? "";
        if (q) related.push({ q, volume: 0, source: "related" });
      }
    }
  }
  return { ...r, domains, queries: related };
}

/** Остаток запроса после бренда → слова-кандидаты (по одному и склейкой из двух: free spins → freespins). */
export function extractModifiers(brand: string, queries: Query[]): Map<string, Omit<ResearchModifier, "keep" | "tier" | "reason">> {
  const words = brandWords(brand);
  const distinctive = words.filter((w) => !isThemeWord(w));
  const need = distinctive.length ? distinctive : words;
  const glued = words.join("");
  const out = new Map<string, Omit<ResearchModifier, "keep" | "tier" | "reason">>();
  const best = new Map<string, number>();
  const add = (word: string, q: Query) => {
    const suffix = cleanSuffix(word);
    if (suffix.length < 2 || suffix.length > 16 || (/^\d+$/.test(suffix) && suffix.length > 3)) return;
    if (words.includes(suffix) || suffix === glued) return;
    const e = out.get(suffix) ?? { suffix, word, volume: 0, count: 0, query: q.q, sources: [] };
    e.volume += q.volume;
    e.count += 1;
    if (!e.sources.includes(q.source)) e.sources.push(q.source);
    // Пример — самый частотный запрос со словом
    if (q.volume > (best.get(suffix) ?? -1)) {
      best.set(suffix, q.volume);
      e.query = q.q;
    }
    out.set(suffix, e);
  };
  for (const q of queries) {
    let text = ` ${sanitizeLabel(q.q).replace(/-/g, " ")} `;
    const flat = text.replace(/\s+/g, "");
    if (!need.every((w) => flat.includes(w))) continue;
    text = text.replace(new RegExp(`\\s${glued}\\s`, "g"), " ");
    for (const w of words) text = text.replace(new RegExp(`\\s${w}\\s`, "g"), " ");
    const rest = text.split(/\s+/).filter((t) => t && !STOP.has(t) && !words.includes(t));
    if (!rest.length || rest.length > 4) continue;
    // Одиночные слова из 1–2 букв (no, de, is) — обрывки фраз, а не приставки; гео-коды страны берутся из гео-базы
    for (const t of rest) if (t.length >= 3) add(t, q);
    // Соседние пары — фразы вида free spins, no deposit, bonus code; хвост из 1–2 букв (casino no) не берём
    for (let k = 0; k + 1 < rest.length; k++) if (rest[k + 1]!.length >= 3) add(rest[k]! + rest[k + 1]!, q);
  }
  return out;
}

const SYSTEM = "Ты отбираешь слова-модификаторы для доменов партнёрского (аффилиатного) сайта онлайн-казино под брендовый трафик. Отвечаешь только валидным JSON.";

function classifyPrompt(brand: string, countryName: string, lang: string, list: Array<{ suffix: string; word: string; volume: number; count: number }>): string {
  return [
    `Бренд казино: ${brand}`,
    `Страна: ${countryName}, язык выдачи: ${lang}`,
    "",
    "Слова, которые люди добавляют к бренду в поиске (слово | частота в месяц | сколько раз встретилось):",
    ...list.map((m) => `${m.word} | ${m.volume} | ${m.count}`),
    "",
    "Мы аффилиат: домен вида бренд+слово (winzoria-bonus.com) должен звучать как сильный партнёрский запрос игрока, который выбирает казино.",
    "Оставляй (keep=true) только яркие аффилиатные слова: casino/casinos, bonus, bonus code/promo code, free spins, no deposit, review/ervaringen/opiniones, app, slots, online, play, live, sport/bet, официальный сайт, гео (страна, язык, город).",
    "Отбрасывай (keep=false): вывод средств/withdrawal/uitbetaling, поддержка/контакты/телефон/адрес, жалобы/scam/мошенничество/обман, удаление аккаунта, верификация/KYC, лицензия/блокировка/проблемы, вакансии, владелец, другие бренды казино, опечатки бренда, имена людей, бессмысленные и слишком общие слова (de, is, what), слишком длинные фразы.",
    "login/inloggen/вход — keep=true, но tier 3.",
    "tier: 1 — гео (страна, язык, город); 2 — сильные тематические и коммерческие слова (casino, bonus, freespins, slots, review); 3 — допустимые, но слабее (app, online, login, live).",
    "label — как слово пишется в домене: латиница a-z и цифры, без пробелов и дефисов, без диакритики, до 16 символов (free spins → freespins, opiniones → opiniones).",
    'Ответ строго JSON: {"items":[{"word":"...","keep":true,"tier":2,"label":"...","reason":"до 60 символов по-русски"}]} — по одному элементу на каждое слово из списка.',
  ].join("\n");
}

function heuristicTier(suffix: string, country: string): 1 | 2 | 3 {
  if (isGeoSuffix(suffix, country)) return 1;
  if (isThemeWord(suffix) || ["bonus", "freespins", "promocode", "bonuscode", "nodeposit", "review", "slots"].includes(suffix)) return 2;
  return 3;
}

/** ИИ-фильтр модификаторов; при сбое — эвристика (все оставлены, уровни по словарю). */
async function classify(ctx: Ctx, brand: string, country: string, list: Array<Omit<ResearchModifier, "keep" | "tier" | "reason">>): Promise<{ items: ResearchModifier[]; cost: number; error: string | null }> {
  const fallback = (reason: string) => list.map((m) => ({ ...m, keep: true, tier: heuristicTier(m.suffix, country), reason }));
  if (!list.length) return { items: [], cost: 0, error: null };
  const resolved = await resolveDomainsSlot(ctx.userId, SLOT_AI);
  if (!resolved.ok) return { items: fallback("ИИ не подключён — проверьте вручную"), cost: 0, error: `ИИ: ${resolved.error} Слова не отфильтрованы.` };
  const c = getCountry(country);
  const res = await runSlot({
    userId: ctx.userId,
    projectSlug: PROJECT_SLUG,
    slotKey: SLOT_AI,
    model: RESEARCH_MODEL,
    payload: { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: classifyPrompt(brand, c?.name ?? country, c?.languageCode ?? "en", list) }], temperature: 0, response_format: { type: "json_object" } },
    timeoutMs: 90_000,
    meta: { teamId: ctx.teamId ?? undefined },
    pre: resolved.value,
  });
  const cost = res.meta?.costUsd ?? 0;
  if (!res.ok) return { items: fallback("ИИ не ответил — проверьте вручную"), cost, error: `ИИ: ${res.error ?? `HTTP ${res.status}`}` };
  const data = res.data as { choices?: Array<{ message?: { content?: string } }> };
  const parsed = parseJsonLenient<{ items?: Array<{ word?: string; keep?: boolean; tier?: number; label?: string; reason?: string }> }>(String(data?.choices?.[0]?.message?.content ?? "")) ?? {};
  const byWord = new Map((parsed.items ?? []).map((x) => [String(x.word ?? "").trim().toLowerCase(), x]));
  const items: ResearchModifier[] = [];
  const used = new Set<string>();
  for (const m of list) {
    const v = byWord.get(m.word.toLowerCase()) ?? byWord.get(m.suffix);
    const label = cleanSuffix(String(v?.label ?? "")) || m.suffix;
    const suffix = label.length >= 2 && label.length <= 16 ? label : m.suffix;
    if (used.has(suffix)) continue;
    used.add(suffix);
    const tier = v?.tier === 1 || v?.tier === 2 || v?.tier === 3 ? v.tier : heuristicTier(suffix, country);
    items.push({ ...m, suffix, keep: v ? v.keep === true : false, tier, reason: v ? String(v.reason ?? "").slice(0, 120) : "ИИ пропустил слово" });
  }
  return { items, cost, error: null };
}

/** Исследование одного бренда в его стране. */
export async function researchBrand(ctx: Ctx, brand: string, country: string, opts: { useAi: boolean }): Promise<BrandResearch> {
  const out: BrandResearch = { brand, country, modifiers: [], queries: 0, competitorDomains: [], tlds: [], errors: [], costUsd: 0 };
  const c = getCountry(country);
  if (!c) {
    out.errors.push(`Страна «${country}» не найдена`);
    return out;
  }
  const pre = await resolveDomainsSlot(ctx.userId, SLOT_SERP_DFS);
  if (!pre.ok) {
    out.errors.push("DataForSEO не подключён к «Подбору доменов»: откройте страницу ключа и отметьте сервис.");
    return out;
  }
  const [kw, ac, sp] = await Promise.all([
    keywordSuggestions(ctx, pre.value, brand, c.locationCode, c.languageCode),
    autocomplete(ctx, pre.value, brand, c.locationCode, c.languageCode),
    serp(ctx, pre.value, brand, c.locationCode, c.languageCode),
  ]);
  out.costUsd += kw.cost + ac.cost + sp.cost;
  if (!kw.ok) out.errors.push(`Запросы с частотой: ${kw.error}`);
  if (!ac.ok) out.errors.push(`Подсказки Google: ${ac.error}`);
  if (!sp.ok) out.errors.push(`Выдача: ${sp.error}`);

  const queries = [...kw.queries, ...ac.queries, ...sp.queries].filter((q) => q.q);
  out.queries = queries.length;
  const mods = extractModifiers(brand, queries);

  out.competitorDomains = sp.domains.filter((d) => domainHasBrand(d, [brand]));
  const tl = new Map<string, number>();
  for (const d of out.competitorDomains) tl.set(tldOf(d), (tl.get(tldOf(d)) ?? 0) + 1);
  out.tlds = Array.from(tl.entries()).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  for (const m of mineSuffixes(out.competitorDomains, [brand])) {
    const e = mods.get(m.suffix) ?? { suffix: m.suffix, word: m.suffix, volume: 0, count: 0, query: m.examples[0] ?? "", sources: [] as ResearchSource[] };
    e.count += m.count;
    if (!e.sources.includes("competitors")) e.sources.push("competitors");
    mods.set(m.suffix, e);
  }

  const list = Array.from(mods.values()).sort((a, b) => b.volume - a.volume || b.count - a.count).slice(0, LIMITS.modifiersPerBrand + 20);
  if (opts.useAi) {
    const r = await classify(ctx, brand, country, list);
    out.costUsd += r.cost;
    if (r.error) out.errors.push(r.error);
    out.modifiers = r.items;
  } else {
    out.modifiers = list.map((m) => ({ ...m, keep: true, tier: heuristicTier(m.suffix, country), reason: "без ИИ" }));
  }
  out.modifiers.sort((a, b) => Number(b.keep) - Number(a.keep) || a.tier - b.tier || b.volume - a.volume || b.count - a.count);
  out.modifiers = out.modifiers.slice(0, LIMITS.modifiersPerBrand + 20);
  return out;
}
