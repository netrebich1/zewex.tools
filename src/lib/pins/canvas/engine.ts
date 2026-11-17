/**
 * Рендер canvas-пина (порт canvasEngine.ts). Браузерные зависимости заменены
 * хостом: холст — host.createCanvas, фото — HostImage, экспорт — host.encodeJpeg.
 */
import { PIN_H, PIN_W, drawSmartCover, accentBox, toAccent, type SubjectRect } from "./crop";
import { loadFontFamilies } from "./fonts";
import { solveCanvasScene, type PlateKind, type SolvedScene } from "./layoutSolver";
import type { CanvasRecipe, CanvasPalette } from "./recipe";
import { roundRect, grain } from "./decor";
import { drawPlate, scatterDoodles, domainBar as drawDomainBar, HEAVY_PLATES } from "./plates";
import {
  drawKitPlate, drawKitNumber, drawKitHighlight, drawKitCta, drawKitFrame, drawKitDomain,
  subtextTransform, CTA_UNDERLINED, PLATE_KIT_MAP, NUMBER_PLACEMENT_MAP,
  highlightExtraRoom, kitNumberHeight,
} from "./kit";
import { getHost, asImageSource, type Ctx2D, type HostImage } from "./host";
import type { TitleEmphasis } from "./recipe";

/** Цифра рисуется отдельно от текстового стека. */
const DETACHED_PLACEMENTS = new Set(["np-ghost", "np-corner-tl", "np-corner-tr", "np-corner-bl", "np-corner-br"]);

interface Box { x: number; y: number; w: number; h: number }

/**
 * Цвета подложки и текста на ней: «чернильные» формы (мазок, скотч, лента)
 * заливаются fg, стикеры — акцентом, бумажные — фоном палитры.
 */
function plateColors(plate: PlateKind, p: CanvasPalette) {
  switch (plate) {
    case "circle":
    case "blob":
    case "sticker":
      return { fill: p.accent, stroke: p.bg, accent: undefined, ink: p.onAccent, inkAccent: p.onAccent, surface: p.accent };
    case "brush":
    case "tape":
    case "ribbon":
      return { fill: p.fg, stroke: undefined, accent: undefined, ink: p.bg, inkAccent: p.accent, surface: p.fg };
    case "band":
      return { fill: p.bg, stroke: undefined, accent: p.accent, ink: p.fg, inkAccent: p.accent, surface: p.bg };
    case "glass":
      return { fill: p.fg, stroke: undefined, accent: undefined, ink: p.bg, inkAccent: p.accent, surface: p.fg };
    default:
      return { fill: p.bg, stroke: undefined, accent: p.accent, ink: p.fg, inkAccent: p.accent, surface: p.bg };
  }
}

export interface PinText { title: string; kicker?: string; subtitle?: string; cta?: string }
export interface RenderCanvasArgs {
  recipe: CanvasRecipe;
  photos: HostImage[];
  /** Рамки объектов по индексам photos (от модели со зрением); undefined — карта энергии. */
  subjects?: Array<SubjectRect | null | undefined>;
  text: PinText;
  domain?: string;
  seed?: number;
  ideaCount?: number;
  year?: string;
}

interface TextLine {
  text: string; font: string; size: number; weight: number; color: string; lineHeight: number;
  role: "title" | "meta" | "cta" | "domain" | "hero";
  boxH?: number; arrowH?: number;
  /** v7.4: строка вынесена из общего стека (цифра-фон, цифра в углу). */
  detached?: boolean;
  /** v8: акцентная часть заголовка (крупнее / другим шрифтом / цветом). */
  emph?: TitleEmphasis;
}

/** v8: границы кегля и межстрочный заголовка — из стиля либо по умолчанию (42–92, 1.08). */
interface TitleFit { min: number; max: number; leading: number; maxLines: number }

function titleFitOf(r: CanvasRecipe): TitleFit {
  const fx = r.fx || {};
  const min = Math.max(30, Math.min(220, fx.titleMin ?? 42));
  const max = Math.max(min, Math.min(240, fx.titleMax ?? 92));
  return { min, max, leading: Math.max(0.8, Math.min(1.4, fx.leading ?? 1.08)), maxLines: 4 };
}

const CTA_GAP = 12;

function ctaMetrics(size: number, style: CanvasRecipe["ctaStyle"]) {
  const padX = style === "line" ? 0 : style === "bar" ? 30 : style === "frame" ? 34 : 28;
  const boxH = style === "line" ? Math.round(size * 1.5) : Math.round(size * 2.05);
  return { padX, boxH };
}

function arrowHeight(arrow: CanvasRecipe["ctaArrow"], size: number) {
  if (!arrow || arrow === "none") return 0;
  if (arrow === "double") return Math.round(size * 1.15) + CTA_GAP;
  if (arrow === "stem") return Math.round(size * 1.35) + CTA_GAP;
  if (arrow === "dot") return Math.round(size * 1.1) + CTA_GAP;
  return Math.round(size * 0.78) + CTA_GAP;
}

function titleCase(text: string, mode: CanvasRecipe["titleCase"]) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (mode === "upper") return clean.toLocaleUpperCase();
  if (mode === "sentence") return clean ? clean[0].toLocaleUpperCase() + clean.slice(1) : clean;
  return clean.replace(/(^|\s)\S/g, (m) => m.toLocaleUpperCase());
}

