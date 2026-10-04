#!/usr/bin/env bash
# Bootstrap an Ubuntu 24.04 host for Basaer. Run as root: sudo bash deploy/install.sh
# Safe to run again; each step checks before it changes anything.
set -euo pipefail

app_user=basaer
app_home=/opt/basaer
app_dir=$app_home/app
data_dir=/var/lib/basaer
backup_dir=/var/backups/basaer
env_file=/etc/basaer.env
caddyfile=/etc/caddy/Caddyfile
caddy_marker="# basaer-managed"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

# The unit files live in the repo next to this script.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export DEBIAN_FRONTEND=noninteractive

echo "==> System packages"
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
  libreoffice-core libreoffice-writer libreoffice-impress \
  poppler-utils fonts-hosny-amiri sqlite3 build-essential python3 git

echo "==> Node 22"
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
fi
if [ "$node_major" != "22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Service user and directories"
if ! id "$app_user" >/dev/null 2>&1; then
  useradd --system --home-dir "$app_home" --create-home --shell /usr/sbin/nologin "$app_user"
fi
mkdir -p "$data_dir/files" "$data_dir/keys" "$backup_dir"
chown -R "$app_user:$app_user" "$data_dir" "$backup_dir"
chmod 700 "$data_dir/keys"

if [ -d "$app_dir" ]; then
  echo "==> App dependencies"
  chown -R "$app_user:$app_user" "$app_dir"
  (cd "$app_dir" && sudo -u "$app_user" npm ci --omit=dev)
else
  echo "NOTE: $app_dir not found. Clone the repo there, then run this script again."
fi

echo "==> systemd units"
install -m 0644 "$script_dir/basaer.service" /etc/systemd/system/basaer.service
install -m 0644 "$script_dir/basaer-backup.service" /etc/systemd/system/basaer-backup.service
install -m 0644 "$script_dir/basaer-backup.timer" /etc/systemd/system/basaer-backup.timer
chmod +x "$script_dir/backup.sh"

echo "==> Config"
if [ ! -f "$env_file" ]; then
  install -m 0640 -o root -g "$app_user" "$script_dir/basaer.env.example" "$env_file"
  echo "Created $env_file from the example."
fi

mkdir -p /var/log/caddy
chown caddy:caddy /var/log/caddy

# Install our Caddyfile over a missing or stock one. A file carrying the marker
# is ours and may hold an edited domain, so it is never overwritten.
if [ ! -s "$caddyfile" ] || grep -q "/usr/share/caddy" "$caddyfile"; then
  install -m 0644 "$script_dir/Caddyfile" "$caddyfile"
  echo "Installed $caddyfile; set your domain in it."
elif grep -qF "$caddy_marker" "$caddyfile"; then
  echo "$caddyfile already managed by Basaer; leaving it alone."
else
  echo "$caddyfile is customised (no marker); leaving it alone."
fi

echo "==> Start services"
systemctl daemon-reload
systemctl enable basaer.service basaer-backup.timer caddy
systemctl restart basaer.service
systemctl start basaer-backup.timer
systemctl reload-or-restart caddy

cat <<NEXT

Install finished. Next steps:
  1. Edit $env_file (BASE_URL, SMTP_*, MAIL_FROM, OWNER_EMAIL), then:
       sudo systemctl restart basaer
  2. Set your domain in $caddyfile, then:
       sudo systemctl reload caddy
  3. Load data as user $app_user (see docs/DEPLOY.md):
       cd $app_dir
       sudo -u $app_user BASAER_DB=$data_dir/basaer.sqlite node tools/seed.js
  4. Watch the logs:
       journalctl -u basaer -f
NEXT
