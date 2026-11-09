# 07. Формат generated_photo и вспомогательные функции — карта логики для переноса

Аудит исходников Supabase Edge Functions (Deno) сервиса «Zewex Pinterest Articles».
База: `supabase/functions/` (далее пути относительно неё). Формат `generated_photo`
в продакшене вторичен (основной — `real_photo`), поэтому глубина — средняя, но список
переносимого — полный.

Ключевой вывод, который меняет картину: в активной цепочке генерацией картинок занимается
**`stage5-nanobanana-edit`** (3219 строк), а не `stage5-generate-outfit-image`. Оркестратор
и direct-pipeline выбирают функцию по `projects.stage5_api_provider`: `openai_image` → режим
`"openai_image"` → `useNanoBanana = true` → `stage5-nanobanana-edit`
(`queue-orchestrator/index.ts:2206-2254`, `direct-pipeline/index.ts:1797-1907`).
`stage5-generate-outfit-image` вызывается только когда провайдер в сценарии пуст
(Lovable Gateway → `google/gemini-3.1-flash-image-preview` через chat completions) — это legacy.

---

## 1. Актуальная цепочка generated_photo

`STAGES = [2, 5, 6, 65, 73, 72, 76, 78]` (`queue-orchestrator/index.ts:14`).
Шаг 55 в списке **отсутствует**: `execStage55` определён (`:2345`), но ни разу не вызывается;
в direct-pipeline стадия 55 не существует вовсе. Апрув картинок и позиции делаются инлайн
в direct-pipeline после ворот (`direct-pipeline/index.ts:883-893`).

Исполнение: `direct-pipeline` — три «инвокации» (1 = шаг 2; 2 = шаг 5 + ворота; 3 = шаги 6→78),
каждая ≤ 170 с (`MAX_MS = 170_000`, `BUFFER_MS = 30_000`, `:16-17`), продолжение через `chainSelf`,
курсор в `article_queue.pipeline_cursor` (RPC `merge_pipeline_cursor`). Оркестратор — conveyor-режим
с теми же `execStage5/6/73`, watchdog: stale 10 мин для шага 2 (`HEAVY_AI_STAGE_STALE_THRESHOLD`,
`:445-447`), шаг 5 — до 6 восстановлений + 2 «спасения» pending_poyo
(`STAGE5_MAX_STALE_RECOVERIES = 6`, `STAGE5_MAX_PENDING_POYO_RESCUES = 2`, `:400-401`).

### Шаг 2 — Концепт-план (`stage2-concept-plan`, 716 строк)

| | |
|---|---|
| Вход | `projects` (count_outfits, niche_code, subniche_code, keyword_attributes, focus_keyword, topic, language, target_country, stage7_target_word_count, stage7_article_personality, prompt_set_id, stage_prompt_ids, stage_models); `niche_profiles` (через `loadNicheProfile`) |
| Выход | `outfits` (upsert по `project_id,outfit_index`; article_position 1..n без дыр), `outfit_items` (delete+insert; типы cut/color/styling/accessory, color/material обрезаются до 100 символов), `article_drafts` (article_plan, h1/seo_title/meta_description ≤400/url_slug, status=planned), `article_sections` (intro=0, outfit 1..n, outro=9990), `workflow_stages` 2 (итог), 64 (section_mapping ключей), 1 и 55 (совместимость для `stage65-build-blueprint`) |
| Промт | `stage_key = "stage_2"` через `loadStagePrompt`; без промта в наборе — ошибка. Переменные `{var}`: `niche_label, topic_facts, concept_fields, topic, focus_keyword, count_items, sections_count, language, target_country, niche, subniche, target_word_count, article_personality, keywords_table` (всегда «нет данных по ключам» — DataForSEO здесь не вызывается, `:187`) |
| Модель | `stageModel(project,"stage_2", project.stage2_provider ‖ "openrouter")` + `stageSubModel`; `callGemini` с `fallbackChain: ["openrouter","laozhang_nothinking","poyo","lovable_gateway"]`, `responseFormat: json`, `temperature 0.8`, `maxTokens 32000`, `timeout 300 с`, `retries 2`. Дефолт OpenRouter → `google/gemini-2.5-flash-lite` |
| Алгоритм | один JSON-ответ `{designs[], meta, trend_context, intro_plan, outro_plan, how_to_care, ordering_strategy}`; `parseJson` + `repairTruncatedJson` (достраивает обрезанный массив); контракт темы `buildTopicContract` → нарушители заменяются одним repair-вызовом (`temperature 0.7`, `maxTokens 8000`, запрашивается `offending+3` замен); идемпотентность: `workflow_stages[2].status === completed && count(outfits) > 0 && !force` → skip |
| Контроль из пайплайна | direct-pipeline: skip если outfits ≥ count_outfits; верификация 4×1.5 с (`getStage2Coverage`); принимает ≥ `max(5, ceil(0.8·expected))` и уменьшает `count_outfits` (`:682-686`); иначе auto-resume до 2 раз (`s2_resume_attempts`) и fail. Оркестратор: при транспортной ошибке ждёт 5 с и проверяет `article_drafts.article_plan` |
| Количество идей | задаётся при постановке в очередь: точное или случайное из диапазона (`ArticleQueuePanel.tsx:361-367`), UI-лимит 1..100; дефолт 10 (`queueEngine.ts:340`). Ограничение «30 образов» относится к legacy `outfit-concepts` (батчи по 5, бюджет 130 с, auto-resume) — в `stage2-concept-plan` батчей нет, один вызов |

