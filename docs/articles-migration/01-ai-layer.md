# 01 — ИИ-слой и резолвинг промтов/моделей (`supabase/functions/_shared`)

Аудит исходников «Zewex Pinterest Articles» перед портом в Node-воркер zewex.tools.
Зона: `aiProvider.ts`, `openrouter.ts`, `promptSet.ts`, `billingGuard.ts`, `serviceSlots.ts`,
`applyScenario.ts`, `countToken.ts`, `jsonRepair.ts`, `cron-auth.ts` + типичные вызовы из `stage-*`.
Ссылки `file:line` — на файлы в `supabase/functions/` архива миграции.

---

## 1. Назначение модулей и экспорты

### `_shared/aiProvider.ts` (525 строк) — единая точка текстовых/vision-вызовов
| Экспорт | Сигнатура | Назначение |
|---|---|---|
| `ProviderName` | `"openrouter" \| "laozhang" \| "laozhang_nothinking" \| "poyo" \| "lovable_gateway"` | имена провайдеров |
| `ContentBlock` | `{ type: "text" \| "image_url"; text?; image_url?: { url } }` | мультимодальный блок (OpenAI-формат) |
| `ChatMessage` | `{ role; content: string \| ContentBlock[] }` | сообщение |
| `parseLaoZhangModel(model)` | `→ { provider; model } \| null` | разбор `laozhang:gemini-2.5-flash` / `laozhang_nothinking:…` (L35) |
| `laoZhangCostRates(modelId)` | `→ [inPerM, outPerM]` | эвристика цен по подстроке имени (deepseek / flash-lite / flash / pro) (L43) |
| `CallGeminiOptions` | `{ provider; model?; fallbackChain?; systemPrompt?; userPrompt?; messages?; temperature?; maxTokens?; responseFormat?: "text"\|"json"; multimodal?; timeoutMs?; retries?; context?: { projectId?, stage?, stageName?, purpose? }; supabase? }` | опции |
| `CallGeminiResult` | `{ success; text?; parsed?; error?; providerUsed; modelUsed; fallbackUsed; fallbackPath; tokensIn; tokensOut; tokensThinking?; costUsd; latencyMs; attempts; rawResponse?; errorLog? }` | результат |
| `callGemini(opts)` | `→ Promise<CallGeminiResult>` | главная функция: цепочка провайдеров, ретраи, парсинг JSON, лог расхода |

Внутреннее: `PROVIDER_REGISTRY` (L113–171) — endpoint, модель по умолчанию, `extraBody`, источник ключа, тарифы; `defaultFallbackChain` (L173); `normalizeProvider` (L187); `getApiKey` (L198); `callOnceProvider` (L253); `logGeneration` (L487).

### `_shared/openrouter.ts` (234 строки) — старый прямой слой OpenRouter (используют шаги написания текста)
| Экспорт | Сигнатура | Назначение |
|---|---|---|
| `OPENROUTER_COSTS` | `Record<modelId, [in, out]>` | статическая таблица цен (17 моделей) |
| `openRouterCostRates(modelId)` | `→ [in, out]`, дефолт `[0.3, 1.2]` | тариф |
| `isOpenRouterModel(m)` / `openRouterModelId(m)` | префикс `openrouter:`; пустой id → `deepseek/deepseek-v4-pro` | разбор строки сценария |
| `getOpenRouterKey(sb)` | `→ string`, бросает исключение | ключ из `integrations` → env |
| `LAOZHANG_EQUIVALENTS` / `laoZhangEquivalent(id)` | OpenRouter-id → LaoZhang-id (6 пар) | подбор модели на резервном провайдере |
| `callOpenRouterMessages(sb, model, messages, opts)` | `→ Response` | OpenRouter с резервом на LaoZhang, **возвращает сырой `Response`** |
| `callOpenRouter(sb, model, system, user, opts)` | `→ Response` | обёртка над предыдущей |
| `extractOpenRouter(model, json)` | `→ { usage, content, cost, cost_input, cost_output, model_used, finish_reason, truncated, empty }` | разбор + стоимость; пустой контент → `"{}"` и `empty: true` |

### `_shared/promptSet.ts` (198 строк) — промты из наборов и модели шагов
| Экспорт | Сигнатура | Назначение |
|---|---|---|
| `fillVars(tpl, vars)` | `→ { text; missing: string[] }` | подстановка `{var}` и `{{var}}` |
| `ResolvedPrompt` | `{ system; user; content; model: string \| null; source }` | результат |
| `resolvePromptSetId(sb, project)` | `→ string \| null` | набор проекта или активный набор по нише/поднише/формату |
| `getPromptForStage(sb, setId, stageKey, promptId?)` | `→ ResolvedPrompt \| null` | промт шага (выбранный вариант или первый по `created_at`) |
| `loadStagePrompt(sb, project, stageKey)` | `→ ResolvedPrompt \| null` | `resolvePromptSetId` + `project.stage_prompt_ids[stageKey]` + `getPromptForStage` |
| `stageModel(project, stageKey, fallback)` | `→ provider` | часть до `:` из `project.stage_models[stageKey]` |
| `stageSubModel(project, stageKey)` | `→ model \| null` | часть после `:` |
| `stageLegacyModel(project, stageKey, fallback)` | `→ "openrouter:<id>" \| "laozhang*:<id>" \| "claude-haiku" \| "claude-sonnet" \| "lovable-gpt" \| "gpt-pro" \| "gemini-pro" \| "gemini-flash" \| fallback` | перевод выбора сценария в старые идентификаторы шагов 7.x |

