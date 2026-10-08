# Zewex Tools — заметки для Claude

Внутренний портал инструментов на https://zewex.tools. Общение с владельцем на русском, он не технический: команды давать пошагово.

## Стек и структура
- Next.js 15 (App Router, `output: standalone`), React 19, Tailwind 4, Prisma 6, MariaDB.
- `src/lib/resolve.ts` — выбор правила для слота (USER_PROJECT → TEAM_PROJECT → PROJECT → TEAM → GLOBAL).
- `src/lib/adapters.ts` — вызовы провайдеров (OpenAI-совместимые, DataForSEO, SerpAPI); `src/lib/run.ts` — прокси + журнал расхода.
- `src/actions/*.ts` — все мутации (server actions), формы через `components/ActionForm.tsx`.
- `prisma/seed.mjs` — провайдеры, модели Perplexity, разделы (идемпотентен).
- Tailwind 4: нельзя `@apply` своих классов, только встроенные утилиты.

## Сборка и деплой
На Mac нет Node: локально только редактируем, собираем на сервере.
- Деплой одной командой: `./deploy/deploy.sh` (rsync → npm install → prisma db push → seed → build → systemd + nginx).
- Проверка типов на сервере: `ssh -i ~/.ssh/fastvps_ed25519 root@159.69.234.194 'cd /var/www/zewex_tools_usr/data/app && sudo -u zewex_tools_usr npx tsc --noEmit'`.
- Логи: `journalctl -u zewex-tools -n 100`. Сервис слушает 127.0.0.1:3100.
- Секреты только в `.env` на сервере (не в git). Никогда не печатать APP_ENCRYPTION_KEY и пароли в чат.
- Репозиторий: `git@github.com:netrebich1/zewex.tools.git`, ветка `main`, пуш через deploy key.

## Pinterest Pins (сервис пинов) и воркер
- Страницы `src/app/(app)/pinterest/pins/*`, действия `src/actions/pins.ts`, библиотеки `src/lib/pins/*` (ai, stages, prompts, plan, texts, wp, schedule, export, canvas). Рецепт сайта и константы — `src/lib/pins/types.ts`.
- Фоновая работа только в воркере `worker/` (systemd `zewex-worker`, `tsx worker/index.ts`): очередь `PinJob`, этапы `worker/stages/*`, реестр `worker/stages/index.ts` — при правках проверять, что все этапы зарегистрированы.
- Canvas рендерится на сервере (`@napi-rs/canvas`), шрифты в `storage/pins/fonts` (скрипт `scripts/pins/fetch-fonts.mjs`). Каталог стилей: `canvas/catalog.ts` (сбор из легаси + свои стили `canvas/curated.ts` + сочные палитры `canvas/paletteLibrary.ts`, подмешиваются в `previews` при harvest). Профиль акцента для обрезки (`crop.ts`) задаётся в `worker/stages/canvas.ts` через `guessAccent(ниша, ключ)`. Отладочный рендер без базы изменений: `scripts/pins/render-style.ts` + `scripts/pins/contact-sheet.mjs` (запускать в `/root/zewex-check` с `PINS_STORAGE_DIR` на копию). Файлы сервиса: `/var/www/zewex_tools_usr/data/storage/pins`, отдаются nginx как `/files/`.
- Проверка типов воркера: `npx tsc --noEmit -p tsconfig.worker.json`. Без деплоя проверять в копии `/root/zewex-check` на сервере.
- Ключи ИИ назначаются сервисам/командам на странице ключа. Сайты — общий раздел `/sites`: сайт = `SiteAccess` (REST API WordPress, команда, сервисы) + привязанный `PinSite` (`wpConnectionId`) с рецептом и досками (`components/sites/*`). `/access` редиректит на `/sites`; в сервисе остаются только запас пинов и прогоны. На сервере нет IPv6: `NODE_OPTIONS=--dns-result-order=ipv4first` в unit-файлах.