Важно: `direct-pipeline` передаёт `{ force: true, resume: true }`, но `stage2-concept-plan`
**не читает `resume`** — всегда перегенерирует весь список и перезаписывает `outfits`/`outfit_items`
(`:377-379, 462-463`). «Resume» здесь фактически = полный повтор.

### Шаг 5 — Генерация изображений (`stage5-nanobanana-edit` + `stage5-scene-planner`)

| | |
|---|---|
| Вход | `outfits` (канонические: дедуп по `outfit_index`, `getCanonicalOutfits`), `outfit_items`, `projects` (stage5_api_provider, stage5_mode, stage5_prompt_id/group_id и варианты hairstyle/haircolor/toenails, stage5_image_model/quality/size, stage51_provider/model, nanobanana_reference_images, nanobanana_aspect_ratio(s), nanobanana_resolution, keyword_*), `image_prompts`, `image_prompt_groups`, `image_prompt_group_items`, `integrations` (ключи openai/poyo/laozhang/nanobananaapi), `sites.site_url`, `articles.focus_keyword`, `agents` (fallback-шаблон) |
| Выход | Storage bucket `generated-images`, путь `{project_id}/{outfit_id}/openai_{ts}.png` (PoYo: `poyo_*.jpg`, rescued: `poyo_rescued_{ts}.jpg`; legacy: `outfit_photo.png`); `generated_images` (status completed/pending_poyo, review_status=pending, prompt_used, prompt_id, api_mode, generation_cost, session_data с task_id/референсами/ротацией кадра); `outfits.stage5_status` (pending→processing→completed/failed/skipped), `stage5_attempts`, `generated_image_url`, `scene_plan`; `generations_log` |
| Планировщик сцены | `stage5-scene-planner` вызывается один раз на проект перед циклом (кэш в курсоре `scene_planned`), пропускается для nails/manicure/pedicure; идемпотентен (skip, если у всех outfits есть `scene_plan`); 2 попытки, провал = провал шага 5. Промт из набора `stage_5_scene_planner` (только legacy-ветка). Ветка hairstyles: LaoZhang `gemini-2.5-flash-thinking`, батчи `HAIRSTYLES_BATCH_SIZE = 10`, `temperature 0.7`; legacy-ветка: **Lovable Gateway** `google/gemini-3-flash-preview` с tool-call `plan_scenes` (`:10-11, 266-303`). Режимы `salon_portfolio`/`contextual` по article_type/ключу |
| Выбор промта | карта `promptMap` строится один раз и живёт в курсоре: группа (`image_prompt_group_items.percentage` → слоты, сортировка по убыванию процента) или одиночный `stage5_prompt_id`; переопределения: hairstyle/hair_color/toenails (toenails — ещё автопоиск группы/промта по имени `toe|pedicure|toenail`, `direct-pipeline:1753-1783`); ниша одежды — `outfits.raw_data.photo_format` ↔ `image_prompts.usage` (`:1859-1884`). Без промта — исключение «визуальный промт не задан» (`nanobanana-edit:1735-1740`) |
| Шаг 5.1 (prompt writer) | `buildPromptWriterRequest` → `writeLegacyStage5Prompt`: провайдер `project.stage51_provider`, ветки только `laozhang`/`laozhang_nothinking`/`poyo`, иначе **Lovable Gateway `google/gemini-2.5-flash`** (`:764-816`). Внутри: контракт темы, cut-spec валидации (`_shared/cutSpecs.ts`), `STEP1_MAX = 4` попытки. Промт переиспользуется на повторах, обновляется на 1-й и 4-й попытке (`PROMPT_REFRESH_EVERY = 3`, `:1623-1627`). Плейсхолдеры шаблона: `{{MODEL_AGE}}`, `{{SCENE_LOCATION}}`, `{{SCENE_OUTFIT}}`, `{{SCENE_ACTIVITY}}`, `{{SCENE_EXPRESSION}}`, `{{SCENE_LIGHTING}}`, `{{SCENE_HAIR_FOCUS_NOTE}}`, `{{SCENE_CAMERA_ANGLE}}`, `{{SCENE_POSE}}`, `{{SCENE_ATMOSPHERE}}` (для nails — вырезаются). Контекст ротации: последние 4 `generated_images.session_data` (distance/focal/pose/expression/ethnicity/location/camera_angle), камера по циклу из 5 по `outfit_index` |
| Батчи | direct: `batchSize = isPoyo ? 5 : openai ? 10 × число активных ключей OpenAI : 3`; ключи раздаются по кругу через `key_index` (`direct-pipeline:1911-1947`); пауза 2 с между батчами; heartbeat курсора после каждого батча; PoYo — один батч на инвокацию. Оркестратор: direct 3 параллельно, conveyor по одному с паузой 3 с. На outfit: 2 попытки, таймаут вызова 260 с (direct) / 200 с (orch), `rate_limited` → ждать 30 с и повторить |
| Лимиты попыток | `MAX_GENERATION_ATTEMPTS = 6` на outfit → `stage5_status = skipped` (`:1570-1590`); direct-pipeline: «grace» — если ≤5 outfits застряли с ≥4 попытками, они `excluded = true, skipped` и шаг завершается (`MAX_STUCK_GRACE = 5`, `MAX_ATTEMPTS_BEFORE_EXCLUDE = 4`, `:1686-1715`); orphan `processing` старше 3 мин сбрасывается в pending |
| Ворота 70 % | после шага 5 (`direct-pipeline:806-882`): `completedImages = max(distinct outfit_id в generated_images completed с url, outfits.generated_image_url not null)` / `outfits where excluded=false`; < 70 % и есть `pending_poyo` → ждать до 10 мин по 60 с; < 70 % и есть skipped → один recovery-pass (сброс `stage5_status/attempts`, флаг `stage5_recovery_done`); иначе `failPipeline(5)`. Доп. порог: >20 % `failed` → ошибка шага (`:2024-2028`, orch `:2335`). Перед воротами — backfill `generated_images` из `outfits.generated_image_url` (`:775-804`) |
| После ворот | `generated_images.review_status = approved` для pending/null; `outfits.article_position` проставляется по порядку для `excluded=false`; `article_queue.direct_gate_passed = true` |

