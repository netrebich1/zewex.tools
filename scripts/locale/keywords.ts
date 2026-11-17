/**
 * Подбор ключей на языке для ядер мешапа (этап 1 плана docs/copy/LOCALES-PLAN.md): для каждого ядра модель даёт
 * поисковые формулировки, как их набрал бы носитель, Semrush (через Group by SEO) замеряет объём и KD по базе страны,
 * скрипт выбирает лучший ключ и пишет TSV для проверки владельцем. В базу ничего не пишет.
 *
 *   sudo -u zewex_tools_usr -H npx tsx scripts/locale/keywords.ts --lang cs --niche hair --limit 30 [--related 5] [--out docs/copy/locale/cs-hair.tsv]
 *   --cores "balayage;french nails" — только эти ядра. --niche можно несколько. --min-class hi|mid|low — ядра не ниже класса.
 *   --dry — только кандидаты модели, без Semrush. --related N — для N лучших ядер ещё и phrase_related (40 юнитов за строку, 8 строк) — что рынок ищет, чего мы не придумали.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { prisma } from "@/lib/db";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { LOCALE_LANGS } from "@/lib/locale/languages";
import { keywordOverview, relatedKeywords, semrushUnits, type KeywordMetrics } from "@/lib/locale/semrush";

const CANDIDATE_MODEL = "openrouter:google/gemini-2.5-flash";
const NICHE_LABEL: Record<string, string> = { nails: "nail designs and manicure", hair: "haircuts, hairstyles and hair color", outfits: "women's outfits and fashion", interior: "home interior and decor" };

type Core = { id: string; niche: string; core: string; volume: number | null; volClass: string | null; formulations: unknown };
type Pick = { core: Core; candidates: Array<KeywordMetrics & { source: "model" | "related" }>; best: KeywordMetrics | null; reason: string; related?: KeywordMetrics[] };

const args = process.argv.slice(2);
const get = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));

async function candidates(ai: { userId: string; teamId: string }, lang: (typeof LOCALE_LANGS)[string], core: Core): Promise<string[]> {
  const forms = Array.isArray(core.formulations) ? (core.formulations as Array<{ k?: string }>).map((f) => f.k).filter(Boolean).slice(0, 6) : [];
  const system = `You are a native ${lang.language} SEO specialist working on Google search in ${lang.country}. Given an English topic from a women's/decor niche, list 8-12 search queries that real people in ${lang.country} type into Google for this exact topic. Rules: queries, not translations — use the words locals actually use (synonyms, the common loanword if locals use it, e.g. "ombre", "balayage", "french"); include the most common grammatical number and 1-2 natural variants (with a tail like "inspirace"/"nápady"/"Ideen"/"pomysły"/"idei"/"ideas" only if locals really add it); 1-4 words each; lowercase; correct diacritics; no year, no brand names, no questions. Keep the meaning identical to the English topic (same hair color / nail shape / garment), do not broaden or narrow it. Return JSON only: {"queries":["..."]}.`;
  const user = JSON.stringify({ topic: core.core, niche: NICHE_LABEL[core.niche] ?? core.niche, english_article_keywords: forms });
  const r = await aiChat(ai, { slot: SLOTS.textFast, model: CANDIDATE_MODEL, system, user, json: true, temperature: 0.4, maxTokens: 600, timeoutMs: 60_000 });
  const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as { queries?: unknown } | null;
  const list = Array.isArray(out?.queries) ? out!.queries.map((q) => String(q).trim().toLowerCase()).filter((q) => q && q.length <= 60) : [];
  return [...new Set(list)].slice(0, 12);
}

/** Балл кандидата: объём, штраф за сложность (KD 0–100 → множитель 1…0.4). */
const score = (m: KeywordMetrics) => m.volume * (m.kd == null ? 0.8 : 1 - 0.6 * Math.min(100, m.kd) / 100);

