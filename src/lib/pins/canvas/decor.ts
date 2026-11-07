/**
 * Декор и акценты текста (порт canvasDecor.ts): маркер, подчёркивание, чип,
 * бокс, градиент, крупная цифра, бейдж года, стикеры, фактуры.
 */
import { PIN_H, PIN_W } from "./crop";
import { shift } from "./palette";
import { mulberry, type Rect } from "./composer";
import type { Ctx2D } from "./host";

export interface DecorColors {
  bg: string; fg: string; accent: string; onAccent: string; soft?: string;
}

export function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/* ---------- подсветка слова ---------- */

export function markerSwipe(ctx: Ctx2D, x: number, y: number, w: number, h: number, color: string, seed = 1): void {
  const rnd = mulberry(seed);
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = color;
  ctx.beginPath();
  const x0 = x - 10, x1 = x + w + 12;
  const yTop = y - h * 0.72 + rnd() * 4;
  const yBot = y + h * 0.16;
  ctx.moveTo(x0, yTop + 6);
  ctx.quadraticCurveTo((x0 + x1) / 2, yTop - 6 + rnd() * 6, x1, yTop + 2);
  ctx.lineTo(x1 - 4, yBot);
  ctx.quadraticCurveTo((x0 + x1) / 2, yBot + 8 - rnd() * 6, x0 + 2, yBot - 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function underlineWord(ctx: Ctx2D, x: number, y: number, w: number, size: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(4, size * 0.09);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - 4, y + size * 0.16);
  ctx.quadraticCurveTo(x + w / 2, y + size * 0.26, x + w + 6, y + size * 0.13);
  ctx.stroke();
  ctx.restore();
}

export function chipBehind(ctx: Ctx2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  const bh = h * 1.14;
  roundRect(ctx, x - 18, y - h * 0.82, w + 36, bh, bh / 2);
  ctx.fill();
  ctx.restore();
}

export function boxAround(ctx: Ctx2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  roundRect(ctx, x - 14, y - h * 0.86, w + 28, h * 1.2, 8);
  ctx.stroke();
  ctx.restore();
}

/** Градиентная заливка текста (для одного слова / строки). */
export function gradientFill(ctx: Ctx2D, x: number, w: number, from: string, to: string): CanvasGradient {
  const g = ctx.createLinearGradient(x, 0, x + Math.max(1, w), 0);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  return g;
}

/* ---------- бейджи ---------- */

/** Крупная цифра в круге/квадрате/блобе. Возвращает занятую ширину. */
export function bigNumber(
  ctx: Ctx2D, n: string, cx: number, cy: number, size: number,
  c: DecorColors, font: string, shape: "circle" | "square" | "blob" | "plain" = "circle",
): number {
  ctx.save();
  ctx.font = `800 ${size}px "${font}"`;
  const tw = ctx.measureText(n).width;
  const r = Math.max(tw, size) * 0.72;
  if (shape !== "plain") {
    ctx.fillStyle = c.accent;
    if (shape === "circle") { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); }
    else if (shape === "square") { roundRect(ctx, cx - r, cy - r, r * 2, r * 2, 18); ctx.fill(); }
    else {
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
        const rr = r * (0.92 + 0.1 * Math.sin(a * 3));
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.fillStyle = shape === "plain" ? c.accent : c.onAccent;
  ctx.textBaseline = "middle";
  ctx.fillText(n, cx - tw / 2, cy + 2);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
  return r * 2;
}

/** Бейдж года: пилюля или уголок-лента. */
export function yearBadge(
  ctx: Ctx2D, text: string, c: DecorColors, font: string,
  corner: "tl" | "tr" | "bl" | "br" = "tr", style: "pill" | "ribbon" | "sticker" = "pill",
): Rect {
  const size = 34;
  ctx.save();
  ctx.font = `800 ${size}px "${font}"`;
  const tw = ctx.measureText(text).width;
  const w = tw + 56, h = size + 34;
  const m = 44;
  const x = corner === "tl" || corner === "bl" ? m : PIN_W - m - w;
  const y = corner === "tl" || corner === "tr" ? m : PIN_H - m - h;
  if (style === "sticker") {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(-0.08);
    ctx.translate(-(x + w / 2), -(y + h / 2));
    ctx.fillStyle = "#ffffff";
    roundRect(ctx, x - 6, y - 6, w + 12, h + 12, (h + 12) / 2);
    ctx.fill();
  }
  ctx.fillStyle = c.accent;
  roundRect(ctx, x, y, w, h, style === "ribbon" ? 6 : h / 2);
  ctx.fill();
  ctx.fillStyle = c.onAccent;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 28, y + h / 2 + 1);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
  return { x, y, w, h };
}

/** Размеры бейджа года до рисования. */
export function measureYearBadge(ctx: Ctx2D, text: string, font: string): { w: number; h: number } {
  ctx.save();
  ctx.font = `800 34px "${font}"`;
  const w = ctx.measureText(text).width + 56;
  ctx.restore();
  return { w, h: 68 };
}

/** Наклонный стикер-подпись. */
export function sticker(
  ctx: Ctx2D, text: string, cx: number, cy: number,
  c: DecorColors, font: string, angle = -0.06, size = 30,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.font = `800 ${size}px "${font}"`;
  const t = text.toUpperCase();
  const tw = ctx.measureText(t).width;
  const w = tw + 52, h = size + 30;
  ctx.fillStyle = c.accent;
  roundRect(ctx, -w / 2, -h / 2, w, h, 10);
  ctx.fill();
  ctx.fillStyle = c.onAccent;
  ctx.textBaseline = "middle";
  ctx.fillText(t, -tw / 2, 1);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

/* ---------- фактуры и заполнение пустоты ---------- */

export function grain(ctx: Ctx2D, alpha = 0.05, seed = 7): void {
  const rnd = mulberry(seed);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 4200; i++) {
    ctx.fillStyle = i % 2 ? "#ffffff" : "#000000";
    ctx.fillRect(rnd() * PIN_W, rnd() * PIN_H, 2, 2);
  }
  ctx.restore();
}

/** Мягкий фон под текстовой зоной. */
export function softField(ctx: Ctx2D, r: Rect, color: string, radius = 28): void {
  ctx.save();
  ctx.fillStyle = color;
  roundRect(ctx, r.x - 18, r.y - 24, r.w + 36, r.h + 40, radius);
  ctx.fill();
  ctx.restore();
}

/** Декоративные искорки/точки/штрихи рядом с текстом. */
export function sparkles(ctx: Ctx2D, r: Rect, color: string, seed = 3, n = 5): void {
  const rnd = mulberry(seed);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (let i = 0; i < n; i++) {
    const x = r.x + rnd() * r.w;
    const y = r.y + rnd() * r.h;
    const s = 10 + rnd() * 16;
    const kind = Math.floor(rnd() * 3);
    if (kind === 0) {
      ctx.beginPath();
      ctx.moveTo(x, y - s); ctx.quadraticCurveTo(x, y, x + s, y);
      ctx.quadraticCurveTo(x, y, x, y + s); ctx.quadraticCurveTo(x, y, x - s, y);
      ctx.quadraticCurveTo(x, y, x, y - s);
      ctx.fill();
    } else if (kind === 1) {
      ctx.beginPath(); ctx.arc(x, y, s * 0.22, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.stroke();
    }
  }
  ctx.restore();
}

/** Скрим под текст поверх фото. */
export function scrim(ctx: Ctx2D, r: Rect, opacity: number, dark = true): void {
  const g = ctx.createLinearGradient(0, r.y - 160, 0, r.y + r.h + 80);
  const c = dark ? "0,0,0" : "255,255,255";
  g.addColorStop(0, `rgba(${c},0)`);
  g.addColorStop(0.35, `rgba(${c},${opacity * 0.8})`);
  g.addColorStop(1, `rgba(${c},${opacity})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, Math.max(0, r.y - 160), PIN_W, Math.min(PIN_H, r.h + 260));
  ctx.restore();
}

/** Внешняя рамка холста. */
export function outerFrame(ctx: Ctx2D, color: string, width = 28): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(width / 2, width / 2, PIN_W - width, PIN_H - width);
  ctx.restore();
}

export function accentTint(hex: string, amount = 0.12): string {
  return shift(hex, 0, 0, amount);
}
