/**
 * Проверка кандидатов в источники с сервера: для адреса ленты — загрузка и разбор, для сайта — поиск лент.
 * Печатает объём, долю за 24 часа, рубрики и примеры заголовков. Запуск:
 *   npx tsx scripts/news/check-candidates.ts <file.json>   (массив { name, url, feed?: boolean })
 */
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/db";
import { fetchText } from "@/lib/news/fetch";
import { parseFeed } from "@/lib/news/parse";
import { discoverFeeds } from "@/lib/news/sources";

type Cand = { name: string; url: string; feed?: boolean };

async function checkFeed(url: string) {
  const r = await fetchText(url, { timeoutMs: 20_000 });
  if (!r.ok) return { ok: false as const, note: r.error ?? `HTTP ${r.status}` };
  let feed = parseFeed(r.text);
  if (feed.kind === "sitemapindex" && feed.children[0]) {
    const c = await fetchText(feed.children[0], { timeoutMs: 20_000 });
    if (c.ok) feed = parseFeed(c.text);
  }
  if (feed.kind === "unknown") return { ok: false as const, note: "не лента" };
  const now = Date.now();
  const dated = feed.items.filter((i) => i.publishedAt);
  const day = dated.filter((i) => now - i.publishedAt!.getTime() < 86_400_000).length;
  const newest = dated.map((i) => i.publishedAt!.getTime()).sort((a, b) => b - a)[0];
  const cats = new Map<string, number>();
  for (const i of feed.items) for (const c of i.categories.slice(0, 2)) cats.set(c, (cats.get(c) ?? 0) + 1);
  return {
    ok: true as const,
    kind: feed.kind,
    items: feed.items.length,
    day,
    newest: newest ? `${Math.round((now - newest) / 3600_000)} ч назад` : "без дат",
    img: feed.items.filter((i) => i.imageUrl).length,
    cats: [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(", "),
    sample: feed.items.slice(0, 4).map((i) => i.title.slice(0, 90)),
  };
}

async function main() {
  const list = JSON.parse(readFileSync(process.argv[2], "utf8")) as Cand[];
  let idx = 0;
  const out: string[] = new Array(list.length);
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (idx < list.length) {
      const i = idx++;
      const c = list[i];
      const lines: string[] = [`### ${c.name} — ${c.url}`];
      try {
        if (c.feed) {
          const r = await checkFeed(c.url);
          if (!r.ok) lines.push(`  FAIL ${r.note}`);
          else lines.push(`  OK ${r.kind} ${r.items} шт, за 24 ч ${r.day}, свежий ${r.newest}, фото ${r.img}`, `  рубрики: ${r.cats}`, ...r.sample.map((t) => `  · ${t}`));
        } else {
          const d = await discoverFeeds(c.url);
          if (!d.found.length) lines.push(`  ленты не найдены ${d.error ?? ""}`);
          for (const f of d.found.slice(0, 5)) {
            const r = await checkFeed(f.url);
            if (!r.ok) lines.push(`  ${f.url} FAIL ${r.note}`);
            else lines.push(`  ${f.url} → ${r.kind} ${r.items} шт, за 24 ч ${r.day}, свежий ${r.newest}, фото ${r.img}`, `    рубрики: ${r.cats}`, ...r.sample.slice(0, 3).map((t) => `    · ${t}`));
          }
        }
      } catch (e) {
        lines.push(`  ERROR ${e instanceof Error ? e.message : e}`);
      }
      out[i] = lines.join("\n");
    }
  }));
  console.log(out.join("\n"));
  await prisma.$disconnect();
}
main();
