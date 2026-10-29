import { disableKey, resolveSlot, runSlot } from "@/lib/run";
import { classifyAiError } from "@/lib/pins/ai/errors";
import { CATEGORIES, PROJECT_SLUG, SLOT_CLASSIFY, SLOT_EMBED } from "./types";
import { normalize } from "./vec";

/**
 * Вызовы ИИ модуля через прокси портала (resolveSlot → runSlot → UsageLog с refId = id прогона).
 * Расход списывается с ключей команды проекта (teamId), модели — из настроек проекта или правила слота.
 */

export type AiCtx = { userId: string; teamId: string; runId: string; classifyModel?: string; embedModel?: string; onCost: (usd: number) => void };

export class NewsAiError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
  }
}

async function call(ctx: AiCtx, slotKey: string, payload: Record<string, unknown>, model: string | undefined, timeoutMs: number) {
  const r = await resolveSlot(ctx.userId, PROJECT_SLUG, slotKey, ctx.teamId);
  if (!r.ok) throw new NewsAiError(r.error, true);
  const res = await runSlot({ userId: ctx.userId, projectSlug: PROJECT_SLUG, slotKey, payload, model: model || undefined, timeoutMs, meta: { teamId: ctx.teamId, refId: ctx.runId }, pre: r.value });
  if (res.meta?.costUsd) ctx.onCost(res.meta.costUsd);
  if (!res.ok) {
    const cls = classifyAiError(res.status, res.error ?? "");
    if (cls.kind === "fatal_run" && (cls.code === "no_credits" || cls.code === "auth")) {
      await disableKey(r.value.binding.apiKey.id, `Автоотключён: ${cls.code === "no_credits" ? "закончился баланс" : "ключ отклонён провайдером"} (${cls.message.slice(0, 120)})`);
      throw new NewsAiError(`Ключ «${r.value.binding.apiKey.label}»: ${cls.message}`, true);
    }
    throw new NewsAiError(res.error ?? `HTTP ${res.status}`, cls.kind === "fatal_run");
  }
  return res.data;
}

/** Чат с ответом JSON (слот и модель — по задаче). Ответ не JSON — ошибка, которую можно повторить. */
export async function chatJson(ctx: AiCtx, slotKey: string, system: string, user: string, model: string | undefined, maxTokens = 3000, timeoutMs = 120_000, temperature = 0.4): Promise<Record<string, unknown>> {
  const data = (await call(
    ctx,
    slotKey,
    { messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature, response_format: { type: "json_object" }, reasoning: { effort: "none" }, max_tokens: maxTokens },
    model,
    timeoutMs,
  )) as { choices?: { message?: { content?: string } }[] };
  const text = data?.choices?.[0]?.message?.content ?? "";
  try {
    const v = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* ниже */
  }
  throw new NewsAiError("ответ модели не JSON — попробуйте ещё раз", false);
}

/** Эмбеддинги пачками по 64 текста; векторы нормированы. */
export async function embedTexts(ctx: AiCtx, texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const part = texts.slice(i, i + 64).map((t) => t.slice(0, 1200));
    const data = (await call(ctx, SLOT_EMBED, { input: part }, ctx.embedModel, 60_000)) as { data?: { embedding?: number[]; index?: number }[] };
    const rows = [...(data?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== part.length) throw new NewsAiError(`Эмбеддинги: пришло ${rows.length} из ${part.length}`, false);
    for (const r of rows) out.push(normalize(r.embedding ?? []));
  }
  return out;
}

export type ClassifyInput = { id: string; title: string; lead: string; domain: string };
export type ClassifyOutput = {
  id: string;
  category: string;
  subcategory: string;
  entities: { name: string; orig: string; type: string; role: string }[];
  sensitive: boolean;
  visual: number;
  isNews: boolean;
  hasPriceUa: boolean;
  /** Что вернула модель до приведения к списку (для журнала причины). */
  rawCategory: string;
};

