/**
 * ИИ-отбор доменов под бренд: модель выбирает кандидатов с наибольшим шансом занять TOP-1 по бренд-запросу.
 * Вызов через прокси портала (слот text_main сервиса «Подбор доменов»), ответ строго JSON.
 */
import { resolveSlot, runSlot } from "@/lib/run";
import { parseJsonLenient } from "@/lib/pins/ai/json";
import { LIMITS, PROJECT_SLUG, SLOT_AI } from "./types";

export type AiCandidate = { domain: string; suffix: string | null; tier: number; pattern: string };
export type AiPick = { domain: string; score: number; reason: string };
export type RankInput = {
  brand: string;
  /** Сколько доменов нужно выбрать */
  take: number;
  countryCode?: string;
  keyword?: string;
  candidates: AiCandidate[];
  topDomains: string[];
};

const SYSTEM = "Ты SEO-эксперт по доменам для брендового трафика. Отвечаешь только валидным JSON без пояснений.";

export function buildPrompt(input: RankInput): string {
  const list = input.candidates
    .slice(0, LIMITS.aiCandidates)
    .map((c, i) => `${i + 1}. ${c.domain} | приставка: ${c.suffix ?? "нет"} | приоритет приставки: ${c.tier > 0 ? c.tier : "—"} | шаблон: ${c.pattern || "—"}`)
    .join("\n");
  const n = Math.min(input.take, input.candidates.length);
  return [
    `Бренд: ${input.brand}`,
    input.countryCode ? `Регион продвижения: ${input.countryCode.toUpperCase()}` : "",
    input.keyword ? `Ключевое слово: ${input.keyword}` : "",
    input.topDomains.length > 0 ? `Домены конкурентов из Google TOP-10:\n${input.topDomains.slice(0, 50).join("\n")}` : "",
    "",
    "Кандидаты (все свободны к регистрации):",
    list,
    "",
    `Выбери ровно ${n} доменов с наибольшим шансом занять TOP-1 в Google по бренд-запросу.`,
    "Критерии: точное и чистое вхождение бренда, короткая и запоминающаяся метка, релевантная гео-приставка для региона (приоритет 1 важнее 2 и 3), совпадение с паттернами конкурентов из ТОП-10, доверие доменной зоны (локальная ccTLD или .com выше), отсутствие лишних символов и опечаточного вида.",
    'Ответ строго JSON: {"picks":[{"domain":"...","score":0-100,"reason":"кратко по-русски, до 120 символов"}]}. Домены бери только из списка кандидатов, без повторов, по убыванию score.',
  ]
    .filter(Boolean)
    .join("\n");
}

export type RankResult = { picks: AiPick[]; note: string | null; costUsd: number | null; model: string | null };

export async function rankDomainsWithAi(ctx: { userId: string; teamId?: string | null; refId?: string }, input: RankInput): Promise<RankResult> {
  const resolved = await resolveSlot(ctx.userId, PROJECT_SLUG, SLOT_AI);
  if (!resolved.ok) throw new Error(resolved.status === 409 ? "ИИ не подключён к сервису «Подбор доменов»: откройте страницу ключа ИИ и отметьте этот сервис." : resolved.error);
  const res = await runSlot({
    userId: ctx.userId,
    projectSlug: PROJECT_SLUG,
    slotKey: SLOT_AI,
    payload: {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(input) },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    timeoutMs: 120_000,
    meta: { teamId: ctx.teamId ?? undefined, refId: ctx.refId },
    pre: resolved.value,
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error("ИИ перегружен или исчерпан лимит ключа, попробуйте через минуту.");
    if (res.status === 402) throw new Error("Закончились кредиты ИИ — пополните баланс у провайдера.");
    throw new Error(`ИИ вернул ошибку: ${res.error ?? `HTTP ${res.status}`}`);
  }
  const data = res.data as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
  const raw = data?.choices?.[0]?.message?.content;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((p) => p?.text ?? "").join("") : "";
  const parsed = parseJsonLenient<{ picks?: Array<Partial<AiPick>> }>(text) ?? {};
  const allowed = new Set(input.candidates.map((c) => c.domain));
  const seen = new Set<string>();
  const picks: AiPick[] = [];
  for (const p of parsed.picks ?? []) {
    const domain = String(p?.domain ?? "").trim().toLowerCase();
    if (!allowed.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    picks.push({ domain, score: Math.max(0, Math.min(100, Math.round(Number(p?.score) || 0))), reason: String(p?.reason ?? "").slice(0, 200) });
    if (picks.length >= input.take) break;
  }
  return { picks, note: picks.length === 0 ? "ИИ не вернул подходящих вариантов" : null, costUsd: res.meta?.costUsd ?? null, model: res.meta?.model ?? null };
}
