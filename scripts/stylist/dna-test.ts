/** Проверка меток «в духе бренда» по словам названия на сохранённом списке Zara: npx tsx scripts/stylist/dna-test.ts <папка> */
import { readFileSync } from "node:fs";
import { zaraProducts } from "@/lib/stylist/adapters/zara";
import { classifyCategory, classifyColor } from "@/lib/stylist/classify";
import raw from "@/lib/stylist/brands.json";

type B = { id: string; icons: Array<{ name: string; category: string; match?: { any?: string[]; all?: string[]; colors?: string[] } }> };
const items = zaraProducts(readFileSync(`${process.argv[2] || "."}/zara-jackets.json`, "utf8"), { path: "mt/en" }, { gender: "woman", keyword: "woman-jackets", name: "JACKETS" });
let hit = 0;
const per: Record<string, number> = {};
for (const it of items) {
  const cat = classifyCategory(it.name, it.rawCategory), color = classifyColor(it.colorName ?? "", it.colorHex), t = it.name.toLowerCase();
  const m: string[] = [];
  for (const b of raw as unknown as B[]) for (const i of b.icons) {
    const any = (i.match?.any ?? []).filter((s) => s.length >= 3);
    if (i.category === cat && any.some((s) => t.includes(s.toLowerCase())) && (!i.match?.colors?.length || i.match.colors.includes(color))) { m.push(`${b.id}:${any.find((s) => t.includes(s.toLowerCase()))}`); break; }
  }
  if (m.length) { hit++; for (const x of m) per[x.split(":")[0]] = (per[x.split(":")[0]] ?? 0) + 1; if (hit <= 25) console.log(`${it.name} [${cat}/${color}] → ${m.join(", ")}`); }
}
console.log(`с метками ${hit} из ${items.length}`, per);
