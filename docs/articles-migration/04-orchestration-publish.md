# 04. Очередь, оркестрация, модерация фото, публикация, очистка, служебные функции

Аудит исходников «Zewex Pinterest Articles» (Supabase Edge Functions, Deno) для порта на Node-воркер
(Next.js 15 + Prisma + MariaDB, очередь `PinJob`, systemd). Зона: `queue-orchestrator`, `direct-pipeline`,
`publish-worker`, `stage7-publish-wordpress`, `resolve-wp-category`, `sync-wp-categories`, `photo-review-action`,
`ai-photo-moderate`, `apply-review-exclusions`, `reference-candidates`, `cleanup-published-articles`,
`cleanup-published-photos`, `telegram-notify`, `sheets-sync`, `manage-team-member`, `check-api-key`,
`test-wp-connection`, модули `_shared/{wpCategories,compressImage,cleanupPublishedPhotos,cron-auth,billingGuard,serviceSlots}.ts`,
фронтовые `src/lib/{queueEngine,workflowEngine,stageRunners,stageIOMap,triggerOrchestrator}.ts`, `db/schema.sql`.

Ссылки на код даны как `файл:строка` относительно `supabase/functions/` (для фронта — относительно `src/`, для схемы — `db/schema.sql`).
Всё ниже — только по коду; документация (`MIGRATION.md`, `SERVICE_DOCUMENTATION.md`) в нескольких местах расходится с кодом, расхождения отмечены.

---

## 1. Машина состояний `article_queue`

### 1.1 Поля состояния (`db/schema.sql`, `CREATE TABLE public.article_queue`)

| Поле | Назначение |
|---|---|
| `status` | основной статус (см. 1.2) |
| `current_stage` | номер этапа конвейера (2, 5, 6, 65, 72, 73, 76, 77, 78 — формат `generated_photo`; 11, 12, 125, 13, 14, 15, 16, 65, … — `real_photo`; 3 — служебная отметка после шага 2, см. ниже; `null` — после завершения; 78 — опубликовано) |
| `pipeline_cursor` (jsonb) | курсор direct-pipeline: `current_invocation`, `invocation_started_at`, `last_heartbeat`, `recovery_count`, `photo_review_approved`, `skip_5/skip_6/skip_71/skip_72`, `stage5_cursor`, `stage6_cursor`, `stage73_cursor`, `_retry_count`, `rp_resume_filter`, `photo_topup_after_rating`, `photo_review_topup`, `photo_filter_cycles`, `photo_more_cycles`, `photo_select_cycles`, `s2_resume_attempts`, `bp65_retry`, `progress_spares`, `last_progress_at`, `photo_pending_seen`, `photo_spares`, `_stage5_pending_poyo_rescues`, `photo_shortage`, `manual_resume_at`, `stage73_last_chance`, `in_retry_phase`, `accumulated_missing`; у legacy-конвейера — `_attempts`, `next_run_after`, `processed`, `phase`. Частичное слияние — RPC `merge_pipeline_cursor` (`schema.sql:601`, ключи со значением `null` удаляются); полная перезапись — `update({pipeline_cursor: {...}})` во многих местах |
| `lock_id`, `locked_at` | CAS-замок записи (RPC `claim_queue_item_lock`, `schema.sql:200`) **и одновременно** «пульс» direct-pipeline (`locked_at` обновляется каждым `refreshHeartbeat`, `direct-pipeline/index.ts:179-191`). Сторож считает статью зависшей, если `locked_at` пустой или старше порога (`queue-orchestrator/index.ts:456`) |
| `consecutive_errors` | счётчик восстановлений сторожа (`queue-orchestrator/index.ts:460`), сбрасывается в 0 при завершении любого шага (`direct-pipeline/index.ts:220-223, 1971-1974, 2101-2104`) и при `progressMade` (`:413-414`) |
| `execution_mode` | по схеме `DEFAULT 'direct'`. Оркестратор обрабатывает «конвейером» только записи с `execution_mode !== "direct"` (`queue-orchestrator/index.ts:772-777`). Значение `"scenario"` ставит только `recoverOrphanQueueItem` (`direct-pipeline/index.ts:276`) и фронтовый `queueEngine` на `projects` (не на очередь, `src/lib/queueEngine.ts:341`). Практически все статьи — `direct`, конвейер мёртв (см. §10) |
| `direct_gate_passed` | флаг «фото сгенерированы» в формате `generated_photo` (`direct-pipeline/index.ts:896`); у восстановленной сироты ставится `true` без проверки (`:279`) |
| `error_message` | не только ошибки: сюда же пишутся служебные заметки («Отобрано N фото — ждёт модерации», «Ожидает фото: …», «Мало фото: …», «Ожидает пополнения баланса ИИ», «Queue paused: …», «Duplicate of already-running article»). Триггер `log_queue_error` (`schema.sql:576-600`) пишет каждое изменение в `pipeline_errors`, исключая по regex только `ждёт модерации|Пауза владельцем|Полный стоп|этап сохранён|Ожидает пополнения баланса`. «Ожидает фото», «Мало фото», «Queue paused» **попадают** в журнал ошибок |
| `pipeline_mode` (1/2) | 1 — текст пишется сразу, финал `review_pending`; 2 — стоп на модерации фото (`photo_review`), после одобрения текст и сразу `publish_queued` |
| `photo_review_claimed_by/at`, `photo_reviewed_by/at` | захват статьи модератором (15 мин, `photo-review-action/index.ts:76-78`) или ИИ-запуском (на 30 дней, `ai-photo-moderate/index.ts:19, 96, 139`); отметка одобрения человеком |
| `insufficient_reason`, `insufficient_by`, `insufficient_by_ai`, `insufficient_at` | причина «Мало фото» (текст ≤500), кто поставил, ИИ ли (`photo-review-action/index.ts:66-71`) |
| `wp_category_id/name`, `sheet_row/tab`, `sheet_sync_state/error`, `wp_url`, `total_cost`, `keyword_ru`, `year_in_url`, `photo_geo/language/freshness`, `test_tag` | вспомогательные |

### 1.2 Значения `status` и кто их ставит

Фактический словарь из кода (документация перечисляет `waiting`, `approved`, `rejected`, `error`, `skipped`, `published` — для `article_queue` они **не используются**; это значения `workflow_stages.status`, `article_drafts.review_status`, `generated_images.review_status`):

| status | Смысл | Кто ставит (file:line) |
|---|---|---|
| `pending` | ждёт запуска (в т.ч. повторного, с сохранённым курсором) | импорт из UI; UI стоп/возобновление (`components/queue/ArticleQueuePanel.tsx:621-624, 876-883, 1500-1505`; `pages/ErrorsPage.tsx:178`); direct-pipeline откат при превышении лимита сайта (`direct-pipeline/index.ts:369-372, 380-383`); billing (`:1293-1297`; `queue-orchestrator/index.ts:651-654`); `photo-review-action` `topup` (`:215-219`) и `approve` (`:261-267`); `ai-photo-moderate` `insufficient_action/topup` (`:224-227`); legacy `queueEngine` (`src/lib/queueEngine.ts:132-135, 144-153, 174-176, 504-507`) |
| `running` | статья в работе (direct-pipeline) | оркестратор `initItem` (`queue-orchestrator/index.ts:1859-1863`); direct-pipeline INV2 «захват следующей» (`:947-955`); UI ручной запуск/возобновление (`ArticleQueuePanel.tsx:593-597, 1389, 1432-1438`; `components/layout/BackgroundProcessIndicator.tsx:188, 227-231`) |
| `processing` | legacy | только `recoverOrphanQueueItem` (`direct-pipeline/index.ts:277`) и подсчёт в idle-проверке (`queue-orchestrator/index.ts:1008`). Никто не продвигает и не сторожит (сторож берёт только `running`) — см. §10 |
| `photo_review` | Режим 2: ждёт модерации фото человеком/ИИ | `sendToPhotoReview` (`direct-pipeline/index.ts:1235-1253`, `current_stage=14`, `error_message` = сообщение); `ai-photo-moderate` `insufficient_action/return` (`:222`) |
| `insufficient_photos` | «Мало фото», выведена из очереди | только `photo-review-action` `mark_insufficient` (`:64-73`), человек или ИИ через `acting_user_id` |
| `waiting_for_photos` | Режим 1: нехватка фото, ждёт ручного повтора | `waitForPhotos` (`direct-pipeline/index.ts:1255-1271`, курсор перезаписывается `{current_invocation, photo_shortage}`) |
| `review_pending` | текст готов, ждёт модерации статьи (Режим 1) | direct-pipeline INV5 (`:1132-1140`); legacy `completeItem` (`queue-orchestrator/index.ts:1873-1878`); `pages/PhotoReviewPage.tsx:406` |
| `reviewed` | одобрена без публикации (терминал для конвейера) | `pages/ModerationPage.tsx:514, 578` (в документации нет) |
| `needs_rework` | отправлена на доработку | `ModerationPage.tsx:548`, `pages/PublicationsPage.tsx:130` (в документации нет; никакой код очереди этот статус не обрабатывает) |
| `publish_queued` | ждёт publish-worker | direct-pipeline INV5 в Режиме 2 (`:1135`); `ModerationPage.tsx:514`; `PublicationsPage.tsx:114`; publish-worker при повторе (`:201, 223, 277, 291, 313`) |
| `publishing` | publish-worker захватил | `publish-worker/index.ts:166` |
| `completed` | опубликовано (есть `wp_url`) | `publish-worker/index.ts:72-79, 240-247`; `stage7-publish-wordpress/index.ts:435-442` (при `approve`); фронт `src/lib/stageRunners.ts:588-595`, `queueEngine.ts:409-416` |
| `publish_error` | публикация окончательно не удалась (permanent или 6 попыток) | `publish-worker/index.ts:312-316` |
| `failed` | статья упала | сторож (`queue-orchestrator/index.ts:661-668`), дубли (`:905-910, 953-957`), init (`:966-969`), конвейер после 3 попыток (`:1139-1142`); `failPipeline` (`direct-pipeline/index.ts:1321-1326`), init (`:395-398`); `queueEngine.ts:263-267, 410` |
| `paused` | очередь сайта остановлена после серии инфраструктурных сбоев (только для `pending`) | `queue-orchestrator/index.ts:693-697` (5 подряд), `direct-pipeline/index.ts:1377-1381` (3 подряд) |
| `stalled` | остановлена вручную | только UI (`ArticleQueuePanel.tsx:1375`, `BackgroundProcessIndicator.tsx:248`); сервер не трогает (в документации нет) |
| `cancelled` | — | только проверяется в `direct-pipeline/index.ts:322`, никем не ставится (мёртвый статус) |

