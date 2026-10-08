/**
 * Canvas Kit v7 (порт canvasKit.ts) — библиотека независимых элементов
 * оформления: подложки, подложки под цифру, выделения, кнопки, доп. текст,
 * раскладки, сетки, рамки, размещение цифры, подача домена.
 * Всё рисуется кодом на canvas, без внешних ассетов.
 */

import { roundRect } from "./decor";
import type { Ctx2D } from "./host";
import type { CanvasFamily, PlateKind } from "./layoutSolver";

export interface KitBox { x: number; y: number; w: number; h: number }
export interface KitSpec {
  plate: string;
  number: string;
  highlight: string;
  cta: string;
  subtext: string;
  grid: string;
  layout: string;
  /** Тень элементов (только формы, к тексту не применяется). */
  shadow: "none" | "soft" | "hard";
  /** Наклон подложек и плашек в градусах (косые линии). */
  skew: number;
  /* ---------- v7.4 ---------- */
  /** Рамка/обводка кадров фото (см. FRAME_KITS). */
  frame?: string;
  /** Размещение цифры «идей» (см. NUMBER_PLACEMENTS). */
  numPlace?: string;
  /** Второй акцент палитры для цифры/рамок/второго слова. */
  useAccent2?: boolean;
  /* ---------- v7.5 ---------- */
  /** Подача домена (см. DOMAIN_KITS). */
  domain?: string;
}


const rnd = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
};

/**
 * Тень заметно смягчена: раньше «подложка тени» под текстом читалась как
 * грязное пятно. Теперь это лёгкий объём формы, а не отдельный слой.
 */
function applyShadow(ctx: Ctx2D, mode: KitSpec["shadow"], color: string) {
  if (mode === "none") return;
  if (mode === "soft") { ctx.shadowColor = "rgba(0,0,0,.16)"; ctx.shadowBlur = 22; ctx.shadowOffsetY = 7; }
  else { ctx.shadowColor = color; ctx.shadowBlur = 0; ctx.shadowOffsetX = 5; ctx.shadowOffsetY = 5; }
}
function clearShadow(ctx: Ctx2D) {
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}
function withSkew(ctx: Ctx2D, box: KitBox, deg: number, fn: () => void) {
  if (!deg) { fn(); return; }
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

/* ============================================================
 * 1. Подложки под текст: форма × обработка (~50)
 * ========================================================== */

type PlateShapeId =
  | "rect" | "pill" | "arch" | "arch-down" | "slab" | "diagonal" | "notch" | "chevron"
  | "tape" | "brush" | "torn" | "blob" | "ticket" | "hexagon" | "wave" | "step"
  | "ribbon" | "glass" | "tag" | "none";

interface PlateShape {
  id: PlateShapeId; name: string; weight: "light" | "heavy"; base: PlateKind;
  path: (ctx: Ctx2D, b: KitBox, r: number, rand: () => number, pin: { w: number; h: number }) => void;
}

/** Каждая форма строит путь; заливка/обводка добавляются обработкой. */
const PLATE_SHAPES: PlateShape[] = [
  { id: "rect", name: "Карточка", weight: "heavy", base: "card", path: (c, b, r) => roundRect(c, b.x, b.y, b.w, b.h, r) },
  { id: "pill", name: "Пилюля", weight: "light", base: "band", path: (c, b) => roundRect(c, b.x - 10, b.y, b.w + 20, b.h, b.h / 2) },
  {
    id: "arch", name: "Арка", weight: "light", base: "arch",
    path: (c, b) => {
      const rad = Math.min(b.w / 2, b.h * 0.55);
      c.beginPath(); c.moveTo(b.x, b.y + b.h); c.lineTo(b.x, b.y + rad);
      c.quadraticCurveTo(b.x, b.y, b.x + rad, b.y); c.lineTo(b.x + b.w - rad, b.y);
      c.quadraticCurveTo(b.x + b.w, b.y, b.x + b.w, b.y + rad);
      c.lineTo(b.x + b.w, b.y + b.h); c.closePath();
    },
  },
  {
    id: "arch-down", name: "Обратная арка", weight: "light", base: "arch",
    path: (c, b) => {
      const rad = Math.min(b.w / 2, b.h * 0.55);
      c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x + b.w, b.y);
      c.lineTo(b.x + b.w, b.y + b.h - rad);
      c.quadraticCurveTo(b.x + b.w, b.y + b.h, b.x + b.w - rad, b.y + b.h);
      c.lineTo(b.x + rad, b.y + b.h);
      c.quadraticCurveTo(b.x, b.y + b.h, b.x, b.y + b.h - rad); c.closePath();
    },
  },
  {
    id: "slab", name: "Скошенная плита", weight: "light", base: "band",
    path: (c, b) => {
      const off = b.h * 0.14;
      c.beginPath(); c.moveTo(b.x, b.y + off); c.lineTo(b.x + b.w, b.y);
      c.lineTo(b.x + b.w, b.y + b.h - off); c.lineTo(b.x, b.y + b.h); c.closePath();
    },
  },
  {
    id: "diagonal", name: "Диагональный срез", weight: "light", base: "band",
    path: (c, b, _r, _rand, pin) => {
      const off = b.h * 0.22;
      c.beginPath(); c.moveTo(0, b.y + off); c.lineTo(pin.w, b.y - off * 0.2);
      c.lineTo(pin.w, b.y + b.h - off * 0.2); c.lineTo(0, b.y + b.h + off); c.closePath();
    },
  },
  {
    id: "notch", name: "Тег с вырезом", weight: "light", base: "band",
    path: (c, b) => {
      const n = Math.min(30, b.h * 0.26);
      c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x + b.w - n, b.y); c.lineTo(b.x + b.w, b.y + n);
      c.lineTo(b.x + b.w, b.y + b.h); c.lineTo(b.x + n, b.y + b.h); c.lineTo(b.x, b.y + b.h - n); c.closePath();
    },
  },
  {
    id: "chevron", name: "Шеврон-лента", weight: "light", base: "ribbon",
    path: (c, b) => {
      const t = Math.min(38, b.h * 0.3);
      c.beginPath(); c.moveTo(b.x - t, b.y); c.lineTo(b.x + b.w + t, b.y);
      c.lineTo(b.x + b.w + t - t * 0.7, b.y + b.h / 2); c.lineTo(b.x + b.w + t, b.y + b.h);
      c.lineTo(b.x - t, b.y + b.h); c.lineTo(b.x - t + t * 0.7, b.y + b.h / 2); c.closePath();
    },
  },
  { id: "tape", name: "Скотч", weight: "light", base: "tape", path: (c, b) => { c.beginPath(); c.rect(b.x - 26, b.y, b.w + 52, b.h); } },
  {
    id: "brush", name: "Брашевый мазок", weight: "light", base: "brush",
    path: (c, b, _r, rand) => {
      const w = b.h * 0.14;
      c.beginPath();
      c.moveTo(b.x - 20, b.y + w * rand());
      c.bezierCurveTo(b.x + b.w * 0.3, b.y - w, b.x + b.w * 0.7, b.y + w * 0.6, b.x + b.w + 20, b.y + w * 0.2);
      c.lineTo(b.x + b.w + 14, b.y + b.h - w * 0.3);
      c.bezierCurveTo(b.x + b.w * 0.7, b.y + b.h + w, b.x + b.w * 0.3, b.y + b.h - w * 0.7, b.x - 16, b.y + b.h - w * 0.1);
      c.closePath();
    },
  },
  {
    id: "torn", name: "Рваная бумага", weight: "light", base: "torn",
    path: (c, b, _r, rand) => {
      const step = b.w / 18;
      c.beginPath(); c.moveTo(b.x, b.y);
      for (let i = 0; i <= 18; i++) c.lineTo(b.x + step * i, b.y + (i % 2 ? 11 : 0) * rand());
      c.lineTo(b.x + b.w, b.y + b.h);
      for (let i = 18; i >= 0; i--) c.lineTo(b.x + step * i, b.y + b.h - (i % 2 ? 11 : 0) * rand());
      c.closePath();
    },
  },
  {
    id: "blob", name: "Мягкая клякса", weight: "heavy", base: "blob",
    path: (c, b, _r, rand) => {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2 + 20, ry = b.h / 2 + 24;
      c.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.001; a += Math.PI / 20) {
        const wob = 1 + Math.sin(a * 3 + rand() * 0.3) * 0.042;
        const px = cx + Math.cos(a) * rx * wob, py = cy + Math.sin(a) * ry * wob;
        if (a === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath();
    },
  },
  {
    id: "ticket", name: "Купон", weight: "heavy", base: "ticket",
    path: (c, b) => roundRect(c, b.x, b.y, b.w, b.h, 14),
  },
  {
    id: "hexagon", name: "Шестиугольник", weight: "heavy", base: "card",
    path: (c, b) => {
      const cut = Math.min(b.w * 0.12, b.h * 0.5);
      c.beginPath();
      c.moveTo(b.x + cut, b.y); c.lineTo(b.x + b.w - cut, b.y); c.lineTo(b.x + b.w, b.y + b.h / 2);
      c.lineTo(b.x + b.w - cut, b.y + b.h); c.lineTo(b.x + cut, b.y + b.h); c.lineTo(b.x, b.y + b.h / 2);
      c.closePath();
    },
  },
  {
    id: "wave", name: "Волна", weight: "light", base: "band",
    path: (c, b) => {
      const a = Math.min(16, b.h * 0.12);
      c.beginPath(); c.moveTo(b.x, b.y + a);
      c.bezierCurveTo(b.x + b.w * 0.3, b.y - a, b.x + b.w * 0.7, b.y + a * 2, b.x + b.w, b.y);
      c.lineTo(b.x + b.w, b.y + b.h - a);
      c.bezierCurveTo(b.x + b.w * 0.7, b.y + b.h + a, b.x + b.w * 0.3, b.y + b.h - a * 2, b.x, b.y + b.h);
      c.closePath();
    },
  },
  {
    id: "step", name: "Ступенька", weight: "light", base: "card",
    path: (c, b) => {
      const s = Math.min(34, b.h * 0.24);
      c.beginPath();
      c.moveTo(b.x, b.y + s); c.lineTo(b.x + s, b.y + s); c.lineTo(b.x + s, b.y);
      c.lineTo(b.x + b.w, b.y); c.lineTo(b.x + b.w, b.y + b.h - s); c.lineTo(b.x + b.w - s, b.y + b.h - s);
      c.lineTo(b.x + b.w - s, b.y + b.h); c.lineTo(b.x, b.y + b.h); c.closePath();
    },
  },
  {
    id: "ribbon", name: "Лента с хвостами", weight: "light", base: "ribbon",
    path: (c, b) => {
      const t = Math.min(34, b.h * 0.3);
      c.beginPath();
      c.moveTo(b.x - t, b.y - t * 0.3); c.lineTo(b.x + b.w + t, b.y - t * 0.3);
      c.lineTo(b.x + b.w + t, b.y + b.h + t * 0.3); c.lineTo(b.x - t, b.y + b.h + t * 0.3); c.closePath();
    },
  },
  { id: "glass", name: "Стекло", weight: "light", base: "glass", path: (c, b, r) => roundRect(c, b.x, b.y, b.w, b.h, Math.max(20, r)) },
  {
    id: "tag", name: "Угловая метка", weight: "light", base: "band",
    path: (c, b) => {
      const cut = Math.min(46, b.h * 0.36);
      c.beginPath(); c.moveTo(b.x, b.y); c.lineTo(b.x + b.w, b.y);
      c.lineTo(b.x + b.w, b.y + b.h - cut); c.lineTo(b.x + b.w - cut, b.y + b.h);
      c.lineTo(b.x, b.y + b.h); c.closePath();
    },
  },
  { id: "none", name: "Без подложки", weight: "light", base: "none", path: () => { /* noop */ } },
];

