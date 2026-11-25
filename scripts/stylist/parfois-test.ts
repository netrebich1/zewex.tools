/** Живая проверка Parfois (несколько запросов к сайту): npx tsx scripts/stylist/parfois-test.ts */
import { parfoisTiles } from "@/lib/stylist/adapters/parfois";
import { classifyCategory, classifyColor, classifyTags } from "@/lib/stylist/classify";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const get = async (url: string) => {
  const t = Date.now();
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8", "accept-language": "en-GB,en;q=0.9" }, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  console.log(r.status, text.length, `${Date.now() - t}ms`, url.slice(0, 150));
  return text;
};
async function main() {
  const cfg = { path: "en/mt", locale: "en_MT", country: "MT" };
  for (const section of ["clothing", "shoes"]) {
    const first = await get(`https://www.parfois.com/${cfg.path}/${section}/`);
    const cgid = /Search-UpdateGrid\?cgid=([^&"]+)/.exec(first)?.[1];
    console.log(section, "cgid", cgid, "плиток на первой странице", parfoisTiles(first, cfg).length);
    if (!cgid) continue;
    for (const start of [0, 48]) {
      const html = await get(`https://www.parfois.com/on/demandware.store/Sites-PAR_World-Site/${cfg.locale}/Search-UpdateGrid?cgid=${cgid}&prefn1=onlineForCountries&prefv1=ALL%7C${cfg.country}&start=${start}&sz=48`);
      const items = parfoisTiles(html, cfg);
      console.log(` start ${start}: ${items.length} вещей`);
      for (const i of items.slice(0, 4)) console.log(`  ${i.extId} | ${i.name} | ${i.rawCategory} → ${classifyCategory(i.name, i.rawCategory)} | ${i.colorName}→${classifyColor(i.colorName ?? "")} | ${classifyTags(i.name, i.rawCategory).join(",")} | ${i.price} | ${i.inStock} | ${i.url}\n   ${i.imageUrl}`);
    }
  }
}
main().catch((e) => console.log("ERR", e));
