# Состояние переноса (читать первым при продолжении)

## Обновление 2026-10-11, вечер — Google Таблицы (задеплоено в 16:35 UTC, ждёт ключа сервисного аккаунта)
- Перенесён `sheets-sync`: `src/lib/articles/sheets.ts` — Google Sheets API напрямую под сервисным аккаунтом (JSON-ключ зашифрован в `ArtSettings.sheetsKeyEnc`, e-mail в `sheetsEmail`; шлюза Lovable больше нет). Правила оригинала сохранены: вкладка = домен сайта, колонки по заголовкам, в работу — строки без «Статуса» и Publish URL, рецепт по номеру в «Сценарий» (`ArtRecipe.number`), режим из «Режим» (2 → `photoReview`), без сценария/режима строка не берётся; «Год в URL», «Гео», «Язык», «Свежесть» переопределяют параметры запуска.
- Импорт: шаг «Ключи» нового запуска, переключатель «Вставить списком / Из Google Таблицы» (`components/articles/SheetImport.tsx` → `previewSheetImport`); запуск `launchArticlesAction` с `source=sheet` читает вкладку заново, ставит статьи (`KeywordInput` с переопределениями строки, `Article.sheetRow/sheetTab`, `ArtRunSettings.sheet`), отмечает строки «в работе».
- Отчёт: этап `publish` воркера пишет ссылку, дату (`SHEETS_TZ`, по умолчанию Europe/Kyiv) и статус «черновик»/«опубликовано» (`writeArticleResult` → `Article.sheetSyncState/sheetSyncError`); падение статьи → «ошибка» (`runner.fail`, `requeueStaleArticles`); несохранённое досылает `resyncSheets` из `worker/cron.ts` раз в 5 минут (7 дней).
- Настройка: карточка «Google Таблицы» в настройках сайта (`components/articles/SheetsCard.tsx`): ключ аккаунта (только админ, общий на все сайты), шаги для таблицы сайта, «Проверить таблицу», список колонок.
- Проверено в `/root/zewex-check`: tsc ×2, next build, прогон библиотеки на подставной таблице (план импорта, отметка, запись отчёта, ошибки). На настоящей таблице не проверялось — нужен ключ сервисного аккаунта от владельца.
- Отличия от оригинала: колонку «Статус» создаёт отметка после импорта, а не чтение; дубли ключей по сайту и повторы в таблице пропускаются с причиной; дата в отчёте — по Киеву, а не UTC.

## Обновление 2026-10-11, 15:54 — задеплоено
- Деплой владельцем прошёл: таблицы ИИ-модерации и ArtSettings созданы, 8 профилей ниш (добавлены tattoo/makeup), воркер стартовал с циклом статей и циклом ИИ-модерации, страницы /pinterest/articles/automation и /moderation/ai отвечают.
- Следующее: владелец включает ИИ-проверку у тестового сайта на экране «Автозапуск», запускает 2–3 ключа, проверяем решения ИИ. Дальше по плану: Telegram, Google Sheets, статистика сотрудников, формат generated_photo.

## Обновление 2026-10-11 (утро)
- Статья «short hairstyles» одобрена владельцем и прошла до конца: опубликована https://beautydaily.com.ua/short-hairstyles-for-women (10 секций, 1169 слов, $0.029 всего). Таймлайн этапов без ошибок.
- Исправлено: проверка качества перед публикацией придумывала заголовок вступлению (позиция 0) — теперь вступление/заключение пропускаются (`src/lib/articles/wp/qualityCheck.ts`).
- Экран «Автозапуск сайтов» проверен на сервере: tsc и next build проходят; ждёт деплоя вместе с ИИ-модерацией.
- ИИ-модерация: исполнитель запущен повторно по брифу ниже.

# Состояние на конец дня 2026-10-10

## Что на боевом сервере (задеплоено 19:39)
- Вся цепочка real_photo (13 этапов), UI волны 1, seed промтов/рецептов. Первая статья «short hairstyles» прошла поиск → фильтр → сравнение → оценка → отбор ($0.017) и стоит в PHOTO_REVIEW, ждёт одобрения владельцем.
- Исправлено после деплоя: права на `storage/` (chown на zewex_tools_usr) — локально это добавлено в `deploy/deploy.sh`, на сервере сделано вручную.

