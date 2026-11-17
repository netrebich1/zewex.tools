# Автозапуск сайтов (экран + логика воркера)

Исполнитель: automation. Статус: написано, типы не проверялись (на Mac нет Node) — **первым делом `tsc --noEmit` и `tsc -p tsconfig.worker.json` на сервере**.

## Что сделано

| Файл | Что | Откуда |
|---|---|---|
| `src/lib/articles/automation.ts` | `loadArtSettings`/`saveArtSettings` (singleton `ArtSettings` id="main", дефолты при отсутствии строки), счётчики `AutostartCounts`/`countBucket`/`emptyCounts`/`addCounts`, `ownerSlots` (кэш доступности слотов владельца сайта на 60 с) + `missingSlots`, `autostartDiagnostics(site, counts, settings, worker)` — чистая функция текста «что мешает сейчас», `siteAutostartRows(me, global?)` (сайты по `artSiteWhere` + 5 `groupBy`/`count` одним `Promise.all`), `automationPayload(me)`, `canEditGlobalSettings` (ADMIN или `leadTeamIds.length > 0`), `validateSitePatch` (лимиты 1..50, batchFrom 1..200, concurrency 1..50, backlogThreshold 0..1000), `applySitePatch`, `patchSiteAutomation` | `SitesAutostartPage.tsx` (counts, blockers), `site_autostart_diagnostics()` (review_ai_done/untouched, published_24h), `queue-orchestrator:779-840` |
| `src/app/api/articles/automation/route.ts` | GET — `AutomationPayload`; PATCH `{siteId, patch}` / `{all: true, patch}` / `{global}`; ответ всегда свежий payload. Доступ: `canAccessArtSite`; `all` — по видимым сайтам; `global` — только админ/лидер | — |
| `src/components/articles/AutomationTable.tsx` | Клиентский экран: 8 плиток (`kpi`), легенда, плашка воркера + мастер-выключатели + общий потолок, таблица `min-w-[1560px]` в карточке с горизонтальной прокруткой, строка «Все сайты» (переключатели → панель подтверждения, без `window.confirm`), строки сайтов (Switch сохраняет сразу, `NumInput` — по blur/Enter, внешние обновления не перетирают поле в фокусе), пометка «простой/вручную» под выключенной цепочкой, автообновление 30 с (пауза во время сохранения) | `SitesAutostartPage.tsx` 1:1 по колонкам, с правкой владельца: «Ждать, если в публикации ≥» в группе «Проблемы», одна колонка «Пауза / ошибка» |
| `src/app/(app)/pinterest/articles/automation/page.tsx` | Серверная страница с первичными данными | — |
| `src/components/articles/ArticlesNav.tsx` | Пункт «Автозапуск» после «Обзора» (пункт «ИИ-модерация» добавляет сосед — я его не трогал) | — |
| `src/app/(app)/pinterest/articles/page.tsx` | Кнопка «Автозапуск всех сайтов» в `PageHeader actions` | — |
| `src/lib/articles/types.ts` | В `ArtSiteSettings.autostart` добавлены необязательные `photoOffReason`/`photoOffAt`/`photoIdleSince`, `writingOffReason`/`writingOffAt`/`writingIdleSince` (единственная правка типов; `mergeSiteSettings` пропускает их через spread) | `sites.auto_*_off_reason`, `*_idle_since` оригинала |
| `worker/articles/queue.ts` | `claimArticle`: мастер-выключатели `ArtSettings` гасят фазу на всех сайтах; `maxConcurrent > 0` — потолок RUNNING с живой арендой по всем статьям; round-robin по сайтам (`orderCandidates`: фаза → номер кандидата внутри сайта → меньше бегущих у сайта → порядок очереди); кэш правил сайта и счётчиков фазы в транзакции | `queue-orchestrator:779-805` (siteLimit, globalCap, «берём по каждому сайту») |
| `worker/articles/autostart.ts` | `autostartTick(now?)` раз в минуту: auto-restart и idle auto-off для сайтов с `autoRestart`; в лог — только изменения | триггер `auto_enable_site_phase` (`schema.sql:95-115`), `queue-orchestrator:807-840` |

