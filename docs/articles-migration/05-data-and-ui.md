# 05. Модель данных и пользовательский интерфейс «Zewex Pinterest Articles»

Аудит исходников React 18 + Vite + Supabase (`db/schema.sql` 4990 строк, 47 таблиц; `src/pages` 30 страниц; `src/lib/*Registry.ts`; `supabase/functions/*`) для переноса в zewex.tools (Next.js 15, Prisma, MariaDB). Источники читались только для анализа, код не менялся.

Условные обозначения: **ключевая** — таблица обязательна в новой схеме; **legacy** — формат `generated_photo` (одежда/outfits), можно переносить позже или не переносить; **служебная** — заменяется механизмами воркера zewex.tools.

---

## 1. Модель данных

### 1.1 Все 47 таблиц одной строкой

| № | Таблица | Назначение | Класс |
|---|---|---|---|
| 1 | `sites` | WordPress-сайт: доступы, порядок, категории, лимиты и флаги автозапуска по этапам, настройки ИИ-модерации, ссылка на Google Таблицу | ключевая |
| 2 | `article_queue` | Очередь статей (одна строка = одна тема/ключ): статус, этап, сценарий, курсор пайплайна, блокировки, параметры запуска, кто модерировал фото | ключевая |
| 3 | `projects` | Рабочий «проект статьи» (создаётся из строки очереди): снимок настроек сценария + 200 колонок наследия | ключевая (сильно сократить) |
| 4 | `article_drafts` | Черновик статьи: план, HTML, мета (H1/title/description/slug), статус ревью, флаги модерации, состояние публикации (очередь, попытки, ошибки) | ключевая |
| 5 | `article_sections` | Секции статьи (intro / outfit / outro / care_block): план секции, H2, HTML, объём, стоимость | ключевая |
| 6 | `articles` | Старая таблица готовой статьи (gdoc, content_json, wp_post_id) — дублирует `article_drafts` | legacy |
| 7 | `article_photos` | Фото, вошедшие в статью (real_photo): позиция, источник, размеры, оценка ИИ, факты, WP media | ключевая |
| 8 | `photo_candidates` | Все найденные кандидаты фото: техфильтр, ИИ-оценка, описание, факты, pHash, резкость, «виральность» | ключевая |
| 9 | `photo_usage_fingerprints` | Отпечатки использованных фото между сайтами (уникальность, TTL 30 дней) | ключевая |
| 10 | `photo_moderation_events` | События модераторов фото (approve/skip/remove/add/heartbeat/open) — источник статистики сотрудников | ключевая |
| 11 | `photo_reference_set` | Эталонные фото по нишам (candidate/selected) — планка качества для ИИ-оценки | ключевая |
| 12 | `ai_moderation_runs` | Запуск ИИ-модерации фото по сайту: режим, лимит, прогресс, стоимость, heartbeat | ключевая |
| 13 | `ai_moderation_results` | Решение ИИ по статье: вердикт, уверенность, удалено/добавлено/порядок, обзор, статус применения | ключевая |
| 14 | `niches` | Справочник ниш и подниш (`parent_code`) | ключевая |
| 15 | `niche_profiles` | Профиль ниши: атрибуты, обязательные визуалы, исключающие термины, оси разнообразия, шаблоны поиска, факт-блок | ключевая |
| 16 | `prompt_sets` | Набор промтов на связку ниша+подниша+формат; ровно один активный | ключевая |
| 17 | `prompts` | Текстовые промты набора по `stage_key` (несколько вариантов на шаг), system-часть | ключевая |
| 18 | `prompt_versions` | История версий промта — таблица есть, UI/функции в неё не пишут | ключевая (не используется) |
| 19 | `prompt_groups` | Старые группы промтов с стратегией выбора (sequential) | legacy |
| 20 | `image_prompts` | Визуальные промты генерации изображений (+референсы, Style DNA, назначение manicure/pedicure) | legacy (generated_photo) |
| 21 | `image_prompt_groups` | Группы визуальных промтов с процентами | legacy |
| 22 | `image_prompt_group_items` | Слоты группы: промт + процент + позиция | legacy |
| 23 | `scenarios` | Сценарий запуска: ниша, формат, набор промтов, модели по шагам, фильтры поиска фото, объём текста, публикация | ключевая |
| 24 | `workflow_stages` | Состояние шагов проекта (stage_number, status, input/output/error JSON, awaiting_confirmation) | ключевая (упростить) |
| 25 | `pipeline_errors` | Журнал ошибок с нормализованной сигнатурой; заполняется триггерами | ключевая |
| 26 | `generations_log` | Лог каждого ИИ/API-вызова: токены, стоимость, модель, латентность, повтор/впустую | ключевая |
| 27 | `article_cost_report` | Агрегат стоимости по статье (итоги + stage_breakdown) — код не пишет | служебная (не используется) |
| 28 | `provider_billing_status` | Блокировка провайдера по балансу до `blocked_until` | служебная |
| 29 | `provider_models` | Пользовательский справочник моделей OpenRouter/LaoZhang (text/image) | ключевая |
| 30 | `integrations` | Ключи API провайдеров (несколько на сервис, приоритет, баланс, проверка) + прокси в `config` | ключевая (→ существующие ключи zewex.tools) |
| 31 | `automation_settings` | Singleton: cron вкл/выкл, интервал, лимиты параллелизма оркестратора | служебная |
| 32 | `orchestrator_lock` | Блокировки оркестратора (singleton + lanes) | служебная (→ lease воркера) |
| 33 | `service_leases` | Слоты конкурентности внешних сервисов (service, holder, expires_at) | служебная |
| 34 | `cleanup_tokens` | Токены подтверждения очистки | служебная |
| 35 | `team_members` | Сотрудники владельца: email, страницы, разрешённые сайты, активность | ключевая (→ Team/SiteAccess zewex.tools) |
| 36 | `telegram_bots` | Боты уведомлений (token, chat_id, флаги) | ключевая |
| 37 | `telegram_bot_sites` | Привязка бот ↔ сайт | ключевая |
| 38 | `agent_teams` | Команды «агентов» (экспериментальный редактор, маршрута нет) | legacy |
| 39 | `agents` | Агенты команды: модель, температура, input_mapping, output_schema | legacy |
| 40 | `benchmark_sessions` | Сессии бенчмарка стоимости | legacy |
| 41 | `benchmark_cost_entries` | Записи баланса до/после по провайдеру (spent — generated column) | legacy |
| 42 | `outfits` | Образы/дизайны формата generated_photo: статусы шагов 3/4/5, позиция, SEO-ключ, исключение | legacy |
| 43 | `outfit_items` | Предметы образа | legacy |
| 44 | `outfit_styling_mistakes` | «Ошибки стилизации» образа | legacy |
| 45 | `generated_images` | Сгенерированные изображения образов: ревью, WP, SEO, факты | legacy |
| 46 | `alternative_images` | Альтернативные изображения (swap предметов) | legacy |
| 47 | `mistake_images` | Изображения «ошибок стилизации» | legacy |

Legacy-блок `generated_photo` (можно перенести позже или только в режиме чтения): `outfits`, `outfit_items`, `outfit_styling_mistakes`, `generated_images`, `alternative_images`, `mistake_images`, `image_prompts`, `image_prompt_groups`, `image_prompt_group_items`, `prompt_groups`, `agent_teams`, `agents`, `articles`, `benchmark_*`. Важно: текущая модерация статей (`/moderation`, `/review/:id`) строит плитки **по `outfits`**, а не по `article_photos`, поэтому для формата real_photo пайплайн создаёт псевдо-outfit на каждое фото (`article_sections.outfit_id`, `article_photos.outfit_id`). При переносе от этой привязки нужно уйти: секция ↔ фото напрямую.

### 1.2 Перечисления статусов (собраны по коду)

- `article_queue.status`: `pending`, `running`, `photo_review` (режим 2, ждёт модератора фото), `insufficient_photos` («мало фото»), `waiting_for_photos` (после оценки не хватило, нужен добор), `paused` (пауза оркестратором: баланс/лимит), `stalled` (остановлен человеком), `failed`, `review_pending` (ждёт модерации статьи), `reviewed` (одобрена, не опубликована), `needs_rework`, `repair_pending`/`repairing` (ремонт картинок, legacy), `publish_queued`, `publishing`, `publish_error`, `completed`, `cancelled`. Dashboard считает `done`/`error`, которых нет — счётчики «Готово/Ошибки» на дашборде всегда 0.
- `article_drafts.review_status`: `pending`, `reviewing`, `approved`, `published`, `needs_rework`, `rejected`, `broken`, `needs_regeneration`, `review_failed`. SiteQueuePage ищет `repair_pending`/`repairing` — таких значений в драфтах нет.
- `article_drafts.publish_state`: `null`, `queued`, `retry`, `publishing`, `published`, `error`; `publish_error_kind`: `transient`, `permanent`, `site_media_down`.
- `article_queue.execution_mode`: `direct` (по умолчанию, серверный direct-pipeline), `scenario`, `batch`, `manual`; `pipeline_mode`: `1` (модерация статьи после написания) / `2` (сначала модерация фото, потом текст и публикация).
- `publish_mode` (очередь/проект/сценарий): `auto`, `moderate_first`, `publish_then_edit`.
- `article_format`: `generated_photo`, `real_photo`.
- `ai_moderation_results.decision`: `approve`, `insufficient`, `human`, `error`, `skipped`; `.status`: `proposed`, `processing`, `applying`, `applied`, `sent_to_human`, `excluded`, `failed`. `ai_moderation_runs.mode`: `test`, `auto`, `compare`; `.status`: `running`, `done`, `stopped`.
- `photo_candidates.tech_status`: `pending`, `ok`, `rejected`; `ai_status`: `pending`, `done`…; `ai_verdict`: `keep` / иначе.
- `workflow_stages.status`: `pending`, `running`, `completed`, `failed`, `skipped`.
- `article_sections.section_type`: `intro`, `outfit`, `outro`, `care_block`; `.status`: `pending`, `planned`, `written`, `assembled`.

### 1.3 Ключевые таблицы — колонки

Типы даны по PostgreSQL; для MariaDB: `uuid` → `CHAR(36)`, `jsonb` → `JSON`, `timestamptz` → `DATETIME(3)` в UTC, `numeric` → `DECIMAL`, `uuid[]` → таблица-связка, `text` → `TEXT`/`VARCHAR`.

#### `sites`
| Колонка | Тип | Смысл |
|---|---|---|
| id | uuid PK | |
| name, site_url, description | varchar/text | Имя, адрес, описание |
| user_id | uuid | Владелец |
| position | int | Порядок обхода оркестратором (SiteQueuePage) |
| wp_rest_url, wp_username, wp_app_password | text | Доступы WordPress REST (пароль хранится открыто) |
| wp_categories | jsonb | Кэш категорий WP: `[{id, name, slug}]` |
| wp_categories_synced_at | timestamptz | Когда синхронизировали |
| category_rules | jsonb | Правила «слово в ключе → категория»: `[{keywords: "nail, manicure", category_id}]` |
| default_category_id | int | Категория по умолчанию |
| category_ai_enabled | bool | Подбирать категорию ИИ, если правила не сработали |
| default_outfits_count | int | Кол-во идей/фото по умолчанию (автосохраняется из формы очереди) |
| default_scenario_id | uuid | Сценарий по умолчанию (автосохраняется из формы очереди) |
| sheet_url | text | Google Таблица; вкладка = домен сайта |
| ai_mod_auto_enabled, ai_mod_auto_batch, ai_mod_concurrency, ai_mod_max_publish_backlog | bool/int | Авто ИИ-модерация фото: включена, запуск от N статей, параллелизм, ждать если в публикации ≥ N (0 — не ждать) |
| auto_photo_enabled, auto_photo_off_reason, photo_idle_since | bool/text/ts | Этап «поиск фото»: включён, причина выключения (`manual`/`idle`), с какого момента простой |
| auto_writing_enabled, auto_writing_off_reason, writing_idle_since | bool/text/ts | То же для этапа «написание и публикация» |
| auto_restart_on_queue | bool | Включать этап снова при новых статьях (триггер `auto_enable_site_phase`) |
| max_photo_concurrent, max_writing_concurrent, max_publish_concurrent | int | Лимиты параллельных статей на сайт по этапам (по умолчанию 20/20/1) |
| created_at, updated_at | timestamptz | |

