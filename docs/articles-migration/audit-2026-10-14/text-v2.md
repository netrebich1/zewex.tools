# Аудит текстов, раунд 2: ногти, волосы, одежда (15.10.2026)

Что проверено:
- 12 готовых статей. Прогон 680241ad (после правок P0): micro french, butter yellow, curly shag, bubble bob, pleated skirt, bomber jacket, mary jane. Прогон 2f7e7129 (14.10, до P0): hush cut, baby bangs, 90s blowout, denim jacket, cargo pants.
- Для сравнения 9 статей раунда 1 (прогон 97c16bc6).
- Статьи chrome french, sleek low bun и ещё 6 стоят на проверке фото (PHOTO_REVIEW), текста у них пока нет.
- 12 фото сверены с текстом глазами.
- Промты в базе совпадают с `prisma/seed-data/articles/prompts.json` побайтно. Сид перезаписал их 15.10 в 17:27, то есть работают именно промты из файла.
- В проекте и базе ничего не менялось.

## Коротко

- **Правки P0 сработали там, где были ошибки кода.**
  - H1 теперь везде начинается с числа: «12 Micro French Nails…».
  - Склеенных H2 больше нет.
  - Мета-описание не обрывается на полуслове.
  - Вступление и заключение проходят проверку.
- **Сами тексты почти не изменились: 5–6 из 10.** Промты (пункты P1 прошлого аудита) не правили, поэтому выдуманный опыт, штампы и длинные тире остались. Длинных тире даже стало больше: 52 на 7 статей против 29 на 9.
- **Найдена новая причина выдумок: их пишет планировщик, а не только автор.**
  - Промт плана требует поле `real_experience`: «первое лицо, конкретно».
  - Gemini-flash-lite сочиняет готовую фразу, например «I wore these to a summer wedding».
  - Автор (deepseek) вставляет её почти дословно.
  - Код при этом прямо запрещает выдумывать (`sections.ts:128`, `:150`), но две команды против одной проигрывают.
- **Расхождения текста с фото рождаются раньше автора, на этапе оценки фото.**
  - Факты пишет gemini-flash-lite, по 8 фото за один вызов.
  - Из 12 проверенных фото факты неверны в 5. Например, бриллиант кольца стал «стразами у кутикулы», коричневые кончики — «синими».
  - Автор фото не видит и честно пересказывает ошибку.
- **Новый баг кода ломает SEO-тайтлы.**
  - Примеры: «Butter Yellow Nails for a Soft & Sunny», «Bubble Bob Haircuts for a Chic & Trendy».
  - Модель дописала «…Look», а `deTemplate` (`meta.ts:517-529`) вырезал «Look» как слово-пустышку. Получились 2 обрубка из 7.
- **Всё ниже можно сделать без роста цены.** Текст статьи сейчас стоит ≈$0.007–0.012:
  - план фото ≈$0.002–0.0045 (это дороже самого автора);
  - мета ≈$0.0027;
  - секции ≈$0.001–0.0024.

  Экономия на мете и плане покрывает все добавки: проверку фактов фото по одному, повторную запись плохих секций и память фраз.

---

## 1. Оценки по нишам

| Ниша | Раунд 1 | Сейчас | Главное |
|---|---|---|---|
| Ногти | 5–6 | **5** | Выдуманный опыт в 8 из 10 секций butter yellow. Ошибки фактов по фото и технике. Полезные «скажи мастеру» есть, но тонут в байках |
| Волосы | 5 | **6** | Лучшая ниша по пользе: кому подходит, уход, частота стрижки. Но все 5 вступлений начинаются одинаково, «персона» противоречит себе, не все фото совпадают с текстом |
| Одежда | 5–6 | **6** | Точнее всех по фото, выдумок почти нет. Но шаблон «The principle:», нет советов по посадке, фигуре и обуви, слабые вступления и концовки, много длинных тире |

### 1.1 Ногти: 5/10

**Что не так**

- **Выдуманный опыт.** Его сочиняет план, автор копирует.
  - butter yellow: «I wore these to a summer wedding», «These were my go-to for a summer road trip», «I wore these to a picnic», «Mine stayed perfect for 12 days straight».
  - micro french: «I got three weeks», «I got so many compliments on these», «That is what the tech told me».
  - Сроки носки в каждой секции разные (7, 10, 12, 14, 21 день) и ничем не подтверждены.
