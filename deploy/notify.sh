#!/usr/bin/env bash
# Сообщение в Telegram: notify.sh "текст". Без TELEGRAM_TOKEN и TELEGRAM_CHAT — только в журнал.
set -uo pipefail
set -a; . /etc/oche.env 2>/dev/null; set +a
logger -t oche "$1"
[[ -n "${TELEGRAM_TOKEN:-}" && -n "${TELEGRAM_CHAT:-}" ]] || exit 0
curl -fsS -m 10 "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT}" --data-urlencode "text=$1" >/dev/null
