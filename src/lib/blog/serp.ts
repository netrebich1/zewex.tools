/**
 * Поисковая выдача для исследования темы (необязательно, `params.research.serp`): SerpApi Google organic через слот
 * `serp_organic` — People Also Ask, заголовки и сниппеты топа. Без ключа или при ошибке — пусто, этап идёт без выдачи.
 */
import { serpRequest, type AiCtx } from "./ai";

export type SerpBrief = { questions: string[]; titles: string[]; snippets: string[]; error?: string };

export async function fetchSerpBrief(ctx: AiCtx, keyword: string, country: string, language: string): Promise<SerpBrief> {
  const out: SerpBrief = { questions: [], titles: [], snippets: [] };
  try {
    const res = await serpRequest(ctx, { engine: "google", q: keyword, gl: country.toLowerCase(), hl: language.slice(0, 2), num: 10 }, "serp_organic", 45_000);
    if (!res.ok) { out.error = `SerpApi ${res.status}: ${String(res.error || "").slice(0, 160)}`; return out; }
    const d = (res.data || {}) as { related_questions?: Array<{ question?: string }>; organic_results?: Array<{ title?: string; snippet?: string }>; people_also_ask?: Array<{ question?: string }> };
    for (const q of [...(d.related_questions ?? []), ...(d.people_also_ask ?? [])]) {
      const t = String(q?.question ?? "").trim();
      if (t && !out.questions.includes(t)) out.questions.push(t);
    }
    for (const r of d.organic_results ?? []) {
      const t = String(r?.title ?? "").trim();
      const s = String(r?.snippet ?? "").trim();
      if (t) out.titles.push(t.slice(0, 160));
      if (s) out.snippets.push(s.slice(0, 300));
    }
    out.questions = out.questions.slice(0, 12);
    out.titles = out.titles.slice(0, 10);
    out.snippets = out.snippets.slice(0, 10);
  } catch (e) {
    out.error = e instanceof Error ? e.message.slice(0, 160) : String(e);
  }
  return out;
}

export function serpBlockText(s: SerpBrief | null): string {
  if (!s || (!s.questions.length && !s.titles.length)) return "SEARCH DATA: none available.";
  const parts: string[] = [];
  if (s.questions.length) parts.push(`PEOPLE ALSO ASK (real questions from Google):\n${s.questions.map((q) => `- ${q}`).join("\n")}`);
  if (s.titles.length) parts.push(`TOP RESULT TITLES (what already ranks — cover the same ground better, never copy):\n${s.titles.map((t) => `- ${t}`).join("\n")}`);
  if (s.snippets.length) parts.push(`SNIPPETS (for fact cross-checking only):\n${s.snippets.map((t) => `- ${t}`).join("\n")}`);
  return parts.join("\n\n");
}
