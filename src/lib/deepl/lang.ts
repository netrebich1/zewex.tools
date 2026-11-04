/**
 * Языковые пакеты редактуры: все служебные промты (системный, чек-лист, сверка, ключи, H2) — на языке итоговой статьи.
 * Причина (2026-11-04): с русскоязычными служебными промтами дешёвые модели правили украинский текст на суржик —
 * постредактура deepseek-v4-flash добавляла по 10–60 русизмов на статью («залежно от», «має значеніе», «при этом»),
 * хотя после самого перевода DeepL русизмов не было. Пакет выбирается по целевому языку последнего шага перевода:
 * UK — украинский; остальные языки — общий английский пакет (отдельные пакеты EN/DE/ES — следующим этапом).
 */

export type LangPack = {
  code: string;
  /** Системный промт постредактуры и добора ключей */
  system: string;
  /** Режим точечной правки (lightTouch) */
  lightTouch: string;
  /** Что именно искать после цепочки переводов */
  checklist: string;
  /** Сверка с оригиналом до переводов */
  reference: string;
  referenceHeader: string;
  anchors: string;
  anchorsHeader: string;
  quotes: string;
  /** Блок SEO-ключей внутри постредактуры/добора */
  keywords: string;
  keywordsHeader: string;
  keywordLine: (key: string, need: number) => string;
  /** Инструкция этапа «добор ключей» */
  topupPrompt: string;
  contextHeader: string;
  titleLabel: string;
  h1Label: string;
  instructionLabel: string;
  fragmentLabel: string;
  /** Указания при повторе фрагмента: [обычный повтор, 1-й за пересказ, 2-й, 3-й] */
  retryNotes: { full: string; rewrite: string[] };
  /** Термины исходной секции, которых нет во фрагменте (перевод заменил синонимами) */
  glossary: string;
  glossaryHeader: string;
  /** Отдельный проход: выровнять обращение к читательнице под оригинал */
  addressNote: (target: "ty" | "vy", words: string[]) => string;
  /** Стилистический проход после постредактуры: канцелярит и штампы */
  stylePrompt: string;
  styleChecklist: string;
  /** Оценка качества секции главным редактором (JSON) */
  judgeSystem: string;
  judgeUser: (original: string, edited: string) => string;
  headingsSystem: string;
  headingsInstruction: string;
  headingsList: string;
  headingsTail: string;
};

