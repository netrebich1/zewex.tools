# Промты пинов (`src/lib/pins/prompts`)

Порт генерации промтов из Lovable-версии (`generate-pin-prompt`, `pinora-generate-prompts`,
`pinoraStyles.ts`). Формулировки промтов сохранены — они настраивались месяцами; менять
осторожно. Данные лежат в `src/data/pins/*.json` и читаются как есть.

| Файл | Что делает |
| --- | --- |
| `aiStyles.ts` | Библиотека стилей ИИ-пинов (`ai-styles.json`): `getAiStyle`, `listAiStyles`, `styleCategories`, `styleTypes`, `sortByCategory`. |
| `aiPrompt.ts` | `buildAiPromptMessages(input)` — чистый билдер system/user; `generateAiPrompts(ctx, input)` — батчи по 3 стиля через `aiChat("text_main")`, добор упавших по одному. |
| `pinora.ts` | Конструктор Pinora: `buildPinoraParams(args)` — параметры пина (группы, коды, SUBJECT OVERRIDE, STYLE BLOCK) на этапе плана; `generatePinoraPrompts(ctx, items)` — промты по готовым параметрам. |
| `elements.ts` | `decideElements(itemId, recipe.text)` — какие теги (сезон/год/число/имя сайта/CTA) ставить на пин: переключатель элемента + хэш `< variety`. Плюс `currentYear` (с октября — следующий год) и `seasonForDate`. |

## Поток

1. План: для каждого пина `decideElements(item.id, recipe.text)` → теги.
   Для Pinora там же `buildPinoraParams({ type, niche, seed, tags, ideaCount, year, season, keyword, rng })`
   и результат кладётся в элемент прогона (`params`). Один `createPinoraRng(seed)` на страницу — мешок
   без повторов параметров между пинами.
2. Промты: ИИ-пины страницы → `generateAiPrompts(ctx, { keyword, topic, niche, language, audience,
   siteName, ideaCount, seasonWord, year, styles: [{ id, overrideInstruction?, tags }] })`.
   Pinora → `generatePinoraPrompts(ctx, [{ id, params, keyword, topic, language, audience }])`.
3. Формат всегда 2:3 (1024x1536); промты нейтральны к модели картинок.

## Отличия от оригинала (намеренно)

- Нет кастомных правил (`customRules`), скриншотов-референсов к правкам стиля, ветки 9:16.
- Шесть процентов заменены на переключатели + `variety`; решение детерминировано хэшем, а не
  перестановкой по теме.
- Listicle-стили по-прежнему всегда получают число идей, если оно известно.
- Pinora: аудитория (`audience`) влияет на правило PEOPLE; CTA выключается тегом (код Д10);
  добавлена строка `SITE NAME OVERRIDE`; `styleMode: "auto" | "random"` (по умолчанию auto 40/40/20).
- `brandColor` добавляется в user-сообщение одной строкой как необязательный акцент.
