/**
 * Библиотека сочных палитр для Canvas-стилей и их «подмешивание» в стили каталога.
 *
 * Старые шаблоны почти все шли с одной бледной палитрой (кремовый фон, тёмный текст).
 * Здесь — насыщенные фоны, тёмные фоны и светлые с ярким акцентом. Все проверены:
 * текст на фоне ≥ 4.5, текст на акценте ≥ 3 (правила validateStyle).
 */
import type { CanvasPalette } from "./recipe";
import type { StyleSpec } from "./styleSpec";

export type PaletteMood = "bold" | "dark" | "light";

const P = (id: string, name: string, mood: PaletteMood, bg: string, fg: string, accent: string, soft: string, onAccent: string, accent2?: string): CanvasPalette & { mood: string[] } =>
  ({ id, name, bg, fg, accent, soft, onAccent, ...(accent2 ? { accent2 } : {}), mood: [mood] });

export const BOLD_PALETTES: Array<CanvasPalette & { mood: string[] }> = [
  // Насыщенный фон, светлый текст
  P("zx-cobalt-pop", "Cobalt Pop", "bold", "#1E3FBF", "#FFFFFF", "#FFD23F", "#2F55D6", "#1A1A1A"),
  P("zx-emerald-bold", "Emerald Bold", "bold", "#0F7A5A", "#FFFFFF", "#FFC857", "#1F8F6C", "#1A1A1A"),
  P("zx-brick-punch", "Brick Punch", "bold", "#C23A22", "#FFFFFF", "#FFE66D", "#D04A31", "#1A1A1A"),
  P("zx-plum-velvet", "Plum Velvet", "bold", "#4B1D6E", "#FFF4F9", "#FF7BAC", "#5E2B86", "#1A1A1A"),
  P("zx-teal-tangerine", "Teal Tangerine", "bold", "#0E5C6B", "#FFFFFF", "#FF8C42", "#167283", "#1A1A1A"),
  P("zx-royal-blue", "Royal Blue", "bold", "#1B5FAE", "#FFFFFF", "#FFD166", "#2A6FC0", "#1A1A1A"),
  P("zx-olive-sand", "Olive Sand", "bold", "#5B6B2F", "#FFFFFF", "#F4D35E", "#6B7B3A", "#1A1A1A"),
  P("zx-ocean-sun", "Ocean Sun", "bold", "#0B3C5D", "#FFFFFF", "#F9A620", "#124B70", "#1A1A1A"),
  P("zx-wine-blush", "Wine Blush", "bold", "#5A1A2E", "#FFF5F7", "#F6A5B9", "#6E2740", "#1A1A1A"),
  P("zx-terracotta", "Terracotta", "bold", "#B5532F", "#FFFFFF", "#FFE1C4", "#C4643F", "#1A1A1A"),
  P("zx-mustard-ink", "Mustard Ink", "bold", "#E9B824", "#1B1B1B", "#1B1B1B", "#F2C94C", "#FFFFFF"),
  P("zx-lemon-black", "Lemon Black", "bold", "#F6E86B", "#1A1A1A", "#1A1A1A", "#FBF08E", "#F6E86B"),
  // Тёмный фон, яркий акцент
  P("zx-midnight-lime", "Midnight Lime", "dark", "#141A2A", "#FFFFFF", "#C6F432", "#222B40", "#141A2A"),
  P("zx-espresso-gold", "Espresso Gold", "dark", "#2B1B12", "#FFF3E6", "#E7B45A", "#3C2819", "#2B1B12"),
  P("zx-navy-peach", "Navy Peach", "dark", "#11213B", "#FFFFFF", "#FFB38A", "#1C2F50", "#11213B"),
  P("zx-cherry-black", "Cherry Black", "dark", "#171717", "#FFFFFF", "#E63946", "#262626", "#FFFFFF"),
  // Светлый фон, но сильный акцент
  P("zx-hotpink-cream", "Hot Pink Cream", "light", "#FFF1F5", "#1E1216", "#E0206B", "#FFD6E3", "#FFFFFF"),
  P("zx-forest-cream", "Forest Cream", "light", "#F3F0E6", "#17241C", "#1F6B3A", "#DCE8D8", "#FFFFFF"),
  P("zx-rust-cream", "Rust Cream", "light", "#FBF3EA", "#2A1A12", "#B8441F", "#F2DCCB", "#FFFFFF"),
  P("zx-lavender-ink", "Lavender Ink", "light", "#EDE7FF", "#1F1638", "#5B2DC9", "#DCD2FA", "#FFFFFF"),
  P("zx-mint-ink", "Mint Ink", "light", "#DFF5EC", "#0F2A22", "#0E7C5B", "#C6EBDC", "#FFFFFF"),

  /* ---------- 2027: тон-в-тон (fg/bg ≥ 10, акцент того же цвета темнее) ---------- */
  P("zx-choco-cream", "Шоколад на сливочном", "light", "#F6E7D3", "#3B2115", "#5A3321", "#EBD5BB", "#FFF4E6", "#B8652E"),
  P("zx-cherry-rose", "Вишня на розовом", "light", "#F9D7DC", "#5A0E1E", "#8E1431", "#F2C3CB", "#FFF2F4", "#D4506A"),
  P("zx-graphite-butter", "Графит на масляном", "bold", "#F3D86B", "#23262B", "#2E3238", "#EFCF52", "#F7E9A8", "#C2410C"),
  P("zx-olive-pistachio", "Олива на фисташковом", "light", "#D9E6B8", "#22301A", "#3C5224", "#CBDBA3", "#EEF5DD", "#B4552F"),
  /* ---------- 2027: молочно-белый Cloud Dancer + один горячий акцент ---------- */
  P("zx-cloud-coral", "Cloud Dancer + коралл", "light", "#F2F0EB", "#1F1E1B", "#E24A32", "#E7E3DB", "#FFFFFF", "#1F3FD1"),
  P("zx-cloud-cobalt", "Cloud Dancer + кобальт", "light", "#F2F0EB", "#15192E", "#1F3FD1", "#E4E3DE", "#FFFFFF", "#E24A32"),
  P("zx-cloud-lime", "Cloud Dancer + лайм", "light", "#F2F0EB", "#1B2012", "#B9E53D", "#E6E4DD", "#1B2012", "#1F3FD1"),
  /* ---------- 2027: сезонные ---------- */
  P("zx-winter-ice", "Зимняя ледяная", "light", "#E6F2FA", "#0E2A42", "#1F5F9E", "#CFE4F2", "#FFFFFF", "#E8614D"),
  P("zx-xmas-bordeaux", "Рождество: бордо и ель", "dark", "#5C0F1E", "#FFF6EC", "#2F7A4B", "#74192B", "#FFFFFF", "#E9C46A"),
  P("zx-autumn-ochre", "Осень: охра и бургунди", "bold", "#D9A441", "#4A1020", "#6E1327", "#CF9633", "#FFF1E3", "#2F3A1F"),
  P("zx-spring-lilac", "Весна: сирень и лайм", "light", "#EBDDF5", "#2A1A3A", "#6FA81A", "#DFCBEE", "#13200A", "#7C3AED"),
  P("zx-summer-azure", "Лето: лазурь и лимон", "bold", "#0A6BB0", "#FFFFFF", "#FFE94A", "#1A7BC2", "#1A1A1A", "#FF8A3D"),
  /* ---------- 2027: чёрный + неон ---------- */
  P("zx-black-neon-lime", "Чёрный + неоновый лайм", "dark", "#0B0B0B", "#FFFFFF", "#D4FF3F", "#1A1A1A", "#0B0B0B", "#FF3DA6"),
  P("zx-black-neon-pink", "Чёрный + неоновый розовый", "dark", "#0B0B0B", "#FFFFFF", "#FF3DA6", "#1A1A1A", "#0B0B0B", "#3DF0FF"),
  P("zx-violet-neon", "Фиолет + кислотный лимон", "dark", "#2A0F5E", "#FFFFFF", "#E8FF4D", "#3A1A78", "#1A1A1A", "#FF7AC6"),
  /* ---------- 2027: матовая бумага (под зерно и антикву) ---------- */
  P("zx-paper-ink", "Бумага и чернила", "light", "#EFE9DC", "#2A2622", "#9A4B2A", "#E3DCCB", "#FFF7EE", "#3F5E4A"),
  P("zx-sage-paper", "Шалфей на бумаге", "light", "#E7E6D9", "#2A3028", "#4F6A5A", "#D9D8C8", "#FFFFFF", "#B4654A"),
];