## Экспорты `worker/articles/autostart.ts`
- `autostartTick(now = new Date()): Promise<AutostartTickResult>` — подключить в `worker/cron.ts`: `setInterval(() => autostartTick().catch((e) => log.warn("articles autostartTick failed", e)), 60_000)`.
- `IDLE_OFF_MS` (15 мин), тип `AutostartTickResult = { enabled, disabled, idleStarted }`.

## Решения
- **Auto-restart не включает цепочку, выключенную вручную** (`offReason = "manual"` ставит переключатель на экране «Автозапуск»; см. `applySitePatch`). Это поведение оригинала (триггер проверял `off_reason = 'idle'`): иначе ручное выключение откатывалось бы через минуту при наличии PENDING. Цепочка, выключенная в `SiteSettingsForm` (без причины), включается — там так и написано в подсказке.
- Для idle auto-off «написание» = фазы writing + publish + статусы PHOTO_REVIEW/INSUFFICIENT_PHOTOS (как в оригинале). Отсчёт — `*IdleSince` в настройках сайта; начало отсчёта в лог не пишется.
- «Ждут публикации» = PUBLISH_QUEUED + REVIEW_PENDING + PENDING@publish; «сейчас» публикации (PUBLISHING + RUNNING@publish) показывается мелким текстом под числом и в диагностике. NEEDS_REWORK и COMPLETED в счётчики не входят.
- «Воркер не отвечает» = нет ни одного RUNNING с живой арендой во всей таблице и у сайта есть PENDING старше 3 мин (по `updatedAt`, `nextRunAt` наступил) в фазе, которая включена и не заглушена мастером. Состояние воркера считается по всем статьям, не по видимым — воркер общий.
- Проверка ключей: по владельцу сайта (`createdById`); слоты цепочки «фото» — text_fast, vision, (photo_dfs или photo_serp); «написание» — text_fast, text_main (формат «реальные фото»; image_main для генерации не проверяется). Если владелец не задан — проверка пропускается.
- «Ждёт пачку ИИ-модерации: X из Y» — X = PHOTO_REVIEW с `aiRunId = null`; «ИИ проверяет сейчас» — есть `ArtAiModerationRun.status = "running"` по сайту. Логику самого автозапуска ИИ-модерации (пачка/30 мин/бэклог) здесь не реализую — зона соседа (`moderation/ai`).
- Глобальный `maxConcurrent` в воркере считается по RUNNING с живой арендой (как и лимиты фаз), а `ARTICLES_WORKER_CONCURRENCY` по-прежнему ограничивает процесс.
- Диапазоны лимитов на этом экране 1..50 (как в оригинале); `SiteSettingsForm`/`saveArtSiteSettings` соседа режут 1..20 — при сохранении формы сайта большее значение ужмётся. Согласовать при желании.

## Не сделано / открытые вопросы
- «Очистка опубликованных материалов» (экран 11 спецификации) — не на этом экране; cron уже чистит (`worker/cron.ts`).
- Нет «Следующей попытки публикации» и «хостинг не принимает фото» из `site_autostart_diagnostics` — в нашей модели нет `publish_error_kind`/`publish_next_attempt_at`; есть только PUBLISH_ERROR в «Пауза / ошибка».
- `saveArtSiteSettings` (сосед) пересобирает `autostart` из полей формы и теряет служебные `*OffReason/*IdleSince` — некритично (цепочка просто считается выключенной без причины, auto-restart её включит).
- Проверить на сервере: `prisma.artSettings` (клиент сгенерирован после добавления модели?), `satisfies` в `FIELDS` (TS ≥ 5.0), `Prisma.TransactionClient` в `queue.ts`.
