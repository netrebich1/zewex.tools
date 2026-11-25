# Правки текстов по аудиту text-v3 (15.10.2026, раунд 4)

Основание: `text-v3.md` (аудит раунда 3: все ниши 6,5/10, текст ≈$0.0105 на статью) и `text-fixes-v2.md` (прошлые правки).
Ничего не задеплоено и не закоммичено, база только читалась. Проверка типов в копии `/root/zewex-check`: `tsc -p tsconfig.worker.json` без ошибок, `tsc` без ошибок в файлах статей (единственная ошибка — чужой неотслеживаемый `scripts/pins/photo-score-test.ts`).

## Коротко

- **Факты фото больше не содержат текст схемы.** Описания полей убраны из образца JSON в промте оценки фото, значения-заглушки и копии описаний отсеиваются при записи и при чтении (старые записи в базе чистятся на лету).
- **H2 без мусорных хвостов** («, None», «, The Single Detail A Reader Notices First», «, Shimmer High Gloss»).
- **Пунктуация.** Автор видит затёртые обороты со знаками препинания. Секция длиннее 50 слов без запятой — дефект, уходит в перепись. Тире перед целым предложением становится точкой.
- **Проверка после записи без ложных срабатываний.** Числа словами и обязательные обороты каркаса больше не считаются штампами. Предел переписи — половина секций (8–12). Стоп-лист видит изогнутый апостроф, новые штампы и потолок «rather than» / «reads as» на статью; проверяются ещё вступление, заключение и мета.
- **Мета и H1.** Title Case после дефиса, тайтл короче 40 символов — повтор, точный ключ в H1, запретные слова (stunning, elevate, effortless, chic, dreamy…).
- **Ключ без «склеек».** Автор больше не получает «Keyword to weave» и `keywords_to_bold`: ключ только естественным английским или никак.
- **План по фото похудел.** Ногти и волосы: ≈16 коротких полей на секцию вместо ~30. Одежда: без `styling_tips` и `fashion_details`.
- **Точность ниш.** Ногти: без подтона кожи, кошачий глаз — магнит над невысохшим гелем, у гель-лака нет «fill» и обновления топа. Волосы: «Ask your colorist/stylist for» в каждой секции. Одежда: обувь только из фактов, в «look for» — вещь из ключа.
- **Цена:** ногти и волосы ≈ −$0.0015…−$0.0025 на статью (≈$0.0095–0.0104 вместо ≈$0.0119), одежда ≈ без изменений (≈$0.0075). В среднем ≈$0.009 вместо ≈$0.0105.

## 1. P0, код ($0)

### 1.1 Факты фото: описание поля вместо значения

**Причина.** `rate.ts` вставлял в образец JSON не пустой скелет, а `photoFactFields` — описания полей без кавычек: `"facts":{"craft": visible execution quality — line cleanliness…}`. Модель повторяла образец.

| Что | Где |
|---|---|
| Описания полей вынесены в чистый модуль без базы | `src/lib/articles/photo/factSanitize.ts` → `PHOTO_FACT_DESCRIPTIONS` (профили в `profile.ts` ссылаются на них) |
| В образце JSON — только скелет `"craft":""`, описания — отдельным списком «FACT FIELDS» с запретом копировать, без примеров «(e.g. "medium almond")», «нет — пустая строка, не "none"/"n/a"/"any"/"visible"» | `profile.ts` → `photoFactFields`, `photoFactRules`; `worker/articles/stages/rate.ts` (оба промта), `text/photoDescribe.ts` |
| Чистка значений: «none», «n/a», «any», «visible», «…», `<…>`, обрывки схемы («only if visible», «the single detail», «e.g.»), строки с `"…" \| "…"`, перечень 3+ вариантов из описания, копия описания (целиком, первые 3 слова «инструкции», сама инструкция внутри, кусок 5+ слов и половина описания). Варианты из самого описания («back view, close crop», «both hands, close macro») остаются | `factSanitize.ts` → `isPlaceholderFact`, `sanitizeFacts` |
| Где чистится | при записи: `ranking.cleanFacts` (этап оценки), `photoDescribe`; при чтении: `vars.factsLine` (бриф автора, таблицы фактов планов, перепись), `vars.photosTable` (план по фото), `plan.ts` (детали образа и интерьера), `textGuards.factWords` (хвосты H2) |

