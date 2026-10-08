#!/usr/bin/env bash
# Dump the zewex_tools database to /var/backups/zewex-tools and keep 14 days.
# Installed on the server by deploy/deploy.sh; also run before every schema push.
# Usage: backup-db.sh [label]
set -euo pipefail
APP=/var/www/zewex_tools_usr/data/app
DEST=/var/backups/zewex-tools
KEEP_DAYS=14
LABEL=${1:-daily}

# DATABASE_URL="mysql://user:pass@host:port/db"
URL=$(grep -E '^DATABASE_URL=' "$APP/.env" | cut -d= -f2- | tr -d '"' | tr -d "'")
[ -n "$URL" ] || { echo "DATABASE_URL not found in $APP/.env" >&2; exit 1; }
rest=${URL#mysql://}
creds=${rest%%@*}
hostdb=${rest#*@}
DB_USER=${creds%%:*}
DB_PASS=${creds#*:}
DB_HOST=${hostdb%%/*}
DB_NAME=${hostdb#*/}
DB_NAME=${DB_NAME%%\?*}
DB_PORT=3306
case "$DB_HOST" in *:*) DB_PORT=${DB_HOST#*:}; DB_HOST=${DB_HOST%%:*};; esac

mkdir -p "$DEST"
chmod 700 "$DEST"
OUT="$DEST/${DB_NAME}-$(date +%Y%m%d-%H%M%S)-${LABEL}.sql.gz"
MYSQL_PWD="$DB_PASS" mysqldump --single-transaction --quick --routines --triggers \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" | gzip -6 > "$OUT"
chmod 600 "$OUT"
find "$DEST" -name "${DB_NAME}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
