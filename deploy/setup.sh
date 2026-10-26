#!/usr/bin/env bash
# Первая установка на чистый VPS (Ubuntu 24.04), запускать от root:
#   DOMAIN=oche.example.ru EMAIL=you@mail.ru REPO=https://github.com/Daniryy/NTK_Darts.git BRANCH=main bash setup.sh
# Повторный запуск безопасен: уже сделанные шаги пропускаются.
set -euo pipefail

: "${DOMAIN:?укажите DOMAIN}" "${EMAIL:?укажите EMAIL для сертификата HTTPS}" "${REPO:?укажите REPO}"
BRANCH="${BRANCH:-main}"
APP=/srv/oche/app
ENV_FILE=/etc/oche.env

echo "== пакеты"
apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -yq nginx postgresql certbot python3-certbot-nginx git curl ufw ca-certificates
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

echo "== пользователь и код"
id oche >/dev/null 2>&1 || useradd --system --home /srv/oche --shell /usr/sbin/nologin oche
mkdir -p /srv/oche /srv/oche/uploads /srv/oche/private /var/backups/oche
chmod 700 /srv/oche/private  # документы заявок на звания: nginx их не отдаёт
if [[ ! -d $APP/.git ]]; then git clone --branch "$BRANCH" "$REPO" "$APP"; fi
chown -R oche:oche /srv/oche /var/backups/oche

echo "== база"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'oche'" | grep -q 1; then
  DB_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql -qc "CREATE ROLE oche LOGIN PASSWORD '$DB_PASS'"
  sudo -u postgres psql -qc "CREATE DATABASE oche OWNER oche"
else
  DB_PASS=""
fi

echo "== настройки $ENV_FILE"
if [[ ! -f $ENV_FILE ]]; then
  [[ -n $DB_PASS ]] || { echo "роль oche уже есть, а $ENV_FILE нет: задайте DATABASE_URL вручную"; exit 1; }
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://oche:$DB_PASS@127.0.0.1:5432/oche
COOKIE_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=https://$DOMAIN
# ID приложения из кабинета VK ID (id.vk.com → Мои приложения)
VK_APP_ID=
# оповещения: токен бота от @BotFather и id чата
TELEGRAM_TOKEN=
TELEGRAM_CHAT=
EOF
  chown root:oche "$ENV_FILE"; chmod 640 "$ENV_FILE"
fi

echo "== зависимости и миграции"
cd "$APP"
sudo -u oche npm ci --omit=dev --no-audit --no-fund
sudo -u oche bash -c "set -a; . $ENV_FILE; set +a; node db/migrate.js"

echo "== служба"
cp "$APP/deploy/oche.service" /etc/systemd/system/oche.service
systemctl daemon-reload
systemctl enable --now oche
sleep 2
curl -fsS http://127.0.0.1:3000/api/health >/dev/null && echo "сервер отвечает"

echo "== nginx и HTTPS"
sed "s/__DOMAIN__/$DOMAIN/g" "$APP/deploy/nginx.conf" > /etc/nginx/sites-available/oche
ln -sf /etc/nginx/sites-available/oche /etc/nginx/sites-enabled/oche
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos -n --redirect

echo "== брандмауэр"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

echo "== резервные копии и проверка"
cat > /etc/cron.d/oche <<EOF
30 3 * * * oche $APP/deploy/backup.sh >> /var/log/oche-backup.log 2>&1
*/5 * * * * oche $APP/deploy/healthcheck.sh
EOF
touch /var/log/oche-backup.log; chown oche /var/log/oche-backup.log
chmod +x "$APP"/deploy/*.sh

echo
echo "Готово: https://$DOMAIN"
echo "Дальше: впишите VK_APP_ID и TELEGRAM_* в $ENV_FILE и выполните: systemctl restart oche"
