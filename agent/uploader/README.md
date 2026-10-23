# Zewex Uploader — агент заливки в Pinterest

Программа на ПК сотрудника рядом с Dolphin Anty. Получает задания от портала zewex.tools (инструмент «Заливка в Pinterest»),
открывает нужный профиль Dolphin через его Local API, заливает CSV-выгрузку дня на странице массовой загрузки Pinterest,
через 10 минут проверяет историю загрузок и отчитывается порталу. Без Claude, без привязки к чьему-либо аккаунту: нужен только
токен агента из портала.

## Запуск у сотрудника (сборка из портала)

1. Открыть Dolphin Anty (аккаунт команды, в профилях выполнен вход в Pinterest).
2. В портале: Pinterest → Заливка в Pinterest → Агенты → «Добавить агента» → скопировать токен.
3. Скачать ZIP на той же странице, распаковать, запустить `ZewexUploader.cmd` (нужен Node.js 22: https://nodejs.org — поставить один раз).
4. Вставить токен в чёрное окно. Дальше агент сам держит связь; окно состояния — http://127.0.0.1:47831/.
5. Данные (токен, файлы, журнал): `%LOCALAPPDATA%\ZewexUploader`. Чтобы сменить токен — удалить там `config.json`.

Переменные: `ZEWEX_PORTAL` (адрес портала, по умолчанию https://zewex.tools), `DOLPHIN_API` (по умолчанию http://localhost:3001 —
если Dolphin занял другой порт, см. окно Health в Dolphin), `ZEWEX_UPLOADER_PORT` (окно состояния).

## Разработка

```
cd agent/uploader
npm install
npm run dev          # tsx src/index.ts
npm run typecheck
```

Сборка ZIP для портала (Windows, PowerShell): `.\build.ps1 -Version 0.1.0` → `dist-zip\zewex-uploader-0.1.0.zip`,
затем загрузить на странице «Агенты» (админ). Исполняемый файл одной кнопкой (без Node) — следующий этап (Node SEA / pkg).

## Где что

- `src/index.ts` — цикл, `src/task.ts` — один визит в профиль, `src/pinterest.ts` — действия на Pinterest,
  `src/selectors.ts` — селекторы (первое, что правится при смене разметки Pinterest), `src/dolphin.ts` — Local API Dolphin,
  `src/humanize.ts` — паузы/мышь/прокрутка, `src/api.ts` — клиент портала, `src/protocol.ts` — копия типов портала.
- Протокол на стороне портала: `src/lib/uploader/agent.ts`.
