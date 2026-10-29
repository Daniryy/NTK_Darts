#!/usr/bin/env bash
# Автообновление (от root): раз в 5 минут сервер проверяет ветку на GitHub и, если есть новое, обновляется (deploy.sh):
# копия базы перед миграциями, откат на прежнюю версию, если новая не встала.
#   bash /srv/oche/app/deploy/autoupdate.sh on      — включить
#   bash /srv/oche/app/deploy/autoupdate.sh off     — выключить
#   bash /srv/oche/app/deploy/autoupdate.sh status  — включено ли и что было в последние разы
#   bash /srv/oche/app/deploy/autoupdate.sh run     — проверить и обновить сейчас
set -euo pipefail
APP=/srv/oche/app
[[ $EUID -eq 0 ]] || { echo "Запустите от root: sudo bash $0 ${1:-}"; exit 1; }

case "${1:-status}" in
on)
  cat > /etc/systemd/system/oche-update.service <<UNIT
[Unit]
Description=Oche: обновление с GitHub
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $APP/deploy/autoupdate.sh run
UNIT
  cat > /etc/systemd/system/oche-update.timer <<UNIT
[Unit]
Description=Oche: проверка обновлений раз в 5 минут

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now oche-update.timer >/dev/null 2>&1
  echo "Автообновление включено: раз в 5 минут. Журнал: journalctl -u oche-update -n 30"
  ;;
off)
  systemctl disable --now oche-update.timer >/dev/null 2>&1 || true
  echo "Автообновление выключено. Обновлять вручную: bash $APP/deploy/deploy.sh"
  ;;
status)
  if systemctl is-active -q oche-update.timer; then echo "Автообновление включено"; else echo "Автообновление выключено"; fi
  echo "Версия на сервере: $(sudo -u oche git -C "$APP" log --oneline -1)"
  journalctl -u oche-update -n 15 --no-pager 2>/dev/null | grep -v '^-- ' || true
  ;;
run)
  # deploy.sh обновит и этот файл: работаем с копией, чтобы bash не дочитывал изменённый скрипт
  if [[ -z ${OCHE_UPDATE_COPY:-} ]]; then
    tmp=$(mktemp /tmp/oche-update.XXXXXX); cp "$0" "$tmp"
    OCHE_UPDATE_COPY=1 exec bash "$tmp" run
  fi
  trap 'rm -f "$0"' EXIT
  cd "$APP"
  sudo -u oche git fetch -q origin
  cur=$(sudo -u oche git rev-parse HEAD); new=$(sudo -u oche git rev-parse '@{u}')
  if [[ $cur == "$new" ]]; then
    # сервер, поставленный до nginx-app.conf, переводится на него и без нового кода
    grep -qs nginx-app.conf /etc/nginx/sites-available/oche || bash "$APP/deploy/nginx-sync.sh" || true
    exit 0
  fi
  # эта версия уже не встала и была откачена — ждём следующую (вручную: deploy.sh)
  [[ -f /srv/oche/update-bad && $(cat /srv/oche/update-bad) == "$new" ]] && exit 0
  echo "обновление: $(sudo -u oche git log --oneline -1 "$new")"
  if ! bash "$APP/deploy/deploy.sh"; then
    "$APP/deploy/notify.sh" "Oche: автообновление не удалось — journalctl -u oche-update -n 50"
    exit 1
  fi
  ;;
*) echo "Команды: on, off, status, run"; exit 1 ;;
esac