function wrap(ctx: Ctx2D, text: string, maxW: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (!current || ctx.measureText(next).width <= maxW) current = next;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

function fitTitle(ctx: Ctx2D, text: string, maxW: number, maxH: number, font: string, weight: number, fit: TitleFit = { min: 42, max: 92, leading: 1.08, maxLines: 4 }) {
  const step = fit.max > 120 ? 4 : 2;
  for (let size = fit.max; size >= fit.min; size -= step) {
    ctx.font = `${weight} ${size}px "${font}"`;
    const lines = wrap(ctx, text, maxW);
    const lh = size * fit.leading;
    // Длинное слово шире колонки — кегль ещё меньше.
    if (lines.some((l) => ctx.measureText(l).width > maxW)) continue;
    if (lines.length <= fit.maxLines && lines.length * lh <= maxH) return { size, lines, lineHeight: lh };
  }
  // Не влезло в заданный диапазон (узкая колонка, длинный заголовок): опускаемся ниже минимума
  // и разрешаем ещё две строки — слова заголовка терять нельзя («Nails For» без «Work»).
  for (let size = fit.min - 2; size >= 30; size -= 2) {
    ctx.font = `${weight} ${size}px "${font}"`;
    const lines = wrap(ctx, text, maxW);
    const lh = size * fit.leading;
    if (lines.some((l) => ctx.measureText(l).width > maxW)) continue;
    if (lines.length <= fit.maxLines + 2 && lines.length * lh <= maxH) return { size, lines, lineHeight: lh };
  }
  ctx.font = `${weight} 30px "${font}"`;
  return { size: 30, lines: wrap(ctx, text, maxW), lineHeight: 30 * fit.leading };
}

/** Делит слова заголовка на обычную и акцентную части. */
function splitEmphasis(words: string[], part: TitleEmphasis["part"]): { small: string[]; big: string[]; bigFirst: boolean } | null {
  const n = words.length;
  if (n < 2) return null;
  switch (part) {
    case "first-word": return { big: words.slice(0, 1), small: words.slice(1), bigFirst: true };
    case "last-word": return { big: words.slice(-1), small: words.slice(0, -1), bigFirst: false };
    case "last-two": return n < 3 ? { big: words.slice(-1), small: words.slice(0, -1), bigFirst: false } : { big: words.slice(-2), small: words.slice(0, -2), bigFirst: false };
    case "first-line": { const k = Math.max(1, Math.ceil(n / 2)); return { big: words.slice(0, k), small: words.slice(k), bigFirst: true }; }
    case "last-line": { const k = Math.max(1, Math.floor(n / 2)); return { big: words.slice(k), small: words.slice(0, k), bigFirst: false }; }
  }
  return null;
}

function applyCase(text: string, mode: TitleEmphasis["case"] | CanvasRecipe["titleCase"]): string {
  if (mode === "lower") return text.toLocaleLowerCase();
  return titleCase(text, (mode ?? "title") as CanvasRecipe["titleCase"]);
}

/**
 * v8: заголовок с акцентной частью — две группы строк разного кегля (и, возможно, шрифта).
 * Подбор: базовый кегль идёт вниз, пока обе части не влезут по ширине и высоте.
 */
function fitEmphasis(
  ctx: Ctx2D, r: CanvasRecipe, rawTitle: string, maxW: number, maxH: number, titleFont: string, fit: TitleFit,
): TextLine[] | null {
  const e = r.fx?.emphasis;
  if (!e) return null;
  const words = rawTitle.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  // На длинных заголовках (7+ слов) акцент не помогает — мелкая часть становится нечитаемой.
  if (words.length > 6) return null;
  // На длинных заголовках (7+ слов) акцент не помогает — мелкая часть становится нечитаемой.
  if (words.length > 6) return null;
  const parts = splitEmphasis(words, e.part);
  if (!parts) return null;
  const bigFont = e.font === "script" ? (r.fonts.script || titleFont) : e.font === "sans" ? r.fonts.sans : e.font === "display" ? r.fonts.display : titleFont;
  const isScript = e.font === "script" && !!r.fonts.script;
  const bigWeight = e.weight ?? (isScript ? 400 : r.titleWeight);
  // У рукописных шрифтов низкий x-height — акцент визуально меньше, компенсируем.
  const scale = Math.max(0.4, Math.min(3, (e.scale || 1.6) * (isScript ? 1.3 : 1)));
  const smallText = titleCase(parts.small.join(" "), r.titleCase);
  const bigText = applyCase(parts.big.join(" "), e.case ?? (isScript ? "lower" : r.titleCase));
  const bigLeading = isScript ? Math.max(0.95, fit.leading * 0.95) : fit.leading;
  const step = fit.max > 120 ? 4 : 2;
  for (let size = fit.max; size >= fit.min; size -= step) {
    const bigSize = Math.round(size * scale);
    if (bigSize > 260) continue;
    ctx.font = `${r.titleWeight} ${size}px "${titleFont}"`;
    const smallLines = smallText ? wrap(ctx, smallText, maxW) : [];
    if (smallLines.some((l) => ctx.measureText(l).width > maxW)) continue;
    ctx.font = `${bigWeight} ${bigSize}px "${bigFont}"`;
    const bigLines = wrap(ctx, bigText, maxW);
    if (bigLines.some((l) => ctx.measureText(l).width > maxW)) continue;
    const h = smallLines.length * size * fit.leading + bigLines.length * bigSize * bigLeading;
    if (smallLines.length + bigLines.length > fit.maxLines || h > maxH) continue;
    const small: TextLine[] = smallLines.map((t) => ({ text: t, font: titleFont, size, weight: r.titleWeight, color: r.palette.fg, lineHeight: size * fit.leading, role: "title" }));
    const big: TextLine[] = bigLines.map((t) => ({ text: t, font: bigFont, size: bigSize, weight: bigWeight, color: r.palette.fg, lineHeight: bigSize * bigLeading, role: "title", emph: e }));
    return parts.bigFirst ? [...big, ...small] : [...small, ...big];
  }
  return null;
}

function fitSingleLine(ctx: Ctx2D, text: string, font: string, weight: number, start: number, min: number, maxW: number) {
  let size = start;
  for (; size > min; size -= 2) { ctx.font = `${weight} ${size}px "${font}"`; if (ctx.measureText(text).width <= maxW) break; }
  return size;
}

function measureTextStack(ctx: Ctx2D, r: CanvasRecipe, text: PinText, maxW: number, maxH: number, ideaCount?: number, year?: string): TextLine[] {
  const titleFont = r.fonts[r.titleFont];
  // v7.4: разные шрифты для разных элементов — строго из одной пары.
  const roles = r.roleFonts || {};
  const kickerFont = roles.kicker || r.fonts.sans;
  const numberFont = roles.number || r.fonts.sans;
  const ctaFont = roles.cta || r.fonts.sans;
  const subFont = roles.subtext || r.fonts.body;
  // v7.5: шаблоны класса «без цифры» не показывают её никогда.
  const numberAllowed = r.numberMode !== "none" && r.numberStyle !== "none";
  const inline = ideaCount && numberAllowed && r.numberStyle === "inline";
  const rawTitle = inline ? `${ideaCount} ${text.title || ""}` : (text.title || "");
  const title = titleCase(rawTitle, r.titleCase);
  const heroNumber = ideaCount && numberAllowed && (r.numberStyle === "hero" || r.numberStyle === "circle" || r.numberStyle === "square" || r.numberStyle === "plain");
  const place = r.kit?.numPlace;
  const detached = !!(heroNumber && place && DETACHED_PLACEMENTS.has(place));
  const tf = titleFitOf(r);
  const titleRoom = Math.max(180, maxH * (heroNumber && !detached ? .54 : .68));
  const emphLines = inline ? null : fitEmphasis(ctx, r, rawTitle, maxW, titleRoom, titleFont, tf);
  const fit = emphLines ? null : fitTitle(ctx, title, maxW, titleRoom, titleFont, r.titleWeight, tf);
  const lines: TextLine[] = [];
  if (text.kicker?.trim()) {
    const script = r.scriptKicker ? r.fonts.script : undefined;
    const base = r.kit ? subtextTransform(r.kit.subtext, text.kicker, "kicker") : text.kicker.trim();
    const value = base && (script ? base : base.toLocaleUpperCase());
    const font = script || kickerFont;
    if (value) {
      // v8: кикер крупнее (в ленте Pinterest пин ~236 px шириной — 28 px превращались в 6–7 px).
      const size = fitSingleLine(ctx, value, font, script ? 500 : 700, script ? 50 : 34, 22, maxW);
      lines.push({ text: value, font, size, weight: script ? 500 : 700, color: r.palette.accent, lineHeight: size + 12, role: "meta" });
    }
  }

  if (heroNumber) {
    // Число вписано в композицию как крупный акцент.
    const value = `${ideaCount}`;
    const scale = (place && NUMBER_PLACEMENT_MAP.get(place)?.scale) || 1;
    const cap = (r.numberStyle === "hero" ? 150 : 96) * (detached ? 1 : Math.min(1.3, scale));
    const size = detached
      ? Math.round(cap * (place === "np-ghost" ? 2.4 : 1))
      : fitSingleLine(ctx, value, numberFont, 900, cap, 56, maxW * .8);
    // Форма кита выше глифа — резервируем её высоту.
    ctx.font = `900 ${size}px "${numberFont}"`;
    const glyphW = ctx.measureText(value).width;
    const shapeH = r.kit && r.kit.number !== "num-plain"
      ? kitNumberHeight(r.kit.number, size, glyphW)
      : (r.numberStyle === "circle" || r.numberStyle === "square" ? size * 1.42 : size * 0.72);
    lines.push({
      text: value, font: numberFont, size, weight: 900, color: r.palette.accent,
      lineHeight: detached ? size * 1.04 : Math.max(size * 1.04, shapeH + 24), role: "hero", detached,
    });
  }
  // Плашки выделения заголовка выше строки — добавляем воздух.
  if (emphLines) {
    const hlRoom = r.kit ? highlightExtraRoom(r.kit.highlight, emphLines[0].size) : 0;
    emphLines.forEach((l) => lines.push({ ...l, lineHeight: l.lineHeight + hlRoom }));
  } else if (fit) {
    const hlRoom = r.kit ? highlightExtraRoom(r.kit.highlight, fit.size) : 0;
    fit.lines.forEach((line) => lines.push({ text: line, font: titleFont, size: fit.size, weight: r.titleWeight, color: r.palette.fg, lineHeight: fit.lineHeight + hlRoom, role: "title" }));
  }
  if (text.subtitle?.trim()) {
    const value = r.kit ? subtextTransform(r.kit.subtext, text.subtitle, "subtitle") : text.subtitle.trim();
    if (value) {
      const size = fitSingleLine(ctx, value, subFont, 600, 34, 22, maxW);
      lines.push({ text: value, font: subFont, size, weight: 600, color: r.palette.fg, lineHeight: size + 13, role: "meta" });
    }
  }
  if (year?.trim() && r.yearStyle !== "none") lines.push({ text: year.trim(), font: kickerFont, size: 34, weight: 800, color: r.palette.accent, lineHeight: 48, role: "meta" });
  if (text.cta?.trim() && r.ctaStyle !== "none") {
    const raw = text.cta.trim();
    const value = r.ctaCase === "title" ? raw : raw.toLocaleUpperCase();
    const probe = ctaMetrics(32, r.ctaStyle);
    const size = fitSingleLine(ctx, value, ctaFont, 800, 32, 20, Math.max(120, maxW - probe.padX * 2 - 16));
    const { boxH } = ctaMetrics(size, r.ctaStyle);
    const arrowH = arrowHeight(r.ctaArrow, size);
    lines.push({
      text: value, font: ctaFont, size, weight: 800, color: r.palette.onAccent,
      lineHeight: boxH + arrowH + 10, role: "cta", boxH, arrowH,
    });
  }
  return lines;
}

function stackHeight(lines: TextLine[]) {
  const flow = lines.filter((l) => !l.detached);
  return flow.reduce((sum, l, i) => sum + l.lineHeight + (i && flow[i - 1].role !== l.role ? 14 : 0), 0);
}

function luminance(hex: string) {
  let v = hex.replace("#", "");
  if (v.length === 3) v = v.split("").map((c) => c + c).join("");
  if (v.length !== 6) return 0;
  const rgb = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}

/** Контур ячейки: арка-окно для верхнего ряда (v8) либо скруглённый прямоугольник. */
function cellPath(ctx: Ctx2D, b: Box, radius: number, arch: boolean) {
  if (arch && b.h > b.w * 0.7) {
    const rr = b.w / 2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y + b.h);
    ctx.lineTo(b.x, b.y + rr);
    ctx.arc(b.x + rr, b.y + rr, rr, Math.PI, 0);
    ctx.lineTo(b.x + b.w, b.y + b.h);
    ctx.closePath();
    return;
  }
  roundRect(ctx, b.x, b.y, b.w, b.h, radius);
}