- **Текст против фото.**
  - micro french, секция 7 («Short Almond Blue Micro French with Gems»): на фото короткие ногти с тёмно-коричневыми кончиками, страз нет. «Стразы» — это камень кольца. Текст целиком построен на стразах: «plan to lose a rhinestone or two by day five».
  - butter yellow, секция 8 («Matte…Polka Dots»): на фото глянец с бликами, а текст про «matte».
  - Оба факта неверны уже в `ArtPhoto.facts`: ошибся этап оценки, не автор.
- **Фактические ошибки в уходе.**
  - «Non-acetone remover for softer nails»: гель-лак без ацетона не снимается.
  - «Chrome powders adhere best to a tacky gel surface»: втирку обычно наносят на топ без липкого слоя.
  - «Three beads of red polish, not two»: «бусины» бывают у акрила, к лаку это не относится.
  - «About 90 minutes in the chair» за micro french: преувеличение.
- **Штампы.** Почти все взяты из промта дословно:
  - «I was skeptical» встречается в 5 статьях из 7;
  - «I'll admit» — 7 раз;
  - «not a Sunday afternoon project»;
  - «After writing all of these, I am…booking»;
  - «doesn't shout».
- **Тайтл butter yellow обрублен** (баг `deTemplate`, см. раздел 3).
- **Мета** начинается одинаково: «X nails offer a fresh and cheerful vibe. Discover 10 nail looks…». «Discover {{COUNT}}» стоит в 7 из 7 описаний.
- **Слаги с мусором:** «chic-micro-french-nails-for-women», «cute-butter-yellow-nails-ideas».

**Что хорошо**
- Уход в концовке (масло, обновление топа) полезен.
- Есть советы «скажи мастеру».
- Указано, какому подтону кожи подходит цвет.
- Микро-френч с коричневым кончиком (секция 12) описан точно.

**Что нужно читателю ногтей:** форма + длина + цвет/отделка (с фото), как попросить мастера (2–3 конкретных слова), реально ли сделать дома и чем, сколько обычно держится такая отделка (общая норма, без «у меня»), кому идёт оттенок, чем рискует дизайн (сколы, цепляние, снятие).

### 1.2 Волосы: 6/10

**Что не так**

- **Одинаковое начало всех вступлений.** Все 5 новых вступлений открываются фразой «I keep seeing it in the chair next to mine». Это пример из промта (`prompts.json:259`: «a cut she keeps seeing in the salon chair next to hers»).
- **«flat by 4 pm» в 4 статьях из 5.** Это примета персоны Норы из промта (`prompts.json:270`).
- **Концовка «I am booking the collarbone version with curtain bangs next» дословно в 3 статьях** (hush cut, italian bob, wolf cut) и почти так же в curly shag.
- **Персона противоречит себе внутри одной статьи** (curly shag):
  - «My fine hair goes flat by 4 pm»;
  - «I have thick hair»;
  - «My waves are more 2B than 3A»;
  - «My own dark brown shag».
- **Текст против фото.**
  - bubble bob 3 («Ash Blonde Bob With Curtain Bangs»): на фото золотисто-медовый прямой боб с плотной чёлкой, без волн и без шторки.
  - curly shag 2 («…With Curtain Bangs», «middle part»): на фото рваная плотная чёлка, снимок в профиль.
  - bubble bob 16 («grazing the ears»): на фото длина до подбородка.
  - Во всех трёх ошибка уже в фактах оценки фото.
- **Тема раскрыта не до конца.**
  - bubble bob: половина секций — обычные бобы (блант, волны, платина с чёлкой). Что такое bubble bob, объяснено только в секции 5.
  - Тайтл «Bubble Bob Haircuts for a Chic & Trendy» обрублен.
- **Сомнительный совет из примера в промте.** «A middle part widens a round face» стоит в hush cut как плюс: «widens a round face nicely». Расширять круглое лицо обычно не стараются.
- **Британское «colour»:** curly shag 2 раза, 90s blowout и hush cut 7 раз. Сайт американский. Промт волос сам написан с «colour».
- **Битый HTML.** В bubble bob секции 8 и 10 заканчиваются на `</p></p>`. Ошибка дошла до готового HTML статьи.

**Что хорошо**
- Почти каждая секция говорит, кому подходит стрижка (густота, текстура, форма лица) и как часто стричься.
- Есть что сказать мастеру: «keep the internal layers soft».
- Верные советы: «layers cut on dry curls», тонировать пепельный.