#### `article_queue`
| Колонка | Тип | Смысл |
|---|---|---|
| id | uuid PK | |
| site_id | uuid FK sites (cascade) | Сайт |
| user_id | uuid | Кто добавил |
| keyword, seo_keyword, focus_keyword | text | Тема (ключ), SEO-ключ, фокус-ключ (если пусто — = keyword) |
| keyword_ru | text | Перевод ключа для модераторов (UI-only) |
| scenario_id | uuid FK scenarios (set null) | Сценарий |
| niche_code, subniche_code, article_format, prompt_set_id, article_type | text/uuid | Снимок из сценария на момент добавления (`article_type` — legacy `nails`/`hair`/`outfits`) |
| status | text | См. 1.2 |
| current_stage | int | Номер шага (2,5,6,65,73,72,76,78 / 11–16) |
| project_id | uuid FK projects (set null) | Созданный проект |
| wp_url | text | Ссылка на публикацию |
| error_message | text | Последняя ошибка/служебная заметка (триггер отсеивает заметки по regex) |
| total_cost | numeric | Стоимость статьи |
| position | int | Порядок в очереди сайта |
| count_outfits | int | Кол-во идей/фото в статье (случайное из диапазона при массовой загрузке) |
| pipeline_cursor | jsonb | Курсор direct-pipeline, см. ниже |
| lock_id, locked_at | text/ts | Блокировка строки оркестратором (`claim_queue_item_lock`) |
| execution_mode | text | `direct` и т.д. |
| direct_gate_passed | bool | Прошла ли «гейт» (после Stage 5) — разрешает второй параллельный запуск |
| consecutive_errors | int | Подряд ошибок (для паузы) |
| publish_mode | text | `auto` / `moderate_first` / `publish_then_edit` |
| wp_category_id, wp_category_name | int/text | Категория публикации (решена `resolve-wp-category` или вручную) |
| sheet_row, sheet_tab, sheet_sync_state, sheet_sync_error | int/text | Привязка к строке Google Таблицы и состояние обратной записи |
| year_in_url | int | Переопределение «год в URL» (0–100) из таблицы |
| photo_geo, photo_language, photo_freshness | text | Переопределения поиска фото для этой статьи (пусто = из сценария) |
| pipeline_mode | smallint | 1 / 2 |
| photo_review_claimed_by, photo_review_claimed_at | uuid/ts | Кто и когда закрепил статью в модерации фото (TTL 15 мин) |
| photo_reviewed_by, photo_reviewed_at | uuid/ts | Кто одобрил фото |
| insufficient_reason, insufficient_by, insufficient_by_ai, insufficient_at | text/uuid/bool/ts | «Мало фото»: причина, кто, ИИ ли, когда |
| test_tag | text | Метка тестовой статьи |
| created_at, started_at, completed_at | timestamptz | |

Ключи `pipeline_cursor` (45 штук, смесь snake/camelCase, схемы нет): общие — `phase`, `processed`, `failed`, `batch_index`, `retry_batch_index`, `in_retry_phase`, `retry_attempt`, `accumulated_missing`, `next_run_after`, `_attempts` (сбрасывается при повторе), `attemptCounts`, `task_ids`, `poll_index`, `poll_count`; режим 2 — `photo_review_approved` (= статья в фазе написания), `rp_resume_filter`, `photo_topup_after_rating`, `photo_filter_cycles`, `photo_select_cycles`, `photo_more_cycles`; пропуски шагов — `skip_5`, `skip_6`, `skip_72`; подкурсоры — `stage5_cursor`, `stage6_cursor`, `stage73_cursor`, `stage73_last_chance`, `s2_resume_attempts`, `_stage72_recovery`, `stage5_recovery_done`, `stage5_gate_wait_started_at`, `ordering_attempts`; генерация картинок (legacy) — `scene_planned`, `promptMap`, `promptMapReady`, `nanoBananaMode`, `useNanoBanana`, `customAltPrompt`, `allImages`, `altDone`, `pending_poyo_wait_started_at`, `_stage5_pending_poyo_rescues`; служебное — `_review_redirects`. В новой схеме: типизированный объект `ArticleJobCursor` (как `PinJob`), legacy-ключи не переносить.

#### `projects`
≈200 колонок; реально используемые в текущих форматах:

| Группа | Колонки | Смысл |
|---|---|---|
| Базовые | id, user_id, site_id (FK cascade), name, topic, focus_keyword, seo_keyword, status (`draft`/`in_progress`/`running`/`stalled`/`completed`), current_stage, total_cost, budget_limit (2.00), language (`en`), target_country (`USA`), count_outfits, images_per_article (28), execution_mode, publish_mode, api_mode, created_at, updated_at | Ядро проекта |
| Новая модель | niche_code, subniche_code, article_format, prompt_set_id (FK), stage_prompt_ids (jsonb `{stage_key: prompt_id}`), stage_models (jsonb `{stage_key: "provider:model"}`), photo_search_config (jsonb, копия из сценария), keyword_attributes (jsonb — результат `parse-keyword-ai`: замки темы по нише), seo_year_url_percent, stage7_target_word_count, stage7_article_personality, stage7_batch_size, stage7_output_settings (jsonb `{stage7_4_enabled}`), schema_enabled, stage16_provider/stage16_model, stage2_provider, stage51_provider/stage51_model, stage6_provider, stage77_provider, stage5_api_provider, stage5_image_model/quality/size, stage5_mode, stage5_prompt_id, stage5_group_id, nanobanana_aspect_ratio(s), nanobanana_resolution, nanobanana_reference_images, disclaimer_text/font_size/color | Снимок сценария на момент запуска |
| Legacy (не переносить) | keyword_hero_item, keyword_color_lock, keyword_length_lock, keyword_technique, keyword_texture, keyword_cut_shape, keyword_face_shape, keyword_style_lock, keyword_age, keyword_skin_tone, keyword_setting, keyword_season, keyword_neckline, keyword_body_shape, keyword_eye_color, keyword_hero_item_2, keyword_nail_* (5), keyword_finish, keyword_aesthetic, keyword_occasion, keyword_surface, cut_family, custom_cut_spec, length_strategy, family_strategy, article_theme, article_type; ~45 колонок `stage*_prompt_id`/`*_group_id` по нишам (hairstyle, haircolor, nails, compact, compact3…); stage4/36/55/71_provider, stage3_priority_mode, stage35/55/64_enabled, stage55_* (mistakes/alternatives), ai_provider, prompt_group_id, agent_team_id, wp_site_url, wp_credentials_id, gdocs_folder_id | Поколения экспериментов; заменены `keyword_attributes` + `stage_prompt_ids` |

Вывод: в новой схеме `Article` (= project) достаточно ~25 колонок + `settings JSON` (снимок сценария) + `keywordAttributes JSON`.

#### `article_drafts` (1:1 с проектом, UNIQUE project_id)
| Колонка | Тип | Смысл |
|---|---|---|
| project_id | uuid FK cascade, UNIQUE | |
| article_plan | jsonb | План статьи: `section_plans[]`, `section_recipes[]`, `intro_plan`, `outro_plan`, порядок фото |
| article_personality, narrative_arc | text | Характер подачи, арка |
| topic_keywords | jsonb | Ключи темы; UI читает `keyword_ru` / `primary_ru` / `primary[0].ru` |
| full_html | text | Собранный HTML |
| table_of_contents, schema_markup | jsonb | Оглавление, Schema.org |
| total_word_count, total_sections, total_generation_cost | int/int/numeric | Итоги |
| h1_title, seo_title, meta_description, url_slug | text | Мета (редактируется в модерации) |
| wp_post_id, wp_post_url, wp_post_status, published_at | int/text/text/ts | Публикация |
| status, current_step, current_batch, error_data | text/text/int/jsonb | Прогресс написания |
| review_status, review_notes, reviewed_at, reviewed_by, excluded_outfits_count | text/text/ts/uuid/int | Ревью статьи |
| quality_verdict, quality_issues (jsonb `[{message, fixable}]`), quality_checked_at, quality_autofixed (jsonb `[string]`) | | Проверка качества перед публикацией |
| moderation_claimed_by, moderation_claimed_at | uuid/ts | Закрепление за модератором (TTL 10 мин — другой механизм, чем у фото) |
| moderation_flag, moderation_flag_reason, moderation_excluded_photos | text/text/int | Флаг доработки («мало фото», «слабый текст») |
| publish_state, publish_error, publish_error_kind, publish_attempts, publish_next_attempt_at, publish_started_at, publish_lock_id, publish_category_id | | Очередь публикации (publish-worker) |

#### `article_sections`
| Колонка | Тип | Смысл |
|---|---|---|
| project_id FK cascade, outfit_id FK outfits (set null) | | Для real_photo `outfit_id` — псевдо-образ на фото |
| section_number | int, UNIQUE(project_id, section_number) | Позиция |
| section_type | text | intro / outfit / outro / care_block |
| plan_data | jsonb | `{h2_draft, photo_description, photo_facts, recipe, outfit_id}` — бриф и «рецепт» секции (шаг 16) |
| h2_heading, intro_text, styling_advice, dont_block_text, alternative_block_text, transition_text, outro_text | text | Части текста (многое legacy) |
| faq_items | jsonb | FAQ |
| html_content | text | Готовый HTML секции |
| format_used, register_used | text | Какой приём/регистр использован (анти-шаблонность) |
| word_count, batch_number, generation_cost, status | | |

#### `articles` (legacy) — project_id UNIQUE, title, meta_description, focus_keyword, content_json, content_html, gdoc_id/url, wp_post_id/url/status, published_at, count_outfits, images_per_article, care_block jsonb. Дублирует `article_drafts`; переносить не нужно.

#### `article_photos`
| Колонка | Тип | Смысл |
|---|---|---|
| project_id FK cascade | | |
| position, section_number | int | Позиция в статье (renumber через `renumber_article_photos`) |
| image_url (UNIQUE с project_id), thumbnail через candidates | text | Оригинал |
| storage_path, public_url | text | Скачанная копия в хранилище |
| source_page_url, source_domain | text | Источник для подписи |
| caption, alt_text, file_name, description | text | Подпись, alt, имя файла, описание ИИ |
| width, height, fingerprint (UNIQUE с project_id, partial), phash | | Техданные и отпечатки |
| ai_score, ai_reason | numeric/text | Оценка ИИ |
| facts | jsonb | Факты кадра по нише: `palette, standout, zone, style, size_feel, silhouette, shoes, setting, room, occasion, materials, lighting, layout, layers, key_pieces, hero_element, accessories` (набор зависит от ниши) |
| reused | bool | Повтор между сайтами |
| outfit_id | uuid | Псевдо-образ (legacy-мост) |
| wp_media_id, wp_url | bigint/text | Загружено в WP |
| search_query, search_geo, search_language, search_freshness | text | Каким запросом найдено |

#### `photo_candidates`
project_id FK cascade, queue_id, source (`serpapi`/`dataforseo`/`instagram`…), search_query, image_url (UNIQUE с project_id), thumbnail_url, source_page_url, source_domain, title, width, height, fingerprint, phash, sharpness, tech_status/tech_reason/tech_quality (техфильтр), ai_status, ai_score, ai_verdict (`keep`), ai_reason, ai_description, ai_facts (как `facts` выше), ai_quality, ai_quality_breakdown (`{virality, trend, trend_reason, composition, lighting, framing}`), beauty_rank, beauty_note (сортировка резерва), selected, search_geo/language/freshness, created_at. Чистится `cleanup_photo_data` через 3 дня после завершения.

#### `photo_usage_fingerprints` — fingerprint, phash, site_id, project_id, keyword_norm, used_at (TTL 30 дней). Индексы по fingerprint, phash, used_at, project_id.

#### `photo_moderation_events` — user_id, queue_id, site_id, action (`claim`, `approve`, `skip`, `topup`, `remove`, `remove_dated`, `add`, `reorder`, `release`, `mark_insufficient`, `heartbeat` каждые 30 с при активности, `open` каждые 60 с при открытой вкладке), created_at. Вставка heartbeat разрешена RLS только самому пользователю.

#### `photo_reference_set` — owner_id, niche_code, image_url (UNIQUE owner+niche+url), thumb_url, source_photo_id, source_project_id, source_title, ai_score, fingerprint, status CHECK (`candidate`/`selected`).

#### `ai_moderation_runs` — site_id, created_by, mode (`test`/`auto`/`compare`), limit_count, queue_ids uuid[], processed, status, cost_usd, error, heartbeat_at, concurrency, model, source_run_id (для compare), label, created_at, finished_at.

#### `ai_moderation_results` — run_id FK cascade, queue_id, site_id, keyword, decision, confidence, photos_before/after, original_ids uuid[], removed (`[{id, url, why}]`), added (`[{id, url, src: "keep"|"reject", why}]`), final_order (`[{kind: "A"|"R", id, url, src}]`), review (`{human_reasons[], model_verdict, scores{relevance, pinterest, trend, order}, needed, min_ok, model, passes, flagged, overturned[], pass_costs[], v2?, empty?}`), summary, status, cost_usd, error, resolved_by, resolved_at. UNIQUE(run_id, queue_id).

#### `niches` — code PK, name, emoji, sort_order, is_active, parent_code. Текущие: outfits; hair → haircut/hairstyle/hair_color; nails → manicure/pedicure; interior → decor/outdoor; blog.

