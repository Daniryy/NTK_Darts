#!/usr/bin/env bash
# Резервные копии (cron из setup.sh, каждую ночь в 3:30):
#   база (игроки, рейтинг, матчи, тарифы, журнал) — каждую ночь, хранятся 14 дней (весит килобайты);
#   фото и документы заявок на звания — раз в неделю (в воскресенье), хранятся 3 последние.
#   backup.sh --full — сразу всё: база, фото и документы (перед очисткой сервера).
# Восстановление базы: pg_restore --clean --if-exists -d "$DATABASE_URL" /var/backups/oche/oche-ДАТА.dump
# Фото: tar -xzf /var/backups/oche/uploads-ДАТА.tgz -C /srv/oche
set -euo pipefail
set -a; . "${OCHE_ENV:-/etc/oche.env}"; set +a
DIR=${BACKUP_DIR:-/var/backups/oche}
NOW=$(date +%Y%m%d-%H%M)
FILE="$DIR/oche-$NOW.dump"
FULL=0
[[ ${1:-} == --full || $(date +%u) == 7 ]] && FULL=1
# оставить только N последних файлов по маске
keep() { ls -1t "$DIR"/$1 2>/dev/null | tail -n +$(($2 + 1)) | xargs -r rm -f; }

if pg_dump -Fc -f "$FILE" "$DATABASE_URL"; then
  find "$DIR" -name 'oche-*.dump' -mtime +14 -delete
  if [[ $FULL == 1 ]]; then
    UP=${UPLOAD_DIR:-/srv/oche/uploads}
    [[ -d $UP ]] && tar -czf "$DIR/uploads-$NOW.tgz" -C "$(dirname "$UP")" "$(basename "$UP")"
    PR=${PRIVATE_DIR:-/srv/oche/private}
    [[ -d $PR ]] && tar -czf "$DIR/private-$NOW.tgz" -C "$(dirname "$PR")" "$(basename "$PR")"
    keep 'uploads-*.tgz' 3
    keep 'private-*.tgz' 3
  fi
  echo "$(date '+%F %T') ok $FILE $(du -h "$FILE" | cut -f1)$([[ $FULL == 1 ]] && echo ' + фото и документы')"
else
  rm -f "$FILE"
  "$(dirname "$0")/notify.sh" "Oche: резервная копия базы не создана"
  exit 1
fi
