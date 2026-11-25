# 06. Промты и конфигурационные данные (перенос 1:1 через seed)

Источник: архив `mig/` (db/data_*.sql, db/schema.sql, PROMPTS.md, supabase/functions). Дата снимка базы — 2026-10-06, снимок профилей ниш — 2026-09-19.
Машинно-читаемые экспорты рядом: `prompts.export.json` (49 активных промтов, 339 КБ) и `config.export.json` (сценарии, ниши, профили, модели, automation_settings — 108 КБ). Скрипты парсинга: scratchpad `tools/pgparse.py`, `tools/export_prompts.py` (парсят pg_dump INSERT напрямую, количества совпали с `grep -c INSERT`).

Итого в базе: **10 наборов, 68 промтов, 0 версий (prompt_versions пуст), 8 сценариев, 9 ниш, 8 профилей ниш, 16 моделей провайдеров, 1 строка automation_settings**; generated_photo: 41 визуальных промтов, 5 групп, 41 элемент групп, 214 эталонных фото.

---

## 1. Наборы промтов (prompt_sets)

Схема: `id uuid, user_id, name, description, niche_code, subniche_code, article_format ('generated_photo'|'real_photo'), is_active, created_at, updated_at`. Все наборы одного владельца (`dcc2d918-…`), `subniche_code` везде NULL.

Полный комплект по реестру UI (`src/lib/promptRegistry.ts`): для `generated_photo` — `stage_2`, `stage_5_scene_planner` (необязателен, исключён для ногтей), `stage_6_image_seo`, `stage_7_writer_system`, `stage_7_writer_user`, `stage_7_intro_outro`; для `real_photo` — `rp_photo_search`, `rp_photo_rate` (необязателен), `rp_photo_plan`, `rp_section_plan`, `stage_6_image_seo`, `stage_7_writer_system`, `stage_7_writer_user`, `stage_7_intro_outro`.

| id | Название | Ниша | Формат | active | Промтов | Чего нет из комплекта | Решение |
|---|---|---|---|---|---|---|---|
| `7d900c16-ccb3-4e64-945b-292959204cf8` | Дизайн ногтей · AI-фото | nails | generated_photo | ✔ | 5 | `stage_5_scene_planner` (для ногтей и не нужен) | переносить |
| `cfc57d0b-0793-4cc5-b223-3abdc6f48a73` | Дизайн ногтей · Реальные фото | nails | real_photo | ✔ | 8 | — (полный) | переносить |
| `6a6bf74e-6b0d-4c57-b823-ae5881b4ff22` | Дизайн ногтей · AI-фото (копия) | nails | generated_photo | ✘ | 5 | то же | **не переносить**: 5/5 промтов байт-в-байт равны оригиналу |
| `75fe1ee8-419e-4c07-9b9c-3081561470ec` | Дизайн ногтей · Реальные фото (копия) | nails | real_photo | ✘ | 8 | — | **не переносить**: 8/8 идентичны оригиналу |
| `73ec48fb-c668-4c27-967d-ce106b64c49d` | Волосы AI фото | hair | generated_photo | ✘ | 6 | — (полный) | **переносить как неактивный**: единственный набор волос для AI-фото, на него ссылается сценарий №4 (`prompt_set_id` работает и для неактивного набора — `resolvePromptSetId` проверяет `is_active` только при подборе по нише) |
| `9b1f0a52-4c77-4c2e-9ad4-5b20e7a0c101` | Волосы · Реальные фото | hair | real_photo | ✔ | 8 | — | переносить |
| `c1a10000-0000-4000-8000-000000000001` | Одежда · AI-фото | outfits | generated_photo | ✔ | 6 | — | переносить |
| `c1a10000-0000-4000-8000-000000000002` | Одежда · Реальные фото | outfits | real_photo | ✔ | 8 | — | переносить |
| `c1a20000-0000-4000-8000-000000000001` | Интерьер и декор · AI-фото | interior | generated_photo | ✔ | 6 | — | переносить |
| `c1a20000-0000-4000-8000-000000000002` | Интерьер и декор · Реальные фото | interior | real_photo | ✔ | 8 | — | переносить |

Без копий остаётся **8 наборов / 55 промтов** (49 в активных + 6 в «Волосы AI фото»). В `prompts.export.json` — только 7 активных наборов (49); промты набора «Волосы AI фото» нужно добрать из `data_prompts.sql` по `set_id = 73ec48fb…` (скрипт берёт только `is_active` наборы — см. §7, что доработать).

Нишевых наборов для `blog`, `tattoo`, `makeup`, подниш `manicure/pedicure/decor/outdoor` нет — хотя ниши/профили есть.

Колонки `prompts`, которые реально используются кодом: `set_id`, `stage_key`, `content`, `system_part`, `model` (почти не используется, см. §8), `is_active`, `created_at` (порядок выбора варианта). Колонки `group_id` (везде NULL), `prompt_group`, `prompt_type`, `niche_code`, `version` — наследие старой системы «групп промтов», в новых стадиях не читаются (только в legacy-ветках `outfit-concepts`, `stage64`, `trend-research` через `project.prompt_group_id`). Легаси-разделитель `---USER---` в текстах не встречается ни разу.

---

## 2. Промты по stage_key

Как резолвятся (`_shared/promptSet.ts`): набор = `project.prompt_set_id` → иначе активный набор по (niche, subniche IS NULL, format). Промт шага = `scenario.stage_prompt_ids[stage_key]` (если он принадлежит набору) → иначе первый по `created_at` промт этого `stage_key` в наборе. Подстановка `fillVars` понимает `{var}` и `{{var}}`, незаполненные оставляет как есть и пишет warning. **Исключения**: `stage-photo-rate` имеет свой `fillVars`, понимающий только `{var}` и фиксированный список из 7 ключей; `photoQueries.ts` — свой `fill` по regex. Модель для шага берётся из `scenario.stage_models[stage_key]` (`provider:model`), а не из `prompts.model`.

Условные обозначения ниже: **П** — переменные в тексте промта, **К** — что подставляет код, ✘ — расхождение.

