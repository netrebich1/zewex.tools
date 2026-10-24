#!/usr/bin/env bash
# Сборка ZIP агента «Zewex Uploader» НА СЕРВЕРЕ (Node у сотрудника не нужен):
#   dist (tsc) + node_modules без dev + node.exe (win-x64 с nodejs.org, кэш) + ZewexUploader.cmd + README
#   → <storage>/uploader/agent/zewex-uploader-<версия>.zip, latest.txt. Отдаётся как /files/uploader/agent/… и /api/uploader/agent.
# Вызывается из deploy/deploy.sh после сборки портала; пересобирает только если изменились src/package.json или версия.
# Руками: cd /var/www/zewex_tools_usr/data/app && sudo -u zewex_tools_usr FORCE=1 bash scripts/uploader/build-agent.sh
set -euo pipefail
APP=${APP:-$(cd "$(dirname "$0")/../.." && pwd)}
STORAGE=${PINS_STORAGE_DIR:-/var/www/zewex_tools_usr/data/storage}
NODE_VER=${AGENT_NODE_VERSION:-22.12.0}
cd "$APP/agent/uploader"
VERSION=$(node -p "require('./package.json').version")
SRC_SHA=$(find src package.json -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
OUT="$STORAGE/uploader/agent"
mkdir -p "$OUT" "$STORAGE/uploader/cache"
ZIP="$OUT/zewex-uploader-$VERSION.zip"
if [ "${FORCE:-0}" != 1 ] && [ -f "$OUT/build.sha" ] && [ "$(cat "$OUT/build.sha")" = "$VERSION-$SRC_SHA" ] && [ -f "$ZIP" ]; then
  echo "agent build up to date ($VERSION)"; exit 0
fi
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --silent; else npm install --no-audit --no-fund --silent; fi
npx tsc -p tsconfig.json
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/zewex-uploader"
cp -r dist package.json README.md "$STAGE/zewex-uploader/"
[ -f package-lock.json ] && cp package-lock.json "$STAGE/zewex-uploader/"
( cd "$STAGE/zewex-uploader" && { npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent 2>/dev/null || npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent; } )
NODE_ZIP="$STORAGE/uploader/cache/node-v$NODE_VER-win-x64.zip"
[ -f "$NODE_ZIP" ] || curl -fsSL -o "$NODE_ZIP" "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-win-x64.zip"
unzip -p "$NODE_ZIP" "node-v$NODE_VER-win-x64/node.exe" > "$STAGE/zewex-uploader/node.exe"
# Запускатель с автообновлением: код выхода 75 = агент скачал новую версию в %LOCALAPPDATA%\ZewexUploader\update и записал путь в pending.txt
cat > "$STAGE/zewex-uploader/ZewexUploader.cmd" <<'CMD'
@echo off
cd /d "%~dp0"
title Zewex Uploader
:loop
node.exe dist\index.js
if "%errorlevel%"=="75" (
  set /p UPD=<"%LOCALAPPDATA%\ZewexUploader\update\pending.txt"
  echo Updating from "%UPD%" ...
  xcopy "%UPD%\*" "%~dp0." /E /Y /Q >nul
  del "%LOCALAPPDATA%\ZewexUploader\update\pending.txt"
  goto loop
)
pause
CMD
sed -i 's/$/\r/' "$STAGE/zewex-uploader/ZewexUploader.cmd"
python3 - "$STAGE" "$ZIP" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out + ".tmp", "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, root))
os.replace(out + ".tmp", out)
PY
echo "$VERSION" > "$OUT/latest.txt"
echo "$VERSION-$SRC_SHA" > "$OUT/build.sha"
echo "agent build published: $ZIP ($(du -h "$ZIP" | cut -f1))"