type PlateDecoId = "flat" | "offset" | "stack" | "inner" | "outline" | "dotted" | "split" | "grad";
interface PlateDeco { id: PlateDecoId; name: string }
const PLATE_DECOS: PlateDeco[] = [
  { id: "flat", name: "гладкая" },
  { id: "offset", name: "со смещением" },
  { id: "stack", name: "двойная" },
  { id: "inner", name: "с внутренней рамкой" },
  { id: "outline", name: "с обводкой" },
  { id: "dotted", name: "пунктир" },
  { id: "split", name: "двухцветная" },
  { id: "grad", name: "с градиентом" },
];

export interface PlateKit {
  id: string; name: string;
  /** Насколько сильно форма перекрывает кадр: heavy — только коллажи 4+. */
  weight: "light" | "heavy";
  base: PlateKind;
  shape: PlateShapeId;
  deco: PlateDecoId;
}

/** Сочетания «форма × обработка»: часть комбинаций отсеяна как визуальный шум. */
const PLATE_DECO_MAP: Record<PlateShapeId, PlateDecoId[]> = {
  rect: ["flat", "offset", "stack", "inner", "outline", "dotted", "split", "grad"],
  pill: ["flat", "offset", "outline", "grad"],
  arch: ["flat", "inner", "outline", "grad"],
  "arch-down": ["flat", "inner", "outline"],
  slab: ["flat", "offset", "split"],
  diagonal: ["flat", "split", "grad"],
  notch: ["flat", "offset", "outline"],
  chevron: ["flat", "split"],
  tape: ["flat", "grad"],
  brush: ["flat", "offset"],
  torn: ["flat", "split"],
  blob: ["flat", "outline", "offset"],
  ticket: ["flat", "inner", "dotted"],
  hexagon: ["flat", "outline", "inner"],
  wave: ["flat", "grad"],
  step: ["flat", "split", "outline"],
  ribbon: ["flat", "split"],
  glass: ["flat", "inner"],
  tag: ["flat", "outline", "offset"],
  none: ["flat"],
};

const SHAPE_MAP = new Map(PLATE_SHAPES.map((s) => [s.id, s]));

export const PLATE_KITS: PlateKit[] = (() => {
  const out: PlateKit[] = [];
  PLATE_SHAPES.forEach((shape) => {
    if (shape.id === "none") { out.push({ id: "kit-none", name: "Без подложки", weight: "light", base: "none", shape: "none", deco: "flat" }); return; }
    PLATE_DECO_MAP[shape.id].forEach((deco) => {
      const d = PLATE_DECOS.find((x) => x.id === deco)!;
      out.push({
        id: `plate-${shape.id}-${deco}`,
        name: deco === "flat" ? shape.name : `${shape.name} · ${d.name}`,
        weight: shape.weight, base: shape.base, shape: shape.id, deco,
      });
    });
  });
  return out;
})();

export const PLATE_KIT_MAP = new Map(PLATE_KITS.map((p) => [p.id, p]));

export interface PlatePaint {
  fill: string; stroke?: string; accent?: string; radius: number; seed: number;
  shadow: KitSpec["shadow"]; skew: number;
}

/** Рисует подложку из кита. Возвращает false, если формы нет. */
export function drawKitPlate(
  ctx: Ctx2D, id: string, box: KitBox, paint: PlatePaint, pin: { w: number; h: number },
): boolean {
  const kit = PLATE_KIT_MAP.get(id);
  if (!kit || kit.shape === "none") return false;
  const shape = SHAPE_MAP.get(kit.shape)!;
  const r = paint.radius || 22;
  const accent = paint.accent || paint.fill;
  ctx.save();

  const trace = (b: KitBox, seed: number) => shape.path(ctx, b, r, rnd(seed), pin);

  const body = () => {
    // Слои обработки под основной формой.
    if (kit.deco === "offset") {
      ctx.save(); ctx.fillStyle = accent; ctx.globalAlpha = 0.9;
      trace({ ...box, x: box.x + 13, y: box.y + 13 }, paint.seed); ctx.fill(); ctx.restore();
    } else if (kit.deco === "stack") {
      ctx.save(); ctx.fillStyle = paint.fill; ctx.globalAlpha = 0.38;
      trace({ ...box, x: box.x - 15, y: box.y - 15 }, paint.seed); ctx.fill(); ctx.restore();
    }

    // Основная заливка.
    ctx.save();
    if (kit.deco === "grad") {
      const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h);
      g.addColorStop(0, paint.fill); g.addColorStop(1, accent);
      ctx.fillStyle = g;
    } else if (kit.shape === "glass") {
      ctx.globalAlpha = 0.55; ctx.fillStyle = paint.fill;
    } else if (kit.shape === "tape") {
      ctx.globalAlpha = 0.92; ctx.fillStyle = paint.fill;
    } else {
      ctx.fillStyle = paint.fill;
    }
    trace(box, paint.seed); ctx.fill();
    ctx.restore();

    // Купон: полукруглые вырезы по бокам.
    if (kit.shape === "ticket") {
      ctx.save(); ctx.globalCompositeOperation = "destination-out";
      [box.x, box.x + box.w].forEach((cx) => { ctx.beginPath(); ctx.arc(cx, box.y + box.h / 2, 18, 0, Math.PI * 2); ctx.fill(); });
      ctx.restore();
    }

    // Двухцветная половина.
    if (kit.deco === "split") {
      ctx.save();
      trace(box, paint.seed); ctx.clip();
      ctx.fillStyle = accent; ctx.globalAlpha = 0.9;
      ctx.fillRect(box.x, box.y + box.h * 0.62, box.w, box.h * 0.38);
      ctx.restore();
    }

    // Обводки поверх.
    clearShadow(ctx);
    if (kit.deco === "outline") {
      ctx.save(); ctx.strokeStyle = paint.stroke || accent; ctx.lineWidth = 8; ctx.lineJoin = "round";
      trace(box, paint.seed); ctx.stroke(); ctx.restore();
    } else if (kit.deco === "inner") {
      ctx.save(); ctx.strokeStyle = paint.stroke || accent; ctx.lineWidth = 1.8;
      trace({ x: box.x + 14, y: box.y + 14, w: box.w - 28, h: box.h - 28 }, paint.seed); ctx.stroke(); ctx.restore();
    } else if (kit.deco === "dotted") {
      ctx.save(); ctx.strokeStyle = paint.stroke || accent; ctx.lineWidth = 2.5; ctx.setLineDash([9, 8]);
      trace({ x: box.x + 12, y: box.y + 12, w: box.w - 24, h: box.h - 24 }, paint.seed); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    } else if (kit.shape === "glass") {
      ctx.save(); ctx.strokeStyle = "rgba(255,255,255,.32)"; ctx.lineWidth = 2;
      trace(box, paint.seed); ctx.stroke(); ctx.restore();
    }
  };

  applyShadow(ctx, paint.shadow, accent);
  withSkew(ctx, box, paint.skew, body);
  clearShadow(ctx);
  ctx.restore();
  return true;
}

/* ============================================================
 * 2. Подложки под цифру: форма × обработка (~50)
 * ========================================================== */

type NumShapeId = "circle" | "square" | "rounded" | "diamond" | "hexagon" | "shield" | "arch" | "ribbon" | "burst" | "pill" | "none";
type NumTreatId = "solid" | "outline" | "offset" | "double" | "dashed" | "rays" | "ghost";