### 1.3 Таблица переходов

| Из | В | Триггер / условие | Исполнитель |
|---|---|---|---|
| `pending` | `running` | лимиты сайта/фазы, нет billing-блока, нет дубля по ключу, `claim_queue_item_lock`; `initItem` создаёт/возобновляет проект; затем `direct-pipeline` inv N | оркестратор (`:891-997`) |
| `pending` | `failed` | уже бежит статья с тем же ключом на сайте (`:897-911`) или такой ключ уже `completed/review_pending/published` (`ilike`, `:949-959`) | оркестратор |
| `pending` | `running` | INV2 после гейта фото: CAS `pending→running` следующей статьи того же сайта с `photo_reviewed_at IS NULL`, минуя `initItem` (проект создастся в inv 1) | direct-pipeline (`:938-959`) |
| `pending` | `running` | ручной «Запуск очереди» (первая `pending` сайта) | UI (`ArticleQueuePanel.tsx:580-602`) |
| `pending` | `paused` | последние 5 (оркестратор) / 3 (direct-pipeline) завершённых статьи сайта — `failed` с инфраструктурной ошибкой | оркестратор `:685-699`, direct-pipeline `:1336-1390` |
| `running` | `pending` | inv 1: лимит фазы сайта или лимит сайтов исчерпан (`started_at=null`) | direct-pipeline `:367-384` |
| `running` | `pending` | «нет баланса» провайдера: `isBillingError` → `markBillingOut` (15 мин) → статья назад с сохранённым курсором | direct-pipeline `failPipeline:1287-1299`; сторож `:648-656` |
| `running` | `running` (+ `current_stage`, курсор) | каждый `updateStage`, `chainSelf` между инвокациями, heartbeat | direct-pipeline |
| `running` | `photo_review` | Режим 2, после шага 14 (отбор) или при нехватке фото на 13/14 (`waitForPhotos` в Режиме 2) | direct-pipeline `:594-596, 1257-1259` |
| `running` | `waiting_for_photos` | Режим 1: `needs_filtering` > 6 кругов, `waiting_for_photos` от шага 13, `needs_more_photos` > 7 кругов без минимума, шаг 14 без фото при `topups ≥ 6` или `select_cycles > 7`; также `failPipeline` с текстом «Недостаточно подходящих фото» | direct-pipeline `:513-514, 527-528, 546-551, 585, 1279-1283` |
| `running` | `review_pending` | INV5 завершён, `pipeline_mode=1` → `article_drafts.review_status=pending`, telegram `review_ready` | direct-pipeline `:1132-1163` |
| `running` | `publish_queued` | INV5 завершён, `pipeline_mode=2` → черновик `approved`, `publish_state=queued`, вызов publish-worker | direct-pipeline `:1132-1161` |
| `running` | `failed` | `failPipeline` после 1 повтора инвокации (`_retry_count`), сторож после `maxRecoveries` (3; шаг 5 — 6) при отсутствии «пощады», init-ошибка, дубль | direct-pipeline `:1301-1326`; оркестратор `:658-668` |
| `running` | `stalled` | кнопка «Стоп» | UI |
| `running` | `running` | «Resume»/«Retry» из UI: `workflow_stages[stage]→pending`, `status=running`, `locked_at` не трогается → сторож на следующем тике видит `!locked_at` и перезапускает inv | UI `ArticleQueuePanel.tsx:1386-1448`, `BackgroundProcessIndicator.tsx:184-243`; сторож `:456` |
| `running` | `running` (`consecutive_errors+1`) | rescue: `{mode:"rescue", article_queue_id}` → сразу `direct-pipeline` с `resolveDirectInvocation` | оркестратор `:340-376` |
| `photo_review` | `pending` (`current_stage=15`, курсор `{current_invocation:2, photo_review_approved:true}`) | `approve` человеком или ИИ: ≥15 фото, у всех есть `facts/description`; удаляются секции/черновик/outfits/стадии `DOWNSTREAM_STAGES`; стадия 14 `completed human_reviewed`; `photo_usage_fingerprints` перезаписаны | `photo-review-action:229-270` |
| `photo_review` | `pending` (курсор `rp_resume_filter`, `photo_topup_after_rating`, `photo_review_topup`; стадии 12,13 → pending) | `topup` (добор) | `photo-review-action:213-227` |
| `photo_review` | `insufficient_photos` | `mark_insufficient` (человек) или ИИ-решение `insufficient` при confidence ≥75 в режиме auto | `photo-review-action:64-73`; `ai-photo-moderate:292-294, 658-661` |
| `photo_review` | `photo_review` (claim/release/remove/add/reorder) | действия модератора; ИИ применяет те же действия с `acting_user_id` | `photo-review-action` |
| `insufficient_photos` | `photo_review` | `insufficient_action/return` | `ai-photo-moderate:221-222` |
| `insufficient_photos` | `pending` | `insufficient_action/topup` (курсор добора, стадии 12,13 → pending, wake оркестратора) | `ai-photo-moderate:223-236` |
| `waiting_for_photos` | `running` (`current_stage=12`, курсор `rp_resume_filter+photo_topup_after_rating`) | «Повторить» в UI | `ArticleQueuePanel.tsx:1401-1448` |
| `review_pending` | `publish_queued` / `reviewed` | модератор статьи: одобрить и опубликовать / одобрить | `ModerationPage.tsx:484-533` |
| `review_pending` | `needs_rework` | «на доработку» (`article_drafts.moderation_flag=needs_rework`) | `ModerationPage.tsx:535-553` |
| `publish_queued` | `publishing` | CAS `article_drafts.publish_state queued/retry → publishing` (`publish_lock_id`) | publish-worker `:157-166` |
| `publishing` | `completed` (+`wp_url`, `current_stage=78`) | `stage7-publish-wordpress` вернул `wp_post_url`; `review_status=published`, `publish_state=published`; sheets-sync | publish-worker `:228-253`; напрямую `stage7-publish-wordpress:434-445` |
| `publishing` | `publish_queued` | `repairing` (качество починено, повтор через 60 с), `PARTIAL_UPLOAD`/таймаут с прогрессом (30 с, попытка не считается), «Сайт не принимает загрузку фото» (20 мин), transient ошибка (backoff 1/3/5/10/15 мин, ≤6 попыток) | publish-worker `:196-204, 214-226, 270-281, 284-295, 296-316` |
| `publishing` | `publish_error` | permanent ошибка (401/403/404, `rest_*`, quality, `WP_CREDENTIALS_MISSING`, `QUALITY_BROKEN`) или 6 попыток | publish-worker `:17-24, 296-316` |
| `publishing` | `completed` | sync: черновик `publishing` + `review_status=published` + `wp_post_id` (ответ WP пришёл, но родительский запрос оборвался) | publish-worker `:58-80` |
| `publishing` (черновик) | `queued` | зависший `publish_started_at` > 10 мин (или `updated_at` > 10 мин без `publish_started_at`) | publish-worker `:83-93` |
| `publish_error` | `publish_queued` / `needs_rework` | «Повторить» / «на доработку» | `PublicationsPage.tsx:99-135` |
| `failed`/`paused`/`stalled` | `pending` | UI «Возобновить всё» (`consecutive_errors=0`, курсор без `_attempts`), «Requeue» на странице ошибок | `ArticleQueuePanel.tsx:862-893, 1493-1512`; `ErrorsPage.tsx:178` |
| `completed` | (удалена) | ночная очистка > 24 ч после публикации | `cleanup-published-articles:109` |

Особенности:
- После шага 2 direct-pipeline пишет `current_stage: 3` (`:740-744`) — номер **удалённого** товарного этапа; сторож трактует 3 как «polling stage» с порогом 10 мин (`queue-orchestrator/index.ts:450`), а `nextStage(3)` возвращает 5 (`:1542-1545`).
- Шаг 125 (ранжирование) нигде не имеет записи в `workflow_stages`, только `current_stage`.
- `photo_review_approved` в курсоре определяет «фазу написания» для лимитов (`isWritingPhase`, `queue-orchestrator/index.ts:91-94`; `isWritingChain`, `direct-pipeline/index.ts:351-352`; триггер `auto_enable_site_phase`, `schema.sql:95-121`).

### 1.4 Причины `insufficient_photos`

- Человек: кнопка «Мало фото» (`reason` — свободный текст из UI).
- ИИ (`ai-photo-moderate`): `decision="insufficient"` при `final.length < minOk` (`minOk = min(count_outfits, 15)`, `:402-403, 605`) либо статья вообще без фото (`:426-431`, confidence 100, cost 0); применяется автоматически только в `mode=auto` при `confidence ≥ 75` (`:292-294`), иначе остаётся `proposed` для человека. Причина пишется как `ИИ: <summary>` (`:659`).
- При применении `approve` ИИ, если после правок фото < 15 — не `insufficient`, а `sent_to_human` (`:690-692`).
- В Режиме 1 нехватка фото даёт `waiting_for_photos`, а не `insufficient_photos` (`direct-pipeline/index.ts:1257-1270`).

---

## 2. Алгоритм `queue-orchestrator` (3154 строки)

Запускается: cron каждую минуту (`set_queue_cron`, `schema.sql:812-855`, тело запроса `{"source":"cron"}`), самовызов `chainSelf` (`:1651-1667`), пробуждения из `photo-review-action` (`:296-302`), `ai-photo-moderate` (`:233-236`), UI (`triggerOrchestrator`), триггер `auto_enable_queue_cron` при вставке `pending` (`schema.sql:72-94`).

### 2.1 Тик по шагам

