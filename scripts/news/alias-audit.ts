import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { makeEntityMatcher, tokens } from "@/lib/news/text";
async function main() {
  const data = JSON.parse(readFileSync(process.argv[2], "utf8")) as { entities: { name: string; type: string; weight: number; aliases: string[] }[] };
  const old = await prisma.newsEntity.findMany({ select: { name: true, type: true, weight: true, aliases: true } });
  const all = [...old.map((e) => ({ ...e, aliases: e.aliases as string[] })), ...data.entities];
  const items = await prisma.newsItem.findMany({ where: { foundAt: { gte: new Date(Date.now() - 7 * 86400000) } }, select: { title: true } });
  const freq = new Map<string, number>();
  for (const it of items) for (const t of tokens(it.title)) freq.set(t, (freq.get(t) ?? 0) + 1);
  const words = [...freq.keys()];
  for (const e of all) {
    for (const v of [e.name, ...e.aliases]) {
      const tk = tokens(v);
      if (tk.length !== 1 || tk[0].length < 4) continue;
      const m = makeEntityMatcher([{ id: "x", name: v, weight: 1, type: "person", aliases: [] }]);
      const hit = words.filter((w) => m([w]).length).sort((a, b) => freq.get(b)! - freq.get(a)!);
      if (hit.length >= 2 || (hit.length === 1 && hit[0] !== tk[0])) console.log(e.name.padEnd(26), '|', v.padEnd(16), '|', hit.slice(0, 12).map((w) => w + ':' + freq.get(w)).join(' '));
    }
  }
  console.log('titles', items.length, 'distinct words', words.length);
  await prisma.$disconnect();
}
main();
