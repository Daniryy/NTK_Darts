#!/usr/bin/env bash
# Сайт в nginx (от root): конфиг /etc/nginx/sites-available/oche подключает deploy/nginx-app.conf из репозитория.
# Старый конфиг (весь сайт в одном файле, до nginx-app.conf) один раз пересобирается из шаблона deploy/nginx.conf.
# Затем nginx -t и перезагрузка; если проверка не прошла — возвращается прежний конфиг.
set -euo pipefail
APP=/srv/oche/app
SITE=/etc/nginx/sites-available/oche
command -v nginx >/dev/null && [[ -f $SITE ]] || exit 0

fresh=0
if ! grep -q 'nginx-app.conf' "$SITE"; then
  if grep -q 'ssl_certificate' "$SITE"; then
    echo "nginx: в конфиге HTTPS от certbot — пересоберите сайт: bash $APP/deploy/setup.sh (сертификат останется)" >&2
    "$APP/deploy/notify.sh" "Oche: обновите конфиг nginx — bash $APP/deploy/setup.sh" || true
    exit 0
  fi
  name=$(awk '$1 == "server_name" { sub(";", "", $2); print $2; exit }' "$SITE")
  cp "$SITE" "$SITE.bak"
  sed "s/__DOMAIN__/${name:-_}/g" "$APP/deploy/nginx.conf" > "$SITE"
  grep -q default_server "$SITE.bak" && sed -i 's/listen 80;/listen 80 default_server;/; s/listen \[::\]:80;/listen [::]:80 default_server;/' "$SITE"
  grep -q 'listen \[::\]' "$SITE.bak" || sed -i '/listen \[::\]/d' "$SITE"
  fresh=1
  echo "nginx: конфиг сайта пересобран (прежний — $SITE.bak)"
fi

if nginx -t -q 2>/dev/null; then
  systemctl reload nginx
else
  nginx -t 2>&1 | tail -3 >&2 || true
  if [[ $fresh == 1 ]]; then cp "$SITE.bak" "$SITE"; echo "nginx: возвращён прежний конфиг" >&2; fi
  "$APP/deploy/notify.sh" "Oche: nginx -t не прошёл после обновления — сайт работает на прежних настройках" || true
  exit 1
fi