**Сухой прогон на bf37757f** (6235 значений фактов фото и кандидатов):
- выброшено 358 значений: craft 132, occasion 71 («none», «any»), decor 64 («none» и копия описания), colors/finish/framing/standout/difficulty по 15, shape_length 7;
- у ногтей поле `craft` выброшено у 32 из 57 фото: 20 точных копий «visible execution quality — line cleanliness, cuticle work, evenness», остальное — «visible» и та же копия с хвостом;
- примеры выброшенного: `standout: the single detail a reader notices first`, `difficulty: "diy" | "salon" | "salon-leaning" + why in a few words`, `finish: glossy / matte / shimmer / chrome / jelly / cat-eye / glitter density`, `shoes: none visible`;
- оставлены нормальные значения: `framing: back view, close crop`, `framing: both hands, close macro`, `difficulty: salon`, `bangs: no bangs`.

### 1.2 Хвосты H2

`src/lib/articles/text/textGuards.ts` → `factWords`, `uniqueHeading`:
- факты проходят `sanitizeFacts`;
- в хвост не идут поля-мнения о кадре: craft, difficulty, framing, standout, occasion;
- значения с «none/any/visible/no», «/ | + &» отбрасываются, от перечня берётся первая часть;
- из описания фото не берутся целые предложения (с глаголом) и фразы про кадр (фон, рука, свет, поза, свитер, кольцо);
- слова хвоста сравниваются с заголовком без окончания -s («Almonds» и «Short Almond» — повтор).

**Было → стало** (сухой прогон):
- «Soft Pink French Almonds, The Single Detail A Reader Notices First» → «Soft Pink French Almonds, Close-Up Take»;
- «Milky White Pearl Chrome Almond Nails, None» → «Milky White Pearl Chrome Almond Nails, Ethereal Glow»;
- «Pearlescent White Almond Iridescent Nails, Shimmer High Gloss» → «…, Close-Up Take».

### 1.3 Пропавшая пунктуация

- **Обороты со знаками.** `polish.ts` → `surfaceForm`: оборот ищется в исходных текстах и показывается как есть. Память сайта (`sections.ts` → `loadSitePhraseMemory`) возвращает и n-граммы, и их вид со знаками. Автор и перепись получают «is not a DIY», «to recreate it, look for», а не «is not a diy», «to recreate it look for».
- **Секция без запятых — дефект.** `polish.ts` → `lacksPunctuation`: больше 50 слов и ни одной запятой. Проблема `no commas (punctuation lost)` идёт в перепись первой, с отдельной инструкцией «восстановить запятые, апострофы, вопросительные знаки».
- Сухой прогон: leather skirt, секции 11, 12, 13, 14 (вся 3-я пачка автора) — найдены. Раньше эти секции переписывались из-за ложной «to recreate it look for», и запятые не возвращались.
- В промтах авторов и в `BANNED_PROMPT_LINE` добавлено: «Normal punctuation: commas between clauses, apostrophes in possessives, a question mark after a question».

### 1.4 Ложные срабатывания проверки после записи

| Что | Как |
|---|---|
| Числа словами («every four to six», «for two to three») | `NUMBER_WORDS` в `templateLike`: one…twelve, twenty, few, couple, half, dozen, once, twice… |
| Обязательные обороты каркаса | `STRUCTURAL_RE`: «To recreate it, look for», «Ask your tech/colorist/stylist for», «look for a/an/the» вырезаются из поиска шаблонов, n-грамма через них не строится. В `SKELETON_WORDS` добавлено `recreate` |
| Изогнутый апостроф | `plainText`: `’ ‘ “ ”` и HTML-сущности → прямые знаки до проверки стоп-листа («Whether you’re» во вступлении pearl теперь ловится) |
| Предел переписи | `revisionCap(n)` = половина секций, от 8 до 12. Порядок: сначала потеря пунктуации, потом по числу находок. В отчёте `details.revision.cap` |
| Ключ статьи | слово из ключа не считается штампом («costume nails») |

