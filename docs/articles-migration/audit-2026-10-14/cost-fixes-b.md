# Расходы, волна 3 — правки «b» (поиск с фильтром, позднее описание фото) — 2026-10-16

Пункты 1 и 4 из `cost-notes-zorvianix.md` («Структура расходов, волна 3»). Всё за флагами, по умолчанию поведение
прежнее: прод zorvianix.com не меняется. Не задеплоено, не закоммичено; типы проверены в копии `/root/zewex-check`
(`tsc` app + worker + scripts/articles — чисто).

## Флаги (снимок рецепта `Article.recipe.photoSearch`, тип `PhotoSearchConfig` в `src/lib/articles/types.ts`)
- `rateMode: "full" | "slim"` (пусто = full). slim — тонкая оценка: только вердикт, баллы, флаги и поля разнообразия;
  описание и полные факты пишутся позже итоговым фото (см. ниже). **Пока в rate.ts не подключён** (файл занят другим
  исполнителем) — готов контракт `src/lib/articles/photo/rateSlim.ts`.
- `searchSizeFilter: boolean` (пусто = false). Поисковику передаются крупные + ориентация: DataForSEO `search_param=tbs=isz:l,iar:t,itp:photo`,
  SerpApi — тот же tbs плюс `imgsz=l`, `imgar=t`. Ориентация для фильтра — `sizeFilterAspect`: есть tall → `t` (квадрат
  наш фильтр по-прежнему принимает, просто реже попадается), только square → `s`, только wide → `w`.
- В рецептах/форме флагов нет: тестовым статьям они ставятся в снимок скриптом `cost-test-launch.ts` (или JSON-правкой снимка).

## Пункт 4 — фильтр размера/ориентации в поиске
Файлы: `src/lib/articles/photo/search.ts` (`SearchCfg.size_filter`, `sizeFilterAspect`, `buildTbs`, параметры SerpApi),
`worker/articles/stages/search.ts` (только `sizeFilter` в details этапа). Проверочный скрипт
`scripts/articles/search-filter-test.ts "<ключ>" [--n=100|200] [--serp]` — две выдачи DataForSEO (≈$0.002 каждая),
первые N кадров скачиваются и прогоняются через наш `sizeVerdict`/`orientationVerdict` (tall+square, ≥550).

Замер 2026-10-16 (DataForSEO, US/en):
| ключ, N | без фильтра: мелкие / ориентация / прошло | с фильтром: мелкие / ориентация / прошло | медиана короткой стороны |
|---|---|---|---|
| pistachio nails, 100 | 13% / 6% / **81%** | 0% / 13% / **87%** | 1022 → 1080 px |
| cowboy boots outfits, 200 | 21% / 7% / **72%** | 0% / 12% / **88%** | 720 → 980 px |

Вывод: `isz:l` полностью убирает отсев «мелкое» (на глубине 200 — 21% выдачи); `iar:t` слабый — Google всё равно
отдаёт ~12% широких (их по-прежнему режет наш фильтр). Выдачи пересекаются на 72–87%, т.е. фильтр не «другой поиск»,
а та же выдача без мелочи. Прошедших на запрос +6…+16 п.п.; ожидаемо на статью — меньше доборов (46% отсева в проде
включает и домены/дубли/коллажи, которые фильтр поиска не трогает). Точную экономию покажет тестовый запуск.

## Пункт 1 — описание фото после модерации (половина пункта)
- `src/lib/articles/text/photoDescribe.ts`: `describePhotosBatch(ai, profile, keyword, photos, {model, signal})` — до 8 фото
  одним vision-вызовом, тот же `photoFactSkeleton`/`photoFactRules` + «description 30–60 words, factual»; принимается
  ответ с ≥8 словами описания и непустыми фактами, пропущенные моделью → `failed`. Прежний `describePhoto` (по одному) остался.
- `src/lib/articles/photo/describeLate.ts`: `describeLatePhotos(ctx, photos, profile, keyword)` — кого описывать
  (`needsLateDescription` в rateSlim.ts): slim → все активные ArtPhoto без описания; full → только фото совсем без фактов и
  описания (ровно то, что раньше по одному делал sections, теперь раньше и пачкой; при полных фактах — ничего).
  Пишет в `ArtPhoto.facts` (тонкие факты оценки + полные, полные сверху) и `ArtPhoto.description` — туда, откуда их
  читают plan (`buildPromptVars` → photos_table, `uniqueHeading`) и sections (`factsLine`, `photo_description`).
  Модель — `stageModel(recipe, "rp_photo_rate")` (у рецептов — gemini-2.5-flash-lite). Пачкой не описанные — по одному
  `describePhoto`; совсем не описанные остаются sections (его автопочинка не трогалась).
- `worker/articles/stages/plan.ts`: вызов в начале этапа после проверки «секции уже написаны» и до планировщика;
  расход — в окне этапа plan (`UsageLog.refId` = статья, в costs.ts → «Текст»); сводка этапа «…; описаны N фото
  (без описания M)», details `describedPhotos/describeCalls/describeCostUsd`. Идемпотентно: описанные пропускаются.