#### `niche_profiles` — niche_code PK, label, attributes `[]` (какие атрибуты извлекать из ключа), required_visuals `[]`, exclusive_terms `[]`, diversity_axes `[]`, search_templates `{}` (шаблоны запросов картинок), constraint_specs `{}`, concept_fields `[]`, fact_block `{}` (какие факты описывать у фото), is_active. Сидится `seed-niche-profiles`. Нужно переносить как есть (JSON), но завести TS-тип.

#### `prompt_sets` — user_id, name, description, niche_code, subniche_code, article_format, is_active (partial UNIQUE: один активный на user+niche+subniche+format), timestamps.

#### `prompts` — set_id FK cascade, stage_key (ключ из `promptRegistry`), name (название варианта), content (user-часть), system_part (постоянный блок, кэшируется провайдером), model (legacy), prompt_type (= stage_key), version (всегда 1), is_active, group_id/prompt_group/niche_code (legacy), user_id. Индекс (set_id, stage_key).

#### `prompt_versions` — prompt_id, version, content, change_summary, created_by. Код не пишет; история промтов фактически отсутствует.

#### `image_prompts` / `image_prompt_groups` / `image_prompt_group_items` (нужны только для generated_photo) — промт: name, description, prompt_text, usage (`universal`/`manicure`/`pedicure`), color, reference_images `[{url, …}]`, send_references, style_dna, style_dna_mode, is_default, set_id; группа: name, description, usage, set_id; слот: group_id, prompt_id, percentage, position.

#### `scenarios` (вкладки см. раздел 4)
| Вкладка | Колонки |
|---|---|
| Основное | id, user_id, scenario_number (авто через триггер, UNIQUE — номер для Google Таблицы), name, description, article_format (не меняется), niche_code, subniche_code, prompt_set_id (`null` = активный набор ниши), execution_mode, publish_mode, seo_year_url_percent (0–100), is_active, is_default (partial UNIQUE на user+niche+subniche+format) |
| Промты и модели | stage_prompt_ids `{stage_key: prompt_id}`, stage_models `{stage_key: "provider" \| "provider:model"}` |
| Пайплайн | stage7_target_word_count (`compact3`/`compact2`/`compact`/`full`), stage7_article_personality, stage7_batch_size (1–10), schema_enabled; legacy: stage64_enabled, stage55_enabled, stage55_review_enabled, stage35_enabled, stage7_4_enabled |
| Изображения (generated_photo) | stage5_mode (`single`/`group`), stage5_prompt_id, stage5_group_id, stage5_prompt_mode, stage5_prompt_template_id, stage5_api_provider (`openai_image`/`poyo`/`laozhang`/`nanobananaapi`), stage5_image_model/quality/size, nanobanana_aspect_ratio, nanobanana_aspect_ratios, nanobanana_resolution, nanobanana_reference_images; legacy: stage55_mistakes_*, stage55_alternatives_*, disclaimer_* |
| Поиск фото (real_photo) | photo_search_config jsonb (`PhotoSearchConfig`: source, candidates_total, orientation[], min_width, min_height, min_score, license, image_type, freshness, country, language, include_domains[], exclude_domains[], query_suffix, caption_mode, caption_template, unique_mode, rating_model, rating_batch_size, writer_mode) |
| Провайдеры | stage2_provider, stage51_provider/stage51_model, stage5_api_provider, stage6_provider, stage16_provider/stage16_model; legacy: stage1/4/36/55/71/77_provider, parse_keyword_provider, ai_provider, stage3_priority_mode |
| Мёртвые | pipeline_config `{}`, publish_config `{}` — ни одна функция и ни одна страница их не читает |

#### `generations_log` — project_id (FK set null), agent_id, api_service (`openrouter`, `laozhang`, `poyo`, `openai`, `dataforseo`, `serpapi`…), api_endpoint, request_summary, model_used, stage (номер шага), tokens_in/out/thinking, tokens_cached_input, tokens_input_text/image, cost_input/output/thinking, cost_usd, status (`success`/`error`), error_message, duration_ms, latency_ms, images_count, is_retry, is_wasted, waste_reason, metadata (`{fallback_path, fallback_used, attempts, purpose}` для ИИ; `{query, fetched, purpose}` для поиска фото), created_at. Аналог `UsageLog` в zewex.tools — добавить `stage` и `purpose`.

#### `article_cost_report` — project_id, total_calls, total_wasted_calls, total_input/output/thinking_tokens, total_cost_usd, total_wasted_cost_usd, stage_breakdown jsonb. Код не пишет — заменить агрегатом по логу.

#### `pipeline_errors` — source (`article`/`photo`/`photo_moderation`/`ai_moderation`/`publication`), site_id, queue_id, project_id, keyword, stage, signature (нормализованная `error_signature`), message (≤2000), resolved, resolved_at, created_at. Индексы: created_at desc; (signature, created_at).

#### `workflow_stages` — project_id FK, stage_number (UNIQUE с project_id), stage_name, status, started_at, completed_at, input_data, output_data (напр. Stage 5: `{outfits_total, outfits_processed, skipped}`), error_data (`{message}`), manual_edited_output, awaiting_confirmation, retry_count. В zewex.tools это `PinJob`-подобные записи шагов; `output_data` хранит тяжёлые JSON (блюпринт) — лучше вынести в отдельную таблицу артефактов.

#### `team_members` — owner_id, member_user_id (null пока не создан auth-пользователь), email, display_name, allowed_pages jsonb (`["dashboard","workflow","review","ai_moderation","scenarios","prompts","calculator","logs","settings","docs"]`), allowed_sites uuid[] (`null` = все), is_active.

#### `telegram_bots` — user_id, bot_name, bot_token (открыто), chat_id, is_active, show_cost, notify_completed; `telegram_bot_sites` — bot_id, site_id UNIQUE.

#### `integrations` — user_id, service (`poyo`, `openai`, `laozhang`, `openrouter`, `dataforseo`, `perplexity`, `serpapi`, `deepl`, `proxy`), name, label, encrypted_api_key (вопреки названию — сырой ключ), config (`{login, password}` для DataForSEO; `{proxies: [{id, url, region, is_active}]}` для proxy; местами `model`, `prompt_template`, `writer_mode`, `country`), is_active, priority (порядок перебора), last_check_status/message/at, balance_value/currency/checked_at, usage_limit/usage_used (DeepL). В zewex.tools уже есть ключи с приоритетами и привязкой к сервисам — переносить **значения**, не таблицу.

#### `automation_settings` (singleton `id='singleton'`) — cron_enabled, every_minutes, auto_disable_when_idle, idle_ticks, auto_enable_on_queue, lanes (4), max_parallel_stages (3), max_concurrent_per_site (6), max_pregate_per_site (3), max_concurrent_sites (16), max_concurrent (40), max_writing_per_site (6), ai_mod_auto_enabled/ai_mod_auto_batch (DEPRECATED → sites). В zewex.tools → константы/ENV воркера + страница «Автозапуск».

#### `provider_models` — user_id (null = общие), service (`openrouter`/`laozhang`), model_id, label, kind (`text`/`image`), is_active, position; UNIQUE(user_id, service, model_id, kind). В zewex.tools уже есть модели у провайдера (seed Perplexity) — слить.

### 1.4 Ограничения и индексы, которые надо воспроизвести
- UNIQUE: `article_drafts.project_id`, `articles.project_id`, `article_sections(project_id, section_number)`, `article_photos(project_id, image_url)`, `article_photos(project_id, fingerprint) WHERE fingerprint IS NOT NULL` (partial — в MariaDB через generated column или проверку в коде), `photo_candidates(project_id, image_url)`, `ai_moderation_results(run_id, queue_id)`, `scenarios.scenario_number`, `scenarios` default (partial), `prompt_sets` active (partial), `provider_models(user_id, service, model_id, kind)`, `telegram_bot_sites(bot_id, site_id)`, `workflow_stages(project_id, stage_number)`, `photo_reference_set(owner_id, niche_code, image_url)`.
- Полезные индексы: `article_queue(site_id, created_at desc)`, `(status, position)`, `(status, created_at)`, partial `status='photo_review'`, `completed_at WHERE status='completed'`, `locked_at WHERE lock_id IS NOT NULL`, `test_tag`; `photo_candidates(project_id, ai_verdict, ai_score desc)`, `(project_id, tech_status)`, `phash`; `generations_log(project_id, created_at desc)`; `pipeline_errors(signature, created_at desc)`; `photo_moderation_events(user_id, created_at)`; `article_drafts(publish_state, publish_next_attempt_at)`, `(moderation_claimed_at)`.
- CHECK только один: `photo_reference_set.status`. Все перечисления статусов — свободный text; в Prisma завести enum.

---

## 2. Функции и триггеры БД — что делают и чем заменить

| Функция / триггер | Что делает | В zewex.tools |
|---|---|---|
| `error_signature(msg)` IMMUTABLE | Нормализует текст ошибки: UUID → `<id>`, строки в кавычках → `"…"`, числа → `#`, пробелы схлопнуть, 200 символов | Функция TS в `lib/articles/errors.ts`; сигнатура считается при записи |
| `log_queue_error()` триггер AFTER INSERT/UPDATE OF error_message ON article_queue | Если `error_message` непустой, изменился и не похож на служебную заметку (regex «ждёт модерации», «Пауза владельцем», «Полный стоп», «этап сохранён», «Ожидает пополнения баланса»), парсит `Stage N` из текста, пишет в `pipeline_errors` с `source = photo` (этап 10–14 или статусы photo_review/insufficient_photos) иначе `article` | Явный вызов `recordPipelineError()` в воркере при переводе статьи в ошибку; хранить `error_message` и `note` раздельно, чтобы не фильтровать regex-ом |
| `log_publication_error()` ON article_drafts.publish_error | Пишет `source=publication`, stage 78, подтягивает site_id/keyword из очереди | То же в publish-воркере |
| `log_ai_moderation_error()` ON ai_moderation_results.error | `source=ai_moderation`, stage 140; отсеивает служебные («уже в статусе», «повтор не оплачиваем», «отменён») | То же в ИИ-модерации |
| `auto_enable_queue_cron()` AFTER INSERT ON article_queue | При добавлении `pending` и `auto_enable_on_queue` — включает pg_cron | Не нужно: воркер zewex.tools постоянно жив |
| `auto_enable_site_phase()` AFTER INSERT/UPDATE OF status | При переходе в `pending` включает обратно этап сайта (фото или написание), если он выключился по `idle` и `auto_restart_on_queue` | Логика в воркере при постановке статьи в очередь (`enqueueArticle`) |
| `set_scenario_number()` BEFORE INSERT ON scenarios | `max(scenario_number)+1` | AUTO_INCREMENT-колонка `number` в таблице сценариев |
| `update_updated_at_column()` | updated_at = now() на 9 таблицах | Prisma `@updatedAt` |
| `claim_queue_item_lock / release_queue_item_lock` | Атомарный захват строки очереди с порогом «протухания» | Уже есть паттерн lease в `worker/domains.ts` (claim + lease 120 с) — переиспользовать |
| `claim_orchestrator_lock / claim_orchestrator_lane / release_*` | Singleton-лок и лок на «полосу» оркестратора (4 lanes) | Один процесс воркера; при нескольких — `SELECT … FOR UPDATE` на строку лока |
| `acquire_service_slot / release_service_slot` | Лимит одновременных обращений к внешнему сервису (service_leases, TTL 180 с, re-entry того же holder) | Семафор в памяти воркера (один процесс) или таблица `ServiceLease` |
| `merge_pipeline_cursor(queue_id, jsonb)` | Слияние курсора с удалением ключей `null` | `JSON_MERGE_PATCH` в MariaDB или чтение-слияние-запись под lease |
| `renumber_article_photos(project_id, order_ids[])` | Перенумеровать `position`/`section_number` по заданному порядку (через +10000 чтобы не ловить UNIQUE) | Транзакция в server action `reorderPhotos` |
| `cleanup_photo_data()` | Удаляет отпечатки старше 30 дней и кандидатов старше 3 дней у завершённых статей | Крон-задача воркера (как `cleanup` в Pins) |
| `delete_site_cascade(site_id)` | Ручной каскад удаления проектов/статей/очереди/привязок ботов, statement_timeout 600s | Prisma `onDelete: Cascade` + удаление файлов в storage |
| `can_access_site(user, site)` / `get_allowed_sites` / `get_team_owner_id` / `is_team_owner` | RLS: не сотрудник → всё; сотрудник с `allowed_sites=null` → всё; иначе по списку | Уже есть `canAccessPinSite` / `pinSiteWhere` в `src/lib/sites/access.ts` — сделать общий `articleSiteWhere` |
| `get_cost_report(from,to,openrouter_only)` / `get_cost_report_v2(from,to,service)` | Отчёт стоимости: по сайтам (cost, calls, articles, wasted, dfs_cost, completed, completed_cost), по этапам, по сервисам; завершённые статьи за период | SQL/Prisma-агрегат по `UsageLog` для страницы «Расходы» (есть `/calculator`) |
| `production_daily_stats(from,to)` / `production_hourly_stats(from,to)` | По дням (в Europe/Malta): опубликовано, среднее время от создания до публикации, проверено фото, проверено ИИ, стоимость по этапам; по часам: опубликовано, ошибки (publication/other) | Агрегаты для «Статистики»; таймзону хранить в настройках, не хардкодить |
| `site_autostart_diagnostics()` | По сайту: сколько на модерации уже проверено ИИ / не тронуто, сколько «сайт не принимает медиа», сколько в retry, ближайшая попытка публикации, опубликовано за 24 ч, последняя публикация | Один запрос для страницы «Автозапуск сайтов» |
| `get_queue_cron / set_queue_cron / set_queue_cron_auto_disable / set_queue_cron_auto_enable` | Управление pg_cron (`queue-orchestrator-tick` → HTTP POST в edge function с публичным ключом в теле SQL) | Не переносить; «Автозапуск» = флаг `workerEnabled` + health воркера |

