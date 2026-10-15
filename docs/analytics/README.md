# Трафик сайтов (Google Analytics 4) — как подключить

Инструмент `/analytics` показывает трафик всех сайтов из всех ваших Google-аккаунтов в одном кабинете.
Данные тянутся из GA4 в свою базу воркером (раз в час), поэтому поиск по страницам и сравнение периодов работают по всем сайтам сразу.

## Разовая настройка на сервере (делается один раз)

Чтобы кнопка «Подключить Google-аккаунт» заработала, нужен OAuth-клиент Google. Это бесплатно, занимает 10 минут.

1. Откройте https://console.cloud.google.com/ и создайте проект (например, «zewex tools»).
2. **APIs & Services → Library**: включите два API — **Google Analytics Data API** и **Google Analytics Admin API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**, название приложения «Zewex Tools», ваша почта.
   - Scopes: добавьте `.../auth/analytics.readonly`.
   - Test users: добавьте все свои Google-аккаунты, которые будете подключать.
   - **Важно:** пока приложение в статусе *Testing*, Google отзывает доступ через 7 дней — придётся переподключать аккаунты.
     Чтобы этого не было, нажмите **Publish app** (статус *In production*). Проверку Google проходить не обязательно:
     при подключении будет экран «Google hasn't verified this app» → «Advanced» → «Go to Zewex Tools (unsafe)». Это нормально для своего приложения.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs: `https://zewex.tools/api/analytics/oauth/callback`.
   - Скопируйте **Client ID** и **Client secret**.
5. На сервере добавьте их в `/var/www/zewex_tools_usr/data/app/.env`:
   ```
   GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=…
   ```
   и перезапустите сервисы:
   ```
   systemctl restart zewex-tools zewex-worker
   ```

## Подключение аккаунтов (в кабинете)

1. `/analytics/settings` → «Подключить Google-аккаунт» → выбрать аккаунт → разрешить чтение статистики.
2. Повторить для каждого Google-аккаунта. Список сайтов (GA4-свойств) подтянется сам.
3. Включить переключатели у нужных сайтов. История за 400 дней (по дням), 120 дней (страницы), 90 дней (часы) загрузится за несколько минут.
4. Создать группы и разложить сайты.

### Запасной путь — сервисный аккаунт
Если не хочется давать доступ к личному аккаунту: Google Cloud → IAM → Service accounts → создать → Keys → JSON.
Вставить JSON в «Подключить сервисный аккаунт». Почту сервисного аккаунта (`…@…iam.gserviceaccount.com`) добавить в каждом аккаунте GA:
Администратор → Управление доступом к аккаунту → + → роль «Читатель».

## Что где лежит (для разработки)
- Схема: модели `Ga*` в `prisma/schema.prisma`.
- `src/lib/analytics/google.ts` — токены (OAuth / сервисный), Admin API (`listProperties`), Data API (`runReport`, `realtimeActiveUsers`).
- `src/lib/analytics/sync.ts` — `syncProperty` (свежие 3 дня + докачка истории порциями), `refreshAccountProperties`, очередь `claimProperty`.
- `worker/analytics.ts` — цикл воркера (GA_SYNC_CONCURRENCY сайтов параллельно), уборка старых строк раз в сутки (`worker/cron.ts`).
- `src/lib/analytics/period.ts` — периоды/сравнение/детализация из адреса (`p`, `from`, `to`, `cmp`, `g`, `m`); `query.ts` — все выборки из своих таблиц.
- Экраны: `src/app/(app)/analytics/*`, компоненты `src/components/analytics/*`, действия `src/actions/analytics.ts`, API `/api/analytics/{oauth,realtime,export}`.
- Квоты GA4 Data API: 25 000 токенов в сутки на свойство; первичная загрузка одного сайта ≈ 150 запросов, обычная синхронизация ≈ 12 запросов в час.