**Что нужно читателю волос:** что это за стрижка или техника (одной фразой, в первой секции или во вступлении), кому идёт (форма лица, густота, текстура), как попросить мастера (2–3 термина), сколько времени на укладку и чем укладывать, как отрастает и через сколько недель стричь или тонировать, какой длины волосы нужны изначально.

### 1.3 Одежда: 6/10

**Что не так**

- **Шаблонные связки.**
  - «The principle:» / «The principle here» — 8 раз в 3 статьях; в прогоне 2 — 14 раз.
  - «Here's the verdict» / «The verdict is» — 7 раз.
  - «masterclass» — 3 раза.
  - «intentional/deliberate rather than accidental» — 8 раз.
  - «without trying too hard» — 5 раз.
  - «does the heavy lifting» — 10 раз в прогоне 2.
- **Длинные тире:** 11–14 на статью. Промт одежды их не запрещает, стоп-листа в нём нет вообще (`prompts.json:424`, 616 символов против 9500 у ногтей).
- **Служебные слова попадают в текст:**
  - «when your hero piece is short and bold»;
  - «Picture this:» 2 раза;
  - «No footwear is visible here» — описание кадра попало в текст.
- **Текст против фото.** bomber 14: H2 «…with Pleated Mini Skirt», текст «dark blue pleated mini skirt». На фото джинсовая мини с бахромой. Факты оценки противоречат сами себе: «pleated» и «denim». Остальные 3 проверенных фото одежды описаны точно (pleated 14, bomber 3).
- **Нет главной пользы.**
  - Посадка, длина относительно роста, какая обувь к какой длине, что делать при широких бёдрах или низком росте. Промт и бриф это запрещают (`sections.ts:126`: «NEVER mention…sizing or fabrics»).
  - Нет «где искать» на уровне категорий («ищите плиссе миди из плотного трикотажа»).
- **Вступление и концовка — общие слова.**
  - «We've rounded up», «Whether you're…», «effortlessly chic».
  - Концовка mary jane — 37 слов без единого совета, «Your next outfit starts at your feet».
  - Списков-правил в концовке нет, в отличие от ногтей и волос.
- **Тайтл mary jane с ошибкой:** «Mary Jane Shoes Outfits – for Mini Skirts…». Тот же `deTemplate`: двоеточие заменено на тире.

**Что хорошо**
- Вещи на фото названы точно: цвет, крой, обувь, сумка.
- Каждая секция заканчивается правилом стиля. Правило полезное, плох только одинаковый зачин.
- Выдуманного опыта почти нет: в промте одежды нет «персоны с опытом».

**Что нужно читателю одежды:** вещи образа списком, крой и посадка главной вещи, какая обувь и почему (длина/пропорции), для какого случая и сезона, кому подходит и как адаптировать (рост, фигура — без оценок тела), как повторить из своего гардероба / что искать (категории, не бренды).

---

## 2. Что изменили правки P0 (сравнение с раундом 1)

| Что | Раунд 1 (9 статей) | Сейчас (7 статей) |
|---|---|---|
| H1 с числом в середине («Fuzzy 13…») | 1 | 0 ✔ |
| Склеенные H2 («Black Pointed-Toe Heels Professional…») | 6 | 0 ✔ |
| Мета, оборванная на полуслове | 2+ | 0 ✔ (hush cut и baby bangs из прогона 2 ещё оборваны, они до P0) |
| Висячий текст без `<p>` | 1 | 0 ✔, но появился лишний `</p></p>` (bubble bob ×2) |
| Обрубленный SEO-тайтл | 0 | **2 + 1 с « – for»** ✘ новый баг |
| Длинные тире в тексте | 29 | **52** ✘ |
| «I was skeptical» / «I'll admit» | 6 / 5 | 9 / 7 ✘ |
| «flat by 4 pm» (волосы) | 5 | 3 (в 2 из 2 статей о волосах) ✘ |
| «I keep seeing… chair next to mine» | 3 | 4 (во всех новых про волосы) ✘ |
| Секции с выдуманным опытом (ногти) | 30–40% | butter yellow 80%, micro french 25% ✘ |
| «effortless» / «stunning» | 10 / 5 | 3 / 0 ✔ (заслуга нового промта меты) |

Итог: правки кода дали ровно то, что обещали. Качество самого текста определяют промты, а их ещё не трогали.

---

