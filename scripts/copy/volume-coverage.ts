/** Разовая проверка: сколько ядер Article Copy находят частотность в «Подборе ключей» (KwKeyword.volume). */
import { prisma } from "@/lib/db";
import { splitKeyword } from "@/lib/copy/keys";

async function main() {
  const kws = await prisma.kwKeyword.findMany({ where: { volume: { not: null } }, select: { phrase: true, volume: true, niche: true } });
  const vol = new Map<string, number>();
  for (const k of kws) {
    const { core } = splitKeyword(k.phrase);
    vol.set(core, Math.max(vol.get(core) ?? 0, k.volume!));
  }
  const cores = await prisma.copyCore.findMany({ select: { niche: true, core: true, articles: true, byPhotos: true }, distinct: ["niche", "core"] });
  const cls = (v: number | undefined) => (v == null ? "нет" : v >= 30000 ? "ВЧ" : v >= 10000 ? "СЧ" : v >= 3000 ? "НЧ" : "<3k");
  const agg: Record<string, Record<string, { cores: number; byPhotos: number }>> = {};
  for (const c of cores) {
    const k = cls(vol.get(c.core));
    agg[c.niche] ??= {};
    agg[c.niche][k] ??= { cores: 0, byPhotos: 0 };
    agg[c.niche][k].cores++;
    agg[c.niche][k].byPhotos += c.byPhotos;
  }
  console.log(`ключей с частотностью: ${kws.length}, ядер из них: ${vol.size}, ядер Copy: ${cores.length}`);
  console.table(Object.entries(agg).flatMap(([niche, m]) => Object.entries(m).map(([k, v]) => ({ niche, class: k, ...v }))));
  // примеры ненайденных крупных ядер
  const miss = cores.filter((c) => !vol.has(c.core) && c.niche !== "interior").sort((a, b) => b.byPhotos - a.byPhotos).slice(0, 25);
  console.log("не нашли частотность (крупные):", miss.map((m) => `${m.core} (${m.byPhotos})`).join("; "));
  await prisma.$disconnect();
}
main();
