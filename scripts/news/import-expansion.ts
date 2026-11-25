/**
 * Загрузка расширения источников и сущностей в проект «Новостей» (повторный запуск безопасен).
 * Источники — по адресу: новый создаётся, существующий обновляется (вес, фильтры, язык). Сущности — по имени
 * без регистра: новая создаётся, у существующей объединяются варианты написания, вес берётся из файла.
 * Запуск: npx tsx scripts/news/import-expansion.ts <file.json> [часть siteUrl, по умолчанию beautydaily] [--dry]
 */
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type Src = { kind: string; name: string; url: string; tier: string; lang: string; weight: number; profile?: boolean; includeCats?: string[]; excludeCats?: string[]; includeUrls?: string[] };
type Ent = { name: string; type: string; grp: string; weight: number; aliases: string[] };
type File = { settings?: Record<string, unknown>; deactivate?: { url: string; why: string }[]; sources: Src[]; entities: Ent[] };

const list = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const json = (v: string[] | undefined) => (v && v.length ? (v.map((x) => x.toLowerCase()) as Prisma.InputJsonValue) : Prisma.DbNull);

async function main() {
  const [file, site = "beautydaily", flag] = process.argv.slice(2);
  const dry = flag === "--dry" || site === "--dry";
  const data = JSON.parse(readFileSync(file, "utf8")) as File;
  const project = await prisma.newsProject.findFirstOrThrow({ where: { siteUrl: { contains: site === "--dry" ? "beautydaily" : site } } });
  console.log(`проект: ${project.name} (${project.siteUrl})${dry ? " — пробный прогон, без записи" : ""}`);

  const sources = await prisma.newsSource.findMany({ where: { projectId: project.id } });
  let sNew = 0, sUpd = 0, sOff = 0;
  for (const s of data.sources) {
    const cur = sources.find((x) => x.url === s.url && x.kind === s.kind);
    const fields = { name: s.name, tier: s.tier, lang: s.lang, weight: s.weight, profile: !!s.profile, includeCats: json(s.includeCats), excludeCats: json(s.excludeCats), includeUrls: json(s.includeUrls), isActive: true };
    if (cur) {
      sUpd++;
      if (!dry) await prisma.newsSource.update({ where: { id: cur.id }, data: fields });
    } else {
      sNew++;
      if (!dry) await prisma.newsSource.create({ data: { projectId: project.id, kind: s.kind, url: s.url, ...fields } });
    }
  }
  for (const d of data.deactivate ?? []) {
    const cur = sources.find((x) => x.url === d.url && x.isActive);
    if (!cur) continue;
    sOff++;
    console.log(`  выключен: ${cur.name} — ${d.why}`);
    if (!dry) await prisma.newsSource.update({ where: { id: cur.id }, data: { isActive: false, lastError: `Выключен 2026-10-29: ${d.why}` } });
  }

  const ents = await prisma.newsEntity.findMany({ where: { projectId: project.id } });
  const byName = new Map(ents.map((e) => [e.name.toLowerCase(), e]));
  let eNew = 0, eUpd = 0;
  for (const e of data.entities) {
    const cur = byName.get(e.name.toLowerCase());
    if (cur) {
      const merged = [...new Set([...list(cur.aliases), ...e.aliases])].filter((a) => a.toLowerCase() !== cur.name.toLowerCase());
      eUpd++;
      if (!dry) await prisma.newsEntity.update({ where: { id: cur.id }, data: { aliases: merged, weight: e.weight, grp: e.grp, type: e.type, isActive: true } });
    } else {
      eNew++;
      if (!dry) await prisma.newsEntity.create({ data: { projectId: project.id, name: e.name, type: e.type, grp: e.grp, weight: e.weight, aliases: e.aliases } });
    }
  }

  if (data.settings && !dry) {
    const cur = (project.settings ?? {}) as Record<string, unknown>;
    await prisma.newsProject.update({ where: { id: project.id }, data: { settings: { ...cur, ...data.settings } as Prisma.InputJsonValue } });
  }
  const [sTotal, sActive, eTotal] = await Promise.all([
    prisma.newsSource.count({ where: { projectId: project.id } }),
    prisma.newsSource.count({ where: { projectId: project.id, isActive: true } }),
    prisma.newsEntity.count({ where: { projectId: project.id, isActive: true } }),
  ]);
  console.log(`источники: +${sNew} новых, ${sUpd} обновлено, ${sOff} выключено; всего ${sTotal}, активных ${sActive}`);
  console.log(`сущности: +${eNew} новых, ${eUpd} обновлено; активных ${eTotal}`);
  if (data.settings) console.log(`настройки: ${JSON.stringify(data.settings)}`);
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
