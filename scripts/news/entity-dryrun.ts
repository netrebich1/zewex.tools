import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { makeEntityMatcher, tokens } from "@/lib/news/text";
async function main() {
  const data = JSON.parse(readFileSync(process.argv[2], "utf8")) as { entities: { name: string; type: string; weight: number; aliases: string[] }[] };
  const m = makeEntityMatcher(data.entities.map((e, i) => ({ id: "n" + i, name: e.name, weight: e.weight, type: e.type, aliases: e.aliases })));
  const items = await prisma.newsItem.findMany({ where: { cutStep: "whitelist", foundAt: { gte: new Date(Date.now() - 3 * 86400000) } }, select: { title: true, lead: true, domain: true } });
  const by = new Map<string, string[]>();
  let pass = 0;
  for (const it of items) {
    const h = m(tokens(it.title + " " + (it.lead ?? "").slice(0, 300)));
    if (!h.length) continue;
    pass++;
    const k = h[0].name;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(it.domain + ": " + it.title.slice(0, 95));
  }
  console.log("отсеяно белым списком за 3 дня:", items.length, "теперь прошло бы:", pass);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log("\n== " + k + " (" + v.length + ")");
    for (const t of v.slice(0, 4)) console.log("   " + t);
  }
  await prisma.$disconnect();
}
main();
