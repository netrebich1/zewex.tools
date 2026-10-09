/**
 * Рецепт canvas-пина (тип из legacy canvasStyles.ts, без изменений) и базовые
 * палитры. Палитры пака v9 лежат внутри каждого шаблона в БД (`data.palette`),
 * поэтому движок принимает палитру прямо в рецепте.
 */
import type { CanvasFamily, PlateKind } from "./layoutSolver";
import type { KitSpec } from "./kit";
import { contrast } from "./palette";

export type TextHighlight = "none" | "marker" | "underline" | "chip" | "box" | "gradient";
export type TextZone = "top" | "bottom" | "overlay" | "middle" | "side";
export type ColorSource = "palette" | "photo" | "brand";
export type DecorKind = "none" | "frame" | "grain" | "sparkles";
export type CtaStyle = "none" | "pill" | "outline" | "block" | "tag" | "line" | "bar" | "frame";
export type CtaArrow = "none" | "chevron" | "double" | "stem" | "dot";
export type NumberStyle = "none" | "circle" | "square" | "plain" | "hero" | "inline";

export interface CanvasPalette {
  id: string; name: string; bg: string; fg: string; accent: string; soft: string; onAccent: string;
  /** второй акцент (v7.4): рамки фото, второе слово, цифра */
  accent2?: string;
  /** Темы, к которым палитра подходит (v9). */
  themes?: string[];
  /** Настроение палитры (v9). */
  mood?: string[];
  /** Температура: тёплая / холодная / нейтральная (v9). */
  temp?: string;
  /** Можно ли красить акцентом текст на фоне (контраст >= 4.5). */
  accentAsText?: boolean;
  /** Замеры контраста: accent-on-bg, fg-on-bg, onAccent-on-accent. */
  contrast?: { accentOnBg: number; fgOnBg: number; onAccentOnAccent: number };
}

export interface CanvasRecipe {
  v: 5 | 6 | 7;
  family: CanvasFamily;
  layout: string;
  photoCount: number;
  palette: CanvasPalette;
  fonts: { display: string; sans: string; body: string; script?: string };
  fontPair: string;
  titleFont: "display" | "sans";
  titleCase: "upper" | "title" | "sentence";
  titleWeight: number;
  titleAlign: "left" | "center";
  textZone: TextZone;
  padding: number;
  radius: number;
  gutter: number;
  highlight: TextHighlight;
  decor: DecorKind;
  numberStyle: NumberStyle;
  /** Подложка под текстом для full-bleed макетов. */
  plate?: PlateKind;
  yearStyle: "none" | "pill" | "ribbon";
  ctaStyle: CtaStyle;
  ctaArrow?: CtaArrow;
  ctaCase?: "upper" | "title";
  texture: number;
  overlay: number;
  colorSource?: ColorSource;
  brandAccent?: string;
  accent?: string;
  highlights?: { number?: boolean; year?: boolean; keyword?: boolean; chance?: number };
  /* ---------- v6 ---------- */
  /** Рисованные акценты (звёзды, сердечки, искры) вокруг текста. */
  doodles?: boolean;
  /** Последнее слово заголовка красится акцентом. */
  titleAccentWord?: boolean;
  /** Нижняя лента с доменом вместо мелкой подписи. */
  domainBar?: boolean;
  /** Кикер рукописным шрифтом. */
  scriptKicker?: boolean;
  /** Разрядка заголовка (px). */
  titleTracking?: number;
  /* ---------- v7 (Mix) ---------- */
  /** Набор элементов оформления: подложка, цифра, выделение, кнопка, доп. текст. */
  kit?: KitSpec;
  /** v7.4: шрифты по ролям элементов (строго из одной пары). */
  roleFonts?: { kicker?: string; number?: string; cta?: string; subtext?: string };
  /**
   * v7.5: отношение шаблона к цифре «идей».
   * `required` — композиция построена вокруг цифры, `optional` — цифра
   * вписывается аккуратно, `none` — цифра не рисуется никогда.
   */
  numberMode?: "required" | "optional" | "none";
  /** Версия библиотеки, которой собран шаблон. */
  libVersion?: number;
}