const NUM_TREATS: Record<NumTreatId, string> = {
  solid: "заливка", outline: "контур", offset: "со смещением", double: "двойная",
  dashed: "пунктир", rays: "с лучами", ghost: "полупрозрачная",
};
const NUM_SHAPE_NAMES: Record<NumShapeId, string> = {
  circle: "Круг", square: "Квадрат", rounded: "Скругление", diamond: "Ромб", hexagon: "Шестиугольник",
  shield: "Щит", arch: "Арка", ribbon: "Лента", burst: "Звезда-печать", pill: "Пилюля", none: "Без подложки",
};
const NUM_COMBOS: Record<NumShapeId, NumTreatId[]> = {
  circle: ["solid", "outline", "offset", "double", "dashed", "rays", "ghost"],
  square: ["solid", "outline", "offset", "double"],
  rounded: ["solid", "outline", "offset", "double", "dashed"],
  diamond: ["solid", "outline", "offset"],
  hexagon: ["solid", "outline", "double"],
  shield: ["solid", "outline"],
  arch: ["solid", "outline", "offset"],
  ribbon: ["solid", "offset"],
  burst: ["solid", "outline"],
  pill: ["solid", "outline", "offset", "dashed"],
  none: ["solid", "outline", "ghost"],
};

export interface NumberKit { id: string; name: string; shape: NumShapeId; treat: NumTreatId }

export const NUMBER_KITS: NumberKit[] = (() => {
  const out: NumberKit[] = [];
  (Object.keys(NUM_COMBOS) as NumShapeId[]).forEach((shape) => {
    NUM_COMBOS[shape].forEach((treat) => {
      const id = shape === "none"
        ? (treat === "solid" ? "num-plain" : `num-plain-${treat}`)
        : `num-${shape}-${treat}`;
      out.push({
        id,
        name: treat === "solid" ? NUM_SHAPE_NAMES[shape] : `${NUM_SHAPE_NAMES[shape]} · ${NUM_TREATS[treat]}`,
        shape, treat,
      });
    });
  });
  return out;
})();

export const NUMBER_KIT_MAP = new Map(NUMBER_KITS.map((n) => [n.id, n]));

export interface NumberPaint { fill: string; ink: string; accent: string; shadow: KitSpec["shadow"] }

function numberPath(ctx: Ctx2D, shape: NumShapeId, cx: number, cy: number, w: number, h: number) {
  const rx = w / 2, ry = h / 2;
  switch (shape) {
    case "circle": {
      const r = Math.max(rx, ry);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); break;
    }
    case "square":
      ctx.beginPath(); ctx.rect(cx - rx, cy - ry, w, h); break;
    case "rounded":
      roundRect(ctx, cx - rx, cy - ry, w, h, Math.min(w, h) * 0.24); break;
    case "pill":
      roundRect(ctx, cx - rx, cy - ry, w, h, Math.min(w, h) / 2); break;
    case "diamond":
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry * 1.18); ctx.lineTo(cx + rx * 1.18, cy);
      ctx.lineTo(cx, cy + ry * 1.18); ctx.lineTo(cx - rx * 1.18, cy); ctx.closePath();
      break;
    case "hexagon": {
      const r = Math.max(rx, ry);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath(); break;
    }
    case "shield":
      ctx.beginPath();
      ctx.moveTo(cx - rx, cy - ry); ctx.lineTo(cx + rx, cy - ry); ctx.lineTo(cx + rx, cy + ry * 0.25);
      ctx.quadraticCurveTo(cx, cy + ry * 1.35, cx - rx, cy + ry * 0.25); ctx.closePath();
      break;
    case "arch":
      ctx.beginPath();
      ctx.moveTo(cx - rx, cy + ry); ctx.lineTo(cx - rx, cy);
      ctx.arc(cx, cy, rx, Math.PI, 0); ctx.lineTo(cx + rx, cy + ry); ctx.closePath();
      break;
    case "ribbon":
      ctx.beginPath(); ctx.rect(cx - rx * 1.6, cy - ry * 0.78, w * 1.6, h * 0.78); break;
    case "burst": {
      const r = Math.max(rx, ry);
      ctx.beginPath();
      for (let i = 0; i < 24; i++) {
        const a = (Math.PI * 2 * i) / 24;
        const rr = i % 2 ? r * 0.86 : r * 1.08;
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath(); break;
    }
    default:
      ctx.beginPath();
  }
}

/**
 * Рисует подложку вокруг крупной цифры и возвращает цвет самой цифры.
 *
 * Геометрия считается от реальной высоты глифа (cap height), а не от кегля,
 * поэтому цифра стоит строго в центре формы — раньше подложка уезжала вверх.
 */
export function drawKitNumber(
  ctx: Ctx2D, id: string,
  geo: { cx: number; baseline: number; width: number; size: number },
  paint: NumberPaint,
): { ink: string; outline?: boolean } {
  const kit = NUMBER_KIT_MAP.get(id);
  const { cx, baseline, width, size } = geo;
  const cap = size * 0.72;               // реальная высота цифр
  const cy = baseline - cap / 2;         // оптический центр глифа
  if (!kit || kit.shape === "none") {
    if (kit?.treat === "outline") return { ink: paint.accent, outline: true };
    return { ink: paint.accent };
  }
  const pad = size * 0.42;
  const w = Math.max(width + pad, cap + pad);
  const h = kit.shape === "ribbon" ? cap + pad * 0.8 : Math.max(cap + pad, w * 0.72);

  ctx.save();
  if (kit.shape === "ribbon") { ctx.translate(cx, cy); ctx.rotate(-0.06); ctx.translate(-cx, -cy); }

  if (kit.treat === "rays") {
    const r = Math.max(w, h) / 2;
    ctx.strokeStyle = paint.accent; ctx.lineWidth = 4; ctx.lineCap = "round";
    for (let i = 0; i < 16; i++) {
      const a = (Math.PI * 2 * i) / 16;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r + 10), cy + Math.sin(a) * (r + 10));
      ctx.lineTo(cx + Math.cos(a) * (r + 24), cy + Math.sin(a) * (r + 24));
      ctx.stroke();
    }
  }
  if (kit.treat === "offset") {
    ctx.save(); ctx.fillStyle = paint.accent; ctx.globalAlpha = 0.85;
    numberPath(ctx, kit.shape, cx + 10, cy + 10, w, h); ctx.fill(); ctx.restore();
  }
  if (kit.treat === "double") {
    ctx.save(); ctx.strokeStyle = paint.accent; ctx.lineWidth = 3;
    numberPath(ctx, kit.shape, cx, cy, w + 20, h + 20); ctx.stroke(); ctx.restore();
  }

  let ink = paint.ink;
  if (kit.treat === "outline" || kit.treat === "dashed") {
    ctx.strokeStyle = paint.accent; ctx.lineWidth = kit.treat === "dashed" ? 4 : 5;
    if (kit.treat === "dashed") ctx.setLineDash([11, 9]);
    numberPath(ctx, kit.shape, cx, cy, w, h); ctx.stroke();
    ctx.setLineDash([]);
    ink = paint.accent;
  } else if (kit.treat === "ghost") {
    ctx.globalAlpha = 0.22; ctx.fillStyle = paint.accent;
    numberPath(ctx, kit.shape, cx, cy, w * 1.25, h * 1.25); ctx.fill();
    ctx.globalAlpha = 1;
    ink = paint.accent;
  } else {
    ctx.fillStyle = paint.fill;
    numberPath(ctx, kit.shape, cx, cy, w, h); ctx.fill();
  }
  ctx.restore();
  return { ink };
}

/* ============================================================
 * 3. Выделения текста (~50)
 * Зачёркивание и «скобки»-кавычки удалены: они портили заголовок.
 * ========================================================== */

type HlKind = "fill" | "underline" | "frame" | "side";
interface HighlightKit { id: string; name: string; kind: HlKind; variant: string; alpha: number }

const HL_FILLS: Array<[string, string, number]> = [
  ["marker", "Маркер", 0.6],
  ["marker-soft", "Мягкий маркер", 0.35],
  ["marker-solid", "Плотный маркер", 0.95],
  ["skew", "Косой маркер", 0.62],
  ["rough", "Рваный маркер", 0.62],
  ["chip", "Чип", 1],
  ["chip-soft", "Мягкий чип", 0.55],
  ["gradient", "Градиент", 0.8],
  ["gradient-soft", "Мягкий градиент", 0.5],
  ["half", "Половина строки", 0.7],
  ["block", "Блок", 1],
  ["tape", "Скотч", 0.85],
];
const HL_UNDERLINES: Array<[string, string]> = [
  ["thin", "Тонкая линия"],
  ["thick", "Толстая линия"],
  ["brush", "Браш"],
  ["double", "Двойная"],
  ["dotted", "Пунктир"],
  ["wave", "Волна"],
  ["offset", "Смещённая"],
  ["short", "Короткая"],
  ["gradient", "Градиентная"],
  ["soft", "Мягкая"],
];
const HL_FRAMES: Array<[string, string]> = [
  ["box", "Рамка"],
  ["round", "Скруглённая рамка"],
  ["pill", "Рамка-пилюля"],
  ["dotted", "Пунктирная рамка"],
  ["double", "Двойная рамка"],
  ["thick", "Толстая рамка"],
  ["skew", "Косая рамка"],
];
const HL_SIDES: Array<[string, string]> = [
  ["bar-left", "Полоса слева"],
  ["bar-both", "Полосы по краям"],
  ["dot-left", "Точка слева"],
  ["arrow", "Стрелка"],
  ["plus", "Плюс"],
  ["star", "Звезда"],
];

