# 02. Цепочка реальных фото (real_photo): поиск → тех. фильтр → сравнение → ИИ-оценка → отбор

Аудит исходников Supabase Edge Functions (Deno) сервиса «Zewex Pinterest Articles» для переноса в Node.js-воркер (Next.js 15 + Prisma + MariaDB). Разобраны:

- `stage-photo-search/index.ts` (шаг 11), `stage-photo-filter/index.ts` (12), `stage-photo-rank/index.ts` (125 = «12.5»), `stage-photo-rate/index.ts` (13), `stage-photo-select/index.ts` (14);
- `_shared/`: `photoSearch.ts`, `photoQueries.ts`, `photoVision.ts`, `photoQuality.ts`, `photoRelevance.ts`, `photoAuthenticity.ts`, `photoAudience.ts`, `photoGender.ts`, `audienceIntent.ts`, `photoDiversity.ts`, `topicContract.ts`, `fashionContract.ts`, `interiorContract.ts`, `nicheProfile.ts`, `cutSpecs.ts`, `nailSpecs.ts`, а также `trendBrief.ts`, `promptSet.ts`, `serviceSlots.ts`, `photoDescribe.ts`;
- оркестрация: `direct-pipeline/index.ts` (инвокации 1–2), `photo-review-action/index.ts` (ручная модерация, скачивание), `db/schema.sql`.

Все ссылки вида `file:line` — на файлы в `supabase/functions/`.

---

## 0. Общая схема и порядок вызова

`direct-pipeline/index.ts:432-597` для `article_format = "real_photo"`:

```
инвокация 1:  stage-photo-search (1 вызов) → stage-photo-filter (цикл до 30 вызовов, пока done=false)
инвокация 2:  stage-photo-rank (цикл) → stage-photo-rate (цикл) → stage-photo-select (1 вызов, runOneShot)
              → (pipeline_mode=2) статус photo_review → далее план/текст
```

Обратные переходы (`direct-pipeline`):
- rate вернул `needs_filtering` → снова инвокация 1 с курсором `rp_resume_filter` (поиск пропускается), не более 6 кругов (`photo_filter_cycles`, :512-515);
- rate вернул `needs_more_photos` → инвокация 1 с `photo_topup_after_rating` (фильтр делает добор `request_topup`), не более 7 кругов (`photo_more_cycles`, :533-545);
- select вернул `waiting_for_photos`/`needs_more_photos`/0 фото → инвокация 1 с добором, если `topups < 6` и `photo_select_cycles ≤ 7` (:568-585), иначе `waitForPhotos`.

Каждая функция — «один вызов = одна пачка», состояние хранится в `photo_candidates.*_status` и `workflow_stages.output_data` (чекпоинты: `topups`, `topup_used_queries`, `topup_queries`, `rescue_pass`, `rescue_used`, `search_log`, `trend_brief`).

Таблицы (из `db/schema.sql`):
- `photo_candidates` (:1730-1764): `source, search_query, image_url, thumbnail_url, source_page_url, source_domain, title, width, height, fingerprint (sha256), phash (dHash 16 hex), sharpness, tech_status (pending|ok|rejected), tech_reason, tech_quality, ai_status (pending|retry|done), ai_score (0-10), ai_verdict (keep|reject), ai_reason, ai_description, ai_facts jsonb, ai_quality, ai_quality_breakdown jsonb, beauty_rank, beauty_note, selected, search_geo/search_language/search_freshness, queue_id`. Уникальный индекс `(project_id, image_url)` (:3079).
- `article_photos` (:1147-1177): `position, section_number, image_url, storage_path, public_url, source_page_url, source_domain, caption, alt_text, file_name, width, height, fingerprint, phash, ai_score, ai_reason, description, facts, reused, search_*`, уникальные `(project_id,image_url)` и `(project_id,fingerprint)`.
- `photo_usage_fingerprints` (:1806): `fingerprint, phash, site_id, project_id, keyword_norm, used_at` — уникальность между сайтами; чистится через 30 дней (`cleanup_photo_data`, :227).
- `workflow_stages` (:2306): `(project_id, stage_number)` → `status, output_data, error_data, started_at, completed_at`.
- `niche_profiles` (:1593), `photo_reference_set` (:1785), `integrations` (ключи SerpApi/DataForSEO), `generations_log` (расход), `service_leases` (слоты).

---

## 1. Шаги

### 1.1. Шаг 11 — `stage-photo-search` («Поиск фото»)

**Вход.**
- `projects`: `photo_search_config, focus_keyword, topic, article_format, niche_code, subniche_code, keyword_attributes, prompt_set_id, stage_prompt_ids, stage_models, language` (:57-62).
- `article_queue` по `project_id`: `keyword, focus_keyword, seo_keyword, count_outfits, site_id, photo_geo, photo_language, photo_freshness` (:64-68).
- `photo_candidates` других проектов с тем же `search_query` (кеш, :147-152).
- `niche_profiles` (через `loadNicheProfile`), `integrations` (ключи), `workflow_stages` (upsert).
- `body`: `project_id`, флаги `force_search` / `reset_search` (полный перезапуск с удалением кандидатов).

**Выход.**
- `photo_candidates` upsert пачками по 200 с `onConflict: project_id,image_url`, `ignoreDuplicates` (:234-240). Поля: `source` (`serpapi` | `dataforseo` | `*-cache`), `search_query`, `image_url`, `thumbnail_url`, `source_page_url`, `source_domain`, `title`, `width`, `height`, `search_geo/language/freshness`, `queue_id`.
- `article_queue.keyword_ru` — русский перевод ключа для модератора (только если было null) (:118-121).
- `workflow_stages[11].output_data`: `candidates, query, sources, notes, keyword_en, keyword_search, translated, search_geo, search_language, search_freshness, search_log[], fashion_contract, interior_contract, topup_queries[6], topup_queries_source (ai|fallback), trend_brief, trend_brief_ru` (:242-252). `topup_queries`/`trend_brief` потом читают шаги 12, 13, 14.
- Ответ `{success, candidates, query, notes}` или `{success:false, retry:true, reason:"image_search_busy"}`.

**Алгоритм.**
1. Слот ограничителя: `waitForServiceSlot(sb, "image_search", "photo-search:<projectId>", 45_000)` — лимит `SERVICE_LIMITS.image_search = 6` одновременных, TTL аренды 180 с, ожидание до 45 с с шагом 1..5 с (`serviceSlots.ts:5-58`; RPC `acquire_service_slot`/`release_service_slot`). Нет слота → ответ `retry:true` (см. слабое место 7.1).
2. Конфиг: `normalizePhotoConfig(project.photo_search_config)` → `applyQueueOverrides(cfg, queue)` (гео/язык/свежесть статьи важнее сценария). Константы `photoSearch.ts:46-71, 118-160`:
   - `MIN_PHOTO_SIDE = 550`; `min_width/min_height = max(550, cfg)`;
   - `candidates_total`: default 100, нижняя граница 40;
   - `orientation`: default `["tall","square"]`, максимум 2 типа, `any` обнуляет остальные;
   - `min_score = 7` (порог ИИ-оценки), `license any|commercial`, `image_type photo|any` (default photo), `freshness any|y|m|w`, `country` (нормализуется `normalizeCountry` по списку `VALID_COUNTRIES`, алиасы `EN→US, UK→GB, EU/GLOBAL/WORLD→US`), `language` (≤5 символов);
   - `include_domains`/`include_urls` (из одного списка через `splitIncludes`: домен + полная ссылка на пост, если путь длиннее 3 символов), `exclude_domains`;
   - `caption_mode` default `domain_link`, `caption_template "{credit} {domain}"`, `unique_mode soft|strict|off` (default soft);
   - `rating_model` default `"openrouter:google/gemini-2.5-flash-lite"`, `rating_batch_size` default 8, максимум 12; `writer_mode image|description`.
3. Ключ: `resolveSearchKeyword(queue, project)` = `queue.focus_keyword || project.focus_keyword || queue.keyword || queue.seo_keyword || project.topic` (:228-233).
4. Контракты: `buildFashionContract` для `niche_code === "outfits"`, `buildInteriorContract` для ниш `interior|decor|outdoor` (пишутся в `output_data`, дальше не используются этим шагом).
5. Если кандидаты уже есть и нет `force_search` → шаг помечается `completed` с `resumed:true` и возврат (:90-107). Иначе при `force_search` — `DELETE photo_candidates WHERE project_id`.
6. Профиль ниши `specializeProfile(loadNicheProfile(...), keyword)`; `generateTopupQueries(...)` — **один вызов ИИ** (см. ниже), результат = 6 запросов (3 primary + 3 secondary) + `keyword_ru` + `trend_brief`.
7. Основной запрос: первый шаблон `nicheProfile.search_templates.primary[0]` (у всех встроенных профилей `"{keyword}"`) → `primaryKeywordEn`. Если `cfg.language` не `en` — `translateSearchQueries` (ещё один вызов ИИ, модель `google/gemini-2.5-flash-lite`, temperature 0.2, maxTokens 400, timeout 45 с). Потом `buildSearchQuery`: убирается год `\b(19|20)\d{2}\b`, добавляются `query_suffix`, `site:` (один домен) или `(site:a OR site:b)`, `-site:` для исключений (`photoSearch.ts:189-199`).
8. `limit = max(20, cfg.candidates_total)` (= 100 по умолчанию).
9. **Кеш поиска**: `photo_candidates` других проектов с тем же `search_query`, до `limit` строк; если их `≥ min(limit, 40)` — берём их (`source = "<source>-cache"`), запросов к API нет (:145-167).
10. Иначе провайдеры по `cfg.source`: `serpapi`/`both` → `searchSerpApi`; `dataforseo` или (`both` и не хватает) → `searchDataForSeo(limit - items.length)` (:169-180). Default `source = "dataforseo"`, т.е. **один запрос DataForSEO глубиной 100**.
11. `include_urls` (до 10 ссылок на посты) — по каждой отдельный `searchSerpApi(postUrl, cfg, 15)` (только SerpApi) (:184-189).
12. Бесплатные фильтры (:193-228): дубликаты `image_url`, `include_domains` (кроме кадров с перечисленных постов), `isBlockedDomain` (встроенный список магазинов/соцсетей/стоков + `exclude_domains`, `photoSearch.ts:290-334`), размеры `width < min_width || height < min_height` и ориентация (`tall: ratio ≤ 1.05`, `wide: ≥ 0.95`, `square: 0.7..1.4`) — **только если провайдер отдал width/height** (DataForSEO их не отдаёт → проверка пропускается).
13. Нет строк → ошибка «Не найдено ни одного фото по запросу…» → `workflow_stages[11].status = failed`, пайплайн падает (`failPipeline`).