const BASE_PALETTES: CanvasPalette[] = [
  { id: "ink-jade", name: "Ink & Jade", bg: "#F6F3ED", fg: "#17201D", accent: "#007F68", soft: "#DDECE7", onAccent: "#FFFFFF" },
  { id: "cool-blue", name: "Cool Blue", bg: "#F1F7FA", fg: "#132A34", accent: "#4B94B5", soft: "#D9EAF1", onAccent: "#FFFFFF" },
  { id: "persimmon", name: "Persimmon", bg: "#FFF6F0", fg: "#2E1C18", accent: "#E4512A", soft: "#F8DED4", onAccent: "#FFFFFF" },
  { id: "cherry-cream", name: "Cherry Cream", bg: "#FFF8F7", fg: "#281A1D", accent: "#A91F3D", soft: "#F1D8DE", onAccent: "#FFFFFF" },
  { id: "citron-ink", name: "Citron Ink", bg: "#F7F7EC", fg: "#171A18", accent: "#C9D83D", soft: "#EBEEC7", onAccent: "#171A18" },
  { id: "plum-sky", name: "Plum & Sky", bg: "#F7F4F8", fg: "#281D2E", accent: "#72508C", soft: "#E7DDEC", onAccent: "#FFFFFF" },
  { id: "rose-graphite", name: "Rose Graphite", bg: "#FBF4F2", fg: "#222222", accent: "#D17475", soft: "#EEDDDD", onAccent: "#FFFFFF" },
  { id: "cobalt-paper", name: "Cobalt Paper", bg: "#F7F5EF", fg: "#151B31", accent: "#2155A3", soft: "#DCE4F0", onAccent: "#FFFFFF" },
  // --- 2026: тёмные, фешн и мягкие пастельные схемы ---
  { id: "noir-gold", name: "Noir & Gold", bg: "#111010", fg: "#F6F1E7", accent: "#C9A84C", soft: "#2A2724", onAccent: "#1A1508" },
  { id: "espresso-cream", name: "Espresso Cream", bg: "#2B211C", fg: "#F7EFE6", accent: "#E4B98C", soft: "#3E3129", onAccent: "#2B211C" },
  { id: "butter-pop", name: "Butter Pop", bg: "#FFF6DC", fg: "#241F12", accent: "#F0663C", soft: "#FCE7B6", onAccent: "#FFFFFF" },
  { id: "mocha-mousse", name: "Mocha Mousse", bg: "#F3EAE2", fg: "#3B2B22", accent: "#A47764", soft: "#E3D2C4", onAccent: "#FFFFFF" },
  { id: "digital-lilac", name: "Digital Lilac", bg: "#F4F1FF", fg: "#1E1934", accent: "#6C4DF6", soft: "#E2DBFB", onAccent: "#FFFFFF" },
  { id: "matcha-milk", name: "Matcha Milk", bg: "#F2F6EC", fg: "#1E2A1A", accent: "#7FA65C", soft: "#DDE9CE", onAccent: "#FFFFFF" },
  { id: "midnight-mint", name: "Midnight Mint", bg: "#0E1A1A", fg: "#EAF7F2", accent: "#4FD8AC", soft: "#1C2E2C", onAccent: "#082019" },
  { id: "peach-sorbet", name: "Peach Sorbet", bg: "#FFF1EC", fg: "#33201C", accent: "#FF7A5C", soft: "#FBD9CC", onAccent: "#FFFFFF" },
  { id: "ink-blue-night", name: "Ink Blue Night", bg: "#101A2E", fg: "#EDF2FB", accent: "#7FA8FF", soft: "#1D2A44", onAccent: "#0B1424" },
  { id: "clay-blush", name: "Clay Blush", bg: "#FBF1F0", fg: "#2B1E1E", accent: "#C4655C", soft: "#F1D9D6", onAccent: "#FFFFFF" },
  { id: "silver-chrome", name: "Silver Chrome", bg: "#EFF1F4", fg: "#14181F", accent: "#5A6B80", soft: "#DCE1E8", onAccent: "#FFFFFF" },
  { id: "hot-magenta", name: "Hot Magenta", bg: "#1A0F1B", fg: "#FDEBF7", accent: "#F5427E", soft: "#33203A", onAccent: "#FFFFFF" },

  /* ---------- v6: палитры 2027 ---------- */
  { id: "carbon-lime", name: "Carbon Lime", bg: "#0B0B0C", fg: "#F4F5F0", accent: "#D8FF3E", soft: "#1C1D1F", onAccent: "#111200" },
  { id: "ivory-ink", name: "Ivory Ink", bg: "#F7F5F0", fg: "#101010", accent: "#101010", soft: "#E6E2D9", onAccent: "#F7F5F0" },
  { id: "bubblegum", name: "Bubblegum", bg: "#FFF4F8", fg: "#1B0F16", accent: "#FF3D8B", soft: "#FFD9E7", onAccent: "#FFFFFF" },
  { id: "cobalt-flash", name: "Cobalt Flash", bg: "#F2F4FF", fg: "#0B1030", accent: "#2B34FF", soft: "#DCE1FF", onAccent: "#FFFFFF" },
  { id: "terracotta-sun", name: "Terracotta Sun", bg: "#FBF0E6", fg: "#2C1A10", accent: "#D2601A", soft: "#F2DCC6", onAccent: "#FFFFFF" },
  { id: "olive-cream", name: "Olive Cream", bg: "#F4F2E7", fg: "#22261A", accent: "#5E6B32", soft: "#E3E4CE", onAccent: "#FFFFFF" },
  { id: "sky-poster", name: "Sky Poster", bg: "#EAF4FF", fg: "#0D1B2A", accent: "#0F6FE8", soft: "#CFE4FA", onAccent: "#FFFFFF" },
  { id: "violet-noir", name: "Violet Noir", bg: "#140F22", fg: "#F0EAFF", accent: "#A78BFA", soft: "#241A3B", onAccent: "#160F26" },
  { id: "sand-espresso", name: "Sand Espresso", bg: "#EFE7DC", fg: "#2A211B", accent: "#7A4B2A", soft: "#DED2C2", onAccent: "#FFFFFF" },
  { id: "aqua-cream", name: "Aqua Cream", bg: "#EFFAF7", fg: "#0D2A25", accent: "#0FA98A", soft: "#D3F0E8", onAccent: "#FFFFFF" },
  { id: "coral-navy", name: "Coral Navy", bg: "#0F1B33", fg: "#F4F7FF", accent: "#FF6B5A", soft: "#1D2B4A", onAccent: "#FFFFFF" },
  { id: "buttercream", name: "Buttercream", bg: "#FFFBEB", fg: "#241F10", accent: "#E9A400", soft: "#FBEFC4", onAccent: "#241F10" },
  { id: "cocoa-rose", name: "Cocoa Rose", bg: "#F6ECEA", fg: "#301F1E", accent: "#9E5C60", soft: "#E7D3D0", onAccent: "#FFFFFF" },
  { id: "graphite-pop", name: "Graphite Pop", bg: "#1B1D20", fg: "#F1F3F5", accent: "#FF9F1C", soft: "#2A2E33", onAccent: "#1B1200" },
  { id: "mint-print", name: "Mint Print", bg: "#EFF7F0", fg: "#12251A", accent: "#2F9E5E", soft: "#D6EDDC", onAccent: "#FFFFFF" },
  { id: "electric-plum", name: "Electric Plum", bg: "#FAF3FF", fg: "#20112C", accent: "#8B2FD6", soft: "#EBDBF8", onAccent: "#FFFFFF" },

  /* ---------- v7.4: современные оттенки, второй акцент ---------- */
  { id: "tech-noir", name: "Tech Noir", bg: "#0B0D10", fg: "#EDF2F7", accent: "#4ADE80", soft: "#151A20", onAccent: "#06210F", accent2: "#38BDF8" },
  { id: "espresso-cream", name: "Espresso Cream", bg: "#F5EFE6", fg: "#2B1D14", accent: "#8C5A34", soft: "#E4D7C6", onAccent: "#FFF8F0", accent2: "#C98F55" },
  { id: "digital-lilac", name: "Digital Lilac", bg: "#F4F1FF", fg: "#1C1633", accent: "#6D5AE6", soft: "#E3DDFB", onAccent: "#FFFFFF", accent2: "#FF7AC6" },
  { id: "matcha-ink", name: "Matcha Ink", bg: "#F2F6EC", fg: "#182016", accent: "#5C8B2A", soft: "#DFEBCE", onAccent: "#FFFFFF", accent2: "#D97706" },
  { id: "cyber-lime", name: "Cyber Lime", bg: "#10131A", fg: "#F2FFE9", accent: "#C6FF3D", soft: "#1B2130", onAccent: "#151C05", accent2: "#8B5CF6" },
  { id: "peach-fizz", name: "Peach Fizz", bg: "#FFF4EE", fg: "#2E1B14", accent: "#FF7F51", soft: "#FFE0D0", onAccent: "#FFFFFF", accent2: "#1F7A8C" },
  { id: "arctic-blue", name: "Arctic Blue", bg: "#F1F7FB", fg: "#0C1F2C", accent: "#1B7FA8", soft: "#D6E9F4", onAccent: "#FFFFFF", accent2: "#F26430" },
  { id: "clay-terracotta", name: "Clay Terracotta", bg: "#FBF1EA", fg: "#2C1A12", accent: "#C05621", soft: "#F0DBCB", onAccent: "#FFFFFF", accent2: "#2F6B5E" },
  { id: "midnight-gold", name: "Midnight Gold", bg: "#0F1524", fg: "#F5F0E1", accent: "#E9C46A", soft: "#1B2436", onAccent: "#1A1405", accent2: "#7DD3FC" },
  { id: "sage-linen", name: "Sage Linen", bg: "#F3F5F0", fg: "#1D2820", accent: "#7C9473", soft: "#E1E8DA", onAccent: "#FFFFFF", accent2: "#B4654A" },
  { id: "berry-milk", name: "Berry Milk", bg: "#FFF3F6", fg: "#2A101B", accent: "#D6336C", soft: "#FBDDE7", onAccent: "#FFFFFF", accent2: "#3D5A80" },
  { id: "graphite-mint", name: "Graphite Mint", bg: "#1A1E1D", fg: "#EAF5F1", accent: "#5EEAD4", soft: "#252B2A", onAccent: "#04211C", accent2: "#FBBF24" },
  { id: "sunbaked", name: "Sunbaked", bg: "#FFF8E7", fg: "#2A2113", accent: "#E4761B", soft: "#FAE9C6", onAccent: "#FFFFFF", accent2: "#146356" },
  { id: "denim-sand", name: "Denim Sand", bg: "#F2F0EA", fg: "#141C2B", accent: "#33507A", soft: "#DDE2E8", onAccent: "#FFFFFF", accent2: "#D98E36" },
  { id: "neon-noir", name: "Neon Noir", bg: "#0A0A0F", fg: "#F7F7FB", accent: "#FF3D81", soft: "#16161F", onAccent: "#FFFFFF", accent2: "#3DD6FF" },
  { id: "olive-paper", name: "Olive Paper", bg: "#F7F5EC", fg: "#22261A", accent: "#6B7A3A", soft: "#E6E6D2", onAccent: "#FFFFFF", accent2: "#A8451F" },
  { id: "cloud-cobalt", name: "Cloud Cobalt", bg: "#F4F6FF", fg: "#111536", accent: "#2A44C4", soft: "#DDE3FB", onAccent: "#FFFFFF", accent2: "#FF8A3D" },
  { id: "cocoa-mint", name: "Cocoa Mint", bg: "#F6F1EC", fg: "#2A1F1A", accent: "#4E7B62", soft: "#E5DCD2", onAccent: "#FFFFFF", accent2: "#B4552F" },
  { id: "plum-butter", name: "Plum Butter", bg: "#FCF6F0", fg: "#2A1330", accent: "#6C2F7C", soft: "#EFE0EE", onAccent: "#FFFFFF", accent2: "#EFA33B" },
  { id: "steel-coral", name: "Steel Coral", bg: "#EEF1F3", fg: "#161D22", accent: "#3E5C6B", soft: "#DCE3E7", onAccent: "#FFFFFF", accent2: "#FF6B5A" },
  { id: "vanilla-noir", name: "Vanilla Noir", bg: "#12100E", fg: "#F8F2E7", accent: "#F1D6A5", soft: "#1E1B17", onAccent: "#20180C", accent2: "#8FBF9F" },
  { id: "ocean-sorbet", name: "Ocean Sorbet", bg: "#EEF9F8", fg: "#0B2A2C", accent: "#0F8B8D", soft: "#D3EEEC", onAccent: "#FFFFFF", accent2: "#EC6A5C" },
  { id: "grape-soda", name: "Grape Soda", bg: "#F7F3FF", fg: "#1B1030", accent: "#5B2AC4", soft: "#E4D9FA", onAccent: "#FFFFFF", accent2: "#22C55E" },
  { id: "toffee-sky", name: "Toffee Sky", bg: "#FBF6F1", fg: "#241A12", accent: "#A46A34", soft: "#EDE0D2", onAccent: "#FFFFFF", accent2: "#3B82C4" },
  { id: "moss-cream", name: "Moss Cream", bg: "#F6F7F1", fg: "#1B241B", accent: "#3F6B3B", soft: "#E2E9DA", onAccent: "#FFFFFF", accent2: "#D4763A" },
  { id: "ink-tangerine", name: "Ink Tangerine", bg: "#14161C", fg: "#F5F6FA", accent: "#FF8C42", soft: "#20242E", onAccent: "#1B0E03", accent2: "#5EEAD4" },
  { id: "pearl-rose", name: "Pearl Rose", bg: "#FDF6F7", fg: "#2A1A1E", accent: "#C46A7A", soft: "#F3E1E5", onAccent: "#FFFFFF", accent2: "#4B6B8A" },
  { id: "harbor-blue", name: "Harbor Blue", bg: "#EFF4F7", fg: "#0E1E2A", accent: "#155E75", soft: "#D8E5EC", onAccent: "#FFFFFF", accent2: "#F2A65A" },
  { id: "chili-paper", name: "Chili Paper", bg: "#FAF6F2", fg: "#26160F", accent: "#C1442E", soft: "#EFDFD5", onAccent: "#FFFFFF", accent2: "#2E6E5B" },
  { id: "pistachio-pop", name: "Pistachio Pop", bg: "#F4FBEF", fg: "#16240F", accent: "#68A63A", soft: "#DEF0CE", onAccent: "#FFFFFF", accent2: "#E4572E" },
  { id: "smoke-amber", name: "Smoke Amber", bg: "#1C1C1E", fg: "#F2F1EE", accent: "#F5A524", soft: "#292A2E", onAccent: "#1F1403", accent2: "#8ECAE6" },
  { id: "orchid-slate", name: "Orchid Slate", bg: "#F5F4F8", fg: "#191826", accent: "#7B4BC4", soft: "#E3E0EE", onAccent: "#FFFFFF", accent2: "#0EA5A5" },
  { id: "honey-forest", name: "Honey Forest", bg: "#FBF7EA", fg: "#1A2418", accent: "#2F5D3A", soft: "#E9E3CC", onAccent: "#FFFFFF", accent2: "#D99E27" },
  { id: "concrete-lime", name: "Concrete Lime", bg: "#F0F0EE", fg: "#1C1D1B", accent: "#5C6B2F", soft: "#DEDEDA", onAccent: "#FFFFFF", accent2: "#C2410C" },
  { id: "night-rose", name: "Night Rose", bg: "#160E14", fg: "#FBF0F5", accent: "#F472B6", soft: "#241723", onAccent: "#2A0A1B", accent2: "#A5F3FC" },
];

