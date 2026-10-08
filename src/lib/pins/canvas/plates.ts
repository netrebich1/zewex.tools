/**
 * Формы подложек под текст v6 (порт canvasPlates.ts). Все фигуры рисуются кодом,
 * детерминированно по сиду.
 */
import { roundRect } from "./decor";
import type { Ctx2D } from "./host";

export type PlateShape =
  | "none" | "card" | "circle" | "band"
  | "brush" | "blob" | "sticker" | "tape" | "torn"
  | "ticket" | "arch" | "ribbon" | "frame-plate" | "glass";

export interface PlateBox { x: number; y: number; w: number; h: number }
export interface PlateStyle {
  fill: string;
  stroke?: string;
  accent?: string;
  radius?: number;
  seed?: number;
}

/** Формы, которые сильно перекрывают кадр — только для плотных коллажей. */
export const HEAVY_PLATES: PlateShape[] = ["circle", "blob", "sticker", "ticket", "card"];
/** Безопасные формы для 1–3 фото. */
export const LIGHT_PLATES: PlateShape[] = ["none", "band", "brush", "tape", "torn", "glass", "arch", "ribbon", "frame-plate"];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function shadow(ctx: Ctx2D, blur = 26, alpha = 0.24) {
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = 8;
}

function clearShadow(ctx: Ctx2D) {
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
}

/* ---------- отдельные фигуры ---------- */

function brushPath(ctx: Ctx2D, b: PlateBox, seed: number) {
  const rnd = rng(seed);
  const steps = 9;
  const amp = b.h * 0.11;
  ctx.beginPath();
  ctx.moveTo(b.x - amp * 1.4, b.y + amp * (0.4 + rnd() * 0.5));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = b.x - amp * 1.4 + (b.w + amp * 2.8) * t;
    const y = b.y + (rnd() - 0.5) * amp * 1.5;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(b.x + b.w + amp * 1.9, b.y + b.h * 0.5);
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    const x = b.x - amp * 1.4 + (b.w + amp * 2.8) * t;
    const y = b.y + b.h + (rnd() - 0.5) * amp * 1.6;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function blobPath(ctx: Ctx2D, b: PlateBox, seed: number) {
  const rnd = rng(seed);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const rx = b.w / 2, ry = b.h / 2;
  const pts = 16;
  ctx.beginPath();
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const k = 0.92 + 0.1 * Math.sin(a * 3 + seed) + rnd() * 0.03;
    const x = cx + Math.cos(a) * rx * k;
    const y = cy + Math.sin(a) * ry * k;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function tornPath(ctx: Ctx2D, b: PlateBox, seed: number) {
  const rnd = rng(seed);
  const teeth = 22;
  const amp = 11;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  for (let i = 1; i <= teeth; i++) {
    const x = b.x + (b.w * i) / teeth;
    ctx.lineTo(x, b.y + (rnd() - 0.5) * amp * 2);
  }
  ctx.lineTo(b.x + b.w, b.y + b.h);
  for (let i = teeth - 1; i >= 0; i--) {
    const x = b.x + (b.w * i) / teeth;
    ctx.lineTo(x, b.y + b.h + (rnd() - 0.5) * amp * 2);
  }
  ctx.closePath();
}

function ticketPath(ctx: Ctx2D, b: PlateBox) {
  const r = Math.min(26, b.h * 0.12);
  const cy = b.y + b.h / 2;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x + b.w, b.y);
  ctx.lineTo(b.x + b.w, cy - r);
  ctx.arc(b.x + b.w, cy, r, -Math.PI / 2, Math.PI / 2, true);
  ctx.lineTo(b.x + b.w, b.y + b.h);
  ctx.lineTo(b.x, b.y + b.h);
  ctx.lineTo(b.x, cy + r);
  ctx.arc(b.x, cy, r, Math.PI / 2, -Math.PI / 2, true);
  ctx.closePath();
}

function archPath(ctx: Ctx2D, b: PlateBox) {
  const r = Math.min(b.w / 2, b.h * 0.42);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y + b.h);
  ctx.lineTo(b.x, b.y + r);
  ctx.arc(b.x + b.w / 2, b.y + r, b.w / 2, Math.PI, 0);
  ctx.lineTo(b.x + b.w, b.y + b.h);
  ctx.closePath();
}

