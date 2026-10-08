# pins/stages — порт серверной логики из Lovable/Supabase

Чистые функции над данными (без Prisma); сеть только через `@/lib/pins/fetch` (safeFetch), ИИ — через `@/lib/pins/ai/client`.

| Модуль | Что делает | Заменяет в legacy |
|---|---|---|
| `redirects.ts` | `checkRedirects(urls)` — конечный URL/статус (HEAD, при 403/404/405/5xx — GET), 8 параллельно | `supabase/functions/check-redirects` |
| `meta.ts` | `extractMeta(urls)` — title, H1, число контентных фото и H2-секций с фото, lang, og:image; `parsePageMeta(html)` для тестов | `bulk-extract-meta` + `bulkEngine.extractMeta` |
| `keywords.ts` | `detectKeywords(ctx, input)` — ключ, тема, сезон, доски (один JSON-вызов `text_fast` на 8 страниц) + ниша локально; `fallbackKeyword(page)` | `bulk-detect-keyword`, `bulkEngine.detectKeywords/autoDetectPages`, `autopilotExtras.fallbackKeyword` |
| `photos.ts` | `extractArticleImages(url, {featuredOnly})` — фото по H2-секциям (≤200) или миниатюра для сайтов рецептов; `isLikelyAuthorPhoto`, `stripAuthorBox`; `pickPhotosForPage`, `frequentImages` | `extract-article-images`, `_shared/authorPhoto.ts`, `bulkEngine.extractArticlePhotoPoolBatch`, `autopilotExtras.collectAutopilotPhotos`, фильтр сайтовых фото из `canvasAutoBuild` |
| `niche.ts` | `detectNiche(text)`, `detectPageNiche(page)` — ниша по словарю маркеров | `src/lib/nicheDetect.ts` (1:1) |
| `topics.ts` | `PAGE_TOPICS`, `TOPIC_LABEL` — справочник тем страниц | `src/lib/pageTopics.ts` (1:1) |

Отличия от legacy (намеренные):
- `checkRedirects`: safeFetch сам следует редиректам (и проверяет конечный хост от SSRF), поэтому `hops` = 0/1, а не точное число прыжков; сначала HEAD, затем GET.
- `detectKeywords`: ответ — объект `{"results":[...]}` (нужен для `response_format: json_object`); правило про цифры в ключе: значимые (возраст, размер) сохраняются, декоративные (год, «10 идей») убираются. Страница без ответа модели получает `keyword: ""` — вызывающий подставляет `fallbackKeyword`. `AiError` пробрасывается, повторы делает воркер.
- `extractArticleImages`: дедупликация по ключу без query и WP-суффикса размера; у картинок есть `indexInSection` (0 = первое фото секции — только такие берёт `pickPhotosForPage`); ссылки на товары (stl-block) и «photo credit» не переносились.
- `bulk-wp-posts` (список постов WordPress) сюда не переносился — он относится к этапу `pages`, а не к стадиям разбора.