**Новые штампы в `BANNED`** (`polish.ts`):
- whether you (любой зачин);
- costume / costumey;
- afterthought;
- the honest downside;
- flatters every/all skin tone(s);
- reads as intentional/deliberate/polished;
- catching the light;
- we've included/gathered;
- as dynamic as.

**Потолок на статью** (`ARTICLE_QUOTAS`, `quotaOveruse`):
- «rather than» — не больше 2;
- «reads as» — не больше 2;
- «intentional/deliberate» — не больше 2;
- «salon-only» — не больше 2.

Всё сверх потолка, и оборот дважды в одной секции, — проблема секции. Первые вхождения не трогаются. После переписи потолок перепроверяется по новой секции.

Подсказка рецепта «INCLUDE: honest downside» заменена на «one real drawback»: автор переносил её дословно.

**Сухой прогон проверки (без памяти сайта):**

| Статья | Было найдено (предел 8) | Стало (предел) | Что ушло / что пришло |
|---|---|---|---|
| leather skirt | 5 | 4 (8) | «to recreate it look» ×3 n-граммы ушли; пришли 4 секции без запятых |
| white sneakers | 14 | 3 (10) | 14 ложных «to recreate it look for» ушли; остались costumey, «reads as», intentional |
| almond french | 0 | 8 (9) | rather than, reads as, costume, reads as intentional |
| short gel | 0 | 8 (10) | afterthought, flatters every skin tone, rather than ×6 |
| pearl | 1 | 13 (10) | afterthought ×3, costume ×3, the honest downside, flatters every skin tone, catching the light, rather than, reads as |
| chunky highlights | 0 | 14 (10) | costume ×3, the honest downside ×3, afterthought, reads as deliberate, rather than, reads as |

- n-грамм-«шаблонов» с числами словами было 89, стало 0. Самые частые: «for two to three» ×3, «every eight to ten» ×2.
- n-грамм каркаса одежды было 39, стало 1. Это «to recreate it look» ×21, «recreate it look for» ×21, «it look for a» ×16.
- На старых текстах находок больше: это тексты старых промтов, где штампы не запрещались. С новыми промтами (раздел 2) ожидается 3–6 секций на статью.

### 1.5 Тире перед целым предложением

`polish.ts` → `fixDashesText` + `looksLikeClause`. Если после тире идёт самостоятельное предложение, ставится точка и заглавная. Признаки предложения:
- начинается с подлежащего: the/a/each/this/your/it/they…;
- 5+ слов;
- глагол стоит раньше относительного слова that/which/who.

Слева должно быть хотя бы 3 слова. Вставки «X — aside — Y» и уточнения «the kind that…» по-прежнему через запятую.

| Было | Стало |
|---|---|
| This is a salon-only finish — the powder application requires a cured no-wipe top coat. | This is a salon-only finish. The powder application requires a cured no-wipe top coat. |
| The chrome sits on a short almond — each nail gets the same thin layer of powder. | The chrome sits on a short almond. Each nail gets the same thin layer of powder. |
| A milky base — the kind that hides grow-out — keeps it soft. | A milky base, the kind that hides grow-out, keeps it soft. |
| Ask for a chartreuse or lime — same punch, slightly softer landing. | Ask for a chartreuse or lime, same punch, slightly softer landing. |

Тексты раунда 3 уже прошли старую чистку: тире в них заменены запятыми, поэтому примеры восстановлены из аудита с исходным тире.

### 1.6 Вступление, заключение, мета и H1