export const HIGHLIGHT_KITS: HighlightKit[] = [
  ...HL_FILLS.map(([v, n, a]) => ({ id: `hl-fill-${v}`, name: n, kind: "fill" as const, variant: v, alpha: a })),
  ...HL_UNDERLINES.map(([v, n]) => ({ id: `hl-line-${v}`, name: n, kind: "underline" as const, variant: v, alpha: 1 })),
  ...HL_FRAMES.map(([v, n]) => ({ id: `hl-frame-${v}`, name: n, kind: "frame" as const, variant: v, alpha: 1 })),
  ...HL_SIDES.map(([v, n]) => ({ id: `hl-side-${v}`, name: n, kind: "side" as const, variant: v, alpha: 1 })),
  { id: "hl-none", name: "Без выделения", kind: "fill", variant: "none", alpha: 0 },
];

const HIGHLIGHT_MAP = new Map(HIGHLIGHT_KITS.map((h) => [h.id, h]));

/**
 * Сколько дополнительной высоты строке нужно, чтобы плашка выделения
 * не наезжала на соседние строки заголовка и на подпись под ним.
 */
export function highlightExtraRoom(id: string, size: number): number {
  const kit = HIGHLIGHT_MAP.get(id);
  if (!kit || kit.variant === "none") return 0;
  if (kit.kind === "fill") return size * 0.3;
  if (kit.kind === "frame") return size * 0.24;
  if (kit.kind === "underline") return size * 0.16;
  return 0;
}

/** Реальная высота блока цифры вместе с формой кита. */
export function kitNumberHeight(id: string, size: number, width: number): number {
  const kit = NUMBER_KIT_MAP.get(id);
  const cap = size * 0.72;
  if (!kit || kit.shape === "none") return cap;
  const pad = size * 0.42;
  const w = Math.max(width + pad, cap + pad);
  const h = kit.shape === "ribbon" ? cap + pad * 0.8 : Math.max(cap + pad, w * 0.72);
  return kit.treat === "ghost" ? h * 1.25 : h;
}

export interface HighlightPaint { accent: string; soft: string; ink: string }


/** Рисуется ДО текста. */
export function drawKitHighlight(
  ctx: Ctx2D, id: string,
  geo: { x: number; baseline: number; width: number; size: number; single?: boolean },
  paint: HighlightPaint,
): { over?: string } {
  let kit = HIGHLIGHT_MAP.get(id);
  if (!kit || kit.variant === "none") return {};
  // Рамки читаются только вокруг одной строки: на многострочном заголовке
  // они превращались в «скобки» вокруг каждого слова.
  if (kit.kind === "frame" && geo.single === false) kit = HIGHLIGHT_MAP.get("hl-line-thin")!;
  const { x, baseline, width, size } = geo;
  const top = baseline - size * 0.76, h = size * 0.9;
  ctx.save();
  ctx.globalAlpha = kit.alpha;
  ctx.fillStyle = paint.accent;
  ctx.strokeStyle = paint.accent;
  ctx.lineCap = "round";

  if (kit.kind === "fill") {
    switch (kit.variant) {
      case "skew": {
        const off = size * 0.14;
        ctx.beginPath();
        ctx.moveTo(x - 14, top + off); ctx.lineTo(x + width + 14, top - off * 0.4);
        ctx.lineTo(x + width + 14, top + h - off * 0.4); ctx.lineTo(x - 14, top + h + off);
        ctx.closePath(); ctx.fill();
        break;
      }
      case "rough": {
        const step = width / 10;
        ctx.beginPath(); ctx.moveTo(x - 10, top + 4);
        for (let i = 0; i <= 10; i++) ctx.lineTo(x + step * i, top + (i % 2 ? 6 : 0));
        ctx.lineTo(x + width + 10, top + h);
        for (let i = 10; i >= 0; i--) ctx.lineTo(x + step * i, top + h - (i % 2 ? 6 : 0));
        ctx.closePath(); ctx.fill();
        break;
      }
      case "chip":
      case "chip-soft":
        ctx.fillStyle = kit.variant === "chip" ? paint.soft : paint.accent;
        roundRect(ctx, x - 18, top - size * 0.08, width + 36, h + size * 0.16, size); ctx.fill();
        break;
      case "gradient":
      case "gradient-soft": {
        const g = ctx.createLinearGradient(x, 0, x + width, 0);
        g.addColorStop(0, paint.accent); g.addColorStop(1, paint.soft);
        ctx.fillStyle = g; ctx.fillRect(x - 12, top, width + 24, h);
        break;
      }
      case "half":
        ctx.fillRect(x - 10, top + h * 0.45, width + 20, h * 0.55);
        break;
      case "tape":
        ctx.fillRect(x - 22, top + 2, width + 44, h - 4);
        break;
      default:
        ctx.fillRect(x - 12, top, width + 24, h);
    }
  } else if (kit.kind === "underline") {
    const y = baseline + size * 0.2;
    const lw = kit.variant === "thick" ? size * 0.16 : kit.variant === "thin" ? Math.max(3, size * 0.05) : Math.max(5, size * 0.09);
    ctx.lineWidth = lw;
    switch (kit.variant) {
      case "brush":
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + width / 2, y + size * 0.12, x + width, y - size * 0.03); ctx.stroke();
        break;
      case "double":
        [0, size * 0.13].forEach((d) => { ctx.beginPath(); ctx.moveTo(x, y + d); ctx.lineTo(x + width, y + d); ctx.stroke(); });
        break;
      case "dotted":
        ctx.setLineDash([lw * 1.6, lw * 1.4]);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y); ctx.stroke(); ctx.setLineDash([]);
        break;
      case "wave": {
        ctx.beginPath(); ctx.moveTo(x, y);
        const seg = width / 6;
        for (let i = 0; i < 6; i++) {
          ctx.quadraticCurveTo(x + seg * i + seg / 2, y + (i % 2 ? size * 0.1 : -size * 0.1), x + seg * (i + 1), y);
        }
        ctx.stroke(); break;
      }
      case "offset":
        ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(x + 8, y + size * 0.06); ctx.lineTo(x + width + 8, y + size * 0.06); ctx.stroke();
        break;
      case "short":
        ctx.beginPath(); ctx.moveTo(x + width * 0.25, y); ctx.lineTo(x + width * 0.75, y); ctx.stroke();
        break;
      case "gradient": {
        const g = ctx.createLinearGradient(x, 0, x + width, 0);
        g.addColorStop(0, paint.accent); g.addColorStop(1, paint.soft);
        ctx.strokeStyle = g; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y); ctx.stroke();
        break;
      }
      case "soft":
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y); ctx.stroke();
        break;
      default:
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y); ctx.stroke();
    }
  } else if (kit.kind === "frame") {
    const fx = x - 18, fy = top - size * 0.1, fw = width + 36, fh = h + size * 0.2;
    ctx.lineWidth = kit.variant === "thick" ? 7 : 3;
    switch (kit.variant) {
      case "round": roundRect(ctx, fx, fy, fw, fh, size * 0.3); ctx.stroke(); break;
      case "pill": roundRect(ctx, fx, fy, fw, fh, fh / 2); ctx.stroke(); break;
      case "dotted": ctx.setLineDash([8, 7]); ctx.strokeRect(fx, fy, fw, fh); ctx.setLineDash([]); break;
      case "double": ctx.strokeRect(fx, fy, fw, fh); ctx.strokeRect(fx + 7, fy + 7, fw - 14, fh - 14); break;
      case "corners": {
        const arm = Math.min(26, fw * 0.16);
        ([[fx, fy, 1, 1], [fx + fw, fy, -1, 1], [fx, fy + fh, 1, -1], [fx + fw, fy + fh, -1, -1]] as const).forEach(([px, py, dx, dy]) => {
          ctx.beginPath(); ctx.moveTo(px + arm * dx, py); ctx.lineTo(px, py); ctx.lineTo(px, py + arm * dy); ctx.stroke();
        });
        break;
      }
      case "skew":
        ctx.beginPath();
        ctx.moveTo(fx + 10, fy); ctx.lineTo(fx + fw, fy); ctx.lineTo(fx + fw - 10, fy + fh); ctx.lineTo(fx, fy + fh);
        ctx.closePath(); ctx.stroke();
        break;
      default: ctx.strokeRect(fx, fy, fw, fh);
    }
  } else {
    // боковые акценты
    ctx.lineWidth = Math.max(4, size * 0.08);
    const midY = top + h / 2;
    const mark = (px: number) => {
      switch (kit.variant) {
        case "dot-left":
          ctx.beginPath(); ctx.arc(px, midY, size * 0.12, 0, Math.PI * 2); ctx.fill(); break;
        case "slash":
          ctx.beginPath(); ctx.moveTo(px - size * 0.12, top + h); ctx.lineTo(px + size * 0.12, top); ctx.stroke(); break;
        case "arrow":
          ctx.beginPath(); ctx.moveTo(px - size * 0.14, midY - size * 0.16);
          ctx.lineTo(px + size * 0.06, midY); ctx.lineTo(px - size * 0.14, midY + size * 0.16); ctx.stroke(); break;
        case "plus":
          ctx.beginPath(); ctx.moveTo(px - size * 0.14, midY); ctx.lineTo(px + size * 0.14, midY);
          ctx.moveTo(px, midY - size * 0.14); ctx.lineTo(px, midY + size * 0.14); ctx.stroke(); break;
        case "star": {
          ctx.beginPath();
          for (let i = 0; i < 10; i++) {
            const a = (Math.PI * i) / 5 - Math.PI / 2;
            const rr = i % 2 ? size * 0.07 : size * 0.16;
            const qx = px + Math.cos(a) * rr, qy = midY + Math.sin(a) * rr;
            if (i) ctx.lineTo(qx, qy); else ctx.moveTo(qx, qy);
          }
          ctx.closePath(); ctx.fill(); break;
        }
        case "line-through-side":
          ctx.beginPath(); ctx.moveTo(px - size * 0.3, midY); ctx.lineTo(px + size * 0.06, midY); ctx.stroke(); break;
        default:
          ctx.fillRect(px - size * 0.06, top, size * 0.12, h);
      }
    };
    mark(x - size * 0.34);
    if (kit.variant === "bar-both" || kit.variant === "line-through-side") {
      ctx.save(); ctx.translate(x + width + size * 0.68, 0); ctx.scale(1, 1);
      mark(0 - size * 0.34 + size * 0.34);
      ctx.restore();
    }
  }
  ctx.restore();
  // Плотные заливки требуют контрастного текста — сообщаем движку цвет фона.
  if (kit.kind === "fill" && kit.alpha >= 0.55) {
    return { over: kit.variant === "chip" ? paint.soft : paint.accent };
  }
  return {};
}