RLS-политики (≈60) заменяются проверками в server actions: владелец видит всё; сотрудник — данные владельца, ограниченные `allowed_sites`; изменение `pipeline_errors.resolved` — только владелец; `provider_models` с `user_id=null` общие.

---

## 3. Карта UI

Навигация: фиксированный левый сайдбар (260 px, сворачивается до 72) с 23 пунктами в одном плоском списке без группировки; TopBar пустой (иконки звонка и пользователя без действий). Тёмная тема, «золотой» акцент, framer-motion.

### 3.1 Сводная таблица страниц

| Маршрут | Страница | Что показывает | Данные | Доступ |
|---|---|---|---|---|
| `/` | Dashboard | Карточки сайтов (здесь называются «Project») со счётчиками очереди/ревью, 4 KPI, виджет активных очередей, поиск, создать/удалить сайт | sites, projects, article_queue, article_drafts (4 запроса, join на клиенте); `delete_site_cascade` | `dashboard` |
| `/site-queue` | Порядок сайтов | Таблица сайтов с drag-and-drop порядка (приоритет оркестратора), счётчики очереди/ревью/ошибок, «добавлено сегодня/вчера», последнее ревью | sites, article_queue, projects, article_drafts (чанками по 5 сайтов) | `site-queue` или `dashboard` |
| `/project/:siteId` | ProjectPage (страница сайта) | Шапка, 3 KPI, доступы WP + «Проверить», ссылка Google Таблицы, категории публикации, **ArticleQueuePanel** | sites, article_queue; `test-wp-connection`, `sync-wp-categories` | все, кто видит сайт |
| `/article/:projectId`, `/workflow/:projectId` | WorkflowRunner | Пошаговый прогон проекта: шапка с Run All / Run Step / Resume, стоимость/бюджет, лента шагов, детали шага (вход/выход, результаты, Clean) | projects, workflow_stages, outfits, article_queue.pipeline_cursor, sites; realtime на workflow_stages | `workflow` |
| `/photo-moderation` | PhotoModerationPage | Модерация фото режима 2 (статус `photo_review`) — см. 3.4 | article_queue, article_photos, photo_candidates, sites; `photo-review-action`; photo_moderation_events | все (без проверки прав) |
| `/review/:projectId` | PhotoReviewPage | Ревью образов после написания (legacy generated_photo): исключить/вернуть образ, Approve, Publish, Re-review | projects, article_drafts, outfits, generated_images, article_sections, image_prompts; `apply-review-exclusions`, `stage7-publish-wordpress`, `telegram-notify` | `workflow` или `review` |
| `/moderation` | ModerationPage | Модерация статей (`review_pending`): список слева, плитки фото (по outfits), SEO-поля, категория, одобрить/опубликовать, в доработку | article_queue, sites, article_drafts, outfits, article_photos, generated_images, article_sections; `resolve-wp-category`, `reorder-article-sections`, `publish-worker` | `workflow` или `review` |
| `/publications` | PublicationsPage | Вкладки Ошибки / В очереди / Опубликовано по `publish_state`; повторить, в доработку | article_drafts, article_queue, sites; `publish-worker` | `workflow` или `review` |
| `/ai-moderation` | AiModerationPage | Запуск ИИ-модерации по сайту, список запусков, таблица решений с фильтрами и массовыми действиями, диалог решения; вкладка «Мало фото» | ai_moderation_runs/results, sites, article_queue, team_members; `ai-photo-moderate` (start/stop/resolve/rerun/compare/watchdog/insufficient_action) | `ai_moderation` |
| `/scenarios` | ScenariosPage | Сценарии по формату и нише, карточка с 6 вкладками, мастер создания, копия, по умолчанию | scenarios, niches, prompt_sets, prompts, image_prompts, image_prompt_groups, sites | `scenarios` |
| `/prompts` | PromptManager | Наборы промтов: 3 панели (наборы / шаги / редактор) + вкладка визуальных промтов | niches, prompt_sets, prompts, image_prompts* | `prompts` |
| `/calculator` | CostCalculator | Отчёт расходов за период по сайтам и этапам, фильтр сервиса | `get_cost_report_v2` | `calculator`, владелец |
| `/logs` | GenerationsLog | Лог ИИ-вызовов с фильтром по проекту (`?project=`), вкладки Статистика/Логи | generations_log | `logs`, владелец |
| `/monitoring` | MonitoringPage | Лента событий + статистика по логу генераций | generations_log | `monitoring`/`logs`, владелец |
| `/automation` | AutomationPage | Глобальный переключатель автопроверки (pg_cron), интервал 1/5 мин, авто-вкл/выкл, «Проверить сейчас», очистка опубликованных материалов | `get_queue_cron`, `set_queue_cron*`, article_queue count; `queue-orchestrator`, `cleanup-published-articles` | владелец |
| `/sites-autostart` | SitesAutostartPage | Таблица 21 колонка: по сайту включение/лимиты этапов, ИИ-проверка, автовключение, счётчики, «что мешает сейчас»; строка «Все сайты» | sites, article_queue (все активные статусы), `site_autostart_diagnostics` | владелец |
| `/settings` | SettingsPage | API-ключи по провайдерам (ApiKeysManager + ProviderModelsSection), SOCKS5-прокси | integrations, provider_models; `check-api-key`, `test-proxy` | `settings` |
| `/import-export` | ImportExportPage | Экспорт/импорт промтов и сайтов (JSON v3) | prompt_sets, prompts, sites… | `settings` |
| `/team` | TeamPage | Сотрудники: добавить (email/пароль/имя/страницы/сайты), редактировать, пароль, активность, удалить | team_members, sites; `manage-team-member` | владелец |
| `/staff-stats` | StaffStatsPage | Кто работает сейчас, сводка по сотрудникам, графики по дням, сессии; ProductionStatsCard | photo_moderation_events (60 дней, по 1000), team_members, article_queue; `production_daily_stats`/`hourly` | владелец |
| `/reference` | ReferencePage | Эталонные фото по нише: собрать кандидатов, отметить selected | photo_reference_set; `reference-candidates` | владелец |
| `/errors` | ErrorsPage | «Горит сейчас», статьи в ошибке по этапам, «не по нашей вине», фильтры (сутки/7/30, источник, сайт, этап), группы по сигнатуре с подсказкой «что делать», вернуть в работу / устранено, график | pipeline_errors, article_queue(failed), sites | владелец |
| `/telegram` | TelegramBotsPage | Боты: добавить, тест, вкл/выкл, показывать стоимость, уведомлять о завершении, привязка к сайтам | telegram_bots, telegram_bot_sites, sites; `telegram-notify` | владелец |
| `/prompt-performance` | PromptPerformancePage | Эффективность визуальных промтов по review_score (legacy) | generated_images, outfits, image_prompts | владелец |
| `/benchmark` | BenchmarkPage | Сессии бенчмарка стоимости: баланс до/после по провайдерам | benchmark_* | владелец |
| `/docs` | DocumentationPage | Markdown документации, кнопка копировать | — | `docs` |
| — | AgentEditor | Редактор агентов/команд — маршрута нет (мёртвый код) | agent_teams, agents | — |

### 3.2 Dashboard (`/`)
- Загружает все сайты, все проекты по сайтам, всю очередь по сайтам, все драфты по проектам и агрегирует на клиенте (4 запроса, без лимитов; при 1000+ строк Supabase обрезает ответ — SiteQueuePage уже обходит это чанками, Dashboard нет).
- KPI: Total Projects (= сайтов), Total Articles (= проектов), Total Spent (скрыт сотрудникам), In Progress.
- Карточка сайта: Готово / В работе / В очереди / Ошибки (две из четырёх метрик считают несуществующие статусы `done`/`error`), Ревью/Опубл./Готовы (по `review_status === "pending"|"reviewed"` — тоже устаревшие значения), «⚡ В работе», потрачено, последнее завершение/ревью; кнопка Open Project, удалить (hover-иконка → AlertDialog → `delete_site_cascade`).
- Диалог «New Project (Website)» создаёт **сайт** (name, site_url). Терминология: «проект» в UI = сайт, в БД `projects` = статья.
- Виджет «Активные очереди» — отдельный запрос каждые 30 с + подписка на клиентский `queueEngine`.

### 3.3 Страница сайта (`/project/:siteId`) и очередь (ArticleQueuePanel)
Блоки сверху вниз: назад, KPI (тем в очереди / в работе / потрачено), **Доступы WordPress** (3 поля + Сохранить + Проверить), **Google Таблица** (URL + Сохранить), **Категории публикации** (SiteCategoriesSection: Обновить список, правила «слова → категория», категория по умолчанию, чекбокс ИИ, Сохранить), **Очередь статей**.

Очередь статей:
- Шапка: прогресс, «Сбросить кеш» (AlertDialog; переводит failed/running/completed в pending, обнуляет project_id/cursor/cost — пересоздаёт проекты), Остановить / Запустить очередь (N) / Retry failed (N) / Продолжить (N).
- Запуск: клиент сам проверяет «уже запущена статья — дождитесь Stage 5+», ставит `running` и вызывает `direct-pipeline` invocation 1. Остановка: все running → pending с сохранением курсора без `_attempts`.
- Баннеры: running (ключ + имя этапа), «Очередь остановлена из-за ошибки» (Повторить — обнуляет курсор полностью / Пропустить), «Есть статьи на паузе» (Возобновить всё — пачками по 200 paused+failed → pending, `triggerOrchestrator`).
- Форма добавления в одну строку из 11 полей: Keyword*, SEO Keyword, Focus Keyword, Дизайнов/Фото, Гео (2 буквы), Язык, Свежесть (Сценарий/Любая/Год/Месяц/Неделя), Режим (1 — модерация статьи / 2 — сначала фото), Сценарий* (подпись: №, название, ниша, формат, ⭐), Добавить. Под строкой — подсказка, что задаёт сценарий. Изменение «Дизайнов» и «Сценария» **молча** через 500 мс сохраняется в `sites.default_outfits_count/default_scenario_id`.
- Дубликаты: два `window.confirm` (проект с тем же focus_keyword в работе; ключ уже в очереди).
- Модалка «Массовая загрузка»: строки `keyword, seo, focus, кол-во` (таб или запятая), сценарий, «Фото», переключатель «Случайное количество от–до». Модалка «Google Sheets»: URL (или из сайта), сценарий (не используется — сценарий берётся по колонке «Сценарий» номером), «Фото», случайное количество; `sheets-sync read` → фильтр строк без статуса и Publish URL → вставка с `sheet_row/sheet_tab`, `year_in_url`, гео/язык/свежесть из колонок → `sheets-sync mark`. Строки без сценария или режима пропускаются с предупреждением.
- Фильтр-табы по статусу с количеством (Все, В работе, Отбор фото, Написание, Ожидают, Ошибки, Модерация фото, Ждут фото, Зависли/пауза, На ревью, Готово). «Отбор фото/Написание» различаются по `current_stage >= 15` или `pipeline_cursor.photo_review_approved`.
- Таблица 13 колонок: чекбокс, #, Keyword (+бейдж Тест), SEO, Focus, Фото, Ниша/формат, Сценарий (+📄 строка таблицы / ⚠ таблица), Статус (бейдж, смесь RU/EN), Этап (spinner + имя этапа или текстовые состояния), Время, $ (не сотрудникам), Действия (📸N ⚠️N🚫txt, ссылка WP, 📋 Review, логи, открыть проект, Стоп/Продолжить/Повторить/Перезапустить/Удалить иконками). Пагинация 10 на страницу, клиентская; данные — вся очередь сайта страницами по 1000 (до 20 000), автообновление 30 с.
- Единственное массовое действие — Удалить выбранные.
- Повтор (Retry) для `waiting_for_photos` откатывает этап 13–14 → 12 и ставит флаги `rp_resume_filter`, `photo_topup_after_rating`; для 72–78 без `article_plan` откатывает на этап 2.

