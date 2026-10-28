#!/usr/bin/env bash
# Установка на чистый VPS (Ubuntu 24.04), от root. Повторный запуск безопасен: сделанные шаги пропускаются.
#
# Тест без домена — сайт по IP сервера, http:
#   curl -fsSLO https://raw.githubusercontent.com/Daniryy/NTK_Darts/main/deploy/setup.sh && bash setup.sh
# С доменом — HTTPS (запись A домена уже смотрит на IP сервера); так же можно перейти с теста на домен:
#   DOMAIN=oche.ru EMAIL=you@mail.ru bash setup.sh
#
# Необязательно: DEMO=1 — демо-данные (игроки, турниры, матчи); ADMIN_NAME, ADMIN_LOGIN, ADMIN_PASSWORD —
# создать тех. администратора без вопросов; REPO, BRANCH — откуда брать код.
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
REPO="${REPO:-https://github.com/Daniryy/NTK_Darts.git}"
BRANCH="${BRANCH:-main}"
APP=/srv/oche/app
ENV_FILE=/etc/oche.env
[[ $EUID -eq 0 ]] || { echo "Запустите от root: sudo bash setup.sh"; exit 1; }
[[ -z $DOMAIN || -n $EMAIL ]] || { echo "Для домена нужен EMAIL (для сертификата HTTPS)"; exit 1; }
# вопросы — только если есть терминал
TTY=""; if [[ -r /dev/tty ]] && (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
ask() { local a=""; if [[ -n $TTY ]]; then read -r -p "$1" a < "$TTY" || true; fi; echo "$a"; }

if [[ -n $DOMAIN ]]; then
  HOST=$DOMAIN; URL="https://$DOMAIN"
else
  HOST=$(curl -fsS -4 -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  URL="http://$HOST"
  echo "== тестовый режим без домена: сайт будет по адресу $URL (без HTTPS)"
fi

echo "== память"
# на VPS с 1 ГБ установка пакетов может упереться в память — добавляем подкачку 2 ГБ
mem=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( mem < 1800 )) && ! swapon --show | grep -q . && [[ ! -f /swapfile ]]; then
  if fallocate -l 2G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile 2>/dev/null; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "подкачка 2 ГБ включена (памяти ${mem} МБ)"
  else
    rm -f /swapfile; echo "подкачку включить не удалось — продолжаем без неё"
  fi
fi

echo "== пакеты"
apt-get update -q
PKGS=(nginx postgresql certbot python3-certbot-nginx git curl ufw ca-certificates openssl sudo cron)
if ! DEBIAN_FRONTEND=noninteractive apt-get install -yq "${PKGS[@]}"; then
  # на VPS без IPv6 стандартный сайт nginx (слушает [::]:80) не запускается и прерывает установку пакетов
  rm -f /etc/nginx/sites-enabled/default
  DEBIAN_FRONTEND=noninteractive dpkg --configure -a
  DEBIAN_FRONTEND=noninteractive apt-get install -yq "${PKGS[@]}"
fi
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
systemctl enable --now postgresql cron >/dev/null 2>&1 || true

echo "== пользователь и код"
id oche >/dev/null 2>&1 || useradd --system --home /srv/oche --shell /usr/sbin/nologin oche
mkdir -p /srv/oche /srv/oche/uploads /srv/oche/private /var/backups/oche
chmod 700 /srv/oche/private  # документы заявок на звания: nginx их не отдаёт
if [[ ! -d $APP/.git ]]; then git clone --branch "$BRANCH" "$REPO" "$APP"; fi
chown -R oche:oche /srv/oche /var/backups/oche
git config --system --add safe.directory "$APP" 2>/dev/null || true

echo "== база"
for _ in $(seq 1 20); do sudo -u postgres psql -tAc 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
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
PUBLIC_URL=$URL
# ID приложения из кабинета VK ID (id.vk.com → Мои приложения); работает только с доменом и HTTPS
VK_APP_ID=
# вход по телефону: SMS_PROVIDER=smsru и SMS_RU_API_ID (звонок-сброс; SMS_METHOD=sms — код в SMS)
SMS_PROVIDER=
SMS_RU_API_ID=
# оповещения: токен бота от @BotFather и id чата
TELEGRAM_TOKEN=
TELEGRAM_CHAT=
# письма с кодами (регистрация, новый пароль): ящик Яндекса или Mail.ru и пароль приложения.
# Задать: bash /srv/oche/app/deploy/set.sh SMTP_HOST=smtp.yandex.ru SMTP_USER=ящик@yandex.ru SMTP_PASS=пароль_приложения
# Проверить: bash /srv/oche/app/deploy/mailtest.sh ваш@адрес. Без почты регистрация работает, но адреса не подтверждаются.
SMTP_HOST=
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
EOF
  chown root:oche "$ENV_FILE"; chmod 640 "$ENV_FILE"
else
  # переход с теста по IP на домен (или обратно) — меняется только адрес сайта
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$URL|" "$ENV_FILE"
fi

echo "== зависимости и миграции"
cd "$APP"
sudo -u oche npm ci --omit=dev --no-audit --no-fund
sudo -u oche bash -c "set -a; . $ENV_FILE; set +a; node db/migrate.js"

# демо-данные на сервер — только по DEMO=1: посмотреть демо можно в самом приложении (Настройки → «Демо в браузере»)
DEMO="${DEMO:-}"
if [[ $DEMO == 1 ]]; then
  sudo -u oche bash -c "set -a; . $ENV_FILE; set +a; node db/seed.js"
fi

echo "== служба"
cp "$APP/deploy/oche.service" /etc/systemd/system/oche.service
systemctl daemon-reload
systemctl enable oche >/dev/null 2>&1
systemctl restart oche
for _ in $(seq 1 15); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:3000/api/health >/dev/null && echo "сервер отвечает" || { echo "сервер не отвечает: journalctl -u oche -n 50"; exit 1; }

echo "== nginx"
if [[ -n $DOMAIN ]]; then NAME=$DOMAIN; else NAME=_; fi
sed "s/__DOMAIN__/$NAME/g" "$APP/deploy/nginx.conf" > /etc/nginx/sites-available/oche
[[ -n $DOMAIN ]] || sed -i 's/listen 80;/listen 80 default_server;/; s/listen \[::\]:80;/listen [::]:80 default_server;/' /etc/nginx/sites-available/oche
# у части VPS IPv6 выключен — тогда nginx не может слушать [::]:80
[[ -f /proc/net/if_inet6 ]] || sed -i '/listen \[::\]/d' /etc/nginx/sites-available/oche
ln -sf /etc/nginx/sites-available/oche /etc/nginx/sites-enabled/oche
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx 2>/dev/null || systemctl restart nginx
if [[ -n $DOMAIN ]]; then
  echo "== HTTPS"
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos -n --redirect
fi
curl -fsS -H "Host: $NAME" http://127.0.0.1/api/health >/dev/null && echo "nginx отдаёт сайт"

echo "== брандмауэр"
# порт SSH — тот, на котором сервер слушает сейчас (иначе брандмауэр отрежет доступ)
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}' || true); SSH_PORT=${SSH_PORT:-22}
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
[[ -z $DOMAIN ]] || ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null || echo "ufw не включился — проверьте брандмауэр в панели хостинга"

