# Прогресс: конец фото-цепочки — rank (125), rate (13), select (14), модули vision/ранжирования

Статус: код написан полностью, типы на сервере **не проверялись** (на Mac нет Node). Ничего не коммичено.

## Что перенесено (файл → исходник)

| Наш файл | Исходник | Примечания |
|---|---|---|
| `src/lib/articles/photo/vision.ts` | `_shared/photoVision.ts` (пиксельный анализ 1:1: тонкие перемычки, швы, леттербокс, плашки с текстом, AI-метки в байтах, dHash, резкость, статистика) + `_shared/trendBrief.ts` (тип `TrendBrief`, `parseTrendBrief`, `fallbackTrendBrief`, `trendBriefText`, `resolveTrendBrief(facts, niche, keyword)`) + новые vision-помощники | Декодирование через `sharp`: перемычки ищутся на копии ≤800 px (аудит 02 §8), сетка 160 px как в оригинале. `inspectPhotoBytes`, `perceptualHash`, `phashDistance`, `detectAiGeneratedBytes`, `MIN_SHARPNESS` — для этапа filter. `loadVisionImage(cand, "full"|"thumb")` — оригинал ≤1024 px JPEG q80 или миниатюра WebP как есть; `VisionImageCache`; `visionJson(ai, {model, system, parts, temperature, maxTokens, timeoutMs})` через `aiChat` (слот `vision`, `json: true`); `mustRethrow(err, signal)` — что пробрасывать (стоп, fatal_run, transient), остальное этап глотает как оригинал. |
| `src/lib/articles/photo/relevance.ts` | `_shared/photoRelevance.ts` 1:1 | `buildTopicRelevance`, `checkTextRelevance`, тип `TopicRelevance`. |
| `src/lib/articles/photo/authenticity.ts` | `_shared/photoAuthenticity.ts` 1:1 | `catalogueSourceSignal`. |
| `src/lib/articles/photo/diversity.ts` | `_shared/photoDiversity.ts` 1:1 | `photoTraits`, `orderPhotosForVariety`, тип `DiversityInput`. |
| `src/lib/articles/photo/ranking.ts` | `_shared/photoQuality.ts` (`techQualityScore`, `finalPhotoRank`) + логика вердикта `stage-photo-rate/index.ts:724-858` (`judgeRatingItem`, `aiQualityOf`, `isFlatRating`, `cleanFacts`, `factsToText`) + константы/баллы `stage-photo-rank` (`beautyLocalScore` 95..25, `beautyChampionScore` 100..72, `seededShuffle`) | Новое: тип `AiBreakdown` (содержимое `ArtPhotoCandidate.aiBreakdown`), `RejectClass` + `HARD_REJECT_CLASSES` + `isHardReject` — структурный «мягкий/жёсткий отказ» (аудит 02 §8), `candidateRank(c)`, `topicOf(article)` (= `resolveSearchKeyword`: focusKeyword → keyword → seoKeyword). |
| `src/lib/articles/photo/fingerprints.ts` | таблица `photo_usage_fingerprints`, `stage-photo-select:386-445, 723-779`, `cleanup_photo_data` | `loadPhotoUsage` (точные совпадения по sha256/URL файла среди статей команды за 30 дней; phash ≤10 — среди статей команды с тем же `keyword`/`focusKeyword`, лимит 2000), `recordPhotoFingerprints` (delete по статье + createMany; `uniqueMode=off` — не пишем), `purgeOldFingerprints` (30 дней), `normalizeKeyword`, `NEAR_DUPLICATE_DISTANCE=10`. |
| `src/lib/articles/photo/caption.ts` | `_shared/photoCaption.ts` + `buildCaption`/`hostOf` из `photoSearch.ts` | **Файл сверх списка задания** (подпись нужна и этапу assemble): `buildCaption(cfg, domain, pageUrl)`, `buildCaptionHtml`, `fillCaptionTemplate`, `captionCredit`, `escapeCaptionHtml`, `PHOTO_CREDIT_PREFIXES`, `hostOf`. |
| `worker/articles/stages/rank.ts` | `stage-photo-rank/index.ts` | Группы по 10 (детерминированный shuffle по id статьи), волны по 4, промт `SYSTEM` дословно, балл 95..25, турнир чемпионов (3 из группы, пул 12) 100..72, остальные ≤70, запись `beautyRank` (округлено до целого — колонка Int) + `aiBreakdown.beauty_note`. Группы без ответа — одна повторная попытка, затем 50 «не удалось сравнить». Если ни одна группа не сравнена из-за transient-ошибки — этап бросает её (раннер повторит), а не ставит всем 50. |
| `worker/articles/stages/rate.ts` | `stage-photo-rate/index.ts` | Промты (`HARD_REJECT_RULES`, `ratingSystemFor`, `JSON_CONTRACT`, `TOPIC_RULES`, `CHECKLIST`, `FASHION_RULES`, `INTERIOR_RULES`, `CONTRACT_RULES`, `AUDIENCE_RULES`, SECOND PASS, CORRECTION-повторы) дословно. Пачки `ratingBatchSize` (≤12, default 8) волнами по 5, порядок `beautyRank DESC`, temperature 0.2, maxTokens 6144, 180 с. Модель — `stageModel(recipe,"rp_photo_rate")` (08-plan §3 п.4), промт — `resolvePromptOptional` + `fillPrompt` с переменными `topic, focus_keyword, niche, subniche, language("en"), topic_kind, subject_label, fashion_contract, interior_contract`; без промта — встроенный. Финиш: возврат к `filter` при непроверенных кандидатах (`cursor.filterCycles` ≤ 6, флаг `cursor.filterPending=true`), промо `aiScore≥6` только мягких классов, второй проход один раз (`cursor.rescueUsed/rescuePass`, порог `max(6, minScore−1)` в `cursor.minScore`), добор `cursor.topup={from:"rate",needed,reason}` → `next:"search"` при `keep<needed && cursor.topups<6 && cursor.rateTopups<7`; иначе `keep≥min(photoCount,15)` → select; `photoReview && keep>0` → select (он остановится на PHOTO_REVIEW «Мало фото»); иначе WAITING_FOR_PHOTOS. |
| `worker/articles/stages/select.ts` | `stage-photo-select/index.ts` | `finalPhotoRank` → уникальность → `takeDistinct` (phash ≤10 или ≥3 одинаковых осей) → listA (≤45) / listB (30) → `gridPass` A/B/final (промты дословно, temperature 0.1, maxTokens 1500, 120 с, повтор A через 3 с) → `chosen` → нехватка → `orderPhotosForVariety` → `spreadSimilarPhotos` (топ-5 фиксированы) → файлы (`toWpJpeg` → `photos/<id>.jpg` + `makeThumb`, пул 6; если оригинал кандидата удалён — повторное скачивание по `url`/`thumbUrl`, 30 с, UA ZewexBot) → `ArtPhoto` (position 1..N, caption по рецепту, `fileName="<pos>-<sha12>.jpg"`, alt=title, facts/description/aiScore из кандидата) → кандидаты `selected`/`reserve` → отпечатки → `purgeCandidateOriginals` → сброс колец в cursor. |