| № | Что делает | Строки | Природа |
|---|---|---|---|
| 0 | Fire-and-forget: `ai-photo-moderate {action:"watchdog"}`, `cleanup-published-photos`, `publish-worker {source:"orchestrator"}` | 310-328 | Костыль: три «крона» подвешены на тик оркестратора; при chainSelf каждые 3 с это десятки вызовов в минуту |
| 1 | Rescue mode: тело `{mode:"rescue", article_queue_id}` → если `running`: `consecutive_errors+1`, `locked_at=now`, курсор `{current_invocation: resolved, invocation_started_at, recovery_count, last_heartbeat, manual_resume_at}`, POST `direct-pipeline`; ответ сразу | 340-376 | Костыль под обрыв цепочки Edge Functions; увеличивает счётчик сбоев при ручном действии |
| 2 | `loadThroughput` из `automation_settings` (`lanes` 1-8, `max_parallel_stages`, `max_concurrent_per_site`, `max_pregate_per_site`, `max_writing_per_site`, `max_concurrent_sites` ≤50, `max_concurrent` ≤200; дефолты кода 4/3/6/6/6/16/80, дефолты БД 4/3/6/3/16/40) | 39-85 | Бизнес-настройка (лимиты), но «lanes» — костыль |
| 3 | `claimLane`: RPC `claim_orchestrator_lane` для `lane_0..lane_N-1` (таблица `orchestrator_lock`, строка на линию, аренда `MAX_DIRECT_MS+15 с = 295 с`), случайный старт. Нет свободной — `skipped`. В `finally` `releaseLane` | 107-140, 378-384, 1283-1286 | Костыль: защита от параллельных cron/chain-инвокаций без процесса-демона. Хеш статьи→линия (`laneOf`) используется только в legacy-конвейере |
| 4 | `resetStaleProcessing` — сброс `outfits.stage4/5_status`, `generated_images.review_status/stage6_status` зависших >5/15 мин (лимиты попыток 3; шаг 5 — 10) | 178-256 | Legacy формата генерации; относится к таблицам шагов, не к очереди |
| 5 | `resetStaleQueueLocks` — `running` с `lock_id` и `locked_at` старше 2 мин → `lock_id=null, locked_at=null` | 155-168 | Костыль: обнуление «пульса» делает статью мгновенно stale для сторожа (`:456`) |
| 6 | Zombie recovery: `running` без `project_id` и `started_at` старше 5 мин → POST `direct-pipeline inv 1` (3 с abort), без счётчика | 404-435 | Костыль под INV2 «захват следующей» без init |
| 7 | **Сторож (watchdog)**: все `running` с `project_id`; stale, если `locked_at` пуст или старше порога: 5 мин (`DIRECT_STALE_THRESHOLD`), 10 мин для стадий 2, 3, 36. Для каждого: `recoveryCount = consecutive_errors+1`, `maxRecoveries` 3 (стадия 5 — 6). Если `recoveryCount > max`: (a) стадия 5: до 2 «спасений» зависших `pending_poyo` — перезапуск `stage5-nanobanana-edit` на каждый, счётчик держится на max; (b) activity spare: есть `generations_log.status=success` за 5 мин → `consecutive_errors=0`, перезапуск (без лимита!); (c) progress spare: новые `article_sections.updated_at`/`article_photos.created_at` после `last_progress_at`, ≤3 раз; (d) photo spare (стадии 11–14): число непроверенных `photo_candidates` уменьшилось, ≤40 раз; (e) billing-блок → `pending` «Ожидает пополнения баланса ИИ»; иначе `failed` «Watchdog: article stuck at stage N after M recovery attempts (K min timeout each)», `completed_at`, sheets-sync `mark ошибка`, пауза сайта (5 последних завершённых — `failed` с инфраструктурной ошибкой), telegram. Если `recoveryCount ≤ max`: `consecutive_errors=recoveryCount`, `locked_at=now`, курсор `{current_invocation, invocation_started_at, recovery_count}`, POST `direct-pipeline` (3 с abort) | 394-754 | Костыль: сторож компенсирует обрыв chainSelf и 150/200-секундные убийства функций. Бизнес-часть — только «не губить статью при пустом балансе» и «пауза сайта при инфраструктурной серии» |
| 8 | Выборка `running`; directStale исключены; разделение на `conveyorItems` (`execution_mode !== "direct"`) и `directItems` (пропускаются) | 756-777 | Legacy |
| 9 | **Продвижение pending**: снимок `allRunning`; конфиг сайтов (`position`, `auto_photo_enabled`, `auto_writing_enabled`, `auto_restart_on_queue`, `max_photo_concurrent`, `max_writing_concurrent`, `*_idle_since`); `siteLimit(site, writing)` = 0 если фаза выключена, иначе `clamp(site.max_*, default, 1, 50)`; `globalCap = min(300, max(tp.max_concurrent, Σ лимитов сайтов))` | 779-805 | Бизнес-логика (две независимые цепочки на сайт: «фото» до одобрения и «написание» после) |
| 10 | **Idle auto-off**: для сайтов с `auto_restart_on_queue=true` и включённой фазой: если нет работы по фазе (`pending/running/photo_review/insufficient_photos`; `photo_review`+`insufficient_photos` считаются работой «написания») — ставится `*_idle_since`, через 15 мин фаза выключается с `*_off_reason="idle"`. Обратное включение — триггер `auto_enable_site_phase` при появлении `pending` (`schema.sql:95-121`) | 807-840 | Бизнес-логика («автоэкономия»), но смысл её — не держать cron/БД Supabase; в демоне без нагрузки от пустых тиков она не нужна |
| 11 | `billingBlocked` (OpenRouter в `provider_billing_status`, `blocked_until > now`) → новых запусков нет | 842-845 | Бизнес-логика |
| 12 | Кандидаты: первые 5000 `pending` по `position, created_at`; по каждому ключу `site:phase` берётся не больше лимита; дочитываются полные строки пачками по 100; сортировка внутри сайта «написание сначала, потом позиция», между сайтами — round-robin по `sites.position`; цикл до `globalCap` и `MAX_PROMOTE_PER_TICK=30`: дедуп по `(site_id, lower(keyword))` среди бегущих (дубль → `failed` «Duplicate of already-running article»), лимит фазы сайта, `max_concurrent_sites` только для фазы фото | 846-937 | Бизнес-логика (кроме пометки дубля как `failed` — спорно) |
| 13 | `launchOne` ×10 параллельно: `claimItem` (CAS), перечитать, проверка «такой ключ уже `completed/review_pending/published`» (`ilike`) → `failed`, `initItem` (создать проект / возобновить: сброс `failed/running` стадий, `applyScenario`, `parse-keyword-ai` 30 с; `status=running`, `current_stage`, `started_at`, курсор сохраняется только при `resumeStage && current_invocation`), снять замок с `locked_at=now`, POST `direct-pipeline {invocation: resolveDirectInvocation}` с 15 с abort | 939-997, 1751-1867 | Бизнес (init проекта, дедуп) + костыль (fire-and-forget с abort) |
| 14 | Если конвейерных `running` нет → **idle auto-off cron**: `automation_settings.auto_disable_when_idle`, счётчик `idle_ticks`, порог `ceil(15/every_minutes)` → RPC `set_queue_cron(false)`; ответ `idle` | 1000-1028 | Костыль под pg_cron |
| 15 | Legacy-конвейер: `workflow_stages` бегущих проектов, `cleanupCompletedItems`/`completeItem` (→`review_pending`), stale-стадии (3: 15 мин, 36: 20 мин, loop-стадии 5/6/73: 10 мин, с курсором 5 мин, без — 2 мин; для 3/36 сохраняется `task_ids`), `findBestAction` (occupancy «стадия|сайт» или «стадия|линия» для `HEAVY_STAGES` 3/5/36/55, 15 с gap, inline-ожидание cooldown <120 с), пакет до `max_parallel_stages`, `processAction`: `execStage` → 3 попытки (`_attempts`) → `failed`; `markStageCompleted`; `nextStage`; rollback 72→2; `chainSelf` в конце | 1030-1287, 1297-1560, 1939-2890 | Мёртвый код для `direct` |

### 2.2 Где хранятся лимиты

- Глобальные: `automation_settings` (singleton) — `lanes`, `max_parallel_stages`, `max_concurrent_per_site`, `max_pregate_per_site`, `max_writing_per_site`, `max_concurrent_sites`, `max_concurrent`, `cron_enabled`, `every_minutes`, `auto_disable_when_idle`, `idle_ticks`, `auto_enable_on_queue`, `ai_mod_auto_enabled`, `ai_mod_auto_batch`.
- Сайт: `sites.auto_photo_enabled`, `auto_writing_enabled`, `auto_restart_on_queue`, `max_photo_concurrent`, `max_writing_concurrent`, `photo_idle_since`, `writing_idle_since`, `auto_*_off_reason`, `max_publish_concurrent` (publish-worker, 1..5), `ai_mod_auto_enabled`, `ai_mod_auto_batch`, `ai_mod_concurrency`, `ai_mod_max_publish_backlog`.
- Этапы (внешние сервисы): `service_leases` через RPC `acquire_service_slot/release_service_slot` (`schema.sql:40-70`), лимиты в `_shared/serviceSlots.ts:5-8` (`image_search` 6, `image_gen` 6, прочее 4, TTL 180 с, `waitForServiceSlot` до 45 с). Оркестратор их не использует — только функции шагов.
- Документация говорит «10 статей, 5 сайтов» — в коде таких чисел нет (дефолты 80/16 в коде, 40/16 в БД).

### 2.3 Автозапуск по этапам

- Фото/написание: § 2.1 п. 9–13 (оркестратор) + direct-pipeline сам проверяет лимиты на inv 1 (`:336-386`) и сам захватывает следующую статью сайта после гейта фото (`:908-966`).
- ИИ-модерация: не в оркестраторе, а в `ai-photo-moderate watchdog` (вызывается каждым тиком): сайты с `ai_mod_auto_enabled`; свободные `photo_review` (не захвачены или захват старше 15 мин); исключаются уже решённые ИИ (`undecided`, `:936-950`); пачка `ai_mod_auto_batch` (1..200, дефолт 20); неполная пачка стартует, если самая старая статья ждёт > 30 мин (`:81-84`); не стартует, если у сайта уже бежит запуск или `publish_queued+publishing+review_pending ≥ ai_mod_max_publish_backlog` (0 = не ждать) (`:85-89`); создаётся `ai_moderation_runs {mode:"auto"}`, статьи захватываются на 30 дней, стартуют `min(concurrency, n)` воркеров (`:91-98`).
- Auto-restart фаз: триггер `auto_enable_site_phase` (БД).

### 2.4 Sleep-then-chain, 504, бюджеты времени