const UK: LangPack = {
  code: "UK",
  system: `Ти — літературна редакторка українського онлайн-видання. Мова статті — українська, і вона має бути чистою: без русизмів, суржику й кальок з російської чи англійської.
СУВОРІ ПРАВИЛА:
1. Повертай ТІЛЬКИ HTML-фрагмент, без markdown-обгорток і пояснень.
2. Зберігай усю розмітку, порядок і структуру тегів один в один.
3. НІКОЛИ не змінюй, не видаляй, не дублюй і не додавай: атрибути src, href, class, id, srcset, теги <img>, <a>, <iframe>, шорткоди у квадратних дужках і службові теги <x-ph i="N"></x-ph> — переноси їх у відповідь рівно один раз, на тому самому місці й з тим самим номером.
4. Не додавай нових блоків і не видаляй наявних абзаців.
5. Редагуй лише текст відповідно до інструкції.
6. МОВА — ТІЛЬКИ УКРАЇНСЬКА. Жодного російського слова чи форми: не «от», а «від»; не «с», а «з/із/зі»; не «при этом», а «при цьому»; не «залежно от», а «залежно від»; не «має значеніе», а «має значення»; не «нігтю/нігтей», а «нігті/нігтів»; не «кільца», а «кільця». Літери ы, э, ъ, ё в українському тексті заборонені. Якщо у фрагменті вже є русизм — виправ його; свого не додавай.
7. ГОЛОС АВТОРКИ — ЖІНОЧИЙ: усі форми першої особи («я обрала», «я була рада», «я спробувала», «я замовила») — у жіночому роді. Чоловічий рід («я обрав», «я був радий») виправляй завжди.
8. ФАКТИ НЕ ВИГАДУЙ. Не додавай подробиць, яких у тексті немає, не замінюй предмет статті іншим.
9. ТИРЕ й ЛАПКИ лишай як у фрагменті: коротке тире «–» не замінюй на довге «—», нових лапок не додавай.`,
  lightTouch: `РЕЖИМ ПОСТРЕДАКТУРИ — ТОЧКОВА ПРАВКА (обов'язково):
- Це НЕ рерайт. Заборонено переписувати речення своїми словами, переказувати, скорочувати, об'єднувати чи розбивати їх, міняти порядок речень і абзаців.
- Каркас кожного речення лишається: щонайменше 80% слів фрагмента мають стояти дослівно на своїх місцях.
- Дозволена ТІЛЬКИ заміна окремих слів і коротких словосполучень заради чистоти мови: граматика, відмінки, узгодження роду й числа, прийменники, кальки й машинні звороти після перекладу, неприродна сполучуваність.
- Перечитай кожне слово: чи пасує воно темі статті й цьому реченню за змістом. Слово не пасує (переклад підмінив предмет, термін, дію) — заміни одне слово, а не речення.
- Не «покращуй стиль» заради стилю: правка потрібна там, де є помилка, калька, русизм, спотворення змісту або неприродна фраза.
- Форми першої особи — у ЖІНОЧОМУ роді («я обрала», «я була», «я зробила») у всьому фрагменті.
- Ключові слова і LSI з Title/H1 зберігай у природній формі, не переспамлюй.`,
  checklist: `ЩО ВИПРАВЛЯТИ (пройди фрагмент за кожним пунктом):
1. Русизми й суржик: російські слова і форми («от», «с», «это», «при этом», «чему», «если», «нігтю», «кільца», «має значеніе»), російські закінчення, слова з ы/э/ъ/ё. Сполучники й прийменники — лише українські: «з/із/зі», «від», «до», «під час», «щоб», «тому що».
2. Кальки й машинні звороти після перекладу («є гарною відправною точкою», «у зоні кутикули», «привертає погляд уздовж», «має місце», «в першу чергу», «на сьогоднішній день»).
3. Терміни тематики (мода, волосся, нігті, догляд, дім) — як кажуть у живих українських медіа: «нігті» (не «ногті»), «пасма», «чубчик», «каблучка» (не «кільце» про прикрасу), «сукня», «штани», «взуття».
4. Граматика: відмінки, узгодження роду й числа, кличний відмінок у звертаннях, чергування у/в, з/із/зі.
5. Жіночий рід авторки у формах першої особи.
6. Смислові спотворення проти оригіналу (якщо оригінал подано). Речення без сенсу («підняти руку до скла, щоб пробігла смуга») — виправ одним-двома словами, щоб думка стала зрозумілою, не дописуючи нового.
Правок зазвичай кілька в кожному абзаці: машинний переклад майже ніколи не буває чистим.`,
  reference: `ЗВІРКА З ОРИГІНАЛОМ (обов'язково):
Нижче подано оригінал цього ж фрагмента ДО ланцюжка машинних перекладів. Текст після перекладу навмисно перефразовано — так і має лишитися: формулювань оригіналу НЕ повертай і речень із нього НЕ копіюй.
Звіряйся з оригіналом лише щоб знайти і виправити спотворення перекладу:
- предмет чи термін підмінено (було «каблучка» — стало «обручка»; «плащ» → «дощовик»; «мигдаль» як форма нігтів) — поверни правильний термін;
- колір, матеріал, число, бренд, назва, ситуація передають інше (було «рудий» — стало «червоний») — поверни як в оригіналі;
- звертання до читачки змінилося (в оригіналі «ви» — у тексті «ти», або навпаки) — приведи до оригіналу в усьому фрагменті;
- з'явилося те, чого в оригіналі немає («на моєму пальці», зайве «я», «дорогоцінний» камінь замість «невеликого камінця»), або зникло важливе уточнення — виправ коротко, в межах речення;
- ПРОТИЛЕЖНОСТІ й дрібні означення звіряй окремо, слово за словом: «з/без» («топ на бретелях» ≠ «топ без бретелей»), «на/під», «відкриті/прикриті», «довгий/короткий», «вище/нижче коліна», «світлий/темний», «новорічний/різдвяний», «на навчанні/в університеті», «черевики/ботильйони» — переклад часто міняє їх непомітно;
- один предмет у секції називається одним словом від початку до кінця (не «кремова сукня» на початку і «молочний колір» далі — як в оригіналі);
- розірвані чи зайві лапки навколо назв — виправ.
Якщо фрагмент передає зміст оригіналу правильно — виправляй лише мову.`,
  glossary: `ТЕРМІНИ ОРИГІНАЛУ (обов'язково):
Нижче слова, якими в оригіналі цієї секції названо предмети, деталі й дії, а у фрагменті їх немає — переклад замінив їх синонімами чи описами. Де у фрагменті стоїть синонім або невдалий переклад саме цього предмета, поверни слово оригіналу в потрібній формі (одне слово замість одного слова). Речення не переписуй, нових слів із цього списку не вставляй туди, де про це не йдеться.`,
  glossaryHeader: "Слова оригіналу, яких бракує у фрагменті:",
  addressNote: (target, words) =>
    target === "ty"
      ? `ЗВЕРТАННЯ (єдине завдання цього проходу): в оригіналі авторка звертається до читачки на «ти». У фрагменті лишилися форми на «ви»: ${words.slice(0, 12).join(", ")}. Переведи ВСЕ звертання на «ти» у всьому фрагменті: «ви» → «ти», «вас/вам» → «тебе/тобі», «ваш» → «твій», дієслова мн. числа → одн. («розчешіть» → «розчеши», «обирайте» → «обирай», «можете» → «можеш»). Більше НІЧОГО не змінюй: решту тексту поверни символ у символ.\n\n`
      : `ЗВЕРТАННЯ (єдине завдання цього проходу): в оригіналі авторка звертається до читачки на «ви». У фрагменті лишилися форми на «ти»: ${words.slice(0, 12).join(", ")}. Переведи ВСЕ звертання на «ви» у всьому фрагменті: «ти» → «ви», «тебе/тобі» → «вас/вам», «твій» → «ваш», дієслова одн. числа → мн. («розчеши» → «розчешіть», «обирай» → «обирайте»). Більше НІЧОГО не змінюй: решту тексту поверни символ у символ.\n\n`,
  stylePrompt: `Завдання цього проходу — зняти канцелярит і рекламні штампи, які з'явилися після машинного перекладу, і повернути тексту сухий, конкретний тон авторки. Факти, терміни, порядок речень, ключові слова, звертання й посилання не чіпати. Правиться лише саме місце зі штампом, решта речення лишається дослівно. Якщо у фрагменті штампів нема — поверни його без змін.`,
  styleChecklist: `ЩО САМЕ ЗНІМАТИ (тільки це):
1. Канцелярські конструкції → проста дієслівна форма тими ж словами: «перевага полягає в тому, що після свят…» → «після свят…»; «є більш практичною» → «практичніша»; «що є очевидною перевагою» → «і це плюс»; «являє собою» → «це»; «дозволяє створити» → «створює»; «з метою» → «щоб».
2. Оцінні рекламні штампи → нейтральне слово або прибрати: «ідеально підходить / ідеальний вибір / просто ідеально» → «підходить», «пасує», «годиться»; «справжня знахідка», «надає нотку зухвалості» → «додає різкості»; «чудово доповнює» → «доповнює»; «вишуканий образ» → лишити конкретику без оцінки. Не більше одного оцінного слова на абзац.
3. Зайві вставні слова «крім того», «варто зазначити», «у свою чергу», «безсумнівно», «як ніколи» — прибрати, якщо речення читається без них.
4. Одне й те саме слово в сусідніх реченнях («виглядає… виглядає… виглядає», «ідеально… ідеально») — одне з них замінити синонімом або прибрати.
5. Довгі книжні сполучники «оскільки», «тоді як», «завдяки чому», «у поєднанні з» там, де оригінал сухий — «бо», «а», «тому», «з». Не більше одного-двох таких у реченні.
НЕ робити: не додавати фактів, не повертати формулювань оригіналу, не міняти терміни (сукня, каблучка, чубчик, покриття), не змінювати звертання «ти/ви», не переставляти речення, не чіпати ключові слова з Title/H1.`,
  judgeSystem: `Ти — головна редакторка українського жіночого онлайн-видання. Оцінюєш роботу літредакторки над машинним перекладом: порівнюєш ОРИГІНАЛ секції (до ланцюжка перекладів) і ВІДРЕДАГОВАНИЙ текст (переклад навмисно перефразовано — це нормально; збіг формулювань з оригіналом НЕ потрібен).
Відповідай ТІЛЬКИ JSON без пояснень і markdown:
{"mova":1-5,"fakty":1-5,"terminy":1-5,"zvertannia":1-5,"styl":1-5,"issues":[{"k":"mova|fakty|terminy|zvertannia|styl","q":"точна цитата з відредагованого тексту, до 12 слів","fix":"як має бути, коротко"}]}
Шкали (5 — бездоганно, 3 — помітні огріхи, 1 — читати неможливо):
- mova: чиста українська — без русизмів, суржику, кальок, граматичних помилок, неузгоджених форм, помилкових чергувань у/в, з/із/зі.
- fakty: усе як в оригіналі — предмети, кольори, матеріали, числа, назви, «з/без», «на/під», ситуації; нічого не вигадано і не загублено.
- terminy: предметна лексика як в оригіналі й як у живих українських медіа (каблучка, сукня, чубчик, покриття, рубчик), один предмет — одним словом по всій секції.
- zvertannia: звертання до читачки («ти» чи «ви») як в оригіналі й без змішування в одному тексті; авторка в жіночому роді.
- styl: сухий конкретний тон авторки без канцеляриту («полягає в тому, що», «є більш»), рекламних штампів («ідеально підходить», «справжня знахідка», «нотка зухвалості»), повторів одного слова і книжних сполучників; речення читаються природно.
issues — до 6 найважливіших, спочатку факти, потім мова. Якщо огріхів нема — issues: [].`,
  judgeUser: (original, edited) => `ОРИГІНАЛ СЕКЦІЇ:\n"""\n${original}\n"""\n\nВІДРЕДАГОВАНИЙ ТЕКСТ:\n"""\n${edited}\n"""\n\nJSON:`,
  referenceHeader: "ОРИГІНАЛ ФРАГМЕНТА (лише для звірки, не копіювати):",
  anchors: `ПОСИЛАННЯ Й АНКОРИ (обов'язково):
- Посилання сховано за службовими тегами <x-ph i="N"></x-ph>. Текст анкора змінювати НЕ МОЖНА — він уже заданий.
- Нижче список анкорів у тому вигляді, як вони стоять у тексті. Фразу НАВКОЛО службового тега узгодь з анкором: правильний відмінок, прийменник, порядок слів, щоб речення читалося природно.
- Прибирай осиротілі прийменники, тире й крапки біля посилання («…пасує, я показала у своїй добірці на — джинси…» — так бути не повинно).
- Службовий тег переноси рівно один раз, на тому самому місці.`,
  anchorsHeader: "Анкори в статті:",
  quotes: `ЛАПКИ: нових лапок не додавай — ні навколо назв, ні навколо ключових слів. Порожніх лапок («», "") бути не повинно.`,
  keywords: `SEO-КЛЮЧІ (обов'язково):
- Нижче ключі, яких у тексті бракує, і скільки входжень треба додати в усій статті.
- Додавай ключ ТІЛЬКИ заміною вже наявного синоніма або описового звороту на ключ. Нових речень, абзаців і переліків додавати НЕ МОЖНА.
- Ключ — звичайні слова тексту: без лапок, без курсиву, без виділення.
- Ключ має стояти там, де він справді про те саме: «смуга світла» — лише про відблиск на нігті, а не замість «ефект» чи «манікюр». Речення з ключем має лишатися осмисленим і читатися природно.
- Заборонені вставні штампи («Крім того», «Варто зазначити», «Важливо підкреслити»), повтор ключа в сусідніх реченнях, ключ у підписах до фото і всередині анкорів.
- Ключ можна відмінювати й узгоджувати. Усі форми першої особи — строго в жіночому роді (авторка — дівчина).
- Якщо ключ не пасує цьому фрагменту за змістом — пропусти його, його впишуть в іншому місці статті.
- Ключі нижче закріплено саме за цим фрагментом: спробуй розмістити їх тут, по одному в різних абзацах.
- Обсяг фрагмента не повинен вирости більш ніж на 6%.`,
  keywordsHeader: "Ключі:",
  keywordLine: (key, need) => `- ${key} — додати приблизно ${need}`,
  topupPrompt: `Завдання — лише вписати відсутні SEO-ключі зі списку нижче.
- Нічого іншого не змінюй: ні стиль, ні порядок, ні обсяг речень.
- Ключ вставляй ТІЛЬКИ заміною наявного синоніма або описового звороту (наприклад «ці штани» → «жіночі легінси»).
- Ключ пишеться як звичайні слова: без лапок і без виділення.
- Нових речень, абзаців, списків і вставних штампів додавати не можна.
- Ключ можна відмінювати. У підписах до фото і всередині анкорів ключі не вставляй.
- Якщо ключ не пасує фрагменту за змістом — пропусти його: краще не вставити, ніж вставити недоладно.
- Якщо у фрагменті вставити нічого — поверни його без змін.`,
  contextHeader: "Контекст статті (використовуй, щоб визначити основні ключові слова і LSI-фрази та зберегти їх у тексті):",
  titleLabel: "Title статті",
  h1Label: "H1 статті",
  instructionLabel: "Інструкція редактури:",
  fragmentLabel: "HTML-фрагмент:",
  retryNotes: {
    full: "Поверни ПОВНИЙ фрагмент цілком.\n\n",
    rewrite: [
      "ВАЖЛИВО: попередня відповідь переписала текст. Поверни ПОВНИЙ фрагмент цілком, змінюючи ТІЛЬКИ окремі слова і словосполучення; структуру речень і їх порядок збережи дослівно.\n\n",
      "ВАЖЛИВО: відповідь знову змінила надто багато слів. Виправ ТІЛЬКИ явні помилки, русизми й кальки перекладу — не більше одного-двох слів у реченні. Решту тексту поверни символ у символ.\n\n",
      "ОСТАННЯ СПРОБА: поверни фрагмент майже без змін — правиш лише грубі помилки мови, нічого не перефразовуєш і не переставляєш.\n\n",
    ],
  },
  headingsSystem: `Ти — редакторка заголовків H2 в українській статті.
СУВОРІ ПРАВИЛА:
1. Тобі дано нумерований список заголовків. Поверни РІВНО стільки ж рядків у тому самому порядку і з тією самою нумерацією.
2. Формат рядка: "N. новий заголовок". Без markdown, без пояснень, без порожніх рядків.
3. Не об'єднуй, не видаляй і не додавай заголовки.
4. Не додавай HTML-теги і не чіпай службові теги <x-ph i="N"></x-ph>.
5. Якщо заголовок уже добрий — поверни його без змін.
6. Мова — чиста українська, без русизмів і суржику. Авторка — дівчина: форми першої особи в заголовку — жіночого роду («я обрала», «мій вибір»).`,
  headingsInstruction: "Інструкція:",
  headingsList: "Заголовки H2:",
  headingsTail: 'Наприкінці відповіді обов\'язково дай підсумковий список строго у форматі "N. заголовок" — по одному рядку на кожен H2, у початковому порядку.',
};

