import { shopifyProducts } from "@/lib/stylist/adapters/shopify";
import { classifyCategory, classifyColor } from "@/lib/stylist/classify";
import { readFileSync } from "node:fs";
for (const [f, cfg] of [["sh-terranova.json", { host: "www.terranovastyle.com", lang: "it" }], ["sh-hudson.json", { host: "hudsonstore.com", multi: true }], ["sh-retail.json", { host: "retail.com.mt", multi: true }]] as const) {
  const items = shopifyProducts(readFileSync(process.argv[2] + "/" + f, "utf8"), cfg);
  const cats: Record<string, number> = {};
  for (const i of items) { const c = classifyCategory(i.name, i.rawCategory, i.lang === "it"); cats[c] = (cats[c] ?? 0) + 1; }
  console.log(f, "вещей", items.length, JSON.stringify(cats));
  for (const i of items.slice(0, 5)) console.log(` ${i.brand ?? ""} | ${i.name} | ${i.rawCategory.slice(0, 40)} → ${classifyCategory(i.name, i.rawCategory, i.lang === "it")} | ${i.gender} | ${i.colorName}→${classifyColor(i.colorName ?? "")} | ${i.price}/${i.oldPrice} | ${i.sizes?.join(" ")} из ${i.sizesAll?.join(" ")} | ${i.sku}`);
  console.log(" other:", items.filter((i) => classifyCategory(i.name, i.rawCategory, i.lang === "it") === "other").slice(0, 8).map((i) => `${i.name} [${i.rawCategory.slice(0, 25)}]`).join("; "));
}