- Оркестратор: бюджет `MAX_DIRECT_MS=280 с − CHAIN_BUFFER_MS=30 с` (`hasTimeBudget`, `:387`); `chainSelf` ждёт ≤10 с и POST-ит сам себя `{_chain:true}` (`:1651-1667`); перед chain обязательно `releaseLane`.
- direct-pipeline: `MAX_MS=170 с`, `BUFFER_MS=30 с` (`:16-17`, комментарий: площадка убивает ~на 200-й секунде), `hasTime`/`hasTimeFor(expected)` (`:304-308`), `chainSelf` с 15 с dispatch-timeout, 3 попытки на 429/сеть (`:131-176`), `sleepWithHeartbeat` кусками по 110 с против 150 с idle-timeout (`:194-205`), `runOneShot` с heartbeat каждые 60 с и «polling recovery» до конца бюджета (`:1397-1507`).
- 504: фронт `triggerOrchestrator` считает 504/`IDLE_TIMEOUT`/`Failed to fetch` успехом «работает в фоне» (`src/lib/triggerOrchestrator.ts:5-14`). Внутри функций транспортные ошибки (`isTransportError`, `:51-55`) → пауза 5 с и проверка результата в БД вместо повтора (`runOneShot:1456-1468`, `execStage` для 2/72/76/78).
- `publish-worker` и `ai-photo-moderate` отвечают сразу и работают через `EdgeRuntime.waitUntil` (`publish-worker:333-335`, `ai-photo-moderate:42-44, 184-186`).

Всё это — борьба с ограничениями Supabase Edge Functions; в Node-воркере не нужно.

### 2.5 Каскадный сброс этапов

- UI `WorkflowRunner.cleanStage` (`src/pages/WorkflowRunner.tsx:233-325`): стадия 2 → удаляет `outfits`, `generated_images`, `outfit_items`, сбрасывает 2/5/55; стадия 5 → чистит storage, сбрасывает 5/55 и каскадно черновик, секции, стадии 6/64/65/7/75/77 (цикл дублирован, `:282-283`); 7 → секции, черновик, 7/71–78; 71–78 → все стадии `sn..78`, для 72/73/74 секции в `planned`. `Stage5ResultViewer.cascadeResetDownstreamStages` (`:53-78`). Это ручной сброс «из воркфлоу», не из очереди.
- Серверные откаты: `execStage` 72 без `article_plan` → `rollbackStage: 2` (≤2 раза, `queue-orchestrator:2012-2024`); direct-pipeline inv 4 без блюпринта → inv 3 `skip_6` (`:1036-1050`); блюпринт < 80 % секций → `article_position=null`, стадия 65 pending, inv 2 `skip_5` (≤2, `:1003-1022`); `photo-review-action approve` удаляет секции/черновик/outfits и стадии `[15,16,65,7,71,72,73,75,76,77,78]` (`:12, 238-243`); `stage-photo-select` чистит downstream перед заменой фото (`stage-photo-select:380`).

### 2.6 Billing-блок 15 мин

`_shared/billingGuard.ts`: `isBillingError` (402, `insufficient credits/quota`, `配额不足`, `not enough balance`…), `markBillingOut(provider)` → `provider_billing_status.blocked_until = now+15 мин`; `billingBlocked` смотрит **только** `openrouter`. В `failPipeline` помечается `openrouter` только если текст содержит «openrouter» или «insufficient credits» (`direct-pipeline:1289-1291`) — ошибка 402 другого провайдера вернёт статью в `pending`, но блок не поставит → оркестратор тут же запустит её снова. Бизнес-логика, оставить (с учётом провайдера).

### 2.7 Итог: что костыль, что бизнес-логика

| Костыли под Supabase (выбросить) | Бизнес-логика (перенести) |
|---|---|
| lanes/`orchestrator_lock`, `claim_queue_item_lock`, `chainSelf`, номера инвокаций, `hasTime*`, `sleepWithHeartbeat`, heartbeat через `locked_at`, сторож со «спасениями», zombie/rescue, 504-как-успех, `EdgeRuntime.waitUntil`, `set_queue_cron`/idle auto-off cron, вызов publish-worker/cleanup/ai-watchdog из тика, `service_leases` (заменить семафорами в процессе), фаза `prepare` и `PARTIAL_UPLOAD` в публикации, `callFn` с abort | Две цепочки на сайт с лимитами и выключателями, `globalCap`, round-robin по сайтам, приоритет «написание раньше фото», дедуп по ключу (лучше — не `failed`, а `skipped`), billing-пауза, пауза сайта при серии инфраструктурных сбоев (одно определение), idle auto-off фазы + auto-restart (если владельцу важно), ограничения кругов добора фото (6/7/7, `topups<6`), гейт 70 % картинок, ≥15 фото для одобрения, Режимы 1/2, автозапуск ИИ-модерации (пачка 20 / 30 мин / backlog) |

---

## 3. `direct-pipeline`

Линейный исполнитель одной статьи, вызывается с `{article_queue_id, invocation, cursor}`; сам себя продолжает через `chainSelf`. Отличия от оркестратора: нет замков и линий, курсор из тела **перекрывает** курсор БД (`:328-329`), на inv 1 проверяет лимиты сайта и при переполнении откатывает в `pending` (`:353-386`), создаёт проект (`initProject:2655-2780`: повторное использование проекта с тем же `focus_keyword+site_id` в активном статусе, сброс курсора), один повтор инвокации при ошибке (`_retry_count<1`, с сохранением `skip_*`/`*_cursor`, `:1301-1318`), billing → `pending`, пауза сайта после 3 инфраструктурных `failed` (`:1334-1390`), «восстановление сироты» (`:255-286`).

Останавливается, если статус `cancelled|failed|paused|waiting_for_photos` (`:322-325`). Не проверяет `photo_review`, `insufficient_photos`, `stalled`, `pending` — чужой chain может продолжить статью, которую человек уже увёл.

### 3.1 Формат `generated_photo` (инвокации 1–5)

| Inv | Шаги | Детали |
|---|---|---|
| 1 | 2 Концепт-план | пропуск, если концептов ≥ `count_outfits`; `resume` при частичных; верификация 4×1.5 с; принимается ≥ max(5, 80 %); авто-resume ≤2 (`s2_resume_attempts`); `markStageCompleted`; `current_stage=3`, курсор `current_invocation=2`; chain 2 (`:634-756`) |
| 2 | 5 Генерация | `runStage5Loop` (сцена-планер кроме nails, сброс «processing» >3 мин, grace-исключение ≤5 застрявших с ≥4 попыток, батчи 3 / PoYo 5 / OpenAI 10×ключей, ожидание `pending_poyo` ≤10 мин, порог отказов 20 %); backfill `generated_images`; гейт ≥70 % картинок (ожидание pending_poyo ≤10 мин, одна recovery-волна по `skipped`); `review_status=approved` всем, `article_position` по порядку; `direct_gate_passed=true`; chain 3; затем **захват следующей `pending` сайта** (CAS) и chain inv 1 для неё (`:761-969`) |
| 3 | 6 Загрузка + 65 Блюпринт | `runStage6`: collect (только `approved`, без `wp_media_id`) → alt_tags пачками 10 (ошибки пропускаются) → upload 5 параллельно → повтор 3 параллельно 180 с → фолбэк `wp_url=public_url`, `wp_media_id=-1`, `stage6_status=fallback`; 65; проверка числа секций ≥80 % → откат на inv 2 `skip_5` ≤2; chain 4 (`:975-1026`) |
| 4 | 72 Вступление/заключение, 73 Секции | без блюпринта → inv 3; 72 через `runOneShot72` (ждёт результат в БД при обрыве); 73 `runStage73` волнами по 7 (3 для claude) батчей × `stage7_batch_size` (дефолт 8), повтор пропавших ≤2 раундов по 3, «последний шанс» по одной секции `forceRewrite`, затем удаление ≤20 % пустых секций (если осталось ≥15) с их фото; chain 5 (`:1031-1081`) |
| 5 | 77 SEO-мета → 76 Сборка → финал | 77 (повтор один раз, fail если нет `seo_title/h1/slug/description≥40`); 76; статус `review_pending` (Режим 1) или `publish_queued` + черновик `approved/queued` + вызов publish-worker (Режим 2); telegram `review_ready` (`:1086-1214`) |

Публикация (78) в direct-pipeline **не вызывается** — только через publish-worker после модерации.

### 3.2 Формат `real_photo` (инвокации 1–3, далее общие 4–5)

| Inv | Шаги |
|---|---|
| 1 | 11 `stage-photo-search` (пропуск при `rp_resume_filter`) → 12 `stage-photo-filter` циклом ≤30 вызовов (`process_pending` при повторных кругах, `request_topup/topup_from` при доборе); `partial` → chain inv 1 `rp_resume_filter`; → chain 2 (`:445-484`) |
| 2 | если не было ручной модерации (`photo_review_approved` или `pipeline_mode=2 && photo_reviewed_at`): 125 `stage-photo-rank` (ошибка не фатальна) → 13 `stage-photo-rate` (`needs_filtering` → inv 1, ≤6 кругов `photo_filter_cycles`; `waiting_for_photos` → `waitForPhotos`; `needs_more_photos` → inv 1 с `photo_topup_after_rating`, ≤7 кругов, иначе продолжаем, если `kept ≥ min_acceptable`) → 14 `stage-photo-select` (нет фото / нужно больше → inv 1 добор при `topups<6 && select_cycles≤7`, иначе `waitForPhotos`) → счётчики кругов сброшены → **Режим 2: `sendToPhotoReview` и стоп** (`:486-597`). Далее 15 `stage-photo-plan`, 16 `stage-photo-section-plan` (бюджет `hasTimeFor` 110/40 с → chain inv 2) → chain 3 (`:602-617`) |
| 3 | 65 блюпринт → chain 4 (`:620-626`) |

Отличия от `generated_photo`: нет шага 6 (фото грузятся на сайт при публикации, `stage7-publish-wordpress:208-348`), нет гейта 70 %, есть ручная модерация фото и ИИ-модерация, `waitForPhotos` только здесь.

---

## 4. `photo-review-action`

Авторизация (`:24-45`): Bearer JWT пользователя → `sb.auth.getUser` → RPC `can_access_site(user, site)`; либо service key + `acting_user_id` (UUID) — вызов ИИ-модерации, проверка доступа пропускается. Статья должна быть `photo_review`, иначе `200 {stale:true}` (`:46-49`).