## 3. Причины в коде и промтах (file:line)

1. **Выдумки заказывает план.**
   - Промт плана ногтей, `prompts.json:599`: «real_experience: Maya's first-person claim, specific and plausible». Там же «Plan every section as if Maya writes it: first person… real wear times».
   - То же для волос, `prompts.json:203`.
   - План ещё сочиняет `estimated_wear_time` и `transition_from_previous`, хотя в кадре этого нет.
   - Всё это уходит автору в бриф (`sections.ts:108-117` выводит все поля плана).
2. **Выдумки заказывает автор.**
   - Ногти, `prompts.json:666`: персона Maya, «She says "my chrome dulled by day 4"», блок MAYA'S REACTION («They said two weeks. Mine held 17 days»), «real_experience: Maya's first-person test claim… personal experience beats general knowledge».
   - Волосы, `prompts.json:270`: Nora, «flat by 4 pm», «my roots showed at week five».
   - Код против этого (`sections.ts:128`, `:150`), но проигрывает.
3. **Примеры фраз копируются дословно.** «chair next to hers» и «which one she is actually booking next» (`prompts.json:259`, `:655`); «not a Sunday DIY», «bathroom-mirror job» (`:666`, `:270`); «a middle part widens a round face» (`:270`).
4. **Факты фото неверны на этапе оценки.**
   - `worker/articles/stages/rate.ts:136`, `:314`: 8 фото в одном вызове gemini-2.5-flash-lite. Модель путает, какой факт к какому фото, и принимает кольцо за стразы.
   - `src/lib/articles/photo/profile.ts:159` и `photoFactSkeleton` (`:682`): описание поля уходит модели как образец значения. В фактах micro french 7 так и записано: «craft: visible execution quality — line cleanliness, cuticle work, evenness».
5. **Автор не видит фото.** В рецептах `writerMode: "description"`. К тому же `sections.ts:162-167` (`modelSupportsVision`) считает любую deepseek текстовой, даже если у модели есть зрение.
6. **Обрубленный тайтл.** `meta.ts:137` (`FILLER_RE` включает look/looks/ideas) + `meta.ts:517-529` (`deTemplate` вырезает слово и меняет «:» на « — »). Проверки, что после вырезания фраза не оборвалась, нет.
7. **Одежда без голоса и правил.** `prompts.json:424` (автор), `:435` (секции), `:413` (вступление и концовка). Нет стоп-листа, запрета тире, объёма концовки и требования практических советов.
8. **Противоречивые указания автору.** Бриф велит «NO emphasis — never use <b>» (`sections.ts:129`), промт ногтей — «Bold each assigned keyword with <b>» (`prompts.json:666`). Бриф велит «THE RECIPE ABOVE IS AUTHORITATIVE» (`sections.ts:121`), а промт — форматы A/B/D/E/F. Два плана (`rp_photo_plan` и `rp_section_plan`) дают разные указания о структуре и зачине. Модель выбирает между ними случайно.
9. **`</p></p>`.** `balanceParagraphs` (`textGuards.ts:267`) вызывается только из `stripLeadingFactDump`, а не для каждой секции.
10. **Слаги с мусором** («cute-…-ideas», «trendy-…-looks», «chic-…-for-women»). Модель меты, в коде нет запрета.

---

## 4. Улучшения без роста цены (по приоритету)

Цены моделей сняты с OpenRouter 15.10. Расход взят из `UsageLog` по 7 статьям прогона 680241ad:
- автор, `text_main`: в среднем 6,6 вызова, ≈5300 входных и ≈520 выходных токенов на вызов, ≈$0.0018 на статью;
- планы, `text_fast`: 4 вызова, ≈2400 входных и **≈2500 выходных**, ≈$0.005;
- мета на gemini-2.5-flash: ≈3 вызова, ≈$0.0027.

Итог: текст ≈$0.0095 на статью.

### P0 — код, бесплатно

**1. Починить обрубленные тайтлы.** $0.
- В `meta.ts:517-529`: если после вырезания пустышки тайтл кончается на предлог, артикль, «&» или прилагательное («for a», «& Trendy»), не вырезать, а вернуть исходный вариант модели.
- В `FILLER_RE` оставить «look/looks» только в сочетании «X Looks» в начале, но не «…Look» в конце фразы.
- Двоеточие менять не на тире, а на пробел (или просить переписать в той же попытке валидации).

