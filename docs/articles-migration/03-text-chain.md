# 03. Текстовая цепочка: план по фото → секции → вступление/заключение → мета → HTML

Аудит кода Supabase Edge Functions сервиса «Zewex Pinterest Articles» для переноса в Node-воркер (Next.js 15 + Prisma + MariaDB).
Пути ниже сокращены: `fn/` = `supabase/functions/`, `sh/` = `supabase/functions/_shared/`. Номера строк — по исходникам архива миграции.

Зона отчёта: `parse-keyword-ai`, `stage-photo-plan` (шаг 15), `stage-photo-section-plan` (16), `stage65-build-blueprint` (65), `stage7-write-sections` (73), `stage7-write-intro` (72, пишет и вступление, и заключение), `stage7-write-outro` (74, легаси), `stage77-generate-seo-meta` (77), `stage7-assemble-html` (76), `reorder-article-sections`, общие модули `textGuards`, `introOutroParse`, `qualityCheck`, `photoCaption`, `photoDescribe`, `trendBrief`, `jsonRepair`, `countToken`, `promptSet`.

Порядок вызова в `fn/direct-pipeline/index.ts` для формата `real_photo`: 15 → 16 → 65 → 72 → 73 (волнами) → 77 → 76 → `review_pending`. Шаг 74 из `direct-pipeline` **не вызывается** (только `queue-orchestrator:2042` и UI `src/lib/stageRunners.ts:481`).

---

## 1. Шаги цепочки

### 1.1 `parse-keyword-ai` (шаг 1, разметка ключа)

**Вход.** Тело `{project_id?, focus_keyword, niche_code?, subniche_code?}`; `projects.parse_keyword_provider, niche_code, subniche_code`; профиль ниши `loadNicheProfile` (таблица `niche_profiles`).

**Выход.** `projects.keyword_attributes` (JSON, любая ниша) и для ногтей дополнительно 13 колонок `keyword_surface … keyword_setting` (`index.ts:280-281`); для не-ногтевых ниш — «замки» `contractLocks()` в колонки `keyword_*_lock` (`284-293`). Ответ клиенту — те же поля + `provider_used`.

**Алгоритм.**
1. Для ниш `nails|manicure|pedicure` — захардкоженный `SYSTEM_PROMPT` на 13 полей с 14 примерами (`19-102`); иначе `genericSystemPrompt(profile)` собирается из `profile.attributes` (`105-126`).
2. `callGemini`: `temperature 0.1`, `maxTokens 800`, `responseFormat json`, `timeoutMs 15_000`, `retries 2`; провайдер — `projects.parse_keyword_provider` или `openrouter`.
3. `sanitize()` — lowercase, обрезка до 60 символов, фолбэк `"none"`; `validateClosed()` только пишет warn, значение не исправляет (`151-157`).
4. Детерминированный override `keyword_surface` по regex `pedicure|toe…` (`267-274`).
5. Промт **не из набора** (нет `stage_key`), переменных `{{…}}` нет; user-часть — `Keyword: "${focus_keyword}"\nReturn JSON.`.

Фронтовое зеркало `src/lib/parseKeyword.ts` — словарный парсер только для ногтей (превью в UI и safety net). `src/lib/textGuards.ts` — копия `sanitizeTopic`.

### 1.2 `stage-photo-plan` (шаг 15, `STAGE_KEY = rp_photo_plan`)

**Вход.** `projects.*` (включая `photo_search_config.writer_mode`, `stage7_target_word_count`, `stage7_article_personality`, `keyword_attributes`); `article_photos` по `position` с полями `description, facts, caption, alt_text, ai_score, source_domain, source_page_url, fingerprint, public_url, image_url, storage_path, width, height`; профиль ниши; `buildFashionContract` (ниша `outfits`) / `buildInteriorContract`.

**Идемпотентность.** Пропуск, если `workflow_stages[15].status = completed` или есть хоть одна `article_sections.status = written` (`117-126`).

**Выход.**
- `generated_images` и `outfits` проекта **удаляются** (`277-278`), затем по одной `outfits` на фото (`outfit_index`, `article_position`, `article_role`, `name`, `description`, `seo_keyword`, `raw_data` = план секции + `real_photo:true, photo_id, photo_fingerprint, photo_facts, photo_description, photo_caption, source_page_url, source_domain`) (`280-319`).
- `generated_images` — мост (`api_mode: "real_photo"`, `image_url/public_url` = фото, `alt_text`, `seo_title` = h2) (`324-341`).
- `article_photos.outfit_id, position, section_number` — пачками по 10 параллельных UPDATE (`345-352`).
- `workflow_stages` 64 (`section_mapping` с `assigned_keyword`) и 55 (`ordering_strategy`) — совместимость для 65 (`355-389`).
- `article_drafts` upsert: `article_plan` (см. ниже), `article_personality`, `topic_keywords {primary:[{keyword}], secondary:[seo_keyword…]}`, `total_sections`, `h1_title`, `seo_title`, `meta_description` (обрезка до 400, `476`), `url_slug`, `status: planned`, `current_step: photo_plan` (`478-494`).
- `article_sections` upsert по `(project_id, section_number)`: `0 intro` (`plan_data = intro_plan`), `1..n outfit` (`outfit_id`, `plan_data = sectionPlan`, `h2_heading = h2_draft`, `format_used`, `register_used`, `status: planned`), `9990 outro` (`509-523`). Удаляются только лишние секции прошлого плана со статусом ≠ `written` (`499-508`). При FK-ошибке — пауза 1.5 с, `remapOutfits()` и повтор (`541-547`).

`article_plan` = `{article_metadata{h1_title, seo_title, meta_description, url_slug, article_personality, intro_plan, outro_plan}, article_personality, topic_keywords, intro_plan, outro_plan, section_plans[], writer_mode, fashion_contract, interior_contract, generated_by}`. Каждый `section_plans[i]` — `{...section_plan модели, section_number, outfit_id, photo_id, photo_fingerprint, outfit_name, h2_draft, seo_keyword_from_blueprint, keywords_to_bold[], section_angle, outfit_mode, fashion_contract, decor_mode, interior_contract, interior_details, fashion_details, format, register, photo_description, photo_facts, photo_caption, photo_source_url, photo_url}` (`393-448`).

**Алгоритм ИИ.** Две попытки (`198-233`): `[provider, laozhang_nothinking]` при `temp 0.7`, затем `[laozhang_nothinking, lovable_gateway]` при `temp 0.3`; `maxTokens 16000`, `retries 1`, общий дедлайн ИИ 105 с от старта запроса (`206`), `timeoutMs = max(20 с, остаток − 3 с)`, вторая попытка только если осталось ≥ 25 с. Разбор `parseModelJson` (`sh/jsonRepair.ts`), список берётся из `out.sections || out.designs || out.items`. Сопоставление `photo_n → фото`; неверный/повторный `photo_n` → первый свободный номер; фото без плана добавляются в конец (`237-258`). Заголовки — `uniqueHeading()` по фактам фото (`261-274`). Модель: `stageModel(project, "rp_photo_plan", project.stage2_provider || "openrouter")` + `stageSubModel`.

**Промт.** `loadStagePrompt(…, "rp_photo_plan")` → `system/user`, иначе `FALLBACK_SYSTEM/USER` (`70-84`). Подстановка **своим** `fillVars` в одинарных фигурных скобках `{var}` (`58-60`); незнакомые `{…}` остаются как есть.

| Переменная | Источник |
|---|---|
| `{topic}` | `sanitizeTopic(project.topic || project.name)` |
| `{topic_kind}` | `topicKindLabel(nicheProfile, focus_keyword + topic)` |
| `{niche_label}` | `nicheProfile.label` |
| `{subject_label}` | `subjectLabel(nicheProfile)` |
| `{required_facts}` | `nicheProfile.fact_block.fields.join(", ")` |
| `{focus_keyword}` | `sanitizeTopic(project.focus_keyword)` |
| `{language}` | `project.language || "en"` |
| `{target_country}` | `project.target_country || "US"` |
| `{niche}` / `{subniche}` | `project.niche_code || article_type` / `project.subniche_code` |
| `{count_items}`, `{sections_count}`, `{total_sections}` | `photos.length` |
| `{target_word_count}` | `project.stage7_target_word_count || "compact3"` |
| `{article_personality}` | `project.stage7_article_personality || "wry"` |
| `{photos_table}` | строки `n. photo_id | domain | score | description | facts(JSON)` по `article_photos` |
| `{photo_captions}` | `n. caption` |
| `{outfit_mode}`, `{fashion_contract}` | `buildFashionContract` / `fashionContractPrompt` (только ниша `outfits`) |
| `{decor_mode}`, `{hero_element}`, `{setting}`, `{interior_contract}` | `buildInteriorContract` / `interiorContractPrompt` |

Реальный промт набора (`PROMPTS.md:520-702`) использует `{sections_count}, {topic_kind}, {topic}, {target_word_count}, {target_country}, {subniche}, {subject_label}, {required_facts}, {photos_table}, {niche}, {language}, {focus_keyword}, {article_personality}` — все покрыты.