### `stage_2` — Концепт-план (AI-фото)
Один вызов вместо старых шагов 1/6.4/6.5/7.1/8: тренды, список дизайнов (по одному на секцию), ключи, план секций, план вступления/заключения, мета. Есть в: ногти AI, волосы AI (неакт.), одежда AI, интерьер AI. Модель в колонке: `gemini-3-flash-preview`; фактически в сценариях `openrouter:google/gemini-2.5-flash-lite`. Код (`stage2-concept-plan`): `responseFormat: json`, temperature 0.8, maxTokens 32000, к system дописывается «контракт темы» (`buildTopicContract`).
- **П** (во всех): `topic, focus_keyword, niche, subniche, count_items, sections_count, language, target_country, target_word_count, article_personality, keywords_table` (одиночные скобки); интерьер ещё использует метку `{{COUNT}}`.
- **К**: те же + `niche_label, topic_facts, concept_fields` (промты их не используют ✘ — данные профиля ниши теряются).
- ✘ `keywords_table` всегда «(нет данных по ключам)» — `keywordRows` в коде пустой массив, DataForSEO отключён; в промтах при этом целый раздел «KEYWORDS».
- ✘ Реестр UI обещает `keyword_nail_*`, `keyword_hair_*`, `outfit_mode`, `decor_mode`… — код их **не подставляет** (вместо этого добавляет контракт темы текстом).
- Ответ: один JSON: `trend_context{current_trends[], style_directions[], celebrity_references[], color_trends[], technique_trends[], visual_direction, seasonal_notes}`, `meta{h1_title, seo_title, meta_description, url_slug, theme, hook, narrative_arc, article_personality}`, `ordering_strategy, visual_flow_note`, `designs[{name, position, role, seo_keyword, style_description, section_plan{h2_draft, angle_note, bullets, callback_detail, bonus_type, difficulty_level, …}, …нишевые поля}]`, `intro_plan{p1_hook, p1_source, p2_answer, p3_personal…}`, `outro_plan`, `faq_plan`, `how_to_care`, `comparison_table_plan`. Ногти: 94 ключа, одежда: 105, интерьер: 107.
- ✘ `faq_plan`, `comparison_table_plan` **ни одна функция не читает** (grep по functions — 0 вхождений); `how_to_care` читается только в outro как `care_plan`. Мёртвый вывод: ногти ~7,8 КБ текста промта, интерьер ~4,4 КБ, одежда ~2,7 КБ.

### `stage_5_scene_planner` — Планировщик сцены (AI-фото, кроме ногтей)
Два разных потребителя одного ключа. (a) `stage5-generate-outfit-image` (одежда, интерьер): промт заменяет встроенного «автора промта» для генератора картинок; **К**: `item_name, item_details, style_description, photography_direction, focus_keyword, scene_context`; **П**: `item_name, item_details, style_description, photography_direction` — совпадает. Ответ — свободный текст сцены, заканчивающийся «Vertical 2:3 composition…», JSON нет. (b) `stage5-scene-planner` (legacy-ветка волос): промт берётся как system **без подстановки переменных**, user собирается кодом (`Article keyword / Scene mode / looks`), ответ JSON `{scene_mode, plans[{outfit_index,…}]}`. Для волос промт лежит в неактивном наборе.
- Упоминает «an OpenAI GPT Image model» — завязка на провайдера в тексте промта.

### `stage_6_image_seo` — SEO изображений (оба формата, все 7 активных наборов)
alt/title/description/file_name для всех картинок статьи одним запросом. **К** (`stage6-image-processing`): `keyword, focus_keyword, language, item_name (= имя ПЕРВОЙ картинки), image_context, images_table`. **П**: `focus_keyword, image_context, images_table` (+ `language, item_name` в 5 из 7). Расхождений нет. Если в промте есть `images_table`, код дописывает только «Include the row's id…», иначе — свою таблицу и формат. Ответ: JSON-массив `[{id, alt_text, title, description, file_name}]` (в AI-наборах перечислены ключи `alt, filename, index, title` — код всё равно требует `id`). ✘ `item_name` = «Current image: <первая картинка>» при пакетной обработке — вводит модель в заблуждение.

