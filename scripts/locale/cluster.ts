/**
 * Кластеризация запросов в темы (docs/copy/LOCALES-PLAN.md, 2а). Два прохода:
 * 1) код: свёртка диакритики и порядка слов — одинаковые наборы слов = одна группа (ruzove nehty / růžové nehty);
 * 2) модель: пачками по 80 групп (по убыванию объёма) раскладывает по темам — одно поисковое намерение = одна тема; даёт
 *    английское имя темы и атрибуты для поиска кадров ({garment, color, shape, technique, hair_color, length, style, occasion}).
 *    Уже существующие темы языка передаются модели списком, чтобы новые запросы ложились в них, а не плодили дубли.
 * Затем код считает объём темы (сумма), KD (средневзвешенный), долю AIO, сезон по трендам, easy, порог по сумме.
 *
 *   npx tsx scripts/locale/cluster.ts --lang cs --niche nails [--min-volume 50] [--reset]
 */
import { prisma } from "@/lib/db";
import { aiChat } from "@/lib/articles/ai";
import { SLOTS } from "@/lib/articles/types";
import { parseModelJsonSafe } from "@/lib/articles/text/jsonRepair";
import { LOCALE_LANGS } from "@/lib/locale/languages";
import { aiCtxForLocale, fold, NICHE_LABEL } from "./common";

const MODEL = "openrouter:google/gemini-2.5-flash";
const args = process.argv.slice(2);
const get = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));

type Q = { id: string; phrase: string; volume: number; kd: number | null; aio: boolean; trends: unknown };
type Group = { key: string; phrases: Q[]; volume: number };
type TopicOut = { name_en: string; primary: string; attrs: Record<string, string>; groups: number[] };

function groupByWords(qs: Q[]): Group[] {
  const map = new Map<string, Group>();
  for (const q of qs) {
    const key = fold(q.phrase).split(" ").filter(Boolean).sort().join(" ");
    const g = map.get(key) ?? { key, phrases: [], volume: 0 };
    g.phrases.push(q); g.volume += q.volume; map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.volume - a.volume);
}

/** Сезон по тренду: пик — месяц максимума; сезонная, если максимум ≥ 2.5 × медианы. Td[0] — 12 месяцев назад. */
function season(trendsList: unknown[]): { peak: number; window: [number, number] } | null {
  const rows = trendsList.filter((t): t is number[] => Array.isArray(t) && t.length === 12);
  if (!rows.length) return null;
  const avg = Array.from({ length: 12 }, (_, i) => rows.reduce((s, r) => s + (Number(r[i]) || 0), 0) / rows.length);
  const sorted = [...avg].sort((a, b) => a - b);
  const median = sorted[6], max = Math.max(...avg);
  if (!median || max < 2.5 * median) return null;
  const idx = avg.indexOf(max);
  const now = new Date();
  const peakMonth = ((now.getMonth() - (11 - idx)) % 12 + 12) % 12 + 1;
  return { peak: peakMonth, window: [((peakMonth - 3 + 11) % 12) + 1, peakMonth] };
}

