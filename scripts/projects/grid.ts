/** Ручная перезапись сетки «Проектов» в Google-таблице владельца (на сервере, с .env): `npx tsx scripts/projects/grid.ts`. */
import { prisma } from "@/lib/db";
import { prjGridTick } from "@/lib/projects/grid";

prjGridTick(true)
  .then((r) => { console.log(r.written ? `OK: сайтов ${r.sites}` : "не записано"); if (r.errors.length) { console.error("ERR", r.errors.join("\n")); process.exitCode = 1; } })
  .catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