### `_shared/billingGuard.ts` (43 строки)
`isBillingError(msg)` — подстроки `http 402`, `error 402`, `api 402`, `insufficient credits`, `insufficient_quota`, `配额不足`, `billing_exhausted`, `not enough balance`, `insufficient balance`.
`markBillingOut(sb, provider, error)` — upsert в `provider_billing_status` с `blocked_until = now + 15 мин`.
`billingBlocked(sb)` — `string | null`; **смотрит только строку `provider === "openrouter"`**.

### `_shared/serviceSlots.ts` (58 строк)
`SERVICE_LIMITS = { image_search: 6, image_gen: 6 }`; `acquireServiceSlot(sb, service, holder, {limit?, ttlSeconds?=180})` → RPC `acquire_service_slot`, при ошибке RPC **возвращает `true`** (fail-open); `releaseServiceSlot(sb, service, holder)` → RPC `release_service_slot`; `waitForServiceSlot(sb, service, holder, waitMs=45_000, opts)` — опрос с задержкой `min(5с, 1с×n)`.

### `_shared/applyScenario.ts` (70 строк)
`applyScenarioToProject(sb, projectId, scenarioId, publishMode?)` → копирует поля сценария в `projects` (см. §5).

### `_shared/countToken.ts` (131 строка)
`COUNT_TOKEN = "{{COUNT}}"`, `numberWord(n)`, `renderCount(text, n)`, `hasCountToken(text)`, `patchCount(text, actual)`, `retargetCount(text, oldN, newN)`, `countTokenPromptBlock()`. Количество идей в тексте — метка, число подставляется при сборке HTML (stage7-assemble-html, stage77, apply-review-exclusions).

### `_shared/jsonRepair.ts` (56 строк)
`repairTruncatedJson(src)` — достраивает обрезанный JSON; `parseModelJson(text)` — мягкий разбор (фенсы → срез `{…}` → достройка).

### `_shared/cron-auth.ts` (34 строки)
`authenticateCronRequest(req) → Response | null` — Bearer-токен сравнивается через sha256 + `timingSafeEqual` с `LOVABLE_CRON_SECRET` / `LOVABLE_CRON_SECRET_PREVIOUS`. **Ни одна функция его не импортирует** (grep по `authenticateCronRequest` даёт только сам файл) — мёртвый код; cron по `MIGRATION.md §5` ходит с anon-key.

### Типичные вызовы (паттерны использования)

**A. Полный «новый» шаг — `stage2-concept-plan/index.ts:177–262`**
`loadStagePrompt(supabase, project, "stage_2")` → если `!prompt.user` — исключение с подсказкой «заполните в разделе Промты»; собирается объект `vars`; `provider = stageModel(project, KEY, project.stage2_provider || "openrouter")`, `model = stageSubModel(project, KEY)`; `callGemini({ provider, model, fallbackChain: ["openrouter","laozhang_nothinking","poyo","lovable_gateway"], systemPrompt, userPrompt, responseFormat: "json", temperature: 0.8, maxTokens: 32000, timeoutMs: 300000, retries: 2, supabase, context: { projectId, stage, stageName, purpose } })`; затем `ai.parsed ?? parseJson(ai.text)`. Далее второй «ремонтный» вызов с тем же провайдером для идей вне контракта темы (L283+).

**B. Две попытки с разными цепочками и бюджетом времени — `stage-photo-plan/index.ts:189–233`** (аналогично `stage-photo-section-plan/index.ts:326–370`)
`attempts = [{ chain: [provider, "laozhang_nothinking"], temp: 0.7 }, { chain: ["laozhang_nothinking","lovable_gateway"], temp: 0.3 }]`; у каждой попытки `fallbackChain: [at.chain[0]]` (т. е. фолбэк внутри `callGemini` фактически отключён), `timeoutMs = max(20с, остаток бюджета 105с − 3с)`, `retries: 1`; при не-JSON ответе к user-промту дописывается «Return ONLY one valid JSON object…». `model` передаётся только когда провайдер попытки совпадает с выбранным в сценарии.

**C. Мультимодальный вызов — `ai-photo-moderate/index.ts:484–503`** (так же `stage-photo-rate:619`, `stage-photo-rank:174`, `stage-photo-select:112`)
`blocks: ContentBlock[]` = чередование `{type:"text"}` и `{type:"image_url", image_url:{url}}` (URL превью, предварительно проверенные `HEAD/GET` на доступность); `callGemini({ provider: "openrouter", model: useModel, systemPrompt, multimodal: blocks, responseFormat: "json", temperature: 0.1, maxTokens: 3000|12000, timeoutMs: 60_000|150_000, retries: 1 })` внутри собственного цикла из 2 попыток; стоимость всех попыток суммируется (`spent += r.costUsd`).

**D. Legacy-шаги текста — `stage7-write-intro/index.ts:337–375, 752–840`** (аналогично outro, sections)
Промт: сначала legacy `project.stage7_intro_prompt_id` (L321), затем **набор перекрывает**: `stage_7_writer_system` → `stage_7_intro_outro` → запасной `stage_7_intro`; дописываются `countTokenPromptBlock()` и жёсткое правило длины; `fillVars` из `promptSet` с предупреждением о `missing`. Модель: `stageLegacyModel(project, "stage_7_intro_outro", project.stage7_intro_outro_model || … || "claude-haiku")`. Диспетчер `callAI(model, …)`: `laozhang*:` → `callGemini` **с упаковкой результата в синтетический `Response`** (L768–776); `openrouter:` → `callOpenRouter`; `claude-*` → прямой Anthropic; иначе Lovable gateway по `MODEL_MAP`.

