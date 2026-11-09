# Зона «Публикация в WordPress» — этап `publish` (78), категории, качество, очистка

Статус: код написан, типы на этой машине не проверены (нет Node) — прогнать `npx tsc --noEmit -p tsconfig.worker.json` на сервере.

## Что перенесено (файл → исходник)

| Наш файл | Исходник | Содержание |
|---|---|---|
| `src/lib/articles/wp/posts.ts` | `stage7-publish-wordpress/index.ts:355-404, 294-304, 583-604`; `test-wp-connection:64-72` | `findPostBySlug` (варианты slug: сам, `-2…-4`, с годом/без; `status=any` → откат к списку статусов при 400; вариант с суффиксом принимается только при совпадении заголовка), `createPost` (одна попытка — повтор мог бы создать дубль), `updatePost` (2 повтора, идемпотентно), `setMediaMeta`, `findMediaBySlug` (поиск уже загруженного файла по маркеру id фото в имени), `deleteMedia`, `fetchMe`, `parseWpError` (с подсказками CDN). Транспорт — копия приватного `wpRequest` из `pins/wp/client.ts` (fetch + Basic + AbortSignal + `assertPublicUrl`), таймаут записи 90 с. |
| `src/lib/articles/wp/categories.ts` | `_shared/wpCategories.ts`, `resolve-wp-category`, `sync-wp-categories` | `fetchCategories` (100/стр., ≤20 стр., 15 с), `syncCategories(siteId, creds)` → `ArtSite.wpCategories`, `matchCategoryRules` (подстроки через `, ; \n`), `resolveCategory(ctx, {keyword, title})`: правила `settings.categories.rules [{pattern, categoryId}]` → ИИ (`aiChat`, слот `text_fast`, JSON `{id}`, temp 0, 40 токенов, 20 с; ≤200 категорий) если `useAi` → `defaultId` → первая из кэша (предпочтительно `uncategorized`) → `null` (WP поставит свою). Пустой кэш дозаполняется с сайта. `applyCategoryToPost`. |
| `src/lib/articles/wp/qualityCheck.ts` | `_shared/qualityCheck.ts` | `checkArticleQuality(article, sections, photos)` → `{ok, problems, fixed, patch}`. Проверки: фото доступны (локальный файл = живое; иначе HEAD/GET, 429/5xx не считаются «пропавшим»), маленькие (<320×480), дубли по sha256 и URL, одно фото в двух секциях; секции: нет текста, <40 слов, «размышления модели», fact-dump, пустые/повторные H2; вступление/заключение (≥25 слов), объём ≥700, разделов ≥5; мета непустая; `{{COUNT}}`; выделения. **Чиним сами**: пустые h1/title/description/slug из плана или ключа, `{{COUNT}}` → число фото, повторные/пустые H2 через `uniqueHeading` (и правка `<h2>` в HTML), `stripEmphasis` в секциях и HTML. Патч применяет `publish.ts`. |
| `src/lib/articles/wp/publish.ts` | `stage7-publish-wordpress/index.ts` | `publishArticle(ctx)`: качество → slug фиксируется в базе → категория (`Article.wpCategoryId` кэш) → фото: для каждого без `wpMediaId` при повторе сначала `findMediaBySlug` по маркеру, иначе `toWpJpeg` → `uploadMedia` (имя `<slug≤60>-<pos>-<photoId8>.jpg`, alt/title/caption, 2 параллельно, таймаут 90 с, 1 повтор), `wpMediaId/wpUrl/fileName` сразу после ответа, `ctx.tick` после каждого; ошибка одного фото → публичная ссылка остаётся (как оригинал), 4 подряд 5xx при нуле загруженных → `MediaDownError`; ни одного фото на сайте → WpError 503 (повтор). HTML: `publicUrl → wpUrl`, сохраняется. Запись: `findPostBySlug` **до** создания (найдена → `wpPostId` пишется сразу, затем `updatePost`; 404 при обновлении → создаём заново) → `createPost`; `wpPostId/wpUrl/wpStatus/slug(из ответа)/publishedAt` сразу после ответа; `featured_media` = первое фото с медиа; `excerpt` = metaDescription; Yoast meta. Статус: `recipe.run.publishMode === "moderate_first"` и статья не одобрена (`reviewedAt` пуст) → `draft`, иначе `publish`. Событие `ArtModerationEvent action=publish`. |
| `src/lib/articles/wp/cleanup.ts` | `_shared/cleanupPublishedPhotos.ts`, `cleanup-published-*` | `purgePublishedPhotos(articleId, {force})` (все живые фото с `wpUrl` → удалить файлы статьи, `publicUrl=wpUrl`, пути пустые у фото и кандидатов, `purgedAt`), `purgePublishedBacklog(limit)` для cron, `purgeOldArticles(days=1, limit=200)` — удаление COMPLETED + `wpStatus=publish` + `wpPostId/wpUrl` + без ошибки + `publishedAt < cutoff`; каскадом уходят фото/секции/кандидаты/журнал; **`ArtPhotoFingerprint` и `UsageLog` не трогаем**. |
| `src/lib/articles/wp/test.ts` | `test-wp-connection/index.ts` | `testArticleSiteConnection(creds, {mediaTest})`: `/users/me?context=edit` (имя, роли, `upload_files`), при `mediaTest` — PNG 1×1 в медиатеку и `DELETE ?force=true`. |
| `worker/articles/stages/publish.ts` | `publish-worker/index.ts:8-24, 258-320` | `export const publish: ArtStageHandler`. Качество / нет доступа WP / 401, 403, 413, прочие 4xx → `fatal`; 5xx, 429, 408, таймаут, сеть → `publishAttempts++`, `retryInMs` 1/3/5/10/15 мин, после 6 → `fatal`; `MediaDownError` → повтор через 20 мин без списания попытки. Успех → `summary` со ссылкой, `details` (id, url, статус, загружено/найдено/ошибок, категория, починка, purged), затем `purgePublishedPhotos(..., {force: true})` если все фото на сайте. |