**2. Детерминированная чистка всех секций, вступления и концовки (без ИИ).** $0.
- Длинное и среднее тире между словами заменять на «, » (перед пояснением — на «: »). В заголовках с хвостом через тире (код `uniqueHeading`) ставить запятую или скобки.
- `colour → color`, `favourite → favorite`, `-ise → -ize` (американская орфография).
- `balanceParagraphs` вызывать в `cleanArticleHtml` для каждой секции, это уберёт `</p></p>`.
- Слаг: убирать `cute|trendy|best|chic|ideas|looks|designs|for-women`, если их нет в ключе.

**3. Не печатать служебные поля плана автору.** Экономит ≈$0.0008.
- В `BRIEF_SKIP` (`sections.ts:98`) добавить `real_experience`, `estimated_wear_time`, `transition_from_previous`, `stylist_score`, `color_palette` (hex-коды), `hero_piece`, `style_verdict`.
- Это убирает источник выдумок сразу, ещё до правки промтов.
- Бриф станет короче примерно на 20–25% входа автора: −$0.0003.

### P1 — промты

Цена ±0, а за счёт удалённых полей плана −$0.0005. Ключи — id в `ArtPrompt`, правка в `prompts.json` и далее сидом.

**4. План ногтей и волос** (`rp_photo_plan`, ногти `b59ca1bd…` `prompts.json:599`, волосы `4a2f81a7…` `:203`).
- Заменить
  > The writer persona is Maya… Plan every section as if Maya writes it: first person, specific, real wear times…

  на
  > The writer is an experienced nail editor who explains, never claims personal testing. Plan facts that come from the photo description only.
- Удалить из схемы поля `real_experience`, `estimated_wear_time`, `transition_from_previous`, `standalone_sentence`, `color_palette`, `stylist_score`.
- Вместо них одно поле: `"ask_for": "2-6 words the reader can say to the tech, built from visible facts"`.
- Выход плана сократится примерно на треть: −$0.0008.

**5. Автор ногтей** (`stage_7_writer_system`, `9d6340d3…`, `prompts.json:666`).
- Блок WHO MAYA IS заменить на:
  > VOICE: a seasoned US nail editor talking to a friend. Second person and plain statements ("ask for…", "this finish usually dulls around day 5"). First person is allowed at most once per article and never as a claim of wearing, testing, booking, a wedding, a trip or compliments. Never state how long a design lasted for you; give typical ranges as general knowledge ("gel chrome typically lasts 2-3 weeks").
- Удалить целиком блоки MAYA'S REACTION и E-E-A-T LINES → real_experience. Пример из STANDALONE BEAT «confession: I stared at this shade…» заменить на «verdict: Best grow-out in this roundup.».
- В конец промта:
  > Never reuse these phrases or close variants: "I was skeptical", "I'll admit", "not a Sunday", "after writing all of these", "I'm booking", "doesn't shout", "catches the light", "the ultimate", "game-changer", "non-negotiable".
- Добавить:
  > ACCURACY: gel and chrome are removed with acetone soak-off; chrome powder goes on a cured no-wipe top coat; do not invent technique terms.

  Это закрывает найденные ошибки.
- Обязательный каркас каждой секции:
  > Every section must contain: (1) one sentence on what the design is, using only the photo facts; (2) one "ask your tech for: …" or DIY line; (3) one honest risk or upkeep line.

**6. Автор волос** (`22b94976…`, `prompts.json:270`).
- То же: убрать персону Норы с «flat by 4 pm», «roots at week five», «bleach job on a Tuesday», убрать NORA'S REACTION. Голос: «experienced stylist-editor, no personal claims».
- В начало:
  > Use American spelling (color, not colour).
- Добавить:
  > If the photo facts say bangs are "full", "blunt" or "wispy", never call them curtain bangs; never state a length that differs from the facts.
- Убрать пример «a middle part widens a round face». Вместо него:
  > Face-shape advice must be standard: a middle part and length below the chin elongate a round face; volume at the sides suits long faces.
- Каркас секции:
  > Every section: who it suits (face shape OR density/texture), what to ask the stylist (2-4 exact words), styling time and tools, grow-out/trim rhythm in weeks.