**E. Необязательный промт из набора с встроенным дефолтом — `_shared/photoQueries.ts:190–240`**
`configured = loadStagePrompt(…, "rp_photo_search")`; своя подстановка (`\{\{?key\}?\}`); `model: selectedModel || configured?.model || MODEL` — один из трёх мест, где используется колонка `prompts.model`.

---

## 2. Алгоритм `callGemini` (aiProvider.ts:328–485)

1. **Цепочка.** `primary = normalizeProvider(opts.provider)` (неизвестное значение → `openrouter`, подстрока `laozhang` → `laozhang_nothinking`, `google/`/`openai/` → `lovable_gateway`). `chain = dedupe([primary, ...(opts.fallbackChain ?? defaultFallbackChain(primary))])`. Цепочки по умолчанию (L173–185):
   - `openrouter → laozhang_nothinking → poyo → lovable_gateway`
   - `laozhang | laozhang_nothinking → openrouter → poyo → lovable_gateway`
   - `poyo → openrouter → laozhang_nothinking → lovable_gateway`
   - `lovable_gateway → openrouter → laozhang_nothinking → poyo`
2. **Попыток на провайдера** `perProviderRetries = max(1, retries ?? 2)`.
3. **Ключ** `getApiKey` (L198): сначала `integrations` (`service = cfg.integrationsService`, `is_active`, `order priority asc`, `limit 1`, без фильтра по пользователю), затем env `cfg.apiKeyEnv`. У `laozhang*` и `poyo` **`apiKeyEnv: null`** — env-переменные `LAOZHANG_API_KEY`/`POYO_API_KEY` в `callGemini` не читаются вовсе (L129, L140, L151). Нет ключа → запись в `errorLog`, `sleep(5000)` (если не последний), следующий провайдер.
4. **Модель.** Для первого провайдера — `opts.model` как есть. Для резервных: `laozhang*` ← `laoZhangEquivalent(requested)`; `openrouter` ← обратный поиск по `LAOZHANG_EQUIVALENTS`; иначе `null` → **модель провайдера по умолчанию из реестра** (flash-lite / gemini-3-flash). Молчаливое понижение класса модели на фолбэке.
5. **Один запрос** `callOnceProvider` (L253–326): `POST cfg.endpoint`, тело `{ model, messages, temperature: 0.7, max_tokens: 4096, ...cfg.extraBody, response_format?: {type:"json_object"} }`. `messages` = `opts.messages` либо `[system?, user(multimodal | userPrompt)]`. Таймаут `opts.timeoutMs ?? 60_000` через `AbortController`; **таймер не снимается после заголовков — покрывает чтение тела** (L288–311). Классификация: `!resp.ok`: 429 → `http_429`, 400–499 → `http_4xx`, остальное → `http_5xx`; тело не JSON / нет `choices[0].message.content` / пустая строка → `empty`; `AbortError` → `timeout`; прочее → `transport`.
6. **Политика повторов** (L438–458):
   - `http_429` → `sleep(5000)` и повтор на том же провайдере, после исчерпания → следующий;
   - `http_5xx` → `sleep(3000)` и повтор, затем следующий;
   - `http_4xx` → **сразу** следующий провайдер (без повтора);
   - `transport | timeout | empty` → **сразу** следующий провайдер (без повтора на том же). *(MIGRATION.md §6.1 утверждает «5xx/таймаут/пустой ответ → повтор, затем следующий» — для таймаута и пустого ответа это не так.)*
   - Перед переходом к следующему провайдеру всегда `sleep(5000)` (L462).
7. **402 / биллинг** (L434–436): при `status === 402` или `isBillingError(msg)` → `markBillingOut(sb, provider→"laozhang" для nothinking, msg)`. Выполнение **продолжается** по цепочке. При полном провале к ошибке добавляется префикс `BILLING_EXHAUSTED: ` (L468–471), на который реагирует `direct-pipeline:1288` (статья в `pending`).
8. **PROHIBITED_CONTENT.** В коде `_shared` и во всех функциях нет ни одного вхождения `prohibited`/`safety`-обработки (grep без учёта регистра). Повтор «без картинок» существует только в `stage7-write-sections:2395–2405` и срабатывает по тексту ошибки `image input|image_url|does not support image`. Пункт MIGRATION.md «Gemini PROHIBITED_CONTENT → повтор без картинок» коду не соответствует.
9. **Reasoning off.** Только через `extraBody`: `lovable_gateway: { reasoning: { effort: "none" } }`, `poyo: { thinkingBudget: 0 }` (нестандартный верхнеуровневый ключ, эффект по коду не подтверждается). Для `openrouter` и `laozhang*` в `callGemini` **размышления не отключаются**; `laozhang` и `laozhang_nothinking` отличаются только моделью по умолчанию (`gemini-2.5-flash` vs `gemini-2.5-flash-lite`) и тарифом в реестре — тело запроса одинаковое. Отключение reasoning для DeepSeek есть лишь в `openrouter.ts:111–113`.
10. **Успех** (L381–425): `usage.prompt_tokens/completion_tokens/completion_tokens_details.reasoning_tokens`; тариф: `openrouter` → `openRouterCostRates(model)` (таблица, дефолт `[0.3,1.2]`), `laozhang*` → `laoZhangCostRates(model)`, `poyo`/`lovable` → константы реестра. `cost = in·rateIn + out·rateOut + thinking·(openrouter ? rateOut : cfg.pricingThinkingPerM)`. Поскольку в OpenAI-совместимом `usage` `reasoning_tokens` уже входят в `completion_tokens`, слагаемое thinking **считает их второй раз** (для openrouter всегда, для laozhang при 2.40/M). `parsed` = `JSON.parse(stripJsonFences(text))` либо `undefined` (без ремонта, без ошибки — `success: true`).
11. **Лог `generations_log`** (`logGeneration`, L487–526): только если есть `context.projectId` и `supabase`. Поля: `project_id, stage, api_service(=providerUsed), api_endpoint, model_used, tokens_in, tokens_out, tokens_thinking, cost_input, cost_output, cost_thinking, cost_usd, latency_ms, is_retry(attempts>1), is_wasted(!success), waste_reason, status("success"|"error"), error_message(≤500), request_summary("<stageName> via <provider> (fallback: yes|no)"), metadata{fallback_path, fallback_used, attempts, purpose}`. Пишется **одна строка на вызов** (не на попытку); неудачные попытки на других провайдерах в лог не попадают (только в `errorLog` результата).
12. **Полный провал** (L467–484): `providerUsed = последний в цепочке`, `modelUsed = его модель по умолчанию`, стоимость 0, `error = "All providers failed: p#n=[kind] msg | …"` (≤800 символов).

