# pins/wp — клиент WordPress REST API

Порт `supabase/functions/bulk-upload-wp` и `bulk-wp-posts` из legacy (Deno) на Node 24. Чистые функции без Prisma; адрес сайта задаёт пользователь, поэтому ходим обычным `fetch` с Basic-авторизацией (Application Password), а не через `safeFetch`.

| Экспорт | Что делает | Заменяет в legacy |
|---|---|---|
| `normalizeBaseUrl(url)` | `https://` по умолчанию, без хвостовых слэшей и случайного `/wp-json…` | `conn.baseUrl.replace(/\/+$/, "")` |
| `testConnection(creds, opts?)` | `GET /users/me?context=edit` → `{ ok, note, user? }`; предупреждает, если нет права `upload_files` | `bulk-upload-wp` с `test: true`, `bulkEngine.testWpConnection` |
| `uploadMedia(creds, file, meta, opts?)` | `POST /media` бинарным телом + `Content-Disposition: attachment`, затем best-effort `alt_text/title/caption`; `{ id, url, warning? }` | `uploadToWp` в `bulk-upload-wp` |
| `uploadMediaBatch(creds, items, opts?)` | то же пакетом, не больше 3 одновременно, ошибка одного файла не ломает остальные | `runLimited(list, 3, …)` в `bulk-upload-wp`, `bulkEngine.uploadBatchToWp` |
| `listPosts(creds, params, opts?)` | одна страница постов/страниц с `_embed=wp:featuredmedia` → `{ posts, totalPages, total }` | `bulk-wp-posts` action `posts` |
| `listAllPosts(creds, params, opts?)` | все страницы с паузой, лимитом и частичным результатом при сбое | `bulkEngine.fetchWpPosts` |
| `listTaxonomies(creds, opts?)` | категории и метки (по 100, по убыванию count) | `bulk-wp-posts` action `taxonomies`, `bulkEngine.fetchWpTaxonomies` |
| `rewriteLinkDomain(url, linkDomain?)` | подмена схемы и хоста ссылки пина (`link_domain`) | настройка подключения (в legacy применялась только в UI) |
| `mediaUrlOnDomain(url, mediaDomain?)` | подмена хоста у адреса медиафайла (`media_domain`) | `rewrite()` в `stageUpload` воркера |
| `mapLimited`, `safeFilename`, `stripHtml`, `WpError` | вспомогательные | — |

Сетевые правила: таймаут через `AbortSignal` (20 с на запросы, 90 с на загрузку), повторы только при сети/429/5xx с паузой `2000·(n+1)` мс (не больше 3 повторов, `Retry-After` учитывается), 4xx отдаются сразу. Отмена через `opts.signal` повторов не вызывает.

Отличия от legacy (намеренные):
- Файл приходит уже готовым (`{ data: Buffer; filename; mime }`): скачивание источника, пересборка в JPEG и прокси `images.weserv.nl` сюда не переносились — это делает `@/lib/pins/images` (`toCleanJpeg`) и вызывающий код.
- Подписи к файлу обновляются `POST /media/{id}` (как в legacy; WP принимает его наравне с PATCH, а PATCH часто режет хостинг). Добавлен `caption`.
- `listPosts` возвращает по одной странице с `id` и `featuredImage`; чанки «3 страницы за вызов» из edge-функции не нужны — пагинацию ведёт `listAllPosts`. Страница за пределами диапазона (`rest_post_invalid_page_number`) — пустой список, а не ошибка.
- `rewriteLinkDomain`: в legacy `link_domain` хранился, но к ссылкам не применялся (только автовыбор подключения по домену); здесь — та же подмена хоста, что и для `media_domain`.
- Все ошибки REST — `WpError` со `status` и `code` WP; сообщения на русском, как в legacy.
