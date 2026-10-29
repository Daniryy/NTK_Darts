#!/usr/bin/env bash
# Администраторы с логином и паролем (от root). Пароль вводится без показа на экране, дважды.
#   bash /srv/oche/app/deploy/admin.sh new "Имя Фамилия" логин   — новый тех. администратор
#   bash /srv/oche/app/deploy/admin.sh password логин            — новый пароль
#   bash /srv/oche/app/deploy/admin.sh list                      — кто входит по паролю
#   bash /srv/oche/app/deploy/admin.sh unlock логин              — снять блокировку после неверных паролей
set -euo pipefail
APP=/srv/oche/app
[[ $EUID -eq 0 ]] || { echo "Запустите от root: sudo bash $0 …"; exit 1; }
run() { sudo -u oche bash -c "set -a; . /etc/oche.env; set +a; cd $APP; ADMIN_PASSWORD=\"\$1\" node tools/admin.js \"\${@:2}\"" _ "$@" < /dev/null; }
pass() {
  while :; do
    read -rs -p "Пароль (от 10 символов, не показывается): " p1; echo
    if (( ${#p1} < 10 )); then echo "Короче 10 символов — ещё раз."; continue; fi
    read -rs -p "Повторите пароль: " p2; echo
    [[ $p1 == "$p2" ]] && break
    echo "Пароли не совпали — ещё раз."
  done
  PW=$p1
}
case "${1:-}" in
new) [[ $# -eq 3 ]] || { echo "Нужно: new \"Имя Фамилия\" логин"; exit 1; }; pass; run "$PW" new "$2" --login "$3" ;;
password) [[ $# -eq 2 ]] || { echo "Нужно: password логин"; exit 1; }; pass; run "$PW" password "$2" ;;
list|unlock|off|2fa-off) run "" "$@" ;;
*) echo "Команды: new \"Имя Фамилия\" логин · password логин · list · unlock логин · off логин · 2fa-off логин"; exit 1 ;;
esac
