/**
 * Поисковая выдача для исследования темы (необязательно, `params.research.serp`): People Also Ask, заголовки и сниппеты топа.
 * Основной источник — DataForSEO Google organic через ключ поиска фото (слот photo_dfs); с 07.11.2026 SerpApi у команды нет,
 * он остаётся запасным (слот serp_organic), только если DataForSEO не подключён. Без ключа или при ошибке — пусто, этап идёт без выдачи.
 */
import { dfsRequest, serpRequest, type AiCtx } from "./ai";
import { DFS_RETRY_PAUSES_MS, dfsTaskVerdict } from "@/lib/articles/photo/search";

export type SerpBrief = { questions: string[]; titles: string[]; snippets: string[]; error?: string };

// Как в поиске фото (src/lib/articles/photo/search.ts); остальные страны → US.
const DFS_LOCATIONS: Record<string, number> = { US: 2840, GB: 2826, AU: 2036, CA: 2124, DE: 2276, FR: 2250, ES: 2724, IT: 2380, NL: 2528, PL: 2616, BR: 2076, IN: 2356, UA: 2804, RU: 2643 };
// Слот не подключён (как NOT_CONFIGURED_STATUS в поиске фото).
const NOT_CONFIGURED = new Set([404, 409]);

type DfsOrganicItem = { type?: string; title?: string; description?: string; items?: Array<{ title?: string }> };

function finish(out: SerpBrief): SerpBrief {
  out.questions = out.questions.slice(0, 12);
  out.titles = out.titles.slice(0, 10);
  out.snippets = out.snippets.slice(0, 10);
  return out;
}

/** DataForSEO organic с повтором при временном сбое (40101 и т. п.); null — DataForSEO не подключён. */
async function viaDataForSeo(ctx: AiCtx, keyword: string, country: string, language: string): Promise<SerpBrief | null> {
  const out: SerpBrief = { questions: [], titles: [], snippets: [] };
  const body = [{ keyword, location_code: DFS_LOCATIONS[country.toUpperCase()] || 2840, language_code: language.slice(0, 2), depth: 10 }];
  for (let attempt = 0; attempt <= DFS_RETRY_PAUSES_MS.length; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, DFS_RETRY_PAUSES_MS[attempt - 1]));
    if (ctx.signal?.aborted) return out;
    const res = await dfsRequest(ctx, "serp/google/organic/live/advanced", body, 90_000);
    if (!res.ok) {
      if (NOT_CONFIGURED.has(res.status) && !res.data) return null;
      out.error = `DataForSEO ${res.status}: ${String(res.error || "").slice(0, 160)}`;
      if (res.status && res.status < 500 && res.status !== 408 && res.status !== 429) return out;
      continue;
    }
    const json = (res.data || {}) as { tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: DfsOrganicItem[] }> }> };
    const task = json.tasks?.[0];
    const code = Number(task?.status_code) || 0;
    const verdict = dfsTaskVerdict(code >= 40000 ? code : 0);
    if (verdict !== "ok" && verdict !== "empty") {
      out.error = `DataForSEO ${code}: ${task?.status_message ?? ""}`.trim();
      if (verdict === "transient") continue;
      return out;
    }
    out.error = undefined;
    for (const it of task?.result?.[0]?.items ?? []) {
      if (it.type === "people_also_ask") {
        for (const q of it.items ?? []) {
          const t = String(q?.title ?? "").trim();
          if (t && !out.questions.includes(t)) out.questions.push(t);
        }
      } else if (it.type === "organic") {
        const t = String(it.title ?? "").trim();
        const s = String(it.description ?? "").trim();
        if (t) out.titles.push(t.slice(0, 160));
        if (s) out.snippets.push(s.slice(0, 300));
      }
    }
    return finish(out);
  }
  return out;
}

async function viaSerpApi(ctx: AiCtx, keyword: string, country: string, language: string): Promise<SerpBrief> {
  const out: SerpBrief = { questions: [], titles: [], snippets: [] };
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
  return finish(out);
}

export async function fetchSerpBrief(ctx: AiCtx, keyword: string, country: string, language: string): Promise<SerpBrief> {
  try {
    const d = await viaDataForSeo(ctx, keyword, country, language);
    if (d) return d;
    return await viaSerpApi(ctx, keyword, country, language);
  } catch (e) {
    return { questions: [], titles: [], snippets: [], error: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }
}

export function serpBlockText(s: SerpBrief | null): string {
  if (!s || (!s.questions.length && !s.titles.length)) return "SEARCH DATA: none available.";
  const parts: string[] = [];
  if (s.questions.length) parts.push(`PEOPLE ALSO ASK (real questions from Google):\n${s.questions.map((q) => `- ${q}`).join("\n")}`);
  if (s.titles.length) parts.push(`TOP RESULT TITLES (what already ranks — cover the same ground better, never copy):\n${s.titles.map((t) => `- ${t}`).join("\n")}`);
  if (s.snippets.length) parts.push(`SNIPPETS (for fact cross-checking only):\n${s.snippets.map((t) => `- ${t}`).join("\n")}`);
  return parts.join("\n\n");
}