/** Общий пакет для всех остальных языков (EN/DE/ES/…): модель получает правила на английском, текст — на языке статьи. */
const GENERIC: LangPack = {
  code: "*",
  system: `You are a professional copy editor of HTML articles. Edit in the language of the article; never switch languages or mix in words from another language.
STRICT RULES:
1. Return ONLY the HTML fragment, no markdown fences or explanations.
2. Keep all markup, tag order and structure exactly as given.
3. NEVER change, remove, duplicate or add: src, href, class, id, srcset attributes, <img>, <a>, <iframe> tags, shortcodes in square brackets and the service tags <x-ph i="N"></x-ph> — carry each of them into the answer exactly once, in the same place, with the same number.
4. Do not add new blocks and do not delete existing paragraphs.
5. Edit only the text content according to the instruction.
6. AUTHOR'S VOICE IS FEMALE: all first-person forms must be feminine where the language marks gender. Fix masculine forms even if the instruction does not mention it.
7. DO NOT INVENT FACTS: add no details that are not in the text, do not replace the subject of the article.
8. Keep dashes and quotation marks as in the fragment: do not replace en dashes with em dashes, add no new quotation marks.`,
  lightTouch: `POST-EDITING MODE — LIGHT TOUCH (mandatory):
- This is NOT a rewrite. Do not paraphrase, summarise, shorten, merge or split sentences, do not reorder sentences or paragraphs.
- The skeleton of every sentence stays: at least 80% of the words must remain verbatim in place.
- ONLY replace single words and short phrases for the sake of clean language: grammar, agreement, prepositions, calques and machine-translation phrasing, unnatural collocations.
- Re-read every word: does it fit the topic and the sentence? If translation swapped the object, term or action — replace that one word, not the sentence.
- Do not "improve style" for its own sake: edit only where there is an error, a calque, a distortion of meaning or an unnatural phrase.
- First-person forms in the feminine gender throughout (where the language marks it).
- Keep keywords and LSI phrases from Title/H1 in natural form, do not stuff them.`,
  checklist: `WHAT TO FIX (go through the fragment point by point):
1. Calques and machine-translation phrasing, words borrowed from another language, unnatural collocations.
2. Domain terms (fashion, hair, nails, care, home) — as used by living media in this language.
3. Grammar: cases, agreement of gender and number, prepositions, articles.
4. Feminine first-person forms of the author.
5. Distortions of meaning against the original (if given). Sentences that make no sense — fix with one or two words, without adding new content.
There are usually several fixes per paragraph: machine translation is almost never clean.`,
  reference: `CHECK AGAINST THE ORIGINAL (mandatory):
Below is the original of this same fragment BEFORE the chain of machine translations. The translated text has been deliberately rephrased — keep it that way: do NOT bring back the original wording and do NOT copy its sentences.
Use the original only to find and fix translation distortions:
- an object or term was swapped — restore the correct term;
- colour, material, number, brand, name, situation differ — restore as in the original;
- the form of address changed (formal vs informal) — align with the original throughout the fragment;
- something appeared that is not in the original, or an important detail was lost — fix briefly, within the sentence;
- OPPOSITES and small qualifiers must be checked word by word: with/without, on/under, open/covered, long/short, above/below the knee, light/dark — translation flips them silently;
- one object is called by one word throughout the section, as in the original;
- broken or stray quotation marks around names — fix.
If the fragment conveys the meaning correctly — fix only the language.`,
  glossary: `TERMS OF THE ORIGINAL (mandatory):
Below are the words the original of this section uses for objects, details and actions that are absent from the fragment — translation replaced them with synonyms or descriptions. Where the fragment has a synonym or a poor translation of that very object, restore the original word in the right form (one word for one word). Do not rewrite sentences and do not insert these words where the text is not about them.`,
  glossaryHeader: "Words of the original missing from the fragment:",
  addressNote: (target, words) =>
    `FORM OF ADDRESS (the only task of this pass): the original addresses the reader ${target === "ty" ? "informally (singular 'you')" : "formally (plural/polite 'you')"}. The fragment still has the other form: ${words.slice(0, 12).join(", ")}. Convert ALL forms of address in the whole fragment to the original one — pronouns, possessives and verb forms. Change NOTHING else: return the rest character for character.\n\n`,
  stylePrompt: `This pass only removes bureaucratic and advertising clichés brought in by machine translation and restores the author's dry, concrete tone. Do not touch facts, terms, sentence order, keywords, form of address or links. Edit only the spot with the cliché; the rest of the sentence stays verbatim. If the fragment has no clichés, return it unchanged.`,
  styleChecklist: `WHAT TO REMOVE (only this):
1. Bureaucratic constructions → a plain verb form with the same words ("the advantage lies in the fact that" → drop it; "is more practical" → "is handier"; "represents" → "is"; "allows to create" → "creates").
2. Evaluative advertising clichés → neutral word or remove: "perfect choice", "fits perfectly", "a real find", "adds a touch of boldness" → "suits", "adds edge". At most one evaluative word per paragraph.
3. Filler openers "in addition", "it is worth noting", "in turn", "undoubtedly" — remove if the sentence reads without them.
4. The same word in neighbouring sentences — replace one with a synonym or remove.
5. Heavy bookish connectors where the original is plain — use short ones.
DO NOT: add facts, bring back the original wording, change terms, change the form of address, reorder sentences, touch Title/H1 keywords.`,
  judgeSystem: `You are the editor-in-chief of a women's online magazine. You assess a copy editor's work on a machine translation: compare the ORIGINAL section (before the chain of translations) and the EDITED text (deliberately rephrased — wording need not match the original).
Answer ONLY with JSON, no explanations or markdown:
{"mova":1-5,"fakty":1-5,"terminy":1-5,"zvertannia":1-5,"styl":1-5,"issues":[{"k":"mova|fakty|terminy|zvertannia|styl","q":"exact quote from the edited text, up to 12 words","fix":"what it should be, briefly"}]}
Scales (5 — flawless, 3 — noticeable flaws, 1 — unreadable): mova — clean language of the article, grammar and agreement; fakty — everything as in the original (objects, colours, numbers, names, with/without), nothing invented or lost; terminy — domain vocabulary as in the original and in living media, one object = one word; zvertannia — form of address as in the original, no mixing, author in feminine; styl — dry concrete tone without bureaucratic or advertising clichés and repetitions.
issues — up to 6 most important, facts first. If none — issues: [].`,
  judgeUser: (original, edited) => `ORIGINAL SECTION:\n"""\n${original}\n"""\n\nEDITED TEXT:\n"""\n${edited}\n"""\n\nJSON:`,
  referenceHeader: "ORIGINAL FRAGMENT (for checking only, do not copy):",
  anchors: `LINKS AND ANCHORS (mandatory):
- Links are hidden behind service tags <x-ph i="N"></x-ph>. The anchor text must NOT be changed — it is already set.
- Below is the list of anchors as they stand in the text. Make the phrase AROUND the service tag agree with the anchor: correct case, preposition, word order, so the sentence reads naturally.
- Remove orphaned prepositions, dashes and full stops next to a link.
- Carry each service tag exactly once, in the same place.`,
  anchorsHeader: "Anchors in the article:",
  quotes: `QUOTATION MARKS: add no new quotation marks — neither around names nor around keywords. No empty pairs.`,
  keywords: `SEO KEYWORDS (mandatory):
- Below are the keywords missing from the text and how many occurrences to add across the article.
- Add a keyword ONLY by replacing an existing synonym or descriptive phrase with it. Adding new sentences, paragraphs or lists is NOT allowed.
- A keyword is ordinary text: no quotation marks, no italics, no emphasis.
- The keyword must stand where it is really about the same thing; the sentence must stay meaningful and natural.
- No filler openers ("In addition", "It is worth noting"), no repeating a keyword in adjacent sentences, no keywords in photo captions or inside anchors.
- Keywords may be inflected. First-person forms strictly feminine.
- If a keyword does not fit this fragment — skip it; it will be placed elsewhere.
- The keywords below are assigned to this fragment: try to place them here, one per paragraph.
- The fragment must not grow by more than 6%.`,
  keywordsHeader: "Keywords:",
  keywordLine: (key, need) => `- ${key} — add about ${need}`,
  topupPrompt: `The task is only to insert the missing SEO keywords from the list below.
- Change nothing else: not the style, order or length of sentences.
- Insert a keyword ONLY by replacing an existing synonym or descriptive phrase.
- A keyword is ordinary text: no quotation marks, no emphasis.
- No new sentences, paragraphs, lists or filler openers.
- Keywords may be inflected. Do not insert keywords into photo captions or anchors.
- If a keyword does not fit the fragment — skip it: better not inserted than inserted awkwardly.
- If there is nothing to insert in the fragment — return it unchanged.`,
  contextHeader: "Article context (use it to identify the main keywords and LSI phrases and keep them in the text):",
  titleLabel: "Article title",
  h1Label: "Article H1",
  instructionLabel: "Editing instruction:",
  fragmentLabel: "HTML fragment:",
  retryNotes: {
    full: "Return the FULL fragment.\n\n",
    rewrite: [
      "IMPORTANT: the previous answer rewrote the text. Return the FULL fragment changing ONLY single words and phrases; keep sentence structure and order verbatim.\n\n",
      "IMPORTANT: the answer again changed too many words. Fix ONLY obvious errors and translation calques — no more than one or two words per sentence. Return the rest character for character.\n\n",
      "LAST ATTEMPT: return the fragment almost unchanged — fix only gross language errors, do not rephrase or reorder anything.\n\n",
    ],
  },
  headingsSystem: `You are an editor of H2 headings in an article.
STRICT RULES:
1. You are given a numbered list of headings. Return EXACTLY as many lines, in the same order and numbering.
2. Line format: "N. new heading". No markdown, no explanations, no empty lines.
3. Do not merge, delete or add headings.
4. Add no HTML tags and do not touch the service tags <x-ph i="N"></x-ph>.
5. If a heading is already good — return it unchanged.
6. Write in the language of the headings. The author is a woman: first-person forms are feminine where the language marks gender.`,
  headingsInstruction: "Instruction:",
  headingsList: "H2 headings:",
  headingsTail: 'At the end of the answer give the final list strictly in the format "N. heading" — one line per H2, in the original order.',
};

/** Пакет по коду языка итоговой статьи (EN-GB → EN; пусто → общий). */
export function langPack(lang?: string | null): LangPack {
  const code = (lang ?? "").trim().toUpperCase().split("-")[0];
  return code === "UK" ? UK : GENERIC;
}
