# Pin Blog Article — инфо-статьи под Pinterest (проект `blog`)

Отдельный сервис рядом со «Статьями» (`/pinterest/articles`). Статьи-подборки там строятся от фото (одно фото = одна секция);
здесь наоборот: текст первичен, фото (3–7) подбираются под разделы. Код статей не меняется — общие библиотеки импортируются.

## Где что

| Что | Где |
|---|---|
| Страницы | `src/app/(app)/pinterest/blog/*`: обзор, `review` (проверка), `recipes`, `journal`, `sites`, `runs/new`, `runs/[id]`, `posts/[id]` |
| Действия | `src/actions/blog.ts` (сайты, запуск, посты, фото, проверка), `src/actions/blogRecipes.ts` (сценарии, промты, версии) |
| Библиотека | `src/lib/blog/*`: `types` (настройки, параметры сценария, бриф, план), `stages` (реестр), `blocks` (каталог блоков), `recipes`, `launch`, `queries`, `access`, `ai` (клиент портала под проект `blog`), `prompts`, `serp`, `text`, `html`, `schema`, `qualityCheck`, `storage`, `photo/search`, `photo/ratePrompt`, `wp/categories`, `wp/publish` |
| Воркер | `worker/blog/*`: `queue` (пост = строка очереди), `runner`, `journal`, `stages/*` (11 этапов) |
| Данные | модели `Blog*` в `prisma/schema.prisma`; сид проекта, слотов и сценария — `prisma/seed.mjs` + `prisma/seed-data/blog/recipes.json` |
| Файлы | `storage/blog/<postId>/{cand,photos}/…` (nginx `/files/`) |
| Самопроверка | `npx tsx scripts/blog/selftest.ts` (чистка HTML, сборка, JSON-LD, проверка качества — без ИИ и базы) |

Ключи ИИ: слоты проекта `blog` — `text_main`, `text_fast`, `vision`, `photo_dfs`, `photo_serp`, `serp_organic` (последний нужен
только при включённом `params.research.serp`). Назначаются на странице ключа, как у других сервисов.

## Конвейер (src/lib/blog/stages.ts)

1. `research` — text_fast: интент (how_to / why / which / comparison / list / problem_fix / what_is), аудитория, YMYL, бриф знаний
   (факты с уверенностью, do/don't, ошибки, безопасность, материалы, сроки, вопросы). При `research.serp` — People Also Ask и заголовки топа.
2. `outline` — text_main: план из каталога блоков (`blocks.ts`): H1/мета, 4–9 секций с типом и ключевыми пунктами, объём, слоты
   картинок с поисковыми запросами, флаги takeaways/FAQ/дисклеймер. Код держит границы сценария (объём, число картинок, уникальные H2).
   Пишет `BlogSection` (planned) и `BlogImageSlot` (hero, s<N>, closing).
3. `photo_search` → `photo_filter` → `photo_rate` → `photo_select` — по слотам: Google Images (DataForSEO / SerpApi), технический
   фильтр (порт фильтра статей), vision-оценка «релевантность + качество + настоящее фото» (промт `photo_rate` или встроенный
   `photo/ratePrompt.ts`), выбор лучшего с уникальностью между постами (`BlogPhotoFingerprint`). Слот без годных кадров —
   второй поиск (altQuery), потом пустой; без hero — ошибка с подсказкой (запрос слота правится в карточке → «Повторить этап: Поиск фото»).
4. `write` — секции пачками по 4 (`writer_system` + `writer_user`): HTML по типу блока (`allowedTags`), чистка `text.ts`.
5. `wrap` — вступление, выводы, заключение, FAQ, дисклеймер по готовому телу (`wrap`).
6. `meta` — проверка title/description/slug, одна починка ИИ, детерминированный запас (год в URL — как у статей).
7. `assemble` — `html.ts` + `schema.ts` (Article / FAQPage / HowTo) + `qualityCheck.ts`; плохие секции переписываются один раз
   (`write.rewriteSection`), проблемы обвязки — один повтор `wrap`; иначе FAILED с перечнем. При `review=before_publish` → REVIEW_PENDING.
8. `publish` — `wp/publish.ts`: категория (правила → ИИ → дефолт), фото в медиатеку, запись с Yoast-мета, featured = hero.

Классы сбоев и повторы — общие со статьями (`src/lib/articles/errors.ts`). Расход — `UsageLog.refId = postId`.

## Сценарий

`BlogRecipe`: `prompts` {stageKey: {system, text}} (переменные — `STAGE_VARS` в `stages.ts`), `models` {stageKey: provider:model},
`params` (`BlogRecipeParams`: объём, картинки, голос и персона, блоки always/never/auto, FAQ, ссылки, SerpAPI), `photoSearch`, `publish`.
Каждое сохранение промта/параметров — `BlogRecipeVersion`; сид обновляет промты только пока их не правили в портале (или по `seedRev`).

## Проверка перед публикацией

`/pinterest/blog/review`: предпросмотр собранного HTML, «Одобрить и опубликовать» (пересборка с правками → публикация),
«В доработку» (переписать текст / новый план). Замена фото из резерва, правка секций, меты и обвязки, запрос слота — в карточке статьи.
