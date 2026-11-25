# Прототип (сессия 18fe03bc, 2026-10-20)

Исходники ручного сбора через Claude in Chrome. Логику метрик переносим отсюда, а не придумываем заново.

- `serp-analyze.js`: функции страницы pinterest.com (`__search`, `__ta`, `__user`, `__uinfo`, `__ownGuess`, `__BIG`, `__analyze`).
- `serp-loop.js`: профили авторов топ-10 (`ul`) и цикл сбора с паузами 2→4→8→15 мин.
- `ads-manager.js`: частотность в Ads Manager (`__setKw`, перехват XHR, `__vol`).
- `run_vol.js`: очередь частотности.
- `build_head.py` + `build_tail.py`: вердикт, оценка 0–100, флаги, вариации, профили (перенесено в `src/lib/keywords/metrics.ts`).
- `competitors.py`, `artdates.py`, `classify.py`, `gen.py`, `queue.py`: конкуренты, даты статей, сезонность, кандидаты, очередь.

Собранные данные лежат в `prisma/seed-data/keywords/starter.json` (лист Evergreen, частотность, снимки выдачи, даты статей).