### 1.3 `stage-photo-section-plan` (шаг 16, `STAGE_KEY = rp_section_plan`)

**Вход.** `article_sections` типа `outfit` (`id, section_number, h2_heading, plan_data, outfit_id`); `article_photos` (`facts, description, outfit_id, section_number, position`); `projects.*`; профиль ниши; контракты.

**Выход.** `article_sections.plan_data` += `{recipe, h2, h2_draft, photo_id, photo_facts, photo_description, fashion_contract, interior_contract}` и `h2_heading` (`404-424`); `article_drafts.article_plan.section_recipes[]`, `section_recipes_summary`, обновлённые `section_plans[].recipe/h2_draft/photo_*`, `current_step: section_plan` (`427-452`); `workflow_stages[16]`.

**Алгоритм.**
1. `photo_facts_table`: `N. H2: … \n FACTS: key: value; …` или `description` (`276-286`).
2. ИИ: две попытки `temp 0.8` → `0.3`, `maxTokens 12000`, `timeoutMs 60000`, `retries 1`, здесь `fallbackChain: at.chain` целиком (`343-369`). Модель: `stageModel(project, "rp_section_plan", stage16_provider || "openrouter")`, подмодель по умолчанию `google/gemini-2.5-flash-lite` (`331`).
3. `normalizeRecipe` (`198-225`): `angle ∈ ANGLES` (11 штук, `31-43`), `opener ∈ OPENERS` (6), `length ∈ short|medium|long`, `paragraphs 1|2`, флаги `include_list/care/occasion/diy_vs_salon/honest_minus`, `focus_fact ≤300`, `avoid ≤6`, `note ≤400`, `narrative_role`, `reader_question ≤240`, `primary_takeaway ≤240`.
4. `enforceDistribution` (`133-196`): `maxList = max(2, round(15%))`, `maxCare = max(2, round(40%))`, `maxOccasion = max(1, round(35%))`, `maxSameAngle = max(2, ceil(n/5))`; соседние секции — разный угол и заход; не больше двух одинаковых `length` подряд; `short → 1 абзац`, `long → 2`; `avoid` пополняется углами двух предыдущих секций.
5. Заголовки: `sanitizeTopic` + `uniqueHeading` ещё раз (`386-401`).

**Промт.** `loadStagePrompt(…, "rp_section_plan")` или `FALLBACK_SYSTEM/USER` (`87-126`); к system дописывается блок контракта и список углов для fashion/interior (`333-337`). Переменные `{var}`:

| Переменная | Источник |
|---|---|
| `{topic}`, `{topic_kind}`, `{niche_label}`, `{subject_label}`, `{required_facts}`, `{focus_keyword}`, `{language}`, `{niche}`, `{subniche}` | как в 1.2 |
| `{sections_count}`, `{total_sections}` | `sections.length` |
| `{article_personality}` | `project.stage7_article_personality || "wry"` |
| `{target_word_count}` | `project.stage7_target_word_count || "compact3"` |
| `{photo_facts_table}` | таблица фактов (п. 1) |
| `{angles}` | `fashionAngles` / `interiorAngles` / `ANGLES` через запятую (`316`) |
| `{openers}` | `OPENERS` |
| `{outfit_mode}`, `{fashion_contract}`, `{decor_mode}`, `{hero_element}`, `{setting}`, `{interior_contract}` | контракты |

Реальный промт набора (`PROMPTS.md:733-791`) дополнительно ссылается на `{item_name}`, `{images_table}`, `{image_context}` — функция их **не подставляет**, в промт уходит буквальный `{item_name}` (см. 7.3).

### 1.4 `stage65-build-blueprint` (шаг 65, без ИИ)

**Вход.** `projects (+ sites)`, `workflow_stages` 2/55/64, `outfits` с `article_position`, `outfit_items`, `generated_images` (`review_status` ≠ `rejected`), профиль ниши, `cutSpecs`/`nailSpecs`, контракты.

**Выход.** `workflow_stages[65].output_data` = блюпринт `{article{title, focus_keyword, target_country ("USA"), language, year: new Date().getFullYear(), …замки ниши…, total_outfits, url_slug: slugify(focus_keyword||name), keyword_context, audience_note, niche_label, topic_facts, topic_attributes, required_visuals, stats}, cut_specs, custom_cut_spec, nail_specs, trend_context, trends, ordering_strategy, visual_flow_note, article_seo{…}, sections[]}` (`542-673`).

`sections[i]` (`201-433`): `section_number = outfit.article_position`, `outfit_id`, `role`, `navigation{previous,next}`, `heading{h2: "${position}. ${name}", seo_keyword…}`, `seo_keywords[]` из шага 64, `main_image{wp_url: gi.wp_url||public_url, public_url, wp_media_id, alt_text, seo_title, seo_description, seo_filename, review_score, caption: raw.photo_caption, source_page_url, source_domain}`, `photo_description = raw.photo_description || gi.ai_description`, `photo_facts`, `outfit{…}`, `hair_details|null`, `interior_details|null`, `fashion_details|null`, `nail_design|null`, `scene_context|null`, `search_queries|null`, `hair_items`, `nail_items`.

Для `real_photo` блюпринт нужен только ради `sections[].main_image` (сборка HTML) и `photo_description/facts`; `generateFaqCandidates`/`generateNailsFaqCandidates` (`678-796`) никем не вызываются — мёртвый код с захардкоженным «in 2026» (`707`).

### 1.5 `stage7-write-sections` (шаг 73) — подробно в разделе 2

**Вход.** Тело `{projectId, batchNumber?, sectionNumbers[] | startSection+endSection | singleSection, forceRewrite?}`; `projects.*`, `article_drafts.article_plan`, `workflow_stages[65]`, `article_queue.article_type`, `article_sections` (`plan_data, outfit_id, h2_heading, html_content, status`), `article_photos` (`real_photo`) или `generated_images` (`ai_facts, ai_description`), `photo_candidates` (`ai_facts, ai_description`), `outfits` (проверка существования), `prompts`/`prompt_sets`, `niche_profiles`.

**Выход.** `article_sections` UPDATE/INSERT по секции: `h2_heading, outfit_id, plan_data(+h2), html_content, intro_text, styling_advice, dont_block_text, alternative_block_text, transition_text, format_used, register_used, word_count, batch_number, generation_cost = cost/sections.length, status: written` (`778-821`); `article_drafts.current_step: "7.3", current_batch, total_generation_cost` (`827-833`); `generations_log` stage 73 (`864-890`); при пропуске/автопочинке — `article_photos.facts/description` и `article_sections.plan_data.photo_id` (`268-291`). Ответ `{status, partial, written[], missing[], total_requested, total_written, total_words, cost, model}`.

**Константы.** `FN_BUDGET_MS 125_000` (`69`); `batchSize = project.stage7_batch_size || 8` (`347`); минимум секции **40 слов** (`184`, `754`); `tokenBudget` 32768 для `claude-sonnet`, иначе 16384 (`656`); 2 попытки генерации, вторая только при остатке ≥ 45 с (`2343-2349`); до 3 повторов на 429 с ожиданием 30·n с (`2364-2391`); `callBudgetMs = clamp(остаток/2, 20 с, 55 с)` (`2094-2097`); HEAD-проверка фото 8 с (`610`); `LENGTH_WORDS short 70-95 / medium 110-135 / long 150-185` (`958`).

**Промты.** `stage_7_writer_system` (system+user набора склеиваются в system, `455-456`) и `stage_7_writer_user` (`457-461`); до этого — легаси-цепочка по `project.stage7_*_prompt_id` (compact3 → compact → standard, `368-451`) и нишевые override `stage7_{haircolor|hairstyle|nails}_writer_*_id` (`100-128`); фолбэк `FALLBACK_WRITER_SYSTEM/USER` (`15-52`). К system всегда дописывается `countTokenPromptBlock()` (`465`). Подстановка `fillVars` из `sh/promptSet.ts` (понимает `{{var}}` и `{var}`, незаполненные оставляет и возвращает `missing` → только `console.warn`, `517-524`).

Переменные (`475-516`):

