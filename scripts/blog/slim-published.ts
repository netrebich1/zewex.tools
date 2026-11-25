/**
 * Разовая дочистка опубликованных блоговых постов (2026-11-06): удаляет оригиналы кандидатов фото (cand/*.jpg) у постов
 * COMPLETED с записью на сайте. Миниатюры, фото поста и строки базы остаются. Идемпотентно.
 *
 * Запуск на сервере:
 *   cd /var/www/zewex_tools_usr/data/app && sudo -u zewex_tools_usr -H nice -n 19 npx tsx scripts/blog/slim-published.ts [--dry]
 */
import { prisma } from "@/lib/db";
import { purgeCandidateOriginals } from "@/lib/blog/storage";

const dry = process.argv.includes("--dry");

async function main() {
  const rows = await prisma.blogPost.findMany({ where: { status: "COMPLETED", wpUrl: { not: null } }, select: { id: true }, orderBy: { finishedAt: "asc" } });
  console.log(`постов: ${rows.length}${dry ? " (проверка без изменений)" : ""}`);
  if (dry) return;
  let files = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      files += await purgeCandidateOriginals(rows[i].id);
      await prisma.blogPhotoCandidate.updateMany({ where: { postId: rows[i].id, path: { not: "" } }, data: { path: "" } });
    } catch (e) {
      console.warn(`${rows[i].id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((i + 1) % 200 === 0 || i === rows.length - 1) console.log(`${i + 1}/${rows.length} · удалено файлов ${files}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
