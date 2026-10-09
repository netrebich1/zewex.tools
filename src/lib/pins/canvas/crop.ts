/**
 * Smart-crop (порт canvaPins.ts): профили акцента, карта энергии (saliency),
 * бокс акцента, drawSmartCover. Карта энергии считается на host-канвасе.
 */
import { asImageSource, getHost, type Ctx2D, type HostImage } from "./host";

export const PIN_W = 1000;
export const PIN_H = 1500;

export type AccentType =
  | "auto" | "hair" | "nails" | "makeup" | "outfit" | "decor" | "food" | "interior";

export interface AccentProfile {
  id: AccentType;
  name: string;
  /** вес «кожи»: > 0 — притягивать (маникюр, волосы, макияж), < 0 — отталкивать */
  skin: number;
  edge: number;
  fine: number;
  sat: number;
  bright: number;
  /** вертикальное смещение предпочтения: -1 верх (лицо/волосы), +1 низ */
  bias: number;
  /** поля вокруг акцента при кадрировании */
  margin: number;
}

export const ACCENT_PROFILES: AccentProfile[] = [
  { id: "auto", name: "Авто", skin: 0.1, edge: 1.0, fine: 1.3, sat: 0.4, bright: 0.3, bias: 0, margin: 0.06 },
  { id: "hair", name: "Волосся / зачіска", skin: 0.9, edge: 1.1, fine: 1.5, sat: 0.3, bright: 0.35, bias: -0.6, margin: 0.09 },
  { id: "nails", name: "Манікюр / нігті", skin: 1.2, edge: 1.3, fine: 1.7, sat: 0.6, bright: 0.3, bias: 0, margin: 0.1 },
  { id: "makeup", name: "Макіяж / обличчя", skin: 1.3, edge: 1.0, fine: 1.4, sat: 0.5, bright: 0.3, bias: -0.5, margin: 0.08 },
  { id: "outfit", name: "Одяг / образ", skin: 0.5, edge: 1.1, fine: 1.1, sat: 0.7, bright: 0.3, bias: -0.2, margin: 0.05 },
  { id: "decor", name: "Декор", skin: -0.2, edge: 1.3, fine: 1.3, sat: 0.9, bright: 0.35, bias: 0, margin: 0.06 },
  { id: "food", name: "Їжа", skin: -0.1, edge: 1.2, fine: 1.4, sat: 1.0, bright: 0.4, bias: 0, margin: 0.05 },
  { id: "interior", name: "Інтер'єр", skin: -0.3, edge: 1.4, fine: 1.0, sat: 0.7, bright: 0.4, bias: 0, margin: 0.03 },
];

export function accentProfile(a?: AccentType): AccentProfile {
  return ACCENT_PROFILES.find((p) => p.id === (a || "auto")) || ACCENT_PROFILES[0];
}

/** Любая строка из рецепта → допустимый AccentType (неизвестное → auto). */
export function toAccent(s?: string): AccentType {
  const hit = ACCENT_PROFILES.find((p) => p.id === s);
  return hit ? hit.id : "auto";
}

/** Тип контента по ключевому слову/теме — по словарю (ua/ru/en). */
const ACCENT_WORDS: Array<[AccentType, RegExp]> = [
  ["nails", /(манік|маник|нігт|ногт|nail|педикюр)/i],
  ["hair", /(зачіск|причёск|причес|стрижк|волосс|волос|hair|балаяж|окрашив|фарбув)/i],
  ["makeup", /(макіяж|макияж|makeup|брови|брів|губ|ресниц|вій)/i],
  ["outfit", /(образ|лук|look|outfit|сукн|плать|одяг|одежд|джинс|спідниц|юбк|пальт|куртк|стиль одяг|гардероб|взутт|обув)/i],
  ["food", /(рецепт|страв|блюд|десерт|торт|салат|food|випічк|выпечк|напо)/i],
  ["interior", /(інтер|интерь|кімнат|комнат|кухн|спальн|ванн|interior|ремонт)/i],
  ["decor", /(декор|прикрас|украшен|букет|подарун|подарк|diy|хендмейд)/i],
];

/** Ниша сайта из рецепта → профиль акцента. */
const NICHE_ACCENT: Record<string, AccentType> = { nails: "nails", hair: "hair", outfit: "outfit", decor: "decor", cooking: "food", interior: "interior" };

export function guessAccent(...text: Array<string | undefined>): AccentType {
  for (const t of text) if (t && NICHE_ACCENT[t]) return NICHE_ACCENT[t];
  const s = text.filter(Boolean).join(" ");
  if (!s.trim()) return "auto";
  for (const [id, re] of ACCENT_WORDS) if (re.test(s)) return id;
  return "auto";
}

interface EnergyMap { e: Float32Array; w: number; h: number }

