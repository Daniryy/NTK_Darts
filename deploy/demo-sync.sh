#!/usr/bin/env bash
# Демо-сервер (от root): та же программа, что и основной сайт, с отдельной базой демо-данных — страница в режиме
# «Демо» работает через /demo/api/ точно так же, как с настоящим сервером, отличаются только данные.
# Первый запуск создаёт базу oche_demo, /etc/oche-demo.env, папки, службу oche-demo и ночной сброс данных (4:10);
# дальше — миграции и перезапуск после каждого обновления. Сбой демо не мешает основному сайту.
set -euo pipefail
APP=/srv/oche/app
ENV=/etc/oche-demo.env
MAIN=/etc/oche.env
[[ -f $MAIN ]] || exit 0
as() { sudo -u oche "$@"; }

if [[ ! -f $ENV ]]; then
  # тот же пользователь базы, что у основного сайта; своя база
  url=$(grep -m1 '^DATABASE_URL=' "$MAIN" | cut -d= -f2-)
  [[ -n $url ]] || { echo "demo: нет DATABASE_URL в $MAIN" >&2; exit 1; }
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'oche_demo'" | grep -q 1; then
    sudo -u postgres psql -qc "CREATE DATABASE oche_demo OWNER oche TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'"
  fi
  mkdir -p /srv/oche/demo-uploads /srv/oche/demo-private
  chmod 700 /srv/oche/demo-private
  chown oche:oche /srv/oche/demo-uploads /srv/oche/demo-private
  # без почты, SMS, VK и оповещений: в демо ничего не уходит наружу
  cat > "$ENV" <<CONF
NODE_ENV=production
DEMO=1
PORT=3001
DATABASE_URL=${url%/*}/oche_demo
COOKIE_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=$(grep -m1 '^PUBLIC_URL=' "$MAIN" | cut -d= -f2-)
UPLOAD_DIR=/srv/oche/demo-uploads
PRIVATE_DIR=/srv/oche/demo-private
UPLOAD_URL=/demo/uploads/
RATE_MAX=40
CONF
  chown root:oche "$ENV"; chmod 640 "$ENV"
  as bash -c "set -a; . $ENV; set +a; cd $APP && node db/seed.js --reset"
  cp "$APP/deploy/oche-demo.service" /etc/systemd/system/oche-demo.service
  systemctl daemon-reload
  systemctl enable oche-demo >/dev/null 2>&1
  # каждую ночь — чистые демо-данные
  cat > /etc/cron.d/oche-demo <<CRON
SHELL=/bin/bash
10 4 * * * oche cd $APP && set -a && . $ENV && set +a && node db/seed.js --reset >/dev/null 2>&1
12 4 * * * root systemctl restart oche-demo
CRON
  echo "demo: создан демо-сервер (база oche_demo, служба oche-demo, сброс в 4:10)"
fi

cp "$APP/deploy/oche-demo.service" /etc/systemd/system/oche-demo.service
systemctl daemon-reload
as bash -c "set -a; . $ENV; set +a; cd $APP && node db/migrate.js" >/dev/null
systemctl restart oche-demo
for _ in $(seq 1 15); do curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1 && exit 0; sleep 1; done
echo "demo: демо-сервер не отвечает — journalctl -u oche-demo -n 50" >&2
exit 1