**Промты и переменные** (`photoQueries.ts:119-279`, `generateTopupQueries`):
- `stage_key = "rp_photo_search"`, промт из набора: `loadStagePrompt(supabase, project, "rp_photo_search")`; переменные `{focus_keyword}`/`{{focus_keyword}}`, `{topic}`, `{language}`, `{target_country}` (из `photo_search_config.country`, без учёта `photo_geo`!), `{niche}`, `{subniche}`, `{outfit_mode}`, `{fashion_contract}`, `{decor_mode}`, `{hero_element}`, `{setting}`, `{interior_contract}` (:191-208). К системному промту всегда дописываются `RU_NOTE` (поле `moderator_translation_ru`) и `trendBriefInstruction` (поля `trend_brief`, `trend_brief_ru`) (:211-217).
- Встроенный системный промт (`builtInSystem`, :163-189): 6 запросов (3 primary + 3 secondary), запрет негативных слов из `search_templates.negative`, запрет года/collage/tutorial/template/chart/printable/vector, 3–7 слов, English; плюс блоки fashion/interior-контракта, AUDIENCE, AGE/GENDER.
- Модель/провайдер: `stageModel(project, "rp_photo_search", "openrouter")` → провайдер из `stage_models`; `stageSubModel` → модель; иначе `configured.model` из промта, иначе `MODEL = "google/gemini-2.5-flash-lite"`. temperature 0.6, maxTokens 1200, timeout 45 с, `responseFormat json`.
- Постобработка: `keepAudience` — в каждый запрос принудительно дописываются слово аудитории («black women»), «outdoor»-слово для уличных интерьерных тем и слово пола (`women`/`men`) (:143-162); запросы с кириллицей выбрасываются; <6 → добивается `fallbackQueries` (шаблоны `search_templates.topup` + 6 легаси-вариантов `legacyFallbackQueries`); <2 → `source: "fallback"`.

**Модели по умолчанию:** генерация запросов — `openrouter` / `google/gemini-2.5-flash-lite`; перевод — то же. В наборах промтов (`PROMPTS.md`) для `rp_photo_search` указан `google/gemini-2.5-flash-lite`, для `rp_photo_rate` — `google/gemini-3-flash-preview`, но шаг 13 эту модель **не читает** (см. 7.9).

### 1.2. Шаг 12 — `stage-photo-filter` («Технический фильтр фото»)

**Вход.**
- `projects`: `photo_search_config, focus_keyword, topic, niche_code, subniche_code, count_outfits, prompt_set_id, stage_prompt_ids, stage_models, article_format, language`; `article_queue`: `keyword, focus_keyword, count_outfits, photo_geo, photo_language, photo_freshness`.
- `photo_candidates` с `tech_status = 'pending'` — **BATCH = 4** строки за вызов, порядок `tech_reason ASC NULLS FIRST` (новые раньше отложенных) (:216-222).
- `photo_candidates` с `tech_status='ok'` — `fingerprint`, `phash` для дублей внутри статьи (:375-380).
- `workflow_stages[11].output_data.topup_queries / topup_used_keywords` (вариации ключа), `workflow_stages[12].output_data.topups / topup_used_queries`.
- `body`: `project_id`, `request_topup`, `topup_from`, `process_pending`.

**Выход.**
- `photo_candidates`: `tech_status ok|rejected|pending`, `tech_reason` (русский текст причины; при `ok` — `null` или «миниатюра Google»), `fingerprint`, `phash`, `sharpness`, `width/height` (из байтов), `tech_quality` (0–100), при скачивании миниатюры — `image_url := thumbnail_url` (:491-506). При доборе — новые строки `photo_candidates` (`source = "<engine>-topup-N"`).
- `workflow_stages[12].output_data`: `passed, rejected, batch_passed, batch_rejected, batch_postponed, remaining, target, topups, topup_used_queries, topup_variants, reject_reasons{}, sub_step, last_topup{}, topup_notes, early_stop`; статусы `running | completed | failed`.
- `workflow_stages[11].output_data.search_log[]` дополняется записями добора; `topup_used_keywords` (:79-85, :305-320).
- `article_queue.keyword_ru` (если вариации генерировались заново).
- Ответ: `{done:false, ...}` после пачки/добора, `{done:true, passed, target, topups}` на финише.

**Константы.**
- `BATCH = 4`, `CONCURRENCY = 1` (:37-38); `MAX_TOPUPS = 10` (:40; комментарии «два добора»/«не больше 3» устарели);
- `needed = max(1, queue.count_outfits || project.count_outfits || 20)`; `minAcceptable = min(needed, 15)` (не используется дальше в этом файле); `reserveTarget = max(needed*5, needed+40)` → при 20 фото **100 технически годных кадров** (:188-193);
- `MAX_ATTEMPTS = 3` (попытка пишется в `tech_reason` «(попытка N)» ДО скачивания; при >3 — reject «источник не отдал файл после 3 попыток») (:227-244);
- скачивание: `fetch` с `AbortSignal.timeout(20_000)`, `User-Agent: "Mozilla/5.0 (compatible; ZewexBot/1.0)"`, без Referer; порядок URL `[image_url, thumbnail_url]`; по каждому URL до 2 попыток, повтор только при 429/5xx с паузой 1200 мс; `content-type` не `image/*` → следующий URL (:416-436);
- мягкие отказы `isSoftFailure` = `/HTTP 429|HTTP 403|HTTP 5\d\d|не изображение \(text\/html|недоступно/` → один раз возвращаются в `pending` с `tech_reason "отложено: … (повтор 1)"`, со второго раза — reject (:102-105, :515-525);
- размеры из байтов (`dimsFromBytes`: PNG/JPEG SOF/WEBP VP8X/VP8/VP8L, :107-153), иначе из провайдера; `sizeVerdict`: короткая сторона `< min(min_width, min_height)` (=550) → «мелкое»; `orientationVerdict` как в шаге 11;
- пиксельный анализ только если `width*height ≤ 8 Мп`, иначе берётся миниатюра (таймаут 10 с) (:461-471); `inspectPhotoBytes` не декодирует файлы `> 6 МБ` (`photoVision.ts:55`);
- `NEAR_DUPLICATE_DISTANCE = 8` по dHash среди уже принятых кадров статьи (:156, :381-382);
- добор: `searchImagesWithFallback(query, cfg, max(40, needed*4))` (= 80), только при `okCount < reserveTarget` или `request_topup && topups === topup_from`, и `topups < MAX_TOPUPS` (:265-342).

**Алгоритм одного кадра** (`process`, :388-529) — порядок проверок:
1. `isBlockedDomain(source_domain || host(source_page_url) || host(image_url), exclude_domains)` → «запрещённый источник (…)».
2. `catalogueSourceSignal` (`photoAuthenticity.ts`): хосты `walmartimages.com`, `media-amazon.com`, `ssl-images-amazon.com` → reject сразу; `scene7.com`, `cloudfront.net`, `shopifycdn.com` → reject при наличии пути `/product|catalog|sku|pdp|item|listing|merch|commerce/` или заголовка `shop now|buy now|price|sale|size(s)|size chart|available in|product details|item #|sku|walmart|amazon|marketplace`; путь + заголовок одновременно → reject без хоста.
3. `checkTextRelevance(rel, [title, source_page_url, image_url])` (`photoRelevance.ts:218-237`): любое запрещённое слово (`forbidden`) в заголовке/URL → reject «не та тема: «X» вместо темы статьи»; поиск — как слово, а для слов ≥5 символов и как подстрока. Отсутствие сильных слов темы → только `weak:true` (не отказ).
4. Скачивание (см. выше). Нет файла → «не изображение (…)» или «HTTP N».
5. `fingerprintBytes` = SHA-256 hex; совпадение с принятым в статье → «дубликат внутри статьи».
6. Размер → ориентация.
7. `inspectPhotoBytes(visBytes)` (`photoVision.ts:452-504`), по порядку:
   - `detectAiGeneratedBytes`: поиск строк из `AI_MARKERS` (midjourney, stable diffusion, dall-e, openai, sora, firefly, imagen, nano banana, leonardo.ai, ideogram, recraft, flux.1, c2pa, contentcredentials, digitalsourcetype, trainedalgorithmicmedia, …) в первых 512 КБ и последних 256 КБ файла → reject «создано ИИ (метка …)»;
   - декодирование (`jpeg-js`, `upng-js`, `@jsquash/webp`) в уменьшенную RGB-сетку `TARGET = 160` px по длинной стороне; поиск тонких однотонных перемычек на полном разрешении (`findThinDividers`: полоса ≤2.5 % кадра, однородность ≥0.94, края ≥0.5 перепад);
   - `isLetterbox` (2 параллельные линии, снаружи ≥90 % однотонно) → reject;
   - `dividers ≥ 1` → «коллаж: кадр разделён однотонной полосой»;
   - `findSeamLines`: линия-шов = доля точек с перепадом `>26` ≥ 0.9 вдоль всей длины в полосе 12–88 % кадра; `seams ≥ 2` или 1 шов с `frac ≥ 0.97` → «коллаж: кадр разделён на панели»;
   - `findTextBanner`: плашка = строки, где ≥45 % пикселей одного цвета и ≥4 перехода; `share ≥ 0.2 && textRatio ≥ 0.07` → «крупная надпись/баннер»; `share ≥ 0.42` → «однотонная плашка»;
   - `sharpnessScore` (дисперсия лапласиана на сетке ≤128) `< MIN_SHARPNESS = 25` → «размытое фото».
   - Возвращает `phash` (dHash 9×8 → 64 бита → 16 hex), `sharpness`, `stats {contrast 0-100, colorfulness 0-100, brightness 0-255}`.