## Что упрощено / изменено осознанно
- Нет фазы `prepare`, `PARTIAL_UPLOAD`, бюджетов 45/75 с, второго базового адреса www/без-www, самовызовов и sheets-sync (таблицы — отдельная зона).
- Сжатие — `toWpJpeg` (sharp, JPEG 90, ≤1600) вместо Storage render / weserv.
- Проверка качества не удаляет секции и фото молча (08-plan §3 п.8): битые фото, короткие секции, «размышления модели» → `problems` → `fatal` с перечнем. Авто-починка оригинала через повторные вызовы stage77/stage7-write-sections не воспроизводится (нужны этапы соседа) — только детерминированные правки. Длины title/description и «ключ в тайтле» не проверяются (у оригинала это блокировало публикацию ради перегенерации меты).
- `createPost` без повторов; защита от дублей — `findPostBySlug` перед созданием + `wpPostId` сразу после ответа (аудит 04 §10 п.3). Ошибка поиска по slug больше не глушится (этап повторит позже).
- Переиспользование медиа по маркеру в имени файла реализовано (оригинал обещал в документации, в коде не было).
- `uploadMedia` общего клиента сам ставит alt/title/caption; `setMediaMeta` экспортирован отдельно (для будущих правок подписей).
- Категория без ИИ-ключа: ошибка ИИ не фатальна — идём к категории по умолчанию.

## Не перенесено и почему
- `apply-review-exclusions` (перенумерация секций и пересборка после исключения фото) — это зона сборки/модерации; publish просто не включает секции, чьё фото `excluded`.
- `sheets-sync write`, telegram — отдельные зоны.
- Лимит одновременных публикаций на сайт — в `claimArticle` (фаза `publish`, `settings.autostart.publishLimit`), не здесь.

## Конвенции для соседей / открытые вопросы
1. **Одобрение черновика (moderate_first).** Статус записи: `draft`, если `recipe.run.publishMode === "moderate_first"` и `Article.reviewedAt` пуст. Действие «одобрить статью» в модерации должно ставить `reviewedAt/reviewedById` и возвращать статью на этап: `status=PENDING, stage="publish"` — тогда повтор `publish` переведёт запись в `publish` без дубля. При `photoReview=false` (REVIEW_PENDING до публикации) одобрение уже стоит → публикуется сразу (как в оригинале с `approve:true`).
2. **Cron (подключает автор раннера):** `purgePublishedBacklog()` раз в ~15 мин, `purgeOldArticles(1)` раз в сутки — экспорты из `@/lib/articles/wp/cleanup`.
3. **После очистки** `ArtPhoto.thumbPath` пуст, `publicUrl = wpUrl` — UI должен показывать `publicUrl`, если миниатюры нет.
4. **Секции и исключённые фото:** publish считает живыми секции, чьё `photoId` не указывает на `excluded` фото; сборка (`assemble`) должна исключать такие секции из `Article.html` сама.
5. Импорты из `@/lib/articles/text/textGuards`: `headingKey`, `looksLikeFactDump`, `stripEmphasis`, `uniqueHeading(heading, used: Set<string>, {facts?, description?})` — имена и сигнатуры оригинала.
6. `Prisma.InputJsonValue` для `wpCategories` и payload события; `ArtSite.wpCategories` обновляется в памяти после синхронизации.
7. Повтор `findPostBySlug` с вариантом `-2…-4`/год принимается только при совпадении заголовка — иначе есть риск перезаписать чужую запись с похожим адресом.

## Экспорты для других
- `@/lib/articles/wp/posts`: `findPostBySlug`, `createPost`, `updatePost`, `setMediaMeta`, `findMediaBySlug`, `deleteMedia`, `fetchMe`, `parseWpError`, `slugVariants`, типы `WpPostInput`, `WpPostResult`, `WpFoundPost`.
- `@/lib/articles/wp/categories`: `syncCategories`, `fetchCategories`, `resolveCategory`, `matchCategoryRules`, `cachedCategories`, `applyCategoryToPost`, типы `WpCategory`, `CategoryResolution`, `CategoryRule`.
- `@/lib/articles/wp/qualityCheck`: `checkArticleQuality`, `urlAlive`, `wordCount`, константы `MIN_SECTION_WORDS`, `MIN_ARTICLE_WORDS`, `MIN_SECTIONS`.
- `@/lib/articles/wp/publish`: `publishArticle`, `QualityError`, `MediaDownError`, `mediaFilename`, `UPLOAD_CONCURRENCY`, тип `PublishCtx`, `PublishOutcome`.
- `@/lib/articles/wp/cleanup`: `purgePublishedPhotos`, `purgePublishedBacklog`, `purgeOldArticles`.
- `@/lib/articles/wp/test`: `testArticleSiteConnection` (для кнопки «Проверить» на странице сайта сервиса).
- `worker/articles/stages/publish`: `publish`, `MAX_PUBLISH_ATTEMPTS`, `PUBLISH_BACKOFF_MIN`.
