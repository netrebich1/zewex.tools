/**
 * Сбор спроса (docs/copy/LOCALES-PLAN.md, 2а): по включённым семенам ниши — phrase_fullsearch (20 юнитов за строку),
 * результат в LocQuery (одна строка на фразу и язык; повтор не дублирует). Затем фильтр мусора: сначала код
 * (цифры-годы, города, явные бренды), потом модель пачками по 60 запросов решает «наша ниша и намерение идеи/вдохновения
 * или нет». Семена, уже собранные (harvestedAt), пропускаются без --again.
 *
 *   npx tsx scripts/locale/harvest.ts --lang cs --niche nails [--limit 200] [--max-units 13000] [--again] [--no-junk]
 * Строк на семя — пропорционально его объёму (самое крупное получает --limit, остальные не меньше 25). Семя, в котором
 * целиком содержится более крупное семя («gelové nehty» ⊃ «nehty»), не собирается: его запросы уже есть в выгрузке крупного.
 */
import { prisma } from "@/lib/db";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { LOCALE_LANGS } from "@/lib/locale/languages";
import { fullSearch, hasAio, semrushUnits } from "@/lib/locale/semrush";
import { aiCtxForLocale, fold, NICHE_LABEL } from "./common";

const MODEL = "openrouter:google/gemini-2.5-flash";
const args = process.argv.slice(2);
const get = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));

/** Явный мусор без модели: годы, цены, города ЧР/ПЛ/DE…, «купить», порно-хвосты. */
const JUNK_RE = /\b(20[0-3]\d|cena|ceny|koupit|kúpiť|kaufen|preis|kupić|cena|pret|praha|brno|ostrava|plzeň|olomouc|liberec|warszawa|kraków|berlin|münchen|hamburg|bucurești|cluj|madrid|barcelona|porn|xxx|sex)\b/i;

async function judgeJunk(ai: { userId: string; teamId: string }, lang: (typeof LOCALE_LANGS)[string], niche: string, phrases: string[]): Promise<Map<string, string | null>> {
  const system = `You are a native ${lang.language} content editor for a women's photo-inspiration site. Niche: ${NICHE_LABEL[niche]}. For each Google query decide if it fits an article of photo examples in this niche: KEEP = a look, style, color, shape, technique, garment, occasion or trend a woman might browse pictures of. JUNK = products to buy, prices, shops, brands, salons, courses, schools, cities, men's or kids' only, celebrities, medical/health, how-to-remove/repair tutorials, unrelated meanings of the word. Return JSON only: {"junk":[{"i":index,"why":"2-4 words"}]} listing ONLY the junk ones.`;
  const user = JSON.stringify(phrases.map((q, i) => ({ i, q })));
  const out = new Map<string, string | null>(phrases.map((p) => [p, null]));
  try {
    const r = await aiChat(ai, { slot: SLOTS.textFast, model: MODEL, system, user, json: true, temperature: 0, maxTokens: 2500, timeoutMs: 90_000 });
    const j = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as { junk?: Array<{ i: number; why: string }> } | null;
    for (const row of j?.junk ?? []) { const p = phrases[Number(row.i)]; if (p) out.set(p, String(row.why || "мусор").slice(0, 190)); }
  } catch (e) {
    console.error(`фильтр мусора: ${e instanceof Error ? e.message : e}`);
  }
  return out;
}

