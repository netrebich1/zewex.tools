#!/usr/bin/env bash
# Dump the zewex_tools database to /var/backups/zewex-tools and keep 14 days.
# Installed on the server by deploy/deploy.sh; also run before every schema push.
# Runs as root: uses MariaDB unix-socket auth, falls back to the app credentials from .env.
# Usage: backup-db.sh [label]
set -euo pipefail
APP=/var/www/zewex_tools_usr/data/app
DEST=/var/backups/zewex-tools
KEEP_DAYS=14
LABEL=${1:-daily}

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
find "$DEST" -name "${DB_NAME}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete
echo "backup: $OUT ($(du -h "$OUT" | cut -f1))"