### 3.4 Модерация фото (`/photo-moderation`) — режим 2
Раскладка: заголовок + бейдж «N ждут» + select сайта + подсказка «Ctrl+Enter — одобрить»; sticky-панель статьи; секция «В статье»; секция «Запас»; полноэкранный zoom по клику.

- Выбор статьи: грузятся ближайшие 100 строк `photo_review` по `position`, перебираются до первой, которую удалось **закрепить** (`photo-review-action claim`; занято другим ≤15 мин → следующая). Ответ claim несёт `keyword_ru`, `trend_brief_ru` (модно/устарело).
- Sticky-панель: ключ, 🇷🇺 перевод, `<details>` «Тренды по ключу», сайт · план N фото · error_message; бейдж «В статье X / минимум 15» (красный, пока <15); кнопки: Добрать ещё фото (topup — статья уходит из очереди и вернётся с резервом), Пропустить (release skip, клиентский skip-набор), Мало фото — пропустить (window.prompt причины → mark_insufficient), Одобрить и писать (disabled <15).
- «В статье»: быстрые раскладки — Топ-5 + через одну, По баллам, Чередовать, Вертикальные вперёд, Перемешать (каждая сразу сохраняет reorder); 4 размера: Компактно (сетка 5–12 колонок, квадраты, вся раскладка на экране), Крупно (2–6 колонок, 3:4), Очень крупно (≥400 px), Мега (≥600 px) — запоминаются в localStorage на пользователя. Карточка: номер, ★ балл, домен, размеры (красным, если <450), drag-ручка (крупные — угол 48 px, компакт — вся карточка), ✕ убрать, «Устарело» (remove reason=dated), 🔍 zoom. Клик по фото в режиме «Крупно» = убрать (!), в компакте = zoom. Красная рамка, если нет `facts` и `description`.
- «Запас»: табы Одобрены ИИ (N) / Отклонены ИИ (N); фильтр формы Все/Вертикальные/Квадратные; сортировка по beauty_rank, затем ai_score; показ по 60 + «Показать ещё»; карточка: домен, размеры, ★ балл, 📌 виральность (красным <45), ✨ тренд (красным <40), заметка/причина; клик = добавить (`add`), 🔍 zoom. В «Мега» грузится оригинал, иначе thumbnail.
- Телеметрия: `heartbeat` каждые 30 с при активности (мышь/клавиши/скролл ≤45 с назад), `open` каждые 60 с при видимой вкладке. Сервер пишет события действий. Ошибка 409/`stale` → автопереход к следующей статье.
- Проблемы: минимум 15 зашит константой; одобрение без объяснения, почему нельзя; причина «мало фото» через `window.prompt`; фото статьи грузятся оригиналами (нет миниатюр); нет истории «кто уже снимал это фото»; нет undo.

### 3.5 Ревью образов (`/review/:projectId`, legacy) 
Сетка 2–4 колонки по `outfits`: фото (wp_url или public_url, thumb 600), бейдж review_score, «#позиция имя», 🎨 имя визуального промта, «⚠ Нет текста» (секция не `written/assembled` или <10 слов), кнопка Exclude/Restore (сразу `outfits.excluded`). Низ: 📸 N фото · ⚠️ без текста · N образов будет удалено; Approve & Continue (при исключениях — `apply-review-exclusions` пересобирает HTML и обновляет живую статью) → `review_status=approved`, очередь `reviewed`; Generate Meta & Publish (`stage7-publish-wordpress`; при `blocked` показывает причину качества) → `completed`, `published`, telegram; Re-review. Лайтбокс. Используется из очереди (📋 Review/Ревью) и из «Публикаций» («открыть статью»).

### 3.6 Модерация статей (`/moderation`) и Публикации (`/publications`)
Moderation: табы сайтов с количеством (сохраняется в localStorage), баннер публикации (публикуется / в очереди / не опубликовано + ссылка), верхняя панель «i / N · за смену · осталось · снято фото», кнопки Проблемные (N), Крупные ×2, Одобрить всё чистое (цикл по загруженным: без исключений и без пустых секций → approved/reviewed, без публикации), чекбокс «публиковать сразу», Назад/Пропустить/Одобрить(+опубликовать). Слева список ключей (50, догрузка). Справа: сайт, ключ КАПСОМ, перевод (из `topic_keywords`), SEO Title / H1 / Описание / Адрес с счётчиками символов (сохраняются при переходе), счётчики фото/вычеркнуто/без текста/статус, Категория на сайте (select из `sites.wp_categories`; автоопределение `resolve-wp-category`, источник подписан). Сетка плиток по `outfits` (3–8 колонок, или 2–4 крупно): клик = снять/вернуть, двойной клик = лайтбокс с zoom колесом/панорамой, drag-ручка → `reorder-article-sections` (блок статьи переезжает вместе с фото), номер, балл, «нет текста», «СНЯТО», размеры под плиткой красным. Низ: Мало фото / Слабый текст (→ `needs_rework` с причиной), Пропустить, Одобрить. Клавиши: стрелки, X/пробел, V, Enter, S, Backspace. Закрепление через `article_drafts.moderation_claimed_*` (предупреждение, если другой <10 мин), продление каждые 5 мин. Одобрить+опубликовать → `publish_state=queued`, очередь `publish_queued`, `publish-worker` wake. Prefetch фото следующей статьи.

Publications: табы Ошибки / В очереди (queued, retry, publishing) / Опубликовано с количеством, select сайта, «Повторить все ошибки (N)», Обновить, ссылка «К модерации»; строка: иконка состояния, ключ, сайт, попыток, «повтор в HH:MM», дата публикации, «нужно решение человека» (permanent), текст ошибки + время фиксации (Валлетта), список неустранимых quality_issues; действия: на сайте, открыть статью (`/review/:id`), Повторить (сброс попыток → queued), В доработку. Автообновление 20 с, лимит 200 строк.

### 3.7 ИИ-модерация (`/ai-moderation`)
Вкладка «Результаты»: карточка «Новый запуск» — сайт, Статей (10/50/200/Все (N)/число ≤5000), Режим Тест (только предлагает) / Авто (уверенные применяются, спорные — людям), оценка цены $0.03–0.08×N, Запустить. Карточка «Запуски» (8 последних): дата, сайт, бейдж режима, «Промодерировано X из Y», $, статус, Стоп, «Сравнить дорогой моделью» (compare-запуск Gemini Pro, не применяется). Фильтры решение/статус/запуск, сводка «Всего · одобрить · мало фото · людям · $». Массовые действия над отмеченными `proposed`: Одобрить, Отправить человеку, Мало фото, Исключить, Перепроверить (resolve вызывается по одному из-за таймаутов). Таблица: ключ (+бейдж compare), сайт, решение, уверенность, фото до → после, −/+, причина/ошибка, статус. Диалог решения (max-w-6xl): summary, бейджи scores (Ключ/Pinterest/Тренд/Порядок, нужно/минимум), сетка «Итоговая подборка» (R = добавлено из резерва), «Удалено» с причинами, «Добавлено из резерва», кнопки решения. Превью через `images.weserv.nl` с 4 попытками. Watchdog каждые 60 с пока есть running. Вкладка «Мало фото»: карточки по дням (ИИ/люди), по сайтам, кто отметил; таблица статей `insufficient_photos` с действиями Добрать фото / На модерацию.

### 3.8 Сценарии (`/scenarios`) — настройки, переносимые 1:1
Верх: табы формата (Генерируем фото / Реальные фото), поиск, «Новый сценарий». Группировка по нише. Карточка (свёрнута): иконка формата, №, название (инлайн-переименование), «По умолчанию», подниша, готовность («готов» / «промты не готовы» / «формат в разработке» для real_photo), строка «Набор: … · шагов заполнено X/Y · картиночный промт: выбран/нет · описание»; кнопки Переименовать, ⭐ По умолчанию (запрещено, если набор неполный), Копировать (глубокая копия набора промтов, визуальных промтов, групп, слотов + remap stage_prompt_ids — 6 последовательных циклов без транзакции, откат удалением набора), Удалить (confirm), раскрыть.

Развёрнутая карточка: предупреждение «Запуск невозможен — не хватает промтов» + вкладки (состав зависит от формата, см. раздел 4):
1. **Основное**: Название, Описание, Формат (только чтение), Ниша, Подниша (сброс набора при смене), Набор промтов («Активный набор ниши» или конкретный), Режим выполнения (Автоматический/Пакетный/Ручной), Публикация на сайт (3 режима; «при загрузке статьи можно поменять»), слайдер «Год в URL статьи N%» (шаг 5; колонка таблицы перекрывает), Switch «Сценарий доступен для запуска».
2. **Промты и модели**: по фазам, строка на шаг: название (+«нет промта»), select варианта промта (Первый вариант / варианты набора), select провайдера (TEXT_PROVIDERS с описанием), select модели (из `provider_models` для openrouter/laozhang, иначе PROVIDER_SUBMODELS; «добавьте модель в настройках»).
3. **Пайплайн**: подсказка «Количество идей задаётся при загрузке… сайт и публикация — на уровне сайта»; Объём статьи (compact3/compact2/compact/full), Характер текста (Авто/С иронией/Тёплый/Любознательный/Уверенный/Самоироничный), слайдер «Секций за один запрос» 1–10; Шаги: Switch Schema.org.
4. **Изображения** (generated_photo): Режим визуальных промтов (Один промт / Группа), select промта или группы из набора, Генератор изображений (OpenAI Image / PoYo / LaoZhang / NanoBananaAPI), для не-OpenAI — Пропорции (2:3,3:4,1:1,4:5,9:16) и Разрешение (1k/2k/4k); для OpenAI — Модель (gpt-image-2 / 1.5 / 2.5-flare), Качество (low/medium/high), Размер (1024×1536 / 1024×1024 / 1536×1024); подсказка о фолбэке.
5. **Поиск фото** (real_photo): Источник (SerpApi / DataForSEO / оба), Кандидатов запрашивать, Ориентация (мультивыбор ≤2: любая/вертикальные/горизонтальные/квадратные), Мин. сторона кадра px (≥450, одно число на оба поля), Тип изображения (фото/любые), География (11 стран), Язык, Свежесть (без/год/месяц/неделя), Лицензия (любая/коммерческая), Искать только на сайтах (домены или ссылка на пост Instagram), Исключить сайты, Добавка к запросу, Модель оценки — провайдер (OpenRouter/LaoZhang NT/LaoZhang) и модель (из справочника или текст), слайдер «Фото в одной пачке» 2–12, слайдер «Порог отбора» 1–10, Подпись под фото (без/домен/домен со ссылкой/полная ссылка), Шаблон подписи `{credit} {domain}`, Уникальность между сайтами (мягко/строго/не учитывать), Как писать текст секций (автор видит фото / по описанию).
6. **Провайдеры**: значения по умолчанию по полям `PROVIDER_FIELDS` (Концепт-план, Автор промта для фото 5.1 + модель, Генерация изображений, SEO изображений, План секций 16 + модель), подсказка «модель из вкладки Промты главнее».
Кнопка Сохранить (валидация: группа выбрана, если режим «group»).

Мастер «Новый сценарий»: 1. Формат (две карточки), 2. Ниша + Подниша, 3. Набор промтов, Название → создаёт с `execution_mode=scenario` и `photo_search_config` по умолчанию для real_photo.

### 3.9 Промты (`/prompts`)
Три панели фиксированной высоты: **Наборы** (группы по родительской нише; ⭐ активный; подпись подниша · формат), **Шаги** (по фазам; кружок с коротким кодом — заполнен/обязателен-пуст/опционален; инфо-кнопка `StageInfoButton` со stageNumber; счётчик вариантов), **Редактор**: заголовок шага (обязательный/опциональный, ключ), кнопки Вариант / Удалить / Сохранить (disabled, если не dirty), чипы вариантов (+«Новый вариант»), Название варианта, Switch «Отдельный постоянный блок» → Textarea system, Textarea промта (монослой, 320 px), чипы переменных шага с подсказками (вставка в курсор). Вкладка «Визуальные» — `ImagePromptsManager` (английский UI: Name, Description, Prompt Text, Назначение, Set as default, Send reference images, Референсы текстом (Style DNA) + `describe-style-references`, группы с Prompt Slots и процентами). Шапка набора: ниша → подниша · формат · X/Y обязательных; «Скопировать промты из…» (другой набор того же формата, только в пустые шаги), Копия, Сделать активным (блок при ошибках валидации), Удалить. Валидация (`validatePromptSet`): ошибки — не заполнен обязательный шаг; предупреждения — неизвестные переменные, промты неиспользуемых шагов. Создание набора: ниша, подниша, формат, название → сразу создаются пустые заготовки по всем шагам. `prompt_versions` не пишутся; guard-confirm при уходе с несохранённым текстом.