## Что в рабочей папке, но НЕ задеплоено (сборка на сервере не проверялась — пропал интернет)
1. `prisma/schema.prisma`: новые модели `ArtSettings` (singleton "main"), `ArtAiModerationRun`, `ArtAiModerationResult`, поле `Article.aiRunId`, relation `ArtSite.aiRuns`. Требует `prisma db push` (внутри deploy.sh).
2. `prisma/seed-data/articles/config.json`: ниши `tattoo`, `makeup` (неактивные), чтобы их профили сидились.
3. Экран «Автозапуск сайтов» — готов полностью (исполнитель закончил, отчёт `progress/automation.md`): `src/lib/articles/automation.ts`, `src/app/api/articles/automation/route.ts`, `src/components/articles/AutomationTable.tsx`, `src/app/(app)/pinterest/articles/automation/page.tsx`, `worker/articles/autostart.ts` (`autostartTick`), правки `worker/articles/queue.ts` (мастер-выключатели, maxConcurrent, round-robin), `src/lib/articles/types.ts` (поля `*OffReason/*IdleSince` в autostart), пункт «Автозапуск» в `ArticlesNav`. `autostartTick` подключён в `worker/cron.ts` (раз в минуту).
4. ИИ-модерация фото — **НЕ написана** (исполнитель упал на старте из-за обрыва сети; файлов нет). Схема под неё уже есть (п.1).

## Следующие шаги (по порядку)
1. Проверка на сервере: `rsync` рабочей папки в `/root/zewex-check`, `npx prisma generate`, `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.worker.json`, `npx next build` (команда — как в сессии 2026-10-10: rsync с исключениями node_modules/.next/.env/.git/storage). Ожидаемые места ошибок по отчёту automation.md: `prisma.artSettings`, `satisfies`, `Prisma.TransactionClient` в queue.ts.
2. Деплой владельцем `./deploy/deploy.sh` (Claude запускать не может — классификатор запрещает production deploy).
3. ИИ-модерация: запустить одного исполнителя с брифом ниже.
4. После деплоя: владелец одобряет статью «short hairstyles» в модерации фото → текстовая цепочка → публикация; проверить журнал этапов.

## Бриф для исполнителя «ИИ-модерация фото» (переиспользовать дословно)
Читать: `progress/README.md`, `04-orchestration-publish.md` §5 и §2.3, `05-data-and-ui.md` (AiModerationPage, §7 экран 8), `progress/ui-moderation.md`, `progress/automation.md` (диагностика ждёт `ArtAiModerationRun.status="running"` и `Article.aiRunId`). Исходник: `scratchpad/mig/supabase/functions/ai-photo-moderate/index.ts` (mix3 + промты sysA/sysB/sysC/V2_REASONS/focusRules дословно), UI `scratchpad/mig/src/pages/AiModerationPage.tsx`.
Схема: `ArtAiModerationRun` (mode auto|test, model, concurrency, status running|stopped|done|failed, source auto|manual, total/processed/applied, costUsd, heartbeatAt), `ArtAiModerationResult` (status processing|proposed|applying|applied|sent_to_human|excluded|failed|superseded, decision approve|human|insufficient, confidence, photosBefore/After, originalIds, removed, added, finalOrder, review, summary, error, costUsd, resolvedById; unique(runId, articleId)), `Article.aiRunId`, `ArtSettings.aiModMaster/aiModAutoBatch`, `ArtSite.settings.aiModeration {enabled, batchFrom, concurrency, backlogThreshold, autoApply}`. Эталонов нет.
Помощники: `src/lib/articles/moderation.ts` (excludePhoto, addFromReserve, reorderPhotos, approvePhotos, markInsufficient, returnToReview, requestTopup, photoState — добавить вариант с актором `{userId: null, byAi: true}`), `aiChat` слот `vision` с моделями `openrouter:google/gemini-2.5-flash-lite` (lite) и `openrouter:google/gemini-3-flash-preview` (flash), json, temperature 0.1; миниатюры `absPath(thumbPath)` через sharp ≤512 px.
Файлы: `src/lib/articles/aiModeration.ts` (startAiRun, stopAiRun, reviewArticle mix3 с вердиктом из фактов §5.3, applyResult approve|human|insufficient|exclude, rerunArticle, resolveResult, aiAutostartTick — пачка batchFrom, неполная через 30 мин, не стартовать при running-запуске сайта или бэклоге ≥ порога, aiRunsOverview), `worker/articles/aiModeration.ts` (`aiModerationLoop(workerId, shouldStop)`, `aiModerationInflight()`: каждые 20 с запуски running, heartbeat, пул concurrency, атомарная вставка результата processing, в auto применять proposed: op = confidence<75 ? human : decision; autoApply=false → оставлять proposed; processing >6 мин удалять, applying с heartbeat >3 мин → proposed; done когда нет processing/applying; раз в минуту aiAutostartTick), `src/actions/articlesAi.ts`, `src/app/(app)/pinterest/articles/moderation/ai/page.tsx` + `src/components/articles/AiModerationPanel.tsx` + `src/app/api/articles/ai/route.ts` (форма запуска, таблица запусков, решения с фильтрами и массовыми действиями, диалог «итог/удалено/добавлено» с миниатюрами, вкладка «Мало фото»: добрать/на модерацию/закрыть), пункт «ИИ-модерация» в `ArticlesNav` после «Модерация фото». Подключение `aiModerationLoop` в `worker/index.ts` — делает координатор.