const CAT_SYNONYMS: [RegExp, string][] = [
  [/^celeb|^звезд|^зірк|^знаменит|^шоу/, "celebrity"],
  [/^fashion|^мод|^стил|^образ/, "fashion"],
  [/^beaut|^красот|^краса|^б['’]?ю?ті|^бьюти|^макия|^макія/, "beauty"],
  [/^brand|^бренд|^новин|^product/, "brands"],
  [/^self|^уход|^догляд|^здоров/, "selfcare"],
  [/^event|^собы|^поді|^преми|^премі/, "events"],
  [/^relation|^отнош|^стосун|^love|^wedding/, "relationships"],
  [/^other|^друг|^інш|^не наш/, "other"],
];

/** Категория модели → одна из списка; нераспознанная — "unknown" (материал классифицируется повторно). */
export function normalizeCategory(raw: string): string {
  const c = raw.toLowerCase().trim();
  if ((CATEGORIES as readonly string[]).includes(c)) return c;
  for (const [re, cat] of CAT_SYNONYMS) if (re.test(c)) return cat;
  return "unknown";
}

const SYSTEM = `Ты редактор украинского женского медиа о знаменитостях, моде и красоте ({site}).
Для каждого материала по его id определи:
1. category: одно из ${CATEGORIES.join(" | ")}.
   celebrity — новости о людях шоу-бизнеса; fashion — одежда, образы, показы; beauty — макияж, волосы, ногти, уход; brands — коллекции, дропы, коллаборации, новинки косметики и парфюмерии, выход бренда в Украину;
   selfcare — здоровье и уход за собой без медицинских обещаний; events — премии, фестивали, недели моды; relationships — отношения, свадьбы, дети звёзд;
   other — всё остальное: война, политика, экономика, спорт, криминал, происшествия, быт, сад, рецепты, гороскопы, техника.
   Правила: образ, наряд, цена вещей звезды → fashion; цвет волос, стрижка, макияж, процедуры звезды → beauty; любой материал о конкретной знаменитости шоу-бизнеса → celebrity (а не other);
   спортсмен — other, кроме его жены/подруги и светской жизни. Поле category пиши строго одним английским словом из списка.
2. subcategory: короткая фраза по-русски («образ на красной дорожке», «маникюр», «развод»).
3. entities: [{name, orig, type: person|brand|event|trend|product, role: main|secondary}] — name по-украински, orig — оригинальное написание (латиница для иностранных), не больше 5.
4. sensitive: true, если тема про смерть, тяжёлую болезнь, насилие, войну, криминал, детей.
5. visual: 1–5, насколько новость «картиночная» (образ, фото с события, коллекция — 4–5; заявление без визуала — 1–2).
6. is_news: true, если это событие, а не вечнозелёная статья или подборка советов.
7. has_price_ua: true, если указана цена в гривнах или дата начала продаж в Украине.
Верни только JSON: {"items":[{"id":"…","category":"…","subcategory":"…","entities":[…],"sensitive":false,"visual":3,"is_news":true,"has_price_ua":false}]}`;

/** Классификация пачки до 10 материалов одним вызовом. */
export async function classifyBatch(ctx: AiCtx, site: string, items: ClassifyInput[]): Promise<ClassifyOutput[]> {
  const user = JSON.stringify(items.map((it) => ({ id: it.id, source: it.domain, title: it.title, text: it.lead.slice(0, 1500) })));
  const data = (await call(
    ctx,
    SLOT_CLASSIFY,
    { messages: [{ role: "system", content: SYSTEM.replace("{site}", site) }, { role: "user", content: user }], temperature: 0, response_format: { type: "json_object" }, reasoning: { effort: "none" }, max_tokens: 3000 },
    ctx.classifyModel,
    120_000,
  )) as { choices?: { message?: { content?: string } }[] };
  const text = data?.choices?.[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new NewsAiError("Классификация: ответ модели не JSON", false);
  }
  const arr = Array.isArray((parsed as { items?: unknown })?.items) ? ((parsed as { items: unknown[] }).items) : Array.isArray(parsed) ? (parsed as unknown[]) : [];
  const out: ClassifyOutput[] = [];
  for (const raw of arr) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? "");
    if (!items.some((it) => it.id === id)) continue;
    const rawCat = String(r.category ?? "").trim();
    out.push({
      id,
      category: normalizeCategory(rawCat),
      rawCategory: rawCat,
      subcategory: String(r.subcategory ?? "").slice(0, 120),
      entities: (Array.isArray(r.entities) ? r.entities : []).slice(0, 6).map((e) => {
        const x = (e ?? {}) as Record<string, unknown>;
        return { name: String(x.name ?? "").slice(0, 120), orig: String(x.orig ?? "").slice(0, 120), type: String(x.type ?? "person"), role: String(x.role ?? "secondary") };
      }).filter((e) => e.name || e.orig),
      sensitive: r.sensitive === true,
      visual: Math.max(1, Math.min(5, Math.round(Number(r.visual) || 2))),
      isNews: r.is_news !== false,
      hasPriceUa: r.has_price_ua === true,
    });
  }
  return out;
}
