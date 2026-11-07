# UI сервиса «Статьи» — ядро (обзор, сайты, запуск, карточки)

Исполнитель: UI-core. Статус: экраны волны 1 из моей зоны написаны; типы не проверялись (на Mac нет Node) — **первым делом `tsc --noEmit` на сервере**.

## Что сделано

### Библиотеки
| Файл | Что | Откуда |
|---|---|---|
| `src/lib/articles/queries.ts` | Общие выборки: `sitesFunnel` (воронка по сайтам одним `groupBy`), `funnelBucket`/`FUNNEL_COLUMNS`, `workerState` (RUNNING с живым lease), `errorsLastHour`, `moderationCounts`, `articlesInWork` (живая доска/API), `queuePage` (пагинация + фильтры `STATUS_FILTER_GROUPS`), `runArticles`, `siteRuns`, `runProgress`, `siteStats` (по дням за 30 дн., средняя стоимость, ошибки по сигнатуре), `articleUsage` | Dashboard/ArticleQueuePanel оригинала (отчёт 05 §3.2–3.3), агрегаты на сервере |
| `src/lib/articles/launch.ts` | `recipeShape`, `buildSnapshot` (рецепт + `run{photoReview, publishMode, yearInUrlPercent, testLabel}`, переопределения `photoSearch`), `userSlots`/`missingSlotsFor`/`recipeReadiness` (есть ли промты всех `promptKeys` этапов формата и правила слотов), `findDuplicateKeywords`, `launchArticles` (ArtRun + `createMany` статей пачками по 50; дубликаты по сайту и повторы в списке пропускаются и возвращаются) | `enqueue`/`article-queue` оригинала (отчёт 04 §2), решения 08-plan §1 |
| `src/lib/articles/keywords.ts` | Чистый парсер списка ключей `ключ | seo | focus | count` (табы/«;»/CSV), `innerDuplicates`; реэкспорт `sanitizeTopic` из `text/textGuards` — общий для браузера и сервера | — |

### Server actions — `src/actions/articles.ts`
`enableArticlesForSite` (ArtSite из SiteAccess, `DEFAULT_SITE_SETTINGS`, проверка галочки «Статьи»), `saveArtSiteSettings` (все поля `ArtSiteSettings` + имя/ниша/рецепт по умолчанию), `toggleArtSiteActive`, `syncSiteCategories` (→ `wp/categories.syncCategories(siteId, creds)` с понятной ошибкой), `launchArticlesAction` (→ redirect на карточку запуска, пропущенные дубликаты через `?skipped=`), `checkKeywordDuplicates(siteId, keywords)` (вызывается из клиента напрямую), `retryArticleAction` (с выбранного этапа; по умолчанию этап ошибки/текущий), `stopArticleAction` (RUNNING → `stopRequested`; PENDING/PUBLISH_QUEUED → STOPPED), `requeueArticleAction`, `deleteArticleAction` (+ `purgeArticleFiles`), `bulkArticlesAction(ids, op)`, `saveArticleMeta`, `saveSectionHtml`. Доступ — `canAccessArtSite`/`canAccessArticle`.

### Компоненты `src/components/articles/`
`ArticlesNav` (пилюли, ссылки на модерацию/публикации/рецепты/журнал — страницы соседа), `StatusBadge` (+`StageLogBadge`, `badgeTone`), `SiteFunnel` (+`FunnelLegend`; клик → очередь с фильтром), `ArticlesBoard` (+`WorkerPill`, опрос `/api/articles/overview` раз в 10 с, «Ошибок за час»), `ArticlesTable` (отметки, массовые действия, удаление с подтверждением в строке, адаптивные колонки), `ArticleTimeline` (ArtStageLog), `KeywordsInput` (разбор, ошибки строк, повторы, дубликаты по сайту списком, галочка «не запускать дубликаты», скрытое поле `keywords` JSON), `NewArticlesRunForm` (4 шага; готовность рецепта с ссылками «исправить»), `RunParamsFields` (общие поля фото/модерация/публикация/поиск/год — и в настройках сайта, и в запуске), `SiteSettingsForm` (группы: основное, по умолчанию для запусков, категории WP с правилами, автозапуск, ИИ-модерация, прочее).

### Страницы `src/app/(app)/pinterest/articles/`
`layout.tsx`, `page.tsx` (Обзор), `sites/page.tsx` (+ «Подключить сайт»), `sites/[id]/page.tsx?tab=queue|settings|stats`, `runs/new/page.tsx`, `runs/[id]/page.tsx`, `articles/[id]/page.tsx?tab=photos|text|publish|log`. API: `src/app/api/articles/overview/route.ts`.

### Подключение к системе
`src/app/(app)/sites/[id]/page.tsx`: вторая строка «Статьи» в карточке «Инструменты» (Включить / Открыть настройки, разрешение — `projects` пуст или содержит `articles`), строка в «Состоянии», кнопка «Открыть в Статьях». Главная (`/`) показывает инструмент из `Project` (seed, url `/pinterest/articles`) — правок не потребовалось.

## Что упрощено / решения
- Воронка строится из `groupBy(siteId, status, stage)`; RUNNING делится по фазе этапа (`phaseOf`). «Опубликовано за 24 ч» — по `publishedAt`.
- «Воркер работает» = есть RUNNING с `leaseUntil > now`; «не отвечает» = RUNNING есть, живых lease нет. Отдельного heartbeat воркера нет.
- Массовые действия — через нативные `name="ids"`/`name="op"` в одной `ActionForm`; без `window.confirm` (подтверждение удаления — в строке / `<details>`).
- `retryArticle` для статьи в `done` по умолчанию ставит этап `publish`; для ожидающих статусов — текущий `stage` (уже следующий этап, как пишет раннер).
- Дубликат ключа = статья того же сайта не в FAILED/STOPPED с тем же `keyword` (после `sanitizeTopic`).
- Стоимость показывается всем (права `costs` в портале нет).

## Не сделано / открытые вопросы
- Нет drag-порядка сайтов (`sortOrder` используется только для сортировки).
- Статистика сайта без «времени цикла» и без разбивки по сотрудникам (волна 2).
- Карточка статьи: вкладка «Фото» только просмотр (правки — в модерации фото соседа); лайтбокса нет, оригинал открывается ссылкой.
- `KeywordsInput` без импорта из Google Таблиц (поле `sheetUrl` только хранится).
- Ссылки `moderation/photos?article=`, `moderation/articles?article=`, `/recipes/[id]`, `/journal` ведут на страницы соседа — согласовать параметры запроса.
- Модель `SiteAccess` без relation `team` — имена команд берутся отдельным запросом.
- Проверить на сервере: `satisfies Prisma.ArticleSelect` в `queries.ts`, `createMany` с JSON-полями, narrowing `c.key` в `SiteFunnel`.

## Экспорты для других исполнителей
`queries.ts`: `ArticleRowData`, `queuePage`, `STATUS_FILTER_GROUPS`, `statusesForFilter`, `articlesInWork`, `runProgress`. `launch.ts`: `recipeShape`, `buildSnapshot`, `recipeReadiness`, `userSlots`. Компоненты: `StatusBadge`, `ArticlesTable`, `ArticleTimeline`, `SiteFunnel`, `WorkerPill`. Actions: `retryArticleAction`, `bulkArticlesAction` (op: retry|stop|requeue|delete).