### Шаг 6 — SEO изображений и загрузка в WP (`stage6-image-processing`, 989 строк)

| | |
|---|---|
| Вход | `generated_images` где `status=completed, review_status=approved, stage6_status in (null,pending,processing)` и `wp_media_id is null`; `projects` (image_seo_prompt_id/stage6_alt_prompt_id, stage6_provider, cut_family, keyword_*), `sites` (wp_rest_url, wp_username, wp_app_password), `outfits`, `outfit_items`, Storage `generated-images` |
| Выход | `generated_images.alt_text, seo_title, seo_description, seo_filename, wp_media_id, wp_url, stage6_status (processing→completed / skipped / fallback), stage6_attempts`; медиа в WordPress (`POST /wp-json/wp/v2/media`, затем `POST /media/{id}` с alt/title/description, Basic auth) |
| Действия | `generate_alt_tags` (батч 10 id; промт `stage_6_image_seo` из набора → `prompts` по id → встроенный fashion/hair текст; `custom_alt_prompt` из `projects.image_seo_prompt_id`), `process_image` (CAS `stage6_status pending/null → processing`; скачивание из Storage; сжатие `fetchCompressedImage` ≤1600 px JPEG 90 через storage render → weserv → оригинал; PNG→JPEG `pngjs`+`jpeg-js` quality 90; загрузка в WP), `generate_single_seo` (только UI), `get_pending` (UI) |
| Модель | `stageModel(project,"stage_6_image_seo", stage6_provider ‖ "openrouter")`; OpenRouter → `google/gemini-2.5-flash-lite` (`max_tokens 8192`, `temperature 0.4`), фолбэк 5xx → Lovable `google/gemini-2.5-flash`; LaoZhang → PoYo → Lovable. Собственная цепочка, не `callGemini` |
| Пайплайн | direct: alt-теги батчами по 10 (ошибка батча — пропуск, не retry), загрузка 5 параллельно, heartbeat, post-verify с ретраем 3 параллельно и таймаутом 180 с, финальный фолбэк `wp_url = public_url`, `wp_media_id = -1`, `stage6_status = fallback` (`:2101-2140`). Оркестратор: последовательно, при любой неудаче — ошибка шага |