**Вступление и заключение** (`worker/articles/stages/introOutro.ts`):
- Стоп-лист (`findBannedPhrases`) проверяет оба блока.
- При находке — одна дополнительная попытка с перечнем фраз. Из всех валидных вариантов берётся тот, где находок меньше.
- Остаток пишется в `details.bannedLeft` и в сводку этапа.
- «This is 14 ways» → «Here are 14 ways» (`fixCountGrammar`).
- Сухой прогон: «Whether you» во вступлениях chunky, almond, short gel и pearl. Раньше старый код видел только pearl, и то без «Whether you’re» и «we’ve included». В заключениях: «as dynamic as» (chunky), «afterthought» (sneakers). Грамматика leather: «This is {{COUNT}} ways» → «Here are {{COUNT}} ways».

**Мета** (`worker/articles/stages/meta.ts`):
- `titleCase` — каждая часть через дефис с заглавной, маленькие слова в середине строчные: «Day-to-night» → «Day-to-Night».
- `validate`:
  - тайтл короче 40 символов — проблема (было 25);
  - H1 должен содержать ключ дословно (`hasExactKeyword`);
  - stunning/elevate/effortless/chic/dreamy/gorgeous/must-have/whether you в H1, тайтле и описании — проблема (`metaBannedWords`). Модель получает это в списке на повтор.
- Если модель не исправила — детерминированно:
  - `stripMetaBanned`: «for a Chic Look» и «to Elevate Your Style» — оборот целиком, effortless → easy, elevate → upgrade, остальные слова — удаление;
  - `ensureH1Keyword`: число + ключ + хвост H1 после связки;
  - тайтл короче 40 → H1 без числа, если в нём 40–60 символов и ключ.

Сухой прогон меты раунда 3:

| Статья | Было | Стало (детерминированно, если и повтор модели не помог) |
|---|---|---|
| pearl | H1 «20 Dreamy Pearl Nail Looks with Iridescent Shine» (нет «pearl nails») | «{{COUNT}} Pearl Nails with Iridescent Shine» |
| pearl | описание «Discover 20 stunning pearl nail looks» | «Discover 20 pearl nail looks» |
| leather | «Leather Skirt Outfits for Chic Day-to-night» | «Leather Skirt Outfits for Day-to-Night» |
| sneakers | H1 «20 White Sneakers Outfits to Elevate Your Style» | «20 White Sneakers Outfits» |
| sneakers | тайтл «White Sneakers Outfits to Try» (29) | проблема валидатора → повтор модели |
| short gel | H1 «19 Short Gel Nails to Try for a Chic Look» | «19 Short Gel Nails to Try» |
| almond | «18 Almond French Nails: Chic Looks for Every Occasion» | «18 Almond French Nails: Looks for Every Occasion» |
| chunky, short gel | тайтл 36 символов | повтор модели |

### 1.7 Ключ без «склеек»

`worker/articles/stages/sections.ts` → `buildSectionBrief`:
- строк «Keywords to use once…» и «Keyword to weave» больше нет;
- вместо них: `Section keyword (optional): "…". Use it at most once, only where it reads as natural English; never as a noun stack ("this X Y Z outfit"). If it does not fit, use a shorter natural part of it or skip it.`;
- `keywords_to_bold` и список «Already used» автору не передаются;
- из ответа автора убраны `word_count` и `keywords_used` (код их не использует).

## 2. P1, промты (seedRev `2026-10-15-text-v3`, 12 промтов)

