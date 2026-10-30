#!/usr/bin/env bash
# Рейтинг просмотров у конкурентов (Discover → Новости → Просмотры): раз в неделю собираем статьи за 30 дней
# с сайтов с открытыми счётчиками и пересчитываем персоны и события. Ставится deploy.sh, cron — /etc/cron.d/zewex-news-views.
set -euo pipefail
APP=/var/www/zewex_tools_usr/data/app
DIR=/var/www/zewex_tools_usr/data/storage/news-views
exec 9>/var/lock/zewex-news-views.lock
flock -n 9 || { echo "[$(date '+%F %T')] уже идёт, выхожу"; exit 0; }
install -d -o zewex_tools_usr -g zewex_tools_usr -m 755 "$DIR"
F="$DIR/views-$(date +%F).jsonl"
run() { sudo -u zewex_tools_usr -H bash -c "set -a && . $APP/.env && set +a && cd $APP && $*"; }
echo "[$(date '+%F %T')] сбор"
run npx tsx scripts/news/views-collect.ts "$F" 30
echo "[$(date '+%F %T')] разбор"
# Кэш разметки заголовков (tags.json) и происхождения персон (origin.json) лежит в $DIR: платим только за новые статьи.
run npx tsx scripts/news/views-analyze.ts "$F" "$DIR" --write
# Держим три последние выгрузки.
ls -1t "$DIR"/views-*.jsonl | tail -n +4 | xargs -r rm -f
echo "[$(date '+%F %T')] готово"
