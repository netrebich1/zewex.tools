/** «Стилист»: карточка клиента — размеры и замеры; подсказки, подходит ли вещь по размеру. Без серверных зависимостей. */
import { unpack } from "./consts";

export const MEASURES = [
  { id: "bust", label: "Обхват груди, см" },
  { id: "waist", label: "Обхват талии, см" },
  { id: "hips", label: "Обхват бёдер, см" },
  { id: "shoulders", label: "Ширина плеч, см" },
  { id: "sleeve", label: "Длина рукава, см" },
  { id: "inseam", label: "Длина ноги по внутреннему шву, см" },
  { id: "foot", label: "Длина стопы, см" },
] as const;

export type ClientSizes = { sizeTop: string; sizeBottom: string; sizeShoes: string };

const TOP = ["jackets", "coats", "blazers", "knitwear", "sweatshirts", "shirts", "tshirts", "tops", "dresses", "suits", "lingerie", "swimwear"];
const BOTTOM = ["trousers", "jeans", "skirts", "shorts"];

const split = (s: string) => s.toUpperCase().split(/[\s,;/]+/).filter(Boolean);

/** Размеры клиента для типа вещи (клиент может носить «S, 36» — оба варианта считаются его размером). */
export function clientSizesFor(c: ClientSizes, category: string): string[] {
  if (category === "shoes") return split(c.sizeShoes);
  if (BOTTOM.includes(category)) return split(c.sizeBottom);
  if (TOP.includes(category)) return split(c.sizeTop);
  return [];
}

/**
 * Подходит ли вещь клиенту по размеру:
 * fit — размер клиента есть в наличии; none — в сетке вещи размера клиента нет вовсе; out — есть в сетке, но раскуплен;
 * unknown — у клиента размер не указан, тип вещи без размера или магазин сетку не отдаёт.
 */
export function clientFit(c: ClientSizes, item: { category: string; sizes: string; sizesAll: string; sizesAt: Date | null }): { state: "fit" | "out" | "none" | "unknown"; size: string } {
  const mine = clientSizesFor(c, item.category);
  if (!mine.length || !item.sizesAt) return { state: "unknown", size: mine[0] ?? "" };
  const have = unpack(item.sizes).map((s) => s.toUpperCase());
  const all = (unpack(item.sizesAll).length ? unpack(item.sizesAll) : unpack(item.sizes)).map((s) => s.toUpperCase());
  const ok = mine.find((s) => have.includes(s));
  if (ok) return { state: "fit", size: ok };
  const listed = mine.find((s) => all.includes(s));
  return listed ? { state: "out", size: listed } : { state: "none", size: mine[0] };
}
