/**
 * Фото статьи + плашка с текстом (как Canvas-пин, но без обрезки кадра): холст шириной 1000 px, фото целиком,
 * над или под ним — плашка с маленькой надписью (кикер), заголовком и доменом сайта. Шрифты — пары из библиотеки
 * Canvas пинов (src/lib/pins/canvas/fonts.ts), цвета — проверенные по контрасту палитры (paletteLibrary.ts).
 * Вариант (место плашки, стиль, палитра, пара шрифтов) выбирается детерминированно по seed (id фото), чтобы картинки
 * в статье и на сайте отличались, а повторный рендер давал то же самое.
 * Работает только там, где задан хост canvas (воркер: installNodeCanvasHost в worker/index.ts).
 */
import { getHost, asImageSource, type Ctx2D } from "@/lib/pins/canvas/host";
import { CANVAS_FONT_PAIRS, fontClass, pairFontFor, type FontPair } from "@/lib/pins/canvas/fonts";
import { BOLD_PALETTES } from "@/lib/pins/canvas/paletteLibrary";
import { hashSeed, mulberry } from "@/lib/pins/canvas/composer";

export type OverlayText = { title: string; kicker?: string; domain?: string };
export type OverlayStyle = "solid" | "strip" | "framed";
export type OverlayResult = { bytes: Buffer; width: number; height: number; variant: { place: "top" | "bottom"; style: OverlayStyle; palette: string; fonts: string } };

const W = 1000;
const PAD = 56;

function pickPair(rnd: () => number): FontPair {
  const host = getHost();
  const ok = CANVAS_FONT_PAIRS.filter((p) => p.scripts.includes("latin") && host.hasFont(p.display) && host.hasFont(p.sans) && fontClass(p.display) !== "script" && fontClass(p.sans) !== "script");
  const pool = ok.length ? ok : CANVAS_FONT_PAIRS;
  return pool[Math.floor(rnd() * pool.length)] ?? pool[0];
}

/** Перенос по словам в ширину; строк не больше maxLines (последняя с многоточием не режется — уменьшаем кегль выше). */
function wrap(ctx: Ctx2D, text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= width || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Кегль заголовка: самый крупный, при котором текст укладывается в maxLines и каждое слово — в ширину. */
function fitTitle(ctx: Ctx2D, text: string, family: string, weight: number, width: number, maxLines: number): { size: number; lines: string[] } {
  for (let size = 92; size >= 40; size -= 4) {
    ctx.font = `${weight} ${size}px "${family}"`;
    const lines = wrap(ctx, text, width);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= width)) return { size, lines };
  }
  ctx.font = `${weight} 40px "${family}"`;
  return { size: 40, lines: wrap(ctx, text, width).slice(0, maxLines) };
}

function spaced(text: string, spacing: number): string {
  // Разрядка для кикера: Skia не везде поддерживает letterSpacing — вставляем тонкие пробелы.
  return spacing > 0 ? text.split("").join(" ") : text;
}

export async function renderPinOverlay(photo: Buffer, text: OverlayText, seed: string): Promise<OverlayResult> {
  const host = getHost();
  const rnd = mulberry(hashSeed(seed, "blog-overlay"));
  const img = await host.loadImage(photo);
  const palette = BOLD_PALETTES[Math.floor(rnd() * BOLD_PALETTES.length)] ?? BOLD_PALETTES[0];
  const pair = pickPair(rnd);
  const style: OverlayStyle = (["solid", "strip", "framed"] as const)[Math.floor(rnd() * 3)];
  const place: "top" | "bottom" = rnd() < 0.5 ? "top" : "bottom";
  const titleFamily = pairFontFor(pair, "title", Math.floor(rnd() * 2));
  const kickerFamily = pairFontFor(pair, "kicker");
  const titleUpper = rnd() < 0.35 && text.title.length <= 34;

  // Размер фото на холсте: во «framed» — с полями цвета плашки вокруг.
  const margin = style === "framed" ? 36 : 0;
  const pw = W - margin * 2;
  const ph = Math.round((img.height / img.width) * pw);

  // Раскладка текста плашки
  const measure = host.createCanvas(10, 10).getContext("2d");
  const textW = W - PAD * 2;
  const title = titleUpper ? text.title.toUpperCase() : text.title;
  const t = fitTitle(measure, title, titleFamily, 700, textW, 3);
  const lineH = Math.round(t.size * 1.12);
  const kickerSize = 26;
  const domainSize = 22;
  const kicker = (text.kicker ?? "").trim().toUpperCase().slice(0, 32);
  const domain = (text.domain ?? "").trim().toLowerCase();
  const bandH = PAD + (kicker ? kickerSize + 18 : 0) + t.lines.length * lineH + (domain ? 18 + domainSize : 0) + PAD;
  const H = margin + ph + bandH;

  const canvas = host.createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, W, H);

  const photoY = place === "top" ? bandH : margin;
  const bandY = place === "top" ? 0 : margin + ph;
  ctx.drawImage(asImageSource(img), margin, photoY, pw, ph);
  if (style === "strip") {
    // Тонкая полоса акцента на стыке фото и плашки
    ctx.fillStyle = palette.accent;
    const y = place === "top" ? bandH - 8 : margin + ph;
    ctx.fillRect(0, y, W, 8);
  }

  // Текст плашки
  let y = bandY + PAD;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  if (kicker) {
    ctx.font = `700 ${kickerSize}px "${kickerFamily}"`;
    const kw = ctx.measureText(spaced(kicker, 1)).width + 36;
    if (style === "solid") {
      ctx.fillStyle = palette.accent;
      ctx.fillRect(W / 2 - kw / 2, y - 8, kw, kickerSize + 16);
      ctx.fillStyle = palette.onAccent;
    } else {
      ctx.fillStyle = palette.accentAsText ? palette.accent : palette.fg;
    }
    ctx.fillText(spaced(kicker, 1), W / 2, y);
    y += kickerSize + 18;
  }
  ctx.fillStyle = palette.fg;
  ctx.font = `700 ${t.size}px "${titleFamily}"`;
  for (const line of t.lines) {
    ctx.fillText(line, W / 2, y);
    y += lineH;
  }
  if (domain) {
    y += 18;
    ctx.globalAlpha = 0.78;
    ctx.font = `500 ${domainSize}px "${kickerFamily}"`;
    ctx.fillStyle = palette.fg;
    ctx.fillText(domain, W / 2, y);
    ctx.globalAlpha = 1;
  }

  const bytes = await host.encodeJpeg(canvas, 0.86);
  return { bytes, width: W, height: H, variant: { place, style, palette: palette.id, fonts: pair.id } };
}

/** Текст плашки: заголовок 3–9 слов без точки, кикер до 3 слов; пустой заголовок — без плашки. */
export function normalizeOverlayText(raw: { title?: unknown; kicker?: unknown }): { title: string; kicker: string } | null {
  const title = String(raw.title ?? "").replace(/[“”"«»]/g, "").replace(/[.!]+$/, "").replace(/\s+/g, " ").trim().slice(0, 70);
  if (title.split(" ").length < 2) return null;
  const kicker = String(raw.kicker ?? "").replace(/[“”"«».!]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  return { title, kicker };
}