### 3.10 Настройки (`/settings`, `/import-export`), Автозапуск (`/automation`), Автозапуск сайтов (`/sites-autostart`)
- Settings: заголовок «API-ключи сервисов и сетевые настройки конвейера». ApiKeysManager: карточка на провайдера (Poyo, OpenAI, LaoZhang, OpenRouter, DataForSEO (логин+пароль), Perplexity, SerpApi, DeepL (лимит символов)) со списком ключей: метка, маска, баланс, последняя проверка, Switch вкл/выкл, Проверить, Удалить, приоритет; «Проверить все ключи» (`check-api-key`). ProviderModelsSection — справочник моделей OpenRouter/LaoZhang (text/image). SOCKS5-прокси: `host:port[:user:pass]` + регион, Тест (`test-proxy`), вкл/выкл, удалить; хранится в `integrations.config.proxies`. Сайты здесь **не** настраиваются.
- Import/Export: JSON экспорт/импорт промтов и сайтов (v3).
- Automation: карточка «Автопроверка включена/выключена» (Switch → pg_cron), «Как часто» (1 / 5 мин), «Включать автоматически при появлении статей», «Выключать при пустой очереди 15 мин», последняя проверка, Обновить, Проверить сейчас; карточка «Очистка опубликованных материалов» (счётчик, AlertDialog, прогресс пачками по 5).
- Sites Autostart: 8 карточек-сводок по шагам (ждут поиска фото / ищутся / ждут проверки фото / мало фото / ждут написания / пишутся / ждут публикации / пауза-ошибка), легенда, таблица min-width 1540 px: Сайт | 1. Поиск фото (Включён, Лимит, Ждут, Сейчас) | 2. Ручная проверка (Ждут, Мало фото) | 3. Написание (Включено, Лимит, Ждут, Сейчас) | 4. Публикация (Лимит, Ждут) | ИИ-проверка (Включена, Лимит, Запуск от, Ждать если в публикации ≥) | Автовключение | Пауза | Ошибки | Что мешает сейчас (текстовая диагностика: хостинг не принимает фото, retry, следующая попытка, опубликовано за 24 ч, ИИ выключена/ждёт пачку/ждёт бэклог, этап выключен). Строка «Все сайты» переключает всё. Числа сохраняются по blur каждой ячейки. Компонент `SiteAutostartSection` (тот же набор для одного сайта) существует, но ни одна страница его не подключает.

### 3.11 Ошибки, Статистика сотрудников, Команда
- Errors: подробно в 3.1. Хорошая модель: группировка по (этап, сигнатура), «Горит сейчас» (час vs предыдущий), словарь KNOWN с человеческими названиями и «что делать» (bug/external), «Вернуть в работу» только статьи в `failed` с сохранением этапа, «Устранено» пачками по 200, график по дням по источникам. Названия этапов — собственный словарь (отличается от promptRegistry).
- StaffStats: фильтр сотрудника, период (сегодня/вчера/7/30/свой), «Кто работает сейчас» (онлайн ≤2 мин, отошёл ≤15 мин, статья в работе, активно сегодня, открыто), ProductionStatsCard (опубликовано, среднее время, проверено, ИИ, стоимость по дням), сводка: одобрено, пропущено, % пропусков, доборов, ср. время на статью, статей в час, активное время (паузы >90 с не считаются), вкладка открыта, удаляет/добавляет фото в среднем (+% «устарело»), быстрее/дольше всего; графики одобрено и активное время по дням, удалено/добавлено на статью; сворачиваемая таблица сессий (новая сессия после 15 мин, паузы 1,5–15 мин, статей за сессию, чистая работа). Всё считается на клиенте из событий за 60 дней.
- Team: карточки сотрудников (email, имя, бейджи страниц, сайты, активен), диалоги: Добавить (Email, Пароль ≥10 — placeholder говорит «минимум 6», Имя, чекбоксы «Доступные страницы» из ALL_PAGES (10), «Видимость сайтов»: все или список), Редактировать, Пароль (provision_auth, если auth-пользователя ещё нет), Активировать/деактивировать, Удалить (confirm). Всё через `manage-team-member`. Сотрудник, открыв `/team`, видит заглушку.

### 3.12 WorkflowRunner (`/article/:id`)
WorkflowHeader: имя (focus_keyword), сайт, Run All (scenario → `runScenarioBackground` с клиентского `workflowEngine`; иначе runStage(3)), Run Step (current+1), Resume (если execution_mode=scenario и есть завершённые шаги), Refresh. Карточка стоимости/бюджета (не сотрудникам). `StagePipeline` — лента шагов по формату с индикатором гейта (pipelineCursor). `StageDetails` — на каждый шаг: статус, время, Run / Resume / Confirm (awaiting_confirmation) / Stop (failed «Stopped by user») / Clean (window.confirm; каскад удалений описан в клиенте: шаг 2 удаляет outfits/images, шаг 5 чистит storage и сбрасывает драфт/секции и шаги 6–77, шаг 7 удаляет секции и драфт, 71–78 поэтапно), `StageIOPanel` (вход/выход из `stageIOMap`), специализированные вьюверы: Stage2ResultViewer, Stage5ResultViewer/PromptConfig/Provider, Stage6ImageGrid, Stage65ResultViewer, Stage7ResultViewer, PhotoStagePanel (real_photo). Realtime-подписка на `workflow_stages` с дебаунсом, самолечение счётчика Stage 5 из `outfits`, авто-возобновление прерванного клиентского процесса из localStorage. Фактически — инженерная консоль, продублированная с серверным direct-pipeline.

---

## 4. Реестры (`src/lib`)

### 4.1 `promptRegistry.ts`
- `ARTICLE_FORMATS`: `generated_photo` («Генерируем фото», AI-фото), `real_photo` («Реальные фото», Real).
- `NICHES` fallback (реальный список — таблица `niches`).
- Фазы `PHASE_ORDER`: Исследование → Концепты → Изображения → Отбор → SEO → Текст → Сборка.
- `StageDef`: key, label, short, phase, formats, required, variables, hint, stageNumber, description, inputs, outputs, niches / excludeNiches.
- Группы переменных: `NAIL_VARIABLES` (keyword_nail_shape, _length, _color, _technique, _art, keyword_surface), `HAIR_VARIABLES` (keyword_hair_cut, _length, _texture, _color, _color_technique, _styling, keyword_face_shape), `OUTFIT_VARIABLES` (outfit_mode, keyword_outfit_type, _hero_piece, _silhouette, _palette, _style, _occasion, _season, _age, _body_type, _setting), `INTERIOR_VARIABLES` (decor_mode, hero_element, setting, interior_contract, keyword_room, _zone, _style, _palette, _materials, _size, _budget, _season, _occasion), `TEXT_STAGE_VARIABLES` (niche_label, topic_facts, article_context, trend_context, trend_details, hair_brief, cut_specs, scene_context, section_briefs, batch_number, total_batches, batch_size, previous_batch_summary, previous_ending, keywords_bolded_previous, primary_keyword, total_outfits, content_angle, subcategories, outro_plan, care_plan, topic_kind, required_facts). `VARIABLE_HINTS` — русские подсказки на каждую (≈85 переменных).
- `STAGE_REGISTRY` (10 ключей):

| key | label | фаза | форматы | обяз. | stage№ | переменные (кроме групп по нишам) |
|---|---|---|---|---|---|---|
| `stage_2` | Концепт-план | Концепты | generated | да | 2 | topic, focus_keyword, count_items, sections_count, language, target_country, niche, subniche, keywords_table, target_word_count, article_personality + все нишевые. Заменяет старые 1, 6.4, 6.5, 7.1, 8 |
| `stage_5_scene_planner` | Планировщик сцены | Изображения | generated | нет (не для ногтей) | 5 | item_name, item_details, style_description, photography_direction, focus_keyword, scene_context |
| `stage_6_image_seo` | SEO изображений | SEO | оба | да | 6 | item_name, focus_keyword, language, image_context, images_table + нишевые |
| `stage_7_writer_system` | Автор — постоянный блок | Текст | оба | да | 73 | language, niche, subniche, article_personality + нишевые + TEXT_STAGE |
| `stage_7_writer_user` | Автор — секции | Текст | оба | да | 73 | section_brief, item_name, item_details, focus_keyword, target_word_count + нишевые + TEXT_STAGE |
| `stage_7_intro_outro` | Вступление и заключение | Текст | оба | да | 72 | focus_keyword, blueprint, language, article_personality, sections_summary + нишевые + TEXT_STAGE |
| `rp_photo_plan` | Планирование по фото | Концепты | real | да | 15 | topic, focus_keyword, photos_table, photo_captions, sections_count, total_sections, language, target_country, niche, subniche, target_word_count, article_personality, topic_kind, niche_label, subject_label, required_facts + нишевые |
| `rp_section_plan` | План секций | Концепты | real | да | 16 | topic, focus_keyword, photo_facts_table, sections_count, total_sections, language, niche, subniche, target_word_count, article_personality, angles, openers, topic_kind, niche_label, subject_label, required_facts + нишевые |
| `rp_photo_search` | Поисковые запросы для фото | Исследование | real | да | 11 | focus_keyword, topic, language, target_country, niche, subniche, topic_kind |
| `rp_photo_rate` | Оценка фото | Отбор | real | нет | 13 | focus_keyword, topic, niche, subniche, language, topic_kind, subject_label |

- Функции: `stagesForFormat(format, niche, subniche)` (фильтр по нише, сортировка фаза→номер), `requiredStageKeys`, `getStage`, `extractVariables` (`{var}`), `validatePromptSet` → `{level, stageKey, message}`.
- `PIPELINE_GENERATED_PHOTO`: 2 Концепт-план → 5 Генерация фото → 6 SEO изображений → 73 Текст секций → 65 Сборка блюпринта (служебный, optional) → 72 Вступление и заключение → 76 Сборка HTML → 78 Публикация. `PIPELINE_REAL_PHOTO`: 11 Поиск фото → 12 Технический фильтр → 13 AI-оценка фото → 14 Отбор фото → 15 Планирование по фото → 16 План секций → 65 → 73 → 72 → 76 → 78. Каждый шаг: icon, phase, group, optional, description, inputs, outputs, promptKeys.
- `LEGACY_STAGE_LABELS`: 1 Тренды, 55 Отбор фото, 64 Ключи, 71 План статьи, 74 Заключение, 77 Мета-теги — «удалён/объединён». `pipelineStageName(num)`.
- `IMAGE_PROMPT_USAGES`: universal / manicure / pedicure.

### 4.2 `scenarioRegistry.ts`
- `TEXT_PROVIDERS`: openrouter (основной), laozhang_nothinking, laozhang, poyo, lovable_gateway, perplexity/sonar. `PROVIDER_SUBMODELS` — захардкоженные подмодели для laozhang / laozhang_nothinking / openrouter с ценами в описании. `splitModelValue/joinModelValue` для формата `provider:model`.
- `IMAGE_PROVIDERS`: openai_image, poyo, laozhang, nanobananaapi. `OPENAI_IMAGE_MODELS/QUALITIES/SIZES`, `DEFAULT_OPENAI_IMAGE` = gpt-image-2 / low / 1024x1536.
- `PROVIDER_FIELDS`: stage2_provider (generated), stage51_provider+stage51_model (generated), stage5_api_provider (generated), stage6_provider (оба), stage16_provider+stage16_model (real).
- `STEP_TOGGLES`: только schema_enabled.
- `WORD_COUNT_OPTIONS`: compact3 ~900, compact2 ~1400, compact ~1900, full 2500+. `PERSONALITIES`: __auto__, wry, warm, curious, confident, self-deprecating. `PUBLISH_MODES`: auto / moderate_first / publish_then_edit. `EXECUTION_MODES`: scenario / batch / manual.
- `PhotoSearchConfig` + `DEFAULT_PHOTO_SEARCH_CONFIG` (dataforseo, 100 кандидатов, tall+square, 450 px, min_score 8, photo, US/en, caption domain_link `{credit} {domain}`, unique soft, rating `openrouter:google/gemini-2.5-flash-lite`, батч 8, writer image). Справочники PHOTO_SOURCES, ORIENTATIONS, FRESHNESS, COUNTRIES (11), CAPTION_MODES, WRITER_MODES, UNIQUE_MODES.
- `SCENARIO_TABS`: basic, prompts, pipeline (все), images (generated), photos (real), providers (все). `tabsForFormat`, `providersForFormat`, `togglesForFormat`.

### 4.3 `stageIOMap.ts`
Презентационная карта «вход → выход → кому передаётся» по номерам шагов: 1, 2, 5, 55, 6, 64, 65, 71, 72, 73, 74, 76, 77, 78 (с описаниями вроде «projects → focus_keyword… → workflow_stages.output_data»). Содержит удалённые шаги (1, 55, 64, 71, 74, 77) и не содержит real_photo (11–16). Используется только `StageIOPanel`. При переносе объединить с `PIPELINE_*` (inputs/outputs уже есть там) и удалить.