/* ============================================================
 * 4. Кнопки CTA (~50)
 * ========================================================== */

type CtaShape = "pill" | "block" | "notch" | "skew" | "arrow" | "bar" | "tab" | "hex" | "text";
type CtaFill = "solid" | "outline" | "soft" | "dotted" | "offset" | "double" | "glass" | "corners";

const CTA_SHAPE_NAMES: Record<CtaShape, string> = {
  pill: "Пилюля", block: "Блок", notch: "Тег с вырезом", skew: "Скошенная", arrow: "Со стрелкой",
  bar: "Полоса", tab: "Вкладка", hex: "Шестиугольник", text: "Текст",
};
const CTA_FILL_NAMES: Record<CtaFill, string> = {
  solid: "заливка", outline: "контур", soft: "мягкая", dotted: "пунктир",
  offset: "со смещением", double: "двойная", glass: "стекло", corners: "уголки",
};
const CTA_COMBOS: Record<CtaShape, CtaFill[]> = {
  pill: ["solid", "outline", "soft", "dotted", "offset", "double", "glass"],
  block: ["solid", "outline", "soft", "dotted", "offset", "double", "corners"],
  notch: ["solid", "outline", "offset"],
  skew: ["solid", "outline", "offset"],
  arrow: ["solid", "outline", "soft"],
  bar: ["solid", "soft", "outline"],
  tab: ["solid", "outline", "soft"],
  hex: ["solid", "outline"],
  text: ["solid", "outline", "double", "dotted"],
};

export interface CtaKit { id: string; name: string; shape: CtaShape; fill: CtaFill }

export const CTA_KITS: CtaKit[] = (() => {
  const out: CtaKit[] = [];
  (Object.keys(CTA_COMBOS) as CtaShape[]).forEach((shape) => {
    CTA_COMBOS[shape].forEach((fill) => {
      out.push({
        id: `cta-${shape}-${fill}`,
        name: fill === "solid" ? CTA_SHAPE_NAMES[shape] : `${CTA_SHAPE_NAMES[shape]} · ${CTA_FILL_NAMES[fill]}`,
        shape, fill,
      });
    });
  });
  return out;
})();

export const CTA_KIT_MAP = new Map(CTA_KITS.map((c) => [c.id, c]));

export interface CtaPaint { accent: string; onAccent: string; ink: string; soft: string }

function ctaPath(ctx: Ctx2D, shape: CtaShape, b: KitBox, pinW: number) {
  const r = b.h / 2;
  switch (shape) {
    case "pill": roundRect(ctx, b.x, b.y, b.w, b.h, r); break;
    case "block": roundRect(ctx, b.x, b.y, b.w, b.h, 8); break;
    case "notch": {
      const n = Math.min(20, b.h * 0.34);
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.w - n, b.y); ctx.lineTo(b.x + b.w, b.y + n);
      ctx.lineTo(b.x + b.w, b.y + b.h); ctx.lineTo(b.x + n, b.y + b.h); ctx.lineTo(b.x, b.y + b.h - n); ctx.closePath();
      break;
    }
    case "skew": {
      const o = b.h * 0.24;
      ctx.beginPath(); ctx.moveTo(b.x + o, b.y); ctx.lineTo(b.x + b.w + o, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h); ctx.lineTo(b.x, b.y + b.h); ctx.closePath();
      break;
    }
    case "arrow": {
      const t = b.h * 0.4;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.w - t, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h / 2); ctx.lineTo(b.x + b.w - t, b.y + b.h);
      ctx.lineTo(b.x, b.y + b.h); ctx.closePath();
      break;
    }
    case "bar": ctx.beginPath(); ctx.rect(0, b.y, pinW, b.h); break;
    case "tab": {
      const rr = Math.min(18, b.h * 0.4);
      ctx.beginPath(); ctx.moveTo(b.x, b.y + b.h); ctx.lineTo(b.x, b.y + rr);
      ctx.quadraticCurveTo(b.x, b.y, b.x + rr, b.y); ctx.lineTo(b.x + b.w - rr, b.y);
      ctx.quadraticCurveTo(b.x + b.w, b.y, b.x + b.w, b.y + rr); ctx.lineTo(b.x + b.w, b.y + b.h); ctx.closePath();
      break;
    }
    case "hex": {
      const cut = b.h * 0.42;
      ctx.beginPath(); ctx.moveTo(b.x + cut, b.y); ctx.lineTo(b.x + b.w - cut, b.y);
      ctx.lineTo(b.x + b.w, b.y + b.h / 2); ctx.lineTo(b.x + b.w - cut, b.y + b.h);
      ctx.lineTo(b.x + cut, b.y + b.h); ctx.lineTo(b.x, b.y + b.h / 2); ctx.closePath();
      break;
    }
    default: ctx.beginPath();
  }
}

/** Рисует форму кнопки. Возвращает цвет подписи. */
export function drawKitCta(
  ctx: Ctx2D, id: string,
  box: KitBox, paint: CtaPaint, opts: { shadow: KitSpec["shadow"]; skew: number; pinW: number },
): string {
  const kit = CTA_KIT_MAP.get(id);
  if (!kit) {
    ctx.save(); ctx.fillStyle = paint.accent; roundRect(ctx, box.x, box.y, box.w, box.h, box.h / 2); ctx.fill(); ctx.restore();
    return paint.onAccent;
  }
  let label = paint.onAccent;
  ctx.save();
  const body = () => {
    if (kit.shape === "text") {
      label = paint.ink;
      if (kit.fill === "double" || kit.fill === "dotted") {
        ctx.strokeStyle = paint.ink; ctx.lineWidth = 2;
        if (kit.fill === "dotted") ctx.setLineDash([8, 7]);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        if (kit.fill === "double") ctx.strokeRect(box.x + 6, box.y + 6, box.w - 12, box.h - 12);
        ctx.setLineDash([]);
      }
      return;
    }
    if (kit.fill === "offset") {
      ctx.save(); ctx.fillStyle = paint.ink; ctx.globalAlpha = 0.9;
      ctxTranslatePath(ctx, kit.shape, box, opts.pinW, 8, 8); ctx.fill(); ctx.restore();
    }
    switch (kit.fill) {
      case "outline":
      case "dotted":
        ctx.strokeStyle = paint.ink; ctx.lineWidth = 3;
        if (kit.fill === "dotted") ctx.setLineDash([9, 7]);
        ctaPath(ctx, kit.shape, box, opts.pinW); ctx.stroke(); ctx.setLineDash([]);
        label = paint.ink;
        break;
      case "soft":
        ctx.globalAlpha = 0.9; ctx.fillStyle = paint.soft;
        ctaPath(ctx, kit.shape, box, opts.pinW); ctx.fill(); ctx.globalAlpha = 1;
        label = paint.ink;
        break;
      case "glass":
        ctx.globalAlpha = 0.32; ctx.fillStyle = paint.ink;
        ctaPath(ctx, kit.shape, box, opts.pinW); ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
        ctaPath(ctx, kit.shape, box, opts.pinW); ctx.stroke();
        label = "#FFFFFF";
        break;
      case "double":
        ctx.fillStyle = paint.accent; ctaPath(ctx, kit.shape, box, opts.pinW); ctx.fill();
        clearShadow(ctx);
        ctx.strokeStyle = paint.accent; ctx.lineWidth = 2;
        ctaPath(ctx, kit.shape, { x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 }, opts.pinW); ctx.stroke();
        break;
      case "corners": {
        ctx.strokeStyle = paint.ink; ctx.lineWidth = 4; ctx.lineCap = "round";
        const arm = Math.min(24, box.w * 0.16);
        ([[box.x, box.y, 1, 1], [box.x + box.w, box.y, -1, 1], [box.x, box.y + box.h, 1, -1], [box.x + box.w, box.y + box.h, -1, -1]] as const)
          .forEach(([px, py, dx, dy]) => { ctx.beginPath(); ctx.moveTo(px + arm * dx, py); ctx.lineTo(px, py); ctx.lineTo(px, py + arm * dy); ctx.stroke(); });
        label = paint.ink;
        break;
      }
      default:
        ctx.fillStyle = paint.accent; ctaPath(ctx, kit.shape, box, opts.pinW); ctx.fill();
    }
  };
  applyShadow(ctx, kit.fill === "offset" ? "none" : opts.shadow, paint.ink);
  withSkew(ctx, box, kit.shape === "skew" ? 0 : opts.skew * 0.4, body);
  clearShadow(ctx);
  ctx.restore();
  return label;
}