## Параллельные сессии в том же дереве
«домены», «API ключи и права команды» (коммит 17a3b90), «система». Ничего из статей не закоммичено (ветка add-claude-md, рабочая папка).


## Хронология правок после аудита (полная, для продолжения в новой сессии)

### 2026-10-10
1. Аудит: 7 параллельных отчётов `01–07*.md`, сводка `00-overview.md`, план `08-plan.md` (решения, что выбрасываем, 11 исправлений при переносе, экраны волны 1).
2. Экспорт данных: `prompts.export.json`, `config.export.json` → seed `prisma/seed-data/articles/{prompts,config}.json` (8 наборов, 55 промтов, 8 рецептов, 9 ниш, 8 профилей; старые UUID). В данных исправлено: `{{section_brief}}`→`{{section_briefs}}` (одежда-real writer_user), `min_width/min_height` 450→550, `stage_5_1`→`image_prompt_writer`, `stage_2` убран из real-рецептов.
3. Фундамент: модели `Art*`/`Article` в `prisma/schema.prisma`; `prisma/seed.mjs` — проект `articles`, 6 слотов (`text_main`, `text_fast`, `vision`, `image_main`, `photo_dfs`, `photo_serp`), сид данных (идемпотентно, промты без версий обновляются); `src/lib/run.ts` — `runSlot` принимает `model: "provider:model"` (`parseModelSpec`); `src/lib/articles/{types,stages,labels,prompts,ai,access,storage}.ts`; `worker/articles/{queue,runner,journal,index}.ts`, `worker/articles/stages/index.ts` (контракт `ArtStageCtx`/`ArtStageResult`); регистрация в `worker/index.ts`, `worker/cron.ts`.
4. Перенос 6 исполнителями (отчёты `progress/photo-search-filter.md`, `photo-rate-select.md`, `text-chain.md`, `publish.md`, `ui-core.md`, `ui-moderation.md`): `src/lib/articles/photo/*` (profile, contracts, audience, keyword, queries, search, download, vision, relevance, authenticity, diversity, ranking, fingerprints, caption), `src/lib/articles/text/*` (textGuards, introOutroParse, countToken, jsonRepair, photoDescribe, slug, html, vars), `src/lib/articles/wp/*` (posts, categories, qualityCheck, publish, cleanup, test), `worker/articles/stages/*` (13 этапов), `src/lib/articles/{launch,queries,keywords,moderation,recipes}.ts`, `src/actions/{articles,articlesModeration,articlesRecipes}.ts`, страницы `src/app/(app)/pinterest/articles/*`, компоненты `src/components/articles/*`, API `src/app/api/articles/*`, строка «Статьи» в `src/app/(app)/sites/[id]/page.tsx`.
5. Правки при сводке: `worker/articles/runner.ts` — `releaseArticle(..., summary ?? undefined)`; учёт `cursor.reviewApproved` после `assemble` (повторной модерации статьи нет); `journal.ts` принимает `null`; карточка статьи — лишняя `)` в JSX; `src/actions/articles.ts` — `syncCategories(siteId, creds)`; `worker/cron.ts` — `purgePublishedBacklog` каждые 30 мин, `purgeOldArticles` раз в сутки.
6. Проверка на сервере `/root/zewex-check` (rsync без node_modules/.next/.env/.git/storage → `prisma generate` → `tsc` ×2 → `next build`): чисто. Деплой владельцем 19:39 (Claude запускать deploy.sh не может — классификатор разрешений).
7. После деплоя: первая статья упала на `filter` — `EACCES mkdir storage/articles` (папка `storage/` принадлежала root). Исправлено: `chown -R zewex_tools_usr storage` на сервере, в `deploy/deploy.sh` добавлено создание `storage/articles` с владельцем. Статья возвращена в очередь, прошла фото-цепочку ($0.017), встала в PHOTO_REVIEW.
8. `prisma/seed-data/articles/config.json`: добавлены неактивные ниши `tattoo`, `makeup` (их профили пропускались, нет FK-ниши); `seed.mjs` пропускает профили без ниши с предупреждением.
9. Вечером владелец попросил сразу ИИ-модерацию и экран «Автозапуск сайтов» (как в оригинале). Добавлены модели `ArtSettings` (singleton "main": мастер-выключатели, maxConcurrent, aiModAutoBatch), `ArtAiModerationRun`, `ArtAiModerationResult`, `Article.aiRunId`. Экран автозапуска написан (`progress/automation.md`): `src/lib/articles/automation.ts`, `api/articles/automation`, `AutomationTable.tsx`, страница `automation`, `worker/articles/autostart.ts` (`autostartTick`: auto-restart + idle-off 15 мин, `*OffReason/*IdleSince` в `ArtSiteSettings.autostart`), `queue.ts` — мастер-выключатели, `maxConcurrent`, round-robin по сайтам. Исполнитель ИИ-модерации упал из-за обрыва сети у владельца — ничего не записал.

