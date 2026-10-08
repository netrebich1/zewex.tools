import { prisma } from "@/lib/db";
import type { CanvasRecipe } from "./recipe";
import { specFromRecipe, validateStyle, type StyleSpec } from "./styleSpec";
import { attachBoldPalettes, PALETTE_REV } from "./paletteLibrary";
import { CURATED_STYLES } from "./curated";

/**
 * Каталог Canvas-стилей: из 3425 старых шаблонов-«лотерей» собираются кандидаты
 * (один «спокойный» шаблон на группу стиля), владелец утверждает их по превью.
 * Строки каталога — PinCanvasStyle с libraryId = "catalog", data = StyleSpec.
 */
export const CATALOG_LIB = "catalog";
const V9_THEMES = ["beauty-fashion", "home-decor", "blog-info", "food", "tattoo"];

/** Ключ стиля: v9-<тема>-<стиль> (без раскладки/числа фото/варианта) или "<категория>:<имя до ' · '>". */
export function styleKeyOf(row: { id: string; name: string; category: string; data: unknown }): string {
  const id = row.id;
  if (id.startsWith("v9-")) {
    const m = id.match(/^(.*)-([a-z0-9-]+?)-(\d+)-(\d+)$/i);
    if (m) {
      const theme = V9_THEMES.find((t) => id.startsWith(`v9-${t}-`));
      const kitLayout = String((row.data as { kit?: { layout?: string } } | null)?.kit?.layout || "").replace(/^lay-/, "");
      const body = m[1];
      if (kitLayout && body.endsWith(`-${kitLayout}`)) return body.slice(0, -kitLayout.length - 1);
      if (theme) return body.replace(/-[a-z]+(-[a-z]+)?$/, "");
      return body;
    }
  }
  const base = row.name.split(" · ")[0].replace(/\s*#\d+$/, "").trim();
  return `${row.category}:${base}`;
}

/** Чем «спокойнее» шаблон, тем выше балл: без наклона, без жёсткой тени, без дудлов, плоская плашка. */
export function calmScore(r: CanvasRecipe): number {
  const kit = (r as { kit?: Record<string, unknown> }).kit ?? {};
  let s = 0;
  if (!kit.skew || Number(kit.skew) === 0) s += 2;
  if (kit.shadow !== "hard") s += 1;
  if (!(r as { doodles?: boolean }).doodles) s += 2;
  if (String(kit.plate ?? "").endsWith("-flat") || !kit.plate) s += 1;
  if (String(kit.highlight ?? "hl-none") === "hl-none" || String(kit.highlight ?? "").includes("thin")) s += 1;
  const ov = Number((r as { overlay?: number }).overlay ?? 0.4);
  if (ov >= 0.3 && ov <= 0.55) s += 1;
  if (!String(kit.numPlace ?? "").includes("ghost")) s += 1;
  return s;
}

/** Собирает кандидатов из старых шаблонов в строки каталога (idempotent). */
export async function harvestCandidates(): Promise<{ groups: number; created: number; skipped: number }> {
  const rows = await prisma.pinCanvasStyle.findMany({ where: { isActive: true, libraryId: { not: CATALOG_LIB } }, select: { id: true, name: true, category: true, libraryId: true, data: true } });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = styleKeyOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let created = 0, skipped = 0;
  for (const [key, list] of groups) {
    const id = `cat:${key}`.slice(0, 160);
    const exists = await prisma.pinCanvasStyle.findUnique({ where: { id }, select: { id: true } });
    if (exists) { skipped++; continue; }
    const scored = list.map((r) => ({ r, score: calmScore(r.data as unknown as CanvasRecipe) })).sort((a, b) => b.score - a.score);
    const best = scored[0].r;
    let spec: StyleSpec;
    try {
      spec = specFromRecipe(id, best.name.split(" · ")[0], best.data as unknown as CanvasRecipe);
    } catch {
      skipped++;
      continue;
    }
    spec.sourceIds = list.map((r) => r.id);
    spec.tags = [...new Set([...(spec.tags ?? []), best.libraryId])];
    spec = attachBoldPalettes(spec, id);
    const counts = new Set<number>();
    for (const r of list) { const n = Number((r.data as { photoCount?: number }).photoCount ?? 1); if ([1, 2, 3, 4, 6].includes(n)) counts.add(n); }
    if (counts.size) spec.counts = [...counts].sort((a, b) => a - b) as StyleSpec["counts"];
    const problems = validateStyle(spec);
    await prisma.pinCanvasStyle.create({ data: { id, libraryId: CATALOG_LIB, name: spec.name, category: best.category, data: spec as unknown as object, isActive: problems.length === 0, isApproved: false, sortOrder: 1000 - scored[0].score } });
    created++;
  }
  return { groups: groups.size, created, skipped };
}

/** Свои стили портала (curated.ts) → строки каталога, если их ещё нет. Idempotent. */
export async function seedCuratedStyles(): Promise<{ created: number; invalid: string[] }> {
  let created = 0;
  const invalid: string[] = [];
  for (const c of CURATED_STYLES) {
    const problems = validateStyle(c.spec);
    if (problems.length) { invalid.push(`${c.id}: ${problems.join("; ")}`); continue; }
    const exists = await prisma.pinCanvasStyle.findUnique({ where: { id: c.id }, select: { id: true } });
    if (exists) continue;
    await prisma.pinCanvasStyle.create({ data: { id: c.id, libraryId: CATALOG_LIB, name: c.spec.name, category: c.category, data: c.spec as unknown as object, isActive: true, isApproved: false, sortOrder: 0 } });
    created++;
  }
  return { created, invalid };
}

/**
 * Старым строкам каталога (rev 1, одна бледная палитра) подмешиваются сочные
 * палитры из библиотеки. Превью таких стилей сбрасывается, чтобы перерисоваться.
 */
export async function upgradeCatalogPalettes(): Promise<number> {
  const rows = await prisma.pinCanvasStyle.findMany({ where: { libraryId: CATALOG_LIB }, select: { id: true, data: true } });
  let n = 0;
  for (const r of rows) {
    const spec = r.data as unknown as StyleSpec;
    if ((spec.rev ?? 1) >= PALETTE_REV) continue;
    const next = attachBoldPalettes(spec, r.id);
    if (validateStyle(next).length) continue;
    await prisma.pinCanvasStyle.update({ where: { id: r.id }, data: { data: next as unknown as object, previewPath: null } });
    n++;
  }
  return n;
}

/** Утверждённые стили каталога, доступные сайту (наборы сайта и скрытия). */
export async function approvedStylesForSite(siteId: string, canvasSetIds: string[]): Promise<Array<{ id: string; spec: StyleSpec }>> {
  const [rows, sets, hidden] = await Promise.all([
    prisma.pinCanvasStyle.findMany({ where: { libraryId: CATALOG_LIB, isApproved: true, isActive: true } }),
    canvasSetIds.length ? prisma.pinSet.findMany({ where: { id: { in: canvasSetIds }, setKind: "canvas" }, select: { styleIds: true } }) : Promise.resolve([]),
    prisma.pinStyleExclusion.findMany({ where: { siteId, kind: "canvas", topic: "" }, select: { styleId: true } }),
  ]);
  const allowed = new Set(sets.flatMap((s) => s.styleIds as string[]));
  const hid = new Set(hidden.map((h) => h.styleId));
  return rows.filter((r) => !hid.has(r.id) && (!allowed.size || allowed.has(r.id))).map((r) => ({ id: r.id, spec: r.data as unknown as StyleSpec }));
}