## Контракт данных (что пишем на кандидате и фото)

- `ArtPhotoCandidate`: `beautyRank` (rank), `status` `keep|rejected` (`rejectStage="rate"`, `rejectReason` по-русски), `aiScore` 0–10 (0, если тема/аудитория не подтверждена), `relevance` = сырой балл модели ×10 (0–100), `aiDescription` (≤1200), `aiFacts` (ключи `fact_block.photo_facts` профиля), `audience` `{expected, seen, ok, subject_age}`, `rankScore` = `finalPhotoRank`, `aiBreakdown` (`AiBreakdown`: virality/trend/ai_likelihood/composition/lighting/framing, `ai_quality`, `reason`, `reject_class`, `verdict`, `topic_ok`, `score_threshold`, `raw_score`, `promoted`, `rescue`, `prev`, `attempts`, `beauty_note`). После отбора одобренные делятся на `selected` / `reserve`.
- `ArtPhoto`: как в задании; `width/height` — размеры сохранённого JPEG (≤1600), а не кандидата.
- `Article.cursor`: читаем `topups` (пишет filter), пишем `filterCycles`, `filterPending`, `rateTopups`, `selectCycles`, `minScore`, `rescueUsed`, `rescuePass`, `topup {from:"rate"|"select", needed, reason}`; после успешного отбора `filterCycles/rateTopups/selectCycles/topup/rescuePass/filterPending` удаляются.