**7. Вступление и концовка, ногти и волосы** (`b0e6dbb4…` `:655`, `4de1da12…` `:259`).
- Удалить «a cut she keeps seeing in the salon chair next to hers», «why Maya/Nora cares: one specific detail from her own… history», «honest_admission (which one she is actually booking next)».
- Вместо них:
  > P1: open with one concrete trend fact from trend_details (a shift in color, length or finish), not with "I keep seeing". P2: who each group of designs suits. CONCLUSION: one practical decision rule ("short nail beds: pick the micro tip and an almond shape") + the care list. No "I'm booking", no "after writing all of these".
- Для волос в P1:
  > define the cut/technique in one sentence.

**8. Одежда: автор, секции, вступление и концовка** (`c1a11005…` `:424`, `c1a11006…` `:435`, `c1a11007…` `:413`).
- Автор, дописать в текст:
  > Write in American English, second person and plain statements. No em dashes or en dashes. Never use: "the principle", "here's the verdict", "masterclass", "intentional rather than accidental", "without trying too hard", "heavy lifting", "hero piece", "picture this", "effortless", "chic", "elevate", "whether you're", "we've rounded up", "vibe". Never describe what is not visible ("no footwear is visible"). Each section: 1) the pieces and fit of the main item; 2) why the shoes/length/proportion work; 3) one "who it suits / how to adapt it" line (height, proportions, without judging bodies); 4) one "to recreate it, look for…" line naming categories, never brands or shops. Vary how each section closes; never start the closing sentence the same way twice in an article.
- В `sections.ts:126` убрать «sizing or fabrics» из запрета. Запрет брендов, цен и магазинов оставить. Тогда «посадка» и «плотный трикотаж» станут разрешены.
- Вступление и концовка:
  > CONCLUSION 80-120 words: 3-4 bullet rules (shoe/length pairing, proportion, color, season) + one closing sentence.

**9. Факты фото без шаблона** (`profile.ts:159` и аналоги у волос и одежды). В `photoFactSkeleton` давать пустые значения `""`, а описание полей выносить отдельной строкой: «craft = …». Тогда модель не скопирует подсказку в факт. $0.

### P1 — проверки после записи (дёшево)

**10. Стоп-лист + одна дешёвая перепись только плохих секций.** +$0.0003…0.0006 на статью.
- В `textGuards.ts` завести список из 40–60 фраз: выдумки «I wore|I tried|I tested|mine held|my go-to|compliments|the tech told me|I'm booking», штампы из разделов 1.1–1.3, служебные «hero piece|picture this|no .* is visible».
- После `sections` и `intro_outro` найти секции с совпадениями. Каждую переписать одним вызовом той же deepseek-v4-flash с инструкцией «remove these phrases, keep facts, same length». Повторять не больше одного раза.
- Одна секция стоит ≈1,5 тыс. входных и 200 выходных токенов, ≈$0.00017. После правки промтов ожидается 2–4 секции на статью.
- Схема повтора уже есть в `introOutro.ts:110-130`: ту же схему поправок можно взять для секций.

**11. Память фраз между статьями.** ≈+$0.0001.
- Раз в сутки (или при запуске этапа) SQL-запросом брать тексты последних ~30 статей сайта в этой нише. Считать повторяющиеся 4–5-словные обороты, которые есть в 3+ статьях: «chair next to mine», «booking the collarbone version».
- Топ-20 передавать автору строкой «Overused on this site, do not use: …» (≈150 токенов на вызов) и добавлять в стоп-лист из п. 10.
- ИИ не нужен, только запрос к базе и подсчёт в коде.

### P2 — факты фото и модели

Цена нейтральна за счёт п. 12.

**12. Мета на дешёвую модель.** −$0.0024 на статью.
- Сейчас мета идёт по правилу слота на gemini-2.5-flash ($0.30/$2.50) и делает ≈3 вызова.
- В рецептах в `stageModels` добавить шаг меты (`STAGE_KEY` в `meta.ts:455`) = `openrouter:deepseek/deepseek-v4-flash` ($0.09/$0.18) или `google/gemini-2.5-flash-lite` ($0.10/$0.40). Код при этом не меняется.
- Допуск описания расширить до 130–160 знаков, чтобы не тратить повторы на 137 символов.
- Это главный источник экономии под п. 13–14.