8. `nearDuplicateOf(phash)` (≤8) → «почти такой же кадр уже есть».
9. OK → `tech_quality = techQualityScore(...)` (`photoQuality.ts:51-88`): резкость 30 (`sqrt(sharp/400)*30`), разрешение 20 (`min(longSide,1600)/1600`), пропорции 20 (`aspectFit` к 2:3), контраст 15 (`min(c,55)/55`), цвет 10 (`min(col,45)/45`), экспозиция 5 (`5 − |140 − brightness|/28`), +4 за домены `GOOD_SOURCES` (pinterest, instagram, vogue, elle, …), −8 за `WEAK_SOURCES` (amazon, aliexpress, shutterstock, …).

**Добор** (`pending` пуст, :247-342): `topupQueryFor` берёт первую неиспользованную вариацию из `workflow_stages[11].topup_queries` (при <2 вариаций или исчерпании и <6 — новый вызов `generateTopupQueries`), переводит при не-en (ещё вызов ИИ), строит запрос `buildSearchQuery`; `searchImagesWithFallback` (SerpApi→DataForSEO или наоборот, `photoSearch.ts:637-675`). Новые строки фильтруются только `isBlockedDomain` (без размеров/ориентации). Если вариации исчерпаны и ничего не добавлено → `topups := MAX_TOPUPS` (стоп). Финиш: `completed` если `okCount > 0`, иначе `failed` «После технического фильтра не осталось ни одного фото».

Ранний стоп: `okAlready ≥ reserveTarget` и нет `request_topup`/`process_pending` → `completed` с `early_stop:true`, оставшиеся pending не трогаются (:202-214).

**ИИ в этом шаге:** только `generateTopupQueries` (повторно) и `translateSearchQueries` при доборе. Промт тот же `rp_photo_search`.

### 1.3. Шаг 125 — `stage-photo-rank` («Сравнение кадров», 12.5)

**Вход.** `projects.*`, `article_queue (keyword, focus_keyword, seo_keyword, count_outfits)`, `photo_candidates` с `tech_status='ok' AND beauty_rank IS NULL`, `PER_RUN = 60` строк (:102-108). Профиль ниши — для `subjectLabel`.

**Выход.** `photo_candidates.beauty_rank` (число 25..100), `beauty_note` (до 120 символов «why»); `workflow_stages[125].output_data {ranked, tech_ok, remaining, groups, cost_usd}`; статус `running|completed|failed`. Ответ `{done, ranked, remaining}`.

**Алгоритм.**
1. Детерминированный shuffle (`seed = projectId`), группы по `GROUP_SIZE = 10` (:59-70, :222-225).
2. На каждую группу — один vision-вызов: миниатюры (`toDataUrl([thumbnail_url, image_url])`, лимит файла `MAX_INLINE_BYTES = 3 МБ`, timeout fetch 20 с, UA ZewexBot) в base64; промт `SYSTEM` (:137-152): упорядочить по Pinterest save-appeal, не судить тему; JSON `{"order":[{"n":4,"why":"…"}]}`. Модель `cfg.rating_model` (default `openrouter:google/gemini-2.5-flash-lite`), temperature 0.1, maxTokens 1024, timeout 150 с. Группы идут волнами `WAVE = 4` параллельно, пауза 400 мс.
3. Локальный балл: позиция `pos` из `n` → `95 − pos/(n−1)·70` (диапазон 95..25) (:245). Пропущенные моделью номера — в конец.
4. «Турнир чемпионов»: `CHAMPIONS_PER_GROUP = 3` лучших из каждой группы, но пул ограничен `GROUP_SIZE + 2 = 12` первыми чемпионами (:261), один дополнительный вызов; чемпионы получают `100 − pos/(n−1)·28` (100..72), все остальные — `min(score, 70)` (:265-274).
5. Запись `beauty_rank` построчно. Если за вызов ничего не записано, а неразобранные остались (`written === 0`) — всем pending ставится `beauty_rank = 50`, `beauty_note "не удалось сравнить"` (:293-302).
6. Ошибка сравнения не останавливает пайплайн (`direct-pipeline:499` только warn).

Стоимость: `ceil(tech_ok/10)` вызовов + 1 турнир на каждые 60 кадров. При `reserveTarget = 100` — ~11–13 vision-вызовов по 10 картинок до какой-либо тематической оценки.

### 1.4. Шаг 13 — `stage-photo-rate` («AI-оценка фото»)

**Вход.**
- `projects.*` (все поля), `article_queue (keyword, focus_keyword, seo_keyword, count_outfits)`.
- `photo_candidates`: `tech_status='ok' AND ai_status IN ('pending','retry')`, порядок `beauty_rank DESC NULLS LAST`, лимит `rating_batch_size × BATCHES_PER_RUN` (8×4 = 32 по умолчанию) (:372-381); счётчики `ai_verdict='keep'`, `tech_status='pending'`.
- `workflow_stages[12].output_data.topups`, `workflow_stages[13].output_data.rescue_pass/rescue_used`, `workflow_stages[11].output_data.trend_brief` (через `loadTrendBrief`, иначе встроенный `FALLBACK` по нише).
- `niche_profiles`, промт `rp_photo_rate`.

**Выход.**
- `photo_candidates`: `ai_status = done|retry`, `ai_score` (0–10; `0` если тема/аудитория не подтверждена), `ai_verdict keep|reject`, `ai_reason` (русский, ≤200), `ai_description` (≤1200), `ai_facts` (только для keep, ключи из `fact_block.photo_facts` профиля, ≤300 символов на поле), `ai_quality` (0–100), `ai_quality_breakdown {virality, trend, ai_likelihood, composition, lighting, framing, trend_reason?, catalogue, catalogue_reason?, ai_artifacts[]}` (:823-858).
- Промо/реанимация: `UPDATE … SET ai_verdict='keep', ai_reason='принято при нехватке фото (балл 6)' WHERE ai_verdict='reject' AND ai_score ≥ 6` (:408-416); второй проход: `ai_status='retry', ai_verdict=null, ai_reason=null` для «мягко» отклонённых (:448-451).
- `workflow_stages[13].output_data {kept, rejected, remaining, cost_usd, score_threshold, rescue_pass, rescue_used, fashion_contract, interior_contract | kept, needed, min_acceptable, needs_more_photos, rescue_count}`; статусы `running | completed | waiting_for_photos | failed`; `error_data {message, failure_class:"content_scarcity"}`.
- Ответ: `{done:false, kept, rejected, remaining}` после пачек; `{done:true, needs_filtering, tech_pending}`; `{done:true, needs_more_photos}`; `{done:true, waiting_for_photos, shortage_message}`; `{done:false, rescue_pass:true}`.

**Константы.**
- `BATCHES_PER_RUN = 4`, `PARALLEL_WAVE = 5` (все 4 пачки одной волной, пауза 500 мс между волнами не срабатывает), `MAX_TOPUPS = 6` (не совпадает с 10 в фильтре) (:50-51, :867).
- `neededPhotos = max(1, count_outfits || 20)`; `minAcceptable = min(needed, 15)`.
- Порог балла `scoreThreshold = cfg.min_score` (7); при `rescueActive` или `scarcity` (= `topups ≥ 6 && kept < min(needed,15)`) → `max(6, min_score − 1)` (:217-236).
- `MAX_INLINE_BYTES = 5 МБ`, fetch timeout 25 с, UA ZexexBot, порядок `[image_url, thumbnail_url]` — **оригинал**, не миниатюра (:146-173).
- Вызов модели: `callGemini({provider, model} = parseModel(cfg.rating_model), temperature 0.2, maxTokens 6144, timeoutMs 180_000, responseFormat json)` (:619-635).
- Пороги вердикта: `VIRALITY_MIN = 45`, `TREND_MIN = 40`, `clearlySynthetic = ai_likelihood ≥ 80 && ai_artifacts.length ≥ 1`, `catalogue === true`, `childInAdultTopic` (`subject_age === "child"` при взрослой теме), `hasVisualEvidence` (есть description или facts) (:755-784).
- `ai_quality` = взвешенное среднее `virality 4, trend 3, composition 2, framing 2, lighting 1` (:807-822); штраф за ИИ-вероятность ≥50: `ai_quality − (ai_likelihood − 45)·0.35` (:827-829).
- «Плоский» ответ (`isFlat`): >50 % фото с одинаковыми 4 баллами или разброс virality < 10 → один повторный вызов с CORRECTION (:664-699). Отсутствие поля `audience` у всей пачки при активном правиле аудитории → ещё один повтор (:702-718).
- Пачка не оценена (ошибка модели / пустой JSON): первый раз `ai_status='retry'`, второй — `reject, ai_score 0, "модель не оценила фото"` (:554-569). Фото, не скачавшееся → `reject "фото недоступно для скачивания"` (:586-592).

**Системный промт** (`ratingSystem`, :365-367): либо `fillVars(custom.system) + JSON_CONTRACT`, либо встроенный `ratingSystemFor(profile)` (:68-91) с `HARD_REJECT_RULES` (:53-65: коллаж, текст/вотермарка/лого, пин-графика/скриншот/рендер/ИИ, размытость/искажения, не тот предмет); затем всегда `+ TOPIC_RULES` (:352-363), включающий:
- `rel.aiConstraints` из `buildTopicRelevance` (MUST show / MUST NOT show по `exclusive_terms`, FINGERNAILS-правило, «defining elements»);
- `CONTRACT_RULES` = `topicContract.reviewRules` (длина/семейство/признаки, пол, аудитория);
- `AUDIENCE_RULES` — обязательное поле `audience` ∈ black/white/latina/east_asian/south_asian/middle_eastern/no_person/unclear; ожидаемое `audience.code`;
- `FASHION_RULES` (контракт одежды, piece/look) или `INTERIOR_RULES` (element/room/style, indoor/outdoor, запрет 3D/CGI/планов/листингов);
- повторно `HARD_REJECT_RULES`;
- `CHECKLIST` = `rel.requirements` (нумерованный чек-лист, `topic_ok`/`topic_miss`);
- при `rescueActive` — блок SECOND PASS (мягкие эстетические причины не повод для отказа).
`JSON_CONTRACT` (:271-274) задаёт формат: `n, score 1-10, verdict, topic_ok, topic_miss, catalogue, catalogue_reason, ai_likelihood, ai_artifacts, subject_age, virality, trend, trend_reason, composition, lighting, framing, reason, facts{…}, description` + CATALOGUE/SUBJECT AGE/AUTHENTICITY/QUALITY правила + `TREND_BLOCK` (с `trendBriefText` или общая формулировка).

