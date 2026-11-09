/**
 * Перенос Canvas-наборов сайтов (PinSet.setKind = "canvas") со старых шаблонов
 * на утверждённые стили каталога.
 *
 * Для каждого id в styleIds:
 *   1. уже утверждённый стиль (PinCanvasStyle.isApproved) — оставляем как есть;
 *   2. легаси-шаблон → ключ группы (та же логика, что в harvest-canvas-candidates.mjs)
 *      → утверждённый стиль, у которого data.sourceIds содержит id шаблона
 *      или чей id равен ключу группы;
 *   3. иначе — выпадает (пишем в лог).
 *
 * По умолчанию сухой прогон (ничего не пишет). Запуск на сервере:
 *   node scripts/pins/migrate-canvas-sets.mjs            # отчёт
 *   node scripts/pins/migrate-canvas-sets.mjs --apply    # записать styleIds/pinCount
 *   (эквивалентно --dry-run=false)
 */
import { PrismaClient } from "@prisma/client";
import { styleKeyOf, isLegacyRecipe } from "./harvest-canvas-candidates.mjs";

const args = process.argv.slice(2);
const dryRun = !(args.includes("--apply") || args.includes("--dry-run=false") || args.includes("--no-dry-run"));
const prisma = new PrismaClient();

const asIds = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

try {
  const approved = await prisma.pinCanvasStyle.findMany({
    where: { isApproved: true },
    select: { id: true, name: true, data: true, isActive: true },
  });
  const approvedIds = new Set(approved.map((s) => s.id));
  const byKey = new Map(approved.map((s) => [s.id, s.id]));
  const bySource = new Map();
  for (const s of approved) {
    const d = s.data && typeof s.data === "object" && !Array.isArray(s.data) ? s.data : {};
    for (const src of asIds(d.sourceIds)) if (!bySource.has(src)) bySource.set(src, s.id);
  }
  console.log(`Утверждённых стилей: ${approved.length} (по sourceIds покрыто шаблонов: ${bySource.size})`);
  if (!approved.length) console.log("Внимание: утверждённых стилей нет — все легаси-шаблоны выпадут.");

  const sets = await prisma.pinSet.findMany({
    where: { setKind: "canvas" },
    select: { id: true, siteId: true, name: true, styleIds: true, site: { select: { name: true } } },
    orderBy: [{ siteId: "asc" }, { name: "asc" }],
  });
  console.log(`Canvas-наборов: ${sets.length}${dryRun ? " — сухой прогон, запись выключена" : " — запись включена"}`);

  const wanted = new Set();
  for (const s of sets) for (const id of asIds(s.styleIds)) if (!approvedIds.has(id)) wanted.add(id);
  const templates = wanted.size
    ? await prisma.pinCanvasStyle.findMany({ where: { id: { in: [...wanted] } }, select: { id: true, name: true, category: true, data: true } })
    : [];
  const templateById = new Map(templates.map((t) => [t.id, t]));

  const totals = { sets: 0, kept: 0, mapped: 0, dropped: 0, unchanged: 0, emptied: 0 };
  for (const s of sets) {
    const ids = asIds(s.styleIds);
    const next = [];
    const seen = new Set();
    const dropped = [];
    const push = (id) => { if (!seen.has(id)) { seen.add(id); next.push(id); } };
    let kept = 0, mapped = 0;
    for (const id of ids) {
      if (approvedIds.has(id)) { push(id); kept++; continue; }
      const t = templateById.get(id);
      let target = bySource.get(id);
      if (!target && t && isLegacyRecipe(t.data)) target = byKey.get(styleKeyOf(t).key);
      if (target) { push(target); mapped++; }
      else dropped.push(t ? `${id} (${styleKeyOf(t).key})` : `${id} (нет в базе)`);
    }
    const changed = next.length !== ids.length || next.some((id, i) => id !== ids[i]);
    totals.sets++; totals.kept += kept; totals.mapped += mapped; totals.dropped += dropped.length;
    if (!changed) totals.unchanged++;
    if (ids.length && !next.length) totals.emptied++;

    const site = s.site?.name || s.siteId;
    console.log(`\n[${site}] «${s.name}»: было ${ids.length} → стало ${next.length} (своих ${kept}, перенесено ${mapped}, выпало ${dropped.length})${changed ? "" : " — без изменений"}`);
    for (const d of dropped.slice(0, 20)) console.log(`    выпало: ${d}`);
    if (dropped.length > 20) console.log(`    … и ещё ${dropped.length - 20}`);

    if (changed && !dryRun) {
      await prisma.pinSet.update({ where: { id: s.id }, data: { styleIds: next, pinCount: next.length } });
      console.log("    записано");
    }
  }

  console.log(`\nИтого: наборов ${totals.sets}, без изменений ${totals.unchanged}, опустело ${totals.emptied}; id оставлено ${totals.kept}, перенесено ${totals.mapped}, выпало ${totals.dropped}`);
  if (dryRun) console.log("Сухой прогон. Чтобы применить: node scripts/pins/migrate-canvas-sets.mjs --apply");
} finally {
  await prisma.$disconnect();
}