## Что упрощено / изменено (с обоснованием)

1. Нет «пачка = HTTP-вызов», `BATCHES_PER_RUN`, `PER_RUN=60`, статусов `ai_status pending|retry|done`: один долгий этап с `ctx.tick()`; «retry» заменён счётчиком `aiBreakdown.attempts` (2 попытки → `model_failed`).
2. Оценка идёт по уменьшенным копиям ≤1024 px (аудит 02 п.7.5), сетки — по миниатюрам 400 px WebP; файлы читаются с диска, не скачиваются повторно.
3. Промо `aiScore ≥ 6` и второй проход — только для мягких классов (`dated`, `low_virality`, `below_threshold`, `model_reject` без HARD-слов); жёсткие (`audience`, `checklist`, `no_evidence`, `catalogue`, `synthetic`, `child`, `download`, `model_failed`) не трогаем (08-plan §3 п.5; аудит 02 п.7.2, 7.6). Регэксп `HARD` оригинала сохранён для `model_reject` и дополнен английскими словами (collage/overlay/screenshot/render/mannequin/off-topic), т.к. причины модели — английские.
4. Факты извлекаются и сохраняются для всех кадров с подтверждённой темой, за которые модель проголосовала keep (оригинал — только для итогового keep): иначе промо/второй проход отдавали писателю кадры без фактов. Добавлен класс/причина `child` (в оригинале падал в `item.reason`).
5. Транзитные ошибки vision (429/5xx/таймаут) пробрасываются раннеру (backoff + повтор идемпотентного этапа) вместо «пачка в retry/отказ» — закрывает аудит 02 п.7.6 (сетевая ошибка во втором проходе = окончательный отказ).
6. Уникальность: оригинал сравнивал phash по `keyword_norm` всех проектов приложения; у нас — статьи **команды** с тем же `keyword`/`focusKeyword` (в `ArtPhotoFingerprint` нет поля ключа — ищем через `Article`), точные совпадения — по sha256 **и URL файла**. Срок жизни — фильтр по `createdAt ≥ 30 дней` + `purgeOldFingerprints()` из select.
7. Эталоны `photo_reference_set` не переносятся (08-plan §2) — сетки без блока REFERENCE QUALITY BAR.
8. Нехватка на select: сначала добор (`topups<6 && selectCycles≤7`) независимо от режима модерации; при исчерпании — `photoReview && chosen>0` → сохраняем и PHOTO_REVIEW «Мало фото», иначе WAITING_FOR_PHOTOS (оригинал в режиме 2 при `chosen>0` сразу шёл на модерацию без добора). Rate при `keep<min(photoCount,15)` и `photoReview && keep>0` не ждёт сам, а отдаёт select, чтобы модератор увидел `ArtPhoto` + резерв.
9. Повтор select удаляет прежние `ArtPhoto` (и файлы `photos/`), секции, план/intro/outro/html статьи (оригинал :368-384, :616) — как и в оригинале, правки модератора по фото при повторном отборе теряются.
10. Оригиналы кандидатов, не вошедших в статью, удаляются после отбора (задание); при повторном отборе резервные кандидаты скачиваются заново по `url` (`fetchOriginal`), если файла нет.
11. `language` для промта — всегда `"en"` (в снимке рецепта нет языка; статьи сервиса английские).

