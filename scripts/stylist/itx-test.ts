/** Живая проверка брендов Inditex (ограниченно, первые ~60 товаров): npx tsx scripts/stylist/itx-test.ts <host> <storeId> */
import { itxCategories, scanItx } from "@/lib/stylist/adapters/itx";
import { classifyCategory, classifyColor, classifyTags } from "@/lib/stylist/classify";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const cfg = { host: process.argv[2] || "massimodutti.com", storeId: process.argv[3] || "35009489", path: "mt" };
let n = 0, bytes = 0;
const get = async (url: string) => {
  n++;
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", "accept-language": "en-GB,en;q=0.9" }, signal: AbortSignal.timeout(40_000) });
  const t = await r.text();
  bytes += t.length;
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 120)}`);
  if (url.includes("/category?")) console.log("разделы:", itxCategories(t, cfg).map((c) => `${c.gender[0]}:${c.name}`).join(" | "));
  return t;
};
scanItx(get, cfg, undefined, 60).then((items) => {
  console.log(`вещей ${items.length}, запросов ${n}, ${(bytes / 1e6).toFixed(1)} МБ`);
  for (const i of items.slice(0, 8)) console.log(` ${i.sku} | ${i.name} | ${i.gender} | ${i.rawCategory} → ${classifyCategory(i.name, i.rawCategory)} | ${i.colorName}→${classifyColor(i.colorName ?? "")} | ${classifyTags(i.name, i.rawCategory).join(",")} | ${i.price}${i.oldPrice ? `/${i.oldPrice}` : ""} | ${(i.sizes ?? []).join(" ")} | ${i.inStock}\n   ${i.url}\n   ${i.imageUrl}`);
}).catch((e) => console.log("ERR", e.message));