| action | Что делает | Строки |
|---|---|---|
| `claim` | захват на 15 мин (`photo_review_claimed_by/at`), если свободна или своя; фоновый перевод ключа на русский (`gemini-2.5-flash-lite` через OpenRouter, `keyword_ru`); возвращает `trend_brief_ru` из стадии 11 | 75-91, 304-320 |
| `release` | снять свой захват; при `skip` пишется событие `skip` | 93-97, 53 |
| `remove` | удалить `article_photos` по `photo_id` (в рамках проекта), `photo_candidates.selected=false` по `image_url`, `renumber_article_photos`; `reason="dated"` → доп. событие `remove_dated` | 99-107, 58-60 |
| `reorder` | RPC `renumber_article_photos(_project_id, _order_ids)` | 109-113, 291-294 |
| `add` | кандидат должен быть `tech_status=ok`; дубль по `image_url` → `already`; дубль по `fingerprint` среди `article_photos` → `selected=true`, `duplicate`; **скачивание**: адреса `[image_url, thumbnail_url]` × 2 User-Agent (Chrome, `ZewexBot/1.0`), затем `images.weserv.nl` прокси; `Referer=source_page_url` кроме gstatic/weserv; общий дедлайн 45 с, на попытку ≤12 с; `content-type image/*`, ≥2000 байт; upload в Storage `generated-images/<pid>/real-photos/m-<ts>-<fp12>.<ext>` (`upsert`); без описания — vision `describePhoto` (stage 14), при неудаче файл удаляется, 502; insert `article_photos` (position = count+1, caption из `photo_search_config`, fingerprint/phash, ai_score…); `23505` → `duplicate`; `selected=true` | 115-211 |
| `topup` | `status=pending`, снятие захватов и отметки `photo_reviewed_*`, курсор `{current_invocation:1, rp_resume_filter, photo_topup_after_rating, photo_review_topup}`, стадии 12/13 → `pending`, wake оркестратора. **Без** `.eq("status","photo_review")` | 213-227 |
| `approve` | ≥15 фото (`MIN_PHOTOS`), у каждого `facts` или `description`; renumber; удаление `article_sections`, `article_drafts`, `outfits`, стадий `DOWNSTREAM_STAGES`; стадия 14 `completed {human_reviewed, reviewed_by}`; перезапись `photo_usage_fingerprints` проекта (fingerprint, phash, site_id, keyword_norm = `normalizeKeyword(resolveSearchKeyword)`); CAS `photo_review → pending`, `current_stage=15`, курсор `{current_invocation:2, photo_review_approved:true}`, `photo_reviewed_by/at`; wake | 229-270 |
| `mark_insufficient` | CAS `photo_review → insufficient_photos` + поля причины | 64-73 |

`photo_moderation_events (user_id, queue_id, site_id, action)` — только действия человека (`!asAi`): `claim, skip, remove, remove_dated, reorder, add, topup, approve, insufficient` (`:52-62`). Ошибки — `pipeline_errors (source=photo_moderation, stage=14)` через `logErr` (`:279-288`). Проверка «фото уже использовано другим сайтом» делается не здесь, а в `stage-photo-select` по `photo_usage_fingerprints` (`stage-photo-select:386-404`).

---

## 5. `ai-photo-moderate`

### 5.1 Действия и доступ

- `process` (service key): один шаг воркера, ответ сразу, работа в `waitUntil` (`:37-45`).
- `watchdog` (service key **или любой авторизованный пользователь**, `:49`): перезапуск запусков с `heartbeat_at` старше 3 мин (`applying→proposed`, удаление `processing`), затем автозапуск по сайтам (§2.3).
- Остальные — JWT; сотрудник должен иметь `allowed_pages ∋ "ai_moderation"` (`:109-110`) и `can_access_site`.
- `start` (`site_id`, `limit` ≤5000, `mode` auto/test, `queue_ids`): свободные `photo_review`, `undecided`, `ai_moderation_runs {model:"mix3", concurrency: sites.ai_mod_concurrency||20}`, захват статей на 30 дней (`FAR_CLAIM`), старт воркеров (`:113-143`).
- `compare`: тот же набор фото другой моделью (`gemini-3.1-pro-preview`, `gemini-2.5-pro`, `gemini-3-flash-preview`, mix/mix2/mix3), без применения, 5 воркеров (`:145-164`).
- `stop`: `status=stopped`, снятие захватов с необработанных (`:166-172, 262-268`).
- `resolve` (`op`: `approve|human|insufficient|exclude`, одна запись за вызов): применение в фоне, ответ через ≤100 с (`:174-190`).
- `rerun`: старые предложения → `superseded`, новый запуск `auto` (`:192-213`).
- `insufficient_action` (`return|topup`) — § 1.3.

### 5.2 Воркеры и пачка

`PARALLEL=20` (`:248`), `startWorkers` стартует `min(concurrency, n)` цепочек `process` (`:257-260`). `processNext` (`:281-334`): heartbeat; в `auto` — сначала применить одно `proposed` (CAS → `applying`), `op` = `confidence<75 ? human : decision==approve ? approve : decision==insufficient ? insufficient : human`; удалить `processing` старше 6 мин; взять следующую статью атомарной вставкой `ai_moderation_results (run_id, queue_id) status=processing` (уникальность); `reviewArticle`; обновить `processed`/`cost_usd`; пауза 1 с; chain. Запуск `done`, когда нет `processing/applying` (и `proposed` для auto).

### 5.3 `reviewArticle` (`:372-633`)

- Пропуски: статья не `photo_review`; есть решение `approve|human|insufficient` в другом запуске или ≥2 оплаченных `error` → `status=excluded` без оплаты (`:390-400`); без фото → `insufficient` confidence 100 (`:426-431`).
- Данные: `needed=count_outfits||15`, `minOk=min(needed,15)`; текущие `article_photos`; резерв из `photo_candidates tech_status=ok, selected=false` до 400 по `ai_score`: ≤25 `keep` + ≤15 `reject` без `HARD_REJECT`-причин (`:17-18, 434-437`); trend brief; 3 случайных эталона `photo_reference_set status=selected` по нише; проверка живости превью через weserv 256 px (`:24, 447-459`).
- Модели: дешёвая `google/gemini-2.5-flash-lite` (`MODEL`, `:13`), «средняя» `google/gemini-3-flash-preview` для финальных/флэш-проходов (`:485`); все через `callGemini(provider:"openrouter")`, `responseFormat:"json"`, `temperature 0.1`, `maxTokens` 12000/3000, `timeoutMs` 150/60 с, 2 попытки × `retries:1`, контекст `stage:140, stageName:"ИИ публикация статей (<pass>)"` (`:483-504`). **Промты зашиты в код** (`sysA/sysB/sysC`, `V2_REASONS`, `focusRules`), наборы промтов (`stage_key`) не используются; `stage 140` — только метка в `generations_log`.
- Режимы (`run.model`, дефолт `mix3`): legacy 3-pass (тема+подлинность ∥ привлекательность, затем ревизор, `:527-561`); `mix2` (`:708-828`: lite тема по S, flash мнение по S+эталоны, lite резерв порциями по 15, flash финал по спорным+резерву); `mix3` (`:831-934`): резерв ≤15; параллельно lite A (S+R) и flash M (S+R+эталоны); удаление: `duplicate` по M; «жёсткая» причина M, подтверждённая A → drop, иначе спор; `weak_pin`: score<35 drop, ≥50 keep, иначе спор; второй flash-вызов только если споров >2 или доля удалений >35 % (подтверждение); резерв: `ok` у обеих, добор до `needed` при score≥50, иначе ≥max(70, средний); ≤`MAX_ADDS=12`; порядок: топ-5, затем чередование сильных/обычных.
- Правило согласия (`:563-574`): убрать неотмеченное фото можно только как дубль или по `hardRe` (аудитория, фигура, пол, дети, ИИ, невеста…); добавить — только `okReserve`.
- **Вердикт из фактов** (`:601-621`): `decision = final ≥ minOk ? approve : insufficient`; → `human`, если модель сказала `human`, если `insufficient` и удалено > половины, если `approve`, а модель — `insufficient`, если доля удалений >30 %, если «проверки расходятся» (overturned/flagged >0.5), если ≥3 «поздних» жёстких нарушений; `confidence` режется до 70/74 в этих случаях. Сохраняется `ai_moderation_results {decision, confidence, photos_before/after, original_ids, removed, added, final_order, review{…}, summary, status=proposed, cost_usd}`.
- Применение `resolve` (`:647-702`): `exclude` → снять захват, `excluded`; `insufficient` → `mark_insufficient` с `ИИ: summary`; `approve|human` → удаления пулом 5, добавления пулом 5 с дедлайном 100 с, `reorder`, при `approve` проверка ≥15 фото → `approve`, иначе `sent_to_human`; ошибки → `failed` + снять захват. Все изменения — только через `photo-review-action` с `acting_user_id = photo_review_claimed_by || created_by`.
- Стоимость: сумма `costUsd` всех попыток всех проходов (`:487, 495, 562`), в `review.pass_costs`; документация оценивает ≈$0.035/статья (mix3); константа `MAX_PUBLISH_BACKLOG=30` не используется (`:14`).
- Ошибки → триггер `log_ai_moderation_error` (`schema.sql:534-552`) в `pipeline_errors (source=ai_moderation, stage=140)`, служебные тексты отфильтрованы regex.

---

## 6. Публикация

### 6.1 `publish-worker` (cron каждую минуту + каждый тик оркестратора + UI)

1. Синхронизация оборванных: черновики `publish_state=publishing` с `review_status=published` и `wp_post_id` → `published`, очередь `completed` (`:58-80`).
2. Освобождение зависших `publishing` > 10 мин (`:83-93`).
3. Досинхронизация Google-таблицы для 5 `completed` с `sheet_row` и `sheet_sync_state in (null,error)` (`:96-105`).
4. Кандидаты: `article_drafts.publish_state in (queued, retry)`, `publish_next_attempt_at ≤ now`, по возрастанию, ≤200; фильтр `project_ids` (≤20) (`:108-116`).
5. Лимит на сайт: `sites.max_publish_concurrent` (1..5, дефолт `PER_SITE_LIMIT=1`), считая уже `publishing`; `MAX_PER_TICK=4` (`:124-155`).
6. `publishOne`: CAS захват → `status=publishing`; при `moderation_excluded_photos>0` → `apply-review-exclusions`; если качество не проверялось <6 ч и фото ещё не грузились → `stage7-publish-wordpress {phase:"prepare"}` (`repairing` → назад в `queued` через 60 с); затем `stage7-publish-wordpress {approve:true, category_id}`; успех → черновик `published`, очередь `completed`+`wp_url`, sheets `write publish` (`:157-257`).
7. Ошибки (`:258-320`): `PARTIAL_UPLOAD` или таймаут с прогрессом (свежая проверка качества или выросло число загруженных фото) → `retry` через 30 с, попытка не считается; «Сайт не принимает загрузку фото» → `retry` через 20 мин, `publish_error_kind=site_media_down`; иначе `classify` → `transient` (408/429/5xx/timeout/network…, ≤`MAX_ATTEMPTS=6`, backoff `[1,3,5,10,15]` мин) или `permanent` (401/403/404/`rest_*`/quality/`not found`/`WP_CREDENTIALS_MISSING`/`QUALITY_BROKEN`) → `error`/`publish_error`. `humanize` — русские тексты ошибок.
8. `invoke` с `AbortSignal.timeout(140 с)`; вся работа в `EdgeRuntime.waitUntil`, ответ `accepted` (`:323-335`), либо `wait:true`.