Пользовательский текст пачки (:596-609): `ratingUser` (из набора) или `Topic: "…"`, `Required in every kept photo: <rel.strong>`, `Never keep photos showing: <rel.forbidden>`, список `n. title — domain`, затем картинки.

Переменные промта `rp_photo_rate` (`fillVars`, :244-256): `{topic}`, `{focus_keyword}`, `{niche}`, `{subniche}`, `{language}`, `{topic_kind}` (для волос: haircut/colour/style), `{subject_label}`.

**Логика вердикта** (:724-858):
```
checklistOk = requirements.length ? topic_ok !== false : true
audienceOk  = !audience || answer === audience.code || (code==="asian" && answer==="east_asian")
topicOk     = checklistOk && audienceOk
requestedKeep = topicOk && verdict==="keep" && score ≥ scoreThreshold
verdict = requestedKeep && hasVisualEvidence && !lowVirality && !dated && !catalogue && !clearlySynthetic && !childInAdultTopic ? keep : reject
ai_score = topicOk ? score : 0
```
`ai_reason` по приоритету: аудитория → чек-лист → нет фактов → каталог → ИИ-признаки → устарело → слабая виральность → `item.reason`.

**Финиш (pending пуст)** (:383-539):
1. `keep ≥ needed` → не трогаем фильтр. Иначе если `tech_pending > 0` → `{needs_filtering:true}`.
2. `kept < needed` → промо rejected с `ai_score ≥ 6` в keep (см. 7.2).
3. `keep < needed && !rescueUsed` → второй проход: до `max(gap·4, 12)` отклонённых, у которых `ai_reason` не совпадает с `HARD = /коллаж|надпис|текст|водян|watermark|ии-|ai-|сгенерирован|не соответствует теме|не та тема|педикюр|pedicure|toe|hero piece|central garment|complete outfit|wrong gender|неверн.*пол|product-only/i`, переводятся в `retry`; `rescue_pass:true` (:433-483).
4. Иначе: `needsMorePhotos = keep < needed && topups < 6`; `ok = keep ≥ minAcceptable`; статус `running` (ждём добор) / `completed` / `waiting_for_photos` + `failure_class content_scarcity`.

### 1.5. Шаг 14 — `stage-photo-select` («Отбор фото»)

**Вход.**
- `projects (id, photo_search_config, focus_keyword, topic, count_outfits, niche_code, subniche_code, keyword_attributes)`, `article_queue (id, site_id, count_outfits, keyword, focus_keyword, pipeline_mode)`.
- `photo_candidates`: `tech_status='ok' AND ai_verdict='keep'`, `ORDER BY ai_score DESC LIMIT 500` (:306-315).
- `workflow_stages[14]` (идемпотентность), `article_photos` (существующие), `article_sections` (count → очистка downstream).
- `photo_usage_fingerprints`: по `fingerprint IN (...)` других проектов и по `keyword_norm` (до 2000 строк с phash) (:388-404).
- `photo_reference_set` `status='selected'` по нише, до 60, из них 3 случайных (:526-535).
- `workflow_stages[11].trend_brief`.

**Выход.**
- `article_photos`: `DELETE` по проекту, затем upsert (`onConflict project_id,image_url`, `ignoreDuplicates:false`) строк `{position, section_number=position, image_url, storage_path, public_url, source_page_url, source_domain, caption (buildCaption), alt_text=title, file_name, width, height, fingerprint, phash, ai_score, ai_reason, description=ai_description, facts=ai_facts, search_*, reused}` (:616, :686-753); затем удаление лишних дублей по `fingerprint||image_url` (:754-771).
- Storage: `supabase.storage.from("generated-images").upload("<projectId>/real-photos/<position>-<fp12>.<ext>", bytes, {contentType, upsert:true})` → `public_url` (:655-667). Параллельно 6 загрузок, fetch timeout 30 с, без Referer/прокси.
- `photo_candidates.selected = true` для выбранных (одним UPDATE … IN).
- `photo_usage_fingerprints`: `DELETE WHERE project_id` + `INSERT` по выбранным (если `unique_mode !== "off"`) (:772-779).
- При повторном запуске с `article_sections` → каскадная очистка `article_sections, article_drafts, generated_images, outfits, workflow_stages[15,16,65,72,73,76,78]` (:370-384).
- `workflow_stages[14].output_data {selected, needed, reused, stored, fashion_contract, interior_contract, grid_pass{grid_a, grid_b, grid_final, size_a, size_b, promoted, kept_weak, dropped, skipped, cost_usd}}`; при нехватке — статус `waiting_for_photos`, `error_data {message, failure_class:"content_scarcity"}`, `output_data {selected, needed, min_acceptable, needs_more_photos:true}` (:581-594).

**Алгоритм.**
1. `needed = max(1, count_outfits || 20)`; `keywordNorm = normalizeKeyword(resolveSearchKeyword)`.
2. Идемпотентность: если шаг `completed` и `article_photos > 0` — только «ремонт» пустых `facts/description` из кандидатов и выход (:336-366).
3. `final_rank = finalPhotoRank(p)` (`photoQuality.ts:97-125`):
   - есть `beauty_rank` и `ai_quality`: `0.55·beauty + 0.2·ai_quality + 0.15·tech + 0.1·(ai_score·10)`;
   - только `beauty_rank`: `0.7·beauty + 0.2·tech + 0.1·rel`;
   - только `ai_quality`: `0.7·ai_quality + 0.2·tech + 0.1·rel` (это формула из `virality-scoring.md`);
   - ничего: `0.25·tech + 0.1·rel` (штраф, максимум ~35); `tech` по умолчанию 50.
4. Уникальность между сайтами: `usedCount/usedOldest/sameSite` по точному `fingerprint` и по `phash` (расстояние ≤ `NEAR_DUPLICATE_DISTANCE = 10`) среди записей с тем же `keyword_norm` (:406-445). Группы: `fresh` (не использованы), `reused` (использованы на других сайтах, сортировка: реже → давнее → ранг), `sameSiteReused` (на этом же сайте — только `soft|off`).
5. `takeDistinct` (:487-504): не берём кадр, если `phash` ≤10 к уже взятому или совпадают ≥3 известных осей `diversity_axes` (`photoTraits`).
6. `orderedPool = fresh + (unique_mode !== strict ? reused) + (soft|off ? sameSiteReused)`; `listA = takeDistinct(orderedPool, min(45, max(GRID_SIZE=30, needed)))`, `listB` = следующие до `GRID_SIZE` (:515-523).
7. `gridPass` (:152-245) — три vision-вызова (`gridAsk`: миниатюры ≤3 МБ, fetch 10 с, модель `cfg.rating_model`, temperature 0.1, maxTokens 1500, timeout 120 с), с 3 эталонами (`photo_reference_set`) как «REFERENCE QUALITY BAR» и `TREND BRIEF`:
   - A: из `listA` выбрать `dropCount = min(floor(|A|/2), max(|A|−needed, |B| ? ceil(|A|·0.2) : 0))` самых слабых (`{"drop":[…]}`); пустой ответ → одна повторная попытка через 3 с;
   - B: из `listB` выбрать `k = min(|B|, |weak|)` сильнейших (`{"pick":[…]}`);
   - final: упорядочить `weak ∪ strong` (`{"order":[…]}`);
   - результат — только приоритеты (`priority` Map), число фото не меняется; `fresh/reused/sameSiteReused` пересортировываются по приоритету (:540-548).
8. `chosen = takeDistinct(fresh, needed)` → добор из `reused` (не strict) → добивка «менее строго» из общего списка (:550-566).
9. `MIN_PUBLISHABLE_PHOTOS = 15`, `minAcceptable = min(needed, 15)`; если `chosen < minAcceptable` и не (`pipeline_mode === 2` и `chosen > 0`) → `waiting_for_photos` (:570-607).
10. `orderPhotosForVariety(chosen, topic, profile)` (`photoDiversity.ts:139-192`): жадная раскладка — штраф `w` за совпадение оси с предыдущим, `0.6·w` с пред-предыдущим, `−0.02·ai_score`; оси, заданные темой, обнуляются; затем `spreadSimilarPhotos` (топ-5 фиксированы, похожие по phash ≤10 сдвигаются) (:36-56).
11. Скачивание в storage, запись `article_photos`, отпечатки, статус `completed`.

**ИИ:** 3 vision-вызова (A/B/final) + возможный повтор A. Промты встроены в код (`aSystem`, B, final, :172-216); `stage_key` у шага нет.

### 1.6. Ручная модерация (`photo-review-action`) — для полноты статусов

- `MIN_PHOTOS = 15` (:11); `approve` требует `≥15` и у каждого фото `facts || description` (:230-235 в файле, смещение +99 от вывода).
- `add` кандидата: скачивание с 2 UA (Chrome 126 / ZewexBot), `Referer = source_page_url` (кроме gstatic/weserv), затем прокси `https://images.weserv.nl/?url=…&output=jpg`; общий бюджет 45 с, per-fetch ≤12 с; файл <2000 байт отбрасывается; при отсутствии `ai_description/ai_facts` — `describePhoto` (`photoDescribe.ts`: openrouter, maxTokens 800, timeout 60 с, 2 попытки, ≥8 слов и непустые facts).
- `topup`: `article_queue.status='pending'`, курсор `{current_invocation:1, rp_resume_filter:true, photo_topup_after_rating:true, photo_review_topup:true}`, `workflow_stages[12,13].status='pending'`.
- `mark_insufficient`: `status='insufficient_photos'` (только из `photo_review`).

---

## 2. Внешние API

