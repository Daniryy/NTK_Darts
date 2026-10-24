#!/usr/bin/env bash
# Ежедневная копия базы (cron из setup.sh). Хранятся 14 дней.
# Восстановление: pg_restore --clean --if-exists -d "$DATABASE_URL" /var/backups/oche/oche-ДАТА.dump
set -euo pipefail
set -a; . /etc/oche.env; set +a
DIR=/var/backups/oche
FILE="$DIR/oche-$(date +%Y%m%d-%H%M).dump"

if pg_dump -Fc -f "$FILE" "$DATABASE_URL"; then
  # фото — рядом с копией базы
  UP=${UPLOAD_DIR:-/srv/oche/uploads}
  if [[ -d $UP ]]; then tar -czf "$DIR/uploads-$(date +%Y%m%d-%H%M).tgz" -C "$(dirname "$UP")" "$(basename "$UP")"; fi
  find "$DIR" \( -name 'oche-*.dump' -o -name 'uploads-*.tgz' \) -mtime +14 -delete
  echo "$(date '+%F %T') ok $FILE $(du -h "$FILE" | cut -f1)"
else
  rm -f "$FILE"
  "$(dirname "$0")/notify.sh" "Oche: резервная копия базы не создана"
  exit 1
fi