### `stage_7_writer_system` — Автор, постоянный блок
Персона и правила: Maya (ногти, одежда), Nora (волосы), Hannah (интерьер). Загружается в трёх функциях: `write-sections`, `write-intro`, `write-outro` (system = `[system_part, content]`), после чего код всегда дописывает `countTokenPromptBlock()` (метка `{{COUNT}}`), для intro — обязательный блок «INTRO LENGTH 2 абзаца 90–120 слов», для outfits/interior — FASHION/HOME DECOR CONTRACT.
- **П**: `article_personality, focus_keyword` (5 из 7), волосы-real: `topic_kind, required_facts`; интерьер — `{{COUNT}}`.
- **К** в секциях — полный набор (см. writer_user); в intro/outro — свои наборы, где `topic_kind`/`required_facts` **нет** ✘ (в волосах они останутся «{{…}}» в intro; в outro вычищаются safety-net'ом `stripPlaceholders`).
- Ответа нет (system).

### `stage_7_writer_user` — Автор, секции (батчами по 4–5)
**К** (`stage7-write-sections`, все `{{…}}`): `niche_label, topic_kind, required_facts, topic_facts, batch_number, total_batches, batch_size, article_personality, focus_keyword, previous_batch_summary, previous_ending, keywords_bolded_previous, section_briefs, batch_sections(=section_briefs), hair_brief, trend_context, cut_specs, scene_context, search_queries_brief, article_context, section_plans, section_data` (последние два пустые при compact2/3).
**П**: `article_context, batch_size, focus_keyword` (все 7); `article_personality, batch_number, total_batches, previous_batch_summary, previous_ending, keywords_bolded_previous, scene_context, trend_context` (5); `section_briefs` (6); `hair_brief, cut_specs` (2 — волосы-real и интерьер-AI); `required_facts, topic_kind` (волосы-real).
- ✘ **Одежда · Реальные фото** использует `{{section_brief}}` (ед. число) — код заполняет `section_briefs`. Переменная остаётся незаполненной, а страховка `if (!userPrompt.includes("SECTION BRIEFS"))` не срабатывает, потому что заголовок «SECTION BRIEFS» в промте есть. Итог: секции одежды по реальным фото пишутся **без брифов**. Исправить при переносе.
- ✘ Код подставляет `niche_label, topic_facts, search_queries_brief` — ни один промт не использует.
- ✘ Реестр обещает `section_brief, item_name, item_details, target_word_count` — код не подставляет.
- Ответ: JSON `{sections:[{section_number, h2, html, word_count, keywords_used, format_used}]}` (5 из 7); у коротких наборов одежда/интерьер-real — «Return the exact JSON requested» без схемы (схема приходит из code-брифов).

### `stage_7_intro_outro` — Вступление и заключение
Один и тот же промт вызывается **дважды** — из `write-intro` и из `write-outro`, с разными наборами переменных.
**К intro**: `article_personality, focus_keyword, primary_keyword, total_outfits(={{COUNT}}), p1_draft, p2_draft, p3_draft, p1_pattern, trend_details, price_range, content_angle, subcategories, market_urgency, forbidden_phrases, p1_must_include, p3_must_include, intro_plan, trend_data, trend_context, article_context, fashion_contract, outfit_mode, interior_contract, decor_mode, hero_element, setting, room, style, hero_piece, previous_ending`.
**К outro**: `article_personality, focus_keyword, primary_keyword, previous_ending, trend_context, outro_plan, care_plan, article_context, fashion_contract, outfit_mode, interior_contract, decor_mode, hero_element, setting, room, style, hero_piece`.
**П**: `article_context` (7), `focus_keyword` (6), `care_plan, content_angle, outro_plan, previous_ending, primary_keyword, subcategories, total_outfits, trend_context, trend_details` (5), `article_personality` (4), `{{COUNT}}` (3), интерьер-real: `interior_contract, decor_mode, hero_element, room, setting`; одежда-real: `fashion_contract, outfit_mode, hero_piece`; волосы: `topic_kind`.
- ✘ В intro-вызове не заполняются `care_plan, outro_plan`; в outro-вызове — `content_angle, subcategories, trend_details, total_outfits` (в outro есть `stripPlaceholders`, в intro — нет: метки уходят модели). `topic_kind` не заполняется ни там, ни там.
- ✘ Реестр обещает `blueprint, sections_summary, language` — не подставляются.
- Ответ: JSON `{intro_html, outro_html}` (5 наборов) или `{intro_text, intro_word_count, outro_text, outro_word_count}` (одежда/интерьер-real) — парсер `introOutroParse.ts` принимает оба варианта, это не ошибка.

### `rp_photo_search` — Поисковые запросы для фото (real_photo)
3 вариации Focus Keyword для добора Google Images. **К** (`photoQueries.ts`): `focus_keyword, topic, language (по умолчанию "English", а не "en"), target_country (из photo_search_config.country), niche, subniche, outfit_mode, fashion_contract, decor_mode, hero_element, setting, interior_contract`. **П**: `focus_keyword` (4), `topic, target_country, niche, subniche` (ногти, волосы), `fashion_contract`/`interior_contract` (одежда/интерьер), `topic_kind` (волосы).
- ✘ `topic_kind` в волосах **не подставляется** (нет в карте `photoQueries`).
- ✘ Промты просят `{"queries":[3]}`, код дописывает `RU_NOTE`, требующий `{"primary":[3],"secondary":[3],"moderator_translation_ru"}` и отдельно оговаривает несовместимость («If your instructions above ask for a single queries list…»). Контракт ответа фактически задан кодом, промт устарел.
- Модель: единственный шаг, где `prompts.model` реально участвует (`selectedModel || configured?.model || MODEL`), но сценарии задают свою.

### `rp_photo_rate` — Оценка фото (real_photo, необязателен)
**К** (локальный `fillVars`, только `{var}`): `topic, focus_keyword, niche, subniche, language, topic_kind, subject_label`. **П**: `focus_keyword, topic, language` (4), `niche, subniche` (ногти, волосы), `topic_kind, subject_label` (волосы), `fashion_contract` (одежда), `interior_contract` (интерьер).
- ✘ `{fashion_contract}` / `{interior_contract}` **не подставляются** — модель получает буквально «{fashion_contract}». Контракт при этом код добавляет отдельно (FASHION_RULES/INTERIOR_RULES), так что смысл не теряется, но текст замусорен.
- ✘ Промт задаёт свой контракт ответа («Score 1-10, reason in Russian, return ONLY JSON»), а код **дописывает** `JSON_CONTRACT` с полной схемой: `{photos:[{n, score, verdict, topic_ok, topic_miss, catalogue, catalogue_reason, ai_likelihood, ai_artifacts[], subject_age, virality, trend, trend_reason, composition, lighting, framing, reason, facts{…из профиля ниши}, description}]}` + TOPIC_RULES + CHECKLIST + rescue-режим. Промт реально задаёт только «вкус» отбора; формат ответа — целиком код.

### `rp_photo_plan` — Планирование по фото (real_photo)
Аналог концепт-плана от реальных фото. **К**: `topic, topic_kind, niche_label, subject_label, required_facts, focus_keyword, language, target_country, niche, subniche, count_items, sections_count, total_sections, target_word_count, article_personality, photos_table, photo_captions, outfit_mode, fashion_contract, decor_mode, hero_element, setting, interior_contract`. **П**: подмножество (`focus_keyword, sections_count, photos_table` везде; длинные наборы ногти/волосы — ещё 7–10 переменных; одежда/интерьер — контракт). Расхождений «промт просит, код не даёт» нет. Ответ: ногти/волосы — большой JSON (`meta, ordering_strategy, sections[{photo_n, h2, h2_draft, …}], intro_plan, outro_plan, how_to_care…`, 66–71 ключ); одежда/интерьер — компактный `{intro_plan, outro_plan, sections[{photo_n, h2, angle, styling_tips, color_palette[], fashion_details|interior_details{}, seo_keyword}]}`. Код при повторе дописывает «Return ONLY one valid JSON object with key "sections"».

### `rp_section_plan` — План секций (real_photo)
Дешёвая модель назначает каждой секции рецепт (угол, заход, длина, списки, уход, честный минус). **К**: `topic, topic_kind, niche_label, subject_label, required_facts, focus_keyword, language, niche, subniche, sections_count, total_sections, article_personality, target_word_count, photo_facts_table, angles, openers, outfit_mode, fashion_contract, decor_mode, hero_element, setting, interior_contract`. **П**: `focus_keyword, sections_count, photo_facts_table` везде; ногти/волосы — `angles, openers, topic, language, niche, subniche, article_personality, target_word_count` (+`topic_kind, subject_label, required_facts` у волос); одежда/интерьер — контракт. Расхождений нет. Ответ: `{sections:[{section_number, angle, opener, length, paragraphs, include_list, list_focus, include_care, include_occasion, include_diy_vs_salon, include_honest_minus, focus_fact, avoid, note}]}` (ногти/волосы); одежда/интерьер — «Return JSON only» без схемы (схема в FALLBACK коде).

### Ключи, которые код ищет, а промтов нет
`stage_1` (trend-research), `stage_64` (keyword-research), `stage_55_review`, `stage_55_ordering`, `stage_7_intro`, `stage_7_outro` (legacy-фолбэки). Все работают на встроенных промтах. В реестре UI их нет — заводить не нужно.

### Сводка расхождений
| Где | Промт использует, код не даёт | Код даёт, промты не используют |
|---|---|---|
| stage_7_writer_user (одежда-real) | `section_brief` (опечатка → `section_briefs`) | `niche_label, topic_facts, search_queries_brief` |
| rp_photo_rate (одежда/интерьер) | `fashion_contract`, `interior_contract` | — |
| rp_photo_search (волосы) | `topic_kind` | `outfit_mode, decor_mode, hero_element, setting, language` |
| stage_7_intro_outro | в intro: `care_plan, outro_plan`; в outro: `content_angle, subcategories, trend_details, total_outfits`; везде `topic_kind` | `p1_draft…p3_must_include, market_urgency, price_range, forbidden_phrases, intro_plan, trend_data, room, style` |
| stage_7_writer_system (волосы, в intro/outro) | `topic_kind, required_facts` | — |
| stage_2 | — | `niche_label, topic_facts, concept_fields`; `keywords_table` всегда пустая |
| Реестр UI (все шаги) | обещает `keyword_*`-замки, `blueprint, sections_summary, item_name, section_brief, target_word_count` | не подставляются ни в одном шаге |

---

## 3. Сценарии (scenarios)

Таблица — 73 колонки, большинство наследие (`stage55_*`, `nanobanana_*`, `ai_provider`, `stage4/36/71/77_provider`, `disclaimer_*`, `stage3_priority_mode`, `stage35_enabled`, `article_type`, `parse_keyword_provider`, `stage1_provider`, `stage5_prompt_mode`, `stage5_prompt_template_id`, `pipeline_config`, `publish_config`). Реально в проект переносит `applyScenarioToProject` (`_shared/applyScenario.ts`): `execution_mode, stage5_mode, stage5_prompt_id, stage5_group_id, stage_prompt_ids, stage_models, niche_code, subniche_code, article_format, prompt_set_id` + опционально `schema_enabled, stage2_provider, stage5_api_provider, stage51_provider, stage51_model, stage6_provider, stage16_provider, stage16_model, stage5_image_model, stage5_image_quality, stage5_image_size, disclaimer_*, stage7_batch_size, stage7_article_personality, stage7_target_word_count, photo_search_config, publish_mode, seo_year_url_percent, stage7_4_enabled`. Количество идей задаётся при постановке в очередь (`article_queue.count_outfits`), сценарий его не трогает.

8 сценариев, все `is_active = true`, `is_default = false`:

| № | Название | Ниша | Формат | Набор | execution_mode | batch | personality | stage5 (картинки) | photo_search_config |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Ногти — AI-фото | nails | generated_photo | 7d900c16 | scenario | 4 | null | group `5fa78894` (Маникюр 1, 9 промтов), prompt `950041d9`, `gpt-image-2` low 1024×1536 | минимальный (см. ниже) |
| 2 | Ногти — реальные фото | nails | real_photo | cfc57d0b | scenario | 5 | null | single/null | полный |
| 4 | Волосы AI фото | hair | generated_photo | 73ec48fb (неакт.) | scenario | 4 | null | group `d44b615f` (All, 12 промтов), `gpt-image-2`, quality/size null | минимальный |
| 5 | Волосы — реальные фото | hair | real_photo | 9b1f0a52 | scenario | 5 | null | single | полный |
| 6 | Одежда · AI-фото | outfits | generated_photo | c1a1…0001 | scenario | 4 | null | group `c1a1…00a1` (8 форматов кадра), `gpt-image-2` low 1024×1536 | минимальный |
| 7 | Одежда · реальные фото | outfits | real_photo | c1a1…0002 | **auto** | 5 | **wry** | single | полный, candidates 150 |
| 8 | Интерьер и декор · AI-фото | interior | generated_photo | c1a2…0001 | scenario | 4 | null | group `c1a2…00a1` (3 формата), `gpt-image-2` low 1024×1536 | минимальный |
| 9 | Интерьер и декор · реальные фото | interior | real_photo | c1a2…0002 | **auto** | 5 | **wry** | single | полный, candidates 150 |

(№3 отсутствует — удалён.)

**Одинаково во всех 8**: `stage7_target_word_count = compact3` (это стиль брифа, а не число слов), `schema_enabled = true` (никем не читается), `stage64_enabled`, `stage55_enabled`, `stage55_review_enabled`, `stage35_enabled`, `stage7_4_enabled = true`, `stage55_mistakes/alternatives` выкл., `stage5_api_provider = openai_image`, `stage5_prompt_mode = group`, `nanobanana_aspect_ratio 3:4 / 2K / ["2:3","1:1","3:4"]` (не используются при openai_image), `publish_mode = publish_then_edit`, `seo_year_url_percent = 100`, `disclaimer` null/11/#888888, `pipeline_config = {}`, `publish_config = {}`, `subniche_code = null`, провайдеры-дефолты `laozhang_nothinking` для stage1/4/36/55/71/77/parse_keyword, `stage2_provider = openrouter`.

**Различается**: ниша/формат/набор, `execution_mode` (scenario | auto), `stage7_batch_size` (4 для AI, 5 для real), `stage7_article_personality` (null | wry), `ai_provider` (lovable | openrouter — мёртвое поле), `stage51_provider/stage6_provider` (openrouter | laozhang_nothinking), `stage51_model` (`google/gemini-2.5-flash-lite` | null), `stage16_provider/model` (только real), картинки (`stage5_mode, stage5_group_id, stage5_prompt_id, stage5_image_model/quality/size`), `photo_search_config`, `stage_prompt_ids`, `stage_models`, `article_type` (nails везде кроме №5 — мусор).

**photo_search_config** (нормализуется `normalizePhotoConfig`, дефолты в `DEFAULT_PHOTO_SEARCH_CONFIG`):
- real-сценарии (№2, 5, 7, 9): `source dataforseo`, `country US`, `language en`, `license any`, `freshness any`, `image_type photo`, `orientation ["tall","square"]`, `min_width/min_height 450` (**код клампит до `MIN_PHOTO_SIDE = 550`** — реально 550), `min_score 8` (дефолт 7), `candidates_total 120` (ногти, волосы) / `150` (одежда, интерьер), `exclude_domains [alibaba, aliexpress, amazon, ebay, etsy, shein, temu, sewmamasew]`, `include_domains []`, `query_suffix ""`, `unique_mode soft`, `writer_mode description`, `caption_mode domain_link`, `caption_template "{credit} {domain}"`, `rating_model openrouter:google/gemini-2.5-flash-lite`, `rating_batch_size 8`.
- AI-сценарии: только `{min_width 450, min_height 450, orientation, caption_mode domain_link, exclude_domains [sewmamasew.com], caption_template}` — остаток, для generated_photo не используется.
- Гео/язык/свежесть переопределяются на уровне статьи из очереди (`applyQueueOverrides`: колонки Geo/Lang/Freshness Google-таблицы).

**stage_models** (везде `provider:model`): все дешёвые шаги — `openrouter:google/gemini-2.5-flash-lite` (stage_2, rp_*, stage_6, stage_5_scene_planner, `stage_5_1` — ключ «автора промта картинки», которого нет среди stage_key промтов); тексты — `openrouter:deepseek/deepseek-v4-flash` (writer_system, writer_user, intro_outro), у AI-сценариев ногти/одежда/интерьер intro_outro — `deepseek/deepseek-v4-pro-0813`. У real-сценариев есть лишний ключ `stage_2` (шаг не выполняется). У №2 (ногти-real) нет `stage_prompt_ids` для `rp_photo_search` и `stage_6_image_seo` — берётся первый по дате, что совпадает.

**Что куда при переносе** (кандидаты):
- «Настройка сайта/ниши» (одинаково для всех запусков ниши): набор промтов, `stage_models`, `stage_prompt_ids`, персона/`article_personality`, `batch_size`, `word_count`, `photo_search_config` без гео/языка/свежести (домены-исключения, min_score, candidates_total, caption_*, rating_*), провайдер и модель картинок, формат кадра/группа визуальных промтов, `publish_mode`, `seo_year_url_percent`.
- «Настройка запуска»: ниша+формат (= выбор сценария), количество идей (`count_outfits`), гео/язык/свежесть поиска, `execution_mode` (auto/scenario), источник ключей.
- Выбросить: `stage55_*`, `nanobanana_*`, `ai_provider`, `stage4/36/71/77_provider`, `disclaimer_*`, `stage3_priority_mode`, `stage35_enabled`, `article_type`, `schema_enabled`, `stage5_prompt_mode`, `stage5_prompt_template_id`, `pipeline_config`, `publish_config`, `parse_keyword_provider`, `stage1_provider`.

---

## 4. Ниши и профили ниш

**niches** (9): `outfits 👗 10`, `hair 💇 20`, `nails 💅 50` → `manicure 💅 10`, `pedicure 🦶 11`; `interior 🛋️ 60` → `decor 🪴 61`, `outdoor 🌿 62`; `blog 📝 70`. Все `is_active`. Подниш волос (`haircut/hairstyle/hair_color` из UI-фолбэка и docs) в таблице **нет** — тип темы волос вычисляется кодом (`hairTopicKind`). Ниш `tattoo`, `makeup` в `niches` нет, но профили для них есть.

**niche_profiles** (8: nails, manicure, pedicure, hair, outfits, tattoo, makeup, blog; все `updated_at 2026-09-19`). Структура JSON (`_shared/nicheProfile.ts`):
```
attributes[]      {key, label, values?[], fallback?}      — какие признаки извлекать из ключа (keyword_attributes)
required_visuals[] {label, values{имя: [маркеры]}}         — что должно быть видно на фото (чек-лист релевантности)
exclusive_terms[]  {scope?: regexp, variants: string[][]}  — взаимоисключающие слова (пальцы/ноги, стрижка/укладка…)
diversity_axes[]   {key, weight, values{имя: [маркеры]}}   — оси разнообразия при раскладке фото
search_templates   {primary[], topup[], negative[]}        — шаблоны запросов, {keyword}
constraint_specs   {source?: "nailSpecs"|"cutSpecs"} | {}  — ссылка на модуль физических ограничений
concept_fields[]                                           — поля концепта
fact_block         {fields[], note?, subject_label?, photo_facts{имя: описание}} — обязательные факты в тексте и в оценке фото
```
По нишам: nails/manicure/pedicure — три одинаковые строки (13 атрибутов, 4 словаря визуалов, 1 группа исключений «пальцы vs ноги», 5 осей, `constraint_specs {source: nailSpecs}`, 6 полей концепта, 6 фактов); hair — 12 атрибутов, 5 словарей, 2 группы исключений, `negative ["wig for sale","hair extension bundles"]`, `cutSpecs`; outfits — 10 атрибутов, 3 словаря, `negative ["product listing","shop now"]`, нет constraint_specs; tattoo — 8 атрибутов; makeup — 10; blog — минимальный (4 атрибута, 1 словарь, без исключений).

**Что главнее.** `loadNicheProfile`: база → `mergeProfile(дефолт из кода, строка)`, где **любое непустое поле строки целиком перекрывает код**, пустое (`[]`/`{}`/null) — берётся из кода. Подниша перекрывает нишу (ищется строка подниши, потом ниши). Поверх результата `specializeProfile` для волос (cut/colour/style) меняет `required_visuals, diversity_axes, search_templates.topup, concept_fields, fact_block` — это **только код**, в таблице нет. Расхождения:
- В коде `DEFAULT_NICHE_PROFILES` — 11 профилей, включая `interior`, `decor`, `outdoor` (добавлены 2026-09-21); в таблице их **нет** → интерьерные ниши работают на кодовых дефолтах.
- `nails` в коде имеет 14 атрибутов (добавлен `outfit_mode` — похоже на ошибочный копипаст из одежды), в таблице 13 → таблица «затеняет» код. Код новее таблицы.
- Вывод для переноса: брать **таблицу как данные** для 8 ниш + **дефолты из кода** для interior/decor/outdoor (их надо выгрузить из `nicheProfile.ts` в JSON отдельно); логику `specializeProfile`/`hairTopicKind` переносить кодом. Хранить профили в таблице одним JSON-полем проще, чем 8 колонками.

---

## 5. provider_models и automation_settings

**provider_models** (16, все `kind = text`, все активные): `openrouter` (12): `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-pro-0813`, `deepseek/deepseek-v4-flash` (дважды: глобальная и пользовательская «эконом»), `deepseek/deepseek-v4.1-flash`, `anthropic/claude-haiku-4.5`, `anthropic/claude-haiku-4.5:batch`, `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite` («видит фото, дёшево»), `google/gemini-3.1-flash-lite`, `z-ai/glm-4.7-flash`, `moonshotai/kimi-k2.5`; `laozhang` (4): `gemini-2.5-flash-thinking`, `gemini-2.5-flash-lite`, `deepseek-v4-flash` (резерв), `deepseek-v4-pro` (резерв). 10 строк глобальные (`user_id NULL`), 6 — пользователя. Это просто справочник для выпадающего списка «модель шага» в сценарии; в zewex.tools аналог — модели провайдера в `seed.mjs`. Моделей, которыми реально пользуются сценарии: `google/gemini-2.5-flash-lite`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro-0813`.

**automation_settings** (singleton): `cron_enabled true, every_minutes 1, auto_disable_when_idle true, idle_ticks 0, lanes 4, max_parallel_stages 3, max_concurrent_per_site 20, max_pregate_per_site 20, max_concurrent_sites 16, max_concurrent 80, max_writing_per_site 20, auto_enable_on_queue false, ai_mod_auto_enabled false, ai_mod_auto_batch 20` (последние два — DEPRECATED, перенесены в `sites`). Это параметры оркестратора очереди (`queue-orchestrator`), не промты; в нашем воркере им соответствуют константы лимитов — переносить как настройки воркера, не как seed промтов.

---

## 6. Данные generated_photo

| Таблица | Строк | Объём | Структура |
|---|---|---|---|
| `image_prompts` | 41 | 770 КБ SQL; `prompt_text` 574 КБ (1,5–22,8 КБ каждый); `style_dna` 22 КБ (у 30) | `id, user_id, name, description, prompt_text, is_default, position, color, reference_images jsonb [{url, filename}], prompt_group ('default' у всех), set_id (привязка к AI-набору), usage (universal 26, manicure 4, форматы кадров одежды 8, null 3), send_references (false у всех), style_dna, style_dna_mode, style_dna_updated_at` |
| `image_prompt_groups` | 5 | 2,5 КБ | по одной группе на AI-набор: «Маникюр 1» (7d90…, 9 промтов), «Маникюр 1» (копия 6a6b…), «All» (волосы, 12), «Одежда — форматы кадров» (8), «Интерьер — форматы кадров» (3); `usage`, `position`, `set_id` |
| `image_prompt_group_items` | 41 | 10 КБ | `group_id, prompt_id, percentage (сумма 100 в каждой группе), position` |
| `photo_reference_set` | 214 | 176 КБ | `owner_id, niche_code (outfits 64, nails/interior/hair по 50), image_url, thumb_url, source_photo_id, source_project_id, source_title, ai_score, fingerprint, status (candidate 140 / selected 74)`; 213 URL → старый Supabase Storage `generated-images/…`, 1 → cdn.shopify.com |

Особенности: 30 визуальных промтов ссылаются на **255 референс-картинок** в бакете `prompt-references` старого Supabase — их надо **выкачать до отключения проекта** (иначе style_dna/референсы потеряют смысл). В промтах ногтей есть дубли по имени (NAIL CAR SELFIE ×3 и т.п. — оригинал + копия набора + вариант). Длина 15–23 КБ на промт картинки — это текущий «стиль» генерации под `gpt-image-2`.

**Рекомендация**: `image_prompts/groups/items` (кроме группы-копии `acd7f961` и её 9 промтов из набора 6a6b…) — переносить **во второй очереди**, вместе с конвейером generated_photo, в отдельный JSON (~0,5 МБ) + архив референсов; сейчас достаточно выгрузить. `photo_reference_set` — **отложить/не переносить**: это эталоны качества для AI-модерации (grid pass A), ссылки умрут вместе со Storage, набор легко собрать заново из своих статей.

---

## 7. План seed для Prisma (zewex.tools)

Принцип: сохранять **старые UUID как первичные ключи** — на них ссылаются `stage_prompt_ids`, `stage5_group_id`, `stage5_prompt_id`; так переносим 1:1 и остаёмся идемпотентными (`upsert where id`).

```prisma
enum ArticleFormat { GENERATED_PHOTO REAL_PHOTO }

model ArtNiche {            // niches
  code       String  @id          // nails, manicure…
  name       String
  emoji      String  @default("📄")
  sortOrder  Int     @default(0)
  isActive   Boolean @default(true)
  parentCode String?
  profile    ArtNicheProfile?
}

model ArtNicheProfile {     // niche_profiles — один JSON вместо 8 jsonb-колонок
  nicheCode String @id
  label     String
  profile   Json          // {attributes, required_visuals, exclusive_terms, diversity_axes, search_templates, constraint_specs, concept_fields, fact_block}
  isActive  Boolean @default(true)
  niche     ArtNiche @relation(fields:[nicheCode], references:[code])
}

model ArtPromptSet {        // prompt_sets
  id           String  @id @db.Char(36)
  name         String
  description  String? @db.Text
  nicheCode    String
  subnicheCode String?
  format       ArticleFormat
  isActive     Boolean @default(false)
  prompts      ArtPrompt[]
  @@index([nicheCode, subnicheCode, format, isActive])
}

model ArtPrompt {           // prompts (только живые колонки)
  id        String  @id @db.Char(36)
  setId     String  @db.Char(36)
  stageKey  String                     // stage_2, rp_photo_plan…
  name      String
  system    String? @db.LongText       // system_part
  text      String  @db.LongText       // content (до 35 КБ → LongText/MediumText)
  model     String?                    // справочно; реальная модель — в сценарии
  isActive  Boolean @default(true)
  createdAt DateTime @default(now())   // порядок выбора варианта, как в оригинале
  set       ArtPromptSet @relation(fields:[setId], references:[id], onDelete: Cascade)
  versions  ArtPromptVersion[]
  @@index([setId, stageKey, createdAt])
}

model ArtPromptVersion {    // prompt_versions — в источнике пусто, заводим для истории правок в UI
  id            String   @id @default(uuid())
  promptId      String   @db.Char(36)
  version       Int
  system        String?  @db.LongText
  text          String   @db.LongText
  changeSummary String?
  createdById   String?
  createdAt     DateTime @default(now())
  prompt        ArtPrompt @relation(fields:[promptId], references:[id], onDelete: Cascade)
  @@unique([promptId, version])
}

model ArtScenario {         // scenarios — только живые поля, остальное в JSON-группах
  id             String  @id @db.Char(36)
  number         Int?
  name           String
  description    String? @db.Text
  nicheCode      String
  subnicheCode   String?
  format         ArticleFormat
  promptSetId    String? @db.Char(36)
  isActive       Boolean @default(true)
  executionMode  String  @default("scenario")   // scenario | auto
  stagePromptIds Json    // {stage_key: prompt_id}
  stageModels    Json    // {stage_key: "provider:model"}
  textSettings   Json    // {batchSize, personality, wordCount:"compact3"}
  imageSettings  Json    // {provider:"openai_image", model:"gpt-image-2", quality, size, mode:"group", groupId, promptId}
  photoSearch    Json    // нормализованный photo_search_config
  publish        Json    // {mode:"publish_then_edit", seoYearUrlPercent:100}
}

model ArtProviderModel {    // provider_models (если не сольём с существующими моделями провайдеров)
  id String @id @db.Char(36); service String; modelId String; label String?; kind String @default("text"); isActive Boolean @default(true); position Int @default(0)
  @@unique([service, modelId])
}
```
Для generated_photo (вторая очередь): `ArtImagePrompt { id, setId, name, description, text LongText, usage, position, color, referenceImages Json, styleDna LongText?, styleDnaMode }`, `ArtImagePromptGroup { id, setId, name, usage, position }`, `ArtImagePromptGroupItem { groupId, promptId, percentage, position }`.

**Как класть данные:**
- `prisma/seed-data/articles/prompts.json` (из `prompts.export.json` + 6 промтов набора «Волосы AI фото»; ≈ 0,38 МБ) и `prisma/seed-data/articles/config.json` (ниши, профили — 8 из таблицы + interior/decor/outdoor из кода, сценарии в очищенном виде, provider_models; ≈ 0,1 МБ). Хранить рядом с seed, не внутри `seed.mjs` — файлы большие и будут редактироваться.
- В `prisma/seed.mjs` — функция `seedArticles()`: читает оба JSON, `upsert` по `id`/`code` (как остальные части seed — идемпотентно), порядок: niches → niche_profiles → prompt_sets → prompts → provider_models → scenarios. `user_id` отбрасываем (владелец в нашей модели — сервис/команда через `SiteAccess`, см. CLAUDE.md).
- Не переносить: два набора-копии (13 промтов), `prompt_versions` (пусто), `automation_settings` (это лимиты воркера → константы/ENV), `photo_reference_set`.
- Доработать экспорт-скрипт: добавить флаг «включая неактивные наборы без суффикса (копия)» и выгрузку `DEFAULT_NICHE_PROFILES` для interior/decor/outdoor (сейчас только таблица).
- При переносе исправить в данных: `{{section_brief}}` → `{{section_briefs}}` (одежда-real writer_user); в сценариях `min_width/min_height 450` → 550 (как реально работает); убрать ключи `stage_2` из `stage_models` real-сценариев и `stage_5_1` (переименовать в понятный `image_prompt_writer`).

Размеры: SQL промтов 450 КБ → JSON 339 КБ (49) / ≈380 КБ (55); конфиг 108 КБ; визуальные промты ≈0,6 МБ JSON + 255 референс-файлов (объём неизвестен, выкачать).

---

## 8. Качество промтов (критично)

**Дубли между наборами** (SequenceMatcher по system+text, активные наборы):
- Ногти-real ↔ Волосы-real — одна семья с подстановкой ниши: `rp_photo_plan 0.84`, `rp_section_plan 0.82`, `rp_photo_search 0.80`, `rp_photo_rate 0.77`, `stage_6 0.92`, `writer_system 0.83`, `writer_user 0.93`, `intro_outro 0.87`.
- Ногти-AI ↔ Ногти-real: `writer_user 0.95`, `writer_system 0.93`, `intro_outro 0.92` — текстовая часть фактически одна на оба формата.
- Одежда-real ↔ Интерьер-real — вторая, короткая семья: `rp_photo_plan 0.77`, `rp_section_plan 0.78`, `rp_photo_search 0.77`, `stage_6 0.88`, `intro_outro 0.81`, `writer_user 0.74`.
- `stage_2` AI между нишами: 0.30–0.56 — здесь нишевой специфики много, общий только скелет (разделы trend_context / meta / DESIGNS / KEYWORDS / section_plan / ARTICLE-LEVEL PLANS / WRITING STANDARD / OUTPUT).
- Наборы-копии: 13 промтов на 100% равны оригиналам.
Итого ≈ 45–50 % всего текста — повторы с заменой слов ниши.

**Устаревшее / мёртвое**:
1. `faq_plan`, `comparison_table_plan` в `stage_2` трёх AI-наборов (до 7,8 КБ текста в ногтях) — не читаются ни одной функцией; `schema_enabled` — тоже. FAQ и таблицы при этом запрещены во всех writer-промтах («No FAQ, tables…»): промт планирует то, что сам же запрещает.
2. `keywords_table` в `stage_2` всегда «(нет данных по ключам)» — раздел KEYWORDS работает вхолостую (DataForSEO-обогащение вынесено и отключено).
3. `prompts.model` (`google/gemini-3-flash-preview` у 60 из 68, `gemini-2.5-flash-lite` у 8) **не влияет** ни на один шаг, кроме `rp_photo_search` без модели в сценарии; фактические модели — из `stage_models` (`gemini-2.5-flash-lite`, `deepseek-v4-flash`). Колонка вводит в заблуждение.
4. `stage_5_scene_planner` в тексте привязан к «OpenAI GPT Image model» и жёсткому «Vertical 2:3»; поля `nanobanana_*` в сценариях — от удалённого провайдера.
5. Внутренняя история в промтах: «replaces the old trend research step», «(replaces the old keyword mapping step)» — объяснения для прошлого рефакторинга, модель читает их на каждом вызове.
6. «Волосы AI фото» неактивен, но используется сценарием №4 — работает только за счёт прямой ссылки.

**Противоречия промт ↔ код**:
- `rp_photo_rate`: промт задаёт свой формат («Score 1-10, reason in Russian, Return ONLY JSON»), код дописывает другой, 20-полевой `JSON_CONTRACT` + чек-лист темы; критерий «simply unattractive» в промте vs отдельные шкалы virality/composition/lighting/framing в коде. Промт — лишь «вкус», контракт — код; при переносе либо перенести контракт в промт, либо сократить промт до критериев отбора.
- `rp_photo_search`: промт просит `{"queries":[3]}`, код требует `primary/secondary` по 3 + `moderator_translation_ru` и явно оговаривает несовместимость.
- `stage_7_writer_user` одежды-real: `{{section_brief}}` — брифы не доходят (см. §2).
- `rp_photo_rate` одежды/интерьера: `{fashion_contract}`/`{interior_contract}` не подставляются.
- Intro: код **всегда** дописывает обязательный блок «INTRO LENGTH 2 абзаца 90–120 слов» — промты одежды/интерьера содержат тот же блок (дубль), промты ногтей/волос могут описывать другую длину (переопределяется молча).
- `{{COUNT}}`: токен используют только интерьер (оба) и одежда-real; остальные полагаются на `countTokenPromptBlock()`, который код дописывает всем. Непоследовательно, но работает.
- `stage_2` ногтей просит `keywords_to_bold`, writer-промты запрещают bold, а `assemble-html` всё равно делает `stripEmphasis` — цепочка противоречит себе.
- `photo_search_config.min_width/min_height = 450` в сценариях vs кламп 550 в коде; `language` для поисковых запросов «English» vs «en» в остальных шагах.
- UI-реестр переменных (`promptRegistry.ts`) обещает редактору ~40 переменных (`keyword_*`, `blueprint`, `sections_summary`, `item_name` в writer…), которые код не подставляет — редактор может вставить их и получит «{{…}}» в тексте.

**Слишком длинные** (system+user, символы): интерьер `stage_2` 46,7 КБ (~11–12 тыс. токенов), одежда `stage_2` 36,1 КБ, ногти `stage_2` 24,2 КБ, интерьер `writer_system` 15,2 КБ, волосы `rp_photo_plan` 14,8 КБ, ногти `rp_photo_plan` 13,5 КБ, одежда `writer_system` 11,7 КБ, волосы/ногти `writer_system` 9,5–10,4 КБ. `writer_system` уходит **с каждым батчем** секций (4–5 секций → 3–6 раз на статью) плюс в intro и outro — на статью из 25 идей это 70–120 КБ одних системных инструкций.

**Что вынести в шаблон** (предложение для нашей модели):
- Один базовый шаблон на каждый stage_key (две семьи для real: «длинная» ногти/волосы и «короткая» одежда/интерьер лучше свести к одной) + нишевой блок из профиля ниши: `niche_label`, `subject_label`, `required_facts`, `topic_facts`, `concept_fields`, `fact_block.note`, персона (Maya/Nora/Hannah), список запрещённых тем. Код уже подставляет эти переменные — промты просто их не используют.
- Общие для всех ниш части: «WRITING STANDARD», формат JSON-ответа, правила «no brands/prices/medical claims», блок про `{{COUNT}}`, INTRO LENGTH, запрет FAQ/таблиц/эмфазы — вынести в код (как уже сделано для COUNT и INTRO LENGTH) или в один общий «постоянный блок», а не копировать в 7 наборов.
- Из `stage_2` убрать разделы faq/comparison_table/keywords (−10–15 % длины) и историю рефакторинга.
- Хранить в промте только то, что меняет поведение модели; контракт ответа — один источник (код или промт), не оба.
