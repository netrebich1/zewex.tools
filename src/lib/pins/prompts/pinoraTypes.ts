/**
 * Ниши и типы Pinora-пинов: константы без серверных зависимостей (можно импортировать в клиентские компоненты).
 * Логика промтов — в pinora.ts.
 */
export type PinoraType =
  | "tobi" | "collage" | "tipo" | "lista" | "split"
  | "nutri" | "compare" | "appetite"
  | "before_after" | "color_story";

export type PinoraScope = "general" | "cooking" | "decor";

/** Ниши прогона. `scope` определяет, какой набор параметров подставляется. */
export const PINORA_NICHES: ReadonlyArray<{ id: string; label: string; scope: PinoraScope }> = [
  { id: "decor", label: "Декор", scope: "decor" },
  { id: "nails", label: "Ногти", scope: "general" },
  { id: "hair", label: "Причёски", scope: "general" },
  { id: "outfit", label: "Аутфит", scope: "general" },
  { id: "cooking", label: "Кулинария", scope: "cooking" },
];

export const nicheScope = (niche: string): PinoraScope =>
  PINORA_NICHES.find((n) => n.id === niche)?.scope ?? "general";

export const nicheLabel = (niche: string): string =>
  PINORA_NICHES.find((n) => n.id === niche)?.label ?? niche;

export const PINORA_TYPES: ReadonlyArray<{ id: PinoraType; ru: string; only?: string }> = [
  { id: "tobi", ru: "Тоби" },
  { id: "collage", ru: "Коллаж" },
  { id: "tipo", ru: "Типо" },
  { id: "lista", ru: "Листа" },
  { id: "split", ru: "Сплит" },
  { id: "nutri", ru: "Нутри", only: "cooking" },
  { id: "compare", ru: "Сравнение", only: "cooking" },
  { id: "appetite", ru: "Аппетит", only: "cooking" },
  { id: "before_after", ru: "До / После", only: "decor" },
  { id: "color_story", ru: "Цветовая история", only: "decor" },
];

export const typesForNiche = (niche: string): PinoraType[] =>
  PINORA_TYPES.filter((t) => !t.only || t.only === niche).map((t) => t.id);

export function isPinoraType(v: string): v is PinoraType {
  return PINORA_TYPES.some((t) => t.id === v);
}

