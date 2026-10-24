# ИИ-модерация фото (шаг 140 «ИИ публикация статей»)

Исполнитель: ai-moderation. Статус: написано полностью, типы не проверялись (на Mac нет Node) — **первым делом `npx tsc --noEmit` и `npx tsc -p tsconfig.worker.json` на сервере в `/root/zewex-check`**. Ничего не коммичено и не деплоено.

## Что сделано (файл → исходник)

| Файл | Что | Исходник |
|---|---|---|
| `src/lib/articles/aiModeration.ts` | Вся логика: константы (`AI_MOD_MODELS`, `AUTO_CONFIDENCE=75`, `RESERVE_KEEP=25/RESERVE_REJECT=15/MAX_ADDS=12`, `HARD_REJECT`, `STALE_PROCESSING_MS=6 мин`, `STALE_APPLYING_MS=3 мин`, `AUTO_WAIT_MS=30 мин`), типы JSON-полей результата, действия пользователя `startAiRun / stopAiRun / resolveResult / rerunArticles / insufficientAction`, автозапуск `aiAutostartTick`, служебные операции запуска для воркера (`runningRuns, heartbeatRun, watchdogRun, claimNextForRun, refreshRun, finishRunIfIdle, runAutoApplies, autoOpFor, autoApplyProposed, releaseUnprocessed, undecidedArticleIds`), применение `applyResult`, правила `focusRules`, промты mix3 (`V2_REASONS`, sysA/sysM/sysF дословно с `// оригинал: …:NNN`), проверка статьи `reviewArticle` (mix3 + правило согласия + вердикт из фактов), данные экрана `aiRunsOverview` | `ai-photo-moderate/index.ts` (start :113-143, stop :166-172, resolve :174-190 + :646-702, rerun :192-213, insufficient_action :215-239, watchdog/autostart :48-104, processNext :281-334, focusRules :336-370, reviewArticle :372-633, mixV3 :831-934, undecided :936-950, runPool :952-957) |
| `worker/articles/aiModeration.ts` | Цикл воркера: каждые 20 с по запускам `running` — heartbeat, сторож, авто-применение proposed (режим auto + autoApply сайта), пул статей размером `concurrency` (атомарная вставка результата processing), завершение запуска; раз в минуту `aiAutostartTick`. Учёт параллельности в памяти (`perRun`, `busyArticles`, `busyResults`) | sleep-then-chain `process` + `watchdog` оригинала |
| `src/actions/articlesAi.ts` | Server actions для форм: `startAiRunAction, stopAiRunAction, resolveAiResultAction, rerunAiResultsAction, insufficientAiAction` (FormState как у соседей) | — |
| `src/app/api/articles/ai/route.ts` | GET — `AiOverview`; POST `{action: start\|stop\|resolve\|rerun\|insufficient}`. Ошибки-сообщения (`AiModerationError` со status 200, напр. «нет свободных статей») — `{error}` без HTTP-ошибки | actions оригинала |
| `src/app/(app)/pinterest/articles/moderation/ai/page.tsx` | Серверная страница с первичными данными | — |
| `src/components/articles/AiModerationPanel.tsx` | Клиентский экран: вкладки «Результаты» / «Мало фото»; карточка «Новый запуск» (сайт с числом ожидающих, 10/50/200/Все/число, Тест/Авто, оценка $0.03–0.08×N, предупреждение, если у сайта выключено autoApply); «Запуски» (8 последних, Стоп, «воркер молчит» при heartbeat > 3 мин); фильтры решение/статус/запуск/сайт; сводка; массовые действия над отмеченными proposed (Одобрить / Отправить человеку / Мало фото / Исключить / Перепроверить, по одной за запрос); таблица; диалог решения (summary, бейджи оценок, «Итоговая подборка» с R-пометками, «Удалено» с причинами, «Добавлено из резерва», снятые замечания, кнопки); «Мало фото»: сводки по дням (ИИ/люди), сайтам, кто отметил; таблица с Добрать фото / На модерацию / Закрыть (двухшаговое подтверждение). Автообновление 8 с при бегущем запуске, иначе 30 с | `src/pages/AiModerationPage.tsx` |
| `src/components/articles/ArticlesNav.tsx` | Пункт «ИИ-модерация» после «Модерация фото» | — |

