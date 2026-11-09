#!/usr/bin/env bash
# Dump the zewex_tools database to /var/backups/zewex-tools: daily dumps kept 7 days, predeploy dumps 48 hours.
# Installed on the server by deploy/deploy.sh; also run before every schema push.
# Runs as root: uses MariaDB unix-socket auth, falls back to the app credentials from .env.
# Usage: backup-db.sh [label]
set -euo pipefail
APP=/var/www/zewex_tools_usr/data/app
DEST=/var/backups/zewex-tools
KEEP_DAYS=7
PREDEPLOY_HOURS=48
PREDEPLOY_MIN=3
PREDEPLOY_GAP_MIN=20
LABEL=${1:-daily}

# Several deploys in a row: one fresh predeploy dump covers them all.
if [ "$LABEL" = predeploy ] && [ -n "$(find "$DEST" -name '*-predeploy.sql.gz' -mmin -"$PREDEPLOY_GAP_MIN" 2>/dev/null | head -1)" ]; then
  echo "backup: predeploy dump younger than ${PREDEPLOY_GAP_MIN} min exists, skipping"
  exit 0
fi

# Parse DATABASE_URL with node (handles URL-encoded passwords), never with shell string ops.
{ read -r DB_USER; read -r DB_PASS; read -r DB_HOST; read -r DB_PORT; read -r DB_NAME; } < <(node "$APP/deploy/db-url.mjs" "$APP/.env")

DUMP=mysqldump
command -v mariadb-dump >/dev/null 2>&1 && DUMP=mariadb-dump
CLIENT=mysql
command -v mariadb >/dev/null 2>&1 && CLIENT=mariadb

mkdir -p "$DEST"
chmod 700 "$DEST"
OUT="$DEST/${DB_NAME}-$(date +%Y%m%d-%H%M%S)-${LABEL}.sql.gz"
OPTS=(--single-transaction --quick --routines --triggers)
if "$CLIENT" -e "select 1" >/dev/null 2>&1; then
  "$DUMP" "${OPTS[@]}" "$DB_NAME" | gzip -6 > "$OUT"
else
  MYSQL_PWD="$DB_PASS" "$DUMP" "${OPTS[@]}" --protocol=tcp -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" | gzip -6 > "$OUT"
fi
chmod 600 "$OUT"
# A dump of a real database is never tiny; refuse to count an empty file as a backup.
[ "$(stat -c %s "$OUT")" -gt 200 ] || { echo "backup looks empty: $OUT" >&2; exit 1; }
# Retention: daily dumps for KEEP_DAYS days; predeploy dumps for PREDEPLOY_HOURS, but never fewer than the newest PREDEPLOY_MIN.
find "$DEST" -name "${DB_NAME}-*-daily.sql.gz" -mtime +$((KEEP_DAYS - 1)) -delete
ls -1t "$DEST"/"${DB_NAME}"-*-predeploy.sql.gz 2>/dev/null | tail -n +$((PREDEPLOY_MIN + 1)) | while read -r f; do
  if [ -n "$(find "$f" -mmin +$((PREDEPLOY_HOURS * 60)))" ]; then rm -f "$f"; fi
done
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
