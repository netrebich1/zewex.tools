#!/usr/bin/env bash
# Diagnose database connectivity for backups. Run on the server as root:
#   ssh root@server bash -s < deploy/db-diag.sh
set -u
APP=/var/www/zewex_tools_usr/data/app
cd "$APP"
echo "--- parsed DATABASE_URL (password masked):"
node deploy/db-url.mjs .env | awk 'NR==2 { print "password length: " length($0); next } { print }'
echo "--- root via unix socket:"
mariadb -e "select 1" 2>&1 | tail -1
echo "--- grants for zewex_app:"
mariadb -e "select user, host, plugin from mysql.user where user = 'zewex_app'" 2>&1
echo "--- app user over tcp 127.0.0.1:"
PW=$(node deploy/db-url.mjs .env | sed -n 2p)
MYSQL_PWD="$PW" mariadb --protocol=tcp -h 127.0.0.1 -u zewex_app -e "select 1" zewex_tools 2>&1 | tail -1
echo "--- app user via socket (-h localhost):"
MYSQL_PWD="$PW" mariadb -h localhost -u zewex_app -e "select 1" zewex_tools 2>&1 | tail -1
echo "--- tools:"
command -v mariadb-dump mysqldump