echo "== резервные копии и проверка"
cat > /etc/cron.d/oche <<EOF
30 3 * * * oche $APP/deploy/backup.sh >> /var/log/oche-backup.log 2>&1
*/5 * * * * oche $APP/deploy/healthcheck.sh
EOF
touch /var/log/oche-backup.log; chown oche /var/log/oche-backup.log
chmod +x "$APP"/deploy/*.sh

echo "== администратор"
# пароль спрашиваем здесь (скрыто, дважды) и передаём программе напрямую: sudo заводит свой терминал,
# и ввод пароля через него ненадёжен
admin() { sudo -u oche bash -c "set -a; . $ENV_FILE; set +a; cd $APP; ADMIN_PASSWORD=\"\$1\" node tools/admin.js new \"\$2\" --login \"\$3\"" _ "$@" < /dev/null; }
has=$(sudo -u oche bash -c "set -a; . $ENV_FILE; set +a; cd $APP; node tools/admin.js list" < /dev/null 2>/dev/null | grep -c ' логин ' || true)
if [[ -n ${ADMIN_LOGIN:-} && -n ${ADMIN_PASSWORD:-} ]]; then
  admin "$ADMIN_PASSWORD" "${ADMIN_NAME:-Администратор}" "$ADMIN_LOGIN" || echo "администратора создать не удалось — команда ниже"
elif [[ $has == 0 && -n $TTY ]]; then
  name=$(ask "Тех. администратор — имя и фамилия (Enter — пропустить): ")
  if [[ -n $name ]]; then
    login=$(ask "Логин (латиница, цифры, точка, дефис): ")
    while :; do
      read -rs -p "Пароль (от 10 символов, не показывается): " p1 < "$TTY"; echo > "$TTY"
      if (( ${#p1} < 10 )); then echo "Короче 10 символов — ещё раз." > "$TTY"; continue; fi
      read -rs -p "Повторите пароль: " p2 < "$TTY"; echo > "$TTY"
      [[ $p1 == "$p2" ]] && break
      echo "Пароли не совпали — ещё раз." > "$TTY"
    done
    admin "$p1" "$name" "$login" && has=1 || echo "администратора создать не удалось — команда ниже"
    unset p1 p2
  fi
fi

echo
echo "Готово: $URL"
if [[ -z $DOMAIN ]]; then
  echo "Тестовый режим: без HTTPS не работают вход через VK и установка на экран телефона."
  echo "Вход администратора: $URL/#staff — игрокам выдаёте коды в «Панели управления»."
  echo "Когда будет домен: DOMAIN=ваш.домен EMAIL=почта bash $0"
fi
[[ $has != 0 ]] || echo "Администратор: cd $APP && sudo -u oche bash -c 'set -a; . $ENV_FILE; set +a; node tools/admin.js new \"Имя Фамилия\" --login логин'"
echo "Автообновление с GitHub: bash $APP/deploy/autoupdate.sh on"
grep -q '^SMTP_HOST=.\+' "$ENV_FILE" || echo "Почта для кодов регистрации: bash $APP/deploy/set.sh SMTP_HOST=smtp.yandex.ru SMTP_USER=ящик@yandex.ru SMTP_PASS=пароль_приложения"
echo "Обновить код: bash $APP/deploy/deploy.sh"