function ribbonPath(ctx: Ctx2D, b: PlateBox) {
  const tail = Math.min(38, b.h * 0.28);
  ctx.beginPath();
  ctx.moveTo(b.x - tail, b.y + tail * 0.4);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x + b.w, b.y);
  ctx.lineTo(b.x + b.w + tail, b.y + tail * 0.4);
  ctx.lineTo(b.x + b.w + tail, b.y + b.h - tail * 0.4);
  ctx.lineTo(b.x + b.w, b.y + b.h);
  ctx.lineTo(b.x, b.y + b.h);
  ctx.lineTo(b.x - tail, b.y + b.h - tail * 0.4);
  ctx.closePath();
}

/**
 * Рисует подложку. Возвращает true, если фигура нарисована (для none — false).
 * box — прямоугольник текстового блока с уже добавленным padding.
 */
export function drawPlate(
  ctx: Ctx2D,
  shape: PlateShape,
  box: PlateBox,
  style: PlateStyle,
  pin: { w: number; h: number },
): boolean {
  if (shape === "none") return false;
  const seed = style.seed ?? 7;
  const radius = style.radius ?? 22;
  ctx.save();
  ctx.fillStyle = style.fill;

  switch (shape) {
    case "card":
      shadow(ctx, 34, 0.22);
      roundRect(ctx, box.x, box.y, box.w, box.h, radius); ctx.fill();
      clearShadow(ctx);
      break;
    case "circle": {
      const cx = pin.w / 2, cy = box.y + box.h / 2;
      const r = Math.max(box.w, box.h) / 2 + 26;
      shadow(ctx, 30, 0.2);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      clearShadow(ctx);
      break;
    }
    case "band":
      ctx.fillRect(0, box.y, pin.w, box.h);
      if (style.accent) { ctx.fillStyle = style.accent; ctx.fillRect(0, box.y, pin.w, 12); }
      break;
    case "brush":
      brushPath(ctx, box, seed); ctx.fill();
      break;
    case "blob": {
      const grown = { x: box.x - 24, y: box.y - 20, w: box.w + 48, h: box.h + 40 };
      if (style.stroke) {
        ctx.save();
        shadow(ctx, 24, 0.18);
        ctx.fillStyle = style.stroke;
        blobPath(ctx, { x: grown.x - 12, y: grown.y - 12, w: grown.w + 24, h: grown.h + 24 }, seed);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = style.fill;
      }
      blobPath(ctx, grown, seed); ctx.fill();
      break;
    }
    case "sticker":
      shadow(ctx, 26, 0.26);
      if (style.stroke) {
        ctx.fillStyle = style.stroke;
        roundRect(ctx, box.x - 12, box.y - 12, box.w + 24, box.h + 24, radius + 10); ctx.fill();
      }
      clearShadow(ctx);
      ctx.fillStyle = style.fill;
      roundRect(ctx, box.x, box.y, box.w, box.h, radius); ctx.fill();
      break;
    case "tape": {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      ctx.translate(cx, cy); ctx.rotate(-0.026); ctx.translate(-cx, -cy);
      ctx.globalAlpha = 0.94;
      ctx.fillRect(box.x - 26, box.y, box.w + 52, box.h);
      ctx.globalAlpha = 1;
      break;
    }
    case "torn":
      tornPath(ctx, box, seed); ctx.fill();
      break;
    case "ticket":
      shadow(ctx, 22, 0.2);
      ticketPath(ctx, box); ctx.fill();
      clearShadow(ctx);
      break;
    case "arch":
      archPath(ctx, box); ctx.fill();
      break;
    case "ribbon":
      ribbonPath(ctx, box); ctx.fill();
      break;
    case "frame-plate":
      roundRect(ctx, box.x, box.y, box.w, box.h, radius); ctx.fill();
      if (style.accent) {
        ctx.strokeStyle = style.accent; ctx.lineWidth = 2;
        roundRect(ctx, box.x + 14, box.y + 14, box.w - 28, box.h - 28, Math.max(0, radius - 8)); ctx.stroke();
      }
      break;
    case "glass": {
      ctx.globalAlpha = 0.78;
      roundRect(ctx, box.x, box.y, box.w, box.h, radius); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(255,255,255,.32)"; ctx.lineWidth = 2;
      roundRect(ctx, box.x + 1, box.y + 1, box.w - 2, box.h - 2, radius); ctx.stroke();
      break;
    }
  }
  ctx.restore();
  return true;
}

