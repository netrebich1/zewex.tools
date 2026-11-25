/**
 * Отбор кандидатов в каталог Canvas-стилей из легаси-шаблонов (PinCanvasStyle).
 *
 * Шаблоны группируются по ключу стиля так же, как это делала галерея легаси
 * (groupStyles в CanvasStyleGallery.tsx): v9 — `v9-<theme>-<style>`, остальные —
 * `<category>:<имя до « · »>`. Внутри группы каждый шаблон получает оценку
 * «спокойствия» (без наклона, без жёсткой тени, без дудлов, плоская подложка,
 * тонкое выделение, спокойная подача цифры, скрим в диапазоне). Из группы берём
 * лучший шаблон и, если есть, один запасной с другим числом фото.
 *
 * Результат: src/data/pins/canvas-candidates.json
 *   [{ key, name, library, sourceIds, counts, sample, score, picked }]
 * Запуск на сервере (только чтение БД):
 *   node scripts/pins/harvest-canvas-candidates.mjs [--out src/data/pins/canvas-candidates.json] [--include-inactive]
 */
import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* ---------- группировка (зеркало groupStyles) ---------- */

export const V9_THEMES = ["beauty-fashion", "home-decor", "food", "tattoo", "blog-info"];

/** Раскладки из LAYOUT_KITS без префикса `lay-`, длинные первыми — для разбора хвоста id. */
const LAYOUT_TAILS = [
  "bottom-editorial", "top-editorial", "swiss-giant", "arch", "grid-caption", "hero-story", "dense", "balanced",
  "side", "soft", "tile", "split", "overlay-center", "overlay-band", "overlay-plate", "overlay-badge", "brush", "neon",
  "sticker", "tape", "hero-number", "hero-number-top", "neo-deco", "neo-deco-bottom", "contrast", "blob", "torn",
  "torn-bottom", "ticket", "doodle", "domain-bar", "chrome", "mid-editorial", "mid-swiss", "side-story", "side-clean",
  "dense-overlay", "grid-overlay", "split-top", "band-bottom", "arch-bottom", "sticker-bottom", "brush-bottom", "tile-top",
].sort((a, b) => b.length - a.length);

export const STYLE_COUNTS = [1, 2, 3, 4, 6];
export const CALM_PLACEMENTS = new Set(["np-inline", "np-above", "np-baseline", "np-side"]);
const LOUD_DOMAINS = new Set(["dom-spaced-lg", "dom-pill", "dom-bar", "dom-outline"]);
const OVERLAY_LAYOUTS = new Set([
  "lay-overlay-center", "lay-overlay-band", "lay-overlay-plate", "lay-overlay-badge", "lay-brush", "lay-neon",
  "lay-sticker", "lay-tape", "lay-contrast", "lay-blob", "lay-torn", "lay-ticket", "lay-chrome", "lay-dense-overlay", "lay-grid-overlay",
]);

export function recipePhotos(recipe) {
  const r = recipe || {};
  if (Number(r.photoCount) > 0) return Number(r.photoCount);
  const m = String(r.layout || "").match(/\d+/);
  return m ? Number(m[0]) : 1;
}

/** Разбор id v9-шаблона: `v9-<theme>-<style>-<layout>-<count>-<variant>`. */
function parseV9(id, recipe) {
  if (!id.startsWith("v9-")) return null;
  const rest = id.slice(3);
  const theme = V9_THEMES.find((t) => rest.startsWith(`${t}-`));
  if (!theme) return null;
  let body = rest.slice(theme.length + 1);
  const tail = /-(\d+)-(\d+)$/.exec(body);
  if (!tail) return null;
  body = body.slice(0, tail.index);
  const kitLayout = String(recipe?.kit?.layout || "").replace(/^lay-/, "");
  const layout = kitLayout && body.endsWith(`-${kitLayout}`) ? kitLayout : LAYOUT_TAILS.find((l) => body.endsWith(`-${l}`));
  if (!layout) return null;
  const style = body.slice(0, body.length - layout.length - 1);
  return style ? { theme, style } : null;
}

