#!/usr/bin/env bash
# Обновление на VPS одной командой (от root): bash /srv/oche/app/deploy/deploy.sh
# Если в обновлении есть миграции — сначала копия базы (backup.sh). Если после обновления сервер не отвечает
# или миграция упала — код откатывается на прежнюю версию, а версия запоминается как плохая
# (/srv/oche/update-bad): автообновление её пропустит, пока не выйдет следующая.
set -euo pipefail
APP=/srv/oche/app
BAD=/srv/oche/update-bad

cd "$APP"
as() { sudo -u oche "$@"; }
health() {
  for _ in $(seq 1 15); do
    curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
prev=$(as git rev-parse HEAD)
as git pull --ff-only
new=$(as git rev-parse HEAD)

rollback() {
  echo "$1 — откат на $(as git log --oneline -1 "$prev")" >&2
  echo "$new" > "$BAD"
  as git reset -q --hard "$prev"
  as npm ci --omit=dev --no-audit --no-fund >/dev/null
  systemctl restart oche
  if health; then echo "откат выполнен, работает прежняя версия" >&2; else echo "после отката сервер тоже не отвечает: journalctl -u oche -n 50" >&2; fi
  "$APP/deploy/notify.sh" "Oche: обновление $(git -C "$APP" log --oneline -1 "$new" 2>/dev/null || echo "$new") не встало ($1), откат на прежнюю версию" || true
  exit 1
}

# копия базы перед миграциями: без неё обновление не идёт
if [[ $prev != "$new" ]] && [[ -n $(as git diff --name-only "$prev" "$new" -- db/migrations) ]]; then
  if ! bash "$APP/deploy/backup.sh"; then
    as git reset -q --hard "$prev"
    echo "копия базы не создалась — обновление отменено" >&2
    exit 1
  fi
fi

as npm ci --omit=dev --no-audit --no-fund || rollback "npm ci не прошёл"
as bash -c "set -a; . /etc/oche.env; set +a; node db/migrate.js" || rollback "миграция не прошла"
systemctl restart oche
health || rollback "сервер не отвечает после обновления"
rm -f "$BAD"
# настройки nginx из репозитория: проверка и перезагрузка (сбой nginx не откатывает код — сайт работает на прежних настройках)
bash "$APP/deploy/nginx-sync.sh" || true
echo "обновлено: $(as git log --oneline -1)"
