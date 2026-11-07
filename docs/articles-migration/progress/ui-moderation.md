# UI сервиса «Статьи»: модерация, публикации, рецепты, журнал

Исполнитель: UI-модерация (волна 1). Ничего не коммичено и не деплоено; tsc не запускался (на Mac нет Node) — проверить на сервере в копии `/root/zewex-check`.

## Что сделано (файл → исходник)

| Файл | Что | Исходник |
|---|---|---|
| `src/lib/articles/moderation.ts` | Единственная точка изменения фото статьи и решений модерации: `claimArticle/releaseClaim/skipArticle/nextForReview/activeClaims/waitingCounts`, `photoState` (фото + резерв + отклонённые + счётчики), `excludePhoto/markOutdated/restorePhoto/reorderPhotos/addFromReserve/removePhoto`, `approvePhotos/requestTopup/markInsufficient/returnToReview`, модерация статьи `reviewState/updateReviewFields/approveArticle/reworkArticle`, публикация `retryPublish/retryAllPublishErrors`. Все с `canAccessArticle`, CAS по статусу (`updateMany` + ожидаемый статус → `ModerationError(409, stale)`), каждое действие пишет `ArtModerationEvent` | `supabase/functions/photo-review-action/index.ts` (claim :75, release :93, remove :99, reorder :109, add :115, topup :213, approve :229, mark_insufficient :64), `reorder-article-sections/index.ts` (секции едут с фото, заголовки «N. …»), `apply-review-exclusions/index.ts` (снятые на модерации статьи фото удаляются с секциями, нумерация, пересборка), `ModerationPage.tsx` (needs_rework), `PublicationsPage.tsx` (retry) |
| `src/app/api/articles/moderation/route.ts` | JSON API сетки: GET `?article=` / `?next=1&mode=photos|articles|rework&site=&exclude=` / `?claims=1`; POST `{action, articleId, …}` → свежее состояние | — |
| `src/actions/articlesModeration.ts` | Server actions для форм: approvePhotos/topup/insufficient/returnToReview/skip/approveArticle/rework/retryPublish/retryAll + журнал: `resolveErrorGroupAction`, `requeueErrorGroupAction` | ErrorsPage.tsx (вернуть в работу / устранено) |
| `src/components/articles/PhotoModerationGrid.tsx` | Клиентская сетка (экспорт `PhotoModerationGrid`, `moderationApi`, `useGridSize`, `LAYOUTS`): «В статье» (номера, HTML5-drag, двойной клик — лайтбокс с оригиналом, ✕ / «Устарело» / «Вернуть», бейджи ★/размеры/домен/«нет описания»), «Резерв» (табы Одобрены ИИ / Отклонены ИИ, фильтр формы, 📌 виральность, ✨ тренд, причина, «+», показ по 60), 3 размера в localStorage на пользователя, раскладки в меню, «Отменить» (стек обратных действий, Ctrl+Z), клавиши Enter/←/→/Esc через пропсы | `PhotoModerationPage.tsx` (раскладки :199-230, размеры, табы запаса) |
| `src/components/articles/PhotoModerationPipeline.tsx` | Конвейер «следующая свободная статья»: sticky-шапка (ключ + 🇷🇺 перевод, сайт, план, «В статье X / нужно ≥ M» с подсказкой, тренды, Одобрить и писать / Добрать фото / Мало фото (встроенная панель причины) / Пропустить / ←), «кто ещё модерирует», переход к следующей после действия и при 409 | `PhotoModerationPage.tsx` |
| `src/app/(app)/pinterest/articles/moderation/photos/page.tsx` | Табы сайтов с количеством, `?article=` открывает конкретную статью (если не держит другой), иначе `nextForReview` | — |
| `src/components/articles/ArticleReviewPanel.tsx` | Модерация статьи: список слева (🔒 кто держит), справа мета-поля со счётчиками (сохраняются по blur и перед переходом), категория WP из кэша сайта, вступление/заключение, сетка фото с текстом секции под каждым (`<details>`), снять/вернуть, drag (секция едет с фото), Одобрить / «публиковать сразу» (localStorage) / В доработку (причина из списка + текст) / Пропустить; клавиши Enter, S, Backspace, Esc | `ModerationPage.tsx` |
| `src/app/(app)/pinterest/articles/moderation/articles/page.tsx` | Вкладки «На модерации» (REVIEW_PENDING) / «В доработке» (NEEDS_REWORK), фильтр сайта | — |
| `src/app/(app)/pinterest/articles/publications/page.tsx` | Ошибки / В очереди (PUBLISH_QUEUED, PUBLISHING, PENDING/RUNNING на этапе publish) / Опубликовано за 7 дн., фильтр сайта, «Повторить все», «Повторить», ссылки на сайт и карточку | `PublicationsPage.tsx` |
| `src/lib/articles/recipes.ts` | Помощники рецептов: `promptSteps(format)`, `recipeReadiness`, `STAGE_VARS` (что код подставляет в каждый шаг — из 06 §2), `VAR_HINTS`, `recipeShape`, дефолты `DEFAULT_PHOTO_SEARCH/TEXT/IMAGES/PUBLISH`, `POPULAR_MODELS`, `SEARCH_OPTIONS`, `FORMAT_LABELS` | `ScenariosPage.tsx`, `PromptManager.tsx`, 06-prompts-and-config.md |
| `src/actions/articlesRecipes.ts` | `createRecipe`, `saveRecipeMain` (сброс stagePromptIds при смене набора, один «по умолчанию» на нишу+формат), `savePhotoSearch`, `savePrompt` (+`ArtPromptVersion` version+1, changeSummary), `createPromptVariant` (пустой или копия, сразу активный в рецепте), `setStagePrompt`, `setStageModel` (валидация `provider:model`), `copyRecipe` (рецепт + набор + промты + remap одной транзакцией), `deleteRecipe` (админ; нельзя при активных статьях или сайтах с этим рецептом по умолчанию) | ScenariosPage (копия без транзакции → с транзакцией) |
| `src/app/(app)/pinterest/articles/recipes/page.tsx` | Список по формату (табы) и нише с готовностью, счётчики статей, форма «Новый рецепт» | — |
| `src/app/(app)/pinterest/articles/recipes/[id]/page.tsx` | Вкладки `?tab=main|prompts|search|history`; Промты — шаги формата слева (точка: есть/нет/необязателен, модель), редактор справа | — |
| `src/components/articles/PromptEditor.tsx` | Варианты (★ выбранный в рецепте), «+ Вариант (копия)», выбор активного варианта, модель шага с datalist популярных, system-блок по чекбоксу, text (моно), чипы переменных шага (зелёные — используются; красный бейдж «неизвестные»), вставка в курсор, «что изменили» → версия | `PromptManager.tsx` |
| `src/app/api/articles/recipes/[id]/export/route.ts` | Экспорт JSON `{recipe, promptSet{prompts}}` как файл | ImportExportPage (экспорт) |
| `src/app/(app)/pinterest/articles/journal/page.tsx` | `?tab=errors|ai|costs`, период 1/7/30 дн., фильтр сайта. Ошибки: «горит сейчас» (час против предыдущего), группы по `signature` с количеством, этапом, последней статьёй, словарём KNOWN «что делать», кнопки «Вернуть в работу» (FAILED → PENDING с текущего этапа) и «Устранено». Вызовы ИИ: `UsageLog` проекта `articles` с фильтром сайта/статьи (`?article=`), ссылки на карточку. Расходы: матрица сайт × этап из `ArtStageLog.costUsd` + «Всего» из `Article.costUsd`; скрыты при `perms.usage === "own"` | `ErrorsPage.tsx` (KNOWN :31-52), GenerationsLog, CostCalculator |