### 4.4 Прочее
- `apiProviders.ts`: `API_PROVIDERS` (service, title, description, link, credentials key|login_password, placeholder, balance, balanceLabel, charLimit, supportsModels), `maskKey`, `formatBalance`.
- `providerModels.ts`: `modelServiceFor` (laozhang*/openrouter* → сервис), `hasCustomModels`, hook `useProviderModels().optionsFor(provider, kind)`.
- `dateTime.ts`: `APP_TIME_ZONE = "Europe/Malta"`, `maltaDateKey`, `shiftDateKey`, `maltaDateTimeToUtc`, `maltaStartOfDay/EndOfDay`, `formatMaltaDateTime/Date/Time` (ru-RU). Таймзона жёстко зашита и в UI, и в SQL-функциях.

---

## 5. Права

- Роли фактически две: **владелец** (нет записи в `team_members`) и **сотрудник** (активная запись с `owner_id`). `useAuth`: `isTeamMember`, `isOwner`, `canAccessPage(key)` — владелец всегда true, сотрудник — по `allowed_pages`.
- Ключи страниц, которые можно выдать в TeamPage (`ALL_PAGES`): `dashboard`, `workflow`, `review`, `ai_moderation`, `scenarios`, `prompts` («только чтение» — но страница на запись), `calculator`, `logs`, `settings`, `docs`. По умолчанию новому сотруднику: dashboard, workflow, review.
- Маршруты (App.tsx): `/` dashboard (иначе редирект на `/article` — несуществующий маршрут); `/site-queue` site-queue или dashboard; `/project/:id` без проверки; `/article/:id` workflow; `/review/:id`, `/moderation`, `/publications` workflow или review; `/photo-moderation` **без проверки** (видна всем); `/scenarios`, `/prompts`, `/calculator`, `/logs`, `/settings`, `/import-export` (settings), `/ai-moderation`, `/docs` по ключу; `/monitoring` monitoring или logs; `/automation`, `/sites-autostart`, `/team`, `/staff-stats`, `/reference`, `/errors`, `/telegram`, `/prompt-performance`, `/benchmark` — только владелец (`!isTeamMember`).
- Сайдбар фильтрует по pageKey, но у части пунктов ключи не из ALL_PAGES (`site-queue`, `monitoring`, `team`, `telegram`, `prompt-performance`, `benchmark`, `photo-moderation`) — сотруднику их выдать нельзя, они скрываются только по `isTeamMember`; `photo-moderation` показывается всегда.
- Видимость сайтов: `team_members.allowed_sites` (null = все) через `can_access_site` в RLS (sites, article_queue, projects, pipeline_errors, ai_moderation_*). Сотрудники не видят стоимость (`$`, Total Spent, cost tracker — по `isTeamMember` в UI, в данных стоимость всё равно отдаётся).
- Данные владельца сотрудникам доступны через `is_team_owner/get_team_owner_id` в политиках (scenarios только владельцу — сотрудник видит список сценариев в очереди, потому что `scenarios` policy `user_id = auth.uid()`… фактически сотруднику сценарии не видны, если он не владелец; в коде очереди это не обработано).
- Соответствие zewex.tools: владелец → ADMIN; сотрудник → участник команды с `SiteAccessViewer`-видимостью; `allowed_pages` → набор прав сервиса «Статьи»: `queue` (добавлять/запускать), `photo_moderation`, `article_moderation`, `ai_moderation`, `scenarios` (редактировать рецепты), `costs` (видеть деньги), `admin` (ошибки, автозапуск, команда, ключи).

---

## 6. Слабые места

### 6.1 UI/UX
1. **Настройки сайта разнесены по четырём местам**: `/project/:id` (WP-доступы, Google Таблица, категории), `/sites-autostart` (включение этапов, лимиты, ИИ-модерация), форма очереди (сценарий и кол-во фото по умолчанию сохраняются молча при каждом изменении select), `/import-export` (экспорт сайтов). Готовый компонент `SiteAutostartSection` для одного сайта никуда не подключён. Глобальные лимиты — ещё и в `/automation` и в `automation_settings`, который редактируется только SQL-ом.
2. **Дублирование обзора**: Dashboard и «Порядок сайтов» показывают один и тот же список сайтов с почти теми же счётчиками, но считают их по разным (и частично несуществующим) статусам: Dashboard — `done`/`error` (всегда 0), `review_status pending/reviewed`; SiteQueue — `completed`/`failed`, `review_pending`, `review_status published / repair_pending`. Пользователь видит разные цифры на двух страницах. Терминология «Project» = сайт на дашборде и «проект» = статья в БД/WorkflowRunner.
3. **Пять экранов модерации с разной механикой**: `/photo-moderation` (режим 2, claim в очереди на 15 мин, 4 размера, Ctrl+Enter), `/review/:id` (legacy образы, кнопки по-английски), `/moderation` (статьи, claim в драфте на 10 мин, ×2, 7 клавиш), `/ai-moderation` (таблица решений), `/publications`. Для одной статьи сотрудник может оказаться в 3 из них. Нет единой «карточки статьи», куда ведут все ссылки: из очереди — в WorkflowRunner или `/review`, из публикаций — в `/review`, из ошибок — никуда.
4. **Форма добавления тем**: 11 полей в одну строку + 2 модалки, в которых повторяются «Фото» и «Случайное количество», причём эти значения общие (state один) — изменение в одной модалке меняет другую; в модалке Google Sheets селект сценария есть, но не используется (сценарий берётся из колонки). Два `window.confirm` на дубликаты. Нет предпросмотра импорта.
5. **Очередь**: 13 колонок, клиентская пагинация по 10 при загрузке всей истории сайта (до 20 000 строк каждые 30 с); 18 статусов с бейджами на смеси языков («📋 review», «Ready to publish», «✅ Done», «🔧 ремонт»); действия — крошечные иконки без подписей; единственное массовое действие — удалить. Пять разных «повторов» (Сбросить кеш, Повторить в баннере, Retry failed, Повторить в строке, Возобновить всё) с разной обработкой курсора: баннер и сброс обнуляют `pipeline_cursor` целиком (теряется прогресс и уже оплаченные шаги), остальные сохраняют.
6. **WorkflowRunner — инженерная консоль в продукте**: английский UI, видимые номера шагов (65, 73, 72…), кнопка Clean с ~100 строками каскадных удалений на клиенте (включая удаление файлов из storage), «самолечение» Stage 5 в браузере, клиентский `workflowEngine` с localStorage, который запускает шаги параллельно серверному direct-pipeline (две системы выполнения). Сотрудникам доступен по `workflow` — это самый опасный экран.
7. **Модерация фото**: минимум 15 зашит; кнопка «Одобрить» просто disabled без подсказки; причина «мало фото» через `window.prompt`; клик по фото в режиме «Крупно» = удаление без подтверждения, в «Компактно» = zoom (разная семантика клика); нет undo; «Пропустить» — только в памяти вкладки (после перезагрузки статья вернётся); фото статьи грузятся оригиналами. Heartbeat пишет 2 строки/мин на человека в таблицу, которую потом целиком считает клиент (60 дней × N сотрудников).
8. **Сценарий vs набор промтов vs модели**: чтобы запустить новую нишу, нужно: создать набор (`/prompts`), заполнить 6–10 шагов, активировать; создать сценарий (`/scenarios`), выбрать набор, на вкладке «Промты и модели» выбрать вариант и модель каждого шага, на «Провайдеры» — провайдеров по умолчанию, в `/settings` добавить модель в справочник, в `photo_search_config` — ещё одну модель оценки. Модель задаётся в 4 местах с правилом приоритета, описанным подсказкой. Готовность считается на клиенте и показывается только в карточке сценария.
9. **Промты без истории**: `prompt_versions` не пишутся, `version` не растёт; редактирование перезаписывает текст. «Вариант» промта выбирается в другом разделе (сценарий), поэтому при правке неясно, какой вариант реально работает. Визуальные промты — на английском.
10. **Автозапуск сайтов** — таблица 21 колонка с горизонтальным скроллом, редактирование чисел по blur в каждой ячейке, без подтверждений; строка «Все сайты» переключает этапы на всех сайтах одним кликом. `/automation` управляет pg_cron (Supabase-специфично) и в тексте уверяет, что «бэкенд не работает вхолостую».
11. **Права**: список страниц для выдачи (10) не совпадает со списком пунктов меню (23); `/photo-moderation` открыта всем; `prompts` подписан «только чтение», но даёт полный доступ; при отсутствии `dashboard` редирект на несуществующий `/article`; placeholder «минимум 6 символов» при валидации ≥10.
12. **Смесь языков и терминов**: Dashboard, WorkflowRunner, PhotoReviewPage, ImagePromptsManager, StatusBadge на английском; остальное на русском; «outfits» в полях для ногтей и интерьеров; «Дизайнов»/«Фото»/«идей» для одного числа.
13. **Таймзона Europe/Malta** зашита в UI и SQL; подписи «(Валлетта)» в интерфейсе.
14. **Словари имён этапов в 4 копиях**: `promptRegistry.pipelineStageName`, `workflowEngine.getStageName`, `ErrorsPage.STAGES`, `stageIOMap` — расходятся (в ErrorsPage есть 10, 75, 125, 140; в реестре их нет).
15. Повсюду агрегаты на клиенте (Dashboard, SiteQueue, StaffStats, SitesAutostart тянут тысячи строк и считают в браузере) и автообновления таймерами (20–120 с) — при 16 сайтах и десятках тысяч строк это медленно и дорого.

### 6.2 Модель данных
1. **`projects` — 200+ колонок**, из них ~45 FK на промты по нишам (`stage7_hairstyle_*`, `stage7_haircolor_*`, `stage7_nails_*`, `compact*`), ~25 `keyword_*`-замков по нишам как отдельные колонки, параллельно с новыми `stage_prompt_ids`/`keyword_attributes` JSON. Те же legacy-колонки продублированы в `scenarios` (с другими дефолтами: `openrouter` в projects vs `laozhang_nothinking` в scenarios).
2. **Тройная денормализация настроек**: сценарий → копия в `article_queue` (niche_code, subniche_code, article_format, prompt_set_id, publish_mode, article_type) → копия в `projects`. Правка сценария не влияет на очередь; какая версия использовалась, восстановить нельзя (нет снимка настроек целиком).
3. **Статус статьи размазан по 4 таблицам**: `article_queue.status` (18 значений), `article_drafts.review_status` (9) + `publish_state` (6) + `moderation_flag`, `projects.status`, `workflow_stages.status`. Все — свободный text без CHECK; UI проверяет значения, которых нет. Переходы делаются из клиента (ModerationPage/PublicationsPage пишут статусы в 2 таблицы без транзакции).
4. **`articles` vs `article_drafts`** — две таблицы на одну сущность; `article_cost_report`, `prompt_versions`, `pipeline_config`, `publish_config`, `agents/agent_teams`, `prompt_groups`, `cleanup_tokens` — мёртвые или не записываемые.
5. **Legacy-мост через `outfits`**: модерация и секции real_photo привязаны к псевдо-образам (`outfit_id` в `article_sections`, `article_photos`, `generated_images`), хотя формат generated_photo объявлен вторичным. Это главный источник сложности в модерации.
6. **JSON без схемы**: `pipeline_cursor` (45 ключей, snake+camel), `workflow_stages.output_data` (тяжёлые блюпринты в строке статуса), `article_plan`, `plan_data`, `facts/ai_facts` (разный набор по нише), `niche_profiles.*`, `integrations.config` (разные формы для разных сервисов), `sites.wp_categories/category_rules`, `team_members.allowed_pages`.
7. **Секреты открытым текстом**: `sites.wp_app_password`, `integrations.encrypted_api_key` (несмотря на имя), `telegram_bots.bot_token`, пароли прокси в `config`, логин/пароль DataForSEO в `config`. В zewex.tools — шифровать `APP_ENCRYPTION_KEY` как остальные ключи.
8. **Дублирование данных**: `keyword` копируется в `pipeline_errors`, `ai_moderation_results`, `photo_usage_fingerprints.keyword_norm`; `wp_category_name` рядом с id; `site_id` в `photo_moderation_events` и `ai_moderation_results` при наличии `queue_id`.
9. **Отсутствующие ограничения**: `article_queue.user_id`, `sites.user_id`, `team_members.member_user_id`, `photo_candidates.queue_id`, `photo_usage_fingerprints.site_id/project_id`, `ai_moderation_results.queue_id/site_id`, `pipeline_errors.*_id`, `telegram_bot_sites.*`, `article_queue.wp_category_id` — без FK; `allowed_sites uuid[]` без FK. Нет индексов `pipeline_errors(site_id)`, `generations_log(api_service, created_at)`, `article_queue(site_id, status)` составного (есть отдельные), `article_drafts(review_status, …)` для модерации по сайту (join через очередь).
10. **Partial unique / массивы / pg_cron / RLS** — всё Postgres-специфично: `prompt_sets` активный, `scenarios` default, `article_photos.fingerprint` partial — в MariaDB через generated-колонку (`active_key = IF(is_active, CONCAT(...), NULL)`) или проверку в транзакции; `uuid[]` → связки `ArticleRunQueue`, `TeamMemberSite`; RLS → `where`-хелперы; cron → воркер.
11. **Рост таблиц без ретеншена**: `photo_moderation_events` (2 строки/мин/модератор), `generations_log` (каждый вызов), `photo_candidates` (сотни на статью, чистка через 3 дня функцией, которую кто-то должен вызывать), `workflow_stages.output_data`.