## Что не перенесено и почему

- `debugPhotoMetrics`, `imageStats` как экспорт, `searchSerpApiEngine`, `nextGeo`, `contractLocks`, `cutSpecs`/`nailSpecs` — вне фото-цепочки/мёртвый код (аудит 02 §8).
- `workflow_stages`-чекпоинты (`output_data` с `fashion_contract`/`interior_contract`) — контракты живут в `Article.facts`; этапы при их отсутствии строят сами (чистые функции).
- `article_photos.search_*`/`reused` — колонок нет; `reusedSelected` виден в `details` журнала этапа.
- `needs_filtering` без лимита: оставлен лимит `PHOTO_LOOPS.filterCycles=6`.

## Зависимости от соседних модулей (имена оригинала — проверить при сборке)

- `@/lib/articles/photo/profile`: `getNicheProfile(niche, subniche): Promise<NicheProfile>`, `specializeProfile(profile, topic)`, `defaultProfile(niche?)`, `subjectLabel`, `photoFactFields`, `photoFactSkeleton`, `topicKindLabel(profile, topic)`, тип `NicheProfile` (поля `required_visuals`, `exclusive_terms`, `diversity_axes`, `fact_block.photo_facts`).
- `@/lib/articles/photo/contracts`: `buildTopicContract(profile, attrs, topicText)` (поле `reviewRules`), `buildFashionContract(keyword, attrs)` / `fashionContractPrompt` (поля `outfit_mode`, `hard_requirements`), `buildInteriorContract(keyword, attrs)` / `interiorContractPrompt` (поля `decor_mode`, `hero_element`, `setting`, `hard_requirements`), `isInteriorNiche(niche, subniche)`, типы `TopicContract`, `FashionContract`, `InteriorContract`.
- `@/lib/articles/photo/audience`: `audienceRule(keyword, niche)` (поля `code`, `tokens`, `rule`), `isChildIntent(keyword, niche)`.
- Этап `filter` (сосед): кандидаты со `status="downloaded"`, `path`, `thumbPath`, `techScore`, `sha256`, `phash`; непроверенные — `status="found"`; пишет `cursor.topups`. Ожидается, что при `cursor.filterPending=true` фильтр дорабатывает оставшиеся `found` без оглядки на резерв (оригинал `process_pending`).
- Этап `search` (сосед): читает `cursor.topup {from, needed, reason}` для добора.

## Экспорты для других исполнителей

- Фильтр: `inspectPhotoBytes`, `perceptualHash`, `phashDistance`, `detectAiGeneratedBytes`, `MIN_SHARPNESS`, типы `PixelVerdict`/`ImageStats` (`vision.ts`); `techQualityScore` (`ranking.ts`); `catalogueSourceSignal` (`authenticity.ts`); `checkTextRelevance`/`buildTopicRelevance` (`relevance.ts`).
- Сборка/публикация: `buildCaption`, `buildCaptionHtml`, `escapeCaptionHtml` (`caption.ts`); `readBreakdown`, тип `AiBreakdown`, `isHardReject` (`ranking.ts`) — для карточки статьи и модерации (причина/класс отказа, промо, второй проход).
- Модерация «добрать»: достаточно сбросить `Article.stage="search"` с `cursor.topup` — rate/select идемпотентны.

## Открытые вопросы

1. Условие добора в rate: оставлено как в оригинале (`keep < photoCount`, не `< min(photoCount,15)`) — иначе статья на 20 фото останавливалась бы на 15 без попытки добрать. Если нужна экономия — поменять одно условие (`needsMore` в `rate.ts`).
2. Имена экспортов соседних модулей (`defaultProfile`, поля контрактов) — сверить при `tsc`.
3. `aiChat` всегда добавляет `reasoning: {effort:"none"}` — для некоторых vision-моделей OpenRouter может быть лишним; это в фундаменте, не здесь.
4. `beautyRank` — Int в схеме, оригинал хранил десятые; на формулу влияет незначительно.