### 6.2 `stage7-publish-wordpress`

Вход `{projectId, approve, skipQualityCheck, category_id, phase}`.
1. Проект + сайт, черновик с `full_html` (иначе ошибка «No assembled HTML»); нет `wp_rest_url/wp_username/wp_app_password` → стадия 78 `failed WP_CREDENTIALS_MISSING`, `blocked` (`:30-65`).
2. `buildWpBaseCandidates`: нормализация к `https://…/wp-json`, второй кандидат www/без-www (`:599-625`).
3. Проверка качества `runQualityCheck(autofix)` — если не `skipQualityCheck`, не проверялась <6 ч (`quality_checked_at`, не `broken`) и ещё ни одно фото не загружено; `broken` → `repairQualityIssues` (`stage77-generate-seo-meta`, `stage7-write-sections forceRewrite` для коротких, уникальные `h2_heading`, `stage7-assemble-html excludeOutfits`) → `repairing`; иначе `review_status=broken`, стадия 78 `QUALITY_BROKEN`, `blocked` (`:70-118, 521-580`).
4. Режим публикации `projects.publish_mode`: `auto` / `moderate_first` (черновик на сайте, пока не `approve`) / `publish_then_edit` (дефолт) → `status: draft|publish` (`:120-127`).
5. Featured image: первое `generated_images` с `wp_media_id` по `article_position` (`:130-136`); для реальных фото — первое загруженное по позиции (`:334-340`).
6. `postBody`: `title=h1_title||project.name||focus_keyword`, `content=full_html`, `slug=url_slug||slugify(focus_keyword)`, `status`, `featured_media`, `meta._yoast_wpseo_title/_yoast_wpseo_metadesc/_yoast_wpseo_focuskw` (`:138-159`).
7. Категория: `body.category_id` → `article_queue.wp_category_id` → `resolveCategory` (правила сайта `category_rules` по подстрокам → ИИ `gemini-2.5-flash-lite` по списку ≤200 категорий, если `category_ai_enabled !== false` → `default_category_id`); категории кэшируются в `sites.wp_categories` (`fetchWpCategories`: `GET {base}/wp/v2/categories?per_page=100&page=N&_fields=id,name,slug,parent`, до 20 страниц); результат пишется в очередь (`:161-193`; `_shared/wpCategories.ts`).
8. `phase:"prepare"` → ответ `prepared`. Если на подготовку ушло >45 с и качество проверялось — `throw PARTIAL_UPLOAD` (`:197-204`).
9. Загрузка реальных фото (`article_photos` по `position`): уже загруженные (`wp_media_id && wp_url`) — только замена URL в HTML; остальные: `fetchCompressedImage` → `POST {base}/wp/v2/media` (`Authorization: Basic base64(user:app_password)`, `Content-Disposition: attachment; filename="<file_name|photo-N>.<jpg|png|webp>"`, `Content-Type`, 25 с), фолбэк на второй base, одна повторная попытка через 3 с при 5xx/abort (если <50 с); `POST media/{id}` `{alt_text, title, caption}`; `article_photos.wp_media_id/wp_url`; замена `public_url → source_url` в HTML. 2 параллельных воркера; бюджет 45 с от начала загрузки и 75 с от старта; `mediaDown` = 4 подряд 5xx при 0 загруженных → `WP_MEDIA_DOWN`; остались незагруженные → `PARTIAL_UPLOAD` (или «ни одного»). Не загрузившиеся фото остаются с публичной ссылкой хранилища (`:206-348`).
10. **Поиск поста по slug**: `GET {base0}/wp/v2/posts?slug=…&status=publish,draft,pending,future&_fields=id` (10 с); найден → обновление вместо создания (`:355-371`).
11. `POST {base0}/wp/v2/posts` или `/posts/{id}`; заголовки `Content-Type/Authorization/Accept/User-Agent: Mozilla/5.0 (compatible; StyleSparkPublisher/1.0)`; таймаут `max(30 с, 125 с − прошло)`; `extractWpErrorMessage` (`:373-404`).
12. Обновление черновика (`wp_post_id/url/status`, `published_at`, `review_status` = `pending` для черновика на сайте / `published` при auto или approve / иначе `pending`, `current_step=7.8`, `status=completed`, при `approve` — `publish_state=published`); при `approve` очередь `completed` + `cleanupProjectPhotos`; `projects.stage7_status=completed`; sheets-sync `write draft|publish` с фиксацией `sheet_sync_state`; стадии 78 и 7 `completed` (`:406-514`).

Документация упоминает «переиспользование медиа по маркеру photo-ID в имени файла и поиск в медиатеке после таймаута/5xx» — в коде этого **нет**: переиспользование только по `article_photos.wp_media_id`; при обрыве после загрузки, но до записи в БД, фото загрузится повторно.

### 6.3 `_shared/compressImage.ts`

`COMPRESS_MAX_SIDE=1600`, `COMPRESS_QUALITY=90`. Порядок: Supabase Storage render (`/storage/v1/render/image/public/...?width=1600&height=1600&resize=contain&quality=90`) → `images.weserv.nl/?url=…&w=1600&h=1600&fit=inside&we&output=jpg&q=90` → оригинал. Результат принимается только как `image/jpeg`; для JPEG-исходника — только если меньше исходника; PNG/WebP конвертируются обязательно; ≥2048 байт; таймауты 20 с. В Node — заменить на `sharp` локально.

### 6.4 `resolve-wp-category`, `sync-wp-categories`, `apply-review-exclusions`

- `resolve-wp-category {queue_id|project_id, apply_to_wp}`: `resolveCategory`, запись в очередь, при `apply_to_wp` и наличии `wp_post_id` — `POST posts/{id} {categories:[id]}` (`:15-78`). Без авторизации. Ошибки возвращаются с HTTP 200.
- `sync-wp-categories {site_id}`: `fetchWpCategories` → `sites.wp_categories`, `wp_categories_synced_at` (`:15-30`). Без авторизации.
- `apply-review-exclusions {project_id}`: исключённые `outfits.excluded=true` → секции `status=excluded`, удаление `article_photos` по `outfit_id`, перенумерация заголовков «N. …», `renderCount/retargetCount` для `h1/seo_title/meta_description`, `total_sections`; `stage7-assemble-html {excludeOutfits:true}`; `excluded_outfits_count`; если пост уже на сайте — `stage7-publish-wordpress {approve:true, skipQualityCheck:true}` (`:20-125`). Без авторизации.

---

## 7. Очистка

### 7.1 `cleanup-published-articles`

- Cron: заголовок `x-cleanup-token` сверяется с `cleanup_tokens(id='nightly').token` (`:135-138`); `cutoff = now − 24 ч`; владельцы = `projects.user_id` с `stage7_status=completed` (≤5000); для каждого ≤200 подходящих проектов; бюджет 80 с; самовызов `chain` ≤60 раз с паузой 1.5 с, если `more && deleted>0` (`:139-164`).
- Критерии (`isFinalPublication`, `:19-34` и запрос `:41-58`): `draft.status=completed`, `review_status=published`, `publish_state=published`, `wp_post_status=publish`, числовой `wp_post_id`, непустой `wp_post_url`, `published_at < cutoff`, нет `publish_error`, нет `publish_lock_id`, `moderation_flag ∉ {needs_rework, flagged}`, `article_queue.status=completed`, `projects.stage7_status=completed`.
- Удаление (`cleanupOne`, `:88-124`): `article_queue` (только `completed`), `generations_log` проекта (теряется история расходов — документация это признаёт), `photo_usage_fingerprints` проекта (**теряется межсайтовая защита от повторов фото**), `projects` (каскад по FK), Storage-пути `generated_images/alternative_images/mistake_images/article_photos`, не упомянутые в `full_html`, пачками по 100.
- Ручной режим: только владелец (не `team_members`), `count` / `clean limit≤20`, бюджет 90 с (`:167-200`).

### 7.2 `cleanup-published-photos` / `_shared/cleanupPublishedPhotos.ts`

- Только service key (`cleanup-published-photos:8-10`); `cleanupBacklog(40 с)`: все `completed` проекты (до 20000), их `article_photos` с `storage_path` и `wp_url` пачками 50×1000; исключая фото из `photo_reference_set.source_photo_id`; `storage.remove`, затем `storage_path=null, public_url=wp_url` (`cleanupPublishedPhotos.ts:8-63`).
- Точечно сразу после публикации с `approve` — `cleanupProjectPhotos` (`stage7-publish-wordpress:444`), только если очередь уже `completed`.
- Чистятся только `article_photos` (формат `real_photo`); оригиналы `generated_images` до ночной очистки не трогаются.

---

## 8. Служебные функции

### 8.1 `telegram-notify`

Вход `{site_id, type, …}`; боты из `telegram_bot_sites ⋈ telegram_bots (bot_token, chat_id, bot_name, is_active, show_cost, notify_completed)`; `POST https://api.telegram.org/bot<token>/sendMessage` `{chat_id, text, parse_mode:"HTML", disable_web_page_preview:true}` (`:37-85`). Без авторизации, без таймаута fetch.

| type | Отправитель | Поля / формат |
|---|---|---|
| (пусто) — ошибка | `notifyTelegram` в оркестраторе/direct-pipeline (поле `error_message`; сторож шлёт `error` — в шаблоне не читается, см. §10) | «🚨 Ошибка в очереди», сайт, keyword, stage, error (≤500), project |
| `review_ready` | direct-pipeline INV5, `completeItem` | «📋 Готово к ревью», статистика `photos_for_review`, `blocks_no_text`, `fallback_images`, сводка смен провайдера из `generations_log` (`%FALLBACK%`) |
| `completed` | `notifyTelegramComplete` (legacy, в direct-пути не вызывается) | «✅ Статья готова!», URL, стоимость (если `show_cost`), минуты, `stage_errors`; пропускается при `notify_completed=false` |
| `provider_fallback` | не найден вызывающий (мёртвый тип) | «🔄 Provider Fallback» |

