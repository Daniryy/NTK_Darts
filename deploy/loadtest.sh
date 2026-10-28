#!/usr/bin/env bash
# Нагрузочный тест на этом сервере (от root). Настоящую базу не трогает: временная база oche_load
# и второй экземпляр сайта на порту 3100 (снаружи недоступен). После теста всё удаляется.
#   bash /srv/oche/app/deploy/loadtest.sh [игроков, по умолчанию 250] [секунд, по умолчанию 60]
# Игроки создаются турнирами по 64, все матчи первого круга идут одновременно, подход раз в 10 с на матч,
# у каждого турнира 2 табло. Генератор нагрузки работает на этом же сервере и сам отнимает процессор —
# результат с запасом: на деле сервер выдержит больше.
set -euo pipefail
APP=/srv/oche/app N=${1:-250} DUR=${2:-60}
[[ $EUID -eq 0 ]] || { echo "Запустите от root: sudo bash $0"; exit 1; }
[[ $N =~ ^[0-9]+$ && $DUR =~ ^[0-9]+$ ]] || { echo "Нужно: loadtest.sh [игроков] [секунд], например: loadtest.sh 500 60"; exit 1; }
set -a; . /etc/oche.env; set +a
DB=${DATABASE_URL%/*}/oche_load
SPID=""
cleanup() {
  [[ -n $SPID ]] && kill "$SPID" 2>/dev/null || true
  sleep 1
  sudo -u postgres psql -qc "DROP DATABASE IF EXISTS oche_load" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== временная база"
sudo -u postgres psql -qc "DROP DATABASE IF EXISTS oche_load" -c "CREATE DATABASE oche_load OWNER oche" >/dev/null
cd "$APP"
sudo -u oche env DATABASE_URL="$DB" node db/migrate.js >/dev/null
sudo -u oche env DATABASE_URL="$DB" NODE_ENV=development node db/seed.js >/dev/null
echo "== тестовый экземпляр на порту 3100"
sudo -u oche env NODE_ENV=development DATABASE_URL="$DB" PORT=3100 SERVE_STATIC=0 LOG_LEVEL=error UPLOAD_DIR=/tmp/oche-load PRIVATE_DIR=/tmp/oche-load node server/index.js >/dev/null 2>&1 &
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:3100/api/health >/dev/null 2>&1 && break; sleep 1; done
SPID=$(pgrep -u oche -n -f "node server/index.js")
echo "== нагрузка: $N игроков, $DUR с (рабочий сайт продолжает работать)"
free -m | awk '/Mem:/ {print "память до теста: занято " $3 " из " $2 " МБ"}'
sudo -u oche node tools/load.js --players "$N" --duration "$DUR" --base http://127.0.0.1:3100 --pid "$SPID"
free -m | awk '/Mem:/ {print "память после: занято " $3 " из " $2 " МБ"}'
echo "Готово, временная база удалена."
