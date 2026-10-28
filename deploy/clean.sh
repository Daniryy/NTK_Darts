#!/usr/bin/env bash
# Убрать демо-данные с сервера (от root): bash /srv/oche/app/deploy/clean.sh
# Удаляются все турниры, матчи, клубы, баннеры и игроки, которые не могут войти сами.
# Остаются аккаунты с логином, почтой, телефоном или VK. Сначала делается копия базы.
# То же можно сделать в панели: «Управление» → «Сервер» (тех. администратор).
set -euo pipefail
APP=/srv/oche/app
[[ $EUID -eq 0 ]] || { echo "Запустите от root: sudo bash $0"; exit 1; }
echo "Будут удалены ВСЕ турниры и матчи, клубы, баннеры и игроки без входа (демо-данные)."
echo "Останутся аккаунты с логином, почтой, телефоном или VK; их рейтинг обнулится."
# в веб-консоли хостинга кириллица часто не набирается — подходит и латинское yes
read -r -p "Продолжить? Введите yes (или ДА): " yes
[[ ${yes,,} == "yes" || ${yes,,} == "y" || $yes == "ДА" || $yes == "да" ]] || { echo "Отменено."; exit 1; }
echo "== копия базы"
sudo -u oche "$APP/deploy/backup.sh" --full
echo "== очистка"
cd "$APP"
sudo -u oche bash -c "set -a; . /etc/oche.env; set +a; node tools/clean.js --yes"
systemctl restart oche
for _ in $(seq 1 15); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
echo "Готово. Вернуть как было: pg_restore из /var/backups/oche (см. deploy/backup.sh)."
