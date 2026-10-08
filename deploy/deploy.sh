#!/usr/bin/env bash
# Deploy zewex-tools from this Mac to the server. Usage: ./deploy/deploy.sh
set -euo pipefail
HOST=root@159.69.234.194
KEY=~/.ssh/fastvps_ed25519
APP=/var/www/zewex_tools_usr/data/app
WEBROOT=/var/www/zewex_tools_usr/data/www/zewex.tools
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude .next --exclude .git --exclude .env -e "ssh -i $KEY -o BatchMode=yes" ./ $HOST:$APP/
ssh -i $KEY -o BatchMode=yes $HOST bash -s <<REMOTE
set -euo pipefail
cd $APP
chown -R zewex_tools_usr:zewex_tools_usr .
sudo -u zewex_tools_usr -H npm install --no-audit --no-fund --silent
sudo -u zewex_tools_usr -H npx prisma db push --skip-generate --accept-data-loss >/dev/null
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
REMOTE
echo "deployed"