async function main() {
  const lang = LOCALE_LANGS[get("--lang")[0] ?? "cs"];
  const niche = get("--niche")[0] ?? "nails";
  if (!lang || !NICHE_LABEL[niche]) throw new Error("нужны --lang и --niche");
  const limit = Number(get("--limit")[0] ?? 200);
  const maxUnits = Number(get("--max-units")[0] ?? 13_000);
  const allSeeds = await prisma.locSeed.findMany({ where: { lang: lang.code, niche, enabled: true }, orderBy: { volume: "desc" } });
  const seeds = allSeeds.filter((s) => args.includes("--again") || !s.harvestedAt);
  const maxVol = Math.max(1, ...allSeeds.map((s) => s.volume ?? 0));
  const linesFor = (s: { volume: number | null }) => Math.max(25, Math.min(limit, Math.round(((s.volume ?? 0) / maxVol) * limit / 25) * 25));
  const coveredBy = (s: { phrase: string; volume: number | null }) => allSeeds.find((o) => o.phrase !== s.phrase && (o.volume ?? 0) > (s.volume ?? 0) && fold(s.phrase).split(" ").includes(fold(o.phrase)));
  console.log(`семян к сбору ${seeds.length}, строк на крупнейшее семя ${limit}, бюджет ${maxUnits} юнитов`);

  let added = 0, updated = 0;
  for (const seed of seeds) {
    const parent = coveredBy(seed);
    if (parent) {
      await prisma.locSeed.update({ where: { id: seed.id }, data: { harvestedAt: new Date(), lines: 0 } });
      console.log(`${seed.phrase}: внутри «${parent.phrase}», отдельно не собираем`);
      continue;
    }
    const lines = linesFor(seed);
    if (semrushUnits.spent + lines * 20 > maxUnits) { console.log(`бюджет: остановка перед «${seed.phrase}» (${lines} строк; потрачено ${semrushUnits.spent})`); break; }
    const rows = await fullSearch(seed.phrase, lang.semrushDb, lines);
    for (const m of rows) {
      const phrase = m.phrase.toLowerCase().trim();
      if (!phrase) continue;
      const data = { niche, volume: m.volume, kd: m.kd == null ? null : Math.round(m.kd), cpc: m.cpc, intent: m.intent ?? null, serp: m.serp ?? null, aio: hasAio(m), trends: m.trends ?? undefined };
      // Коллация MariaDB не различает диакритику: «ruzove nehty» найдёт строку «růžové nehty» — тогда оставляем более частотную.
      const ex = await prisma.locQuery.findUnique({ where: { lang_phrase: { lang: lang.code, phrase } }, select: { id: true, phrase: true, volume: true } });
      if (ex) { if (ex.phrase === phrase || m.volume > ex.volume) { await prisma.locQuery.update({ where: { id: ex.id }, data: { ...data, phrase } }); updated++; } }
      else { await prisma.locQuery.create({ data: { lang: lang.code, phrase, seedId: seed.id, ...data, junk: JUNK_RE.test(phrase), junkWhy: JUNK_RE.test(phrase) ? "код: год/цена/город/бренд" : null } }); added++; }
    }
    await prisma.locSeed.update({ where: { id: seed.id }, data: { harvestedAt: new Date(), lines: rows.length } });
    console.log(`${seed.phrase}: ${rows.length} строк; всего новых ${added}; юнитов ${semrushUnits.spent}`);
  }

  if (!args.includes("--no-junk")) {
    const ai = await aiCtxForLocale(get("--team")[0]);
    const pending = await prisma.locQuery.findMany({ where: { lang: lang.code, niche, junk: false, topicId: null, junkWhy: null }, orderBy: { volume: "desc" }, select: { id: true, phrase: true } });
    console.log(`фильтр мусора моделью: ${pending.length} запросов`);
    let junked = 0;
    for (let i = 0; i < pending.length; i += 60) {
      const batch = pending.slice(i, i + 60);
      const verdict = await judgeJunk(ai, lang, niche, batch.map((b) => b.phrase));
      for (const b of batch) {
        const why = verdict.get(b.phrase);
        await prisma.locQuery.update({ where: { id: b.id }, data: why ? { junk: true, junkWhy: why } : { junkWhy: "ok" } });
        if (why) junked++;
      }
    }
    console.log(`мусора отмечено ${junked} из ${pending.length}`);
  }
  const stat = await prisma.locQuery.groupBy({ by: ["junk"], where: { lang: lang.code, niche }, _count: { _all: true }, _sum: { volume: true } });
  console.table(stat.map((s) => ({ junk: s.junk, queries: s._count._all, volume: s._sum.volume })));
  console.log(`юнитов Semrush за прогон ${semrushUnits.spent}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