async function main() {
  const lang = LOCALE_LANGS[get("--lang")[0] ?? "cs"];
  const niche = get("--niche")[0] ?? "nails";
  if (!lang || !NICHE_LABEL[niche]) throw new Error("нужны --lang и --niche");
  const minVolume = Number(get("--min-volume")[0] ?? 50);
  const ai = await aiCtxForLocale(get("--team")[0]);
  if (args.includes("--reset")) {
    await prisma.locQuery.updateMany({ where: { lang: lang.code, niche }, data: { topicId: null } });
    await prisma.locTopic.deleteMany({ where: { lang: lang.code, niche } });
  }

  const qs = (await prisma.locQuery.findMany({ where: { lang: lang.code, niche, junk: false, topicId: null, volume: { gt: 0 } }, orderBy: { volume: "desc" }, select: { id: true, phrase: true, volume: true, kd: true, aio: true, trends: true } })) as Q[];
  const groups = groupByWords(qs);
  console.log(`запросов без темы ${qs.length}, групп по словам ${groups.length}`);

  for (let i = 0; i < groups.length; i += 80) {
    const batch = groups.slice(i, i + 80);
    const existing = await prisma.locTopic.findMany({ where: { lang: lang.code, niche }, select: { id: true, primary: true, nameEn: true }, orderBy: { volume: "desc" }, take: 300 });
    const system = `You cluster ${lang.language} Google queries for a women's photo-inspiration site (niche: ${NICHE_LABEL[niche]}) into article topics. One topic = one search intent that ONE article of photo examples satisfies; spelling variants, word order, singular/plural, "inspirace"/"nápady"/"ideas" tails and the English equivalent belong to the same topic. Different colors, shapes, lengths, garments, techniques or occasions are DIFFERENT topics unless too small to stand alone. Existing topics are given with ids — put a group into an existing topic when it fits, else create a new one. For each topic give: name_en (short English topic name as an article subject, e.g. "almond nails", "black jacket outfits"), primary (the ${lang.language} query to target: usually the biggest group's main spelling with diacritics), attrs (English attributes for finding photos: any of garment, color, pattern, shape, length, technique, finish, hair_color, hair_type, style, occasion, season — only what the topic states). Return JSON only: {"topics":[{"existing_id":"id or null","name_en":"...","primary":"...","attrs":{...},"groups":[group indexes]}]}. Every group index must appear exactly once.`;
    const user = JSON.stringify({ existing: existing.map((t) => ({ id: t.id, primary: t.primary, name_en: t.nameEn })), groups: batch.map((g, idx) => ({ i: idx, volume: g.volume, queries: g.phrases.slice(0, 6).map((p) => p.phrase) })) });
    let topics: Array<TopicOut & { existing_id?: string | null }> = [];
    try {
      const r = await aiChat(ai, { slot: SLOTS.textFast, model: MODEL, system, user, json: true, temperature: 0.1, maxTokens: 8000, timeoutMs: 180_000 });
      const out = (r.json && typeof r.json === "object" ? r.json : parseModelJsonSafe(r.text)) as { topics?: unknown } | null;
      topics = Array.isArray(out?.topics) ? (out!.topics as Array<TopicOut & { existing_id?: string | null }>) : [];
    } catch (e) { console.error(`кластеризация, пачка ${i}: ${e instanceof Error ? e.message : e}`); continue; }
    const placed = new Set<number>();
    for (const t of topics) {
      const idxs = (Array.isArray(t.groups) ? t.groups : []).map(Number).filter((n) => n >= 0 && n < batch.length && !placed.has(n));
      if (!idxs.length) continue;
      idxs.forEach((n) => placed.add(n));
      const ids = idxs.flatMap((n) => batch[n].phrases.map((p) => p.id));
      let topicId = t.existing_id && existing.some((e) => e.id === t.existing_id) ? t.existing_id : null;
      if (!topicId) {
        const primary = String(t.primary || batch[idxs[0]].phrases[0].phrase).trim().toLowerCase().slice(0, 190);
        const created = await prisma.locTopic.create({ data: { lang: lang.code, niche, primary, nameEn: String(t.name_en || primary).slice(0, 190), attrs: (t.attrs && typeof t.attrs === "object" ? t.attrs : {}) as object } });
        topicId = created.id;
      }
      await prisma.locQuery.updateMany({ where: { id: { in: ids } }, data: { topicId } });
    }
    // Группы, которые модель не разложила, становятся отдельными темами по главному запросу.
    for (let n = 0; n < batch.length; n++) {
      if (placed.has(n)) continue;
      const g = batch[n];
      const created = await prisma.locTopic.create({ data: { lang: lang.code, niche, primary: g.phrases[0].phrase, nameEn: g.phrases[0].phrase, attrs: {}, note: "модель не разложила — проверить" } });
      await prisma.locQuery.updateMany({ where: { id: { in: g.phrases.map((p) => p.id) } }, data: { topicId: created.id } });
    }
    console.log(`пачка ${i / 80 + 1}: групп ${batch.length}, тем в ответе ${topics.length}, не разложено ${batch.length - placed.size}`);
  }

  // Метрики тем.
  const topics = await prisma.locTopic.findMany({ where: { lang: lang.code, niche }, include: { queries: { where: { junk: false }, select: { phrase: true, volume: true, kd: true, aio: true, trends: true } } } });
  for (const t of topics) {
    const vol = t.queries.reduce((s, q) => s + q.volume, 0);
    const kdW = t.queries.filter((q) => q.kd != null).reduce((s, q) => s + q.kd! * q.volume, 0);
    const kdV = t.queries.filter((q) => q.kd != null).reduce((s, q) => s + q.volume, 0);
    const kd = kdV ? Math.round(kdW / kdV) : null;
    const aioShare = vol ? t.queries.filter((q) => q.aio).reduce((s, q) => s + q.volume, 0) / vol : 0;
    const top = [...t.queries].sort((a, b) => b.volume - a.volume)[0];
    const primary = t.queries.some((q) => q.phrase === t.primary) ? t.primary : (top?.phrase ?? t.primary);
    const easy = vol >= minVolume && (kd ?? 100) < 30 && aioShare < 0.2;
    await prisma.locTopic.update({ where: { id: t.id }, data: { primary, volume: vol, kd, aioShare: Math.round(aioShare * 100) / 100, easy, season: season(t.queries.map((q) => q.trends)) ?? undefined, status: t.status === "rejected" ? "rejected" : vol >= minVolume ? (t.status === "new" ? "new" : t.status) : "rejected", note: vol < minVolume && t.status !== "rejected" ? `объём ${vol} < ${minVolume}` : t.note } });
  }
  const list = await prisma.locTopic.findMany({ where: { lang: lang.code, niche, status: { not: "rejected" } }, orderBy: { volume: "desc" }, include: { _count: { select: { queries: true } } } });
  console.table(list.slice(0, 60).map((t) => ({ primary: t.primary, en: t.nameEn, vol: t.volume, kd: t.kd, aio: t.aioShare, easy: t.easy, q: t._count.queries, season: t.season ? JSON.stringify(t.season) : "" })));
  const rejected = await prisma.locTopic.count({ where: { lang: lang.code, niche, status: "rejected" } });
  console.log(`тем ${list.length} (объём ≥ ${minVolume}), ниже порога ${rejected}, easy ${list.filter((t) => t.easy).length}, суммарный объём ${list.reduce((s, t) => s + t.volume, 0)}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
