#!/usr/bin/env bash
# Проверить почту (от root): соединение с SMTP, вход и тестовое письмо.
#   bash /srv/oche/app/deploy/mailtest.sh ваш@адрес.ру
set -euo pipefail
[[ $# -eq 1 ]] || { echo "Укажите, куда отправить тестовое письмо: bash $0 you@mail.ru"; exit 1; }
cd /srv/oche/app
sudo -u oche bash -c 'set -a; . /etc/oche.env; set +a; node tools/mail.js "$1"' _ "$1"