/* ---------- доодлы: звёзды, сердечки, искры, стрелки ---------- */

export function doodleStar(ctx: Ctx2D, cx: number, cy: number, r: number, color: string, filled = false): void {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(2, r * 0.16); ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 ? r * 0.44 : r;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  if (filled) ctx.fill(); else ctx.stroke();
  ctx.restore();
}

export function doodleHeart(ctx: Ctx2D, cx: number, cy: number, r: number, color: string, filled = false): void {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(2, r * 0.18); ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.85);
  ctx.bezierCurveTo(cx - r * 1.4, cy - r * 0.2, cx - r * 0.45, cy - r, cx, cy - r * 0.35);
  ctx.bezierCurveTo(cx + r * 0.45, cy - r, cx + r * 1.4, cy - r * 0.2, cx, cy + r * 0.85);
  ctx.closePath();
  if (filled) ctx.fill(); else ctx.stroke();
  ctx.restore();
}

export function doodleSpark(ctx: Ctx2D, cx: number, cy: number, r: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, r * 0.2); ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 4) * i;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
  ctx.restore();
}

/** Лучи вокруг крупного числа (ретро-поп). */
export function rays(ctx: Ctx2D, cx: number, cy: number, r: number, color: string, n = 12): void {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, r * 0.06); ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + 0.2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a) * r * 1.28, cy + Math.sin(a) * r * 1.28);
    ctx.stroke();
  }
  ctx.restore();
}

/** Набор доодлов по углам текстового блока. */
export function scatterDoodles(ctx: Ctx2D, box: PlateBox, color: string, seed = 3): void {
  const rnd = rng(seed);
  const spots: Array<[number, number, number]> = [
    [box.x - 26, box.y - 10, 17],
    [box.x + box.w + 24, box.y + 6, 13],
    [box.x + box.w + 12, box.y + box.h - 4, 19],
    [box.x - 14, box.y + box.h + 12, 12],
  ];
  spots.forEach(([x, y, r], i) => {
    const kind = Math.floor(rnd() * 3);
    if (kind === 0) doodleStar(ctx, x, y, r, color, i % 2 === 0);
    else if (kind === 1) doodleHeart(ctx, x, y, r * 0.9, color, false);
    else doodleSpark(ctx, x, y, r * 0.9, color);
  });
}

/** Нижняя доменная лента. */
export function domainBar(
  ctx: Ctx2D, text: string, font: string,
  colors: { bg: string; fg: string }, pin: { w: number; h: number },
): number {
  const h = 74;
  ctx.save();
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, pin.h - h, pin.w, h);
  ctx.fillStyle = colors.fg;
  ctx.font = `700 27px "${font}"`;
  const value = text.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
  const spaced = value.split("").join(" ");
  const w = ctx.measureText(spaced).width;
  ctx.textBaseline = "middle";
  ctx.fillText(spaced, (pin.w - w) / 2, pin.h - h / 2 + 1);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
  return h;
}