### Шаги 65 → 73 → 72 → 76 → 78 (общие с real_photo, здесь только специфика generated_photo)

- **65 `stage65-build-blueprint`** — без ИИ; читает `workflow_stages` 2/55/64, `outfits`, `outfit_items`,
  `generated_images` (public_url, wp_url, alt_text, seo_*, review_status, article_position, ai_facts, ai_description).
  Поэтому шаг 2 пишет компат-записи `workflow_stages` 1 и 55 (`stage2-concept-plan:509-544`).
- **73 `stage7-write-sections`** — для `article_format != real_photo` подтягивает `generated_images.ai_facts/ai_description`
  по `article_position` (`:305-330`). В активной цепочке **никто эти поля для generated_images не пишет**
  (единственный писатель — мёртвый `stage55-review-photo:578`), т.е. текст пишется только по плану, с warning «AI photo has no visual facts».
  Батчи `stage7_batch_size` (дефолт 4), retry батчами по 5, 2 попытки, cooldown 5 с/90 с.
- **72 `stage7-write-intro` + `stage7-write-outro`** — ключ `stage_7_intro_outro`; при отсутствии `article_plan` — откат на шаг 2 (до 2 раз).
- **76 `stage7-assemble-html`** — `isRealPhoto` ветвление; картинка секции = `generated_images.wp_url ‖ public_url`
  (`:171, 490`); блоки `dont_block`/`alternative_block` в блюпринте — наследие шага 55.
- **78 `stage7-publish-wordpress`** — общий; проверка `article_drafts.wp_post_id` до вызова.

---

## 2. Генерация изображений — детали

**Цепочка OpenAI (`stage5-nanobanana-edit:2017-2140`)**
`OA_ALL = ["gpt-image-2","gpt-image-1.5","gpt-image-2.5-flare"]`; порядок: `project.stage5_image_model` (дефолт `gpt-image-2`) → остальные.
`quality = stage5_image_quality ‖ "low"`, `size = stage5_image_size ‖ "1024x1536"` — в коде один размер на все модели;
`1024x1824` встречается только в `test-openai-image:15` и в сценариях через `stage5_image_size` (сид `db/data_scenarios.sql` хранит `1024x1536`).
Стоимость: `{gpt-image-2: 0.005, gpt-image-1.5: 0.013, flare: 0.02} × {low 1, medium 2, high 4}`.
Промт обрезается до 30 000 символов.

Эндпоинты: с референсами — `POST https://api.openai.com/v1/images/edits`, multipart `model, prompt, size, quality, n=1, image[]` (файлы `ref-N.{jpg|png|webp}`, скачиваются по URL);
без референсов — `POST /v1/images/generations` JSON. Ответ `data[0].b64_json` → PNG в Storage.
Ошибки: 429/5xx → следующий ключ OpenAI (все активные `integrations.service=openai` по `priority`), иначе следующая модель.
Все модели/ключи упали → **само-вызов той же функции с `mode: "nanobanana_2_poyo"`** (HTTP на `/functions/v1/stage5-nanobanana-edit`), ответ проксируется как есть.

**PoYo (`:2141-2850`)** — асинхронно: `POST https://api.poyo.ai/api/common/upload/url` для референсов (≤14), submit → `GET /api/generate/status/{task}`,
`MAX_POLL_ATTEMPTS = 4`, интервал 8 с, бюджет ≤125 с от начала инвокации. Модели: `nanobanana_2_poyo` → `nano-banana-2-official`;
`nanobanana_pro_poyo` → `nano-banana-2-new` с фолбэком `nano-banana-2-official(-edit)`; `gpt4o_image_poyo` → `gpt-4o-image(-edit)`.
Незавершённая задача → строка `generated_images.status = pending_poyo` (`session_data.task_id, poll_attempt, model_id`), ответ `{rate_limited: true}` → пайплайн вернётся позже и продолжит опрос (resume-path `:2160-2300`).

**Референсы (`:1687-1720, 1913-1950`)**
Переключатель на промте `image_prompts.send_references` (по умолчанию выкл. → картинки не отправляются вовсе, даже проектные).
Пул: `image_prompts.reference_images` (массив строк или объектов `url/public_url`); из пула — **случайные 5** (`pickRandomRefs(pool, 5)`), иначе `projects.nanobanana_reference_images`.
`maxRefs = openai 5 / NB2 и PoYo 14 / LaoZhang 5 / прочее 8`. При референсах к промту добавляется заголовок «STYLE REFERENCE IMAGES … MATCH style, DO NOT copy subject» (отдельные тексты для nails и hair).
**Style DNA**: если `send_references = false` и `image_prompts.style_dna_mode = true` → текст `style_dna` вставляется блоком «STYLE DNA … text only» без картинок. Текст готовится функцией `describe-style-references` из UI (OpenRouter `google/gemini-2.5-flash-lite`, vision, 120–180 слов).
`photo_reference_set` в шаге 5 не используется (только в отборе real_photo).
Аспект: `nanobanana_aspect_ratios[outfit_index % n]` ‖ `nanobanana_aspect_ratio` ‖ `3:4`; `resolution` ‖ `2K` — только для NB/PoYo/LaoZhang.