Худший случай по времени при `retries: 2`, `timeoutMs: 60с`, 4 провайдерах: ≈ 4×(2×60 + 5/3) + 3×5 ≈ 8,5 мин (в Edge Functions всё равно обрывается платформой ~150 с, о чём пишут комментарии в шагах).

---

## 3. JSON-ответы и подсчёт токенов

**Разбор в `callGemini`:** только срез ```` ```json ```` -фенсов + `JSON.parse`; при неудаче `parsed = undefined`, вызывающий сам решает (все шаги делают `ai.parsed ?? parseJson(ai.text)`).

**`jsonRepair.parseModelJson`** (L40–56): 1) снять фенсы; 2) `JSON.parse`; 3) срез от первой `{` до последней `}`; 4) `repairTruncatedJson(от первой {)`. **`repairTruncatedJson`** (L7–37): сканер со стеком скобок и состоянием «внутри строки»; запоминает `lastGoodIdx` — позицию последней `,`/`}`/`]` на глубине ≤ 2 (предполагается `{ "key": [ {…}, {…} ] }`); если обрыв — обрезает до неё, пересчитывает незакрытые скобки и дописывает их. Ограничения: для более глубоких структур отбрасывает больше, чем нужно; при обрыве внутри первой строки без `lastGoodIdx` получится невалидный JSON → `JSON.parse` бросит (ошибку перехватывает вызывающий).

Дубли: та же функция скопирована в `stage2-concept-plan/index.ts:65–98` (идентична) и `trend-research/index.ts:487` (своя версия, возвращает `any | null`). `ai-photo-moderate`, `stage-photo-rate`, `photoQueries`, `parse-keyword-ai` используют ещё более простой разбор `text.match(/\{[\s\S]*\}/)`.

**Повторы при плохом JSON** живут в шагах, не в `callGemini`: photo-plan/section-plan — вторая попытка с другой цепочкой и дописанным требованием «ONLY one valid JSON object»; intro/outro — до 5 попыток с `correction`-блоком; moderation — 2 попытки.

**Токены:** собственного счётчика нет — берутся `usage.*` ответа; если провайдер не вернул `usage` — нули (и стоимость 0). `countToken.ts` — не про токены LLM, а про метку количества идей `{{COUNT}}`: `renderCount` подставляет число; `patchCount` чинит «живые» числа рядом с существительными из `ITEM_NOUNS` (5…40, с защитой от единиц измерения и «of/per/to»); `retargetCount` заменяет **любое** отдельно стоящее `oldN` (защита только от соседних цифр/точек/запятых — «25 minutes» тоже заменится).

---

## 4. Резолвинг промта шага и модели шага

### Промт
Порядок в `loadStagePrompt` (`promptSet.ts:138–146`):
1. `setId = project.prompt_set_id` **без проверки `is_active`**; иначе активный `prompt_sets` по `niche_code` + `article_format || "generated_photo"` + `subniche_code` (точное совпадение или `IS NULL`) + `is_active`, `limit 1 maybeSingle` (L62–83).
2. `promptId = project.stage_prompt_ids[stageKey]` → запись `prompts` с этим `id` **и `set_id = setId`**, но **без проверки `stage_key`** (L99–106): неверно собранный `stage_prompt_ids` подставит промт другого шага.
3. Иначе первый по `created_at asc` промт с `stage_key` в наборе (**`is_active` промта игнорируется**, L108–116).
4. `system` = `system_part` или часть до `---USER---`; `user` — остальное.
5. В шагах далее: legacy-поля проекта (`stage7_intro_prompt_id` и т. п.) и/или встроенные `FALLBACK_SYSTEM/USER` (photo-plan, section-plan, photoQueries); stage2 без промта **падает**.

Ключи шагов, встреченные в коде: `stage_1`, `stage_2`, `stage_5_scene_planner`, `stage_55_review`, `stage_55_ordering`, `stage_6_image_seo`, `stage_64`, `stage_7_writer_system`, `stage_7_writer_user`, `stage_7_intro_outro` (+ legacy `stage_7_intro`, `stage_7_outro`), `stage_8_meta`, `rp_photo_search`, ключи photo-plan/section-plan/photo-rate (константы `STAGE_KEY` в функциях).

### Переменные
`fillVars` (promptSet) понимает `{var}` и `{{var}}` (имя `[a-zA-Z0-9_]+`, пробелы внутри скобок допустимы), ключи `vars` нормализуются (`{{x}}`, `{x}`, `x`), не-строки → `JSON.stringify`, `null/undefined` → `""`. Неизвестная переменная **остаётся в тексте как есть** и возвращается в `missing` (шаги только пишут `console.warn`). `{{COUNT}}` формально тоже «missing», но именно поэтому доживает до сборки HTML.

Наборы переменных по шагам (из call-sites):
- `stage_2`: `niche_label, topic_facts, concept_fields, topic, focus_keyword, count_items, sections_count, language, target_country, niche, subniche, target_word_count, article_personality, keywords_table` (`stage2-concept-plan:198–219`).
- photo-plan: `topic, topic_kind, niche_label, subject_label, required_facts, focus_keyword, language, target_country, niche, subniche, count_items, sections_count, total_sections, target_word_count, article_personality, photos_table, photo_captions, outfit_mode, fashion_contract, decor_mode, hero_element, setting, interior_contract` (`stage-photo-plan:160–186`); section-plan — то же + `photo_facts_table, angles, openers`.
- `rp_photo_search`: `focus_keyword, topic, language, target_country, niche, subniche, outfit_mode, fashion_contract, decor_mode, hero_element, setting, interior_contract`.
- `stage_7_*` (по PROMPTS.md и intro/sections): `focus_keyword, primary_keyword, total_outfits, article_personality, topic_kind, required_facts, article_context, trend_context, trend_details, content_angle, subcategories, previous_ending, outro_plan, care_plan, batch_size, batch_number, total_batches, scene_context, hair_brief, cut_specs, previous_batch_summary, keywords_bolded_previous, section_briefs`.

**Четыре разные реализации подстановки**: `promptSet.fillVars` (обе формы скобок, отчёт о missing); локальные `fillVars` в `stage2-concept-plan:52`, `stage-photo-plan:58`, `stage-photo-section-plan:75` — **только `{var}`**: на `{{focus_keyword}}` они заменят внутреннее `{focus_keyword}` и оставят `{значение}` в скобках; `photoQueries:204` — регексп `\{\{?key\}?\}` только по известным ключам, без отчёта.

### Модель
Порядок (фактический):
1. `project.stage_models[stageKey]` (скопировано из `scenarios.stage_models` при `applyScenarioToProject`). Формат **`provider:model`**: `stageModel` отдаёт часть до первого `:` (или всю строку, если `:` нет), `stageSubModel` — после. Примеры: `openrouter:deepseek/deepseek-v4-flash`, `laozhang_nothinking:gemini-2.5-flash-lite`, `lovable_gateway`.
2. Аргумент `fallback` = legacy-колонка проекта `stageNN_provider` (`stage2_provider`, `stage6_provider`, `stage16_provider`, `stage55_provider`, `stage77_provider`, `stage1_provider`, `parse_keyword_provider`).
3. Жёсткий дефолт в коде шага — **разный**: `"openrouter"` (stage2, photo-plan, section-plan, stage6, stage77, photoQueries), `"laozhang_nothinking"` (stage64, outfit-concepts, trend-research), `"lovable_gateway"` (stage55 review/ordering).
4. Подмодель: `stageSubModel` → иногда жёсткий дефолт (`google/gemini-2.5-flash-lite` в section-plan, stage77) → иначе `null` → модель провайдера из `PROVIDER_REGISTRY`.
5. Колонка `prompts.model` (дефолт `google/gemini-3-flash-preview`) возвращается в `ResolvedPrompt.model`, но используется только в `stage64-keyword-research:617,630`, `trend-research:65`, `photoQueries:225` — в остальных шагах игнорируется.

Для шагов 7.x дополнительно `stageLegacyModel` (L170–198): `openrouter:` и `laozhang*:` проходят как есть, остальное схлопывается в `claude-haiku|claude-sonnet|lovable-gpt|gpt-pro|gemini-pro|gemini-flash`; если в сценарии пусто — legacy-поля `stage7_*_model` → `"claude-haiku"` (прямой Anthropic, см. §8).

---

## 5. billingGuard, serviceSlots, applyScenario — влияние на очередь

**`provider_billing_status`** (`provider PK, blocked_until, last_error, updated_at`). Пишут: `callGemini` (любой провайдер при 402/биллинг-строке), `callOpenRouterMessages` (только 402 openrouter), `direct-pipeline:1290`. Читает только `billingBlocked()` → **только `openrouter`**. Эффект: `queue-orchestrator:843` не запускает новые статьи, пока блок активен; `queue-orchestrator:650` зависшую статью при активном блоке возвращает в `pending` вместо `failed`; `direct-pipeline:1288` при ошибке с биллинг-признаком возвращает статью в `pending` на тот же этап (курсор сохраняется). Блоки LaoZhang/PoYo/Lovable пишутся, но ни на что не влияют. Через 15 минут блок истекает сам — «одна пробная попытка» реализуется просто истечением.

**`service_leases` + RPC** (`acquire_service_slot(p_service, p_holder, p_limit, p_ttl_seconds=180)`, `release_service_slot`): удаляет просроченные, тот же `holder` продлевает аренду (re-entrant), иначе `count < limit` → вставка. Использование — **только** `stage-photo-search:47` (`image_search`, лимит 6, ожидание 45 с, при неудаче ответ `{retry: true, reason: "image_search_busy"}` и оркестратор пробует позже). Константа `image_gen` не используется нигде. **К ИИ-вызовам ограничитель не применяется** — параллелизм запросов к OpenRouter/LaoZhang ограничен только числом одновременно запущенных статей в оркестраторе.

**`applyScenarioToProject`**: читает `scenarios.*`, в `projects` пишет `execution_mode, stage5_mode, stage5_prompt_id, stage5_group_id, stage_prompt_ids, stage_models` (последние два — `|| {}`, т. е. пустой сценарий **стирает** ручные настройки проекта), `niche_code/subniche_code/article_format/prompt_set_id` только если заданы, `OPTIONAL_FIELDS` (23 поля) только не-null, `publish_mode` (аргумент > сценарий > `publish_then_edit`), `stage7_4_enabled` внутрь JSON `stage7_output_settings`. Ошибка `update` **только логируется**, функция всё равно возвращает сценарий → вызывающие (`queue-orchestrator:2898`, `direct-pipeline:2652`) о неудаче не знают.

---

## 6. Внешние API

| Провайдер | URL | Заголовки | Тело | Разбор |
|---|---|---|---|---|
| **OpenRouter** (`callGemini`) | `POST https://openrouter.ai/api/v1/chat/completions` | `Content-Type: application/json`, `Authorization: Bearer <key>`, `HTTP-Referer: https://zewex.app`, `X-Title: Zewex Pinterest Articles` | `{model, messages, temperature(0.7), max_tokens(4096), response_format?:{type:"json_object"}}` | `choices[0].message.content`, `usage.prompt_tokens/completion_tokens/completion_tokens_details.reasoning_tokens` |
| **OpenRouter** (`openrouter.ts`) | то же | то же | `{model, temperature(0.6), max_tokens(8192), response_format(json, если не `json:false`), reasoning:{enabled:false, exclude:true} для `/deepseek/i`, messages}` | `extractOpenRouter`: + `finish_reason` (`length` → `truncated`), пустой → `"{}"`/`empty` |
| **LaoZhang** | `POST https://api.laozhang.ai/v1/chat/completions` | `Bearer` | то же, что OpenRouter-тело соответствующего слоя; модели `gemini-2.5-flash(-lite)`, `deepseek-v4-flash/pro` | OpenAI-формат |
| **PoYo** | `POST https://api.poyo.ai/v1/chat/completions` | `Bearer` | + `thinkingBudget: 0`; модель по умолчанию `gemini-3-flash` | OpenAI-формат |
| **Lovable AI Gateway** | `POST https://ai.gateway.lovable.dev/v1/chat/completions` | `Bearer <LOVABLE_API_KEY>` | `callGemini`: + `reasoning:{effort:"none"}`, `max_tokens`; прямые вызовы в stage7-*: `max_completion_tokens`, `response_format json_object`, `reasoning:{effort:"none"}` | OpenAI-формат |
| **Anthropic** (только stage7-write-*) | `POST https://api.anthropic.com/v1/messages` | `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-beta: prompt-caching-2024-07-31` | `{model: claude-haiku-4-5-20251001 \| claude-sonnet-4-20250514, max_tokens, temperature, system:[{type:"text", text, cache_control:{type:"ephemeral"}}], messages}` | `content[0].text`, `usage.input_tokens/output_tokens/cache_*`; цены захардкожены `[1,5]`/`[3,15]` |
| **OpenAI** | в текстовом слое не используется; `api.openai.com/v1/images/{generations,edits}` — только генерация картинок (stage5, test-openai-image), `check-api-key` проверяет `/v1` как OpenAI-совместимый | | | вне зоны отчёта |