Подменю `ArticlesNav` рендерит `layout.tsx` соседа — в моих страницах его нет (иначе было бы дважды). Бейдж статуса — общий `StatusBadge` соседа.

## Правила модерации фото (как реализовано)
- Исключение не удаляет строку: `ArtPhoto.excluded=true` (для «Отменить»); при `approvePhotos` исключённые удаляются вместе с файлами, кандидат → `reserve`, позиции 1..N, все `ArtSection` удаляются (старый текст не соответствует фото — как оригинал :238-243), `ArtPhotoFingerprint` статьи перезаписывается (оригинал :251-259), `plan/html/intro/outro` очищаются, статья → `PENDING`, `stage = firstWritingStage(format)`, `cursor.photoReviewApproved = true`, `cursor.topup` снимается.
- Одобрить можно при активных фото ≥ `min(MIN_PHOTOS, article.photoCount)`; иначе ошибка «Нужно ещё N…». Проверка «у каждого фото есть описание» из оригинала (:233) **не блокирует** — только бейдж «нет описания» (writerMode=vision описания не требует; см. открытые вопросы).
- `addFromReserve`: кандидат `reserve|keep` **или** `rejected` на этапе `rate` (технические фильтры он прошёл — оригинал проверял `tech_status=ok`; иначе вкладка «Отклонены ИИ» с «+» бессмысленна). Файл: оригинал кандидата, если ещё на диске, иначе скачивание заново через `safeFetch` (адреса × 2 UA, Referer страницы, ≤12 с попытка, 45 с всего, ≥2000 байт; прокси `images.weserv.nl` не переносил). Дубли по `candidateId/sha256/phash` запрещены; если дубль — снятое фото, оно возвращается. `caption` оставлен пустым — подпись строит сборка по `captionMode` рецепта и `sourceDomain/sourcePageUrl`.
- `requestTopup`: `cursor.topup = {from:"moderation", needed: photoCount − активные, reason}`, `status=PENDING`, `stage="search"`, снятие закрепления и `moderatedBy`. Разрешено также из `INSUFFICIENT_PHOTOS`/`WAITING_FOR_PHOTOS`.
- Пропуск: событие `skip`; `nextForReview` исключает пропущенные за 12 ч; если остались только они — второй круг по ним.
- Телеметрия heartbeat/open не переносилась (решение 05 §7: события действий вместо heartbeat).