`src/lib/articles/moderation.ts` **не трогал**: вариант с ИИ-актором там уже был (`Actor = CurrentUser | AiActor`, `aiActor(userId)`, `isAi/actorId`, `closeArticle`); все функции фото принимают `Actor`, события пишутся с `byAi=true`.

## Экспорты `worker/articles/aiModeration.ts` (подключает координатор в `worker/index.ts`)
- `aiModerationLoop(workerId: string, shouldStop: () => boolean): Promise<void>` — запускать рядом с `articlesLoop`; внутри уже вызывается `aiAutostartTick` раз в минуту — **в `worker/cron.ts` его добавлять не нужно**.
- `aiModerationInflight(): Set<Promise<void>>` — добавить в `Promise.allSettled([...])` при остановке (как `articlesInflight()`).
- `aiModerationStats(): { inflight: number; runs: Record<string, number> }` — для логов/диагностики.

## Как устроено (решения)
- **Состав запуска** — `Article.aiRunId = run.id` (у `ArtAiModerationRun` нет массива queue_ids). Статья с `aiRunId` недоступна сотрудникам (`claimArticle`/`nextForReview` уже это учитывают). Захват снимается: при `excluded`/`sent_to_human`/`failed` (ИИ отдаёт людям), при `approvePhotos`/`markInsufficient`/`requestTopup` (они ставят `aiRunId: null`), при `stopAiRun` — только с непроверенных (как `releaseUnprocessed` оригинала). Предложение в режиме «Тест» держит статью до решения человека (оригинал: claim на 30 дней).
- **Следующая статья** — `claimNextForRun`: статьи `aiRunId=run.id` без результата этого запуска; атомарность — уникальный индекс `(runId, articleId)` при вставке `processing`.
- **Завершение запуска** — нет непроверенных статей, нет `processing/applying`, а для auto+autoApply — нет `proposed`.
- **Авто-применение** (`autoOpFor`): `confidence < 75 → human`, иначе `decision` (`approve|insufficient`), прочее → `human`. Применяет только `mode=auto` **и** `ArtSite.settings.aiModeration.autoApply=true`; иначе предложения ждут человека на экране.
- **Применение** (`applyResult`): `exclude` — снять захват; `insufficient` — `markInsufficient` с «ИИ: summary»; `approve|human` — `excludePhoto` для удалённых (пометка ✕, `excludedByAi=true`, фото **не удаляется** — человек может вернуть), `addFromReserve` пулом по 5 (отказы — в summary «Не добавлено из резерва: N (причины)», не в журнал ошибок), `reorderPhotos` по `finalOrder`; `approve` → проверка активных ≥ `min(15, photoCount)` (иначе `sent_to_human` «после правок N фото — отдано людям») → `approvePhotos`; `human` → снять захват, `sent_to_human`. Исключённые ИИ фото удалятся при одобрении человеком (как любые исключённые).
- **reviewArticle** (mix3): фото статьи `excluded=false` по позиции; резерв — кандидаты `reserve|keep` (≤25, по aiScore) + `rejected` на `rate` без `HARD_REJECT` в `rejectReason` (≤15); mix3 берёт первые 15 с существующими миниатюрами. Миниатюры — `thumbPath` (или `path`) → sharp ≤512 px JPEG q75 → data-URL `detail: low`. Нет файла у фото статьи → `S{n}: preview unavailable — answer "ok"`. Тренд-бриф — `resolveTrendBrief(facts, niche, keyword)`. Ниша — `recipe.nicheCode ?? site.nicheCode`; мотив для `focusRules` — `facts.keywordAttributes.keyword_nail_art`. Модели: lite `openrouter:google/gemini-2.5-flash-lite`, flash `openrouter:google/gemini-3-flash-preview`, слот `vision`, `aiChat` json, temperature 0.1, maxTokens 12000/3000, timeout 150/60 с, 2 попытки (fatal_run не повторяем). Стоимость всех попыток суммируется в `costUsd` результата (неудача с оплатой — `failed` с costUsd > 0; две такие — статью больше не берём, как `undecided`); `Article.costUsd` пересчитывается через `articleCost`.
- **Пропуски без оплаты** → `status=excluded` + summary («Уже проверена ИИ ранее…», «2 неудачные попытки…», «Статья уже в статусе …»), захват снимается. Без фото → `proposed insufficient confidence 100` (`review.empty`).
- **Автозапуск** (`aiAutostartTick`): мастер `aiModMaster`; сайты `isActive` с `aiModeration.enabled`; свободные PHOTO_REVIEW (aiRunId null, закрепление пусто или старше 15 мин) минус решённые; пачка `batchFrom` (0 → глобальная `aiModAutoBatch`); неполная — если самая старая ждёт > 30 мин (по `updatedAt`); не стартуем при бегущем запуске сайта или бэклоге `PUBLISH_QUEUED+PUBLISHING+REVIEW_PENDING ≥ backlogThreshold` (0 — не ждать). `source="auto"`, `startedById = site.createdById` (его ключи).
- **Ключи**: `AiCtx.userId = run.startedById ?? site.createdById`; нет ни того ни другого → результат `failed` «укажите владельца сайта».
- **Права**: запуск/стоп/решение — все, кому виден сайт (`canAccessArtSite`); стоимость скрыта при `perms.usage === "own"` (как в журнале соседа).
- **Сторож**: `processing` старше 6 мин удаляется (статья снова в пуле запуска), `applying` без `updatedAt` 3 мин → `proposed`. Внутри процесса статьи/решения в полёте не берутся повторно (`busyArticles/busyResults`).

