# Планировщики пинов (`src/lib/pins/plan`)

Чистые функции без Prisma и React: воркер читает прогон, зовёт планировщик, вставляет `PinRunItem`.
Все алгоритмы детерминированы по `seed` (`RunSettings.seed`) — повторный запуск даёт тот же план.

| Файл | Что делает |
|---|---|
| `seed.ts` | `hash32`, `mulberry32`, `seededShuffle`, `shuffleWith`, `randIntWith` |
| `balanced.ts` | `BalancedPicker` (шаблоны расходуются поровну за прогон, не повторяются на странице), `pickSetForPage` (тема → без темы → любой), `exclusionSet` |
| `aiPlan.ts` | `planAiPins` — ИИ-пины (OPENAI), только недостающее до `mix.ai` / `pinQuota` |
| `pinoraPlan.ts` | `planPinoraPins` — типы Pinora мешком без возврата до `mix.pinora` |
| `photoPlan.ts` | `planPhotos` — первые `mix.photos` фото публикуются, доля со ссылкой = `photoLinkPercent`, остальные в резерв для Canvas |
| `canvasPlan.ts` | `planCanvasPins` — стиль + число фото (1/2/3/4/6) по резерву страницы до `mix.canvas` / `canvasQuota` |

Отличия от старого приложения: количество на URL — точное число из рецепта (не диапазон, нет «0 = весь набор»);
`existing*Count` считается по `engine`, поэтому Pinora/Canvas больше не съедают квоту ИИ-пинов;
Canvas вместо оси «наименее использованное число фото» выбирает форматы, которые страница может заполнить,
предпочитая 1/2/3/4 перед 6 и не повторяя формат внутри страницы.
