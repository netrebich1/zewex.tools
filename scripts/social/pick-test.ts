/** Проверка автоподбора статей по темам: npx tsx scripts/social/pick-test.ts <сайт> [сколько] (на сервере, с .env — нужна база). */
import { prisma } from "@/lib/db";
import { pickSitePosts } from "@/lib/social/source";

pickSitePosts(process.argv[2] ?? "beautydaily.com.ua", Number(process.argv[3]) || 10)
  .then((r) => {
    console.log(`берём рубрики: ${r.used.join(", ")}\nне берём: ${r.skipped.join(", ")}\nуже использовано: ${r.skippedUsed}`);
    for (const u of r.urls) console.log(u);
  })
  .catch((e) => { console.error("ОШИБКА:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