async function main() {
  const langCode = get("--lang")[0] ?? "cs";
  const lang = LOCALE_LANGS[langCode];
  if (!lang) throw new Error(`язык ${langCode} не описан в LOCALE_LANGS`);
  const niches = get("--niche");
  const onlyCores = get("--cores")[0]?.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const limit = Number(get("--limit")[0] ?? 30);
  const relatedN = Number(get("--related")[0] ?? 0);
  const minClass = get("--min-class")[0];
  const classes = minClass === "hi" ? ["hi"] : minClass === "mid" ? ["hi", "mid"] : minClass === "low" ? ["hi", "mid", "low"] : null;
  const out = get("--out")[0] ?? `docs/copy/locale/${langCode}-${niches.join("-") || "all"}.tsv`;

  const user = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
  if (!user) throw new Error("нет администратора");
  // Ядра лежат в общем банке (teamId = "shared", решение владельца 05.11), а слоты ИИ настроены у команды,
  // которая собирает мешап-статьи — её и берём для вызовов модели; --team переопределяет.
  const lastCopy = await prisma.copyArticle.findFirst({ orderBy: { id: "desc" }, select: { teamId: true } });
  const teamId = get("--team")[0] ?? lastCopy?.teamId;
  if (!teamId) throw new Error("нет команды с мешап-статьями — укажите --team");
  const ai = { userId: user.id, teamId };

  const cores = (await prisma.copyCore.findMany({
    where: { grp: "women", ...(niches.length ? { niche: { in: niches } } : {}), ...(onlyCores ? { core: { in: onlyCores } } : {}), ...(classes ? { volClass: { in: classes } } : {}) },
    orderBy: [{ volume: "desc" }],
    take: onlyCores ? undefined : limit,
    select: { id: true, niche: true, core: true, volume: true, volClass: true, formulations: true },
  })) as Core[];
  console.log(`язык ${lang.language} (база ${lang.semrushDb}), ядер ${cores.length}, порог объёма ${lang.minVolume}`);

  // 1. Кандидаты от модели — параллельно по 5.
  const cands = new Map<string, string[]>();
  for (let i = 0; i < cores.length; i += 5) {
    await Promise.all(cores.slice(i, i + 5).map(async (c) => {
      try { cands.set(c.id, await candidates(ai, lang, c)); } catch (e) { console.error(`кандидаты ${c.core}: ${e instanceof Error ? e.message : e}`); cands.set(c.id, []); }
    }));
  }

  // 2. Один замер на все кандидаты всех ядер (по 100 за запрос).
  const all = [...new Set([...cands.values()].flat())];
  if (args.includes("--dry")) {
    for (const c of cores) console.log(`${c.core} → ${(cands.get(c.id) ?? []).join(" | ")}`);
    await prisma.$disconnect();
    return;
  }
  console.log(`кандидатов ${all.length}, замер Semrush…`);
  const metrics = await keywordOverview(all, lang.semrushDb);
  console.log(`с данными ${metrics.size} из ${all.length}; юнитов ${semrushUnits.spent}`);

  // 3. Выбор.
  const picks: Pick[] = cores.map((core) => {
    const list = (cands.get(core.id) ?? []).map((q) => ({ ...(metrics.get(q) ?? { phrase: q, volume: 0, kd: null, cpc: null, competition: null, results: null }), source: "model" as const }));
    list.sort((a, b) => score(b) - score(a));
    const best = list[0] && list[0].volume >= lang.minVolume ? list[0] : null;
    return { core, candidates: list, best, reason: best ? "" : list.length ? `лучший объём ${list[0]?.volume ?? 0} < ${lang.minVolume}` : "нет кандидатов" };
  });

  // 4. Related для лучших N ядер: подсказки рынка; если находится ключ с большим баллом — он и выбирается.
  if (relatedN > 0) {
    const top = picks.filter((p) => p.best).sort((a, b) => score(b.best!) - score(a.best!)).slice(0, relatedN);
    for (const p of top) {
      try {
        p.related = await relatedKeywords(p.best!.phrase, lang.semrushDb, 8);
        for (const r of p.related) {
          if (!p.candidates.some((c) => c.phrase === r.phrase.toLowerCase())) p.candidates.push({ ...r, phrase: r.phrase.toLowerCase(), source: "related" });
        }
        p.candidates.sort((a, b) => score(b) - score(a));
      } catch (e) { console.error(`related ${p.core.core}: ${e instanceof Error ? e.message : e}`); }
    }
  }

  // 5. Склейка: один ключ — одно ядро (у второго ядра ключ становится дубликатом).
  const taken = new Map<string, string>();
  for (const p of picks.sort((a, b) => (b.core.volume ?? 0) - (a.core.volume ?? 0))) {
    if (!p.best) continue;
    const owner = taken.get(p.best.phrase);
    if (owner) { p.reason = `дубликат ядра «${owner}»`; p.best = null; } else taken.set(p.best.phrase, p.core.core);
  }

  // 6. TSV.
  const rows = [["niche", "core_en", "vol_us", "class", "keyword", "volume", "kd", "cpc", "status", "reason", "candidates (phrase:volume:kd)"].join("\t")];
  for (const p of picks) {
    rows.push([p.core.niche, p.core.core, p.core.volume ?? "", p.core.volClass ?? "", p.best?.phrase ?? "", p.best?.volume ?? "", p.best?.kd ?? "", p.best?.cpc ?? "", p.best ? "auto" : "skip", p.reason, p.candidates.slice(0, 12).map((c) => `${c.phrase}:${c.volume}:${c.kd ?? "-"}${c.source === "related" ? "*" : ""}`).join(" | ")].join("\t"));
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, rows.join("\n") + "\n", "utf8");
  const ok = picks.filter((p) => p.best).length;
  console.log(`выбрано ${ok} из ${picks.length}; дубликатов ${picks.filter((p) => /дубликат/.test(p.reason)).length}; ниже порога ${picks.filter((p) => /< /.test(p.reason)).length}; юнитов Semrush ${semrushUnits.spent}; файл ${out}`);
  console.table(picks.slice(0, 40).map((p) => ({ core: p.core.core, keyword: p.best?.phrase ?? `— (${p.reason})`, vol: p.best?.volume ?? "", kd: p.best?.kd ?? "" })));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