/** Пробует CSS-фильтр контекста (есть в Skia/@napi-rs, в типах DOM может отсутствовать). */
function setFilter(ctx: Ctx2D, value: string) {
  try { (ctx as unknown as { filter: string }).filter = value; } catch { /* noop */ }
}

/** v8: тонировка фото внутри уже обрезанной ячейки. */
function tonePhoto(ctx: Ctx2D, tone: NonNullable<CanvasRecipe["fx"]>["photoTone"], b: Box, p: CanvasPalette) {
  if (!tone) return;
  ctx.save();
  if (tone === "duotone") {
    // Оттенок акцента поверх ч/б кадра: hue/sat акцента, светлота фото.
    ctx.globalCompositeOperation = "color";
    ctx.fillStyle = p.accent; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = p.accent; ctx.fillRect(b.x, b.y, b.w, b.h);
  } else if (tone === "warm") {
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#E9A860"; ctx.fillRect(b.x, b.y, b.w, b.h);
  }
  ctx.restore();
}

function drawPhotos(ctx: Ctx2D, args: RenderCanvasArgs, scene: SolvedScene) {
  const r = args.recipe;
  const fx = r.fx || {};
  const seed = args.seed || 1;
  const topY = Math.min(...scene.photos.map((p) => p.y));
  const light = luminance(r.palette.bg) > 0.5;
  scene.photos.forEach((p, i) => {
    const img = args.photos[p.imageIndex];
    if (!img) return;
    let box: Box = { x: p.x, y: p.y, w: p.w, h: p.h };
    const arch = fx.photoShape === "arch" && Math.abs(p.y - topY) < 2;
    ctx.save();
    if (fx.photoStyle === "polaroid") {
      // Белая карточка с полем снизу, лёгкий поворот по сиду, полоска скотча сверху.
      const angle = ((((seed + i * 7919) % 7) - 3) / 3) * (3.2 * Math.PI / 180);
      const shrink = 0.94;
      const cw = p.w * shrink, chh = p.h * shrink;
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      ctx.translate(cx, cy); ctx.rotate(angle); ctx.translate(-cx, -cy);
      const card: Box = { x: cx - cw / 2, y: cy - chh / 2, w: cw, h: chh };
      ctx.shadowColor = "rgba(0,0,0,.22)"; ctx.shadowBlur = 26; ctx.shadowOffsetY = 10;
      ctx.fillStyle = "#FBF9F5";
      ctx.fillRect(card.x, card.y, card.w, card.h);
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      const mat = Math.max(10, Math.min(22, cw * 0.05));
      box = { x: card.x + mat, y: card.y + mat, w: card.w - mat * 2, h: card.h - mat - Math.max(mat * 2.6, cw * 0.14) };
      ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
    } else if (fx.photoStyle === "card") {
      ctx.shadowColor = light ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.45)"; ctx.shadowBlur = 28; ctx.shadowOffsetY = 12;
      ctx.fillStyle = r.palette.soft;
      cellPath(ctx, box, scene.radius, arch); ctx.fill();
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      cellPath(ctx, box, scene.radius, arch); ctx.clip();
    } else {
      cellPath(ctx, box, scene.radius, arch); ctx.clip();
    }
    if (fx.photoTone === "mono" || fx.photoTone === "duotone") setFilter(ctx, "grayscale(1)");
    else if (fx.photoTone === "warm") setFilter(ctx, "sepia(0.25) saturate(1.15)");
    // Всегда настоящий cover: ячейка заполняется целиком, smart-фокус хранит объект.
    drawSmartCover(ctx, img, box.x, box.y, box.w, box.h, {
      maxCrop: 1,
      fillBg: r.palette.soft,
      accent: toAccent(r.accent),
      subject: args.subjects?.[p.imageIndex] ?? null,
    });
    setFilter(ctx, "none");
    tonePhoto(ctx, fx.photoTone, box, r.palette);
    if (fx.photoStyle === "polaroid") {
      // Скотч: полупрозрачная полоска под наклоном поверх верхнего края.
      ctx.restore(); ctx.save();
      const angle = ((((seed + i * 7919) % 7) - 3) / 3) * (3.2 * Math.PI / 180);
      const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      ctx.translate(cx, cy); ctx.rotate(angle); ctx.translate(-cx, -cy);
      ctx.translate(box.x + box.w / 2, box.y - 2); ctx.rotate(-0.1);
      ctx.globalAlpha = 0.55; ctx.fillStyle = light ? "#FFFFFF" : "#F2EBD9";
      const tw = Math.min(140, box.w * 0.42), th = Math.max(22, tw * 0.26);
      ctx.fillRect(-tw / 2, -th / 2, tw, th);
    }
    ctx.restore();
    if (fx.photoStyle === "polaroid") return;
    // v7.4: рамка/обводка кадра поверх фото.
    const p2 = r.palette;
    drawKitFrame(ctx, r.kit?.frame, box, scene.radius, {
      accent: p2.accent, accent2: p2.accent2 || p2.accent, bg: p2.bg, fg: p2.fg,
    });
  });
}

