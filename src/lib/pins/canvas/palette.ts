/**
 * Цвет для canvas-пинов: гармонии, контраст (WCAG), палитра из фото.
 * Доминанты фото считаются через host.createCanvas (без document).
 */
import { asImageSource, getHost, type HostImage } from "./host";

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0));
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const H = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let T = t; if (T < 0) T += 1; if (T > 1) T -= 1;
    if (T < 1 / 6) return p + (q - p) * 6 * T;
    if (T < 1 / 2) return q;
    if (T < 2 / 3) return p + (q - p) * (2 / 3 - T) * 6;
    return p;
  };
  return { r: f(H + 1 / 3) * 255, g: f(H) * 255, b: f(H - 1 / 3) * 255 };
}

export function hsl(h: number, s: number, l: number): string {
  return rgbToHex(hslToRgb({ h, s, l }));
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function shift(hex: string, dh = 0, ds = 0, dl = 0): string {
  const c = rgbToHsl(hexToRgb(hex));
  return hsl(c.h + dh, clamp01(c.s + ds), clamp01(c.l + dl));
}

/* ---------- контраст ---------- */

function lin(c: number) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Читаемый цвет текста на фоне bg (не чистый чёрный/белый). */
export function readableOn(bg: string, prefer?: string): string {
  if (prefer && contrast(prefer, bg) >= 4.5) return prefer;
  const dark = "#171310", light = "#fbf8f4";
  const cd = contrast(dark, bg), cl = contrast(light, bg);
  if (Math.max(cd, cl) >= 4.5) return cd >= cl ? dark : light;
  const base = prefer || (cd >= cl ? dark : light);
  const c = rgbToHsl(hexToRgb(base));
  const up = luminance(bg) < 0.4;
  for (let i = 0; i <= 20; i++) {
    const cand = hsl(c.h, c.s, clamp01(up ? c.l + i * 0.05 : c.l - i * 0.05));
    if (contrast(cand, bg) >= 4.5) return cand;
  }
  return up ? "#ffffff" : "#000000";
}

/** Плотность скрима (0.25..0.55) для текста поверх фото. */
export function scrimFor(avgLum: number, textLight = true): number {
  if (textLight) return Math.max(0.25, Math.min(0.55, 0.25 + avgLum * 0.45));
  return Math.max(0.25, Math.min(0.55, 0.7 - avgLum * 0.45));
}

/* ---------- извлечение цветов из фото ---------- */

const cache = new WeakMap<HostImage, string[]>();

/** 4-6 доминант фото (hex), отсортированы по весу. */
export function dominantColors(img: HostImage, k = 6): string[] {
  const hit = cache.get(img);
  if (hit) return hit;
  const S = 64;
  let out: string[] = ["#f4efe9", "#2a2420", "#c2705a"];
  try {
    const ctx = getHost().createCanvas(S, S).getContext("2d");
    ctx.drawImage(asImageSource(img), 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data;
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b;
      buckets.set(key, e);
    }
    out = Array.from(buckets.values())
      .sort((a, b) => b.n - a.n)
      .slice(0, k)
      .map((e) => rgbToHex({ r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }));
  } catch { /* остаёмся на дефолте */ }
  cache.set(img, out);
  return out;
}

/** Средняя яркость фото 0..1 (для скрима). */
export function averageLuminance(img: HostImage): number {
  const cols = dominantColors(img);
  return cols.reduce((s, c) => s + luminance(c), 0) / Math.max(1, cols.length);
}

export interface PhotoPalette {
  bg: string; fg: string; accent: string; onAccent: string; soft: string;
}

/**
 * Палитра из фото: нейтральный фон, средний тон для карточек, один насыщенный
 * акцент (аналогичный ±20-40° или комплементарный ±150-180°).
 */
export function paletteFromPhoto(img: HostImage, seed = 0): PhotoPalette {
  const cols = dominantColors(img);
  const hsls = cols.map((c) => ({ hex: c, ...rgbToHsl(hexToRgb(c)) }));
  const vivid = [...hsls].sort((a, b) => b.s * (1 - Math.abs(b.l - 0.5)) - a.s * (1 - Math.abs(a.l - 0.5)))[0] || hsls[0];
  const dark = luminance(cols[0]) < 0.35 && seed % 4 === 0;

  const bg = dark
    ? hsl(vivid.h, Math.min(0.18, vivid.s * 0.4), 0.11)
    : hsl(vivid.h, Math.min(0.16, vivid.s * 0.35), 0.95);
  const soft = dark
    ? hsl(vivid.h, Math.min(0.2, vivid.s * 0.5), 0.2)
    : hsl(vivid.h, Math.min(0.22, vivid.s * 0.5), 0.88);

  const rot = seed % 3 === 0 ? 168 : seed % 3 === 1 ? 28 : -34;
  const accent = hsl(
    vivid.h + rot,
    Math.max(0.5, Math.min(0.86, vivid.s + 0.22)),
    dark ? 0.6 : Math.min(0.52, Math.max(0.36, vivid.l)),
  );
  const fg = readableOn(bg, dark ? "#f6f1ea" : "#1d1712");
  const onAccent = readableOn(accent, "#ffffff");
  return { bg, fg, accent, onAccent, soft };
}