### 2.1. DataForSEO (`photoSearch.ts:502-610`)
- Endpoint: `POST https://api.dataforseo.com/v3/serp/google/images/live/advanced`, Basic-auth `login:password` из `integrations.config` (service `dataforseo`, `is_active`, минимальный `priority`). Env-переменных для DFS нет.
- Тело: `[{ keyword: query, location_code: DFS_LOCATIONS[country] || 2840 (US), language_code: lang[0..2], depth: min(700, max(100, limit)), search_param: "tbs=<buildTbs>" }]`. `DFS_LOCATIONS`: US 2840, GB 2826, AU 2036, CA 2124, DE 2276, FR 2250, ES 2724, IT 2380, NL 2528, PL 2616, BR 2076, IN 2356, UA 2804, RU 2643 (остальные страны → US!).
- `buildTbs` (:237-250): `iar:t|w|s` только при одной ориентации, `itp:photo`, `sur:fmc` (commercial), `qdr:y|m|w`; размер в tbs не передаётся.
- Таймаут одного запроса `AbortSignal.timeout(120_000)`. **Опроса (polling) нет** — это live-endpoint, один POST. «5 попыток, rescue-запрос, таймауты 90 с» из `MIGRATION.md §6.3` в коде отсутствуют (документация устарела/описывает другую версию).
- Разбор ответа: `tasks[0].result[0].items`, берутся `type === "images_search"` (или любой с `source_url/image_url/url`); `image_url := r.source_url || r.image_url || r.url`; `thumbnail_url := r.encoded_url` (gstatic encrypted-tbn); `source_page_url := r.source_url`; `source_domain := host(r.source_url) || r.domain`; `title := r.title || r.alt`; `width/height = null`.
  По документации DataForSEO: `url` — страница, где размещена картинка; `source_url` — прямой URL файла; `encoded_url` — кеш Google (gstatic). Т.е. **`source_page_url` и `source_domain` заполняются URL/хостом файла картинки, а поле `url` (страница) не используется вовсе** (см. 7.4).
- Учёт расхода: `logDataForSeo` → `generations_log` (`api_service "dataforseo"`, `api_endpoint "serp/google/images/live/advanced"`, `model_used "google-images"`, `cost_usd = DATAFORSEO_COST_PER_REQUEST = 0.004` если `tasks[0].cost !== 0`, иначе 0; реальное `cost` из ответа не сохраняется). По документации `site:`-операторы умножают цену ×5, depth > 100 тарифицируется дополнительно; максимум depth = 200 (в коде допускается до 700).
- Ошибки: `!resp.ok` → `"DataForSEO HTTP N"`; `tasks[0].status_code ≥ 40000` → `status_message` в лог (но items всё равно возвращаются).

### 2.2. SerpApi (резерв / основной при `source=serpapi|both`) (`photoSearch.ts:385-500`)
- Ключ: `integrations.encrypted_api_key` (service `serpapi`) или env `SERPAPI_API_KEY`.
- `GET https://serpapi.com/search.json?engine=google_images&q=…&gl=<cc>&hl=<lang>&ijn=<page>&tbs=…`, до 3 страниц (`ijn 0..2`), по 100 результатов, пока `items < limit`; таймаут 60 с на страницу. Поля: `original || thumbnail → image_url`, `thumbnail`, `link || source → source_page_url`, `original_width/height → width/height`, `title`.
- `searchSerpApiEngine` (bing_images / yahoo_images / duckduckgo) — **экспортируется, но не вызывается** ни одним шагом (мёртвый код; комментарий шапки фильтра про Bing/Yahoo/DDG устарел).
- `searchImagesWithFallback` (:637-675): при `source !== dataforseo` сначала SerpApi, пусто/ошибка → DataForSEO; при `source === dataforseo` сначала DFS, пусто → SerpApi.

### 2.3. Скачивание изображений
| Где | URL-порядок | UA | Referer | Прокси | Таймаут | Лимит |
|---|---|---|---|---|---|---|
| filter | image_url → thumbnail_url | `Mozilla/5.0 (compatible; ZewexBot/1.0)` | нет | нет | 20 с ×2 попытки (429/5xx) | без лимита байт; декод ≤6 МБ, >8 Мп — миниатюра |
| rank | thumbnail_url → image_url | ZewexBot | нет | нет | 20 с | 3 МБ |
| rate | image_url → thumbnail_url | ZewexBot | нет | нет | 25 с | 5 МБ |
| select (grid) | thumbnail_url → image_url | ZewexBot | нет | нет | 10 с | 3 МБ |
| select (storage) | image_url → thumbnail_url | ZewexBot | нет | нет | 30 с | без лимита |
| photo-review-action add | image_url, thumbnail_url × 2 UA, затем weserv.nl | Chrome 126 / ZewexBot | `source_page_url` (кроме gstatic/weserv) | `images.weserv.nl` | ≤12 с, бюджет 45 с | ≥2000 байт |

Один и тот же файл скачивается **до 4 раз** (filter, rank, rate, select) без локального кеша.

### 2.4. Perceptual hash (`photoVision.ts:347-392`)
- Собственная реализация, без библиотек: картинка декодируется (`jpeg-js@0.4.4`, `upng-js@2.1.0`, `@jsquash/webp@1.5.0`) → RGB-сетка ≤160 px → `grayGrid` 9×8 (яркость `0.299R+0.587G+0.114B`) → dHash: бит = `g[x] < g[x+1]` по строкам → 64 бита → 16 hex.
- `phashDistance` — Хэмминг по hex-символам (0..64). Пороги: 8 (filter, внутри статьи), 10 (select: внутри статьи и между сайтами по `keyword_norm`).
- Файловый отпечаток — SHA-256 (`fingerprintBytes`, `crypto.subtle`).

---

## 3. Контракты темы и профиль ниши

### 3.1. `nicheProfile.ts` — `NicheProfile`
```
niche_code, label,
attributes[]        { key, label, values?, fallback? }    — что извлекать из ключа (parse-keyword-ai)
required_visuals[]  { label, values: {value: [words]} }   — словари признаков (длина, форма, цвет…)
exclusive_terms[]   { scope?: regexp, variants: [[words]…] } — взаимоисключающие группы
diversity_axes[]    { key, weight, values }               — оси раскладки
search_templates    { primary?: [], topup?: [], negative?: [] }
constraint_specs    { source: "nailSpecs" | "cutSpecs" }  — только метка, в фото-цепочке не читается
concept_fields[]
fact_block          { fields[], note?, subject_label?, photo_facts?: {key: описание} }
```
Встроенные профили `DEFAULT_NICHE_PROFILES` (:732-760): `nails`, `manicure`, `pedicure` (копии nails), `hair`, `outfits`, `interior`, `decor`, `outdoor` (копии interior с другими topup/negative), `tattoo`, `makeup`, `blog`. Все `primary = ["{keyword}"]`.

**Загрузка и приоритет** (`loadNicheProfile`, :798-826): база = `defaultProfile(niche, subniche)` (подниша → ниша → `nails`); из таблицы `niche_profiles` читаются строки `niche_code IN (subniche, niche)` с `is_active`; берётся первая найденная (подниша важнее); `mergeProfile` — поле из таблицы **перекрывает код, только если непустое** (непустой массив/объект/строка). Кеш в памяти процесса на весь срок жизни функции (`cache` Map) — изменения таблицы подхватываются после холодного старта. `db/data_niche_profiles.sql` содержит 8 строк (nails, manicure, pedicure, hair, outfits, tattoo, makeup, blog; **interior/decor/outdoor только в коде**). `seed-niche-profiles` заливает `DEFAULT_NICHE_PROFILES` (без `overwrite` — только отсутствующие). Итого: главнее таблица, но только по заполненным полям; пустое поле в таблице = значение из кода.

`specializeProfile` (:961-1033) — только для `hair`: по `hairTopicKind` (cut/colour/style, подсчёт слов `HAIR_CUT_WORDS/COLOUR/STYLE`) меняет `required_visuals`, веса осей, `topup`-шаблоны, `fact_block.subject_label` (например «the haircut — shape, length, layers and bangs»).

Хелперы для промтов: `photoFactFields` (строка `"key": описание`), `photoFactSkeleton` (`"key":""`), `subjectLabel` (default «the subject of the topic»), `topicKindLabel`.

**Где используется в цепочке.**
- Шаг 11/12: `search_templates.primary/topup/negative` (запросы), `exclusive_terms`/`required_visuals` через `buildTopicRelevance` (текстовый фильтр), `fact_block` нет.
- Шаг 125: `subject_label`.
- Шаг 13: `required_visuals`+`exclusive_terms` → `buildTopicRelevance` (чек-лист, aiConstraints) и `buildTopicContract` (reviewRules); `fact_block.photo_facts` → поля `facts`; `subject_label`; `topicKindLabel`.
- Шаг 14: `diversity_axes` (`photoTraits`, `takeDistinct`, `orderPhotosForVariety`).

### 3.2. `photoRelevance.ts` — `TopicRelevance` (бесплатная релевантность)
`buildTopicRelevance(keyword, niche, profile)` → `{tokens, strong, forbidden, aiConstraints, requirements}`:
- `tokens` = слова ключа ≥3 символов без `STOPWORDS` (служебные, «best/top/ideas/photos…», годы 2024–2030);
- `strong` = tokens минус общие слова ниши (`nails nail hair interior outfit outfits room tattoo makeup` + сама ниша) минус слова аудитории;
- `forbidden` = все слова других вариантов тех `exclusive_terms`-групп, где один вариант совпал с темой (scope-regexp проверяется по `keyword + niche`); для ногтевых тем без слов о ногах — вся группа «toenail/pedicure/feet…»;
- `requirements` (чек-лист для ИИ): по каждому `required_visuals`-словарю «`label` is `value` (reject others)», по группам «subject is X (reject …)», сезоны — мягко (`SEASON_HINTS`, по одежде), абстрактные слова (`ABSTRACT_TOKENS`: work, office, wedding, women, plus, petite…) — «styling plausibly suits», остальные мотивы — «the "X" element is clearly visible»; правило аудитории — первым пунктом.
`checkTextRelevance(rel, parts)` — применяется только в фильтре по `title/source_page_url/image_url`.