function drawHighlight(ctx: Ctx2D, line: TextLine, x: number, baseline: number, width: number, r: CanvasRecipe) {
  if (line.role !== "title" || r.highlight === "none") return;
  ctx.save();
  ctx.globalAlpha = r.highlight === "marker" ? .68 : 1;
  if (r.highlight === "underline") {
    ctx.strokeStyle = r.palette.accent; ctx.lineWidth = Math.max(5, line.size * .08); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x, baseline + line.size * .18); ctx.lineTo(x + width, baseline + line.size * .18); ctx.stroke();
  } else if (r.highlight === "box") {
    ctx.strokeStyle = r.palette.accent; ctx.lineWidth = 4; roundRect(ctx, x - 18, baseline - line.size, width + 36, line.size * 1.25, 8); ctx.stroke();
  } else {
    ctx.fillStyle = r.highlight === "chip" ? r.palette.soft : r.palette.accent;
    roundRect(ctx, x - 16, baseline - line.size * .86, width + 32, line.size * 1.04, r.highlight === "chip" ? line.size : 6); ctx.fill();
  }
  ctx.restore();
}

/* ---------- контраст: крупное число не должно сливаться с фоном ---------- */
function contrastRatio(a: string, b: string): number {
  try {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  } catch { return 1; }
}

/** Первый цвет с нужным контрастом к фону; иначе лучший кандидат дотягивается по светлоте. */
function pickContrast(bg: string, candidates: Array<string | undefined>, min = 4.5): string {
  let best = candidates.find((c): c is string => Boolean(c)) || "#FFFFFF", bestRatio = 0;
  for (const c of candidates) {
    if (!c) continue;
    const ratio = contrastRatio(bg, c);
    if (ratio >= min) return c;
    if (ratio > bestRatio) { bestRatio = ratio; best = c; }
  }
  return bestRatio >= min ? best : forceContrast(bg, best, min);
}

/** Двигает светлоту цвета, пока контраст к фону не достигнет порога. */
function forceContrast(bg: string, color: string, min: number): string {
  const up = luminance(bg) < 0.42;
  let cur = color;
  for (let i = 0; i < 22; i++) {
    cur = shiftLightness(cur, up ? 0.05 : -0.05);
    if (contrastRatio(bg, cur) >= min) return cur;
  }
  return up ? "#FFFFFF" : "#111111";
}

function shiftLightness(hex: string, delta: number): string {
  const v = hex.replace("#", "");
  if (v.length !== 6) return hex;
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  const to = delta > 0 ? 255 : 0;
  const k = Math.min(1, Math.abs(delta) * 1.6);
  return "#" + ch.map((c) => Math.round(c + (to - c) * k).toString(16).padStart(2, "0")).join("");
}