**Идемпотентность шага 5**
1. `generated_images` с `status=completed` для outfit → `{skipped: true, reason: "Already completed"}` (`:1395-1402`).
2. CAS-claim: `outfits.stage5_status in (pending, failed)` или `null` → `processing` + `stage5_attempts++` (`:1594-1621`); неудача → `{skipped: true}`, пайплайн не считает это done и перепроверяет по БД.
3. Перед финальной вставкой повторная проверка `count(completed) > 0` → `skipped_duplicate` (`:3068-3082`).
4. Пайплайн синхронизирует курсор с БД в обе стороны (`direct-pipeline:1716-1735`), завершение шага — только по `stage5_status` в БД, не по курсору.

**Защита от фантомных записей**
- Stale `pending_poyo` старше 10 мин (`:1403-1566`): финальный GET статуса → finished → скачать и перевести в completed («rescue»); unknown/queued → отложить (bump `created_at`, `poll_attempt`), жёсткий потолок 6 ч; failed → удалить и закрыть pending-запись в `generations_log`.
- Потеря строки `pending_poyo` → восстановление `task_id` из `generations_log` за 30 мин, без повторного submit (`:2172-2210`).
- В `catch`: PoYo с `task_id` → до `MAX_RESUME_ATTEMPTS = 4` остаётся pending; без `task_id` → удалить сироты `pending_poyo` (`:3153-3195`).
- Пайплайн: удаление `pending_poyo`, когда все outfits уже имеют картинку (`direct-pipeline:1677-1680`); backfill `generated_images` из `outfits.generated_image_url` перед воротами; `review_status` ставится в approved только после ворот.
- Legacy `stage5-generate-outfit-image` после upload делает `storage.list()` и проверяет наличие файла (`:1272-1292`); пишет строки `generated_images.status=failed` с `error_message`.

**Хранение**
- Bucket `generated-images` (публичный; URL `{SUPABASE_URL}/storage/v1/object/public/generated-images/{path}`), пути `{project_id}/{outfit_id}/…`.
- `generated_images` — главная таблица (колонки: `outfit_id, project_id, prompt_id, storage_path, public_url, image_url, api_mode, status, review_status, generation_cost, total_cost, generation_time, prompt_used, session_data, article_position, alt_text, seo_title, seo_description, seo_filename, wp_media_id, wp_url, stage6_status, stage6_attempts, ai_facts, ai_description, …`).
- `outfits` — идея/образ (`stage5_status, stage5_attempts, generated_image_url, scene_plan, excluded, article_position, is_alternative_outfit, is_mistake_outfit, raw_data`).
- `outfit_items` — детали для промта (cut/color/styling/accessory; читают шаг 5, scene-planner, шаг 6, blueprint).
- `alternative_images`, `mistake_images` — таблицы фаз «alternatives/mistakes» шага 55; **ни одна edge-функция в них не пишет** (писатели `stage55-generate-*` удалены, остались лишь имена в `fnNameToStage`, `queue-orchestrator:1697`); читают их `cleanup-published-articles:99-100`, `stage6-image-processing` (через `image_table`) и UI. Мёртвые для нового пайплайна.
- `generations_log` — расход/аудит каждого вызова (`api_service, api_endpoint, status, cost_usd, metadata.task_id …`).

---

## 3. Статус функций

Проверено grep по именам в `queue-orchestrator/index.ts`, `direct-pipeline/index.ts`, `src/lib/stageRunners.ts` и по всему `src/`.

