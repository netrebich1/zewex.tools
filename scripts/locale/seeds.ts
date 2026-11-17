/**
 * Семена сбора спроса (docs/copy/LOCALES-PLAN.md, 2а): модель строит дерево головных слов ниши на языке (+ английские головы
 * и заимствования), каждое семя замеряется одной строкой обзора (10 юнитов), сохраняется в LocSeed. Семена без объёма
 * выключаются (fullsearch по ним не идёт). Повторный запуск добавляет новые, не трогая правки владельца (source=owner).
 *
 *   npx tsx scripts/locale/seeds.ts --lang cs --niche nails [--add "nehty;manikúra"] [--dry]
 */
import { prisma } from "@/lib/db";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { LOCALE_LANGS } from "@/lib/locale/languages";
import { keywordOverview, semrushUnits } from "@/lib/locale/semrush";
import { aiCtxForLocale, NICHE_LABEL } from "./common";

const MODEL = "openrouter:google/gemini-2.5-flash";
const args = process.argv.slice(2);
const get = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));

async function main() {
  const lang = LOCALE_LANGS[get("--lang")[0] ?? "cs"];
  const niche = get("--niche")[0] ?? "nails";
  if (!lang || !NICHE_LABEL[niche]) throw new Error("нужны --lang и --niche (nails|hair|outfits|interior)");
  const ai = await aiCtxForLocale(get("--team")[0]);

  const system = `You are a native ${lang.language} SEO specialist planning keyword research for Google in ${lang.country}. Niche: ${NICHE_LABEL[niche]}. List the HEAD WORDS people in ${lang.country} use for this niche — single words or 2-word phrases that many longer queries contain. Cover: the niche itself and its main sub-areas (for nails: nails, manicure, pedicure, gel nails, acrylic, nail polish, nail design, nail shapes; for hair: hairstyles, haircuts, hair color, highlights, bangs, updos, braids, hair lengths; for clothing: every garment type — jacket, coat, pants, jeans, skirt, dress, sweater, shirt, boots, bag — plus "outfit" words), the common English loanwords locals type (e.g. "nails", "outfit", "nail art", "balayage"), and spelling variants without diacritics only when locals really type them. 25-45 items, lowercase, no brands, no cities, no questions. Return JSON only: {"seeds":["..."]}.`;
  const r = await aiChat(ai, { slot: SLOTS.textFast, model: MODEL, system, user: JSON.stringify({ niche, language: lang.language, country: lang.country }), json: true, temperature: 0.3, maxTokens: 1200, timeoutMs: 90_000 });
  const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as { seeds?: unknown } | null;
  const fromModel = Array.isArray(out?.seeds) ? [...new Set(out!.seeds.map((s) => String(s).trim().toLowerCase()).filter((s) => s && s.length <= 60))] : [];
  const added = (get("--add")[0] ?? "").split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
  console.log(`семян от модели ${fromModel.length}${added.length ? `, от владельца ${added.length}` : ""}`);
  if (args.includes("--dry")) { console.log(fromModel.join(" | ")); await prisma.$disconnect(); return; }

  const existing = new Set((await prisma.locSeed.findMany({ where: { lang: lang.code, niche }, select: { phrase: true } })).map((s) => s.phrase));
  const fresh = [...new Set([...fromModel, ...added])].filter((p) => !existing.has(p));
  const metrics = await keywordOverview(fresh, lang.semrushDb);
  for (const phrase of fresh) {
    const m = metrics.get(phrase);
    await prisma.locSeed.create({ data: { lang: lang.code, niche, phrase, source: added.includes(phrase) ? "owner" : "model", volume: m?.volume ?? 0, kd: m?.kd == null ? null : Math.round(m.kd), measuredAt: new Date(), enabled: added.includes(phrase) || (m?.volume ?? 0) >= 50 } });
  }
  const all = await prisma.locSeed.findMany({ where: { lang: lang.code, niche }, orderBy: { volume: "desc" } });
  console.table(all.map((s) => ({ phrase: s.phrase, volume: s.volume, kd: s.kd, enabled: s.enabled, source: s.source })));
  console.log(`новых ${fresh.length}, всего ${all.length}, включено ${all.filter((s) => s.enabled).length}; юнитов ${semrushUnits.spent}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
