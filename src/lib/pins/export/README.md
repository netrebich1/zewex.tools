# Выгрузка в Pinterest (`src/lib/pins/export`)

Чистые функции без Prisma и React. Порт шага «Выгрузка» старого приложения
(`bulkEngine.preparePinterestExport`, `buildPinterestCsv*`, `dayExport.ts`). Buffer убран.

| Файл | Что делает |
|---|---|
| `pinterest.ts` | `PINTEREST_UNSAFE_CHARS`, `normalizeText`, `clampText`, `csvEscape`, `preparePinterestExport(items, opts)`, `dedupeTitles(rows)`, `buildPinterestCsv(rows, tz)`, `splitCsv(rows, maxRows, tz)`, `fileName(day, siteName, isNew)` |
| `day.ts` | `buildDayFiles(input)` — файл одного сайта за один день: редиректы → fixer `today` (только сегодня) → preflight → уникальные заголовки → CSV |

## Правила

- Колонки: `Title, Media URL, Pinterest board, Thumbnail, Description, Destination link, Publish date, Keywords`;
  дата `YYYY-MM-DDTHH:mm:ss` в поясе `tz`; до 200 строк на файл (`splitCsv`).
- Preflight: картинка и ссылка — http(s) URL, доска и описание не пустые, заголовок или описание есть, дата есть.
  Публикация не раньше `now + 15 мин`; одинаковые времена разводятся с шагом 5 мин. Проблемные пины не попадают
  в файл, а возвращаются в `issues` (`{ id, reason }`, подписи — `PINTEREST_ISSUE_LABEL`).
- Тексты: вырезаются эмодзи/ZWJ/variation selectors/разделители строк, нормализуются кавычки, тире, неразрывные
  пробелы; заголовок ≤ 100, описание ≤ 500, ключевые слова ≤ 200 (обрезка по слову).
- Имя файла: `DD_MM_YYYY_SiteName.csv`; если fixer переставил время сегодняшних пинов — `NEW_…`.
- CSV возвращается без BOM — при отдаче файла добавьте `﻿` в начало.

## Отличия от старого приложения

- Дедупликация заголовков только суффиксами (`- Ideas`, `- Inspo`, …), без переписывания ИИ.
- Убрана эвристика удаления кириллического префикса в латинском тексте; alt-текст не обрезается (в CSV его нет).
- Сдвинутые вперёд даты идут цепочкой с шагом 5 мин от «сейчас + 15», но несдвинутые строки эту цепочку не двигают.
- `buildDayFiles` не ходит в БД и не проверяет редиректы сам: карта редиректов и запись новых дат (`retimedAt`) — у вызывающего.
