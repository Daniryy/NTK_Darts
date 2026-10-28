#!/usr/bin/env bash
# Поменять настройки сервера и перезапустить его (от root):
#   bash /srv/oche/app/deploy/set.sh SMTP_HOST=smtp.yandex.ru SMTP_USER=oche@yandex.ru SMTP_PASS=abcdefghijklmnop
#   bash /srv/oche/app/deploy/set.sh VK_APP_ID=12345678
# Без аргументов — показать настройки (пароли и ключи скрыты).
set -euo pipefail
ENV_FILE=/etc/oche.env
[[ $EUID -eq 0 ]] || { echo "Запустите от root: sudo bash $0 …"; exit 1; }
[[ -f $ENV_FILE ]] || { echo "Нет $ENV_FILE — сначала установите сервер (setup.sh)"; exit 1; }

if [[ $# -eq 0 ]]; then
  sed -E 's/^((SMTP_PASS|COOKIE_SECRET|DATABASE_URL|SMS_RU_API_ID|TELEGRAM_TOKEN)=).+/\1•••/' "$ENV_FILE" | grep -v '^#' | grep -v '^$'
  exit 0
fi
for kv in "$@"; do
  key=${kv%%=*}; val=${kv#*=}
  [[ $kv == *=* && $key =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "Нужно КЛЮЧ=значение, например SMTP_HOST=smtp.yandex.ru (получено: $kv)"; exit 1; }
  # значение читают и systemd, и bash: без пробелов, кавычек и $
  [[ $val =~ [[:space:]\"\'\$\`\\] ]] && { echo "$key: значение без пробелов, кавычек и знаков \$ \` \\"; exit 1; }
  case $key in COOKIE_SECRET|DATABASE_URL) echo "$key меняется только вручную"; exit 1;; esac
  tmp=$(mktemp)
  grep -v "^$key=" "$ENV_FILE" > "$tmp" || true
  echo "$key=$val" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  [[ $key == *PASS* || $key == *TOKEN* || $key == *API_ID* ]] && echo "$key = •••" || echo "$key = $val"
done
systemctl restart oche
for _ in $(seq 1 10); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && { echo "сервер перезапущен"; exit 0; }; sleep 1; done
echo "сервер не отвечает после перезапуска: journalctl -u oche -n 50"; exit 1