Проверка ключей (`check-api-key`): `GET https://openrouter.ai/api/v1/key`, OpenAI-совместимые пробные вызовы для LaoZhang/PoYo/OpenAI.

Источники ключей по провайдерам (фактические): OpenRouter — `integrations(service="openrouter")` → env `OPENROUTER_API_KEY`; LaoZhang — `integrations("laozhang")` (в `openrouter.ts` ещё env `LAOZHANG_API_KEY`); PoYo — только `integrations("poyo")`; Lovable — только env `LOVABLE_API_KEY`; Anthropic — `integrations("anthropic")` → env `ANTHROPIC_API_KEY`. Значение `encrypted_api_key` используется как Bearer **напрямую** — никакого `decrypt` в функциях нет, ключи лежат в БД открытым текстом.

---

## 7. Зависимости от Supabase — список для замены

**Клиент** (`sb.from(...)`, `sb.rpc(...)`, передаётся параметром `supabase`/`sb` во все функции слоя):
- `integrations` — `select encrypted_api_key where service, is_active order priority limit 1` (aiProvider:202–209, openrouter:41–46, 73–78, stage7-*:740+). → у нас `ApiKey`/`Provider`/`Binding` + `resolveSlot`.
- `generations_log` — `insert` (aiProvider:496; плюс собственные вставки в stage7-intro:573,598, outro:332,362, sections:864,925,2379,2410, stage77:670,704). → `UsageLog` через `runSlot`.
- `provider_billing_status` — `upsert onConflict provider`, `select … gt blocked_until`. → новая маленькая таблица или поле в настройках воркера.
- `service_leases` + RPC `acquire_service_slot`/`release_service_slot`. → in-process семафор в воркере.
- `prompt_sets` — `select id where niche_code, article_format, is_active, subniche_code|null`; `prompts` — `select id, content, system_part, model where id&set_id | set_id&stage_key order created_at`. → новые Prisma-модели `ArticlePromptSet`/`ArticlePrompt`.
- `scenarios` — `select *`; `projects` — `select stage7_output_settings`, `update <23+ полей>`. → снимок настроек в JSON прогона.
- Вызывающие функции: `createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)`, `Deno.serve`, `workflow_stages` upsert, `article_queue` update.

