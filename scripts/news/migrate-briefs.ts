/**
 * Разовый перенос (30.10): углы и ТЗ, сделанные до «ТЗ по сайтам», хранились в самом кластере.
 * Переносим их в NewsBrief основного сайта проекта: с ТЗ — «ТЗ готово», только углы — черновик.
 * Повторный запуск безопасен: уже перенесённые пропускаются.
 *   npx tsx scripts/news/migrate-briefs.ts
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseSettings, projectSites } from "@/lib/news/types";

async function main() {
  const projects = await prisma.newsProject.findMany();
  let moved = 0;
  for (const p of projects) {
    const site = projectSites(p, parseSettings(p.settings))[0];
    if (!site) continue;
    const rows = await prisma.newsCluster.findMany({ where: { projectId: p.id, angles: { not: Prisma.DbNull } } });
    for (const c of rows) {
      const exists = await prisma.newsBrief.findUnique({ where: { clusterId_site: { clusterId: c.id, site: site.host } } });
      if (exists) continue;
      await prisma.newsBrief.create({
        data: {
          projectId: p.id, clusterId: c.id, site: site.host, angles: c.angles as Prisma.InputJsonValue, anglesAt: c.anglesAt, angleIdx: c.angleIdx,
          brief: c.brief, briefAt: c.briefAt, status: c.brief ? (c.status === "published" ? "published" : "ready") : "draft", createdById: c.workById,
        },
      });
      moved++;
    }
    console.log(`${p.name}: ${site.host}, перенесено ${moved}`);
  }
}

main().finally(() => prisma.$disconnect());
