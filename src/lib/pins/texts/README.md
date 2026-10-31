# pins/texts — тексты пинов (title / description / alt)

Порт из Lovable: `bulk-generate-descriptions`, `rewrite-duplicate-titles`, `titleDedupe.ts`,
этап `stageTexts` воркера и `stripAiMentions` мастера. ИИ — только через `@/lib/pins/ai/client`.

| Модуль | Что делает |
|---|---|
| `rules.ts` | Чистые правила: `truncateAtWord`, `stripEmoji`, `stripAiMentions`, `seasonalTerms` / `requireTerms` / `ensureSeasonWord`, `normalizeHashtags` / `stripHashtags` / `makeHashtags`, `applyLimits`, `inShare` (стабильная доля по хэшу id), `cleanTitle` |
| `generate.ts` | `generatePinTexts(ctx, input, opts)` — чанки по 10, до 3 параллельно, слот `text_main`, JSON `{results:[{i,title,description,alt}]}`, t=0.85, 8000 токенов, 100 с; пост-обработка из `rules.ts` |
| `dedupe.ts` | `dedupeTitles(ctx, rows, opts)` — повторы заголовков переписывает ИИ (`text_fast`, до 60 за вызов), остальное получает приписку Ideas / Inspo / Looks / … / Idea N |

Правила (SERVICE.md §9): title ≤ 100, alt ≤ 490, description ≤ 500 (≤ 350 с хэштегами), обрезка по слову;
сезонное слово обязательно и ставится в начало, если модель его потеряла; хэштеги 3–5 строчными в конце,
при «нет» — полная зачистка `#`; упоминания ИИ вырезаются.

Отличия от legacy (намеренные):
- **Эмодзи нет совсем**: блок EMOJI RULES убран, промт запрещает эмодзи, `stripEmoji` вырезает всё, что пришло (`emojiPercent` больше не существует).
- Доля элементов с хэштегами — `hashtagShare` (variety рецепта), выбор **стабильный по хэшу id** (`inShare`), а не случайная перетасовка: повторный запуск даёт те же флаги. При `hashtags=false` — 0 %, без `hashtagShare` — 100 %.
- `stripAiMentions` исправлен: границы слов Unicode-aware (`u`, lookbehind/lookahead по `\p{L}\p{N}_`), поэтому `нейросеть`, `искусственный интеллект`, `штучний інтелект`, `ИИ`/`ШІ` реально вырезаются; хэштеги удаляются только буквально про ИИ (`#ai`, `#aiart`, `#midjourney`, `#нейросеть`…), а `#nails`, `#hair`, `#braids` остаются.
- `applyLimits` при обрезке описания с хэштегами сохраняет хвост тегов целиком и режет только текст перед ним.
- Промт дополнен: запрет упоминать ИИ/генераторы, аудитория рецепта (тон, без явного упоминания), имя сайта — не больше одного раза в финальном призыве описания; ответ — объект `{"results":[...]}` (нужен для `response_format: json_object`).
- `generatePinTexts` не возвращает элементы, для которых модель не дала заголовок (legacy клал `error: "AI returned no result"`); `AiError` пробрасывается, повторы — у воркера.
- `dedupeTitles` возвращает карту `id → новый заголовок` только для изменённых строк; `AiError` вида `fatal_run` пробрасывается, остальные сбои ИИ → приписки без ИИ (как в legacy). Приписки английские, как в legacy.