**13. Перепроверка фактов выбранных фото по одному.** ≈+$0.003, покрывается п. 12.
- После `select` для каждого из 10–20 выбранных фото сделать ОДИН вызов gemini-2.5-flash-lite с ОДНИМ фото (не пачкой). Промт: «верни только форму/длину/цвет/отделку/декор (ногти) | длина/чёлка/цвет/текстура/пробор (волосы) | вещи/обувь/фасон (одежда), "" если не видно».
- Если поле расходится с фактами оценки, переписать `ArtPhoto.facts` и H2 из плана.
- Стоимость: ≈1,5 тыс. входных и 120 выходных токенов на фото ≈ $0.0002, на 15 фото ≈ $0.003.
- Ровно это исправило бы 5 из 12 найденных расхождений: кольцо вместо страз, шторка вместо плотной чёлки, мат вместо глянца, джинса вместо плиссе.

**14. (Вместо п. 13 или вместе с ним) A/B автора со зрением при той же цене.**

Сейчас автор не может получить фото: `modelSupportsVision` (`sections.ts:165`) считает любую deepseek текстовой. Кандидаты (вход/выход за 1 млн токенов):

| Модель | Цена | Зрение | Оценка на статью с 15 фото |
|---|---|---|---|
| deepseek/deepseek-v4-flash (сейчас) | $0.09 / $0.18 | нет | ≈$0.002–0.004 |
| deepseek/deepseek-v4.1-flash | $0.022 / $0.72 | да | ≈$0.003–0.0035 (вход дешевле в 4 раза) |
| qwen/qwen3.7-flash | $0.03 / $0.13 | да | ≈$0.002 |
| anthropic/claude-haiku-5.5 | $0.10 / $0.50 | да | ≈$0.0065 (+$0.003), английский заметно чище |
| google/gemini-2.5-flash-lite | $0.10 / $0.40 | да | ≈$0.006 |

- Предложение: в `modelSupportsVision` разрешить модели, у которых на OpenRouter есть вход «image» (или явный список).
- Прогнать по 1 статье каждой ниши этапом «Тексты секций» на v4.1-flash и haiku-5.5 с `writerMode: "vision"` и сравнить.
- Если v4.1-flash не хуже текущей, перейти на неё: цена та же, автор видит фото.
- Качество моделей по документации не проверить, нужен прогон.

**15. Убрать дублирующий план.** −$0.0015…0.002, требует проверки.
- `rp_section_plan` (отдельный вызов flash-lite) заново задаёт угол, зачин, длину и списки и спорит с `rp_photo_plan`.
- Варианты: оставить один план, перенеся `recipe` (angle/opener/length/include_*) в схему `rp_photo_plan`; или оставить section_plan и удалить из photo_plan поля format/voice_seed/sentence_rhythm/angle_note.
- Одновременно убрать противоречие о `<b>` между `sections.ts:129` и `prompts.json:666`.

**16. Температура автора** `sections.ts:279`: 1 → 0,8 (у вступления уже 0,8, `introOutro.ts:79`). Меньше опечаток и случайных оборотов. $0.

### Итог по цене (на статью)

| Шаг | Изменение |
|---|---|
| 1, 2, 9, 16 (код) | $0 |
| 3–8 (промты и бриф) | −$0.0008…−$0.001 |
| 10 (перепись плохих секций) | +$0.0003…0.0006 |
| 11 (память фраз) | +$0.0001 |
| 12 (мета на дешёвую модель) | −$0.0024 |
| 13 (факты по одному фото) | +$0.003 |
| 15 (один план) | −$0.0015 |
| **Итого** | **≈ −$0.001…+$0.0002, то есть без роста** |

Если п. 14 выиграет v4.1-flash, п. 13 можно оставить только для ногтей и волос (у одежды факты точнее). Тогда выйдет ещё ≈−$0.002.

---

## 5. Порядок работ

1. Код без ИИ (п. 1, 2, 3, 9, 16) — за один заход, это сразу уберёт обрубленные тайтлы, тире, colour, `</p></p>` и половину выдумок (через `BRIEF_SKIP`).
2. Промты (п. 4–8) — в `prompts.json`, сид. Перегенерировать тексты 2 статей каждой ниши (этапы «План» → «Тексты» → «Вступление»), сравнить по тем же счётчикам: выдумки, «skeptical», «chair next to mine», тире.
3. Мета на дешёвую модель (п. 12) и стоп-лист с перепиской (п. 10, 11).
4. Факты фото (п. 13) и A/B автора со зрением (п. 14), затем решение по одному плану (п. 15).

Целевой уровень после шагов 1–3: ногти и волосы 7/10, одежда 7/10. Чтобы выйти выше 7, нужны верные факты фото (шаг 4).
