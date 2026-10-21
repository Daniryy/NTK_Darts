#!/usr/bin/env bash
# Раз в 5 минут (cron из setup.sh): сервер отвечает, на диске есть место.
# Сообщает в Telegram только при смене состояния, чтобы не слать одно и то же каждые 5 минут.
set -uo pipefail
STATE=/tmp/oche-health.state
problems=()

curl -fsS -m 5 http://127.0.0.1:3000/api/health >/dev/null 2>&1 || problems+=("сервер не отвечает")
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
(( disk < 85 )) || problems+=("диск заполнен на ${disk}%")

now="${problems[*]:-ok}"
prev=$(cat "$STATE" 2>/dev/null || echo ok)
if [[ "$now" != "$prev" ]]; then
  if [[ "$now" == ok ]]; then msg="Oche: всё снова в порядке"; else msg="Oche: ${now}"; fi
  "$(dirname "$0")/notify.sh" "$msg"
  echo "$now" > "$STATE"
fi
