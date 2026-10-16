-- Деплой 2026-10-10 упал на `prisma db push`: Prisma пытался удалить связь Article_siteId_fkey,
-- которой в базе нет (предыдущая синхронизация схемы статей прервалась). Типы колонок совпадают
-- (char(36) utf8mb4_unicode_ci), таблица Article пуста. Добавляем связь вручную, после чего db push проходит.
-- Запуск: ssh -i ~/.ssh/fastvps_ed25519 root@159.69.234.194 'mariadb zewex_tools' < scripts/articles/fix-article-site-fk.sql
ALTER TABLE `Article`
  ADD CONSTRAINT `Article_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `ArtSite` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