---

## 7. Предложение структуры UI для zewex.tools

Принципы: верхняя навигация без сайдбара (как сейчас в портале), раздел **Pinterest** получает второй сервис **«Статьи»** рядом с «Пинами»; три уровня настроек — **система `/sites`** → **сайт в сервисе** → **запуск**; одна карточка статьи как центр, куда ведут все ссылки; агрегаты — на сервере одним запросом; никаких клиентских движков выполнения — только воркер.

### 7.1 Что объединить
- **Сценарий + набор промтов → одна сущность «Рецепт статьи» (`ArticleRecipe`)**. Набор промтов существует только внутри рецепта (один рецепт = ниша + формат + промты + модели + настройки). «Активный набор ниши» и «сценарий по умолчанию» заменяются одним флагом «рецепт по умолчанию для ниши/формата». Варианты промтов остаются (A/B внутри шага), но выбираются там же, где редактируются. Нужен ли отдельный справочник промтов для копирования между рецептами — да: действие «Скопировать промты из рецепта…» и экспорт/импорт JSON (как `prompts.export.json`).
- **Модель задаётся в одном месте** — в строке шага рецепта («Промт | Провайдер/модель»), с глобальным значением по умолчанию в настройках ключей (слоты `text_concept`, `text_writer`, `text_intro`, `image_seo`, `photo_rate`, `photo_search_dfs`, `photo_search_serp`, `image_gen`, `ai_moderation`); вкладка «Провайдеры» и `rating_model` в конфиге поиска исчезают.
- **Dashboard + Порядок сайтов → одна страница «Сайты»** с перетаскиванием приоритета и воронкой по этапам.
- **PhotoReviewPage + ModerationPage → одна «Модерация статьи»** на базе `article_photos`/секций, без outfits. **PhotoModerationPage** остаётся отдельным «конвейерным» экраном (режим 2), но с той же раскладкой и тем же компонентом сетки.
- **Automation + SitesAutostart → одна страница «Автозапуск»** (воркер + таблица сайтов), плюс те же переключатели в настройках сайта.
- **Errors + Monitoring + Logs** → «Журнал» с вкладками Ошибки / Вызовы ИИ / Расходы (Cost Calculator). Benchmark, Prompt Performance, AgentEditor, Reference (эталоны) — не переносить в первой итерации (эталоны — позже в настройки ниши).

### 7.2 Экраны

**Система (уже есть)**
- `/sites` — сайт = `SiteAccess` (WP REST URL, логин, пароль приложения, проверка подключения, команды, сервисы (галочка «Статьи»), видимость сотрудникам). Добавить: Telegram-бот сайта (перенос `telegram_bots` + привязка), Google Таблица (URL вкладки).
- `/keys` — ключи ИИ/SEO с галочкой «Статьи» и слотами (см. выше); справочник моделей провайдера (перенос `provider_models`); прокси SOCKS5 как отдельный тип ключа.
- `/team` — сотрудники и права сервиса «Статьи» (`queue`, `photo_moderation`, `article_moderation`, `ai_moderation`, `recipes`, `costs`, `admin`).

**Сервис `/pinterest/articles`**
1. `/pinterest/articles` — **Обзор**: таблица сайтов (drag-порядок), по сайту воронка «ждут фото → на модерации фото → мало фото → пишутся → на модерации статьи → публикуются → ошибки → опубликовано за 24 ч», индикаторы «этап выключен / ждёт пачку ИИ / хостинг не принимает фото» (из диагностики), последняя статья, добавлено сегодня. Плашка «Воркер: работает / остановлен», «Ошибок за час: N». Кнопки: Новый запуск, Модерация фото (N), Модерация статей (N).
2. `/pinterest/articles/sites/[id]` — **Сайт**, вкладки:
   - **Очередь** — все статьи сайта (серверная пагинация и фильтры по статусу/запуску/рецепту/поиску), колонки: ключ, рецепт, режим, статус (один словарь на русском), этап, кто модерировал, время, стоимость (по правам), ссылка WP; массовые действия над выбранными: Повторить, Остановить, Вернуть в очередь, Сменить рецепт/режим, Удалить; клик → карточка статьи.
   - **Настройки** (= `PinsSiteSettings`): ниша и рецепт по умолчанию, кол-во фото по умолчанию, режим (1/2) по умолчанию, публикация (auto / moderate_first / publish_then_edit), категории WP (синхронизация, правила «слово → категория», по умолчанию, ИИ), автозапуск (поиск фото вкл + лимит, написание вкл + лимит, публикация лимит, авто-включение при новых статьях), ИИ-модерация фото (вкл, запуск от N, параллелизм, ждать если в публикации ≥ N), язык/гео/свежесть поиска по умолчанию, Google Таблица, Telegram.
   - **Статистика** — опубликовано по дням, время цикла, стоимость, ошибки сайта.
3. `/pinterest/articles/runs/new` — **Новый запуск** (как у пинов, шаги): 1) сайт; 2) рецепт (с индикатором готовности и ссылкой «исправить»); 3) ключи — вручную (поля keyword / seo / focus / кол-во, по строке) или вставка CSV/таб, или Google Таблица (предпросмотр строк с пропущенными/ошибочными до импорта); 4) параметры запуска: кол-во фото (точно / диапазон), режим 1/2, публикация, переопределения поиска (гео, язык, свежесть), год в URL, тестовая метка; значения по умолчанию — из настроек сайта (`runDefaultsFrom`). Проверка дубликатов ключей показывается списком до запуска, не `confirm`.
4. `/pinterest/articles/runs/[id]` — **Запуск** (партия): прогресс, статьи партии со статусами, массовые действия, журнал ошибок партии, стоимость, остановить/продолжить.
5. `/pinterest/articles/articles/[id]` — **Карточка статьи** (замена WorkflowRunner + PhotoReviewPage): шапка (ключ, перевод, сайт, рецепт, режим, статус, стоимость), таймлайн шагов (вход/выход сворачиваемо, ошибка, время, повторить с этого шага, остановить), вкладки **Фото** (сетка с порядком, резерв — тот же компонент, что в модерации), **Текст** (секции с H2 и HTML, мета H1/title/description/slug с редактированием), **Публикация** (категория, состояние, попытки, ссылка, повторить), **Журнал** (вызовы ИИ и ошибки этой статьи). Опасные действия («очистить шаг») — только администратору и только через server action с каскадом на сервере.
6. `/pinterest/articles/moderation/photos` — **Модерация фото** (режим 2, конвейер «следующая свободная статья»):
   - Фильтр сайта (табы с количеством), счётчик «ждут», кто ещё работает (онлайн).
   - Sticky-шапка: ключ + перевод, тренды (модно/устарело) по клику, сайт, план N, «В статье X / нужно ≥ M» с подсказкой почему нельзя одобрить, кнопки **Одобрить и писать** (Enter), **Добрать фото**, **Мало фото** (всплывающее поле причины, не prompt), **Пропустить** (сервер фиксирует skip, статья уходит в конец очереди для этого сотрудника), размер превью (3 размера, запоминается), раскладки (по баллам / чередовать / вертикальные вперёд / перемешать) в выпадающем меню.
   - Одна сетка с двумя зонами друг под другом: **«В статье»** (пронумерована, drag за всю карточку, двойной клик — лайтбокс, кнопки ✕ и «Устарело» на карточке, бейджи ★ балл / размеры / домен / «нет описания») и **«Резерв»** (табы Одобрены ИИ / Отклонены ИИ, фильтр формы, карточка с ★, 📌 виральность, ✨ тренд, причина, кнопка «+»). Клик по фото **никогда не удаляет** — только явная кнопка; есть «Отменить последнее» (undo стека действий в рамках статьи).
   - Миниатюры для всех фото через `/files/` (как у пинов — sharp на сервере), оригинал — только в лайтбоксе.
   - Телеметрия: события действий пишет server action; активность — одна строка «сессия» с продлением, а не heartbeat-строки.
7. `/pinterest/articles/moderation/articles` — **Модерация статей** (режим 1 и после написания): список слева (по сайтам), справа карточка: мета-поля с счётчиками, категория, сетка фото **с текстом секции под каждым фото в раскрывающемся блоке** (чтобы «слабый текст» оценивался не вслепую), снять/вернуть фото, перетаскивание порядка (секция едет с фото), кнопки Одобрить / Одобрить и опубликовать / В доработку (причина из списка + текст) / Пропустить; клавиши как сейчас; закрепление единым механизмом (`claimedBy/claimedAt` в одной таблице статей, TTL 15 мин, видно кто держит).
8. `/pinterest/articles/moderation/ai` — **ИИ-решения**: запуск (сайт, N, тест/авто), запуски, таблица решений с фильтрами и массовыми действиями, диалог «итоговая подборка / удалено / добавлено» — перенос текущего, только с миниатюрами с нашего сервера; вкладка **Мало фото** (добрать / на модерацию / закрыть).
9. `/pinterest/articles/publications` — **Публикации**: вкладки Ошибки / В очереди / Опубликовано, фильтр сайта, повторить все, в доработку; из строки — в карточку статьи.
10. `/pinterest/articles/recipes` и `/recipes/[id]` — **Рецепты** (объединённые сценарий + промты): список по нише и формату с готовностью; карточка с вкладками **Основное** (название, ниша/подниша, формат (только при создании), по умолчанию, активен, режим публикации, год в URL, объём, характер, секций за запрос, Schema.org), **Промты** (список шагов по фазам слева — редактор справа: варианты, system-блок, текст, переменные-чипы, подсказки «что подставится», валидация набора прямо здесь; выбор активного варианта и модели шага — в той же строке), **Поиск фото** (real_photo; поля PhotoSearchConfig как сейчас, но без модели оценки), **Изображения** (generated_photo; визуальные промты и группы, генератор, размеры — переносить во второй итерации), **История** (версии промтов с diff — наконец пишем `PromptVersion`). Действия: копировать (одна транзакция), экспорт/импорт JSON, удалить (если нет активных статей).
11. `/pinterest/articles/automation` — **Автозапуск**: состояние воркера, глобальные лимиты (параллельных статей всего / на сайт / полос), таблица сайтов (компактная: сайт | фото вкл+лимит | написание вкл+лимит | публикация лимит | ИИ вкл+от N | авто-вкл | что мешает) с сохранением по «Сохранить» и строкой «все сайты» с подтверждением; очистка опубликованных материалов.
12. `/pinterest/articles/journal` — **Журнал**: вкладки **Ошибки** (перенос ErrorsPage как есть — лучшая страница сервиса: горит сейчас, группы по сигнатуре, что делать, вернуть в работу, устранено), **Вызовы ИИ** (лог с фильтром статьи/сайта/сервиса), **Расходы** (отчёт по сайтам/этапам/сервисам за период, скрыт без права `costs`).
13. `/pinterest/articles/stats` — **Статистика**: сотрудники (кто онлайн, сводка, сессии — считать на сервере по сессиям, не по heartbeat), производство по дням/часам.

### 7.3 Уровни настроек
| Уровень | Где | Что |
|---|---|---|
| Система | `/sites`, `/keys`, `/team` | WP-доступы и проверка, Telegram-бот, Google Таблица, ключи и модели со слотами «Статьи», права сотрудников и видимость сайтов, таймзона портала |
| Сайт в сервисе | `/pinterest/articles/sites/[id]?tab=settings` | Ниша и рецепт по умолчанию, кол-во фото, режим 1/2, публикация, категории WP и правила, автозапуск и лимиты этапов, ИИ-модерация, язык/гео/свежесть по умолчанию |
| Запуск | `/pinterest/articles/runs/new` → `ArticleRun.settings` | Рецепт, ключи, кол-во фото (точно/диапазон), режим, публикация, переопределения поиска, год в URL, тестовая метка; снимок рецепта сохраняется в запуске (`recipeSnapshot`) — именно его исполняет воркер |

### 7.4 Что это даёт сотруднику
- Один вход для работы: «Модерация фото» и «Модерация статей» с одинаковой сеткой, одинаковыми клавишами, одинаковым закреплением и миниатюрами с нашего сервера.
- Одна карточка статьи вместо трёх страниц; из любой таблицы (очередь, публикации, ошибки, ИИ-решения) — один клик в неё.
- Один словарь статусов на русском (`ArticleStatus` enum в Prisma, подписи в одном файле), один словарь имён этапов (из реестра пайплайна).
- Массовые действия в очереди и в публикациях; никаких `window.confirm`/`prompt`.
- Настройки сайта в одном месте с понятными группами; рецепт — в одном месте с промтами, моделями и готовностью.