## Исправления относительно оригинала (аудит)
- `undecided` оригинала считал решённой запись `superseded` → «Перепроверить» всегда пропускал статью («Уже проверена ИИ ранее»). У нас `superseded` не считается решением (и в `reviewArticle`, и в `undecidedArticleIds`).
- `rerun` в оригинале создавал запуск `mode:"auto"` при комментарии «новый тестовый запуск» — у нас режим берётся у исходного запуска.
- «Статья уже не на модерации» — не `failed` (в оригинале отсеивалось триггером из журнала), а `excluded` с текстом в summary.

## Упрощено / не перенесено
- Режимы `mix2`, legacy 3-pass и `compare` («Сравнить дорогой моделью», Gemini Pro) — нет; `ArtAiModerationRun.model` всегда `mix3`. Промты sysB/sysC legacy и sysR/sysF mix2 не переносились.
- Эталонов (`photo_reference_set`, блок QUALITY BAR) нет — так в брифе.
- Превью через `images.weserv.nl` и проверка «живости» URL — не нужны (наши файлы).
- Телеграм/sheets — нет.
- `startAiRunAction` принимает `articleIds` через запятую — для будущей кнопки «Проверить ИИ» в карточке статьи (кнопку в карточку не добавлял — не мой файл).

## Открытые вопросы / проверить на сервере
1. `Prisma.ArtAiModerationRunGetPayload<{ include: typeof RUN_INCLUDE }>` с `satisfies` (TS ≥ 5.0) и `where: { run: siteIn }` в `aiRunsOverview` — проверить tsc.
2. `src/lib/articles/moderation.ts` использует `cursor as object` для Json — если tsc ругается, это зона соседа; в моём файле все Json-записи через `as unknown as Prisma.InputJsonValue`.
3. Возраст ожидания для неполной пачки — по `Article.updatedAt` (нет поля «вошла в PHOTO_REVIEW»); закрепления сотрудников сдвигают его. Если важно точнее — добавить `photoReviewAt` в схему.
4. `aiScore` кандидатов у нас 0–10 (этап rate), в оригинале 0–100 — используется только для сортировки резерва, на логику не влияет.
5. При остановке воркера текущие проверки доводятся (inflight ждёт `worker/index.ts` до 60 с); если не успели — `processing` подберёт сторож через 6 мин.
6. `maxDuration = 300` в API-маршруте — для standalone не критично; applying одной статьи (скачивание ≤12 добавлений пулом по 5, ≤45 с каждое) укладывается.
