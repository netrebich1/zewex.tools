/**
 * Article Copy: пересчитать карту ключей вручную (то же делает воркер по расписанию).
 *   cd /var/www/zewex_tools_usr/data/app && sudo -u zewex_tools_usr -H nice -n 19 npx tsx scripts/copy/rebuild.ts
 */
import { prisma } from "@/lib/db";
import { rebuildCopy } from "@/lib/copy/build";

rebuildCopy()
  .then(async (r) => {
    const sum = await prisma.copyCore.aggregate({ _sum: { byPhotos: true, capacity: true } });
    console.log(`ядер: ${r.cores}, ${r.ms} мс; статей по кадрам: ${sum._sum.byPhotos}, на сайты: ${sum._sum.capacity}`);
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