| Переменная | Источник |
|---|---|
| `{{niche_label}}`, `{{topic_kind}}`, `{{required_facts}}` | профиль ниши (`specializeProfile`) |
| `{{topic_facts}}` | `describeAttributes(nicheProfile, project.keyword_attributes)` |
| `{{batch_number}}` | `batchNumber || 1` |
| `{{total_batches}}` | `ceil(section_plans.length / batchSize)` |
| `{{batch_size}}` | `enrichedPlans.length` (реальный размер пачки) |
| `{{article_personality}}` | `draft.article_personality || plan.article_metadata.article_personality || "wry"` |
| `{{focus_keyword}}` | `sanitizeTopic(project.focus_keyword || project.seo_keyword)` |
| `{{previous_batch_summary}}` | JSON `buildPreviousBatchSummary(written)` = `{sections_written, format_counts, h2_headings_used[], last_section_format, last_section_register, last_section_ending}` по `article_sections.status = written` (`338-343`, `2056-2073`) |
| `{{previous_ending}}` | `prevSummary.last_section_ending` (= `transition_text` последней написанной) |
| `{{keywords_bolded_previous}}` | `h2_headings_used.join(", ")` (несмотря на имя — заголовки, не ключи) |
| `{{section_briefs}}`, `{{batch_sections}}` | `buildBatchBriefs(enrichedPlans, …)` — compact3 → `buildCompact3Brief` (+`buildRecipeBrief` для `real_photo` с `recipe`), compact2 → `buildCompact2Brief`, иначе `buildSectionBrief` |
| `{{hair_brief}}` | `buildHairBrief` — `hair_details/hair_items/fashion_details/interior_details` из блюпринта (`1817-1926`) |
| `{{trend_context}}` | `buildTrendContextBrief(blueprint.trend_context)` |
| `{{cut_specs}}` | `buildCutSpecsBrief(blueprint.cut_specs, custom_cut_spec)` |
| `{{scene_context}}` | `buildSceneContextBrief` из `blueprint.sections[].scene_context` |
| `{{search_queries_brief}}` | `blueprint.sections[].search_queries` |
| `{{article_context}}` | JSON `{article_personality, focus_keyword, previous_batch_summary, article_map:[{section_number, h2, narrative_role, reader_question, primary_takeaway}]}` |
| `{{section_plans}}`, `{{section_data}}` | JSON `enrichedPlans` (пусто для compact2/compact3) |

Если в user-промте нет подстроки `SECTION BRIEFS` / `SECTION PLANS FOR THIS BATCH`, брифы дописываются в конец (`527-529`). В режиме «по описанию» (без вложения фото) дописывается блок `PHOTO DESCRIPTIONS … HARD BAN` (`553-579`).

Реальный `stage_7_writer_user` (`PROMPTS.md:445-519`) использует `{{batch_size}}, {{trend_context}}, {{total_batches}}, {{section_briefs}}, {{scene_context}}, {{previous_ending}}, {{previous_batch_summary}}, {{keywords_bolded_previous}}, {{hair_brief}}, {{focus_keyword}}, {{cut_specs}}, {{batch_number}}, {{article_personality}}, {{article_context}}` — покрыты. Один вариант (набор «Одежда · Реальные фото», `PROMPTS.md:4287`) содержит `{{section_brief}}` в единственном числе — не подставляется (см. 7.4).

**Модель.** `stageLegacyModel(project, "stage_7_writer_user", project.stage7_sections_model || stage7_writer_model || "claude-haiku")` (`538`). Vision-способность определяется regex по названию (`539-543`); фото прикрепляются только если `visionOk && (real_photo ? writer_mode === "image" : wcTarget === "compact3")` (`549-551`).

### 1.6 `stage7-write-intro` (шаг 72: вступление + заключение)

**Вход.** `projects.*`, `article_drafts.*` (`article_plan.intro_plan, topic_keywords, article_metadata, section_plans, fashion_contract, interior_contract`), `workflow_stages[65]`, `article_queue.article_type`, `article_sections` типа `outfit` (`h2_heading, intro_text, html_content`) для контекста, `prompts`.

**Выход.** `DELETE article_sections WHERE section_type IN (intro, outro, faq)` (`522-525`), затем INSERT: `intro` (`section_number 0`, `intro_text`, `h2_heading`, `word_count`, `generation_cost = cost`, `status written`) и `outro` (`9990`, `outro_text`, `word_count`, `generation_cost 0`) (`527-548`); `article_drafts.current_step "7.2"`, `total_generation_cost` (`554-556`); `workflow_stages[72]` с `variables_injected`/`input_data` (`558-571`); `generations_log` stage 72.

**Алгоритм.**
1. Разбор `intro_plan`: `p1_hook/p2_answer/p3_personal` (строка или `{text|draft}`), `hasDrafts` выбирает `FALLBACK_INTRO_PROMPT_REWRITE` или `_SCRATCH` (`207-219`, `312-315`).
2. Цепочка промтов: fallback → легаси `stage7_writer_system_prompt_id` / `stage7_intro_prompt_id` (разделитель `---USER---`) → блоки контрактов (`329-334`) → набор `stage_7_writer_system`, затем `stage_7_intro_outro`, иначе `stage_7_intro` (`337-352`) → `countTokenPromptBlock()` → жёсткий блок `INTRO LENGTH — MANDATORY: exactly 2 paragraphs, 90-120 words` (`355-357`).
3. Модель: `stageLegacyModel(project, "stage_7_intro_outro", stage7_intro_outro_model || stage7_intro_model || stage7_writer_model || "claude-haiku")` (`375`).
4. До `MAX_ATTEMPTS 5` попыток (`379`); новая попытка только если прошло < 65 с (`398`); при не-«объёмной» ошибке OpenRouter-модель подменяется на `openrouter:deepseek/deepseek-v4-flash` (`403-405`); между попытками пауза `1200·attempt` мс (`483`).
5. Проверки ответа (`435-478`): `finish_reason = length` → повтор; пустой ответ → повтор; `parseIntroOutroResponse`; `normalizeIntroParagraphs` (приводит к ровно 2 `<p>`, `13-42`); `introW ∈ [90,120]` и ровно 2 абзаца, `outroW ∈ [30,200]`, иначе `correction` в следующий промт; «приемлемый» `fallbackCandidate` (intro 60-160 слов, 2 абзаца, outro 30-200) принимается, если строгий не достигнут (`452`, `487-490`).
6. Пост-обработка: `postProcessHtml` = `stripEmphasis` + обёртка `<p>` (`606-615`); `containsInternalLabel` → `stripInternalLabels` (`500-507`); обязательны непустое заключение, отсутствие `looksLikeModelThinking`, наличие `<p>` (`513-519`).

Вызовы провайдеров (`752-840`): LaoZhang через `callGemini` (`temp 1`, `maxTokens 8192`), OpenRouter `callOpenRouter` (`maxTokens 6000`, `timeoutMs 50_000`), Anthropic напрямую (`claude-haiku-4-5-20251001` / `claude-sonnet-4-20250514`, `max_tokens 4096`, `temp 0.6`, prompt caching), Lovable Gateway (`max_completion_tokens 4096`, `temp 1`).

Переменные (`255-310`):

| Переменная | Источник |
|---|---|
| `{{article_personality}}` | `article_metadata.article_personality || draft.article_personality || "wry"` |
| `{{focus_keyword}}` | `sanitizeTopic(project.focus_keyword)` |
| `{{primary_keyword}}` | `sanitizeTopic(topic_keywords.primary[0].keyword || focus_keyword)` |
| `{{total_outfits}}` | **`COUNT_TOKEN` = `{{COUNT}}`** (число подставляется при сборке) |
| `{{p1_draft}}`, `{{p2_draft}}`, `{{p3_draft}}` | `intro_plan.p1_hook / p2_answer / p3_personal` (или `hook/answer/personal`), иначе `"none"` |
| `{{p1_pattern}}` | `intro_plan.p1_hook.pattern` или дефолт |
| `{{trend_details}}` | `intro_plan.trend_details_to_weave[]` маркированным списком |
| `{{price_range}}` | `getPriceRange()` — regex по `p2_answer.text`, цены блюпринта, иначе `"various price points"` |
| `{{content_angle}}` | `extractContentAngle()` — `article_metadata.narrative_arc`, первое предложение `p2_answer.text`, иначе **`"structured silhouettes meeting soft pastels and bold accents"`** (`653`) |
| `{{subcategories}}` | `extractSubcategories()` — regex по `p2_answer.text` на fashion-слова, иначе **`"various summer styles and occasions"`** (`678`) |
| `{{market_urgency}}` | `intro_plan.market_urgency || article_metadata.market_urgency || "Collections are launching now"` |
| `{{forbidden_phrases}}` | `intro_plan.forbidden_phrases[]` |
| `{{p1_must_include}}`, `{{p3_must_include}}` | `buildP1Checklist/buildP3Checklist` — fashion-эвристики (TikTok, 80s blazers, humidity…) |
| `{{intro_plan}}`, `{{trend_data}}` | JSON (легаси) |
| `{{trend_context}}` | JSON `blueprint.trend_context` |
| `{{article_context}}` | JSON `[{section_number, h2, summary ≤280}]` по написанным секциям |
| `{{fashion_contract}}`, `{{outfit_mode}}`, `{{hero_piece}}`, `{{interior_contract}}`, `{{decor_mode}}`, `{{hero_element}}`, `{{setting}}`, `{{room}}`, `{{style}}` | контракты из `article_plan` |
| `{{previous_ending}}` | `summary` последней написанной секции |

Реальный `stage_7_intro_outro` (`PROMPTS.md:325-360`) требует ещё `{{outro_plan}}` и `{{care_plan}}` — функция их **не подставляет** (см. 7.1).