function ctxTranslatePath(ctx: Ctx2D, shape: CtaShape, b: KitBox, pinW: number, dx: number, dy: number) {
  ctaPath(ctx, shape, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, pinW);
}

/** Кнопки, у которых подпись подчёркивается линией. */
export const CTA_UNDERLINED = new Set(CTA_KITS.filter((c) => c.shape === "text" && c.fill === "solid").map((c) => c.id));

/** Метрика кнопки для расчёта высоты блока. */
export function ctaMetricFor(id: string): "pill" | "block" | "outline" | "line" | "bar" | "frame" {
  const kit = CTA_KIT_MAP.get(id);
  if (!kit) return "pill";
  if (kit.shape === "text") return kit.fill === "solid" ? "line" : "frame";
  if (kit.shape === "bar") return "bar";
  if (kit.fill === "outline" || kit.fill === "dotted" || kit.fill === "corners") return "outline";
  if (kit.shape === "pill") return "pill";
  return "block";
}

/* ============================================================
 * 5. Доп. текст (~50)
 * Скобки и любые кавычки убраны из трансформаций.
 * ========================================================== */

interface SubtextKit { id: string; name: string; sep?: string; prefix?: string; suffix?: string; upper?: boolean; role?: "kicker" | "subtitle" }

const SEPARATORS: Array<[string, string, string]> = [
  ["dots", "Точки-разделители", " · "],
  ["slashes", "Слэши", " / "],
  ["dashes", "Тире", " — "],
  ["pipes", "Вертикальные линии", " | "],
  ["bullets", "Буллеты", " • "],
  ["arrows", "Стрелки", " → "],
  ["plus", "Плюсы", " + "],
  ["stars", "Звёздочки", " ✦ "],
  ["diamonds", "Ромбы", " ◆ "],
  ["waves", "Волны", " ~ "],
];
const PREFIXES: Array<[string, string, string]> = [
  ["issue", "Номер выпуска", "NO. "],
  ["new", "Бейдж NEW", "NEW · "],
  ["top", "Бейдж TOP", "TOP · "],
  ["guide", "Гид", "GUIDE · "],
  ["edit", "Подборка", "EDIT · "],
  ["trend", "Тренд", "TREND · "],
  ["hot", "Хит", "HOT · "],
  ["save", "Сохрани", "SAVE · "],
  ["idea", "Идея", "IDEA · "],
  ["look", "Лук", "LOOK · "],
];
const SUFFIXES: Array<[string, string, string]> = [
  ["readmore", "Read more", " — read more"],
  ["seeall", "См. все", " — див. усі"],
  ["inside", "Inside", " · inside"],
  ["guideend", "Гид", " · гід"],
  ["swipe", "Свайп", " · swipe"],
  ["arrow", "Стрелка", " →"],
  ["dot", "Точка", " ·"],
  ["star", "Звезда", " ✦"],
];
const PLAIN: Array<[string, string, boolean]> = [
  ["plain", "Обычный", false],
  ["caps", "Капсом", true],
  ["script", "Скриптовый подзаголовок", false],
  ["domain", "Доменная лента", true],
  ["rule", "Линия с текстом", true],
  ["category", "Метка-категория", true],
  ["wide", "Разрядка", true],
  ["lower", "Строчными", false],
  ["mini", "Мелкий", true],
  ["accent", "Акцентный", true],
  ["editorial", "Редакционный", false],
  ["label", "Лейбл", true],
];

export const SUBTEXT_KITS: SubtextKit[] = [
  ...SEPARATORS.map(([id, name, sep]) => ({ id: `sub-sep-${id}`, name, sep, upper: true })),
  ...PREFIXES.map(([id, name, prefix]) => ({ id: `sub-pre-${id}`, name, prefix, upper: true })),
  ...SUFFIXES.map(([id, name, suffix]) => ({ id: `sub-suf-${id}`, name, suffix, role: "subtitle" as const })),
  ...PLAIN.map(([id, name, upper]) => ({ id: `sub-${id}`, name, upper })),
  { id: "sub-none", name: "Без доп. текста" },
];

const SUBTEXT_MAP = new Map(SUBTEXT_KITS.map((s) => [s.id, s]));