### 3.3. `topicContract.ts` — `TopicContract` (единые «замки»)
`buildTopicContract(profile, keyword_attributes, topicText)`:
- из `topicText` вырезаются слова аудитории; haystack = тема + строковые значения `keyword_attributes` (кроме `none`);
- `hair`: семейство из `HAIR_FAMILIES` (pixie, bob, lob, shag, mullet, wolf cut, buzz, butterfly cut) — правило `cut family` с запретом остальных семейств;
- по каждому `required_visuals`-словарю `ruleFromDict`: ровно одно совпавшее значение → `allow` = его слова (+ соседи для шкал `SCALE_LABELS = length, nail length, size, hair length` по `SCALE_ORDER`), `forbid` = слова остальных значений через `refineForbid` (`FORBID_PHRASES`: `long → "long hair", "long nails", …`, `medium → "medium length", …`, `short → "short hair", …`); цветовые словари (`colour|color|palette`) — без `forbid`, `required=false`;
- `exclusive_terms` → правила `subject` (или `season (soft)` без forbid), если не дублируют уже построенные;
- дедупликация по `label`; `primary = family || length || first`;
- `promptBlock` («TOPIC RELEVANCE CONTRACT …» + строки пола `genderRule`, возраста `ageRule` (кроме interior/decor/home/garden), аудитории);
- `reviewRules[]` — правила авто-отказа для шага 13: по правилам с `forbid` (`wrong_haircut` / `wrong_length` / `off_topic`), + пол (`wrong_gender`), + аудитория (`wrong_audience`).
`contractViolation/contractMissing/contractLocks` — используются другими этапами (идеи/промты/parse-keyword), в фото-цепочке нет.

### 3.4. `fashionContract.ts` — `FashionContract` (ниша `outfits`)
`buildFashionContract(keyword, attrs)`: `hero_piece` = `attrs.keyword_hero_piece` или первое совпадение из `PIECES` (jeans, shoes, dress, skirt, trousers, shorts, blazer, suit, coat, jacket, top, sweater, jumpsuit, bag, accessory); `outfit_mode` = `attrs.outfit_mode` или `piece` если есть hero, иначе `look`; `audience` = `keyword_age || keyword_body_type || ("children" если `isChildIntent`, иначе "adult women")`; `occasion/season/style/silhouette/palette/body_context` из attrs; `hard_requirements[]`: hero/complete look, audience, «adults only» (если не детская тема), occasion, запрет special-occasion (wedding/prom/gala/maternity/costume), «real person wears the look; listings off-topic», season (мягко), style, silhouette, palette.
Используется: шаг 11 (в промт генерации запросов + `output_data`), шаг 13 (`FASHION_RULES` с HARD REJECT), шаг 14 (только пишется в `output_data`).

### 3.5. `interiorContract.ts` — `InteriorContract` (ниши `interior|decor|outdoor`)
`buildInteriorContract(keyword, attrs)`: `decor_mode` element/room/style (по `ELEMENTS` ~37 регэкспов, `ROOMS` ~20 с признаком indoor/outdoor, иначе style); `setting` indoor/outdoor/any (attrs `keyword_setting_type` → комната → `OUTDOOR_HINT`/`INDOOR_HINT`); `style` (`STYLES`), `season` (`SEASONS`), `palette` (`COLOURS`), `materials`, `size`, `occasion`, `budget`; `hard_requirements[]` аналогично fashion + «Real photography only: no 3D render…».
Используется: шаг 11 (запросы, в т.ч. принудительное outdoor-слово), шаг 13 (`INTERIOR_RULES`), шаг 14 (`output_data`).

### 3.6. `cutSpecs.ts` и `nailSpecs.ts`
Таблицы физических спецификаций (`CUT_FAMILY_SPECS` — максимальные длины в дюймах, forbidden_visuals, visual_test; `NAIL_FAMILY_SPECS` — формы ногтей, допустимые длины; `classifyCutFamily`, `classifyNailShape`, `detectNailSurface`, валидаторы промтов). **В фото-цепочке (11–14) не импортируются** — используются `parse-keyword-ai`, `outfit-concepts`, `stage5-nanobanana-edit`, `stage65-build-blueprint`, `stage7-write-sections`. В профиле ниши на них ссылается только строка `constraint_specs.source`. Для порта real_photo-цепочки не нужны.

---

## 4. Audience intent / пол / возраст

### 4.1. `audienceIntent.ts`
- `AMBIGUOUS` — замены двусмысленных выражений перед определением аудитории: `baby <colour> → "pastel colour"`, `baby's breath`, `baby doll`, `babylights`, `baby hairs/bangs/braids/curls`, `baby french/boomer/nails/tips`, `baby face/skin/glow`, `baby tattoo`, `baby tee`, `mom jeans`, `boyfriend/girlfriend jeans…`, `dad sneakers/shoes/hat…`, `grandpa/grandma sweater…`, `boy cut/pixie/bob/brows`, `schoolgirl`, `princess/mermaid dress/hair/nails…`, испанские `azul bebé → azul cielo`, `rosa bebé → rosa pastel`.
- `CHILD_WORDS` = `baby|babies|infant|newborn|toddler|kid|kids|child|children|boy|boys|girl|girls|teen|teens|nursery|bebé|niña|niño|infantil` → `isChildIntent`; `ageRule` = «AGE: this topic is for ADULTS…» если не детская тема.
- Используется: шаг 13 (`adultTopic` → `childInAdultTopic`), `fashionContract` (аудитория children), `topicContract` (ageLine).

### 4.2. `photoGender.ts`
- `MALE_WORDS` (men, man, male, boy, guy, gentleman, barber, beard, husband, groom, dad, father…), `FEMALE_WORDS` (women, woman, female, girl, lady, bride, mom, mother, wife, feminine), `UNISEX_WORDS` (unisex, couple, family, kids, children, baby, toddler, his and hers, matching).
- `genderRule`: unisex или оба → `any`; только male → `male` («reject any woman/girl, even next to the man»); **иначе (по умолчанию) `female`** — «reject the photo if ANY man or boy is clearly visible… children also rejected». Попадает в промт шага 13 через `topicContract.reviewRules` (`wrong_gender`) и в запросы шага 11 (`keepAudience` добавляет `women`/`men`).

### 4.3. `photoAudience.ts`
- `DEFS` (порядок проверки): `black` (black, african american, afro, melanin, dark/brown skin, ebony), `latina` (latina/o, hispanic, chicana, mexican), `asian` (asian, korean, japanese, chinese, k-beauty) — ожидаемый ответ модели `east_asian`, `south_asian` (indian, desi, pakistani, south asian, bollywood), `middle_eastern` (arab, middle eastern, hijabi, khaleeji, turkish, persian), `white` (white, caucasian, scandinavian, nordic, pale/fair skin).
- Для `black`/`white` (`COLOUR_ONLY`) требуется слово о человеке в теме (`PERSON_WORDS`, куда входят и `nails, hair, outfits, style, fashion, hairstyles`) **и** непосредственная близость: `black (\w+ )?(women|girls|ladies|men|models|people|teens|queens|brides|moms|skin|hair|beauty|hairstyles|haircuts)`.
- Правило отклонения в шаге 13: модель обязана вернуть `audience`; любое значение кроме ожидаемого (включая `no_person` и `unclear`) → `reject`, `ai_score 0`, `ai_reason "не та аудитория: …"`. При отсутствии поля у всей пачки — один повторный запрос.
- В `photoRelevance`/`topicContract` слова аудитории (`tokens`) исключаются из признаков предмета («black women» ≠ чёрный цвет).

---

## 5. Статусы

| Статус `article_queue` / `workflow_stages` | Когда |
|---|---|
| `workflow_stages[13].status = waiting_for_photos` | rate: pending пуст, `keep < min(needed,15)`, доборы исчерпаны (`topups ≥ 6`), второй проход уже был (`stage-photo-rate:497-522`) |
| `workflow_stages[14].status = waiting_for_photos` | select: `chosen < min(needed, 15)` и не (`pipeline_mode=2` и `chosen>0`) (`stage-photo-select:575-594`) |
| `article_queue.status = waiting_for_photos` | `direct-pipeline.waitForPhotos` (:1255-1271): по сигналам rate/select, по зацикливанию фильтр↔оценка (>6 кругов), по исчерпанию кругов добора (>7) при `kept < min_acceptable`, по `selectCycles > 7`/`topups ≥ 6` при нехватке на отборе. `error_message "Ожидает фото: …"`, `pipeline_cursor {current_invocation: 1|2, photo_shortage}`. Автоматически **не возобновляется** — только из UI (`ArticleQueuePanel.handleRetry`: для `waiting_for_photos` на этапах 13–14 откат на этап 12) или `photo-review-action topup`. |
| `article_queue.status = photo_review` | `pipeline_mode === 2`: после успешного отбора (`sendToPhotoReview`, :594-596), а также вместо `waiting_for_photos` на этапах ≥13 (:1257-1259) — «Мало фото: …». `current_stage = 14`, `pipeline_cursor.photo_review_approved = null`. |
| `article_queue.status = insufficient_photos` | только вручную/ИИ-модерацией: `photo-review-action mark_insufficient` из `photo_review`; `ai-photo-moderate` (шаг 140). Статья не пишется, оркестратор считает её «будущей работой» (не idle). |

**Правило «≥15 фото».** Константа 15 задана трижды: `stage-photo-rate:428` (`minAcceptable = min(needed, 15)`), `stage-photo-select:570-571` (`MIN_PUBLISHABLE_PHOTOS = 15`), `photo-review-action:11` (`MIN_PHOTOS = 15`); в `stage-photo-filter:191` вычисляется, но не используется. Смысл: при `count_outfits ≥ 15` статья идёт дальше с 15+ одобренными кадрами, даже если заказано 20/25; при `count_outfits < 15` порог = `count_outfits`. В режиме 2 отбор сохраняет и <15 (человек доберёт), а `approve` всё равно требует ≥15.

---

## 6. Зависимости от Supabase — список для замены

