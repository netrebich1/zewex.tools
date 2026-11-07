#!/usr/bin/env bash
# Nightly storage cleanup, nothing in the DB changes:
# 1) the pins photo cache (storage/pins/photos/*.jpg, re-downloaded on demand by cachedPhoto) is kept under CAP_GB,
#    least recently read files go first; the .json files next to them (subject boxes, rankings) are kept;
# 2) full pin images already in the WP media library (PinRunItem.wpMediaUrl) are deleted, thumbnails stay.
# Installed on the server by deploy/deploy.sh, run daily by cron. Usage: prune-photo-cache.sh [cap_gb]
set -euo pipefail
STORAGE=/var/www/zewex_tools_usr/data/storage
DIR=$STORAGE/pins/photos
CAP_GB=${1:-5}
CAP=$((CAP_GB * 1000000000))
# Files read in the last day stay even over the cap (atime is relatime: updated at most daily).
find "$DIR" -maxdepth 1 -name '*.jpg' -printf '%A@ %s %p\n' | sort -n | awk -v cap="$CAP" -v fresh="$(( $(date +%s) - 86400 ))" '
  { t[NR] = $1; s[NR] = $2; p[NR] = substr($0, index($0, $3)); total += $2 }
  END { for (i = 1; i <= NR && total > cap && t[i] < fresh; i++) { print p[i]; total -= s[i] } }
' | while read -r f; do rm -f -- "$f"; done
echo "photo cache: $(du -sh "$DIR" | cut -f1)"

# A file is deleted only if no item without a WP copy points to it, and it is nobody's thumbnail.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mariadb -N zewex_tools -e "SELECT DISTINCT imagePath FROM PinRunItem WHERE wpMediaUrl <> '' AND imagePath LIKE 'pins/runs/%' AND imagePath <> thumbPath" | sort > "$TMP/wp"
mariadb -N zewex_tools -e "SELECT DISTINCT imagePath FROM PinRunItem WHERE wpMediaUrl = '' AND imagePath <> '' UNION SELECT DISTINCT thumbPath FROM PinRunItem WHERE thumbPath <> ''" | sort > "$TMP/keep"
cd "$STORAGE"
comm -23 "$TMP/wp" "$TMP/keep" | while read -r f; do [ -f "$f" ] && echo "$f"; done > "$TMP/del" || true
xargs -a "$TMP/del" -d '\n' -r rm -f --
echo "pin images on WP removed: $(wc -l < "$TMP/del"), pins/runs: $(du -sh pins/runs | cut -f1)"
