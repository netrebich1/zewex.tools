/**
 * Разовая дочистка уже опубликованных статей (2026-10-22): slimPublishedFiles для каждой COMPLETED-статьи с записью
 * на сайте — удаляет наши копии фото, уже лежащие в WordPress, дубли миниатюр вошедших кандидатов и пережимает банк
 * одобренных кадров (JPEG ≤1200, q80). Идемпотентно: повторный запуск ничего не портит.
 *
 * Запуск на сервере (низкий приоритет, чтобы не мешать воркеру):
 *   cd /var/www/zewex_tools_usr/data/app && sudo -u zewex_tools_usr -H nice -n 19 npx tsx scripts/articles/slim-published.ts [--limit N] [--dry]
 */
import { prisma } from "@/lib/db";
import { slimPublishedFiles } from "@/lib/articles/wp/cleanup";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 100_000;
const dry = args.includes("--dry");

async function main() {
  const rows = await prisma.article.findMany({
    where: { status: "COMPLETED", wpUrl: { not: null } },
    select: { id: true },
    orderBy: { finishedAt: "asc" },
    take: limit,
  });
  console.log(`статей: ${rows.length}${dry ? " (проверка без изменений)" : ""}`);
  if (dry) return;
  let saved = 0;
  let photos = 0;
  let skipped = 0;
  const started = Date.now();
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = await slimPublishedFiles(rows[i].id);
      if (!r) skipped++;
      else {
        saved += r.savedBytes;
        photos += r.photos;
      }
    } catch (e) {
      console.warn(`${rows[i].id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      const min = ((Date.now() - started) / 60_000).toFixed(1);
      console.log(`${i + 1}/${rows.length} · освобождено ${(saved / 1073741824).toFixed(2)} ГБ · копий фото удалено ${photos} · пропущено ${skipped} · ${min} мин`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