1. Клиент `npm:@supabase/supabase-js@2` с `SUPABASE_SERVICE_ROLE_KEY` во всех пяти функциях — заменить на Prisma/прямые запросы.
2. `Deno.serve` + HTTP-вызовы между функциями (`direct-pipeline.callFn` → `/functions/v1/<name>`) с таймаутами 240–300 с и ограничением «30 пачек за вызов» — в воркере становятся обычными функциями в одном процессе; цикл «одна пачка — один HTTP-вызов» (BATCH=4, 32 фото на вызов, 60 на ранг) можно убрать, оставив чекпоинты в БД.
3. Storage: `supabase.storage.from("generated-images").upload(...)/getPublicUrl(...)/remove(...)` в `stage-photo-select:658-667`, `photo-review-action` (пути `<projectId>/real-photos/<position>-<fp12>.<ext>` и `m-<ts>-<fp12>.<ext>`). Render API (`/storage/v1/render/image/...`) в этих пяти шагах **не используется** (только в публикации, `compressImage.ts`). Заменить на файловое хранилище (`storage/...`, отдача nginx `/files/`).
4. RPC: `acquire_service_slot(p_service, p_holder, p_limit, p_ttl_seconds)`, `release_service_slot` (таблица `service_leases`) — лимит 6 параллельных поисков; `merge_pipeline_cursor` (jsonb-merge в `article_queue.pipeline_cursor`); `can_access_site` (модерация); SQL-функция `cleanup_photo_data` (чистка кандидатов старше 3 дней у завершённых статей, отпечатков старше 30 дней).
5. PostgREST-специфика: `upsert(..., {onConflict, ignoreDuplicates})`, `.select("id", {count:"exact", head:true})`, `.order(..., {nullsFirst})`, `.is("x", null)`, `.in(...)`, jsonb-поля `output_data`, `ai_facts`, `ai_quality_breakdown`, `keyword_attributes`, `photo_search_config`, `pipeline_cursor`, `stage_models`, `stage_prompt_ids` — в MariaDB JSON-колонки + явные уникальные индексы `(project_id, image_url)` на кандидатах и фото статьи, `(project_id, fingerprint)`.
6. Таблицы конфигурации: `integrations` (ключи SerpApi/DataForSEO с `encrypted_api_key`/`config.login/password`) → в zewex-tools это `ApiKey`/слоты (`runSlot`), `niche_profiles`, `prompts`/`prompt_sets` (`loadStagePrompt`, `stageModel`, `stageSubModel` из `promptSet.ts`), `photo_reference_set`, `generations_log` (расход ИИ и DataForSEO).
7. `callGemini` (`aiProvider.ts`) — цепочка провайдеров openrouter → laozhang → poyo → lovable_gateway, multimodal `image_url` с data-URL, `responseFormat json`, учёт стоимости → заменить на адаптер проекта (`src/lib/adapters.ts`/`run.ts`); Lovable gateway убрать.
8. Deno-специфика: `Deno.env.get`, `AbortSignal.timeout`, `btoa`+`String.fromCharCode` для base64 (в Node — `Buffer.toString("base64")`), `crypto.subtle` (есть в Node), динамические `import("npm:jpeg-js")` и др. → `sharp`.
9. Оркестрация статусов `article_queue` (`pending/running/photo_review/waiting_for_photos/insufficient_photos`), `workflow_stages`, `pipeline_cursor` (флаги `rp_resume_filter`, `photo_topup_after_rating`, `photo_filter_cycles`, `photo_more_cycles`, `photo_select_cycles`, `photo_review_approved`) и pg_cron → очередь `PinJob`-подобная в воркере.
10. Внешнее: `images.weserv.nl` как прокси скачивания (только в модерации) — можно оставить или заменить на собственный fetch с Referer.

---

## 7. Слабые места (по коду)

**7.1. `retry:true` от поиска трактуется как успех** — `stage-photo-search/index.ts:47-54` при занятых слотах возвращает `{success:false, retry:true}` с HTTP 200 без поля `error`; `direct-pipeline/index.ts:448-449` проверяет только `s11?.error`, затем идёт в фильтр. Кандидатов нет → фильтр сразу уходит в добор по вариации ключа (`stage-photo-filter:272-276`), основной запрос по ключу не выполняется никогда, а один из 10 доборов сгорает. Под нагрузкой (>6 параллельных статей) это штатный сценарий.

**7.2. Промо отклонённых по `ai_score ≥ 6` игнорирует причину отказа** — `stage-photo-rate/index.ts:405-416`: при `kept < needed` все `reject` с `ai_score ≥ 6` становятся `keep`. Но `ai_score = topicOk ? score : 0` (:825), т.е. у кадров, отклонённых за каталог, явные ИИ-признаки, детей во взрослой теме, устаревший стиль или низкую виральность, балл сохраняется (часто 7–9) — они попадают в статью с `ai_reason "принято при нехватке фото (балл 6)"`. Это противоречит `catalogue-and-ai-filtering.md` («явно синтетические отклоняются»). Нужен фильтр по причине или отдельный флаг «мягкий отказ».

**7.3. Правило аудитории срабатывает на цвет волос и на страны-стили** — `photoAudience.ts:80-104`: `nearPerson` включает `hair`, `hairstyles`, `haircuts`, `beauty`, `skin` → тема «black hair color ideas» / «white hair» (платина) получает `audience = black/white`, и шаг 13 отклоняет всех моделей другой этничности. Регэксп `asian` ловит `korean|japanese|chinese`, `latina` — `mexican`: темы «korean nails», «japanese nail art», «mexican nail designs» требуют East Asian/Latina **человека в кадре**, а любое `no_person`/`unclear` = reject (`stage-photo-rate:737-742`) — для ногтевых макро-кадров это отклонение практически всего пула. `PERSON_WORDS` для `COLOUR_ONLY` тоже слишком широк (включает `nails`, `outfits`, `style`), но спасает `nearPerson`.

**7.4. DataForSEO: страница-источник подменяется URL файла** — `photoSearch.ts:584-596`: `image_url` и `source_page_url` оба берутся из `r.source_url` (по документации DFS — прямой URL картинки), поле `r.url` (страница) не читается, `source_domain = host(source_url)` (хост CDN картинки). Следствия: подпись `domain_link` ведёт на файл, а не на пост; `isBlockedDomain`/`catalogueSourceSignal`/`techQualityScore` смотрят на домен CDN (`i.pinimg.com`, `cdn.shopify.com`), а не издателя; `checkTextRelevance` теряет текст URL страницы; `Referer` в модерации равен URL картинки. При порте проверить на живом ответе и использовать `url` → `source_page_url`, `source_url` → `image_url`, `encoded_url` → `thumbnail_url`.

**7.5. Расходы на vision до тематической оценки** — порядок 125 → 13 означает, что `stage-photo-rank` сравнивает **весь** технически годный пул (`reserveTarget = needed·5 = 100` кадров → ~11–13 вызовов по 10 картинок, `stage-photo-filter:193`, `stage-photo-rank:25-27`), хотя по комментарию в фильтре ИИ оставляет ~30 %. Затем шаг 13 отправляет **оригиналы до 5 МБ** (`stage-photo-rate:146-173`) вместо миниатюр, а шаг 14 ещё до трёх сеток по 30–45 картинок. Плюс каждый файл скачивается до 4 раз (filter/rank/rate/select) без кеша. Для порта: качать один раз в фильтре, хранить уменьшенную копию (sharp, ≤1024 px) и подавать её во все ИИ-вызовы; ранжировать только `keep`.

**7.6. Второй проход (rescue) пересматривает «жёсткие» отказы и наказывает за сбой модели** — `stage-photo-rate:435-447`: регэксп `HARD` не содержит «не та аудитория», «каталожн», «признаки ИИ» (в коде `ии-` с дефисом, причина пишется как «признаки ИИ (80/100)»), «устаревший стиль», «нет проверенных визуальных фактов» → все эти кадры отправляются на платную переоценку, хотя промт SECOND PASS сам говорит, что аудитория/ИИ — жёсткие правила. При этом `ai_status='retry'` используется как маркер второго прохода, а `markBatchFailure` (:554-569) при любой ошибке модели переводит `retry` сразу в `reject` — одна сетевая ошибка в rescue-проходе = окончательный отказ всей пачки.

**7.7. Разные лимиты доборов в трёх местах** — `stage-photo-filter:40` `MAX_TOPUPS = 10`, `stage-photo-rate:51` `MAX_TOPUPS = 6` (и `scarcity`), `direct-pipeline:574` `topups < 6`. Фильтр может сделать 10 доборов до оценки (по $0.004 + перевод + генерация вариаций), а оценка/отбор перестают просить добор после 6. Комментарии в фильтре («два добора», «не больше 3») не соответствуют коду.

**7.8. Кеш поиска берёт чужих кандидатов без учёта качества и контекста** — `stage-photo-search:147-167`: совпадение только по `search_query`, игнорируются `tech_status`/`ai_verdict` чужих строк (в кеш попадают уже отбракованные), `search_geo/language` (один и тот же английский запрос с другим `gl`), порядок не задан (`limit` без `order`). Экономия $0.004, цена — повторная проверка заведомо негодных ссылок.

**7.9. Модель шага 13/125/14 берётся не из набора промтов** — `stage-photo-rate:550`, `stage-photo-rank:134`, `stage-photo-select:94-97` используют `cfg.rating_model` из `photo_search_config` сценария (default `openrouter:google/gemini-2.5-flash-lite`); `custom.model` из `loadStagePrompt` и `stage_models["rp_photo_rate"]` не читаются. В `PROMPTS.md`/`data_prompts.sql` для `rp_photo_rate` указан `google/gemini-3-flash-preview` — он не применяется. Расхождение с `MIGRATION.md §6.1`.

**7.10. Расхождения документации с кодом**
- `MIGRATION.md §6.3`: «опрос DataForSEO 5 попыток, rescue-запрос, таймауты 90 с, приоритет gstatic, обогащение постоянными URL» — в `photoSearch.ts` live-endpoint, один POST, таймаут 120 с, никакого опроса; «добор по другому гео — один доп. запрос» — `nextGeo`/`GEO_FALLBACKS` (`photoSearch.ts:351-383`) экспортируются, но никем не вызываются (мёртвый код). Шапка `stage-photo-search:1-2` называет SerpApi основным, default `source = "dataforseo"`.
- `virality-scoring.md`: `ai_quality` = virality 4 / composition 2 / framing 2 / lighting 1 — в коде добавлен `trend 3` (`stage-photo-rate:807-813`); `finalPhotoRank = 0.7/0.2/0.1` — в коде основная ветка `0.55·beauty_rank + 0.2·ai_quality + 0.15·tech + 0.1·rel` (`photoQuality.ts:114-116`).
- `stage-photo-filter:1-6` обещает добор из Bing/Yahoo/DDG — `searchSerpApiEngine` не вызывается.
- `GOOD_SOURCES` в `photoQuality.ts:23-27` содержит `pinterest`, который `BLOCKED_ROOTS` отбраковывает ещё в поиске — бонус недостижим.

