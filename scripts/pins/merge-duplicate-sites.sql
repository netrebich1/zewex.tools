-- Объединение дублей сайтов, пришедших из импорта старого сервиса (2026-10-09).
-- Старая запись (без досок) → наборы стилей и скрытия переносятся на новую (с досками),
-- старая уходит в архив (isActive=0), не удаляется. Прогонов у этих записей нет.
-- Запуск: mariadb zewex_tools < scripts/pins/merge-duplicate-sites.sql

-- inspiration-for-home.com
UPDATE PinSet SET siteId='f3f794b3-479c-45f9-82e9-6bfaed760751' WHERE siteId='0187b329-66bf-4ead-badb-44227ac4101d';
UPDATE PinStyleExclusion SET siteId='f3f794b3-479c-45f9-82e9-6bfaed760751' WHERE siteId='0187b329-66bf-4ead-badb-44227ac4101d';
-- my-inspo.com
UPDATE PinSet SET siteId='e77961e6-1bd7-4027-af28-e304dd064079' WHERE siteId='dd42743a-b560-4b87-adb9-1a6ee1f55e72';
UPDATE PinStyleExclusion SET siteId='e77961e6-1bd7-4027-af28-e304dd064079' WHERE siteId='dd42743a-b560-4b87-adb9-1a6ee1f55e72';
-- qunex.online
UPDATE PinSet SET siteId='0c70e654-04d2-4e15-a63e-b37c1a39e9d2' WHERE siteId='0cef2889-f10f-4a9c-8aa5-2ad4c6ec7e5c';
UPDATE PinStyleExclusion SET siteId='0c70e654-04d2-4e15-a63e-b37c1a39e9d2' WHERE siteId='0cef2889-f10f-4a9c-8aa5-2ad4c6ec7e5c';
-- voxen.info
UPDATE PinSet SET siteId='6fcfa522-5daa-4195-a2bb-d815331deacf' WHERE siteId='0a66bf81-dda7-40a8-9e39-be93f5212c4b';
UPDATE PinStyleExclusion SET siteId='6fcfa522-5daa-4195-a2bb-d815331deacf' WHERE siteId='0a66bf81-dda7-40a8-9e39-be93f5212c4b';
-- women-lifstyle.com
UPDATE PinSet SET siteId='39fbaf72-00b3-4c0e-8dfc-2b8957d77c49' WHERE siteId='0c03d223-4feb-40a9-b9cc-e06dada0e48b';
UPDATE PinStyleExclusion SET siteId='39fbaf72-00b3-4c0e-8dfc-2b8957d77c49' WHERE siteId='0c03d223-4feb-40a9-b9cc-e06dada0e48b';
-- zentrosy.com
UPDATE PinSet SET siteId='ded22fdc-38ff-4059-b687-d6e2d7858db5' WHERE siteId='dbd66c49-a7cf-4775-8b97-cf95bb1c59fa';
UPDATE PinStyleExclusion SET siteId='ded22fdc-38ff-4059-b687-d6e2d7858db5' WHERE siteId='dbd66c49-a7cf-4775-8b97-cf95bb1c59fa';

-- Старые записи в архив, с пометкой в названии.
UPDATE PinSite SET isActive=0, name=CONCAT(name, ' (старая запись)') WHERE id IN (
  '0187b329-66bf-4ead-badb-44227ac4101d','dd42743a-b560-4b87-adb9-1a6ee1f55e72','0cef2889-f10f-4a9c-8aa5-2ad4c6ec7e5c',
  '0a66bf81-dda7-40a8-9e39-be93f5212c4b','0c03d223-4feb-40a9-b9cc-e06dada0e48b','dbd66c49-a7cf-4775-8b97-cf95bb1c59fa');

-- В поле «ниша» у части импортированных сайтов лежит текст темы, а не ниша — чистим.
UPDATE PinSite SET niche='' WHERE niche NOT IN ('', 'decor', 'nails', 'hair', 'outfit', 'cooking', 'other');

SELECT name, isActive, (SELECT COUNT(*) FROM PinSet x WHERE x.siteId=s.id) sets, (SELECT COUNT(*) FROM PinBoard b WHERE b.siteId=s.id) boards
FROM PinSite s WHERE name LIKE 'inspiration-for-home%' OR name LIKE 'zentrosy%' OR name LIKE 'qunex%' OR name LIKE 'voxen%' OR name LIKE 'women-lifstyle%' OR name LIKE 'my-inspo%' ORDER BY name;