### 1.7 `stage7-write-outro` (шаг 74, легаси)

Отдельный писатель заключения. Читает `projects, article_drafts, workflow_stages[65], article_sections (written)`, собирает `{{outro_plan}}`, `{{care_plan}}`, `{{article_context}}`, `{{previous_ending}}` (последние 3 предложения последней секции, ≤600 символов), `{{trend_context}}` (строка), `{{primary_keyword}}`, контракты (`154-172`); `stripPlaceholders` заменяет незаполненные `{{…}}` на `(not provided)`, кроме `{{COUNT}}` (`190-193`). Загружает тот же `stage_7_intro_outro` (`140-143`), т.е. при наличии набора получает промт на «вступление + заключение», но сохраняет только `outro`. `MAX_ATTEMPTS 2` (`203`). Удаляет `outro, faq, care_block` и вставляет `outro` (`9990`, `word_count` из ответа модели, не пересчитан) и при `plan.how_to_care` — `care_block` (`9989`) (`283-320`). Его `postProcessHtml` **выделяет ключ `<b>`** (`368-382`). ~430 строк (`540-972`) — таблица сравнения/FAQ/разбор, не используемые.

### 1.8 `stage77-generate-seo-meta` (шаг 77)

**Вход.** `projects` (выборка полей `148`), `COUNT(article_sections outfit, status ≠ excluded)`, `outfits.seo_keyword` (`limit 10` → до 5 уникальных, порядок не задан), `article_queue.keyword, year_in_url`, `article_drafts.topic_keywords`.

**Выход.** `article_drafts.h1_title, seo_title, meta_description, url_slug, topic_keywords (+primary[0].ru, primary_ru, keyword_ru)` (`657-663`); `projects.total_cost += cost` (`666-667`); `generations_log` stage 77. `workflow_stages` обновляет вызывающий `runOneShot`.

**Промт.** `SEO_SYSTEM_PROMPT` **захардкожен** (`14-105`), набор промтов не используется; `stage_key "stage_8_meta"` служит только для выбора модели (`257-258`) и в seed-данных отсутствует. User-промт собирается строкой (`233-254`): ниша, тема, `Source Keyword field`, `PRIMARY KEYWORD`, ключ без года, политика года, год в slug (`YES/NO`), `kwSlug`, `slugExample`, `COUNT_TOKEN`, `itemNoun` (`detectNailNoun/detectHairNoun/nicheNoun`), related keywords, `titleShape` (6 вариантов, выбор `hashPercent(projectId+"|shape")`).

**Алгоритм.** До 3 попыток `generate()` с фидбэком списка проблем `validate()` (`493-517`); модель: `stageModel(project, "stage_8_meta", stage77_provider || "openrouter")`, подмодель по умолчанию `google/gemini-2.5-flash-lite`, `maxTokens 800`, `timeoutMs 55_000`; LaoZhang → захардкоженные `gemini-2.5-flash-preview-05-20` / `gemini-2.5-flash-lite` (`306`), PoYo → `gemini-3-flash` (`330`), Lovable → `google/gemini-2.5-flash-lite` (`346`). Детали правил — в разделе 5.

### 1.9 `stage7-assemble-html` (шаг 76) — раздел 4.

### 1.10 `reorder-article-sections`

Ручная смена порядка на модерации. Вход `{project_id, outfit_ids[], reassemble = true}`. Непереданные outfits — в конец. Сначала все `section_number` уводятся в отрицательные (обход уникального индекса `(project_id, section_number)`, `38-45`), затем для позиции `pos`: `outfits.article_position`, `article_photos.section_number/position`, `generated_images.article_position`, `article_sections.section_number`; у видимых секций перенумеровывается префикс `N. ` в `h2_heading` (`63-70`). Затем HTTP-вызов `stage7-assemble-html` с `excludeOutfits: excluded.size > 0`.

---

## 2. Как работает `stage7-write-sections`

**Пакеты.** `direct-pipeline.runStage73` (`2195-2395`) берёт все `outfit`-секции с непустым `plan_data`, у которых `status ≠ written` или пустой `html_content` или `word_count < 10`; режет на пачки `stage7_batch_size || 8`; запускает волнами по `PARALLEL_BATCHES` = 3 для `sonnet|claude`, иначе 7 (`2242`) параллельных HTTP-вызовов функции с `{batchNumber, sectionNumbers}` и бюджетом `callBudget(145_000)`; пауза между волнами 1/8/10 с. Внутри функции `batchNumber` идёт только в `article_sections.batch_number`, `{{batch_number}}` и `current_batch`.

**Идемпотентность.** Секции, у которых `html_content ≥ 40 слов`, из пачки выкидываются (`177-200`), если не `forceRewrite`. Если все уже написаны — ответ `skipped_all`.

**Фото ↔ секция.** Формат `real_photo`: `article_photos` по `section_number` (`244-248`). Секция без фото **молча удаляется из пачки** (`251-256`); если удалились все — `throw Photo integrity failed`. Если `plan.photo_id ≠ photo.id` (фото пересозданы после модерации) — план перепривязывается к текущему фото и `plan_data.photo_id` обновляется (`262-273`). Если у фото нет ни `facts`, ни `description` — автопочинка (`276-296`): 1) `photo_candidates.ai_facts/ai_description` по `image_url/original_url`; 2) `describePhoto()` (`sh/photoDescribe.ts`: `callGemini provider openrouter, temp 0.2, maxTokens 800, timeoutMs 60_000`, 2 попытки, нужно ≥ 8 слов описания и хоть один факт) → `article_photos.facts/description` UPDATE. Если и после этого пусто — `throw` на всю пачку (`297-299`). Один `outfit_id` соответствует одному фото ещё с шага 15; сборка HTML бросает ошибку при повторе `outfit_id` в двух секциях (`assemble:124-131`), `qualityCheck` — `photo_shared_section`.

**Запрос к модели.** `generateSectionsWithRetries` (`2314-2497`): 2 попытки, `temperature 1`; вторая — с добавкой `CRITICAL OUTPUT REQUIREMENTS` и только при остатке ≥ 45 с. При 429 — до 3 ожиданий по 30·n с. Если провайдер отвергает изображения (`image input|image_url|…`) — повтор без фото (`2397-2406`). Мультимодальный контент: `[{text: userPrompt}, {text: "--- PHOTO for Section N ---"}, {image_url}]…` (`636-652`); фото берутся из `generated_images` по `outfit_id` со `status completed` и `stage6_status ∉ (skipped, fallback)`, каждое проверяется HEAD-запросом (`587-631`).