**Env (`Deno.env.get`)**: `OPENROUTER_API_KEY`, `LOVABLE_API_KEY`, `LAOZHANG_API_KEY` (только openrouter.ts), `ANTHROPIC_API_KEY` (stage7), `LOVABLE_CRON_SECRET(_PREVIOUS)` (мёртвый cron-auth), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.

**Deno-специфика**: `Deno.env`, `Deno.serve`, `import … from "./x.ts"` с расширениями, `node:crypto` в cron-auth, глобальный `fetch`/`AbortController` (в Node 20+ есть). Передача результата между `callAI` и `extractResult` через объект `Response` (в т. ч. синтетический, stage7-intro:768–776) — артефакт, который переносить не надо.

---

## 8. Слабые места (конкретные находки)

Баги и несоответствия поведения:
1. **`aiProvider.ts:129,140,151` — `apiKeyEnv: null` у `laozhang`, `laozhang_nothinking`, `poyo`.** `callGemini` берёт их ключи только из `integrations`; секреты `LAOZHANG_API_KEY`/`POYO_API_KEY` из `MIGRATION.md §4` для него не существуют. Там же §4 говорит «`getApiKey()` сначала смотрит env, потом `integrations`» — в коде порядок обратный (L200–218).
2. **`aiProvider.ts:394` — двойной учёт reasoning-токенов.** `completion_tokens` в OpenAI-совместимом `usage` уже включает `reasoning_tokens`; слагаемое `costThinking` (для openrouter по `rateOut`, для laozhang по 2.40/M) добавляется поверх. Статистика расхода завышена на моделях с размышлениями.
3. **`aiProvider.ts:113–171` — «nothinking» не отключает размышления.** `laozhang` и `laozhang_nothinking` шлют одинаковое тело; для openrouter в `callGemini` reasoning не отключается вообще (только в `openrouter.ts:111` и только DeepSeek). PoYo получает нестандартный `thinkingBudget` в корне тела. Комментарий о DeepSeek в `openrouter.ts:109` («тратит весь лимит на размышления и отдаёт пустой текст») описывает проблему, которую `callGemini` для тех же моделей не решает.
4. **`aiProvider.ts:454–458` — таймаут и пустой ответ не повторяются на том же провайдере**, сразу переключение; `MIGRATION.md §6.1` утверждает обратное. При `fallbackChain: [единственный]` (photo-plan:214) один таймаут = провал попытки без ретрая.
5. **`aiProvider.ts:472–473, 500` — ошибка приписывается последнему провайдеру цепочки** (`lovable_gateway`), а не тому, где всё началось; `api_endpoint` в логе тоже его. Аналитика «кто падает» по `generations_log` искажена; попытки на промежуточных провайдерах в лог не попадают вовсе.
6. **`promptSet.ts:99–106` — выбранный `promptId` не проверяется на `stage_key`**; `promptSet.ts:108–116` — игнорируется `prompts.is_active`; `promptSet.ts:66` — `project.prompt_set_id` берётся без проверки `prompt_sets.is_active`.
7. **Четыре реализации подстановки переменных** (`promptSet.fillVars`; локальные в `stage2-concept-plan:52`, `stage-photo-plan:58`, `stage-photo-section-plan:75` — только одинарные скобки; `photoQueries:204`). Промт stage_2 в PROMPTS.md использует `{subniche}`, промты stage_7 — `{{var}}`; перенос промта между шагами ломает подстановку (остаются `{значение}`).
8. **`applyScenario.ts:39–40,65–66`** — пустые `stage_prompt_ids`/`stage_models` сценария затирают настройки проекта; ошибка `update` глотается, вызывающий считает сценарий применённым.
9. **`billingGuard.ts:38`** — блокируется очередь только по `openrouter`; записи других провайдеров бесполезны. `isBillingError` — хрупкое сравнение подстрок: `stage77:285` формирует `OpenRouter error: 402 …` (с двоеточием), под шаблон `error 402` не попадает — срабатывает лишь если в теле есть `Insufficient credits`.
10. **`stage7-write-intro:375`, `sections:538`, `outro:197`** — при пустом сценарии и пустых legacy-полях модель = `"claude-haiku"` → прямой Anthropic, ключ которого `MIGRATION.md §4` называет устаревшим. В sections есть фолбэк на Lovable при 4xx (L2188–2203), в intro/outro — нет: шаг упадёт.

