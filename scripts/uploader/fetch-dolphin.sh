#!/usr/bin/env bash
# Обновить установщик Dolphin Anty в нашем хранилище (сотрудники скачивают его с портала, не с чужого сайта).
# Источник — официальный CDN Dolphin (указан в download.js на dolphin-anty.com и в winget-манифесте DenisZhitnyakov.DolphinAnty).
# Запуск на сервере: bash scripts/uploader/fetch-dolphin.sh  → <storage>/uploader/downloads/dolphin-anty-setup.exe (+ .date)
set -euo pipefail
STORAGE=${PINS_STORAGE_DIR:-/var/www/zewex_tools_usr/data/storage}
DIR="$STORAGE/uploader/downloads"
mkdir -p "$DIR"
curl -fsSL -o "$DIR/dolphin-anty-setup.exe.tmp" "https://dolphin-anty-cdn.com/anty-app/dolphin-anty-win-latest.exe"
SIZE=$(stat -c %s "$DIR/dolphin-anty-setup.exe.tmp")
[ "$SIZE" -gt 50000000 ] || { echo "скачалось подозрительно мало ($SIZE байт)"; rm -f "$DIR/dolphin-anty-setup.exe.tmp"; exit 1; }
mv "$DIR/dolphin-anty-setup.exe.tmp" "$DIR/dolphin-anty-setup.exe"
date +%Y-%m-%d > "$DIR/dolphin-anty-setup.date"
chown zewex_tools_usr:zewex_tools_usr "$DIR"/* 2>/dev/null || true
echo "ok: $DIR/dolphin-anty-setup.exe ($SIZE bytes)"