**7.11. Шкала «крайние значения» в контракте работает не так, как описано** — `topicContract.ts:154-160`: `if (idx <= 1)` и `if (idx >= ordered.length − 2)`. Для словаря из 3 значений (`nails.length`: short/medium/long) `medium` (idx=1) удовлетворяет обоим условиям → разрешены и short, и long, `forbid` пуст — замок на длину исчезает. Для 4 значений (`hair.length`) `medium` (idx=2) разрешает `long`. Задумано было только для реальных крайних значений (idx 0 и last).

**7.12. Пол «по умолчанию женщины» применяется к интерьеру и тату** — `topicContract.ts:284-313` добавляет `GENDER: this topic is about WOMEN… reject if ANY man visible` в `reviewRules` для любой ниши без мужских слов (возраст для interior исключён, пол — нет). Для интерьерных тем это шум в промте и редкие ложные отказы; для тату («forearm tattoo ideas») — отказ всех мужских рук. Если это сознательное решение владельца — зафиксировать в настройках ниши.

**7.13. Текстовый фильтр одежды отбрасывает смешанные образы** — `nicheProfile.ts` (OUTFITS `exclusive_terms`): варианты `["dress"],["skirt"],["jeans","denim"],["shorts"],["suit"],["jumpsuit"]` взаимоисключающие; `checkTextRelevance` ищет запрещённые слова ≥5 символов как подстроки в title+URL (`photoRelevance.ts:222-226`). Тема «summer dress outfits» → заголовок «summer dress with denim jacket» → reject «не та тема: denim». Для одежды это обычное сочетание; теряются кандидаты до любой визуальной проверки.

**7.14. `girls` = дети** — `audienceIntent.ts:44` `CHILD_WORDS` включает `girl|girls`; `fashionContract.ts:39-40` → `audience: "children"`, требование «styling must suit children», `adultTopic=false`. Темы вида «girls night out outfits», «girls trip outfits» получают детский контракт и отклоняют взрослых моделей.

**7.15. Непоследовательность рангов между запусками шага 125** — `stage-photo-rank:259-274`: турнир чемпионов сшивает только группы одного вызова (≤60 кадров), остальные режутся до 70; кадры следующего вызова (61–100) получают локальные 25..95 без сравнения с первыми → второй запуск может дать 95 «слабой» пачке, а чемпионы первого ограничены 70 (кроме 12 в турнире). Также `champions.slice(0, 12)` обрезает чемпионов 5-й и 6-й групп.

**7.16. Мелочи**
- `stage-photo-select:537-539` — сетка (3 платных вызова) выполняется до проверки `pool.length < minAcceptable`; при заведомой нехватке деньги тратятся зря.
- `stage-photo-select:638-646` — скачивание в хранилище без Referer/прокси (в отличие от модерации): Instagram/Pinterest-оригиналы дают `public_url = null`, фото остаётся с хотлинком.
- `stage-photo-filter:430` — `arrayBuffer()` без ограничения размера (защита только на декодирование 6 МБ/8 Мп).
- `stage-photo-filter:280-299` — добор не применяет размер/ориентацию к новым кандидатам (DFS не отдаёт размеры) — ожидаемо, но все 80 ссылок будут скачаны.
- `stage-photo-rate:867-873` — `PARALLEL_WAVE = 5 > BATCHES_PER_RUN = 4`: пауза между волнами никогда не выполняется.
- `photoSearch.ts:508, 530` — расход DFS всегда `$0.004` вне зависимости от `site:` (×5 по тарифу) и `depth > 100`; реальное `tasks[0].cost` отбрасывается; `depth` допускает до 700 при максимуме API 200.
- `photoQueries.ts:195` — `{target_country}` берётся из `photo_search_config.country`, а не из итогового `cfg.country` после `applyQueueOverrides` (гео статьи игнорируется в промте).
- `nicheProfile.ts:762-826` — кеш профилей живёт весь процесс; в долгоживущем воркере правки `niche_profiles` не подхватятся без TTL/инвалидации.
- `stage-photo-rate:437-441` — выборка soft-rejects `limit(200)` без фильтра по `ai_status` может взять уже `retry`-кадры повторно (безвредно, но лишние UPDATE).
- Трёхкратное дублирование константы 15 (rate/select/review) и двукратное `needed = count_outfits || 20`.

---

## 8. Рекомендации для порта

**Перенести как есть (логика проверена и самодостаточна):**
- `photoSearch.ts`: `normalizePhotoConfig`, `applyQueueOverrides`, `buildSearchQuery`, `buildTbs`, `sizeVerdict`, `orientationVerdict`, `isBlockedDomain`/`BLOCKED_ROOTS`/`rootDomain`, `resolveSearchKeyword`, `buildCaption`, `normalizeKeyword` — чистые функции. `searchDataForSeo`/`searchSerpApi` — перенести с исправлением полей DFS (7.4) и через `runSlot` проекта (`serp_dfs`/`serp_api`), логировать реальный `tasks[0].cost`.
- `photoVision.ts`: алгоритмы коллажа/плашки/dHash/резкости/EXIF-маркеров перенести 1:1, но декодирование делать через `sharp` (`.raw().toBuffer()` для RGB-сетки; для `findThinDividers` — отдельный проход по полному разрешению, можно с даунскейлом до ~800 px по длинной стороне, поскольку порог «≤2.5 % кадра» масштабируется). `AI_MARKERS` и чтение метаданных — по байтам, как сейчас (`sharp.metadata().exif/xmp` опционально).
- `photoQuality.ts` (`techQualityScore`, `finalPhotoRank`), `photoAuthenticity.ts`, `photoDiversity.ts`, `photoRelevance.ts`, `topicContract.ts` (с правкой 7.11), `fashionContract.ts`, `interiorContract.ts`, `audienceIntent.ts`, `photoGender.ts`, `photoAudience.ts` (с правкой 7.3), `trendBrief.ts`, `nicheProfile.ts` (встроенные профили как сид; таблица поверх по непустым полям) — чистый TypeScript, без Deno-зависимостей.
- Промты `builtInSystem` (запросы), `HARD_REJECT_RULES`/`ratingSystemFor`/`JSON_CONTRACT`/`TOPIC_RULES` (оценка), `SYSTEM` сравнения, `aSystem`/B/final сетки — перенести дословно; переменные `rp_photo_search`/`rp_photo_rate` сохранить, но модель брать из набора/слота проекта (7.9).
- Правило вердикта шага 13 (пороги 7/6, VIRALITY_MIN 45, TREND_MIN 40, ai_likelihood ≥80 + артефакт, child/adult, аудитория) и веса `ai_quality` (4/3/2/2/1).

**Упростить:**
- Убрать HTTP-цепочку функций и «пачка = вызов»: один воркер-этап на статью с внутренним циклом и чекпоинтами (`PinJob`-подобная очередь), без `service_leases`/`merge_pipeline_cursor` — лимит параллельных поисков делать семафором в процессе/через `runSlot`.
- Скачивать файл один раз в фильтре; сохранять оригинал + превью (sharp, ≤1024 px, JPEG q80) на диск (`storage/articles/<project>/candidates/<id>.jpg`); rank/rate/select/публикация читают локально. Это закрывает 7.5 и даёт Referer/прокси-фолбэк в одном месте (взять логику `photo-review-action add`: 2 UA, Referer, weserv).
- Ранжировать (125) только `ai_verdict = keep` после оценки, либо совсем заменить `beauty_rank` турнирной сеткой шага 14 (функционально дублируют друг друга); если оставлять — сравнивать все группы одного проекта в одном проходе (7.15).
- Один лимит доборов и один порог «15» в общем модуле констант; `rescue`-проход — отбирать по структурированному признаку «мягкий отказ» (хранить `reject_class` в `ai_quality_breakdown`), а не по регэкспу на русский текст; промо по `ai_score ≥ 6` — только для класса «ниже порога балла».
- Кеш поиска по `search_query` — либо убрать, либо ограничить `tech_status='ok'` и тем же `search_geo/search_language`.
- `searchSerpApiEngine`, `nextGeo`/`GEO_FALLBACKS`, `debugPhotoMetrics`, `contractLocks` (для фото-цепочки), `cutSpecs.ts`/`nailSpecs.ts` — не переносить в фото-цепочку.
- Проверить/перенастроить словари: `nearPerson` без `hair/hairstyles/haircuts/beauty` для цветов; `asian/latina` только при словах о людях; `girls` вне `CHILD_WORDS` (или только `girls'`/`little girls`); gender-замок по умолчанию — настройкой ниши.

**npm-пакеты:**
- `sharp` (уже есть) — декод JPEG/PNG/WebP/AVIF, размеры (`metadata()`), RGB-сетка (`resize().raw()`), превью; заменяет `jpeg-js`, `upng-js`, `@jsquash/webp` и ручной `dimsFromBytes`.
- Ничего для phash/sha256 (dHash свой, `crypto.createHash("sha256")`).
- HTTP: встроенный `fetch` Node 18+/`undici` (нужен `AbortSignal.timeout`, в Node ≥17.3 есть). Для прокси — тот же `images.weserv.nl` URL либо `undici.ProxyAgent`, если будет свой прокси.
- ИИ: существующие адаптеры проекта (`src/lib/adapters.ts`, OpenAI-совместимый OpenRouter с `image_url` data-URL); JSON-ответы парсить так же устойчиво (````json```, первый `{…}`).
- DataForSEO/SerpApi — через уже существующий `src/lib/domains/serp.ts`-подобный слой (`runSlot`), добавив Google Images endpoint и учёт `tasks[0].cost`.
- Опционально `p-limit` для пулов скачивания/вызовов (6 параллельных загрузок, 4–5 параллельных vision-вызовов).