const energyCache = new WeakMap<HostImage, Map<string, EnergyMap>>();

function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const out = new Float32Array(src.length);
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        s += src[y * w + xx]; n++;
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x]; n++;
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function energyMap(img: HostImage, prof: AccentProfile = accentProfile("auto")): EnergyMap {
  let byProf = energyCache.get(img);
  if (!byProf) { byProf = new Map(); energyCache.set(img, byProf); }
  const cached = byProf.get(prof.id);
  if (cached) return cached;
  const iw = img.width;
  const ih = img.height;
  const w = iw >= ih ? 96 : Math.max(8, Math.round((96 * iw) / ih));
  const h = iw >= ih ? Math.max(8, Math.round((96 * ih) / iw)) : 96;
  const ctx = getHost().createCanvas(w, h).getContext("2d");
  ctx.drawImage(asImageSource(img), 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const gray = new Float32Array(w * h);
  const sat = new Float32Array(w * h);
  const skinRaw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    gray[i] = (r + g + b) / 3;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat[i] = (mx - mn) / (mx + 1e-6);
    skinRaw[i] = r > 80 && r > g + 12 && g >= b - 10 && mx - mn > 12 ? 1 : 0;
  }
  const skin = boxBlur(skinRaw, w, h, 2);
  const blurG = boxBlur(gray, w, h, 2);

  const e = new Float32Array(w * h);
  let edgeMax = 1e-6, fineMax = 1e-6;
  const edge = new Float32Array(w * h);
  const fine = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = Math.abs(gray[i] - gray[y * w + Math.max(0, x - 1)]);
      const gy = Math.abs(gray[i] - gray[Math.max(0, y - 1) * w + x]);
      edge[i] = gx + gy;
      fine[i] = Math.abs(gray[i] - blurG[i]);
      if (edge[i] > edgeMax) edgeMax = edge[i];
      if (fine[i] > fineMax) fineMax = fine[i];
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bright = Math.min(1, Math.max(0, (gray[i] - 140) / 115));
      let v =
        prof.edge * (edge[i] / edgeMax) +
        prof.fine * (fine[i] / fineMax) +
        prof.sat * sat[i] +
        prof.bright * bright +
        prof.skin * skin[i];
      if (v < 0) v = 0;
      if (prof.bias) {
        const ny = y / Math.max(1, h - 1) - 0.5;
        v *= 1 + prof.bias * -ny * 0.8;
        if (v < 0) v = 0;
      }
      if (y < 2 || y >= h - 2 || x < 2 || x >= w - 2) v *= 0.3;
      e[i] = v;
    }
  }
  const res = { e, w, h };
  byProf.set(prof.id, res);
  return res;
}

/** Фокус кадра (0..1) для окна пропорций w:h. */
export function bestFocal(img: HostImage, w: number, h: number, accent?: AccentType): { fx: number; fy: number } {
  const prof = accentProfile(accent);
  const { e, w: ew, h: eh } = energyMap(img, prof);
  const iw = img.width;
  const ih = img.height;
  const r = Math.max(w / iw, h / ih);
  const ww = Math.min(ew, Math.max(1, Math.round((ew * (w / r)) / iw)));
  const wh = Math.min(eh, Math.max(1, Math.round((eh * (h / r)) / ih)));
  const ii = new Float64Array((ew + 1) * (eh + 1));
  for (let y = 0; y < eh; y++) {
    let rowSum = 0;
    for (let x = 0; x < ew; x++) {
      rowSum += e[y * ew + x];
      ii[(y + 1) * (ew + 1) + (x + 1)] = ii[y * (ew + 1) + (x + 1)] + rowSum;
    }
  }
  const win = (y: number, x: number) =>
    ii[(y + wh) * (ew + 1) + (x + ww)] - ii[y * (ew + 1) + (x + ww)] - ii[(y + wh) * (ew + 1) + x] + ii[y * (ew + 1) + x];
  let best = -Infinity, by = 0, bx = 0;
  for (let y = 0; y <= eh - wh; y++) {
    for (let x = 0; x <= ew - ww; x++) {
      const cy = (y + wh / 2) / eh - 0.5;
      const cx = (x + ww / 2) / ew - 0.5;
      const sc = win(y, x) * (1 - 0.12 * (Math.abs(cy) + Math.abs(cx)));
      if (sc > best) { best = sc; by = y; bx = x; }
    }
  }
  return { fx: (bx + ww / 2) / ew, fy: (by + wh / 2) / eh };
}