Гонки, потери, расточительность:
11. **`aiProvider.ts:355,462` — фиксированные `sleep(5000)`** при отсутствии ключа и перед каждым следующим провайдером, даже после мгновенного 4xx (например, 404 «модель не найдена»). На самохостинге без `LOVABLE_API_KEY` каждая цепочка гарантированно теряет 5 с на пустом провайдере.
12. **Двойная запись расхода на пути `laozhang*:` в stage7-write-sections**: `callGemini` логирует (контекст с `projectId`, L2113) и сам шаг пишет итог в `generations_log` (L864). В intro/outro `callGemini` вызывается без `projectId` (L766) — там, наоборот, логирует только шаг. Единого правила нет.
13. **`openrouter.ts:94,117–119` — таймер снимается в `finally` сразу после получения заголовков**; чтение тела (`resp.json()` у вызывающего) не ограничено — ровно та проблема, от которой защищается комментарий в `aiProvider.ts:288`. При зависшем OpenRouter шаг доживает до обрыва платформой.
14. **`openrouter.ts:122–184`** — нет ретраев на 429/5xx (ретраи 429 реализованы отдельно в `sections:2364–2390` с ожиданием до 90 с), нет лога в `generations_log`; дефолтный тариф расходится: `openRouterCostRates` → `[0.3,1.2]`, `extractOpenRouter` → `[1,2]` (L218).
15. **Статическая таблица цен `OPENROUTER_COSTS`** вместо `usage: {include: true}` (точная стоимость от OpenRouter, которую наш `adapters.ts` уже запрашивает) — цены неизбежно устаревают; `laoZhangCostRates` — эвристика по подстроке имени.
16. **Молчаливое понижение модели на фолбэке** (`aiProvider.ts:365–375`): если для запрошенной модели нет эквивалента, резервный провайдер получает `gemini-2.5-flash-lite`/`gemini-3-flash` — для шага с `gemini-3.1-pro` это другой класс качества без сигнала наверх (кроме `modelUsed`).
17. **Нет ограничителя параллельных ИИ-вызовов**: `serviceSlots` используется лишь для поиска картинок; `SERVICE_LIMITS.image_gen` — мёртвая константа; при ошибке RPC лимитер **разрешает** вызов.
18. **`timeoutMs: 300000`** в `stage2-concept-plan:252` при лимите edge-функции ~150 с (комментарии в photo-plan) — таймаут недостижим, обрывает платформа без фолбэка.

