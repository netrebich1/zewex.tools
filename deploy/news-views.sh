#!/usr/bin/env bash
# Рейтинг просмотров у конкурентов (Discover → Новости → Просмотры): 1-го числа собираем статьи прошлого месяца
# с сайтов с открытыми счётчиками и считаем персоны и события. Ставится deploy.sh, cron — /etc/cron.d/zewex-news-views.
# Можно запустить вручную за любой месяц: zewex-news-views 2026-10
set -euo pipefail
APP=/var/www/zewex_tools_usr/data/app
DIR=/var/www/zewex_tools_usr/data/storage/news-views
MONTH=${1:-$(date -d "$(date +%Y-%m-01) -1 day" +%Y-%m)}
exec 9>/var/lock/zewex-news-views.lock
flock -n 9 || { echo "[$(date '+%F %T')] уже идёт, выхожу"; exit 0; }
install -d -o zewex_tools_usr -g zewex_tools_usr -m 755 "$DIR"
F="$DIR/views-$MONTH.jsonl"
# Глубина сбора — от начала месяца до сегодня плюс запас.
DAYS=$(( ( $(date +%s) - $(date -d "$MONTH-01" +%s) ) / 86400 + 3 ))
run() { sudo -u zewex_tools_usr -H bash -c "set -a && . $APP/.env && set +a && cd $APP && $*"; }
echo "[$(date '+%F %T')] сбор за $MONTH ($DAYS дн.)"
run npx tsx scripts/news/views-collect.ts "$F" "$DAYS"
echo "[$(date '+%F %T')] разбор"
# Кэш разметки заголовков (tags.json) и происхождения персон (origin.json) лежит в $DIR: платим только за новые статьи.
run npx tsx scripts/news/views-analyze.ts "$F" "$DIR" --month "$MONTH" --write
# Держим выгрузки за полгода.
ls -1t "$DIR"/views-*.jsonl | tail -n +7 | xargs -r rm -f
echo "[$(date '+%F %T')] готово"