### 8.2 `sheets-sync`

Шлюз **Lovable** `https://connector-gateway.lovable.dev/google_sheets/v4` с `LOVABLE_API_KEY` + `GOOGLE_SHEETS_API_KEY` (`:10, 46-51`) — в Node заменить на Google Sheets API напрямую. Повторы 5× на 429/5xx с `retry-after`/экспонентой (`:55-78`). Вкладка = домен сайта (`site_url|wp_rest_url|name`, `:155-164`). Колонки по заголовкам (`COLUMNS`, `:12-27`): keyword, seo keyword, focus keyword, сценарий, url draft, data draft, publish url, data publish, статус, год в url, гео, язык, свежесть, режим.
- `read {site_id, sheet_url?}`: читает `A1:Z2000`, создаёт колонку «Статус», возвращает строки (`sheet_row`, ключи, `scenario_number`, `year_in_url` 0..100, `photo_geo` 2 буквы, `photo_language`, `photo_freshness` y/m/w/any, `pipeline_mode` 2/1/null); сохраняет `sites.sheet_url` (`:175-233`).
- `mark {site_id, rows[] | queue_id, status}`: пишет статус (`в работе|черновик|опубликовано|ошибка`) в колонку «Статус» (`:236-276`).
- `write {queue_id|project_id, kind: draft|publish, url}`: ссылка + дата `YYYY-MM-DD HH:MM` + статус в строку `sheet_row`; результат в `article_queue.sheet_sync_state/error` (`:278-348`). Ошибки — HTTP 200 с `error`.

### 8.3 `check-api-key`

Вход `{integrationIds[]}` без авторизации; читает `integrations.encrypted_api_key, config` (поле используется **как открытый ключ**, `:182`). Проверки (`:51-156`): `openai` — `GET /v1/models`; `laozhang`/`poyo` — `/v1/models` + `/dashboard/billing/subscription` (`hard_limit_usd`); `openrouter` — `GET /api/v1/key` (`limit`, `usage`, `limit_remaining`, `label`); `dataforseo` — `POST /v3/appendix/user_data` Basic `login:password` из `config`, `status_code 20000`, баланс `money.balance`; `perplexity` — `chat/completions` `sonar` `max_tokens 1` (429 = валиден); `serpapi` — `GET /account?api_key=` (`total_searches_left`); `deepl` — `/v2/usage` (`:fx` → api-free), символы. Таймаут 20 с. Пишет `last_check_status/message/at`, `balance_value/currency/checked_at`, `usage_used/limit`.

### 8.4 `manage-team-member`

Владелец = авторизованный пользователь, **не** состоящий в `team_members` (`:31-40`). Действия: `create` (auth user через `admin.createUser(email_confirm)`, запись `team_members {owner_id, member_user_id, email, display_name, allowed_pages (дефолт ["dashboard","workflow"]), allowed_sites|null}`, откат при ошибке), `update` (`allowed_pages`, `display_name`, `is_active`, `allowed_sites` по `owner_id`), `update_password`, `provision_auth` (создать/привязать auth-пользователя к записи без `member_user_id`, поиск через `listUsers`), `delete` (удаляет запись по `owner_id`, затем `auth.admin.deleteUser(body.member_user_id)` **без проверки принадлежности**, `:168-179`).
Права на страницы — фронт `useAuth.canAccessPage(pageKey)` (`src/hooks/useAuth.tsx:62-67`): владелец — всё; сотрудник — `allowed_pages.includes(key)`. Серверно проверяется только `ai_moderation` (`ai-photo-moderate:109-110`) и «не сотрудник» в `reference-candidates`, `cleanup-published-articles`, `manage-team-member`. Доступ к сайту — RPC `can_access_site`/`get_allowed_sites` (`schema.sql:122, 294`) по `team_members.allowed_sites`.

### 8.5 `test-wp-connection`

`{site_id, media_test}` без авторизации: `GET {wp}/wp-json/wp/v2/users/me` Basic → `{ok, name, roles}`; при `media_test` — загрузка 1×1 PNG в `/media` и `DELETE /media/{id}?force=true` (`:40-102`). Ответы всегда HTTP 200.

### 8.6 `reference-candidates`

Только владелец; `niche_code`; удаляет старых `candidate`; берёт `photo_moderation_events action=approve` (≤5000) → статьи ниши владельца (≤400) → `article_photos position ≤2`; сортировка по `ai_score`, по одному фото с проекта в первом круге, затем вторые; до 50; `photo_reference_set upsert (owner_id, niche_code, image_url) status=candidate` (`:19-82`).

### 8.7 `_shared/cron-auth.ts`

`authenticateCronRequest` сверяет `Bearer` с `LOVABLE_CRON_SECRET(_PREVIOUS)` через sha256 + `timingSafeEqual`. В рассмотренных функциях **не вызывается** (cron-вызовы идут с anon key через `net.http_post`, `schema.sql:826-834`). Мёртвый модуль.

---

## 9. Зависимости от Supabase — список для замены

| Зависимость | Где | Замена в Node |
|---|---|---|
| `supabase-js` клиент с service role, `.from().select/update/upsert/rpc` | везде | Prisma |
| RPC `claim_orchestrator_lane`, `release_orchestrator_lane`, `claim_orchestrator_lock`, `claim_queue_item_lock`, `release_queue_item_lock` (`schema.sql:153-222, 727-776`) | оркестратор | не нужны (один воркер-процесс; захват job — `UPDATE … WHERE status='pending'` с `affectedRows`) |
| RPC `merge_pipeline_cursor` (`:601-622`) | direct-pipeline, оркестратор, photo-review-action, ai-photo-moderate | JSON-merge в коде внутри транзакции |
| RPC `acquire_service_slot`/`release_service_slot` + таблица `service_leases` (`:40-70`) | функции шагов через `serviceSlots.ts` | семафоры в процессе (`p-limit`) |
| RPC `set_queue_cron`, `get_queue_cron`, `set_queue_cron_auto_*` (`:468-502, 812-889`) + `pg_cron`, `pg_net` | оркестратор, UI «Автозапуск» | systemd-таймер/`setInterval` в воркере; флаг включения в БД |
| RPC `can_access_site`, `get_allowed_sites`, `get_team_owner_id`, `is_team_owner` | photo-review-action, ai-photo-moderate | функции доступа (аналог `src/lib/sites/access.ts`) |
| RPC `renumber_article_photos` (`:791`) | photo-review-action | один UPDATE/транзакция |
| RPC `delete_site_cascade`, `cleanup_photo_data`, `production_*_stats`, `get_cost_report*`, `site_autostart_diagnostics` | UI | Prisma-запросы |
| Триггеры `log_queue_error`, `log_publication_error`, `log_ai_moderation_error` (`:534-600`, `:3233-3247`) → `pipeline_errors` | ошибки | явная запись в коде (один helper) или триггеры MariaDB |
| Триггеры `auto_enable_queue_cron`, `auto_enable_site_phase` (`:72-121`, `:3219-3226`) | очередь | логика в воркере при постановке job |
| `sb.auth.getUser(token)`, `auth.admin.createUser/updateUserById/deleteUser/listUsers` | photo-review-action, ai-photo-moderate, cleanup-published-articles, reference-candidates, manage-team-member | сессии портала / `User`-модель |
| Storage bucket `generated-images` (`storage.from().upload/remove/getPublicUrl`, публичные URL `/storage/v1/object/public/...`, render API `/storage/v1/render/image/...`) | photo-review-action `add`, cleanup*, direct-pipeline fallback (`:791, 2146`), WorkflowRunner, compressImage | локальный `storage/` + nginx `/files/`, `sharp` для сжатия |
| `images.weserv.nl` как внешний прокси/ресайзер | compressImage, photo-review-action, ai-photo-moderate (превью для vision) | `sharp` + отдача своих превью |
| HTTP-вызовы функций друг друга `fetch(${SUPABASE_URL}/functions/v1/<name>)` с `Bearer service_key`, `AbortController` | все | прямые вызовы модулей |
| `EdgeRuntime.waitUntil`, 150/200-с лимиты, `Deno.env`, `npm:` импорты, `Deno.serve`, CORS | все | нет |
| `connector-gateway.lovable.dev` + `LOVABLE_API_KEY` | sheets-sync | Google Sheets API |
| `LOVABLE_CRON_SECRET` | cron-auth.ts | нет |
| Захардкоженные URL проекта и publishable key в SQL `set_queue_cron` (`:826-834`) | cron | нет |
| `supabase/config.toml` `verify_jwt` (в архиве — заглушка) | авторизация части функций | явные проверки в коде |

---

## 10. Слабые места (по коду)

Критичные:

1. **Нет замка на статью в `direct-pipeline`** (`direct-pipeline/index.ts:289-425`: только запись `locked_at`, никакого CAS). Параллельно одну статью могут запустить: сторож (`queue-orchestrator/index.ts:740-749`), rescue (`:369-373`), zombie (`:421-430`), chainSelf предыдущей инвокации, UI «Resume» через сторож, INV2 «захват следующей» (`direct-pipeline:938-959`). `chainSelf` при сетевой ошибке повторяет POST (`:166-170`), хотя первый мог дойти → две цепочки. Последствия: двойные вызовы ИИ (оплата), гонки курсора. Единственная защита — идемпотентность отдельных шагов (`runOneShot:1402-1410`, CAS в stage5-функциях).
2. **Сторож может крутить статью бесконечно**: «activity spare» (`queue-orchestrator:532-562`) сбрасывает `consecutive_errors=0` без лимита при любом `generations_log.status=success` за 5 мин; `markStageCompleted` и heartbeats stage5/6 тоже обнуляют счётчик (`direct-pipeline:220-223, 1973, 2103`). Зациклившийся шаг с успешными ИИ-вызовами никогда не упадёт — расход без предела.
3. **Дубли постов в WordPress возможны**: поиск по slug идёт только по `wpBases[0]` с 10-секундным таймаутом, ошибка молча игнорируется (`stage7-publish-wordpress:357-371`); если `url_slug` пуст, slug вычисляется `slugify(focus_keyword||name)` и может отличаться между попытками; при обрыве после создания поста, но до записи `wp_post_id` (`:375-432`), и неудачном slug-поиске следующая попытка создаст второй пост. Переиспользования медиа «по маркеру в имени» нет — фото грузятся повторно, если `wp_media_id` не успел записаться (`:294-296`).
4. **Статья может «потеряться»**: `recoverOrphanQueueItem` создаёт запись со `status="processing"` (`direct-pipeline:277`) — оркестратор продвигает только `pending`, сторожит только `running`; при обрыве цепочки такая статья зависает навсегда. Аналогично `stalled` и `needs_rework` не обрабатываются сервером (ожидаемо), а `cancelled` проверяется, но не ставится (`:322`).
5. **Безопасность `manage-team-member delete`**: `auth.admin.deleteUser(body.member_user_id)` без проверки, что этот `member_user_id` принадлежит удаляемой записи владельца (`manage-team-member/index.ts:168-178`) — любой «владелец» (любой пользователь, не являющийся сотрудником) может удалить произвольного auth-пользователя по id.