**Разбор ответа.** `extractJsonFromResponse` (`2543-2594`): срез ```-фенсов → `JSON.parse` → границы `{…}`/`[…]` → чистка висячих запятых, лишних `\`, управляющих символов → `balanceJsonClosers` → `extractSectionsFromTruncated` (посимвольный проход по массиву `sections`). `toSectionList` (`3292-3304`) принимает `{sections|Sections|items|data:[…]}`, массив, `{"1":{…}}`, `{"section_1":{…}}`, одиночный объект с `html_content|h2_heading`, иначе `[parsed]`. `normalizeSections` (`2499-2530`) **присваивает `section_number` по позиции** в ожидаемом списке (`2506-2513`), игнорируя номер модели, обрезает до `expected.length`, дедуплицирует; при пустом результате — `extractLikelySectionObjects` (regex `{…}` 40–3000 символов).

Поля текста (`705-720`): `html_content || html || content || body || text || paragraph`; строка без `<` разбивается по `\n{2,}` в `<p>`; при отсутствии — склейка `intro_text + styling_advice`. Заголовок берётся **из плана** (`h2_draft || h2_heading || dbSection.h2_heading`), ответ модели используется только как последний фолбэк (`693-694`); затем `sanitizeTopic(stripInternalLabels(…))` и `uniqueHeading` против заголовков всех остальных секций статьи (`673-700`).

**Пост-обработка и отсев.** `postProcessHtml` (`2025-2050`): `stripEmphasis`, обёртка «голых» строк в `<p>`, повтор `stripEmphasis`, линковка `Read reviews on Google`. Затем: `looksLikeFactDump` → `stripLeadingFactDump`, если после обрезки ≥ 40 слов и дамп исчез — сохраняем, иначе секция **пропускается** (`733-743`); `containsInternalLabel` → `stripInternalLabels` (`746-748`); `< 40 слов` → пропуск (`753-757`). Пропущенные секции не сохраняются и попадают в `missing`.

**Частичный результат.** Если модель вернула не все секции: после 1-й попытки — вторая; после 2-й возвращаются имеющиеся + `missingSections` (`2463-2473`); если 2-я попытка не состоялась — `bestPartial` (`2480-2483`). Для `singleSection` при полном провале разбора **сырой ответ сохраняется как `html_content`** (`2486-2494`). Ответ функции `{partial: true, written, missing}`; `direct-pipeline` складывает `missing` в `accumulated_missing`, после волн делает ≤ 2 ретрай-фазы пачками по 3 (`batchNumber 900`, `2303-2350`), затем «последний шанс» по одной секции с `forceRewrite` (`batchNumber 950`, `2370-2378`). Если пустых секций ≤ 20 % и остаётся ≥ 15 — **пустые секции и их `article_photos` удаляются** и шаг считается успешным (`2385-2393`); иначе `error: N sections still empty`.

**`{{COUNT}}`.** В system-промт дописывается `countTokenPromptBlock()` (`465`): модель пишет буквальную метку вместо числа. В 73 метка не заменяется; её разворачивает `patchCount` в сборке (`assemble:94-102`) для `intro_text, outro_text, html_content, styling_advice, dont_block_text, alternative_block_text, transition_text, h2_heading`, а также в `seo_title/h1_title/meta_description` и оглавлении. `patchCount` помимо метки заменяет «живые» числа 5–40 рядом с предметными существительными (`ITEM_NOUNS`, зазор до 4 слов, защита от единиц измерения и года) и числительные словами.

**Когда шаг падает (ошибка 500).** Нет проекта/плана; нет планов для запрошенных номеров; `Photo integrity failed` (ни одного фото в пачке или нет фактов после автопочинки); пустые брифы; HTTP-ошибка провайдера ≠ 429 (после text-only повтора); обе попытки неразборны и секций > 1. Для `direct-pipeline` транспортные ошибки и 429 — «в missing», остальное — `fatal`, который валит статью, если к этому моменту `missingSet` пуст (`2258-2263`, `2286`).

---

## 3. Гигиенические правила текста

### 3.1 `sh/textGuards.ts`

| Функция | Что делает |
|---|---|
| `sanitizeTopic` (`22-50`) | Убирает служебные префиксы `NEW — `, `[TEST] `, `OLD: ` (до 4 раз, список `LABEL_WORDS` рус/англ), хвостовые скобки со служебным словом (до 3), хвост `— OLD`, крайние тире/двоеточия. |
| `headingKey` (`59-67`) | «Скелет» заголовка: lowercase, без тегов и знаков, минус `HEADING_STOPWORDS` (nail, design, idea, look, style, the…), уникальные слова, отсортированы. |
| `uniqueHeading` (`111-156`) | Почти-дубль = `≥ 2` общих слов и сходство `≥ 0.7`. Кандидаты: `титул(fact) + base`, `base — fact` по `FACT_PRIORITY` (length, shape, finish, color…), фрагменты `description` ≤ 40 символов, 12 `fallbackQualifiers` («Close-Up Take», «Everyday Version»…). Номера не добавляются. |
| `looksLikeFactDump` (`159-178`) | В первых 400 символах ≥ 2 пар `ключ: значение`, либо первое предложение > 40 символов с ≥ 2 запятыми, без глагола/местоимения и с «фактовым» словом (shape, glossy, almond…). |
| `stripLeadingFactDump` (`181-199`) | До 2 раз вырезает первый `<p>` или первое предложение (20–400 символов), если остаток > 60 символов. |
| `containsInternalLabel` (`202-219`) | Сырое название задачи (если отличается от очищенного) в тексте; `NEW|OLD|TEST|DRAFT|COPY` + разделитель; `(новые/старые/тестовые … настройки)`. |
| `stripInternalLabels` (`222-234`) | Заменяет сырое название на чистое, вырезает пометки, сжимает пробелы. |
| `stripEmphasis` (`240-247`) | Удаляет теги `strong|b|em|i|u|mark`, markdown `**x**`, `__x__`, `*x*`. |

### 3.2 `sh/introOutroParse.ts`

`looksLikeRawJson` (начинается с `{`/`[` или содержит `"intro_html":`), `looksLikeModelThinking` (9 «сильных» паттернов: `we need to write`, `let's draft`, `the prompt says`, `word count:`, `P1: hook`…; 8 «слабых» — срабатывают от двух), `parseIntroOutroResponse` (режимы `json` → `repaired` (экранирование сырых переносов, висячие запятые) → `fields` (извлечение строк регуляркой) → весь текст как intro, если не JSON и не «мысли»; бросает ошибку при сыром JSON/мыслях/пустоте), `normalizeFaqItems`, `parseFaqItemsFromHtml`, `countWords`.

### 3.3 Где применяется

| Этап | Правила |
|---|---|
| 15 `stage-photo-plan` | `sanitizeTopic` для topic/focus_keyword/h1/seo_title/url_slug; `stripInternalLabels` для meta_description; `uniqueHeading` для H2. |
| 16 `stage-photo-section-plan` | `sanitizeTopic` + `uniqueHeading` для H2. |
| 73 `stage7-write-sections` | `sanitizeTopic` focus_keyword; H2: `sanitizeTopic(stripInternalLabels)` + `uniqueHeading`; `stripEmphasis` ×2; `looksLikeFactDump/stripLeadingFactDump`; `containsInternalLabel/stripInternalLabels`; минимум 40 слов; промт `HARD BAN` на копирование структуры данных. |
| 72 `stage7-write-intro` | `sanitizeTopic` focus/primary; `stripEmphasis`; `containsInternalLabel/stripInternalLabels`; `looksLikeModelThinking`; `looksLikeRawJson` (в парсере); ровно 2 `<p>`, 90–120 слов; outro 30–200. |
| 74 `stage7-write-outro` | **Нет** `stripEmphasis`; наоборот, `<b>` на ключ (`368-382`). |
| 76 `stage7-assemble-html` | Локальная копия `stripEmphasis` (`430-435`, без правила `*x*`); `stripMarkdown` (фенсы); `looksLikeRawJson` и `looksLikeModelThinking` для intro/outro; `patchCount`; `escapeHtml` в H2 только в compact-ветке; `normalizeExternalLinks` (`nofollow noopener noreferrer`). |
| Публикация `stage7-publish-wordpress:85` → `runQualityCheck(autofix: true)` | См. 3.4. |

### 3.4 `sh/qualityCheck.ts` (бесплатная проверка перед публикацией)

Вердикты `ok / autofixed / broken`; пишет `article_drafts.quality_verdict, quality_issues, quality_autofixed, quality_checked_at`.

- Фото (только `real_photo`): `photo_dead` (HEAD/GET-Range, 2 попытки, таймаут 8 с; мёртвое только при 400/401/404/410; файлы собственного хранилища не проверяются), `photo_small` (< 320×480), `photo_duplicate` (fingerprint), `photo_duplicate_url`, `photo_unlinked` (нет `outfit_id`, не чинится).
- Текст секций: `section_thinking` (`THINKING_RE`), `section_emphasis` (`EMPHASIS_RE` = `**x**` или `<strong|b|em|i`), `section_factdump` (**только по `intro_text`**, `178`), `section_short` (< `MIN_SECTION_WORDS` 40), `heading_empty`, `heading_duplicate` (точное совпадение `headingKey`, без «почти-дублей»), `outro_missing` (< 25 слов), `intro_missing`, `intro_thinking`, `article_short` (< `MIN_ARTICLE_WORDS` 700).
- Мета: `meta_title_missing`, `meta_title_long` (> 65, в сообщении «до 60»), `meta_desc_missing`, `meta_desc_length` (вне 120–175, в сообщении «140–160»), `meta_title_keyword` (нет первого слова ключа), `slug_invalid`, `slug_duplicate` с автопочинкой `${count}-${base}` / `-ideas` / `best-` / `-2..9` (`235-251`).
- Сборка: `photo_shared_section`.
- Автопочинка: страховка `floor = max(5, ceil(60 %))` → при массовом браке `photos_mass_reject` и ничего не удаляется; иначе `article_sections.status = excluded`, `outfits.excluded = true`, `article_photos` DELETE, перенумерация префиксов `N. `, `retargetCount` в h1/title/description, HTTP-вызов `stage7-assemble-html {excludeOutfits: true}`. Финальный барьер `no_sections` (< 5 секций).

---

## 4. Структура финального HTML (`stage7-assemble-html`)

**Вход.** `projects (+sites)`, `article_drafts`, все `article_sections` по `section_number`, `workflow_stages[65].sections[].main_image`, `article_photos (outfit_id, section_number, position, source_page_url, source_domain, caption, width, height)`, при `excludeOutfits` — `outfits.excluded`. Секции `outfit` без `html_content`/`intro_text` пропускаются (`47-57`). Обязательны `intro_text` и `outro_text`, без «мыслей» и сырого JSON (`105-115`, `142`, `269`).

**Порядок.** По `section_number`: `intro (0)` → `outfit (1..n)` → `how_to_ask_stylist` → `care_block (9989)` → после цикла `outro (9990)`.

**Секция с фото** (compact-ветка, `193-220`; для `real_photo` всегда она, т.к. `intro_text`/`styling_advice` пишутся `null`):

```html
<h2 id="outfit-N">{escapeHtml(h2_heading)}</h2>
[caption id="" align="alignnone" width="W"]<img src="{wp_url||public_url}" alt="{alt}" title="{h2 без «N. »}" data-pin-description="{pin}" loading="lazy" width="W" height="H" style="display:block; margin-left:auto; margin-right:auto;" /> <span class="photo-credit" style="font-size:12px; color:#777; font-weight:400;">Photo credit: <a href="{source_page_url}" target="_blank" rel="nofollow noopener noreferrer">{domain}</a></span>[/caption]
<p>…текст автора как есть…</p>
```

- `mainImage = {...blueprint.main_image, ...article_photo}` (`157-159`): URL из `generated_images.wp_url || public_url` блюпринта, `source_*`/`caption`/`width`/`height` — из `article_photos`.
- Из `html_content` предварительно вырезаются следы прошлой сборки: `stl-block`, `<h2>`, `<figure>`, `[caption]`, `photo-credit`, `<img>` (`199-205`, `366-372`).
- `alt` = `buildAltText` (`457-465`): заголовок без префикса `N. `, иначе `seo_title`; если похоже на чужой тайтл (`| » - Vogue .com …`) — ключ статьи или **`"Nail design idea"`**; если ключа нет в alt — дописывается ` — {keyword}`; ≤ 125 символов.
- `data-pin-description` = `seo_description` блюпринта или `"{h2} — {keyword} inspiration to save for your next set"` ≤ 480 (`467-474`).
- Подпись источника (`sh/photoCaption.ts`): режим `photo_search_config.caption_mode ∈ none|domain|domain_link|full_link` (дефолт `domain_link`), шаблон `caption_template` (дефолт `{credit} {domain}`), `{credit}` — один из 5 префиксов по хэшу позиции (`Photo credit: / Image credit: / Source: / Via / Courtesy of:`), ссылка `nofollow noopener noreferrer`. Без источника — `<figure class="outfit-photo">`.
- Стандартная ветка (`165-192`, когда есть `intro_text`/`styling_advice`): H2 **без `escapeHtml`** (`168`), затем картинка, `textToHtml(intro_text)`, `styling_advice`, блоки `dont-block`/`alternative-block` с эмодзи-заголовками, `<p class="transition">`.

**Заключение.** `<h2 id="conclusion">Final Thoughts</h2>` (жёстко, `272`) + `textToHtml(outro_text)`. `care_block` → `<section class="care-block"><h2 id="care-section">…</h2>…</section>` с дефолтным H2 для ногтей/волос.

**Финализация.** `normalizeArticleHtml` (внешние ссылки → `target="_blank" rel="nofollow noopener noreferrer"`, стили центрирования для `figure`/`img`) → `dedupeImageBlocks` по `src`.

**Сохраняется.** Каждая секция: `article_sections.html_content = собранный фрагмент`, `status = assembled` (`390-394`) — т.е. текст автора перезаписывается HTML с заголовком и картинкой. `article_drafts`: `full_html`, `table_of_contents [{heading, anchor, level}]`, `schema_markup: null`, `total_word_count` (сумма `word_count` всех секций, включая intro/outro), `total_sections = sections.length` (**включая** intro/outro, в отличие от плана), `current_step "7.5"`, `status "assembling"`, патч `seo_title/h1_title/meta_description` через `patchCount` (`283-302`). `workflow_stages[76]`.

---

## 5. SEO: slug, H1, title, description, год, резервный путь

**Источник ключа.** `article_queue.keyword` → иначе `project.name || seo_keyword || focus_keyword` (`stage77:171-178`). Год берётся **только** из этого ключа (`\b20\d{2}\b`); «правило 2027» в коде не захардкожено — любой год из ключа становится `TARGET_SEO_YEAR`, все остальные годы в h1/title/description/slug заменяются на него (`normalizeMetaYear`, `714-720`); если года в ключе нет — годы удаляются везде. Исключения вне 77: `stage65` пишет `article.year = new Date().getFullYear()` (`548`); `trendBrief.trendYear` берёт год из ключа или текущий.

**Slug.**
1. Шаг 15: `slugify(sanitizeTopic(meta.url_slug || h1 || focus_keyword))`, ≤ 90 символов (`stage-photo-plan:38-45`).
2. Шаг 77 (перезаписывает): модель получает `kwSlug = slugify(keywordNoYear)` и форму из `SLUG_SHAPES` (11 вариантов: `{kw}-ideas`, `trendy-{kw}`, …, `{kw}`), выбираемую `hashPercent(projectId + "|slug")` (`116-128`, `227-229`). Валидация: lowercase/дефисы; ключ одним неразрывным блоком; ≤ 3 добавочных слов и все из `SLUG_SAFE_WORDS` (`108-113`); иначе slug **собирается детерминированно** как `slugExample` (`600-612`). Год в slug: `yearInSlug = year && yearPercent > 0 && hashPercent(projectId) < yearPercent`, где `yearPercent = article_queue.year_in_url ?? project.seo_year_url_percent ?? 100` (`196-203`); при `YES` дописывается `-YYYY`, при `NO` все `20xx` вырезаются (`615-625`).
3. `qualityCheck` при коллизии добавляет `${count}-` (цифры), что противоречит правилу «без цифр» шага 77 (`qualityCheck:235-251`).

**H1.** Шаг 15 — `sanitizeTopic(meta.h1_title || meta.title || topic)`. Шаг 77: 40–75 символов, ключ узнаваем (стемминг `ies|es|s`), год обязателен, **`{{COUNT}}` обязателен** (`465-467`), не равен title; при отсутствии года дописывается ` for YYYY` (`632-634`); `titleCase` с `SMALL_WORDS`; `keepToken` нормализует `{COUNT}`/`[COUNT]` → `{{COUNT}}`. Число подставляется в сборке `patchCount`, при автопочинке — `retargetCount`.

**seo_title.** ≤ 60 (валидатор считает по тексту с развёрнутым счётчиком, `381-387`), ≥ 25; ключ в первой половине (`430-433`); без `|`, без двоеточия с ключом до него (бан шаблона `<kw> <year>: …`), без filler-слов (`ideas, looks, best, stunning, top…`, если их нет в самом ключе); год обязателен. Детерминированные правки: `deTemplate` (удаляет filler, двоеточие → тире, `549-578`), обрезка до 60 по границе слова, если нет метки `{{COUNT}}` (`587-589`), дописывание года с подрезкой (`626-631`), `titleCase`.

**meta_description.** 140–160; начинается с ключа без года **дословно** (`436`); год; ≥ 2 LSI-ключа из `secondaryKeywords` (`478-487`); обрезка до 160 (если нет метки) по последней точке > 120 (`590-594`); `padDescription` (`781-800`): заглавная буква, откат к последнему предложению при обрыве, добор хвостами `See the looks and save your favourite.` и др. до 140.

**Язык.** Кириллица запрещена в четырёх полях (`469-475`); при наличии поле заменяется на детерминированное английское (`536-544`). `keyword_ru` — перевод для модератора → `topic_keywords.primary[0].ru`, `primary_ru`, `keyword_ru`.

**Резервный путь.** После 3 неудачных попыток берётся последний ответ модели (`516`) или, если ни один не разобран, `fallbackMeta()` (`521-527`): `h1 = "{{COUNT}} {kw} {year}"`, `seo_title = "{kw} {year}"`, `meta_description = "{{COUNT}} {kw} {year} to save and copy, with styling notes for every outfit."` (≤ 158), `url_slug = slugExample`. В `direct-pipeline` после 77 — проверка `metaOk` (title, h1, slug непустые, description ≥ 40) → один повтор → `failPipeline(77)` (`1101-1123`). Сборка 76 берёт H1 из черновика, поэтому 77 стоит перед 76.

---

## 6. Зависимости от Supabase (что менять при переносе)

| Зависимость | Где | Замена в воркере |
|---|---|---|
| `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` + PostgREST-запросы (`from().select/upsert/update/delete/in/or/maybeSingle/count head`) | все функции | Prisma-клиент; `upsert … onConflict` → `prisma.upsert` по уникальным ключам `(project_id, section_number)`, `(project_id, stage_number)`, `article_drafts.project_id` |
| `Deno.serve` + CORS, HTTP-вызовы функции в функцию (`fetch ${SUPABASE_URL}/functions/v1/stage7-assemble-html`) | `qualityCheck:336`, `reorder:77`, `apply-review-exclusions:78`, `direct-pipeline`, `queue-orchestrator` | прямые вызовы модулей воркера; очередь `PinJob`-подобная |
| Лимит 150 с на вызов и все бюджеты под него (`FN_BUDGET_MS 125 с`, `aiDeadline 105 с`, `65 с` в intro, `callBudgetMs`, `hasTimeFor`, `chainSelf`, курсоры `stage73_cursor`, heartbeat `merge_pipeline_cursor` RPC) | 15, 72, 73, `direct-pipeline` | убрать; в воркере — lease и обычные таймауты провайдера |
| Таблицы: `projects`, `sites`, `article_queue`, `article_drafts`, `article_sections`, `article_photos`, `outfits`, `outfit_items`, `generated_images`, `photo_candidates`, `workflow_stages`, `prompts`, `prompt_sets`, `niche_profiles`, `integrations`, `generations_log`, `provider_billing_status` | везде | модели Prisma; `jsonb` → `Json` в MariaDB; `generated_images` для `real_photo` — лишний «мост», можно убрать |
| FK `article_sections.outfit_id → outfits ON DELETE SET NULL`, `generated_images.outfit_id SET NULL` (`db/schema.sql:3423, 3455`) | шаг 15 удаляет `outfits` | учесть при повторном запуске плана: написанные секции теряют `outfit_id` |
| Ключи провайдеров из `integrations.encrypted_api_key` и `Deno.env` (`LOVABLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) | `getAnthropicApiKey`, `callOpenRouter`, 77 | `src/lib/resolve.ts` + `runSlot` портала; Lovable Gateway, LaoZhang, PoYo — нет на новом хосте |
| Прямые HTTP к `ai.gateway.lovable.dev`, `api.anthropic.com`, `api.laozhang.ai`, `api.poyo.ai`, `openrouter.ai` | 72, 73, 74, 77, `aiProvider`, `openrouter.ts` | один адаптер `src/lib/adapters.ts` (OpenAI-совместимый + Anthropic) |
| Storage: `public_url`/`storage_path`, префикс `/storage/v1/object/public/` для пропуска проверки (`qualityCheck:48`), `wp_url` | 15, 76, qualityCheck | файлы в `storage/`, отдача nginx `/files/` |
| `npm:@supabase/supabase-js@2/cors`, `Deno.env.get`, `AbortSignal.timeout` | импорты | Node-эквиваленты |
| `workflow_stages` как журнал этапов и как контейнер данных (блюпринт 65, `trend_brief` в 11, `section_mapping` 64, `ordering_strategy` 55) | 65, 72, 73, 76, `trendBrief` | отдельная таблица/JSON-поле у статьи вместо «этапов-контейнеров» |

---

## 7. Слабые места (по коду)

### 7.1 Вступление/заключение получают незаполненные переменные и противоречивые инструкции
- Реальный промт `stage_7_intro_outro` (`PROMPTS.md:335-339`) содержит `Outro plan: {{outro_plan}}` и `Care plan: {{care_plan}}`, а `fn/stage7-write-intro/index.ts:255-310` эти переменные **не подставляет** (они есть только в `stage7-write-outro:160-161`). `fillVars` оставляет незаполненные `{{…}}` как есть и лишь пишет warn (`365-366`); в intro нет `stripPlaceholders`, который есть в outro (`190-193`). Модель видит буквальные `{{outro_plan}}`.
- Тот же промт требует обернуть ключ в `<b>` и разрешает `<b>, <em>` (`PROMPTS.md:342, 346`), а код затем `stripEmphasis` всё снимает (`intro:606-615`) — расход токенов на заведомо вырезаемую разметку и противоречие с `mem/constraints/no-text-emphasis.md`.
- Дефолты `{{content_angle}}` = `"structured silhouettes meeting soft pastels and bold accents"` (`653`) и `{{subcategories}}` = `"various summer styles and occasions"` (`678`), `{{price_range}}` = `"various price points"` — fashion-заглушки, которые реальный промт для волос/ногтей действительно использует (`PROMPTS.md:337-338`), когда у `intro_plan` нет `p2_answer.text`.

### 7.2 `normalizeSections` присваивает номера секций по позиции
`fn/stage7-write-sections/index.ts:2506-2513`: `finalSectionNum = expectedSectionNumbers[idx]` всегда, когда ожидаемый список известен. Если модель пропустила секцию в середине пачки (вернула 7 из 8), текст про фото 5 сохраняется под номером 4 и т.д., а «пропавшей» объявляется последняя. Конвейер дописывает последнюю, и статья уезжает с рассогласованными фото/текстом без единой ошибки.

### 7.3 План секций ломает углы для одежды и интерьера
`fn/stage-photo-section-plan/index.ts:316, 333-337` просят модель использовать `fashionAngles`/`interiorAngles` (`proportion`, `layout`, …), но `enforceDistribution:147` заменяет любой угол не из `ANGLES` (ногтевые/универсальные `photo_read`, `technique`, `diy_howto`…) на `pick(ANGLES, i)`. Для ниш `outfits`/interior рецепт всегда получает чужие углы. Там же: реальный промт использует `{item_name}`, `{images_table}`, `{image_context}` (`PROMPTS.md:733-791`), которых нет в `vars` (`301-324`) — остаются литералами.

### 7.4 Писатель секций может остаться без брифов
`fn/stage7-write-sections/index.ts:527-529` дописывает брифы только если в промте нет строки `SECTION BRIEFS`. В наборе «Одежда · Реальные фото» промт содержит заголовок `SECTION BRIEFS` и опечатку `{{section_brief}}` (`PROMPTS.md:4286-4287`) — переменная не подставляется, брифы не дописываются, модель получает заголовок и пустой плейсхолдер. Любая проверка «остались `{{…}}` после подстановки» это бы поймала.

### 7.5 Один проблемный снимок валит пачку и статью
`fn/stage7-write-sections/index.ts:297-299`: если у фото нет фактов и `describePhoto` не справился — `throw` для всех 8 секций пачки. В `direct-pipeline:2252-2263` такая ошибка — `fatal`, и при пустом `missingSet` (`2286`) статья падает на шаге 73, хотя 7 секций можно было написать. Логичнее — исключить одну секцию, как делается для «фото нет» (`251-256`).

### 7.6 Сырой ответ модели может стать текстом секции
`fn/stage7-write-sections/index.ts:2486-2494`: для `singleSection` при провале разбора `lastContent` целиком сохраняется как `html_content` (это ветка «последнего шанса» `forceRewrite`). Далее для секций нет проверки `looksLikeRawJson` (она есть только для intro/outro в `assemble:142, 269`); `looksLikeFactDump` JSON не ловит; при ≥ 40 словах секция сохраняется и собирается. `toSectionList:3303` аналогично возвращает `[parsed]` для любого объекта.

### 7.7 `stage7-write-outro` — дубль шага 72 с нарушениями
Пишет заключение второй раз (`DELETE outro` → INSERT, `283-298`), затирая результат 72 с другим `word_count` (не пересчитанным, `294`). Его `postProcessHtml` **добавляет `<b>`** вокруг ключа (`368-382`) и не вызывает `stripEmphasis`; `context.stage: 72` в `callGemini` при `stage 74` в журнале (`410`); ~430 строк мёртвого кода (`buildComparisonData`, `assignGroup`, FAQ-парсеры, `540-972`). Всё ещё вызывается из `queue-orchestrator:2042` и UI `src/lib/stageRunners.ts:481`.

### 7.8 Повтор плана по фото стирает связи написанных секций
`fn/stage-photo-plan/index.ts:277-278` удаляет `outfits` и `generated_images`; `article_sections.outfit_id` по FK становится `NULL` (`db/schema.sql:3423`). Защита «не трогаем написанное» (`499-508`) касается только удаления строк, но `remapOutfits` (`526-536`) перепривязывает только строки нового `sectionRows`, а не старые написанные. Идемпотентный пропуск (`117-126`) смягчает, но повторный запуск после сброса этапа возможен (`direct-pipeline` «ручной сброс каскадно сбрасывает последующие»).

### 7.9 Удаление «пустых» секций вместе с фото — тихая потеря материала и расхождение с документацией
`direct-pipeline:2385-2393`: если ≤ 20 % секций так и не написаны и остаётся ≥ 15, секции **и их `article_photos`** удаляются, шаг помечается успешным. `MIGRATION.md:154` утверждает «Пустые секции — критическая ошибка (статья не идёт дальше)». Для ниш, где важен каждый кадр, это неожиданное поведение; плюс одобренные модератором фото исчезают без следа в UI.

### 7.10 Хардкод моделей, ниш и провайдеров
- Модели Anthropic `claude-haiku-4-5-20251001` / `claude-sonnet-4-20250514` и цены `[1,5]`/`[3,15]` продублированы в 72 (`792, 861`), 73 (`2153, 2272`), 74 (`434, 500`); подмена на `openrouter:deepseek/deepseek-v4-flash` (`intro:405`); Lovable `MODEL_MAP` ×3; в 77 — `gemini-2.5-flash-preview-05-20`, `gemini-3-flash`, `google/gemini-2.5-flash-lite` (`306, 330, 346, 258`); `laozhang_nothinking`/`lovable_gateway` в цепочках 15/16 (`198-201`, `343-346`).
- Нишевые заглушки: `"Nail design idea"` (`assemble:462`), `"inspiration to save for your next set"` (`assemble:472-473`), `"styling notes for every outfit"` в резервной мете (`77:524`), `"Final Thoughts"` (`assemble:272`), `careH2Default` только для ногтей/волос (`assemble:253-255`), fashion-чеклисты `buildP1Checklist/extractSubcategories` (`intro:656-735`), «in 2026» (`65:707`), `target_country "USA"` в 65 против `"US"` в 15.
- Промт 77 (`14-105`) живёт в коде, а не в наборе; `stage_8_meta` в seed-данных нет.

### 7.11 Дублирование логики между функциями
- `callAI` / `extractResult` / `getEndpoint` / `getAnthropicApiKey` скопированы в 72 (`739-909`), 73 (`2079-2312`), 74 (`384-534`) с расхождениями (`maxTokens` 4096/16384/8192/6000, `temperature` 0.6/1, наличие prompt caching).
- `postProcessHtml` — три версии (`73:2025`, `72:606`, `74:368`), одна из них выделяет жирным.
- `stripEmphasis` — `sh/textGuards.ts:240` и локальная в `assemble:430` без правила `*x*`.
- Разбор JSON — четыре реализации: `sh/jsonRepair.parseModelJson`, `73:extractJsonFromResponse`, `74:extractJson`, `sh/introOutroParse`.
- `slugify` — четыре (`15:38` ≤ 90, `65:71` ≤ 80 и regex `['']` из двух прямых апострофов — типографский `’` не вырезается, `assemble:534` не используется, `77:130` без лимита).
- Нишевые override `stage7_{haircolor|hairstyle|nails}_*_id` скопированы в 72/73/74 (`179-196`, `100-128`, `68-85`).
- `normalizeFaqItems`/`parseFaqItemsFromHtml` — в `introOutroParse` и в 74.

### 7.12 Расточительные вызовы и обращения к базе
- Проверка существования `outfits` по одному SELECT на кандидата на каждую секцию (`73:771-776`) при 2 кандидатах × 8 секций × волна из 7 — до 112 запросов за волну.
- HEAD-запрос на каждое фото пачки при каждом вызове, включая повторы и ретрай-фазы (`73:607-619`); `qualityCheck` потом делает это снова.
- Вступление: до 5 попыток с принудительной сменой модели на DeepSeek (`intro:403-405`) — выбранная в сценарии модель теряется ради «не объёмной» ошибки, а `fallbackCandidate` всё равно принимает интро 60–160 слов.
- `stage-photo-plan:214` передаёт `fallbackChain: [at.chain[0]]` — второй провайдер цепочки (`laozhang_nothinking`) никогда не используется, попытка №1 тратит до 105 с на одного провайдера.
- `stage77` читает `outfits.seo_keyword` с `limit(10)` без `order` — LSI-набор меняется между запусками, что ломает детерминизм валидации.
- `qualityCheck.looksLikeFactDump(intro_text)` (`178`) никогда не срабатывает для compact-писателя: он пишет `intro_text: null`, текст лежит в `html_content`.

### 7.13 Мелкие несоответствия
- Пороги `qualityCheck` (title ≤ 65, description 120–175) мягче правил 77 (≤ 60, 140–160) и расходятся с текстами сообщений (`216-220`).
- `assemble:168` вставляет H2 без `escapeHtml` (стандартная ветка) при экранировании в compact-ветке (`212`).
- `article_drafts.total_sections` после сборки включает intro/outro (`assemble:298`), после плана — только секции с фото (`15:484`).
- Стоимость: intro-строка получает всю стоимость вызова, outro — 0 (`intro:534, 544`); 73 делит `cost` на `sections.length`, включая не сохранённые; 77 пишет в `projects.total_cost`, а 72/73 — в `article_drafts.total_generation_cost`.
- Модульная переменная `fnDeadline` (`73:70, 74`) общая для параллельных запросов одного изолята: волна из 7 вызовов сдвигает дедлайн ранних запросов.
- `MIGRATION.md:154` называет запасные ключи `stage_7_intro`/`stage_7_outro` — в seed-данных их нет (только `stage_7_intro_outro`), ветка легаси в 72/74 мёртвая.
- `article-text-hygiene.md` указывает `uniqueHeading` в 15 и 73; фактически ещё и в 16 (`386-401`) — тройная уникализация одного и того же заголовка.

---

## 8. Рекомендации для порта

**Перенести как есть (логика проверена практикой):**
- `sh/textGuards.ts` целиком (`sanitizeTopic`, `headingKey`, `uniqueHeading`, `looksLikeFactDump`, `stripLeadingFactDump`, `containsInternalLabel`, `stripInternalLabels`, `stripEmphasis`) — единственная копия, использовать и в сборке.
- `sh/introOutroParse.ts` (`parseIntroOutroResponse`, `looksLikeModelThinking`, `looksLikeRawJson`) — применять также к секциям.
- `sh/countToken.ts` (`{{COUNT}}`, `patchCount`, `retargetCount`, `countTokenPromptBlock`) — ключевой механизм пересчёта после модерации.
- `sh/jsonRepair.parseModelJson` + `extractSectionsFromTruncated` из 73 как единый «мягкий JSON».
- `enforceDistribution` и `normalizeRecipe` из 16 (с исправлением 7.3: валидировать угол по списку, который реально отдали в промт).
- Правила 77: `validate()`, `SLUG_SHAPES`/`SLUG_SAFE_WORDS`, `normalizeMetaYear`, `deTemplate`, `padDescription`, `titleCase`, детерминированный `hashPercent` для года в URL и формы тайтла, `fallbackMeta`.
- `buildImageBlock`/`buildAltText`/`buildCaptionHtml` и `normalizeArticleHtml` из 76 (вынеся нишевые строки в профиль ниши).
- `qualityCheck` как шаг перед публикацией (с исправлением проверки `looksLikeFactDump` по `html_content` и порогов).

**Объединить:**
- 72 + 74 → один шаг «вступление и заключение» на промте `stage_7_intro_outro`; `stage7-write-outro` не переносить, `care_block` — отдельным опциональным полем ответа того же вызова, если нужен.
- `callAI`/`extractResult`/`getEndpoint` ×3 → один адаптер `runSlot` портала (слоты `text_writer`, `text_plan`, `text_meta`, `vision_describe`), цены и имена моделей — в таблице моделей, не в коде.
- `postProcessHtml` ×3 и `stripEmphasis` ×2 → одна функция `cleanArticleHtml` (stripEmphasis → обёртка `<p>` → чистка плейсхолдеров `{{…}}` кроме `{{COUNT}}`).
- `slugify` ×4 → одна (с `['’]` и лимитом 90).
- Нишевые override промтов (`stage7_*_id`, `---USER---`, compact/compact2/compact3) → только `stage_key` из набора промтов: `rp_photo_plan`, `rp_section_plan`, `stage_7_writer_system`, `stage_7_writer_user`, `stage_7_intro_outro`, плюс новый `stage_8_meta` для 77.
- 15 + 65: для `real_photo` блюпринт нужен только ради `main_image`/`photo_facts`; хранить план секций и ссылку на фото прямо в секции (`PinArticleSection.photoId`), «мост» `generated_images`/`outfits` не создавать.

**Упростить:**
- Убрать все бюджеты под 150 с (`FN_BUDGET_MS`, `aiDeadline`, `chainSelf`, курсоры, heartbeat): воркер пишет секции последовательно или с ограниченным параллелизмом, хранит прогресс в статусах секций.
- Пачки: один вызов на пачку из N секций с жёсткой привязкой по `section_number` в ответе (не по позиции, см. 7.2); при неполном ответе — дописывать только реально отсутствующие; одна проблемная секция не валит пачку (см. 7.5); никогда не сохранять сырой ответ (см. 7.6) и ничего не удалять молча (см. 7.9) — оставлять статью в статусе «нужны правки» с перечнем секций.
- Переменные промтов: единый словарь `{{…}}` для всех шагов; после подстановки — проверка на остатки `{{…}}`/`{…}` (кроме `{{COUNT}}`) с ошибкой шага, а не warn (закрывает 7.1, 7.3, 7.4). Убрать fashion-заглушки `price_range/content_angle/subcategories/p1_must_include` — для `real_photo` они не нужны.
- `stage7-write-sections` — оставить только ветку compact3/real_photo (`buildCompact3Brief` + `buildRecipeBrief` + блок `PHOTO DESCRIPTIONS`); форматы A–G, `buildSectionBrief` на 420 строк, продукты/отзывы/цены (`blueprintProducts` всегда пустой `Map`, `350`) — не переносить.
- Рендер фото в секции: один источник правды — `article_photos` (URL, размеры, источник, подпись); хранить текст автора отдельно от собранного HTML (сейчас `html_content` перезаписывается при сборке, из-за чего нужны `stripImageArtifacts`/`removeExistingStlBlocks`).
- `parse-keyword-ai`: оставить один универсальный промт из профиля ниши (ногтевой `SYSTEM_PROMPT` — как профиль ниши `nails` с примерами), `validateClosed` сделать реальной валидацией с фолбэком `none`.
- `reorder-article-sections`: в транзакции Prisma без трюка с отрицательными номерами.
