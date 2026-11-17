/**
 * Самопроверка модуля «Новости» без базы: качает ленты из стартового набора, разбирает их и прогоняет бесплатные фильтры
 * (стоп-слова, рубрики, белый список, сущности). Печатает воронку по источникам и примеры прошедших и отсечённых заголовков.
 * Запуск: npx tsx scripts/news/selftest.ts [число источников]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchText } from "@/lib/news/fetch";
import { cleanGnewsItem, parseFeed, parseTrends } from "@/lib/news/parse";
import { filterText, makeEntityMatcher, makeMatcher, rubricTokens, tokens } from "@/lib/news/text";
import { DEFAULT_SETTINGS } from "@/lib/news/types";

type Src = { kind: string; name: string; url: string; tier: string; profile?: boolean; includeCats?: string[]; excludeCats?: string[]; includeUrls?: string[] };

async function main() {
  const data = JSON.parse(readFileSync(join(process.cwd(), "prisma/seed-data/news/beautydaily.json"), "utf8")) as { sources: Src[]; entities: { name: string; weight: number; type: string; aliases: string[] }[] };
  const limit = Number(process.argv[2] || 999);
  const s = DEFAULT_SETTINGS;
  const stop = makeMatcher(s.stopWords, s.stopExceptions);
  const rub = makeMatcher(s.stopRubrics, s.stopExceptions);
  const niche = makeMatcher(s.nicheWords);
  const ents = makeEntityMatcher(data.entities.map((e, i) => ({ id: String(i), ...e })));
  const passed: string[] = [];
  const cut: string[] = [];
  for (const src of data.sources.slice(0, limit)) {
    const url = src.kind === "gnews_query" ? `https://news.google.com/rss/search?q=${encodeURIComponent(src.url + " when:1d")}&hl=uk&gl=UA&ceid=UA:uk`
      : src.kind === "gnews_topic" ? `https://news.google.com/rss/headlines/section/topic/${src.url}?hl=uk&gl=UA&ceid=UA:uk`
      : src.kind === "trends" ? `https://trends.google.com/trending/rss?geo=${src.url}` : src.url;
    const r = await fetchText(url);
    if (!r.ok) {
      console.log(`✗ ${src.name}: ${r.error}`);
      continue;
    }
    if (src.kind === "trends") {
      const t = parseTrends(r.text);
      console.log(`✓ ${src.name}: трендов ${t.length}: ${t.slice(0, 8).map((x) => `${x.title}${stop.match(tokens(x.title + " " + x.news.map((n) => n.title).join(" "))) ? "✗" : ""}`).join(", ")}`);
      continue;
    }
    let feed = parseFeed(r.text);
    if (feed.kind === "sitemapindex" && feed.children[0]) feed = parseFeed((await fetchText(feed.children[0])).text);
    const items = src.kind.startsWith("gnews") ? feed.items.map(cleanGnewsItem) : feed.items;
    const fresh = items.filter((i) => !i.publishedAt || Date.now() - i.publishedAt.getTime() < s.maxAgeHours * 3600_000);
    let n = 0;
    const why: Record<string, number> = {};
    for (const it of fresh) {
      const cat = it.categories.join(" | ").toLowerCase();
      const toks = filterText(it.title, it.lead, !!src.profile, s.stopExceptions);
      const nicheToks = tokens(`${it.title} ${it.lead.slice(0, 300)}`);
      const hit = ents(nicheToks);
      const incOk = !!src.includeCats?.length && src.includeCats.some((x) => cat.includes(x));
      let reason = "";
      if (src.includeUrls?.length && !src.includeUrls.some((x) => it.url.toLowerCase().includes(x))) reason = "url";
      else if (src.includeCats?.length && !incOk) reason = "рубрика источника";
      else if (src.excludeCats?.some((x) => cat.includes(x))) reason = "исключённая рубрика";
      else if (stop.match(toks)) reason = `стоп «${stop.match(toks)}»`;
      else if (!incOk && !src.profile && cat && rub.match(rubricTokens(it.categories))) reason = `стоп-рубрика «${rub.match(rubricTokens(it.categories))}»`;
      else if (!hit.length && !src.profile && !niche.match(nicheToks)) reason = "белый список";
      if (reason) {
        why[reason.split(" «")[0]] = (why[reason.split(" «")[0]] ?? 0) + 1;
        if (!reason.startsWith("url") && !reason.startsWith("рубрика источника") && cut.length < 400) cut.push(`${src.name} | ${reason} | ${it.title.slice(0, 100)}`);
      } else {
        n++;
        passed.push(`${src.name} | ${hit.map((h) => h.name).join(", ") || "—"} | ${it.title.slice(0, 100)}`);
      }
    }
    const newest = items.map((i) => i.publishedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    console.log(`✓ ${src.name}: ${feed.kind}, всего ${items.length}, свежих ${fresh.length}, прошло ${n}; отсев ${JSON.stringify(why)}; новейший ${newest ? new Date(newest).toISOString().slice(0, 16) : "—"}${items[0] && !items[0].imageUrl ? " · без картинок" : ""}`);
    if (src.kind.startsWith("gnews")) await new Promise((res) => setTimeout(res, 3000));
  }
  console.log(`\n=== ПРОШЛО ${passed.length} (первые 60)\n${passed.slice(0, 60).join("\n")}`);
  console.log(`\n=== ОТСЕЧЕНО словами/рубриками/белым списком (первые 80)\n${cut.slice(0, 80).join("\n")}`);
}
main();
