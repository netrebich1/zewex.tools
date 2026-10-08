#!/usr/bin/env bash
# Deploy zewex-tools from this Mac to the server. Usage: ./deploy/deploy.sh
set -euo pipefail
HOST=root@159.69.234.194
KEY=~/.ssh/fastvps_ed25519
APP=/var/www/zewex_tools_usr/data/app
WEBROOT=/var/www/zewex_tools_usr/data/www/zewex.tools
SSH="ssh -i $KEY -o BatchMode=yes"
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude .next --exclude .git --exclude .env -e "$SSH" ./ $HOST:$APP/
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
install -m 644 deploy/nginx.includes /etc/nginx/fastpanel2-sites/zewex_tools_usr/zewex.tools.includes
systemctl daemon-reload
systemctl enable --now zewex-tools >/dev/null
systemctl restart zewex-tools
nginx -t && systemctl reload nginx
sleep 2
systemctl is-active zewex-tools
curl -s -o /dev/null -w "local: %{http_code}\n" http://127.0.0.1:3100/login
curl -s -o /dev/null -w "http->https: %{http_code} %{redirect_url}\n" http://zewex.tools/login
REMOTE
# Keep the server-generated lockfile in the repo so the next deploy uses npm ci.
if [ ! -f package-lock.json ]; then
  rsync -az -e "$SSH" $HOST:$APP/package-lock.json ./package-lock.json && echo "package-lock.json fetched from server: commit it"
fi
echo "deployed"
