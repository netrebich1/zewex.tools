# Правки текстов по аудиту text-v2 (15.10.2026)

Основание: `text-v2.md` (аудит раунда 2) и `text.md` (раунд 1). Ниши: ногти, волосы, одежда, рецепты с реальными фото.
Ничего не задеплоено и не закоммичено. Проверка типов в копии `/root/zewex-check` проходит: `tsc` и `tsc -p tsconfig.worker.json` без ошибок.

## Коротко

- **Код без ИИ.** Починены обрубленные SEO-тайтлы. Тире, британское написание и `</p></p>` чистятся детерминированно на каждом этапе. Слова-пустышки убраны из URL. Температура автора снижена с 1 до 0,8.
- **План больше не сочиняет опыт.** Из промтов плана ногтей, волос и одежды убраны `real_experience`, `estimated_wear_time`, `transition_from_previous` и похожие поля. Вместо них практические поля: `ask_for`, `who_it_suits`, `wear_tip`, у одежды `fit_note`, `shoes_note`, `look_for`. Старые поля в `BRIEF_SKIP`, поэтому автор не увидит их и в планах, сохранённых до правки.
- **Промты авторов переписаны.** Персон Maya и Nora больше нет. Сняты шаблонные фразы, у каждой ниши свой обязательный каркас секции. Добавлены правила точности. Конфликт с `<b>` решён в пользу «без выделений»: код и так их вырезает.
- **Проверка после записи.** Стоп-лист, обороты, затёртые на сайте (память по последним 30 статьям), и обороты, повторённые в 3+ секциях статьи. Плохие секции переписываются один раз той же моделью, расход виден в журнале этапа.
- **Мета на дешёвой модели.** `stage_8_meta` = `openrouter:google/gemini-2.5-flash-lite` в трёх рецептах с реальными фото (вместо gemini-2.5-flash по правилу слота).
- **Итог по цене: ≈ −$0.002…−$0.003 на статью**, при худшем случае с переписью ≈ −$0.001 (подробно ниже).

## 1. Код ($0)