## Контракт для раннера/этапов (другие исполнители)
- `cursor.topup` — читает этап `search` (добор к существующему резерву, не с нуля).
- `cursor.photoReviewApproved === true` — фото одобрены человеком (можно показывать в карточке; этап `select` при повторном проходе не должен менять `ArtPhoto`).
- `approveArticle`: если модератор снял фото — они удалены вместе с секциями, позиции и заголовки «N. …» пересчитаны, статья уходит на `stage="assemble"` с `cursor.reviewApproved=true`. **Раннер после `assemble` не должен снова останавливать такую статью в `REVIEW_PENDING`** (идти в `publish`). Без снятых фото — сразу `stage="publish"`. `{{COUNT}}`/«retargetCount» в уже написанной мете при уменьшении числа фото не переписывается — если `assemble` этого не делает, h1/title могут содержать старое число (оригинал: `apply-review-exclusions` делал `retargetCount`).
- `retryPublish`: `PUBLISH_ERROR → PENDING`, `stage="publish"`, `publishAttempts=0`.
- «Вернуть в работу» в журнале: `FAILED → PENDING` с текущим `stage`, `attempts=0`, `stopRequested=false`; ошибки статьи помечаются устранёнными.

## Экспорты для карточки статьи (сосед)
- `PhotoModerationGrid` (`@/components/articles/PhotoModerationGrid`): `initial={await photoState(me, id)}`, `userKey={me.id}`, `editable={["PHOTO_REVIEW","REVIEW_PENDING","NEEDS_REWORK"].includes(status)}`, `mode="photos"|"articles"`, `hideReserve` после публикации. Для секций под фото — `renderUnderPhoto`.
- `photoState`, `reviewState`, `activeClaims`, `waitingCounts` из `@/lib/articles/moderation`; ссылки `…/moderation/photos?article=<id>`, `…/moderation/articles?article=<id>` открывают статью в конвейере.
- Server actions кнопок карточки: `approvePhotosAction`, `topupAction`, `insufficientAction`, `returnToReviewAction`, `approveArticleAction`, `reworkArticleAction`, `retryPublishAction` (`@/actions/articlesModeration`, поле `id`).

## Упрощено / не перенесено
- Нет vision-описания при добавлении из резерва (оригинал :175-187 вызывал `describePhoto`): требует профиля ниши и промта; показываем бейдж «нет описания». Если writerMode=description и у фото нет описания, автор получит пустые факты — открытый вопрос к владельцу этапа `sections` (fallback на `altText`/заголовок кандидата?).
- Перевод ключа при claim (`translateKeywordRu`, gemini) не вызывается из UI — показываем `Article.keywordRu` или `facts.keywordRu` (ожидается от этапа `search`).
- Публикации: «В доработку» из ошибок публикации не делал (статус не REVIEW_PENDING); есть карточка статьи.
- Рецепты: вкладка «Изображения» (generated_photo), импорт JSON, «Скопировать промты из другого набора», валидация набора целиком — волна 2/3. Diff версий в «Истории» — нет (список версий с автором и summary).
- Журнал: график по дням и фильтр «не по нашей вине» — нет; словарь KNOWN адаптирован под тексты наших этапов (регулярки стоит дополнить после первых прогонов).
- `SubmitButton confirm=` использует `window.confirm` (так в проекте) — только для «Повторить все» и удаления рецепта.
- Права на рецепты: смотреть/править — все вошедшие, удалять — админ (отдельного права `recipes` в портале нет).

## Открытые вопросы
1. Кто пишет `ArtPhotoFingerprint` — `select` или только одобрение? Сейчас одобрение перезаписывает отпечатки статьи (как оригинал); если `select` тоже пишет, дублей не будет (delete по articleId перед insert).
2. Статус кандидата после ручного добавления — `selected`; при `removePhoto`/одобрении с исключением → `reserve`. Этап `select` должен считать «selected» занятыми.
3. `ArtSection` при `approvePhotos` удаляются целиком (включая 0 и 9990) — этап `plan` создаёт заново; если `blueprint` ожидает их наличие, проверить.
4. Проверку «нет описания» при одобрении включить обратно, если этап `sections` требует `facts/description` обязательно.