/** Бокс акцента (доли 0..1) — область высокой энергии, которую нельзя резать. */
export function accentBox(img: HostImage, accent?: AccentType): { x0: number; y0: number; x1: number; y1: number } {
  const prof = accentProfile(accent);
  const { e, w, h } = energyMap(img, prof);
  let max = 0;
  for (let i = 0; i < e.length; i++) if (e[i] > max) max = e[i];
  if (max <= 0) return { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.85 };
  const thr = max * 0.45;
  let x0 = w, y0 = h, x1 = 0, y1 = 0, hits = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (e[y * w + x] < thr) continue;
      hits++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!hits) return { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.85 };
  return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h };
}

export interface SmartCoverOpts {
  accent?: AccentType;
  /** ручной фокус 0..1 — перекрывает авто */
  focus?: { fx: number; fy: number };
  /** дополнительное приближение (1 = максимально широкий безопасный кадр) */
  zoom?: number;
  /** максимально допустимая доля обрезки площади исходника (0..1) */
  maxCrop?: number;
  /** цвет подложки, если фото вписывается целиком (contain) */
  fillBg?: string;
}

/** Доля площади, которую cover должен удалить при переходе между пропорциями. */
export function cropRatioForCell(imageAR: number, cellAR: number): number {
  if (!Number.isFinite(imageAR) || !Number.isFinite(cellAR) || imageAR <= 0 || cellAR <= 0) return 1;
  return imageAR > cellAR ? 1 - cellAR / imageAR : 1 - imageAR / cellAR;
}

/** Рисуем изображение «cover» с умным кадрированием по боксу акцента. */
export function drawSmartCover(
  ctx: Ctx2D, img: HostImage,
  dx: number, dy: number, dw: number, dh: number, opts: SmartCoverOpts = {},
): void {
  const iw = img.width;
  const ih = img.height;
  const ar = dw / dh;
  const prof = accentProfile(opts.accent);
  const src = asImageSource(img);

  const cover = Math.max(dw / iw, dh / ih);
  let sw = dw / cover, sh = dh / cover;

  let cx: number, cy: number;
  if (opts.focus) {
    cx = opts.focus.fx * iw;
    cy = opts.focus.fy * ih;
  } else {
    const box = accentBox(img, opts.accent);
    const m = prof.margin;
    const bx0 = Math.max(0, box.x0 - m) * iw;
    const bx1 = Math.min(1, box.x1 + m) * iw;
    const by0 = Math.max(0, box.y0 - m) * ih;
    const by1 = Math.min(1, box.y1 + m) * ih;
    let needW = Math.max(sw, bx1 - bx0);
    let needH = Math.max(sh, by1 - by0);
    if (needW / needH > ar) needH = needW / ar; else needW = needH * ar;
    if (needW > iw) { needW = iw; needH = iw / ar; }
    if (needH > ih) { needH = ih; needW = ih * ar; }
    sw = Math.min(iw, needW);
    sh = Math.min(ih, needH);
    cx = (bx0 + bx1) / 2;
    cy = (by0 + by1) / 2;
  }

  const zoom = Math.max(1, opts.zoom || 1);
  if (zoom > 1) {
    sw = Math.max(dw / cover, sw / zoom);
    sh = Math.max(dh / cover, sh / zoom);
  }

  let sx = cx - sw / 2;
  let sy = cy - sh / 2;
  if (!opts.focus) {
    // Окно обязано целиком накрывать бокс акцента: если оно меньше бокса,
    // держим верх (лицо и причёска живут вверху), а не центр.
    const box = accentBox(img, opts.accent);
    const m = prof.margin;
    const bx0 = Math.max(0, box.x0 - m) * iw, bx1 = Math.min(1, box.x1 + m) * iw;
    const by0 = Math.max(0, box.y0 - m * 1.5) * ih, by1 = Math.min(1, box.y1 + m) * ih;
    if (sh >= by1 - by0) sy = Math.max(by1 - sh, Math.min(by0, sy)); else sy = by0;
    if (sw >= bx1 - bx0) sx = Math.max(bx1 - sw, Math.min(bx0, sx)); else sx = (bx0 + bx1) / 2 - sw / 2;
  }
  sx = Math.max(0, Math.min(iw - sw, sx));
  sy = Math.max(0, Math.min(ih - sh, sy));

  // Пропорции не искажаются. Если для заполнения ячейки нужно срезать больше
  // допустимого — фото вписывается целиком, поля закрашиваются подложкой.
  const maxCrop = opts.maxCrop ?? 0.35;
  const cropped = cropRatioForCell(iw / ih, dw / dh);
  if (cropped > maxCrop + 1e-6) {
    const k = Math.min(dw / iw, dh / ih);
    const w = iw * k;
    const h = ih * k;
    if (opts.fillBg) {
      ctx.fillStyle = opts.fillBg;
      ctx.fillRect(dx, dy, dw, dh);
    }
    ctx.drawImage(src, 0, 0, iw, ih, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
    return;
  }
  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}