| Функция | Вызывается откуда | Статус |
|---|---|---|
| `stage2-concept-plan` | orchestrator `:1997`, direct-pipeline `:653,657,698`, UI `stageRunners.ts:197` | **активна** |
| `stage5-nanobanana-edit` | orchestrator `:2254` (fnName при `useNanoBanana`), `:493` (rescue pending_poyo), direct-pipeline `:1907`, UI `stageRunners.ts:256`; сама себя (фолбэк на PoYo) | **активна — основной генератор** (режим `openai_image` и PoYo) |
| `stage5-scene-planner` | orchestrator `:2137`, direct-pipeline `:1632`, `stage5-nanobanana-edit:1360` (defense), UI `stageRunners.ts:277` | **активна** (кроме nails) |
| `stage6-image-processing` | orchestrator `:2537,2566`, direct-pipeline `:2050,2086,2125`, UI `stageRunners.ts:428,443`, `Stage55ResultViewer.tsx:152` | **активна** |
| `stage5-generate-outfit-image` | orchestrator `:2254`, direct-pipeline `:1907`, UI — только при пустом `stage5_api_provider`; дефолт сценария `openai_image` (`queueEngine.ts:449`) | **legacy** (Lovable Gateway, gemini image через chat) |
| `outfit-concepts` | только комментарии (`orchestrator:445`) и строка в `fnNameToStage:1695`; `_shared/cutSpecs.ts` упоминает в комментарии | **мёртвая** (заменена `stage2-concept-plan`) |
| `stage55-review-photo` | только внутри `execStage55` (`orchestrator:2404`), который никем не вызывается | **мёртвая** |
| `stage55-order-outfits` | только внутри `execStage55` (`orchestrator:2478`) | **мёртвая** |
| `stage64-keyword-research` | нигде (ни функции, ни `src/`) | **мёртвая** (ключи выбирает шаг 2) |
| `trend-research` | нигде | **мёртвая** (тренды внутри шага 2; `stage_1`) |
| `describe-style-references` | UI `ImagePromptsManager.tsx:254` (кнопка «описать референсы») | **активна как утилита UI** (Style DNA) |
| `seed-niche-profiles` | нигде из кода; ручной вызов (сид `niche_profiles` из `_shared/nicheProfile.ts DEFAULT_NICHE_PROFILES`) | **служебная/ручная** |
| `test-wp-connection` | UI `ProjectPage.tsx:135`; упомянута в `MIGRATION.md §8` | **активна (диагностика)** |
| `test-proxy` | UI `SettingsPage.tsx:153` (SOCKS5-прокси) | **активна (диагностика)** |
| `test-openai-image` | нигде | **мёртвая** (ручной тест gpt-image, size `1024x1824`) |
| `test-poyo-chat` | нигде | **мёртвая** |
| `test-nanobanano` | нигде | **мёртвая** (Lovable Gateway) |

Также мёртвый код внутри живых файлов: `execStage55` (`queue-orchestrator:2345-2510`), ссылки на
`stage55-generate-mistake-image`/`stage55-generate-alternative-image` (`:1697`), таблицы
`alternative_images`/`mistake_images`, поля сценария `stage55_*`, `stage64_enabled`, `stage1_provider`, `stage4_provider`, `stage36_provider`.

---

## 4. Зависимости от Supabase — что заменить

| Что | Где | Замена в Node-воркере |
|---|---|---|
| `createClient(SUPABASE_URL, SERVICE_ROLE_KEY)` + PostgREST-запросы (`from().select/upsert/update/delete`, `.or()`, `.filter("metadata->>task_id")`, `count: exact, head: true`, `maybeSingle`) | все функции | Prisma/SQL; особое внимание — upsert `onConflict` (`outfits(project_id,outfit_index)`, `article_sections(project_id,section_number)`, `workflow_stages(project_id,stage_number)`, `article_drafts(project_id)`), JSON-фильтры по `metadata->>task_id` |
| RPC `merge_pipeline_cursor` | direct-pipeline, orchestrator | обычная транзакция/JSON-merge в коде |
| Storage `generated-images` (`upload upsert`, `getPublicUrl`, `download`, `list`), render-URL для сжатия (`storageRenderUrl`) | шаг 5 (все варианты), шаг 6, `compressImage.ts`, фолбэк URL в direct-pipeline `:2113` | локальная ФС + nginx `/files/` (как у пинов) или S3; `fetchCompressedImage` переписать на `sharp` |
| Межфункциональные HTTP-вызовы `fetch(${SUPABASE_URL}/functions/v1/…)` с `Authorization: Bearer SERVICE_ROLE_KEY` | orchestrator → stage*, direct-pipeline → stage*, `stage5-nanobanana-edit` → scene-planner и сам себя (фолбэк PoYo), `chainSelf` | прямые вызовы функций в воркере; фолбэк OpenAI→PoYo — обычная ветка, а не HTTP |
| Edge-таймауты (150 с idle, бюджеты 125/130/170 с, `chainSelf`, курсоры, heartbeat `locked_at`) | везде | в воркере не нужны; оставить только lease/heartbeat для перезапуска и лимиты попыток |
| `Deno.env`: `LOVABLE_API_KEY` (обязателен в `stage5-generate-outfit-image:457`, scene-planner legacy-ветка, prompt-writer дефолт, фолбэки шага 6), `OPENAI_API_KEY`, `POYO_API_KEY`, `LAOZHANG_API_KEY`, `NANOBANANA_API_KEY`, `OPENROUTER_API_KEY` | шаг 5/6 | ключи из `integrations` (уже основной путь) → в zewex-tools через слоты/ключи ИИ; Lovable Gateway удалить |
| `integrations` (`service, encrypted_api_key, is_active, priority`) — ключ хранится в открытом виде несмотря на имя колонки | шаг 5/6 | модель ключей zewex-tools (шифрование `APP_ENCRYPTION_KEY`) |
| npm через Deno: `npm:@supabase/supabase-js@2`, `npm:jpeg-js@0.4.4`, `npm:pngjs@7.0.0`, `node:buffer` | шаг 6 | `sharp` |
| `_shared/*`: `promptSet.ts` (наборы промтов: `prompt_sets`, `prompts.stage_key`, `scenarios.stage_prompt_ids/stage_models`), `aiProvider.ts` (`callGemini`, цепочки провайдеров, `generations_log`), `nicheProfile.ts`, `topicContract.ts`, `cutSpecs.ts`, `compressImage.ts`, `billingGuard.ts` | шаг 2/5/6 | переносятся как библиотеки; `aiProvider` → `src/lib/adapters.ts`/`runSlot` |
| Supabase cron (`pg_cron` → orchestrator/publish-worker) | — | systemd-таймер/цикл воркера |
| CORS-заголовки, `Deno.serve`, `OPTIONS` | все | не нужны |

