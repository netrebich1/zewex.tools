# Общие правила для исполнителей переноса (читать первым)

Проект: zewex.tools — Next.js 15 (App Router), React 19, Tailwind 4, Prisma 6, MariaDB, воркер `worker/` (tsx, Node 24).
Переносим сервис «Zewex Pinterest Articles» (Supabase Edge Functions, Deno) **как есть по логике и промтам**, но на нашу инфраструктуру.

## Где что лежит
- Исходники оригинала (только читать): `/private/tmp/claude-501/-Users-a1-Projects-zewex-tools/c3c57472-f5d7-43ee-b713-425aa689ae75/scratchpad/mig/` — `supabase/functions/*` (функции и `_shared`), `src/` (фронтенд), `db/schema.sql`, `PROMPTS.md`, `docs/`, `mem/`.
- Аудит и спецификации: `docs/articles-migration/01…08*.md` (в отчётах — алгоритмы, константы, file:line исходника и найденные ошибки). План и принятые решения: `08-plan.md`, в т.ч. §3 «Что исправляем при переносе».
- Фундамент (уже написан, использовать, не переписывать без крайней нужды):
  - `prisma/schema.prisma` — модели `Art*` и `Article` (внизу файла). Поля JSON типизированы в `src/lib/articles/types.ts`.
  - `src/lib/articles/types.ts` — константы (`MIN_PHOTOS`, `PHOTO_LOOPS`, слоты), типы рецепта/снимка/настроек сайта и запуска, `ArticleCursor`, `ArticlePlan`, `ArticleFacts`.
  - `src/lib/articles/stages.ts` — реестр этапов (`StageKey`), фазы, `nextStage`.
  - `src/lib/articles/labels.ts` — русские подписи статусов.
  - `src/lib/articles/prompts.ts` — `resolvePrompt(recipe, stageKey)`, `resolvePromptOptional`, `stageModel(recipe, stageKey)`, `fillVars`/`fillPrompt` (единая подстановка `{{var}}` и `{var}`; неизвестные переменные → ошибка, `{{COUNT}}` остаётся).
  - `src/lib/articles/ai.ts` — `aiChat(ctx, {slot, model, system, user, json, maxTokens, timeoutMs, history})`, `imagePart(buffer)` для vision, `aiImage`, `dfsRequest(ctx, endpoint, body)`, `serpRequest(ctx, params)`. Ошибки — `AiError` с классами transient/permanent/fatal_run (`src/lib/pins/ai/errors.ts`).
  - `src/lib/articles/storage.ts` — пути файлов статьи, `makeThumb`, `toWpJpeg` (JPEG 90, ≤1600), `writeFileAtomic`, `publicUrl`.
  - `src/lib/articles/access.ts` — видимость сайтов/статей.
  - `worker/articles/` — `queue.ts` (захват), `runner.ts` (ведёт по этапам), `journal.ts`, `stages/index.ts` — **контракт этапа** `ArtStageCtx`/`ArtStageResult` и реестр `STAGES`. Этап не меняет `Article.status/stage` сам: он возвращает `next` (следующий этап по умолчанию, явный `StageKey` для отката назад, или `{wait: ArtStatus}`), `fatal`, `retryInMs`, `summary`, `details`. Промежуточные данные — `ctx.cursor/facts/plan` через `ctx.save(...)`. `ctx.tick(label)` — регулярно (продлевает lease, бросает StopRequested).
  - Готовые помощники портала: WordPress REST клиент `src/lib/pins/wp/client.ts` (uploadMedia, createPost, listTaxonomies и др. — посмотри экспорт), `src/lib/pins/ai/json.ts` (`parseJsonLenient`), `src/lib/pins/ai/limiter.ts` (семафор на ключ), `sharp` для картинок, `src/lib/crypto.ts` (decryptSecret), `src/lib/utils.ts`.
- Пример реализованного сервиса для образца стиля: Пины — `worker/stages/*.ts`, `src/lib/pins/*`, страницы `src/app/(app)/pinterest/pins/*`, компоненты `src/components/pins/*`, server actions `src/actions/pins.ts`, форма `src/components/ActionForm.tsx`, примитивы `src/components/ui/index.tsx`, классы `src/app/globals.css` (`btn-primary`, `btn-ghost`, `btn-danger`, `tab`, `menu`, `help`, `card`…).

## Правила
1. **Логика и константы — из исходника**, с указанием в комментарии, откуда (`// оригинал: stage-photo-rate/index.ts:405`). Исправления только из списка `08-plan.md §3` и явно найденные баги — с комментарием «аудит NN».
2. Никакого Supabase, Deno, Lovable, `esm.sh`. Ключи ИИ — только через `aiChat`/`dfsRequest`/`serpRequest` (`src/lib/articles/ai.ts`). Никаких ключей в коде или базе сервиса.
3. Нет лимита времени на функцию: костыли под 150 с (chainSelf, бюджеты hasTime*, 504-как-успех, самовызовы) не переносим — просто длинный этап с `ctx.tick()`.
4. Этап идемпотентен: при повторе проверяет, что уже сделано (по строкам в базе), и доделывает.
5. Картинки: `sharp` (вместо jpeg-js/upng/jsquash). Файлы — через `src/lib/articles/storage.ts`.
6. Код на TypeScript strict, импорты через `@/…`, комментарии и тексты UI — по-русски, тексты статей — по-английски. **На этой машине нет Node**: запустить tsc/сборку нельзя, поэтому пиши аккуратно, сверяй имена полей с `prisma/schema.prisma` и типами. Проверка типов будет на сервере.
7. Prisma: `prisma.article`, `prisma.artPhotoCandidate`, `prisma.artPhoto`, `prisma.artSection`, `prisma.artPhotoFingerprint`, `prisma.artModerationEvent`, `prisma.artStageLog`, `prisma.artError`, `prisma.artSite`, `prisma.artRun`, `prisma.artRecipe`, `prisma.artPromptSet`, `prisma.artPrompt`, `prisma.artNiche`, `prisma.artNicheProfile`. JSON-поля пишем как `as object`/`Prisma.InputJsonValue`.
8. Работай только в своих файлах (список в задании). Общие модули другого исполнителя импортируй по оговорённым именам, не создавай дубликатов. Ничего не коммить, не деплоить.
9. В конце запиши `docs/articles-migration/progress/<твоя-зона>.md`: что перенесено (файл → исходник), что упрощено, что не перенесено и почему, открытые вопросы, какие экспорты предоставляешь другим.
10. Если контекст заканчивается — сначала запиши progress-файл с точным местом остановки, затем завершай.