/** Средний цвет уже отрисованного участка холста (фото под текстом). */
function sampleSurface(ctx: Ctx2D, box: Box): string | null {
  try {
    const x = Math.max(0, Math.round(box.x)), yy = Math.max(0, Math.round(box.y));
    const w = Math.max(1, Math.min(PIN_W - x, Math.round(box.w)));
    const h = Math.max(1, Math.min(PIN_H - yy, Math.round(box.h)));
    const d = ctx.getImageData(x, yy, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    const step = Math.max(4, Math.floor(d.length / 4 / 2000) * 4);
    for (let i = 0; i < d.length; i += step) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return null;
    return "#" + [r / n, g / n, b / n].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

/** Смешивает цвет с чёрным скримом заданной плотности. */
function blendBlack(hex: string, alpha: number): string {
  const v = hex.replace("#", "");
  if (v.length !== 6) return hex;
  return "#" + [0, 2, 4].map((i) => Math.round(parseInt(v.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

const rectsOverlap = (a: Box, b: Box, gap = 0) =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/** Межбуквенный интервал: в napi-rs есть, тип DOM может его не знать. */
function setLetterSpacing(ctx: Ctx2D, value: string) {
  try { (ctx as unknown as { letterSpacing: string }).letterSpacing = value; } catch { /* noop */ }
}

/** v8: ширина кнопки как в drawCta — нужна для выравнивания влево. */
function ctaBoxWidth(style: CanvasRecipe["ctaStyle"], size: number, textW: number) {
  const { padX } = ctaMetrics(size, style);
  return style === "bar" ? Math.min(textW + padX * 2 + 120, 760) : textW + padX * 2;
}

/** v8: матовое стекло — размытая копия холста под подложкой. */
function drawGlass(ctx: Ctx2D, snapshot: CanvasImageSource | null, box: Box, radius: number, dark: boolean) {
  ctx.save();
  roundRect(ctx, box.x, box.y, box.w, box.h, Math.max(20, radius));
  ctx.clip();
  if (snapshot) {
    setFilter(ctx, "blur(22px)");
    try { ctx.drawImage(snapshot, 0, 0); } catch { /* хост без снимка */ }
    setFilter(ctx, "none");
  }
  ctx.fillStyle = dark ? "rgba(12,12,14,.42)" : "rgba(255,255,255,.46)";
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.restore();
}

/** v8: контурные приёмы заголовка. */
function drawTitleGlyphs(ctx: Ctx2D, r: CanvasRecipe, line: TextLine, x: number, baseline: number, fill: string, knockout: string, accent: string) {
  const outline = line.emph && r.fx?.outline === "hollow" ? undefined : r.fx?.outline;
  const lw = Math.max(2, line.size * (outline === "hollow" ? 0.045 : 0.06));
  ctx.lineJoin = "round";
  if (outline === "echo") {
    // Контурные повторы уходят вверх-вправо; основной текст «вырезает» их обводкой цвета поверхности.
    ctx.save();
    ctx.strokeStyle = accent; ctx.lineWidth = Math.max(2, line.size * 0.028); ctx.globalAlpha = 0.85;
    const d = line.size * 0.1;
    ctx.strokeText(line.text, x + d, baseline - d);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = knockout; ctx.lineWidth = Math.max(4, line.size * 0.07); ctx.strokeText(line.text, x, baseline);
    ctx.restore();
    ctx.fillStyle = fill; ctx.fillText(line.text, x, baseline);
    return;
  }
  if (outline === "hollow") {
    ctx.strokeStyle = fill; ctx.lineWidth = lw; ctx.strokeText(line.text, x, baseline);
    return;
  }
  if (outline === "stroke") {
    ctx.strokeStyle = knockout; ctx.lineWidth = lw * 2; ctx.strokeText(line.text, x, baseline);
  }
  ctx.fillStyle = fill; ctx.fillText(line.text, x, baseline);
}

function drawTextStack(ctx: Ctx2D, scene: SolvedScene, r: CanvasRecipe, lines: TextLine[], seed = 1, snapshot: CanvasImageSource | null = null) {
  const totalH = stackHeight(lines);
  // v8: при наезде фото на заголовок стек прижимается к верху зоны.
  const overlap = r.fx?.photoOverlap && r.textZone === "top" ? r.fx.photoOverlap : 0;
  let y = scene.textRect.y + (overlap ? 0 : Math.max(0, (scene.textRect.h - totalH) / 2));
  const left = scene.align === "left";
  const plate = scene.plate;
  // На full-bleed макетах текст живёт на подложке либо белым по затемнению.
  const onPlate = scene.textOnPhoto && plate !== "none";
  const pc = plateColors(plate, r.palette);
  const ink = plate === "none" ? "#FFFFFF" : pc.ink;
  const accentInk = plate === "none" ? "#FFFFFF" : pc.inkAccent;
  // Поверхность под текстом: для текста поверх фото — средний цвет кадра с учётом затемнения.
  const scrim = Math.min(0.78, Math.max(0.3, r.overlay || 0.55));
  const photoSurface = scene.textOnPhoto && plate === "none"
    ? blendBlack(sampleSurface(ctx, scene.textRect) || "#1A1A1A", scrim)
    : null;
  const surface = plate === "none" ? (photoSurface || r.palette.bg) : pc.surface;
  // v7.4: второй акцент палитры для цифры и акцентного слова.
  const accent2 = (r.kit?.useAccent2 && r.palette.accent2) || r.palette.accent;
  // Крупная цифра — порог 3.5, мелкий акцентный текст — 4.5.
  const heroInk = pickContrast(surface, [accent2, accentInk, r.palette.accent, r.palette.fg, "#FFFFFF", "#111111"], 3.5);
  const badgeFill = pickContrast(surface, [plate === "circle" ? r.palette.bg : accent2, r.palette.fg, "#FFFFFF"], 2.6);
  const badgeInk = pickContrast(badgeFill, [r.palette.onAccent, r.palette.bg, "#FFFFFF", "#111111"], 4.5);
  const titleAccent = pickContrast(surface, [r.palette.accent, accentInk, "#FFFFFF", "#111111"], 4.5);
  let plateBox: Box | null = null;
  if (onPlate) {
    const pad = 34;
    plateBox = { x: scene.textRect.x - pad, y: y - pad, w: scene.textRect.w + pad * 2, h: totalH + pad * 2 };
    // v7: форма подложки из кита; для v5/v6 — исторические формы.
    if (plate === "glass") drawGlass(ctx, snapshot, plateBox, r.radius || 18, luminance(r.palette.bg) < 0.4);
    const kitPlate = r.kit && r.kit.plate !== "kit-none" && PLATE_KIT_MAP.has(r.kit.plate)
      ? drawKitPlate(ctx, r.kit.plate, plateBox, {
        fill: pc.fill, stroke: pc.stroke, accent: pc.accent ?? r.palette.accent, radius: r.radius || 18,
        seed, shadow: r.kit.shadow, skew: r.kit.skew,
      }, { w: PIN_W, h: PIN_H })
      : false;
    if (!kitPlate) {
      drawPlate(ctx, plate, plateBox, {
        fill: pc.fill, stroke: pc.stroke, accent: pc.accent, radius: r.radius || 18, seed,
      }, { w: PIN_W, h: PIN_H });
    }
  } else if (scene.textOnPhoto) {
    // v7.5: градиентное затемнение — сильнее у текста, прозрачное над остальным кадром.
    const strong = scrim;
    const mid = strong * 0.62;
    const top = scene.textRect.y < PIN_H / 2;
    if (top) {
      const end = scene.textRect.y + scene.textRect.h + 180;
      const g = ctx.createLinearGradient(0, 0, 0, end);
      g.addColorStop(0, `rgba(0,0,0,${strong})`); g.addColorStop(.55, `rgba(0,0,0,${mid})`); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, PIN_W, end);
    } else {
      const g = ctx.createLinearGradient(0, scene.textRect.y - 180, 0, PIN_H);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(.45, `rgba(0,0,0,${mid})`); g.addColorStop(1, `rgba(0,0,0,${strong})`);
      ctx.fillStyle = g; ctx.fillRect(0, scene.textRect.y - 180, PIN_W, PIN_H - scene.textRect.y + 180);
    }
  }
  if (r.doodles) {
    const box = plateBox || { x: scene.textRect.x, y, w: scene.textRect.w, h: totalH };
    scatterDoodles(ctx, box, scene.textOnPhoto && plate === "none" ? "#FFFFFF" : (onPlate ? accentInk : r.palette.accent), seed);
  }
  // v7.4: цифра-фон или цифра в углу рисуется до текста и вне общего стека.
  const detachedHero = lines.find((l) => l.detached && l.role === "hero");
  if (detachedHero) {
    const textBox = plateBox || { x: scene.textRect.x, y, w: scene.textRect.w, h: totalH };
    drawDetachedNumber(ctx, r, detachedHero, scene, { hero: heroInk, badgeFill, badgeInk, surface }, textBox);
  }
  const flow = lines.filter((l) => !l.detached);
  const lastTitle = flow.map((l) => l.role).lastIndexOf("title");
  for (let i = 0; i < flow.length; i++) {
    const line = flow[i];
    if (i && flow[i - 1].role !== line.role) y += 14;
    const tracking = line.role === "title" && r.titleTracking ? r.titleTracking : 0;
    if (tracking) setLetterSpacing(ctx, `${tracking}px`);
    ctx.font = `${line.weight} ${line.size}px "${line.font}"`;
    const metrics = ctx.measureText(line.text);
    const width = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight || metrics.width;
    // v8: выравнивание влево — чернила начинаются от левого края зоны; кнопка тоже прижата влево.
    const cx = left
      ? (line.role === "cta" ? scene.textRect.x + ctaBoxWidth(r.ctaStyle, line.size, width) / 2 : scene.textRect.x + width / 2)
      : scene.textRect.x + scene.textRect.w / 2;
    // Оптический центр: боковые выносы у шрифтов разные, центрируем по чернилам.
    const x = cx + (metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2;
    const inkLeft = x - metrics.actualBoundingBoxLeft;
    // v8: линейка над первой строкой заголовка.
    if (r.fx?.rule && line.role === "title" && flow.findIndex((l) => l.role === "title") === i) {
      ctx.save();
      ctx.strokeStyle = pickContrast(surface, [r.palette.accent, ink, r.palette.fg], 3); ctx.lineWidth = 3; ctx.globalAlpha = 0.9;
      const ry = y - 12;
      ctx.beginPath(); ctx.moveTo(scene.textRect.x, ry); ctx.lineTo(scene.textRect.x + scene.textRect.w, ry); ctx.stroke();
      ctx.restore();
      y += 10;
    }
    // Цифру центрируем внутри её слота: слот шире глифа на высоту формы кита.
    const baseline = line.role === "hero"
      ? y + (line.lineHeight + line.size * 0.72) / 2
      : y + line.size;
    if (line.role === "cta") {
      drawCta(ctx, r, line, cx, y, width, scene.textOnPhoto, onPlate ? ink : undefined, onPlate && pc.fill === r.palette.accent ? r.palette.onAccent : undefined);
      y += line.lineHeight;
      continue;
    }
    let kitInk: string | null = null;
    let kitOutline = false;

    if (line.role === "hero" && r.kit && r.kit.number !== "num-plain") {
      const res = drawKitNumber(ctx, r.kit.number, { cx, baseline, width, size: line.size }, {
        fill: badgeFill, ink: badgeInk, accent: heroInk, shadow: r.kit.shadow,
      });
      kitInk = res.ink;
      kitOutline = !!res.outline;
      ctx.font = `${line.weight} ${line.size}px "${line.font}"`;
    } else if (line.role === "title" && r.kit && r.kit.highlight !== "hl-none") {
      const singleTitle = lines.filter((l) => l.role === "title").length === 1;
      const hl = drawKitHighlight(ctx, r.kit.highlight, { x: inkLeft, baseline, width, size: line.size, single: singleTitle }, {
        accent: titleAccent, soft: r.palette.soft, ink: scene.textOnPhoto ? ink : r.palette.fg,
      });
      // Плотная заливка выделения — текст перекрашивается в контрастный цвет.
      if (hl.over) kitInk = pickContrast(hl.over, [r.palette.onAccent, r.palette.bg, "#FFFFFF", "#111111"], 4.5);
    } else if (line.role === "hero" && (r.numberStyle === "circle" || r.numberStyle === "square")) {
      const pad = line.size * .34;
      ctx.save();
      ctx.fillStyle = badgeFill;
      const bw = width + pad * 2, bh = line.size * 1.42;
      roundRect(ctx, cx - bw / 2, baseline - line.size * 1.06, bw, bh, r.numberStyle === "circle" ? bh / 2 : 12);
      ctx.fill();
      ctx.restore();
    } else if (line.role === "title") drawHighlight(ctx, line, inkLeft, baseline, width, r);
    ctx.fillStyle = kitInk ?? (line.role === "hero"
      ? (r.numberStyle === "circle" || r.numberStyle === "square"
        ? badgeInk
        : heroInk)
      // Любой текстовый цвет проверяем против реальной подложки.
      : pickContrast(surface, [scene.textOnPhoto ? ink : line.color, ink, r.palette.fg, "#FFFFFF", "#111111"], 4.5));
    ctx.textBaseline = "alphabetic";
    // v6: последняя строка заголовка может краситься акцентом.
    if (r.titleAccentWord && !kitInk && line.role === "title" && i === lastTitle) ctx.fillStyle = titleAccent;
    // v8: цвет акцентной части заголовка.
    if (line.emph && !kitInk) {
      const want = line.emph.color === "accent" ? titleAccent
        : line.emph.color === "accent2" ? pickContrast(surface, [r.palette.accent2, titleAccent], 4.5)
        : String(ctx.fillStyle);
      ctx.fillStyle = want;
    }
    if (kitOutline) {
      ctx.save();
      ctx.strokeStyle = kitInk || heroInk; ctx.lineWidth = Math.max(3, line.size * 0.05);
      ctx.strokeText(line.text, x, baseline);
      ctx.restore();
    } else if (line.role === "title" && (r.fx?.outline || r.fx?.textShadow)) {
      ctx.save();
      if (r.fx?.textShadow) { ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = Math.round(line.size * 0.22); ctx.shadowOffsetY = Math.round(line.size * 0.05); }
      drawTitleGlyphs(ctx, r, line, x, baseline, String(ctx.fillStyle), surface, titleAccent);
      ctx.restore();
    } else {
      ctx.fillText(line.text, x, baseline);
    }
    if (tracking) setLetterSpacing(ctx, "0px");
    y += line.lineHeight;
  }
}

/**
 * v7.4: цифра «идей» вне текстового стека — гигантская подложка-цифра
 * либо угловой блок. Кит цифры рисуется вместе с глифом как один блок.
 */
function drawDetachedNumber(
  ctx: Ctx2D, r: CanvasRecipe, line: TextLine,
  scene: SolvedScene,
  colors: { hero: string; badgeFill: string; badgeInk: string; surface: string },
  textBox: Box,
) {
  let place = r.kit?.numPlace || "np-ghost";
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.font = `900 ${line.size}px "${line.font}"`;
  const m = ctx.measureText(line.text);
  const w = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || m.width;
  const capH = line.size * 0.72;

  // Ghost-цифра требует широкой текстовой зоны — иначе уводим её в свободный угол.
  if (place === "np-ghost" && scene.textRect.w < 430) place = "np-corner-tl";

  if (place === "np-ghost") {
    const cx = scene.textRect.x + scene.textRect.w / 2;
    const cy = scene.textRect.y + scene.textRect.h / 2;
    // Прозрачность зависит от контраста цифры к подложке.
    const ratio = contrastRatio(colors.surface, colors.hero);
    ctx.globalAlpha = Math.min(0.3, Math.max(0.1, 0.42 / Math.max(1.2, ratio)));
    ctx.fillStyle = colors.hero;
    ctx.fillText(line.text, cx + (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2, cy + capH / 2);
    ctx.restore();
    return;
  }

  const pad = 34;
  let size = line.size;
  let boxW = Math.max(w + size * 0.7, size * 1.2);
  let boxH = capH + size * 0.55;
  // Домен занимает нижнюю полосу — считаем её занятой.
  const bottomBand: Box = { x: 0, y: PIN_H - 118, w: PIN_W, h: 118 };
  const corners = (bw: number, bh: number): Record<string, Box> => ({
    "np-corner-tl": { x: pad, y: pad, w: bw, h: bh },
    "np-corner-tr": { x: PIN_W - pad - bw, y: pad, w: bw, h: bh },
    "np-corner-bl": { x: pad, y: PIN_H - pad - bh, w: bw, h: bh },
    "np-corner-br": { x: PIN_W - pad - bw, y: PIN_H - pad - bh, w: bw, h: bh },
  });

  const order = ["np-corner-tl", "np-corner-tr", "np-corner-br", "np-corner-bl"];
  const tryPlace = (bw: number, bh: number): Box | null => {
    const all = corners(bw, bh);
    const wanted = all[place] ? [place, ...order.filter((o) => o !== place)] : order;
    for (const id of wanted) {
      const box = all[id];
      if (!rectsOverlap(box, textBox, 22) && !rectsOverlap(box, bottomBand, 0)) return box;
    }
    return null;
  };

  let box = tryPlace(boxW, boxH);
  if (!box) {
    // Уменьшаем цифру, пока она не перестанет задевать текст.
    for (let k = 0.85; k >= 0.5 && !box; k -= 0.12) {
      const s2 = Math.round(line.size * k);
      ctx.font = `900 ${s2}px "${line.font}"`;
      const mm = ctx.measureText(line.text);
      const w2 = (mm.actualBoundingBoxLeft + mm.actualBoundingBoxRight) || mm.width;
      const bw = Math.max(w2 + s2 * 0.7, s2 * 1.2), bh = s2 * 0.72 + s2 * 0.55;
      const hit = tryPlace(bw, bh);
      if (hit) { size = s2; boxW = bw; boxH = bh; box = hit; }
    }
  }
  if (!box) {
    // Совсем нет места — угол с наибольшим зазором от текста.
    const all = corners(boxW, boxH);
    const free = (b: Box) =>
      Math.max(0, Math.min(Math.abs(b.y + b.h - textBox.y), Math.abs(textBox.y + textBox.h - b.y)));
    box = order.map((id) => all[id]).sort((a, b) => free(b) - free(a))[0];
  }

  ctx.font = `900 ${size}px "${line.font}"`;
  const cx = box.x + box.w / 2;
  const baseline = box.y + box.h / 2 + size * 0.36;
  const res = r.kit && r.kit.number !== "num-plain"
    ? drawKitNumber(ctx, r.kit.number, { cx, baseline, width: boxW - size * 0.7, size }, {
      fill: colors.badgeFill, ink: colors.badgeInk, accent: colors.hero, shadow: r.kit.shadow,
    })
    : { ink: colors.hero, outline: false };
  ctx.font = `900 ${size}px "${line.font}"`;
  ctx.fillStyle = res.ink || colors.hero;
  const m2 = ctx.measureText(line.text);
  ctx.fillText(line.text, cx + (m2.actualBoundingBoxLeft - m2.actualBoundingBoxRight) / 2, baseline);
  ctx.restore();
}

/** Кнопка CTA: текст по центру плашки, под ней — стрелка на кнопку Pinterest. */
function drawCta(ctx: Ctx2D, r: CanvasRecipe, line: TextLine, cx: number, top: number, textW: number, onPhoto: boolean, plateInk?: string, plateAccent?: string) {
  const style = r.ctaStyle;
  const { padX, boxH } = ctaMetrics(line.size, style);
  const boxW = style === "bar" ? Math.min(textW + padX * 2 + 120, 760) : textW + padX * 2;
  const bx = cx - boxW / 2;
  const accent = plateAccent || r.palette.accent;
  const solidText = plateAccent ? r.palette.accent : r.palette.onAccent;
  let labelColor = solidText;
  const outlineInk = plateInk || (onPhoto ? "#FFFFFF" : accent);

  ctx.save();
  const kitCta = r.kit?.cta;
  if (kitCta && r.kit) {
    labelColor = drawKitCta(ctx, kitCta, { x: bx, y: top, w: boxW, h: boxH }, {
      accent, onAccent: solidText, ink: outlineInk, soft: r.palette.soft,
    }, { shadow: r.kit.shadow, skew: r.kit.skew, pinW: PIN_W });
  } else if (style === "pill") { ctx.fillStyle = accent; roundRect(ctx, bx, top, boxW, boxH, boxH / 2); ctx.fill(); }
  else if (style === "block") { ctx.fillStyle = accent; ctx.fillRect(bx, top, boxW, boxH); }
  else if (style === "bar") { ctx.fillStyle = accent; roundRect(ctx, bx, top, boxW, boxH, 10); ctx.fill(); }
  else if (style === "outline") {
    ctx.strokeStyle = accent; ctx.lineWidth = 3;
    roundRect(ctx, bx + 1.5, top + 1.5, boxW - 3, boxH - 3, boxH / 2); ctx.stroke();
    labelColor = outlineInk;
  } else if (style === "tag") {
    const notch = Math.min(20, boxH * 0.34);
    ctx.fillStyle = accent; ctx.beginPath();
    ctx.moveTo(bx, top); ctx.lineTo(bx + boxW - notch, top); ctx.lineTo(bx + boxW, top + notch);
    ctx.lineTo(bx + boxW, top + boxH); ctx.lineTo(bx + notch, top + boxH); ctx.lineTo(bx, top + boxH - notch);
    ctx.closePath(); ctx.fill();
  } else if (style === "frame") {
    ctx.strokeStyle = accent; ctx.lineWidth = 2;
    ctx.strokeRect(bx, top, boxW, boxH);
    ctx.strokeRect(bx + 7, top + 7, boxW - 14, boxH - 14);
    labelColor = outlineInk;
  } else if (style === "line") {
    labelColor = outlineInk;
  }

  ctx.font = `${line.weight} ${line.size}px "${line.font}"`;
  const labelMetrics = ctx.measureText(line.text);
  const labelX = cx + (labelMetrics.actualBoundingBoxLeft - labelMetrics.actualBoundingBoxRight) / 2;
  const labelY = top + boxH / 2 + (labelMetrics.actualBoundingBoxAscent - labelMetrics.actualBoundingBoxDescent) / 2;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = labelColor;
  ctx.fillText(line.text, labelX, labelY);
  if (kitCta ? CTA_UNDERLINED.has(kitCta) : style === "line") {
    ctx.strokeStyle = labelColor; ctx.lineWidth = Math.max(2, line.size * 0.09); ctx.lineCap = "round";
    const uw = textW; const uy = top + boxH / 2 + line.size * 0.72;
    ctx.beginPath(); ctx.moveTo(cx - uw / 2, uy); ctx.lineTo(cx + uw / 2, uy); ctx.stroke();
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.restore();

  drawCtaArrow(ctx, r, cx, top + boxH + CTA_GAP, line.size, onPhoto, plateInk || (plateAccent ? r.palette.onAccent : undefined));
}

/** Стрелка вниз — подсказка, что кнопка перехода под пином. */
function drawCtaArrow(ctx: Ctx2D, r: CanvasRecipe, cx: number, top: number, size: number, onPhoto: boolean, forced?: string) {
  const arrow = r.ctaArrow;
  if (!arrow || arrow === "none") return;
  const color = forced || (onPhoto ? "#FFFFFF" : r.palette.accent);
  const w = size * 0.82;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2.5, size * 0.11);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const chevron = (y: number, scale = 1) => {
    ctx.beginPath();
    ctx.moveTo(cx - (w / 2) * scale, y);
    ctx.lineTo(cx, y + (w / 2.4) * scale);
    ctx.lineTo(cx + (w / 2) * scale, y);
    ctx.stroke();
  };
  if (arrow === "chevron") chevron(top);
  else if (arrow === "double") { chevron(top, 0.78); chevron(top + size * 0.42, 0.78); }
  else if (arrow === "stem") {
    ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + size * 0.85); ctx.stroke();
    chevron(top + size * 0.5, 0.7);
  } else if (arrow === "dot") {
    ctx.beginPath(); ctx.arc(cx, top + size * 0.18, Math.max(2.5, size * 0.09), 0, Math.PI * 2); ctx.fill();
    chevron(top + size * 0.5, 0.7);
  }
  ctx.restore();
}

/**
 * v7.5: домен — отдельный элемент рецепта. Форма из кита, шрифт из роли
 * `subtext`, цвет считается от реальной подложки под подписью.
 */
function drawDomain(ctx: Ctx2D, domain: string, r: CanvasRecipe, onPhoto: boolean, roomBelow: boolean) {
  if (!domain.trim()) return;
  const font = r.roleFonts?.subtext || r.fonts.sans;
  const surface = onPhoto ? "#1A1A1A" : r.palette.bg;
  const accent2 = (r.kit?.useAccent2 && r.palette.accent2) || r.palette.accent;
  const ink = onPhoto ? "#FFFFFF" : pickContrast(surface, [r.palette.fg, accent2, "#111111"], 4.5);
  const fill = pickContrast(surface, [accent2, r.palette.fg, "#111111"], 2.6);
  const onFill = pickContrast(fill, [r.palette.onAccent, r.palette.bg, "#FFFFFF", "#111111"], 4.5);
  // Крупные подачи (лента, пилюля, рамка) только когда внизу есть место.
  const LOUD = new Set(["dom-bar", "dom-pill", "dom-outline", "dom-spaced-lg"]);
  const id = r.kit?.domain && (roomBelow || !LOUD.has(r.kit.domain)) ? r.kit.domain : "dom-spaced";
  drawKitDomain(ctx, id, domain, font, { ink, fill, onFill, onPhoto }, { w: PIN_W, h: PIN_H });
}

/**
 * v8: круглый стикер с текстом по кругу («NEW · IDEAS · NEW …») в свободном углу —
 * напротив текстовой зоны, выше полосы домена.
 */
function drawRingBadge(ctx: Ctx2D, r: CanvasRecipe, scene: SolvedScene, kicker: string, seed: number) {
  const R = 92, pad = 64;
  const textTop = scene.textRect.y + scene.textRect.h / 2 < PIN_H / 2;
  const cx = PIN_W - pad - R;
  const cy = textTop ? PIN_H - 150 - R : pad + R;
  const font = r.roleFonts?.cta || r.fonts.sans;
  const word = (kicker.trim() || "NEW IDEAS").toLocaleUpperCase().replace(/\s+/g, " ");
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.2 + ((seed % 5) - 2) * 0.05);
  ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
  ctx.fillStyle = r.palette.accent;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.strokeStyle = r.palette.onAccent; ctx.lineWidth = 2; ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.arc(0, 0, R - 10, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
  // Текст по кругу: повторяем слово с разделителем, пока не заполним окружность.
  const size = 22;
  ctx.font = `800 ${size}px "${font}"`;
  ctx.fillStyle = r.palette.onAccent;
  ctx.textBaseline = "middle"; ctx.textAlign = "center";
  const unit = `${word} · `;
  const rr = R - 30;
  const circ = Math.PI * 2 * rr;
  let text = unit;
  while (ctx.measureText(text + unit).width <= circ) text += unit;
  const chars = [...text];
  const total = chars.reduce((sum, c) => sum + ctx.measureText(c).width, 0);
  let a = -Math.PI / 2;
  for (const c of chars) {
    const w = ctx.measureText(c).width;
    const da = (w / total) * Math.PI * 2;
    ctx.save();
    ctx.rotate(a + da / 2);
    ctx.translate(0, -rr);
    ctx.fillText(c, 0, 0);
    ctx.restore();
    a += da;
  }
  // Центр: стрелка/звёздочка.
  ctx.font = `900 ${Math.round(R * 0.5)}px "${font}"`;
  ctx.fillText("✦", 0, 2);
  ctx.restore();
}

export interface RenderCanvasResult {
  jpeg: Buffer;
  /** Замечания решателя сцены (текст не влез, объект срезан и т.п.). */
  issues: string[];
}

/** Полный рендер: JPEG + замечания сцены. */
export async function renderCanvasPinDetailed(args: RenderCanvasArgs): Promise<RenderCanvasResult> {
  if (!args.photos.length) throw new Error("Нет фото для рендера");
  const r = args.recipe;
  loadFontFamilies([r.fonts.display, r.fonts.sans, r.fonts.body, r.fonts.script,
    r.roleFonts?.kicker, r.roleFonts?.number, r.roleFonts?.cta, r.roleFonts?.subtext]);
  const host = getHost();
  const canvas = host.createCanvas(PIN_W, PIN_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = r.palette.bg; ctx.fillRect(0, 0, PIN_W, PIN_H);
  const count = Math.min(r.photoCount || args.photos.length, args.photos.length);
  const imageRatios = args.photos.map((img) => img.width / Math.max(1, img.height));
  const accent = toAccent(r.accent);
  let focusY = 0.5;
  try { const b = accentBox(args.photos[0], accent); focusY = (b.y0 + b.y1) / 2; } catch { /* noop */ }
  // Выравнивание — инвариант рендерера (центр), даже для сохранённых v5-рецептов с `left`.
  // Тяжёлые подложки при 1–3 фото закрывают главный объект — заменяем на лёгкую форму.
  const wanted = r.plate ?? "none";
  const plate = HEAVY_PLATES.includes(wanted) && count < 4
    ? (wanted === "blob" || wanted === "sticker" ? "brush" : "band")
    : wanted;
  const overlap = r.fx?.photoOverlap && r.textZone === "top" ? Math.max(0, Math.min(160, r.fx.photoOverlap)) : 0;
  const solve = (textHeight: number, photos = count) => solveCanvasScene({
    family: r.family, count: photos, imageRatios, textHeight, padding: r.padding, radius: r.radius, gutter: r.gutter,
    // v8: выравнивание влево поддерживается (раньше всегда центр).
    align: r.titleAlign === "left" ? "left" : "center", accent, seed: args.seed || 1, plate, focusY, zone: r.textZone, overlap,
  });
  // v8: крупным заголовкам (постер 120–200 px) первая оценка зоны нужна выше, иначе кегль не поднимется.
  const tf0 = titleFitOf(r);
  let scene = solve(Math.max(320, Math.min(600, Math.round(tf0.max * 2.2 * tf0.leading))));
  let lines = measureTextStack(ctx, r, args.text, scene.textRect.w, scene.textRect.h, args.ideaCount, args.year);
  scene = solve(stackHeight(lines));
  if (scene.issues.includes("текст не помещается")) {
    lines = lines.map((l) => l.role === "title" ? { ...l, size: Math.max(38, l.size * .84), lineHeight: l.lineHeight * .84 } : l);
    scene = solve(stackHeight(lines), args.photos.length);
  }
  // v8: при наезде фото на заголовок текст рисуется первым, фото ложится сверху.
  if (overlap) {
    drawTextStack(ctx, scene, r, lines, args.seed || 1);
    drawPhotos(ctx, args, scene);
  } else {
    drawPhotos(ctx, args, scene);
    const snapshot = scene.plate === "glass" && host.snapshot ? host.snapshot(canvas) : null;
    drawTextStack(ctx, scene, r, lines, args.seed || 1, snapshot);
  }
  if (r.fx?.ringBadge) drawRingBadge(ctx, r, scene, args.text.kicker || "", args.seed || 1);
  // v6: доменная лента внизу — только если текстовый блок туда не заходит.
  const barSafe = scene.textRect.y + scene.textRect.h < PIN_H - 96;
  if (r.domainBar && (args.domain || "").trim() && barSafe) {
    drawDomainBar(ctx, args.domain || "", r.fonts.sans, { bg: r.palette.fg, fg: r.palette.bg }, { w: PIN_W, h: PIN_H });
  } else {
    drawDomain(ctx, args.domain || "", r, scene.textOnPhoto, barSafe);
  }

  if (r.decor === "frame") { ctx.strokeStyle = r.palette.accent; ctx.lineWidth = 18; ctx.strokeRect(9, 9, PIN_W - 18, PIN_H - 18); }
  // v8: зерно/бумага — раньше флаг сохранялся, но не рисовался.
  if (r.decor === "grain" || r.texture > 0) grain(ctx, Math.max(0.04, Math.min(0.09, r.texture || 0.06)), args.seed || 7);
  const jpeg = await host.encodeJpeg(canvas, 0.94);
  return { jpeg, issues: scene.issues };
}

/** Рендер пина → JPEG (quality 0.94). */
export async function renderCanvasPin(args: RenderCanvasArgs): Promise<Buffer> {
  return (await renderCanvasPinDetailed(args)).jpeg;
}
