#!/usr/bin/env bash
# Deploy zewex-tools to the server. Usage: bash deploy/deploy.sh (Git Bash on Windows, or Terminal on Mac)
# Needs only ssh + tar locally: the code goes over ssh as a tar stream, rsync --delete runs on the server.
set -euo pipefail
HOST=root@159.69.234.194
KEY=~/.ssh/fastvps_ed25519
APP=/var/www/zewex_tools_usr/data/app
WEBROOT=/var/www/zewex_tools_usr/data/www/zewex.tools
STAGE=/root/zewex-deploy-src
SSH="ssh -i $KEY -o BatchMode=yes"
EXCLUDES=(--exclude=node_modules --exclude=.next --exclude=.git --exclude=.env)
cd "$(dirname "$0")/.."
# CRLF from a Windows checkout breaks shell scripts and unit files on the server: stop before sending anything.
# (git, not grep: grep in Git Bash for Windows matches \r in every file)
CRLF=$(git ls-files -co --exclude-standard --eol | awk '$2 == "w/crlf" || $2 == "w/mixed" { print $NF }')
if [ -n "$CRLF" ]; then
  echo "Files with CRLF line endings (need LF, see .gitattributes):"; echo "$CRLF"; exit 1
fi
COPYFILE_DISABLE=1 tar -czf - "${EXCLUDES[@]}" . | $SSH $HOST "set -e
rm -rf $STAGE && mkdir -p $STAGE
tar -xzf - -C $STAGE --no-same-owner
rsync -a --delete ${EXCLUDES[*]} $STAGE/ $APP/
rm -rf $STAGE"
$SSH $HOST bash -s <<REMOTE
set -euo pipefail
cd $APP
chown -R zewex_tools_usr:zewex_tools_usr .
# Backups: script + daily cron (03:30), and one dump right before any schema change.
install -m 755 deploy/backup-db.sh /usr/local/bin/zewex-backup-db
printf '30 3 * * * root /usr/local/bin/zewex-backup-db daily >> /var/log/zewex-backup.log 2>&1\n' > /etc/cron.d/zewex-tools-backup
chmod 644 /etc/cron.d/zewex-tools-backup
/usr/local/bin/zewex-backup-db predeploy
# Reproducible install: npm ci when a lockfile is committed, otherwise npm install and bring the lockfile back.
if [ -f package-lock.json ]; then
  sudo -u zewex_tools_usr -H npm ci --no-audit --no-fund --silent
else
  sudo -u zewex_tools_usr -H npm install --no-audit --no-fund --silent
fi
# Schema sync WITHOUT --accept-data-loss: a change that would drop data fails the deploy instead of running.
# Хранилище файлов сервиса пинов (nginx отдаёт его как /files/)
install -d -o zewex_tools_usr -g zewex_tools_usr -m 755 /var/www/zewex_tools_usr/data/storage/pins/{runs,photos,examples,previews,fonts}
install -d -o zewex_tools_usr -g zewex_tools_usr -m 755 /var/www/zewex_tools_usr/data/storage /var/www/zewex_tools_usr/data/storage/articles
chown zewex_tools_usr:zewex_tools_usr /var/www/zewex_tools_usr/data/storage
sudo -u zewex_tools_usr -H npx prisma db push --skip-generate
sudo -u zewex_tools_usr -H npx prisma generate >/dev/null
sudo -u zewex_tools_usr -H node prisma/seed.mjs
sudo -u zewex_tools_usr -H npx next build 2>&1 | tail -3
# standalone needs static + public next to it, and nginx serves static straight from the web root
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
mkdir -p $WEBROOT/_next
rm -rf $WEBROOT/_next/static
cp -r .next/static $WEBROOT/_next/static
cp -r public/. $WEBROOT/
chown -R zewex_tools_usr:zewex_tools_usr $WEBROOT .next
install -m 644 deploy/zewex-tools.service /etc/systemd/system/zewex-tools.service
install -m 644 deploy/zewex-worker.service /etc/systemd/system/zewex-worker.service
install -m 644 deploy/nginx.includes /etc/nginx/fastpanel2-sites/zewex_tools_usr/zewex.tools.includes
systemctl daemon-reload
systemctl enable --now zewex-tools >/dev/null
systemctl enable --now zewex-worker >/dev/null
# воркер останавливается мягко (SIGTERM, до 90 с): дорабатывает текущие задачи или возвращает их в очередь
systemctl restart zewex-worker
systemctl restart zewex-tools
nginx -t && systemctl reload nginx
sleep 2
systemctl is-active zewex-tools
systemctl is-active zewex-worker
curl -s -o /dev/null -w "local: %{http_code}\n" http://127.0.0.1:3100/login
curl -s -o /dev/null -w "http->https: %{http_code} %{redirect_url}\n" http://zewex.tools/login
REMOTE
# Keep the server-generated lockfile in the repo so the next deploy uses npm ci.
if [ ! -f package-lock.json ]; then
  $SSH $HOST "cat $APP/package-lock.json" > package-lock.json && echo "package-lock.json fetched from server: commit it"
fi
echo "deployed"