### 2026-10-11
10. Статья «short hairstyles» одобрена владельцем ночью и дошла до конца: опубликована https://beautydaily.com.ua/short-hairstyles-for-women (10 секций, 1169 слов, 10/10 фото в медиатеке, $0.029). Все этапы без ошибок.
11. Исправлено: `src/lib/articles/wp/qualityCheck.ts` придумывал заголовок вступлению (позиция 0) — вступление/заключение пропускаются в проверке заголовков.
12. ИИ-модерация перенесена повторно запущенным исполнителем (`progress/ai-moderation.md`): `src/lib/articles/aiModeration.ts` (mix3, промты дословно, вердикт из фактов, автозапуск пачками), `worker/articles/aiModeration.ts` (`aiModerationLoop`, `aiModerationInflight`, `aiModerationStats`; `aiAutostartTick` внутри цикла), `src/actions/articlesAi.ts`, `api/articles/ai`, страница `moderation/ai` + `AiModerationPanel.tsx`, пункт в `ArticlesNav`. Подключено в `worker/index.ts`, `autostartTick` — в `worker/cron.ts`.
13. Проверка на сервере чисто; деплой владельцем 15:54: таблицы созданы, 8 профилей ниш, воркер стартовал с циклом ИИ-модерации, страницы отвечают.

### Известные открытые вопросы (из отчётов исполнителей)
- Лимиты на экране «Автозапуск» 1..50, а `saveArtSiteSettings` формы сайта режет 1..20; форма сайта при сохранении теряет служебные `*OffReason/*IdleSince` (некритично).
- `parseKeywordAi` (ИИ-разметка ключа) написан, но в `search` не вызывается — контракты строятся по словарю.
- `ArtPhotoCandidate.searchQuery` VARCHAR(191): длинные запросы с `site:` режутся и не кэшируются.
- `recipe.photoSearch.source` только `dataforseo|serpapi` (`both` оригинала → dataforseo).
- Вызов mix2/legacy/compare ИИ-модерации, weserv-превью и эталоны не перенесены.
- Не перенесено (волна 2–3): Telegram, статистика сотрудников, экран очистки, формат generated_photo (stage 2→5→6, визуальные промты ~0,6 МБ + 255 референсов в старом Storage — выкачать до отключения Lovable).
- Idle auto-off в воркере реализован ради совместимости; реальной нагрузки без него нет.
- Ветка `add-claude-md`, ничего из статей не закоммичено; рядом работали сессии «домены», «API ключи и права команды» (коммит 17a3b90), «система».