| Промт | Что сделано |
|---|---|
| План по фото, ногти (`b59ca1bd`) | Поля секции: photo_n, position, role, h2, seo_keyword, description, visual_anchor, who_it_suits, ask_for, wear_tip, occasion, difficulty_level + nail_shape, nail_length, finish, art_technique. Убраны name, mood, color_story, keyword_placement, styling_tips, maintenance_level, salon_vs_diy и весь подобъект section_plan (h2_draft, keywords_to_bold, problem_to_solve, solution, value_focus, expertise_depth). Без подтона кожи. Правила точности: кошачий глаз, гель-лак без fill и обновления топа, 2–3 недели. В примере «refresh the top coat at day 7» заменено на «cuticle oil daily; soak off with acetone around week three» |
| План по фото, волосы (`4a2f81a7`) | То же сокращение (+ cut, hair_length, texture, hair_color, bangs; убраны color_technique, styling, face_shapes, hair_types, estimated_upkeep). ask_for обязателен в каждой секции (colorist для темы цвета, stylist для стрижки и укладки). Подтон кожи убран. Правило: тёмная база со светлыми прядями — не «lighter blonde base», кудрявая чёлка — не curtain bangs. Опечатка «color, not color» → «color, not colour» |
| План по фото, одежда (`c1a11003`) | Убраны styling_tips и подобъект fashion_details (он приносил выдуманную «footwear»: детали образа теперь строятся кодом из очищенных фактов). shoes_note — только обувь из фактов фото, точный тип. look_for начинается с вещи из ключа |
| Автор, ногти (`9d6340d3`, `a29fb28f`) | Без объяснений «почему оттенок идёт подтону» и «flatters every skin tone». Who it suits — длина ногтя и образ жизни. ACCURACY: магнит над невысохшим гелем кошачьего глаза до сушки, гель-лак без fill и без обновления топа, срок 2–3 недели. «fill at week 3» убран из примера цены временем. Блок KEYWORD (без склеек существительных). Новые штампы, «rather than» ≤2. VALUE FOCUS и поля, которых больше нет в плане, убраны. «Ask your tech for» в каждой секции |
| Автор, волосы (`22b94976`, `785382a2`) | «Ask your colorist for:» / «Ask your stylist for:» — обязательная строка каждой секции (и в FINAL CHECK). База и пряди строго по фактам. Подтон кожи убран. KEYWORD, новые штампы (reads as, costume, the honest downside, as dynamic as), «rather than» ≤2, intentional/deliberate ≤1 |
| Автор, одежда (`c1a11005`, `c1a11006`) | Обувь только из фактов, точный тип (high-top не low-profile). «To recreate it, look for» начинается с вещи из ключа. KEYWORD с примером «This cream knit sweater slip dress white sneakers outfit» как запрещённым. Нормальная пунктуация (апострофы в притяжательных) |
| Вступление и заключение (`b0e6dbb4`, `4de1da12`, `c1a11007`) | Ногти: без подтонов в «для кого», пример ухода «top coat refresh on day 7» → «soak off with acetone at week three», запрет «Whether you…», «we've included», «catches the light». Волосы: запрет «Whether you…», «as dynamic as», «reads as». Одежда: «Here are {{COUNT}} ways…», никогда «This is {{COUNT}} ways», «whether you» |

**Код поверх промтов** (на случай правок в портале):
- `sections.ts` → `nicheRules` добавляется в system автора: ногти — подтон, кошачий глаз, гель-лак, «Ask your tech for»; волосы — «Ask your colorist/stylist for» в каждой секции; одежда — обувь из фактов, вещь из ключа в «look for».
- `BANNED_PROMPT_LINE` дополнен новыми штампами, потолком «rather than»/«reads as», запретом подтона без фактов и правилом пунктуации.
- `BRIEF_SKIP` дополнен полями, убранными из плана: автор их не видит и в планах, сохранённых до правки. Это keyword_placement, mood, color_story, styling_tips, maintenance_level, salon_vs_diy, estimated_upkeep, problem_to_solve, solution, value_focus, expertise_depth, face_shapes, hair_types, color_technique.

**Как попадёт в базу.** Механизм прежний (`prisma/seed.mjs`, правки не нужны):
- промты без версий перезаписываются;
- промты с версиями получают новую версию «seed:2026-10-15-text-v3 — …» один раз;
- метка `seedRev` поднята у всех 12 изменённых промтов;
- `config.json` не менялся.

Уже запущенные статьи работают по снимку рецепта: новые промты действуют для статей, запущенных после деплоя. Код (факты, хвосты, проверки, мета) действует сразу, в том числе при пересборке и повторе этапов.

## 3. Цена на статью

База — аудит text-v3: ≈$0.0105 (ногти и волосы ≈$0.0119, одежда ≈$0.0076). План по фото ногтей и волос: 10–12,7 тыс. выходных токенов flash-lite ($0.40/M).