| Что | Где | Как |
|---|---|---|
| Обрубленный тайтл «…for a Soft & Sunny» | `worker/articles/stages/meta.ts` → `deTemplateTitle`, `looksCut`, `trimDangling` | Пустышка (Ideas/Looks/Best…) вырезается, только если фраза не обрывается: нет связки или «артикль + прилагательное» на конце. Иначе остаётся вариант модели («…Sunny Look»). Двоеточие перед связкой (for/with/to…) → пробел, иначе двоеточие остаётся. На тире двоеточие больше не меняется. Обрезка тайтла до 60 символов убирает висящие «for a». |
| «Mary Jane Shoes Outfits – for…» | `polish.ts` → `fixDashesHeading` | Тире перед связкой → пробел, остальные тире в H1/тайтле → запятая. |
| Длинные и средние тире в тексте | `src/lib/articles/text/polish.ts` → `fixDashesText` / `polishHtml` | Диапазон «2–3» → «2-3». «mid–length» → дефис. Короткий зачин «The fix — …» → двоеточие. Тире перед новым предложением («— it's…», «— there is…», «— who…») → точка и заглавная. Остальное → запятая, вставка «X — aside — Y» → «X, aside, Y». Дефисы составных слов не трогаются. Работает только по тексту вне тегов. |
| Британское написание | `polish.ts` → `toUsSpellingText`, `usesUsSpelling` | colour/favourite/honour…, grey → gray, jewellery, cosy, -ise/-isation → -ize/-ization (по явному списку корней, «rise/precise/advise» не задеваются). Только для англоязычного сайта не из GB/AU/NZ/IE/ZA/IN (`recipe.photoSearch.language/country`). |
| `</p></p>` | `polishHtml` (каждая секция в `sections.ts`, вступление и заключение в `introOutro.ts`, все блоки в `assemble.ts`), `html.ts` → `assembleArticleHtml` | `balanceParagraphs` на каждом блоке и финальная зачистка итогового HTML. |
| Пересборка старых статей | `worker/articles/stages/assemble.ts` | Та же чистка на сборке: статьи, написанные до правок, при пересборке тоже получают чистый HTML (в `ArtSection` текст не перезаписывается). |
| Хвосты уникальных H2 | `textGuards.ts` → `uniqueHeading` | Хвост через запятую вместо « — ». |
| Мусор в URL | `polish.ts` → `stripSlugFiller`, `slug.ts` → `SLUG_SHAPES = ["{kw}"]`, промт меты п. 9 | URL — блок ключа (+ год по розыгрышу). cute/trendy/best/chic/ideas/looks/designs/for-women… вне ключа вырезаются. |
| Лишние попытки меты | `meta.ts` → `validate` | URL больше не проверяется: он собирается детерминированно, и повтор ИИ ради него не нужен. Нижний порог описания снижен со 140 до 130 символов, до 140 добирает `padDescription`. «favourite» → «favorite» в CTA. |
| Температура автора | `sections.ts` | 1 → 0,8, как у вступления. |

## 2. Поля плана с выдуманным опытом

- **`rp_photo_plan` ногтей (`b59ca1bd…`) и волос (`4a2f81a7…`).**
  - Персона заменена: «опытный редактор, объясняет, никогда не заявляет личный тест».
  - Убраны поля `real_experience`, `estimated_wear_time`, `transition_from_previous`, `standalone_*`, `color_palette`, `stylist_score`, `style_verdict`, `hero_piece`, `angle_note` с «reaction: …».
  - Убраны поля структуры (format, register, voice_seed, sentence_rhythm, target_word_count, section_angle, bonus_type) и `faq_plan`: FAQ в статье нет, план писал его впустую.
  - Новые поля: `who_it_suits`, `ask_for` (2–8 слов для мастера), `wear_tip`.
  - Добавлены правила точности. Ногти: снятие гель-лака и втирки — ацетоном, втирка — на топ без липкого слоя. Волосы: чёлку и длину копировать из фактов, советы по форме лица — стандартные.
  - Интро-план: `p3_personal` → `p3_reader` (проблема читателя). Аутро: подходы `decision_rule | care_focus | new_angle` вместо `honest_admission` («какую я запишу себе»).
- **`rp_photo_plan` одежды (`c1a11003…`):** поля `fit_note`, `shoes_note`, `who_it_suits`, `look_for`. Видимая посадка, длина и фактура ткани разрешены, состав ткани и комфорт — нет.
- **`rp_section_plan` (ногти, волосы, одежда):**
  - Убраны «sceptical take» и «reaction opener».
  - В `note` запрещено первое лицо.
  - У одежды добавлена форма JSON и требование `primary_takeaway` — одно практическое правило на секцию.
- **Углы и заходы** (`src/lib/articles/text/vars.ts`): `personal_story` → `how_to_ask`, `skeptic` → `honest_take`. Заходы: `observation, verdict, question, fact, rule, contrast` вместо `reaction` и `confession`. Подсказки углов в `sections.ts` больше не просят первое лицо. Для старых ключей в сохранённых рецептах оставлены нейтральные подсказки.
- **`BRIEF_SKIP`** (`sections.ts`): все поля выше плюс структура. Ключи `hero_piece` и `fashion_details` автор видит как `main_item` и `outfit_details`, чтобы «hero piece» не попадал в текст.
- **`sectionPlan.ts`:** для одежды «fit claims» больше не запрещены. Запрещены выдуманные состав, комфорт и тесты, видимая посадка разрешена.

## 3. Промты авторов (`prisma/seed-data/articles/prompts.json`)

| Промт | Что сделано |
|---|---|
| Ногти, автор (`9d6340d3…`, `a29fb28f…`) | Голос из `text-v2.md`. Блоки WHO MAYA IS, MAYA'S REACTION, E-E-A-T → real_experience, STANDALONE, FORMATS A–F и RHYTHM/DISORDER удалены: структуру задаёт рецепт секции. Каркас: что за дизайн → кому идёт → «ask your tech for» → риск или уход. Блок ACCURACY (ацетон, no-wipe топ, «бусины» только у акрила). Без `<b>`, американское написание, расширенный стоп-лист. |
| Волосы, автор (`22b94976…`, `785382a2…`) | В начале «Use American spelling». Нора и NORA'S REACTION убраны, вместе с «flat by 4 pm», «roots at week five» и «bathroom-mirror job». Каркас: что это → кому подходит (форма лица ИЛИ густота и текстура, исходная длина) → что сказать мастеру → укладка и ритм стрижки в неделях. Правило про чёлку и длину. Стандартные советы по форме лица («middle part widens a round face» больше нет). |
| Одежда, автор (`c1a11005…`, `c1a11006…`) | Персона Maya убрана, второе лицо. Каркас: посадка главной вещи → обувь, длина и пропорции → кому подходит и как адаптировать → «to recreate it, look for…» (категории, без брендов). Стоп-лист: the principle, verdict, masterclass, intentional rather than accidental, heavy lifting, hero piece, picture this. Запрет описывать невидимое. Без тире. |
| Вступление и заключение, ногти и волосы (`b0e6dbb4…`, `4de1da12…`) | Убраны «chair next to hers», «why Maya/Nora cares» и «which one she is booking». P1: конкретный факт тренда; у волос сначала определение стрижки или техники. Заключение 70–120 слов: правило выбора + список ухода, без первого лица. У ногтей исправлены буквальные `\n` в тексте промта. «Тексты уже написаны» → «по плану и заголовкам»: по реестру этапов `intro_outro` идёт до `sections`. |
| Вступление и заключение, одежда (`c1a11007…`) | Заключение 80–120 слов: 3–4 правила списком (обувь и длина, пропорции, цвет, сезон) + итоговая фраза. Стоп-лист («whether you're», «we've rounded up», «effortlessly chic»…). |
| Код поверх промтов | `introOutro.ts`: объём заключения 70–120 и стоп-лист добавляются к любому промту набора. Поправка модели теперь просит 70–120, а не 80–140. Это внутри жёстких рамок 30–200 (`OUTRO_MIN_WORDS` в `introOutroParse.ts`). `sections.ts`: тот же стоп-лист `BANNED_PROMPT_LINE` и до 15 затёртых оборотов сайта в system автора. |

Промты ИИ-фото наборов (GENERATED_PHOTO) и интерьера не менялись. Оценку фото (`rp_photo_rate`) и автора со зрением не трогали: это отдельные треки.

## 4. Проверка после записи секций

`worker/articles/stages/sections.ts` → `loadSitePhraseMemory`, `reviseFlagged`, `rewriteSection`; чистые функции в `polish.ts`.

**Что ищем:**
- Стоп-лист `BANNED` (≈35 регулярок):
  - выдуманный опыт: I wore/tried/tested, mine lasted/held, my go-to/my tech, I'm booking, compliments, I was skeptical, I'll admit, after writing all of these, chair next to mine, flat by 4;
  - штампы: the principle, the verdict, masterclass, intentional rather than accidental, heavy lifting, doesn't shout, catches the light, effortless, stunning, elevate, whether you're, vibe…;
  - служебное: hero piece, picture this, «no footwear is visible», in the photo.
- Затёртые на сайте обороты. Это 4-граммы из текстов последних 30 статей сайта той же ниши, которые встретились в 3+ статьях.
  - Берутся только «голосовые» 4-граммы: 2–3 служебных слова из 4.
  - Не берутся 4-граммы с цифрами, словами каркаса (ask/tech/stylist) и предметными словами ниш (coat, brush, bob, jeans, цвета…), а также со словами ключа статьи.
  - Это один запрос к базе на этап, без ИИ.
- Оборот, повторённый в 3+ секциях статьи. Проблема у всех секций, кроме первой, где он встретился.

**Перепись:**
- Каждая секция с проблемами переписывается один раз той же моделью автора (`text_main`, temperature 0.6, JSON `{html}`), не больше 8 секций на статью.
- Новый текст принимается при трёх условиях: не короче 40 слов, объём 60–150 % от прежнего, проблем стало меньше. Иначе остаётся прежний текст.
- Переписанная секция получает `brief.revised`, и повторного захода не будет.
- Отчёт пишется в `details.revision` этапа: checked, flagged, revised, kept, costUsd, позиции и фразы. Расход также попадает в стоимость этапа через `UsageLog`, как у остальных вызовов.

## 5. Модели рецептов

- **Мета.** В `config.json` добавлено `stageModels.stage_8_meta = "openrouter:google/gemini-2.5-flash-lite"` для рецептов «Ногти — реальные фото», «Волосы — реальные фото», «Одежда · реальные фото».
  - Это та же модель, что уже пишет черновик меты в плане.
  - Мета — короткий JSON с жёсткой проверкой: длины, ключ, год, `{{COUNT}}`. Что модель не доделает, чинится детерминированно: URL, год, тире, Title Case, добор описания. Поэтому качество держится, как и рассуждал аудит (п. 12).
  - Deepseek-v4-flash не выбран: при `maxTokens: 800` модель с рассуждениями рискует оборвать ответ.
  - В портале шаг «SEO-мета» не показывает выбор модели (`STAGE_INFO.meta.promptKeys = []`). Сменить модель можно только в `config.json` или в базе.
- **Объединение двух планов не делалось.** Это затронуло бы реестр этапов, `plan.ts`, `sectionPlan.ts` и распределение рецептов (`enforceDistribution`) — риск выше пользы.
  - Сделано безопасное «половинное» решение: из `rp_photo_plan` убраны все поля структуры и голоса. Они спорили с рецептом `rp_section_plan`.
  - Теперь структуру решает только план секций, а план по фото даёт факты. Это сняло противоречия (`<b>`, форматы A–F против «THE RECIPE IS AUTHORITATIVE») и сократило выход дорогого плана.

## 6. Как правки попадают в базу (сид)

`prisma/seed.mjs`, часть «Pinterest Articles»:
- **Промт без версий** (никто не правил в портале) — текст перезаписывается, как раньше. Сейчас в базе ни у одного промта нет версий, поэтому все 15 изменённых промтов обновятся на ближайшем деплое.
- **Промт с версиями** (правили в портале) — обновляется, только если в `prompts.json` у него есть метка `seedRev` и версии с `changeSummary`, начинающимся на `seed:<seedRev>`, ещё нет.
  - Сид пишет новую версию: «seed:2026-10-15-text-v2 — обновление из prompts.json…».
  - Если текущий текст расходится с последней версией, перед этим сохраняется снимок.
  - История не теряется, прежний текст можно вернуть из версии. Повторный деплой эту метку не применяет, поэтому правки из UI после неё не затираются.
  - Следующую партию правок промтов помечать новой меткой `seedRev`.
- **Поле `seedRev`** в `prisma.artPrompt.create` не передаётся.
- **Рецепты:** дописываются только недостающие ключи `stageModels`. Модель, выбранная в портале, не меняется. Так `stage_8_meta` попадёт в три рецепта.
- **Уже запущенные статьи** работают по снимку рецепта на момент запуска. Новые модель меты и промты действуют для статей, запущенных после деплоя.

## 7. Сухой прогон на готовых статьях (только чтение базы)

7 статей прогона 680241ad, 99 секций. Чистка текущим кодом, в базу ничего не записывалось.

**Итог:** 48 длинных тире, 2 «colour», 2 `</p></p>` (bubble bob, секции 8 и 10) — всё убрано. URL: `chic-micro-french-nails-for-women` → `micro-french-nails`, `cute-butter-yellow-nails-ideas` → `butter-yellow-nails`, `trendy-bubble-bob-looks` → `bubble-bob`.

**Примеры:**
- «…with a high-gloss finish — it's pure sunshine, zero fuss.» → «…with a high-gloss finish. It's pure sunshine, zero fuss.»
- «Blunt bangs with a chin-length bob — who does that actually flatter?» → «Blunt bangs with a chin-length bob. Who does that actually flatter?»
- «ask for a chartreuse or lime — same punch, slightly softer landing» → «ask for a chartreuse or lime, same punch, slightly softer landing»
- «…mood—playful, slightly academic, and entirely deliberate.» → «…mood, playful, slightly academic, and entirely deliberate.»
- «the subtle undertones in the colour create dimension» → «…in the color create dimension»; «Grey and gorgeous.» → «Gray and gorgeous.»
- H2: «Golden Caramel Blonde Shag — Mid-Back» → «Golden Caramel Blonde Shag, Mid-Back»
- Тайтл: из «…Sunny Look» новый код больше не делает «…for a Soft & Sunny» (проверено юнит-тестом). «Mary Jane Shoes Outfits – for Mini Skirts» → «Mary Jane Shoes Outfits for Mini Skirts».

**Стоп-лист на старых текстах.** Нашёл 101 фразу, к переписи 70 из 99 секций. Примеры: butter yellow — «I wore» ×2, «Mine stayed», «I got so many… compliments»; bubble bob — «chair next to mine», «flat by 4», «I am booking»; одежда — «The principle», «the verdict:», «masterclass», «hero piece», «No footwear is visible». Это тексты старых промтов. С новыми ожидается 2–4 секции на статью, плюс есть предел в 8.

**Затёртые обороты сайта** (примеры): волосы — «not a bathroom mirror», «chair next to mine», «i am booking the», «i used to think»; одежда — «is the kind of», «do the heavy lifting», «the principle here is», «the look from feeling». Предметные обороты («a black handbag and», «mary janes with a») фильтром исключены.

Юнит-проверка чистых функций (тире, US-написание, `</p></p>`, URL, стоп-лист, n-граммы, `deTemplateTitle`, `uniqueHeading`, `assembleArticleHtml`) временным tsx-скриптом в `/root/zewex-check`: все проверки прошли, скрипт удалён.

## 8. Цена на статью

База из аудита: текст ≈$0.0095 на статью (автор ≈$0.0018, планы ≈$0.005, мета ≈$0.0027).

| Изменение | Расчёт | Δ на статью |
|---|---|---|
| Мета: gemini-2.5-flash → 2.5-flash-lite | ≈3 вызова × (1,5 тыс. вх. + 0,25 тыс. вых.): $0.0027 → ≈$0.0008; без попыток ради URL и описания 130–139 знаков часто 1–2 вызова | **−$0.0019…−$0.0024** |
| План по фото без полей структуры, опыта и FAQ | ≈−1,3…1,6 тыс. выходных токенов flash-lite ($0.40/M) | **−$0.0005…−$0.0007** |
| Бриф автора без служебных полей | −≈20 % входа автора | **−$0.0003** |
| Стоп-лист и затёртые обороты в system автора | ≈+250 токенов × 4 вызова × $0.09/M | +$0.0001 |
| Перепись плохих секций | ≈$0.00018 за секцию (1,5 тыс. вх. + 0,25 тыс. вых. deepseek-v4-flash); 2–4 секции, максимум 8 | +$0.0004…+$0.0007 (худший случай +$0.0015) |
| Память оборотов, тире, US-написание, URL, `</p></p>` | запрос к базе и код | $0 |
| **Итого** | | **≈ −$0.002…−$0.003** (худший случай ≈ −$0.001) |

## 9. Что проверить после деплоя

1. В логе сида: `articles seed: … prompts (0 new, 0 new seed versions) … recipes (3 with new stage models)`. Версий у промтов сейчас нет, поэтому они обновятся обычной перезаписью.
2. Перегенерировать по 2 статьи каждой ниши: этапы «План по фото» → «План секций» → «Вступление» → «Тексты» → «SEO-мета» → «Сборка». Сравнить по тем же счётчикам: выдумки, «skeptical», «chair next to mine», тире, `colour`, обрубленные тайтлы, URL. Сколько секций переписано, видно в журнале этапа «Тексты секций» (`details.revision`).
3. Если перепись часто отклоняется («проблем не меньше»), значит промт автора всё ещё даёт штампы. Править промт, а не предел.

## Изменённые файлы

- `prisma/seed-data/articles/prompts.json` (15 промтов, метка `seedRev`)
- `prisma/seed-data/articles/config.json` (`stage_8_meta` в трёх рецептах)
- `prisma/seed.mjs` (часть «Pinterest Articles»: версии промтов от сида, недостающие `stageModels`)
- `src/lib/articles/text/polish.ts` (новый)
- `src/lib/articles/text/textGuards.ts`, `html.ts`, `slug.ts`, `vars.ts`
- `worker/articles/stages/sections.ts`, `meta.ts`, `introOutro.ts`, `assemble.ts`, `sectionPlan.ts`
- `docs/articles-migration/audit-2026-10-14/text-v2.md` (копия аудита), этот файл
