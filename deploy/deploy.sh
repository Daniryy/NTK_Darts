#!/usr/bin/env bash
# Обновление на VPS одной командой (от root): bash /srv/oche/app/deploy/deploy.sh
set -euo pipefail
APP=/srv/oche/app

cd "$APP"
sudo -u oche git pull --ff-only
sudo -u oche npm ci --omit=dev --no-audit --no-fund
sudo -u oche bash -c "set -a; . /etc/oche.env; set +a; node db/migrate.js"
systemctl restart oche
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then echo "обновлено: $(sudo -u oche git log --oneline -1)"; exit 0; fi
  sleep 1
done
echo "сервер не отвечает после обновления: journalctl -u oche -n 50" >&2
exit 1