/** Преобразует строку кикера/подзаголовка под выбранный тип доп. текста. */
export function subtextTransform(id: string, value: string, role: "kicker" | "subtitle"): string {
  const kit = SUBTEXT_MAP.get(id);
  const v = value.replace(/["'«»“”„]/g, "").replace(/\s+/g, " ").trim();
  if (!v) return v;
  if (!kit || kit.id === "sub-none") return kit ? "" : v;
  if (kit.role && kit.role !== role) return kit.upper ? v.toLocaleUpperCase() : v;
  let out = v;
  if (kit.sep && role === "kicker") out = out.split(/\s+/).join(kit.sep);
  if (kit.prefix && role === "kicker") out = kit.prefix + out;
  if (kit.suffix && role === "subtitle") out = out + kit.suffix;
  if (kit.id === "sub-wide" && role === "kicker") out = out.split("").join(" ");
  if (kit.id === "sub-lower") out = out.toLocaleLowerCase();
  else if (kit.upper) out = out.toLocaleUpperCase();
  return out;
}

export const SUBTEXT_SCRIPT = new Set(["sub-script"]);
export const SUBTEXT_DOMAIN_BAR = new Set(["sub-domain"]);

/* ============================================================
 * 6. Раскладки пина и сетки фото
 * ========================================================== */

export interface LayoutKit {
  id: string; name: string; family: CanvasFamily;
  zone: "top" | "bottom" | "overlay" | "middle" | "side";
  overlay: boolean;
  counts: number[];
}

export const LAYOUT_KITS: LayoutKit[] = [
  { id: "lay-bottom-editorial", name: "Текст снизу", family: "editorial-focus", zone: "bottom", overlay: false, counts: [1, 2, 3, 4, 6, 9] },
  { id: "lay-top-editorial", name: "Текст сверху", family: "framed-editorial", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9, 12] },
  { id: "lay-swiss-giant", name: "Крупный заголовок сверху", family: "swiss-giant", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
  { id: "lay-arch", name: "Арочная редакционная", family: "arch-editorial", zone: "top", overlay: false, counts: [1, 2, 3, 4, 6] },
  { id: "lay-grid-caption", name: "Сетка с подписями", family: "grid-caption", zone: "top", overlay: false, counts: [4, 6, 8, 9, 12] },
  { id: "lay-hero-story", name: "Герой + миниатюры", family: "photo-story", zone: "bottom", overlay: false, counts: [3, 4] },
  { id: "lay-dense", name: "Плотный коллаж", family: "dense-inspiration", zone: "bottom", overlay: false, counts: [6, 8, 9, 12, 14] },
  { id: "lay-balanced", name: "Сбалансированный коллаж", family: "balanced-collage", zone: "bottom", overlay: false, counts: [4, 6, 8, 9] },
  { id: "lay-side", name: "Текст сбоку", family: "clean-product", zone: "side", overlay: false, counts: [1] },
  { id: "lay-soft", name: "Мягкий лайфстайл", family: "soft-lifestyle", zone: "top", overlay: false, counts: [2, 3, 4, 6] },
  { id: "lay-tile", name: "Текстовая плитка", family: "text-tile", zone: "bottom", overlay: false, counts: [2, 3, 4, 6, 9] },
  { id: "lay-split", name: "Split-контраст", family: "split-contrast", zone: "bottom", overlay: false, counts: [2, 3, 4, 6, 9] },
  { id: "lay-overlay-center", name: "Текст поверх кадра", family: "modern-poster", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6, 9] },
  { id: "lay-overlay-band", name: "Лента поперёк кадра", family: "band-poster", zone: "overlay", overlay: true, counts: [1, 2, 3] },
  { id: "lay-overlay-plate", name: "Подложка на кадре", family: "full-bleed-plate", zone: "overlay", overlay: true, counts: [4, 6, 9] },
  { id: "lay-overlay-badge", name: "Бейдж на коллаже", family: "full-bleed-badge", zone: "overlay", overlay: true, counts: [6, 9, 12, 14] },
  { id: "lay-brush", name: "Мазок с заголовком", family: "brush-headline", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6, 9] },
  { id: "lay-neon", name: "Ночной неон", family: "neon-night", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6] },
  { id: "lay-sticker", name: "Стикер-карточка", family: "sticker-card", zone: "overlay", overlay: true, counts: [4, 6, 9] },
  { id: "lay-tape", name: "Zine со скотчем", family: "tape-zine", zone: "overlay", overlay: true, counts: [2, 3, 4, 6] },

  /* ---------- v7.4: новые раскладки ---------- */
  { id: "lay-hero-number", name: "Крупная цифра", family: "hero-number", zone: "bottom", overlay: false, counts: [1, 2, 3, 4, 6] },
  { id: "lay-hero-number-top", name: "Крупная цифра сверху", family: "hero-number", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
  { id: "lay-neo-deco", name: "Нео-деко", family: "neo-deco", zone: "top", overlay: false, counts: [1, 2, 3, 4, 6] },
  { id: "lay-neo-deco-bottom", name: "Нео-деко снизу", family: "neo-deco", zone: "bottom", overlay: false, counts: [2, 3, 4, 6] },
  { id: "lay-contrast", name: "Контрастный оверлей", family: "contrast-overlay", zone: "overlay", overlay: true, counts: [1, 2, 3, 4, 6, 9] },
  { id: "lay-blob", name: "Блоб-стикер", family: "blob-sticker", zone: "overlay", overlay: true, counts: [4, 6, 9] },
  { id: "lay-torn", name: "Рваная бумага", family: "torn-paper", zone: "overlay", overlay: true, counts: [2, 3, 4, 6, 9] },
  { id: "lay-torn-bottom", name: "Рваная бумага снизу", family: "torn-paper", zone: "bottom", overlay: false, counts: [3, 4, 6, 9] },
  { id: "lay-ticket", name: "Билет-поп", family: "ticket-pop", zone: "overlay", overlay: true, counts: [2, 3, 4, 6] },
  { id: "lay-doodle", name: "Дудл-поп", family: "doodle-pop", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
  { id: "lay-domain-bar", name: "Лента домена", family: "domain-bar", zone: "bottom", overlay: false, counts: [2, 3, 4, 6, 9, 12] },
  { id: "lay-chrome", name: "Хром-глянец", family: "chrome-gloss", zone: "overlay", overlay: true, counts: [1, 2, 3, 4] },
  { id: "lay-mid-editorial", name: "Текст по центру", family: "editorial-focus", zone: "middle", overlay: false, counts: [2, 4, 6] },
  { id: "lay-mid-swiss", name: "Полоса по центру", family: "swiss-giant", zone: "middle", overlay: false, counts: [2, 4, 6, 8] },
  { id: "lay-side-story", name: "Текст сбоку · история", family: "photo-story", zone: "side", overlay: false, counts: [1, 2] },
  { id: "lay-side-clean", name: "Паспарту сбоку", family: "clean-product", zone: "side", overlay: false, counts: [1, 2, 3] },
  { id: "lay-dense-overlay", name: "Плотный коллаж + бейдж", family: "dense-inspiration", zone: "overlay", overlay: true, counts: [8, 9, 12, 14] },
  { id: "lay-grid-overlay", name: "Сетка + подложка", family: "grid-caption", zone: "overlay", overlay: true, counts: [6, 8, 9, 12] },
  { id: "lay-split-top", name: "Split сверху", family: "split-contrast", zone: "top", overlay: false, counts: [2, 3, 4, 6] },
  { id: "lay-band-bottom", name: "Лента снизу", family: "band-poster", zone: "bottom", overlay: false, counts: [1, 2, 3, 4] },
  { id: "lay-arch-bottom", name: "Арки снизу", family: "arch-editorial", zone: "bottom", overlay: false, counts: [2, 3, 4, 6] },
  { id: "lay-sticker-bottom", name: "Стикер снизу", family: "sticker-card", zone: "bottom", overlay: false, counts: [3, 4, 6, 9] },
  { id: "lay-brush-bottom", name: "Мазок снизу", family: "brush-headline", zone: "bottom", overlay: false, counts: [2, 3, 4, 6] },
  { id: "lay-tile-top", name: "Плитка сверху", family: "text-tile", zone: "top", overlay: false, counts: [2, 3, 4, 6, 9] },
];

/** Сетки фото: подсказка решателю о плотности и отступах (~60 вариантов). */
export const GRID_KITS = (() => {
  const gutters: Array<[string, string, number]> = [
    ["flush", "Без зазоров", 0], ["hair", "Волосяной", 4], ["tight", "Плотная", 8],
    ["snug", "Собранная", 12], ["soft", "Мягкая", 16], ["card", "Карточки", 22],
    ["airy", "Воздушная", 28], ["loose", "Разреженная", 34],
  ];
  const radii: Array<[string, string, number]> = [
    ["sharp", "острые", 0], ["micro", "микро-скругление", 6], ["small", "лёгкое скругление", 12],
    ["mid", "скруглённая", 26], ["large", "круглые углы", 42], ["arch", "арочные", 64],
  ];
  const out: Array<{ id: string; name: string; gutter: number; radius: number }> = [];
  gutters.forEach(([gi, gn, gutter]) => radii.forEach(([ri, rn, radius]) => {
    if (gutter === 0 && radius > 26) return; // без зазоров крупный радиус режет кадры
    out.push({ id: `grid-${gi}-${ri}`, name: `${gn} · ${rn}`, gutter, radius });
  }));
  return out;
})();

/* ==========================================================
 * 7. Рамки и обводки кадров фото (v7.4)
 * ========================================================== */

export type FrameKind = "none" | "hairline" | "thick" | "double" | "inset" | "shadowbox" | "corner" | "mat";
export interface FrameKit { id: string; name: string; kind: FrameKind; width: number; color: "accent" | "accent2" | "bg" | "fg" }

export const FRAME_KITS: FrameKit[] = (() => {
  const kinds: Array<[FrameKind, string, number[]]> = [
    ["none", "Без рамки", [0]],
    ["hairline", "Тонкая обводка", [2, 3]],
    ["thick", "Толстая рамка", [6, 10]],
    ["double", "Двойная обводка", [3, 5]],
    ["inset", "Внутренняя линия", [2, 4]],
    ["shadowbox", "Смещённая рамка", [4, 7]],
    ["corner", "Уголки", [3, 5]],
    ["mat", "Паспарту", [8, 14]],
  ];
  const colors: Array<FrameKit["color"]> = ["accent", "accent2", "bg", "fg"];
  const out: FrameKit[] = [];
  kinds.forEach(([kind, name, widths]) => widths.forEach((w) => colors.forEach((c) => {
    if (kind === "none" && (w !== 0 || c !== "accent")) return;
    out.push({ id: `frm-${kind}-${w}-${c}`, name: kind === "none" ? name : `${name} ${w}px · ${c}`, kind, width: w, color: c });
  })));
  return out;
})();

export const FRAME_KIT_MAP = new Map(FRAME_KITS.map((f) => [f.id, f]));

export interface FramePaint { accent: string; accent2: string; bg: string; fg: string }

/** Скруглённый прямоугольник как подпуть — без сброса текущего пути. */
function matSubPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Рисует рамку кадра поверх уже отрисованного фото. */
export function drawKitFrame(
  ctx: Ctx2D, id: string | undefined, box: KitBox, radius: number, paint: FramePaint,
) {
  const kit = id ? FRAME_KIT_MAP.get(id) : undefined;
  if (!kit || kit.kind === "none" || kit.width <= 0) return;
  const color = kit.color === "accent" ? paint.accent : kit.color === "accent2" ? paint.accent2 : kit.color === "bg" ? paint.bg : paint.fg;
  const w = kit.width;
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w;
  const inset = w / 2;
  const r = Math.max(0, radius - inset);
  if (kit.kind === "hairline" || kit.kind === "thick") {
    roundRect(ctx, box.x + inset, box.y + inset, box.w - w, box.h - w, r); ctx.stroke();
  } else if (kit.kind === "double") {
    roundRect(ctx, box.x + inset, box.y + inset, box.w - w, box.h - w, r); ctx.stroke();
    const o = w * 2.2;
    roundRect(ctx, box.x + o, box.y + o, box.w - o * 2, box.h - o * 2, Math.max(0, r - o)); ctx.stroke();
  } else if (kit.kind === "inset") {
    const o = w * 3;
    roundRect(ctx, box.x + o, box.y + o, box.w - o * 2, box.h - o * 2, Math.max(0, r - o)); ctx.stroke();
  } else if (kit.kind === "shadowbox") {
    ctx.globalAlpha = 0.9;
    roundRect(ctx, box.x + w * 1.6, box.y + w * 1.6, box.w - w, box.h - w, r); ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (kit.kind === "corner") {
    const len = Math.min(box.w, box.h) * 0.22;
    ctx.lineCap = "square";
    const corners: Array<[number, number, number, number]> = [
      [box.x + inset, box.y + inset, 1, 1], [box.x + box.w - inset, box.y + inset, -1, 1],
      [box.x + inset, box.y + box.h - inset, 1, -1], [box.x + box.w - inset, box.y + box.h - inset, -1, -1],
    ];
    corners.forEach(([cx0, cy0, sx, sy]) => {
      ctx.beginPath();
      ctx.moveTo(cx0 + sx * len, cy0); ctx.lineTo(cx0, cy0); ctx.lineTo(cx0, cy0 + sy * len); ctx.stroke();
    });
  } else if (kit.kind === "mat") {
    // Паспарту: заливка только по периметру кадра.
    // Важно: `roundRect` из canvasDecor начинает новый путь, поэтому кольцо
    // собираем локально — иначе внешний контур терялся и заливка закрывала фото.
    ctx.beginPath();
    matSubPath(ctx, box.x, box.y, box.w, box.h, radius);
    matSubPath(ctx, box.x + w, box.y + w, Math.max(0, box.w - w * 2), Math.max(0, box.h - w * 2), Math.max(0, radius - w));
    ctx.fill("evenodd");
  }
  ctx.restore();
}

/* ==========================================================
 * 8. Размещение цифры «идей» (v7.4)
 * ========================================================== */

export type NumberPlacementId =
  | "np-inline" | "np-above" | "np-corner-tl" | "np-corner-tr" | "np-corner-bl" | "np-corner-br"
  | "np-ghost" | "np-side" | "np-baseline";

export interface NumberPlacement { id: NumberPlacementId; name: string; scale: number }

export const NUMBER_PLACEMENTS: NumberPlacement[] = [
  { id: "np-inline", name: "В строке заголовка", scale: 1 },
  { id: "np-above", name: "Над заголовком", scale: 1.15 },
  { id: "np-corner-tl", name: "Угол сверху слева", scale: 0.9 },
  { id: "np-corner-tr", name: "Угол сверху справа", scale: 0.9 },
  { id: "np-corner-bl", name: "Угол снизу слева", scale: 0.9 },
  { id: "np-corner-br", name: "Угол снизу справа", scale: 0.9 },
  { id: "np-ghost", name: "Гигантская цифра-фон", scale: 3.1 },
  { id: "np-side", name: "Сбоку от заголовка", scale: 1.25 },
  { id: "np-baseline", name: "Под заголовком", scale: 1.05 },
];

export const NUMBER_PLACEMENT_MAP = new Map<string, NumberPlacement>(NUMBER_PLACEMENTS.map((p) => [p.id, p]));

export const SHADOW_KITS: KitSpec["shadow"][] = ["none", "none", "soft", "hard"];
export const SKEW_KITS = [0, 0, -2.5, -1.5, 1.5, 2.5, 4];

export const KIT_COUNTS = {
  plates: PLATE_KITS.length,
  numbers: NUMBER_KITS.length,
  highlights: HIGHLIGHT_KITS.length,
  ctas: CTA_KITS.length,
  subtexts: SUBTEXT_KITS.length,
  grids: GRID_KITS.length,
  layouts: LAYOUT_KITS.length,
  frames: FRAME_KITS.length,
  placements: NUMBER_PLACEMENTS.length,
};


/** Формы подложек, которые органично смотрятся с наклоном. */
export const PLATE_KIT_SKEWED = new Set(
  PLATE_KITS.filter((p) => ["slab", "tape", "brush", "torn", "diagonal"].includes(p.shape)).map((p) => p.id),
);

/* ==========================================================
 * 9. Подача домена (v7.5)
 *
 * Раньше домен рисовался единственным способом — мелкой серой строкой
 * внизу. Теперь это отдельная ось рецепта: разрядка, линии-разделители,
 * пилюля, лента, уголок. Цвет считает движок, здесь только форма.
 * ========================================================== */

export type DomainKind =
  | "plain" | "spaced" | "rule" | "pill" | "bar" | "outline" | "dots" | "corner" | "tick";

export interface DomainKit {
  id: string; name: string; kind: DomainKind;
  /** Кегль подписи. */
  size: number;
  /** Насколько выразительна подача: «тихая» подходит для любых макетов. */
  loud: boolean;
}

export const DOMAIN_KITS: DomainKit[] = [
  { id: "dom-plain", name: "Простая подпись", kind: "plain", size: 26, loud: false },
  { id: "dom-spaced", name: "Разрядка капсом", kind: "spaced", size: 24, loud: false },
  { id: "dom-spaced-lg", name: "Крупная разрядка", kind: "spaced", size: 30, loud: true },
  { id: "dom-rule", name: "Линии по бокам", kind: "rule", size: 25, loud: false },
  { id: "dom-pill", name: "Пилюля акцентом", kind: "pill", size: 25, loud: true },
  { id: "dom-bar", name: "Лента во всю ширину", kind: "bar", size: 27, loud: true },
  { id: "dom-outline", name: "Контурная рамка", kind: "outline", size: 24, loud: true },
  { id: "dom-dots", name: "С точками по краям", kind: "dots", size: 25, loud: false },
  { id: "dom-corner", name: "В углу мелко", kind: "corner", size: 21, loud: false },
  { id: "dom-tick", name: "С засечкой сверху", kind: "tick", size: 26, loud: false },
];

export const DOMAIN_KIT_MAP = new Map(DOMAIN_KITS.map((d) => [d.id, d]));

export interface DomainPaint {
  /** Цвет текста, уже проверенный на контраст движком. */
  ink: string;
  /** Заливка пилюли/ленты. */
  fill: string;
  /** Цвет текста на заливке. */
  onFill: string;
  /** Нужна ли защитная подложка (текст лежит на фото). */
  onPhoto: boolean;
}

/** Рисует домен внизу пина выбранной подачей. Возвращает занятую высоту. */
export function drawKitDomain(
  ctx: Ctx2D, id: string | undefined, raw: string,
  font: string, paint: DomainPaint, canvas: { w: number; h: number },
): number {
  const text = raw.replace(/^https?:\/\//, "").replace(/\/$/, "").trim().toLocaleUpperCase();
  if (!text) return 0;
  const kit = (id && DOMAIN_KIT_MAP.get(id)) || DOMAIN_KITS[0];
  const size = kit.size;
  const spacing = kit.kind === "spaced" ? size * 0.34 : kit.kind === "corner" ? size * 0.18 : size * 0.1;
  ctx.save();
  ctx.font = `800 ${size}px "${font}"`;
  try { (ctx as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`; } catch { /* noop */ }
  ctx.font = `800 ${size}px "${font}"`;
  const w = ctx.measureText(text).width;
  const cx = canvas.w / 2;
  const baseY = canvas.h - (kit.kind === "bar" ? 22 : 30);

  const label = (x: number, y: number, color: string) => { ctx.fillStyle = color; ctx.fillText(text, x, y); };
  // Защита от фона: под текстом лёгкая тень-ореол, а не серая плашка.
  const halo = (fn: () => void) => {
    if (paint.onPhoto) { ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 12; }
    fn();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
  };

  if (kit.kind === "bar") {
    const h = size * 2.1;
    ctx.fillStyle = paint.fill;
    ctx.fillRect(0, canvas.h - h, canvas.w, h);
    label(cx - w / 2, canvas.h - h / 2 + size * 0.36, paint.onFill);
  } else if (kit.kind === "pill") {
    const padX = size * 0.9, h = size * 1.9;
    const x = cx - (w + padX * 2) / 2, y = baseY - h + size * 0.3;
    ctx.fillStyle = paint.fill;
    roundRect(ctx, x, y, w + padX * 2, h, h / 2); ctx.fill();
    label(x + padX, y + h / 2 + size * 0.36, paint.onFill);
  } else if (kit.kind === "outline") {
    const padX = size * 0.8, h = size * 1.8;
    const x = cx - (w + padX * 2) / 2, y = baseY - h + size * 0.3;
    ctx.strokeStyle = paint.ink; ctx.lineWidth = 2;
    roundRect(ctx, x, y, w + padX * 2, h, 4); ctx.stroke();
    halo(() => label(x + padX, y + h / 2 + size * 0.36, paint.ink));
  } else if (kit.kind === "rule") {
    const gap = 22, len = Math.min(150, (canvas.w * 0.72 - w) / 2 - gap);
    ctx.strokeStyle = paint.ink; ctx.lineWidth = 2; ctx.globalAlpha = 0.75;
    if (len > 24) {
      ctx.beginPath();
      ctx.moveTo(cx - w / 2 - gap - len, baseY - size * 0.3); ctx.lineTo(cx - w / 2 - gap, baseY - size * 0.3);
      ctx.moveTo(cx + w / 2 + gap, baseY - size * 0.3); ctx.lineTo(cx + w / 2 + gap + len, baseY - size * 0.3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    halo(() => label(cx - w / 2, baseY, paint.ink));
  } else if (kit.kind === "dots") {
    const gap = 18, rr = 3.5;
    ctx.fillStyle = paint.ink;
    ctx.beginPath(); ctx.arc(cx - w / 2 - gap, baseY - size * 0.3, rr, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + w / 2 + gap, baseY - size * 0.3, rr, 0, Math.PI * 2); ctx.fill();
    halo(() => label(cx - w / 2, baseY, paint.ink));
  } else if (kit.kind === "tick") {
    ctx.strokeStyle = paint.fill; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - size * 1.1, baseY - size * 1.25); ctx.lineTo(cx + size * 1.1, baseY - size * 1.25);
    ctx.stroke();
    halo(() => label(cx - w / 2, baseY, paint.ink));
  } else if (kit.kind === "corner") {
    halo(() => label(canvas.w - w - 34, canvas.h - 28, paint.ink));
  } else {
    halo(() => label(cx - w / 2, baseY, paint.ink));
  }
  ctx.restore();
  try { (ctx as unknown as { letterSpacing: string }).letterSpacing = "0px"; } catch { /* noop */ }
  return kit.kind === "bar" ? size * 2.1 : size * 2;
}

/* ==========================================================
 * 10. Нужна ли шаблону цифра «идей» (v7.5)
 *
 * Раньше цифра включалась во всех шаблонах Mix, из-за чего попадала
 * в композиции, которые её не предполагали. Теперь у каждой раскладки
 * есть класс: обязательна / допустима / не нужна.
 * ========================================================== */

export type NumberNeed = "required" | "optional" | "none";

/** Раскладки, построенные вокруг цифры. */
const NUMBER_REQUIRED = new Set([
  "lay-hero-number", "lay-hero-number-top", "lay-overlay-badge", "lay-dense-overlay",
  "lay-blob", "lay-sticker", "lay-sticker-bottom", "lay-ticket", "lay-neo-deco", "lay-neo-deco-bottom",
]);

/** Раскладки, где цифра почти всегда мешает композиции. */
const NUMBER_NONE = new Set([
  "lay-side", "lay-side-story", "lay-side-clean", "lay-arch", "lay-arch-bottom",
  "lay-swiss-giant", "lay-soft", "lay-mid-editorial", "lay-mid-swiss",
  "lay-band-bottom", "lay-overlay-band", "lay-chrome", "lay-domain-bar", "lay-grid-caption",
]);

export function layoutNumberNeed(layoutId: string): NumberNeed {
  if (NUMBER_REQUIRED.has(layoutId)) return "required";
  if (NUMBER_NONE.has(layoutId)) return "none";
  return "optional";
}

/** Спокойные подачи цифры — для шаблонов, где она лишь допустима. */
export const CALM_NUMBER_PLACEMENTS = new Set(["np-inline", "np-above", "np-baseline", "np-side"]);