/** Ключ стиля и его человеческое имя — как в галерее легаси. */
export function styleKeyOf(row) {
  const v9 = parseV9(row.id, row.data);
  if (v9) return { key: `v9-${v9.theme}-${v9.style}`, name: v9.style, theme: v9.theme };
  const name = String(row.name || "").split(" · ")[0].replace(/\s*#\d+$/, "").trim();
  const category = String(row.category || "");
  return { key: `${category}:${name}`, name, theme: category };
}

/** Легаси-рецепт (а не StyleSpec нового каталога). */
export const isLegacyRecipe = (data) => !!data && typeof data === "object" && !Array.isArray(data) && "palette" in data && !("palettes" in data);

/* ---------- оценка «спокойствия» ---------- */

export function calmScore(recipe) {
  const r = recipe || {};
  const kit = r.kit || {};
  const reasons = [];
  let score = 0;
  const add = (v, why) => { score += v; if (v < 0) reasons.push(why); };

  const skew = Number(kit.skew || 0);
  if (skew === 0) add(2, ""); else add(-2 * Math.min(3, Math.abs(skew)), `skew ${skew}`);
  if (kit.shadow === "hard") add(-2, "hard shadow"); else if (kit.shadow === "soft") add(0, ""); else add(1, "");
  if (r.doodles) add(-2, "doodles");

  const plate = String(kit.plate || "kit-none");
  if (plate === "kit-none") add(1, "");
  else if (/-flat$/.test(plate)) add(1, "");
  else if (/-(split|grad)$/.test(plate)) add(-1.5, `plate ${plate}`);
  else add(-1, `plate ${plate}`);

  const hl = String(kit.highlight || "hl-none");
  if (hl === "hl-none") add(1, "");
  else if (/^hl-line-(thin|short|soft|dotted)$/.test(hl)) add(0.5, "");
  else if (hl.startsWith("hl-fill-")) add(-1.5, `highlight ${hl}`);
  else if (hl.startsWith("hl-frame-")) add(-1, `highlight ${hl}`);
  else add(-0.5, `highlight ${hl}`);

  const mode = r.numberMode || (r.numberStyle === "none" ? "none" : "optional");
  if (mode !== "none") {
    const place = String(kit.numPlace || "np-inline");
    if (place === "np-ghost") add(-3, "number ghost");
    else if (CALM_PLACEMENTS.has(place)) add(1, "");
    else add(-1.5, `number ${place}`);
    const num = String(kit.number || "num-plain");
    if (/-(rays|double|dashed|offset)$/.test(num) || /^num-(burst|ribbon)-/.test(num)) add(-2, `number ${num}`);
    else add(0.5, "");
  }

  const layout = String(kit.layout || "");
  const overlayLayout = OVERLAY_LAYOUTS.has(layout) || (!layout && r.textZone === "overlay");
  if (overlayLayout) {
    const o = Number(r.overlay || 0);
    if (o >= 0.3 && o <= 0.55) add(1, ""); else add(-1, `overlay ${o}`);
  }
  if (LOUD_DOMAINS.has(String(kit.domain || ""))) add(-0.5, `domain ${kit.domain}`);
  if (r.decor === "grain" || Number(r.texture || 0) > 0) add(-0.3, "grain");
  if (/^frm-(thick|shadowbox)-/.test(String(kit.frame || ""))) add(-0.5, `frame ${kit.frame}`);
  if (Math.abs(Number(r.titleTracking || 0)) > 4) add(-0.5, "tracking");

  const count = recipePhotos(r);
  if (!STYLE_COUNTS.includes(count)) add(-5, `photos ${count}`);

  return { score: Math.round(score * 100) / 100, reasons };
}

/* ---------- основной проход ---------- */

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
  const outPath = resolve(opt("--out", "src/data/pins/canvas-candidates.json"));
  const includeInactive = args.includes("--include-inactive");

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.pinCanvasStyle.findMany({
      where: includeInactive ? {} : { isActive: true },
      select: { id: true, libraryId: true, name: true, category: true, data: true, isApproved: true },
      orderBy: { sortOrder: "asc" },
    });
    const legacy = rows.filter((r) => isLegacyRecipe(r.data) && !r.isApproved);
    console.log(`Шаблонов: ${rows.length}, легаси-рецептов для отбора: ${legacy.length}`);

    const groups = new Map();
    for (const row of legacy) {
      const k = styleKeyOf(row);
      const g = groups.get(k.key) || { key: k.key, name: k.name, theme: k.theme, library: row.libraryId, rows: [] };
      g.rows.push({ row, count: recipePhotos(row.data), ...calmScore(row.data) });
      groups.set(k.key, g);
    }

    const candidates = [];
    for (const g of groups.values()) {
      const sorted = [...g.rows].sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));
      const best = sorted[0];
      const alt = sorted.find((x) => x.count !== best.count && STYLE_COUNTS.includes(x.count));
      const picked = [best, ...(alt ? [alt] : [])];
      candidates.push({
        key: g.key,
        name: g.name,
        library: g.library,
        theme: g.theme,
        sourceIds: g.rows.map((x) => x.row.id),
        counts: [...new Set(picked.map((x) => x.count))].sort((a, b) => a - b),
        sample: best.row.data,
        score: best.score,
        picked: picked.map((x) => ({ id: x.row.id, count: x.count, score: x.score, reasons: x.reasons })),
        templates: g.rows.length,
      });
    }
    candidates.sort((a, b) => a.library.localeCompare(b.library) || b.score - a.score || a.name.localeCompare(b.name));

    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(candidates, null, 2) + "\n", "utf8");

    const perLib = new Map();
    for (const c of candidates) {
      const s = perLib.get(c.library) || { groups: 0, templates: 0 };
      s.groups++; s.templates += c.templates;
      perLib.set(c.library, s);
    }
    console.log(`Групп (кандидатов): ${candidates.length} → ${outPath}`);
    for (const [lib, s] of [...perLib.entries()].sort()) console.log(`  ${lib.padEnd(18)} групп ${String(s.groups).padStart(3)}  шаблонов ${s.templates}`);
    const skipped = rows.length - legacy.length;
    if (skipped) console.log(`Пропущено строк (уже стили каталога или не рецепт): ${skipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
