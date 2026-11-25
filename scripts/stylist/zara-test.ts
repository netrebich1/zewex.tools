/** Проверка разбора Zara на сохранённых ответах: npx tsx scripts/stylist/zara-test.ts <папка с zara-cats.json и zara-jackets.json> */
import { readFileSync } from "node:fs";
import { zaraCategories, zaraProducts } from "@/lib/stylist/adapters/zara";
import { classifyCategory, classifyColor, classifyTags } from "@/lib/stylist/classify";

const dir = process.argv[2] || ".";
const cats = zaraCategories(readFileSync(`${dir}/zara-cats.json`, "utf8"));
console.log(`разделов: ${cats.length}`);
console.log(cats.map((c) => `${c.gender}:${c.keyword}`).join("  "));
const items = zaraProducts(readFileSync(`${dir}/zara-jackets.json`, "utf8"), { path: "mt/en" }, { gender: "woman", keyword: "woman-jackets", name: "JACKETS" });
const count = (f: (i: (typeof items)[number]) => string) => Object.entries(items.reduce<Record<string, number>>((a, i) => ((a[f(i)] = (a[f(i)] ?? 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k || "—"} ${v}`).join(", ");
console.log(`вещей: ${items.length}`);
console.log("типы:", count((i) => classifyCategory(i.name, i.rawCategory)));
console.log("цвета:", count((i) => classifyColor(i.colorName ?? "", i.colorHex)));
console.log("без цвета:", [...new Set(items.filter((i) => !classifyColor(i.colorName ?? "", i.colorHex)).map((i) => `${i.colorName}/${i.colorHex}`))].join(", "));
for (const i of items.slice(0, 12)) console.log(` ${i.name} | ${classifyCategory(i.name, i.rawCategory)} | ${i.colorName}→${classifyColor(i.colorName ?? "", i.colorHex)} | ${classifyTags(i.name, i.rawCategory).join(",")} | ${i.price}${i.oldPrice ? ` (было ${i.oldPrice})` : ""}`);
console.log(items[0]);
