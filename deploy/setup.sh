#!/usr/bin/env bash
# Выкладка «Дасти Гӯё» на Ubuntu-сервер (запускать от root).
# Повторный запуск безопасен: обновляет код и перезапускает сервис, .env и базу не трогает.
#
#   DIST_TAR=/tmp/dasti-dist.tar.gz bash setup.sh
#
# DIST_TAR — собранный сайт (архив папки frontend/dist, собирается на компьютере: npm run build).
# INSTALL_TTS=1 — дополнительно поставить нейросетевой таджикский голос (PyTorch, ~1 ГБ на диске).
set -euo pipefail

DOMAIN=${DOMAIN:-dastiguyo.king.tj}
APP_DIR=/opt/dasti-guyo
REPO=${REPO:-https://github.com/maga76/dasti-guyo.git}
DIST_TAR=${DIST_TAR:-/tmp/dasti-dist.tar.gz}

echo "==> Пакеты"
# Ставим только недостающее: на общем сервере нельзя случайно обновить nginx под чужими сайтами
MISSING=""
for pkg in python3-venv git nginx certbot python3-certbot-nginx; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
done
if [ -n "$MISSING" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q $MISSING
fi

id dasti >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin dasti

echo "==> Код"
if [ -n "${SRC_TAR:-}" ]; then
  # Код архивом (git archive) — если с сервера нет доступа к GitHub
  mkdir -p "$APP_DIR"
  tar -xzf "$SRC_TAR" -C "$APP_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  # Папка принадлежит пользователю dasti, а скрипт идёт от root — git нужно явно разрешить
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" fetch -q origin main
  git -c safe.directory="$APP_DIR" -C "$APP_DIR" reset -q --hard origin/main
else
  git clone -q "$REPO" "$APP_DIR"
fi

echo "==> Сайт"
rm -rf "$APP_DIR/frontend/dist"
mkdir -p "$APP_DIR/frontend/dist"
tar -xzf "$DIST_TAR" -C "$APP_DIR/frontend/dist"
# Архив, собранный на Windows, несёт права 666 — делаем обычные
chmod -R u=rwX,go=rX "$APP_DIR/frontend/dist"

echo "==> Python"
cd "$APP_DIR/backend"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
if [ "${INSTALL_TTS:-0}" = "1" ]; then
  .venv/bin/pip install -q -r requirements-tts.txt --extra-index-url https://download.pytorch.org/whl/cpu
fi

if [ ! -f .env ]; then
  echo "==> Новый .env (секреты генерируются здесь, в git их нет)"
  ADMIN_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(12))")
  cat > .env <<EOF
JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))")
FIRST_ADMIN_USERNAME=admin
FIRST_ADMIN_PASSWORD=$ADMIN_PASS
CORS_ORIGINS=https://$DOMAIN
SERVE_FRONTEND=false
TTS_WARM_UP=$([ "${INSTALL_TTS:-0}" = "1" ] && echo true || echo false)
EOF
  chmod 600 .env
  echo "admin / $ADMIN_PASS" > /root/dasti-guyo-admin.txt
  chmod 600 /root/dasti-guyo-admin.txt
fi

mkdir -p data media
chown -R dasti:dasti "$APP_DIR"

echo "==> База"
sudo -u dasti .venv/bin/python -m app.scripts.seed
sudo -u dasti .venv/bin/python -m app.scripts.create_admin || true

echo "==> Сервис"
cp "$APP_DIR/deploy/dasti-guyo.service" /etc/systemd/system/dasti-guyo.service
systemctl daemon-reload
systemctl enable -q dasti-guyo
systemctl restart dasti-guyo

echo "==> nginx"
# Если certbot уже дописал HTTPS в конфиг — не затираем его
if ! grep -q "ssl_certificate" "/etc/nginx/sites-available/$DOMAIN" 2>/dev/null; then
  cp "$APP_DIR/deploy/nginx-dastiguyo.conf" "/etc/nginx/sites-available/$DOMAIN"
fi
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t
systemctl reload nginx

echo "==> HTTPS"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
  || echo "!! certbot не смог выпустить сертификат — сайт пока работает по http"

sleep 2
curl -fsS "http://127.0.0.1:8031/api/v1/health" >/dev/null 2>&1 && echo "API работает" || systemctl status dasti-guyo --no-pager | tail -20
echo "Готово: https://$DOMAIN"
[ -f /root/dasti-guyo-admin.txt ] && echo "Вход администратора: $(cat /root/dasti-guyo-admin.txt)"