---

## 5. Слабые места (конкретно)

1. **Lovable Gateway остаётся в активном пути.** `stage5-nanobanana-edit:764-816` — prompt-writer знает только `laozhang`/`poyo`, при `stage51_provider = "openrouter"` (дефолт сценария, `queueEngine.ts:453`) молча уходит на `ai.gateway.lovable.dev` с `LOVABLE_API_KEY`; без ключа — текстовый fallback-промт без ИИ (`:800-811`). Также `stage5-scene-planner:266-268` (legacy-ветка, обязателен `LOVABLE_API_KEY`), `stage6-image-processing:24,700-710` (фолбэк), `stage5-generate-outfit-image:457-462` (жёсткое требование).
2. **`resume` в шаге 2 не реализован.** `direct-pipeline:653,698` шлёт `resume: true`, `stage2-concept-plan` флаг не читает → полная перегенерация, `outfit_items` удаляются и создаются заново (`:462`), возможен сдвиг `article_position` при частично созданных картинках.
3. **Описание ИИ-кадра для писателя не создаётся.** `stage7-write-sections:305-330` ждёт `generated_images.ai_facts/ai_description`; единственный писатель — мёртвый `stage55-review-photo:578`. Текст секции для generated_photo никогда не видит реальную картинку.
4. **Дефолтный размер не совпадает с документацией.** Код: `stage5_image_size ‖ "1024x1536"` для всех моделей (`nanobanana-edit:2026`); `1024x1824` только в `test-openai-image:15`. Один размер применяется и к gpt-image-2, и к gpt-image-1.5 — отдельного фолбэк-размера нет.
5. **Фолбэк OpenAI → PoYo через HTTP на саму себя** (`nanobanana-edit:2109-2125`): второй вызов заново делает claim (`stage5_status` уже `processing` → CAS провалится → `{skipped: true}`), т.е. фолбэк фактически срабатывает лишь на следующей итерации пайплайна. Промт тоже пишется заново (платно), если `prompt_used` ещё не сохранён.
6. **Гонка claim ↔ idempotency**: проверка `existingCompleted` (`:1395`) идёт до CAS, а запись `generated_images` — после генерации; два параллельных вызова на один outfit возможны при stale `processing` (сброс через 3 мин в `direct-pipeline:1652-1663`).
7. **Промт-карта «теряет» идеи**: при `promptMap` из группы распределение считается по `remaining`, а не по всем outfits — на повторных инвокациях проценты пересчитываются по хвосту (`direct-pipeline:1827-1835`), и в режиме orchestrator нет `seededShuffle` (UI использует, `stageRunners.ts`), поэтому первые N идей всегда получают первый промт.
8. **Лог с неверной переменной**: `nanobanana-edit:3075` печатает `${existingCompleted}` (объект/null) вместо `existingCompletedCount`.
9. **Проверка ворот считает по двум источникам** (`generated_images` vs `outfits.generated_image_url`, `direct-pipeline:811-826`) и берёт максимум — после backfill это дубликат логики; при расхождении (удалённый файл) картинка «есть» только по URL.
10. **`stage6-image-processing` падает целиком без WP-учётки** (`:181-183`) даже для `generate_alt_tags`; в direct-pipeline ошибка alt-батча «пропускается» (`:2057-2060`), в orchestrator — возвращает курсор и повторяет бесконечно до watchdog.
11. **Фолбэк `wp_media_id = -1`** (`direct-pipeline:2117-2121`) — сентинел в integer-колонке; `stage7-assemble-html` потом ставит `public_url` из Supabase Storage в HTML — после миграции эти URL умрут.
12. **PoYo-сироты**: `pending_poyo` без `task_id` удаляются только при ошибке в `catch` (`:3193`); при успешной генерации другого пути строка может остаться (чистится лишь когда все outfits готовы, `direct-pipeline:1677`).
13. **Ключи в открытом виде**: `integrations.encrypted_api_key` используется как plaintext (`nanobanana-edit:1288-1335`).
14. `getCanonicalOutfits` дедуплицирует по `outfit_index`, но `stage2-concept-plan` делает upsert по той же паре — дубликаты возможны только из legacy `outfit-concepts`; код тащит защиту от них повсюду.
15. `stage5-generate-outfit-image` ставит `?t=${Date.now()}` в `public_url` (`:1300`) — URL с query попадает в `generated_images.public_url` и далее в alt/SEO-обработку.