Безопасность:
19. **`encrypted_api_key` не зашифрован** (нет ни одного `decrypt`), выборка в `getApiKey` **без `user_id`** — ключ любого пользователя; при переносе брать ключи только через наш `resolveSlot`/`decryptSecret`.
20. `errorMessage` включает до 300 символов тела ответа провайдера и уходит в `generations_log.error_message` и в сообщение ошибки статьи — обычно безвредно, но стоит ограничить.

Мёртвый/дублирующий код: `cron-auth.ts` (не импортируется), `SERVICE_LIMITS.image_gen`, поля `pricingInputPerM/OutputPerM` у `openrouter`/`laozhang*` в реестре (перекрываются функциями тарифов), `repairTruncatedJson` ×3, `fillVars` ×4, `stageLegacyModel` → `MODEL_MAP` (`lovable-gpt`, `gpt-pro`, `gemini-pro` — Lovable-only модели).

---

## 9. Что перенести как есть / что упростить

**Перенести почти как есть**
- `promptSet.fillVars` — как единственную реализацию подстановки (убрать 3 локальные копии и `photoQueries.fill`); сохранить поведение «неизвестная переменная остаётся в тексте» (ради `{{COUNT}}`) и возврат `missing`.
- Порядок резолвинга промта (набор проекта → активный набор по нише/поднише/формату → выбранный вариант → первый вариант → встроенный дефолт) и формат `provider:model` (`stageModel`/`stageSubModel`). Добавить проверки `stage_key` и `is_active`.
- `jsonRepair.parseModelJson` — целиком; использовать его **внутри** нашего аналога `callGemini` вместо «голого» `JSON.parse`, чтобы `parsed` был заполнен и для обрезанных ответов.
- `countToken.ts` — целиком (это бизнес-правило сборки статьи), с оговоркой про `retargetCount`.
- Таблица эквивалентов моделей между провайдерами (`LAOZHANG_EQUIVALENTS`) — как данные в настройках, а не константа.
- Шаблоны `isBillingError` и идея «биллинг-ошибка возвращает статью в очередь, а не роняет её».
- Контракт результата `CallGeminiResult` (`text, parsed, providerUsed, modelUsed, fallbackPath, tokens, costUsd, attempts, errorLog`) — удобен шагам, их переписывать не придётся.

**Упростить / заменить**
- Транспорт `callOnceProvider` → `runSlot`/`runProvider` из `src/lib/run.ts`/`adapters.ts`: ключи, таймаут, точная стоимость OpenRouter (`usage.include`), запись в `UsageLog` уже есть. Слой статей добавляет только: цепочку слотов (например `articles.text_main`, `articles.text_fallback_1..n`), политику ретраев и парсинг JSON. **Одно место логирования** — убрать собственные вставки в `generations_log` из шагов 7.x/77 и синтетические `Response`.
- Ретраи: 429/5xx/timeout/empty — повтор с экспоненциальной задержкой и джиттером на том же провайдере, 4xx — сразу дальше, **без фиксированных 5 с** между провайдерами; логировать каждую неудачную попытку с её провайдером.
- Reasoning: явный параметр на провайдера/модель (`reasoning: {effort:"none"}` для OpenRouter/OpenAI-совместимых, `reasoning_effort`/`thinking_config` где поддерживается) вместо пары `laozhang`/`laozhang_nothinking`. Стоимость thinking не добавлять поверх `completion_tokens`.
- Убрать `lovable_gateway` из цепочек (ключа на самохостинге нет) и прямой Anthropic (не OpenAI-совместим; при необходимости — `anthropic/*` через OpenRouter). Выкинуть `stageLegacyModel` и `MODEL_MAP`: все шаги получают `provider:model` одним способом.
- `serviceSlots` → in-process семафор в воркере (`p-limit`-подобный, по ключу сервиса), т. к. воркер один процесс; DB-аренды нужны только при нескольких воркерах. Добавить такой же лимит на ИИ-вызовы.
- `billingGuard` → карта `provider → blockedUntil` в памяти воркера с зеркалом в БД (чтобы переживать рестарт и показывать в UI); проверять **все** провайдеры цепочки, а не только первый.
- `applyScenario` → один снимок настроек сценария в JSON прогона при создании (как `PinRun.settings`), без копирования 25 колонок и без тихого затирания.
- `cron-auth.ts` не переносить (нет HTTP-cron, воркер крутит очередь сам).
- Таблица цен `OPENROUTER_COSTS`/`laoZhangCostRates` — заменить на `Model.priceIn/priceOut` в нашей базе и точную стоимость из ответа OpenRouter.