export const BOLD_PALETTE_MAP = new Map(BOLD_PALETTES.map((p) => [p.id, p]));

/** Ревизия спецификации, с которой стиль уже получил сочные палитры. */
export const PALETTE_REV = 2;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Добавляет стилю палитры из библиотеки: к его родной палитре докладываются
 * одна насыщенная, одна тёмная и одна светлая с сильным акцентом (до 4 всего).
 * Выбор детерминирован по id стиля, чтобы повторный запуск ничего не менял.
 * Для стилей с accentWord подходят только палитры, где акцент читается на фоне.
 */
export function attachBoldPalettes(spec: StyleSpec, key: string): StyleSpec {
  if ((spec.rev ?? 1) >= PALETTE_REV) return spec;
  const own = spec.palettes.filter((p) => !p.id.startsWith("zx-")).slice(0, 1);
  const have = new Set(own.map((p) => p.id));
  const h = hash(key);
  const out = [...own];
  const moods: PaletteMood[] = ["bold", "dark", "light"];
  moods.forEach((mood, i) => {
    const pool = BOLD_PALETTES.filter((p) => p.mood[0] === mood && !have.has(p.id));
    if (!pool.length) return;
    const pick = pool[(h >>> (i * 7)) % pool.length];
    const { mood: _m, ...plain } = pick;
    out.push(plain);
    have.add(pick.id);
  });
  return { ...spec, rev: PALETTE_REV, palettes: out.slice(0, 4) };
}