---

## 6. Рекомендация по переносу

**Первая волна (минимум для работающего generated_photo):**
1. `stage2-concept-plan` целиком + `_shared/promptSet.ts`, `nicheProfile.ts`, `topicContract.ts`, `aiProvider.callGemini` (через адаптеры zewex-tools). Реализовать настоящий `resume` или убрать флаг.
2. Из `stage5-nanobanana-edit` — **только режим `openai_image`**: загрузка настроек/промта (одиночный + группа + переопределения hairstyle/haircolor/toenails + `photo_format`), `buildPromptWriterRequest` + prompt-writer на `callGemini` (убрать Lovable), референсы (`send_references`, случайные 5, Style DNA), OpenAI `/v1/images/edits|generations` с перебором моделей `gpt-image-2 → gpt-image-1.5` и ключей, запись `generated_images`/`outfits`/лог. CAS-claim и лимит 6 попыток. Фолбэк на PoYo — как обычная ветка `nanobanana_2_poyo` (submit→poll) без self-HTTP; можно отложить во вторую волну, если PoYo-ключа нет.
3. `stage5-scene-planner` — только если нужны волосы/одежда; для nails не нужен. Перевести обе ветки на `callGemini`.
4. Контур шага 5 из `direct-pipeline`: `promptMap`, батчи по ключам, ворота 70 % + recovery-pass + grace-порог, 20 % failed, backfill, апрув и `article_position`.
5. `stage6-image-processing`: `generate_alt_tags` (батч 10, промт `stage_6_image_seo`) и `process_image` (сжатие `sharp`, upload WP, фолбэк на публичный URL своего хранилища) — переиспользовать `src/lib/pins/wp`.
6. Хранилище: `generated-images` → локальная папка `storage/articles/{project}/{outfit}/…` + nginx `/files/`; обновить `public_url` при переносе.
7. Дописать недостающее: писать `ai_description/ai_facts` для сгенерированного кадра (один vision-вызов на картинку) либо честно убрать чтение в шаге 73.

**Отложить (вторая волна):** PoYo и NanoBanana/LaoZhang image-режимы (`nanobanana_2`, `nanobanana_pro_*`, `laozhang_flash_image`, `gpt4o_image_poyo`), Style DNA-утилита `describe-style-references` (нужна форма в UI промтов), `test-wp-connection`/`test-proxy` (заменить на свои проверки ключей/сайтов), `seed-niche-profiles` (сделать частью `prisma/seed`), multi-key round-robin OpenAI (если ключ один).

**Удалить, не переносить:** `outfit-concepts`, `stage55-review-photo`, `stage55-order-outfits`, `execStage55` и `stage55_*`-поля сценариев, `stage64-keyword-research`, `trend-research`, `stage5-generate-outfit-image` (Lovable image-chat), `test-openai-image`, `test-poyo-chat`, `test-nanobanano`, таблицы `alternative_images`/`mistake_images` и их чтение в cleanup/blueprint/assemble (`dont_block`/`alternative_block`), все ветки Lovable Gateway, `agents.image_director` как источник промта, компат-записи `workflow_stages` 1/55/64 (переписать `stage65-build-blueprint` на чтение `article_drafts.article_plan`).