- `src/lib/articles/photo/rateSlim.ts` (подключён к rate.ts, см. ниже): `SLIM_FACT_KEYS` по нишам — только поля, по которым `diversity.ts`
  раскладывает фото (оси профиля → поля photo_facts): nails colors/shape_length/finish/decor; hair colour/length/texture/
  styling/bangs; outfits hero_piece/layers/palette/silhouette/shoes; interior palette/hero_element/key_pieces/style/materials/
  lighting; tattoo, makeup — см. файл. `slimJsonContract(profile)` — хвост JSON-контракта вместо facts/description;
  `slimJudgement(j)` — обнуляет description и ставит `aiBreakdown.slim=true` (judgeRatingItem иначе подставляет текст из
  фактов, и позднее описание не поймёт, что фото ещё не описано).
- `worker/articles/stages/rate.ts` (подключение slim, после правок A того же дня): `RateSystemInput.rateMode`;
  в `buildRateSystem` JSON-контракт = `FACTS_AND_JSON` (full — прежний текст «ON-TOPIC FACTS ONLY … facts/description:
  empty for rejected photos.» байт в байт; slim — `slimJsonContract(profile)`) + общий хвост (CATALOGUE/SUBJECT AGE/
  AUTHENTICITY/QUALITY SCORES/trend); встроенный промт без набора — `ratingSystemFor(profile, slim)`. Статичная часть
  остаётся статичной: slim и full — просто два разных текста системы (два ключа кэша). В этапе: `slim = cfg.rateMode ===
  "slim"`, `FACT_KEYS = slimFactKeys(profile)`, результат `judgeRatingItem` → `slimJudgement` (aiDescription = null,
  `aiBreakdown.slim = true`). Баллы, HARD REJECT, контракт темы, промо при нехватке, второй проход, ранний стоп — без
  изменений; maxTokens пачки не трогал (6144 — верхняя граница, платим за фактический вывод).
  Стенд (временный tsx, удалён): встроенная система nails full 3033 симв. (~758 ток.) → slim 2157 (~539); hair 3077 →
  2218; outfits 2906 → 2109; lead не меняется (~250–300 ток.); с системным промтом набора slim ≈ 4.3k симв.
  `buildRateSystem` без `rateMode` и с `rateMode: "full"` даёт одинаковые system/lead (проверено на трёх нишах).
  Главная экономия slim — вывод: ~280 → ~90 токенов на фото (нет описания, 4–5 полей фактов вместо 9–10).

## Тестовые скрипты (`scripts/articles/`, запускать на сервере в `/root/zewex-check`, ничего не запущено)
- `cost-test-launch.ts --name="…" --rateMode=slim --sizeFilter=1 [--per=5] [--photoCount=30] [--photoReview=1] [--label=cost-b] [--apply]`
  — 15 ключей (5 на нишу, нет среди 4000 заголовков women-club и в прежних тестах) на сайте
  `6c1b4b83-…` с рецептами ногти/волосы/одежда «реальные фото», норма 30, черновик до одобрения, тестовая метка; после
  `launchArticles` ставит флаги в снимок каждой статьи. Без `--apply` — сухой прогон (проверен). Цепочки автозапуска сайта
  («фото» и «написание») сейчас выключены — с `--apply` скрипт включает их сам (`ArtSite.settings.autostart.photoEnabled/
  writingEnabled = true`, лимиты и остальное не трогает) и пишет об этом. Ключи: blueberry milk / coquette / strawberry /
  pistachio / vanilla chrome nails; layered lob, cowboy copper hair, dark cherry hair, bubble braid hairstyles, peekaboo
  highlights; sweater vest / ballet flats / linen pants / puffer vest / cowboy boots outfits.
- `cost-test-report.ts <runId> --out=<папка> [--no-sheets]` — расход по этапам (окна ArtStageLog + окна ИИ-модерации, как
  costs.ts, но по этапам, с числом вызовов), воронка found→filter→rated→keep→selected→reserve→модерация −/+→итог→описаны,
  поисков на статью, кандидаты по номеру запроса, сравнение с базой волны 3 (цифры зашиты в `BASELINE`), таблица по
  статьям; `report.md`, `report.json`, контактные листы `sheets/<ключ>.jpg` (sharp: 4 колонки, оранжевый номер = позиция,
  под кадром описание из ArtPhoto, красная рамка — исключено) и `sheets.json` для локального PIL. Проверен на запуске
  `d580e62d` (9 статей, $0.042/статья при норме 11–19): `/root/zewex-check/out/cost-test-d580/`.

## Что не менялось
`rank.ts`, `stages.ts`, `ai.ts`, `aiModeration.ts`, `sections.ts`, `select.ts`, `ranking.ts`, схема базы. В rate.ts — только
подключение slim (см. выше); поведение при `rateMode` пустом/full прежнее.