/** Дубли id в базовом списке (как в паке v9: fixes.renamePaletteIds). */
const PALETTE_RENAMES: Record<string, string> = {
  "espresso-cream": "espresso-latte",
  "digital-lilac": "digital-lilac-pop",
};

/** Дописывает замеры контраста и флаг `accentAsText`. */
export function enrichPalette(p: CanvasPalette): CanvasPalette {
  const accentOnBg = Math.round(contrast(p.accent, p.bg) * 100) / 100;
  const fgOnBg = Math.round(contrast(p.fg, p.bg) * 100) / 100;
  const onAccentOnAccent = Math.round(contrast(p.onAccent, p.accent) * 100) / 100;
  return { ...p, accentAsText: accentOnBg >= 4.5, contrast: { accentOnBg, fgOnBg, onAccentOnAccent } };
}

/** Базовые палитры с починенными дублями id и замерами контраста. */
export const CANVAS_PALETTES: CanvasPalette[] = (() => {
  const seen = new Set<string>();
  const out: CanvasPalette[] = [];
  BASE_PALETTES.forEach((p) => {
    let id = p.id;
    if (seen.has(id)) id = PALETTE_RENAMES[id] || `${id}-2`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(enrichPalette({ ...p, id }));
  });
  return out;
})();

export const CANVAS_PALETTE_MAP = new Map(CANVAS_PALETTES.map((p) => [p.id, p]));

/** Палитры с читаемым акцентом — для текстовых ролей. */
export const palettesWithTextAccent = (): CanvasPalette[] => CANVAS_PALETTES.filter((p) => p.accentAsText);