| Изменение | Расчёт | Δ ногти/волосы | Δ одежда |
|---|---|---|---|
| План по фото: ≈16 коротких полей вместо ~30, без section_plan | ≈550–650 → ≈280–330 вых. токенов на секцию × 19 ≈ −5…−6 тыс. | **−$0.0020…−0.0024** | −$0.0003…−0.0004 (без styling_tips и fashion_details) |
| Бриф автора без полей-дублей и keywords_to_bold; ответ без word_count/keywords_used | −≈15 % входа, −≈300 вых. токенов deepseek-v4-flash | −$0.0001 | −$0.0001 |
| Правила ниш и длиннее стоп-лист в system автора | ≈+220 токенов × 4–5 пачек × $0.091/M | +$0.0001 | +$0.0001 |
| Перепись: без ложных срабатываний, предел 8 → 8–12 | ≈$0.00005 за секцию; ожидание 3–6 секций (было ≈6–7 с ложными), худший случай 12 | −$0.0001…+$0.0001 (худший +$0.0003) | −$0.0001…+$0.0001 |
| Стоп-лист во вступлении и заключении | одна доп. попытка ≈$0.0002, примерно в половине статей | +$0.0001 | +$0.0001 |
| Строже проверка меты (тайтл ≥40, ключ в H1, запретные слова) | ещё ≈1 попытка flash-lite ($0.0002–0.0003) примерно в половине статей | +$0.0001 | +$0.0001 |
| Факты фото: скелет вместо описаний в образце JSON | короче system оценки, без длинных скопированных строк в ответе | ≈0 (этап фото) | ≈0 |
| Чистка фактов, хвосты H2, тире, пунктуация, Title Case, грамматика | код | $0 | $0 |
| **Итого** | | **≈ −$0.0015…−$0.0025** → ≈$0.0095–0.0104 | **≈ −$0.0002…+$0.0001** → ≈$0.0075 |

В среднем по нишам ≈$0.009 на статью против ≈$0.0105 в раунде 3. Худший случай (12 переписей, повтор вступления и меты) ≈ −$0.001 у ногтей и волос.

## 4. Что проверить после деплоя

1. **Лог сида:** `articles seed: … prompts (0 new, N new seed versions)`. У промтов без версий текст перезаписывается без счётчика.
2. **По 2 статьи каждой ниши, счётчики против text-v3:**
   - `craft`/`standout` с текстом схемы в фактах фото (ожидание 0);
   - хвосты «, None» в H2;
   - секции без запятых;
   - «Whether you» во вступлениях;
   - «rather than» на статью (≤2–3);
   - подтон кожи у ногтей;
   - «Ask your colorist/stylist for» у волос (ожидание: каждая секция);
   - обувь, которой нет в фактах;
   - H1 с точным ключом;
   - тайтл ≥40 символов.
3. **Расход плана по фото** ногтей и волос в `UsageLog`: выход ≈5–6 тыс. токенов вместо 10–12,7 тыс.
4. **Отчёт переписи** `details.revision`: `flagged`, `revised`, `cap`. Если `flagged` упирается в `cap`, смотреть, какие штампы дают находки, и править промт, а не предел.

## Изменённые файлы

- `src/lib/articles/photo/factSanitize.ts` (новый): описания полей, `isPlaceholderFact`, `sanitizeFacts`, `factFieldGuide`
- `src/lib/articles/photo/profile.ts`: описания из factSanitize, `photoFactFields` списком, `photoFactRules`, `sanitizePhotoFacts`
- `src/lib/articles/photo/ranking.ts`: `cleanFacts` через `sanitizeFacts`
- `src/lib/articles/text/photoDescribe.ts`, `vars.ts`, `textGuards.ts`, `polish.ts`
- `worker/articles/stages/rate.ts`, `plan.ts`, `sections.ts`, `introOutro.ts`, `meta.ts`
- `prisma/seed-data/articles/prompts.json` (12 промтов, `seedRev: 2026-10-15-text-v3`)
- этот файл