Серьёзные:

6. Функции без авторизации, работающие с service role: `test-wp-connection`, `check-api-key` (читает ключи интеграций), `resolve-wp-category`, `sync-wp-categories`, `apply-review-exclusions`, `telegram-notify`, `stage7-publish-wordpress`, `publish-worker`, `direct-pipeline`, `queue-orchestrator` (rescue для любого id). Защита целиком на `verify_jwt` в `config.toml`, который в архиве — заглушка. `ai-photo-moderate watchdog` доступен любому авторизованному (`:49`) и запускает платную авто-модерацию.
7. Секреты в открытом виде: `integrations.encrypted_api_key` используется как plaintext (`check-api-key:182`), `telegram_bots.bot_token` и `sites.wp_app_password` в таблицах и join-выборках (`telegram-notify:40`, `stage7-publish-wordpress:206`), publishable key и URL проекта зашиты в SQL (`schema.sql:826-834`).
8. Два определения «инфраструктурного сбоя» и два порога паузы сайта: оркестратор — 5 подряд (`:686`), `isSiteWideInfrastructureFailure` с мёртвой ветвью (`:287` возвращает false для `compute resources`, `:288` снова его проверяет); direct-pipeline — 3 подряд (`:1370`), `isInfrastructureFailure("")===true` (`:1348`) — пустая ошибка считается инфраструктурной. Логи говорят «3 consecutive failures», а условие — 5 (`:692`).
9. Пауза сайта пишет `error_message="Queue paused: …"` в каждую `pending` статью (`:693-697`, `direct-pipeline:1377-1381`) → триггер `log_queue_error` вставляет по строке в `pipeline_errors` на каждую (regex-исключения `schema.sql:586` этот текст не покрывают). То же для «Ожидает фото:» и «Мало фото:» — это статусы, а не ошибки.
10. Дедуп оркестратора переводит легитимную `pending` статью в `failed` («Duplicate…», «Skipped: … already completed», `:905-910, 953-957`); `ilike(keyword)` без экранирования `%`/`_` (`:950`).
11. `publish-worker` вызывается cron'ом **и** каждым тиком оркестратора (включая chain-тики каждые 3 с, `queue-orchestrator:324`) → параллельные тики; лимит на сайт считается по снимку (`:125-155`), CAS — только по черновику (`:160-165`) → лимит `max_publish_concurrent` может быть превышен. Детекция прогресса по regex `^timeout: stage7-publish-wordpress` (`:263`) хрупкая. Строки с `sheet_sync_state=error` без колонки для ссылки пересинхронизируются каждую минуту вечно (`:96-105`).
12. `photo-review-action topup` без условия `status='photo_review'` (`:215-219`) — можно сбросить бегущую статью; `approve` делает деструктивные удаления (`:238-243`) до CAS-обновления статуса (`:261-267`), без транзакции.
13. `ai-photo-moderate`: захват статей на 30 дней (`FAR_CLAIM`, `:19`); при сбое запуска без явного `stop` захваты снимаются только для обработанных с ошибкой (`:327-328`); для людей такие статьи невидимы (UI считает захват «протухшим» через 15 мин, но дата в будущем). `rerun` захватывает без проверки статуса (`:210`).
14. Stage 73: фатальная ошибка батча глушится, если есть `missing` (`direct-pipeline:2286-2287`), затем до 20 % пустых секций **удаляются вместе с фото** (`:2384-2393`) — статья публикуется короче плана без сигнала.
15. `direct-pipeline` INV2 «захват следующей статьи» (`:938-959`) обходит дедуп, billing-блок и auto-off сайта оркестратора, ставит `running` без `initItem` (источник «зомби»).
16. Billing-блок ставится только для OpenRouter и только по тексту ошибки (`direct-pipeline:1289-1291`, `billingGuard:33-43`); 402 другого провайдера → статья `pending` → немедленный повторный запуск.
17. `cleanup-published-articles` удаляет `photo_usage_fingerprints` проекта (`:113`) — через 24 ч после публикации фото снова может быть выбрано для другого сайта (противоречит назначению `stage-photo-select:386-404`).
18. Сторож шлёт в telegram поле `error` (`queue-orchestrator:706`), шаблон читает `error_message` (`telegram-notify:144`) → сообщение без текста ошибки.
19. Фронтовый `queueEngine`/`workflowEngine`/`stageRunners` — второй исполнитель того же конвейера из браузера, пишущий в `article_queue`/`workflow_stages` (`src/lib/queueEngine.ts:312-424`, `stageRunners.ts:588-595`); с серверным direct-pipeline он конфликтует (сторож через 5 мин перезапустит статью, которую ведёт браузер).
20. Нагрузочные мелочи: каждый тик — `ai-photo-moderate watchdog` + `cleanup-published-photos` (скан до 20000 строк) + `publish-worker`; idle-проверка читает до 20000 строк очереди и делает по UPDATE на сайт (`:812-840`); `pendingLite` 5000 строк каждый тик.

Мёртвый код: весь legacy-конвейер оркестратора (`findBestAction`, `isStageInGap`, `execStage*`, `cleanupCompletedItems`, `completeItem`, `callFnWithRetry`, `notifyTelegramComplete`, `resetStaleProcessing`, `HEAVY_STAGES`, `STAGES_PAST_IMAGE_GEN`, `MAX_MS`, `RETIRED_STAGES`), `execStage55` (не вызывается из `switch`), курсорный флаг `skip_71` (ставится, не читается), статус `cancelled`, `MAX_PUBLISH_BACKLOG` и тип `provider_fallback`, `_shared/cron-auth.ts`, три копии `parseKeyword` (оркестратор `:2903`, direct-pipeline `:2402`, `src/lib/parseKeyword.ts`), `claim_orchestrator_lock` (заменён lanes).

---

## 11. Рекомендации для порта на Node-воркер

**Оставить (бизнес-логика):**
- Машину состояний из §1.2/1.3, но урезанную: `pending → running → (photo_review | insufficient_photos | waiting_for_photos | review_pending | publish_queued) → publishing → completed | publish_error`, плюс `failed`, `paused`, `needs_rework`, `reviewed`, `stalled` (переименовать в `stopped`). Выбросить `processing`, `cancelled`.
- Две цепочки на сайт (фото / написание) с лимитами и выключателями, глобальный потолок, round-robin по сайтам, приоритет написания.
- Режимы 1/2, правила `MIN_PHOTOS=15`, гейт 70 %, пределы кругов добора, идемпотентность шагов через `workflow_stages`, откаты 72→2 и 65→(позиции).
- Billing-пауза (по провайдеру, по коду ответа, не по тексту), пауза сайта при серии инфраструктурных сбоев — одно определение и один порог.
- `photo-review-action` как единственный вход для изменения фото статьи (человек и ИИ), журнал `photo_moderation_events`, реестр `photo_usage_fingerprints` (не удалять при очистке).
- ИИ-модерация mix3 с вердиктом «из фактов», правило «не платить дважды», автозапуск пачками (20 / 30 мин / backlog).
- Публикация: проверка качества + авто-починка, категория (правила → ИИ → дефолт), поиск поста по slug **до** создания и запись `wp_post_id` сразу после ответа WP, повтор с backoff и классификацией ошибок, сжатие 1600/90 (через `sharp`), фолбэк на публичную ссылку.
- Очистка: оригиналы фото после `completed` с `wp_url` (кроме эталонов); ночное удаление статей старше 24 ч — но без удаления `photo_usage_fingerprints` и, желательно, без удаления истории расходов (достаточно агрегата).
- Telegram (события `error`, `review_ready`, `completed`), Google Sheets (read/mark/write) напрямую через Google API.

**Выбросить как костыли под Supabase:** lanes/замки оркестратора, `chainSelf` и номера инвокаций, бюджеты `hasTime*`, heartbeat через `locked_at`, сторож со «спасениями», zombie/rescue, трактовка 504, `waitUntil`, `set_queue_cron`/idle-off cron, `service_leases`, фазу `prepare`/`PARTIAL_UPLOAD`, вызов publish-worker/cleanup/ai-watchdog из тика, `cron-auth.ts`, Lovable-шлюз таблиц, legacy-конвейер и фронтовые движки (`queueEngine`, `workflowEngine`, `stageRunners`).

**Модель очереди:** один job на статью (`ArticleJob`) с полем `stage` (курсор — текущий шаг и данные шага в JSON), а не job на стадию. Причины: конвейер строго линейный, стадии зависят от общей сущности (`project`), откаты «назад» (65→5, 72→2, добор фото 13→12) естественны внутри одного job, лимиты считаются по статьям, а не по стадиям. Воркер: процесс держит пул `N` одновременных статей (общий `max_concurrent`), выбирает `pending` с учётом лимитов сайта/фазы (`SELECT … FOR UPDATE SKIP LOCKED` или CAS `UPDATE … WHERE status='pending'`), выполняет шаги последовательно с длинными таймаутами, после каждого шага сохраняет `stage`+курсор транзакционно; «зависание» — только по реальному таймауту шага внутри процесса, при падении процесса — восстановление по `startedAt` при старте воркера (как lease в `worker/domains.ts`). Внешние лимиты (DataForSEO, OpenAI, WP) — семафоры в процессе.
Отдельные типы job: `PublishJob` (своя очередь с backoff и лимитом на сайт, как сейчас `publish-worker`), `AiModerationRun` (запуск → подзадачи по статьям пулом `concurrency`, применение решений в том же процессе), `Cleanup` (таймер в воркере). Ручные действия (модерация фото/статьи, стоп/возобновление) — server actions, меняющие статус job; воркер подхватывает `pending`.
Для `article_queue.error_message` завести отдельное поле `note` (информационные сообщения) и писать в `pipeline_errors` только настоящие ошибки одним helper'ом.
