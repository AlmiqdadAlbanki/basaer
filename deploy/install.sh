#!/usr/bin/env bash
# Bootstrap an Ubuntu 26.04 (or 24.04) host for Basaer. Run as root: sudo bash deploy/install.sh
# Safe to run again; each step checks before it changes anything.
set -euo pipefail

app_user=basaer
app_home=/opt/basaer
app_dir=$app_home/app
data_dir=/var/lib/basaer
backup_dir=/var/lib/basaer/backups   # on the data volume, next to what it backs up (docs/DEPLOY.md section 6)
env_file=/etc/basaer.env
site_conf=/etc/nginx/sites-available/basaer
site_link=/etc/nginx/sites-enabled/basaer
site_marker="# basaer-managed"

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
  ca-certificates curl gnupg nginx certbot python3-certbot-nginx \
  libreoffice-core libreoffice-writer libreoffice-impress \
  poppler-utils fonts-hosny-amiri fonts-noto-core sqlite3 rsync build-essential python3 git
# Fonts: the certificate templates embed their own (Cairo, Readex Pro, Markazi Text, IBM Plex
# Sans Arabic travel inside the .docx), so they render the same on any machine; Amiri and
# Noto (Kufi/Naskh Arabic) are only the fallback for a template that embeds nothing.

echo "==> Node 22"
node_major=""
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
fi
if [ "$node_major" != "22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Service user and directories"
if ! id "$app_user" >/dev/null 2>&1; then
  useradd --system --home-dir "$app_home" --create-home --shell /usr/sbin/nologin "$app_user"
fi
mkdir -p "$data_dir/files" "$data_dir/keys" "$backup_dir"
chown -R "$app_user:$app_user" "$data_dir" "$backup_dir"
# Modes as well as ownership (a directory made by hand, or by an rsync as another user, may be
# left wide open): the data is the app's alone; nginx never reads it, the app serves the files.
chmod 750 "$data_dir" "$data_dir/files" "$backup_dir"
chmod 700 "$data_dir/keys"
chmod 700 "$data_dir/keys"

if [ -d "$app_dir" ]; then
  echo "==> App dependencies"
  chown -R "$app_user:$app_user" "$app_dir"
  # npm writes its cache to the service user's home. The home can be root-owned when the
  # directory was created (for the clone) before the user existed, which makes npm ci fail with EACCES.
  chown "$app_user:$app_user" "$app_home"
  (cd "$app_dir" && sudo -u "$app_user" npm ci --omit=dev)
else
  echo "NOTE: $app_dir not found. Clone the repo there, then run this script again."
fi

echo "==> systemd units"
install -m 0644 "$script_dir/basaer.service" /etc/systemd/system/basaer.service
install -m 0644 "$script_dir/basaer-backup.service" /etc/systemd/system/basaer-backup.service
install -m 0644 "$script_dir/basaer-backup.timer" /etc/systemd/system/basaer-backup.timer
chmod +x "$script_dir/backup.sh"

echo "==> Log limits"
# The app logs every request to the journal; cap it so the 8 GB root volume never fills
# (journald's default is 10% of the disk). nginx's logs are rotated by logrotate (14 days).
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=1month\n' > /etc/systemd/journald.conf.d/basaer.conf
systemctl restart systemd-journald

echo "==> Config"
if [ ! -f "$env_file" ]; then
  install -m 0640 -o root -g "$app_user" "$script_dir/basaer.env.example" "$env_file"
  echo "Created $env_file from the example."
fi

# Install our site config over a missing one. A file carrying the marker is ours
# and may hold an edited domain, so it is never overwritten; neither is a
# customised file without the marker.
if [ ! -s "$site_conf" ]; then
  install -m 0644 "$script_dir/nginx-basaer.conf" "$site_conf"
  echo "Installed $site_conf; set server_name in it."
elif grep -qF "$site_marker" "$site_conf"; then
  echo "$site_conf already managed by Basaer; leaving it alone."
else
  echo "$site_conf is customised (no marker); leaving it alone."
fi
ln -sfn "$site_conf" "$site_link"
rm -f /etc/nginx/sites-enabled/default
nginx -t

echo "==> Start services"
systemctl daemon-reload
systemctl enable basaer.service basaer-backup.timer
systemctl restart basaer.service
systemctl start basaer-backup.timer
systemctl enable --now nginx
systemctl reload nginx

cat <<NEXT

Install finished. Next steps:
  1. Edit $env_file (BASE_URL, SMTP_*, MAIL_FROM, OWNER_EMAIL), then:
       sudo systemctl restart basaer
  2. Set server_name in $site_conf, then:
       sudo nginx -t && sudo systemctl reload nginx
     DNS must already point at this server. Then get the HTTPS certificate:
       sudo certbot --nginx -d basaerbh.com -d www.basaerbh.com --redirect -m <email> --agree-tos
     This obtains the Let's Encrypt certificate, adds the 443 block and the
     HTTP to HTTPS redirect, and installs an auto-renew timer. Confirm with:
       systemctl list-timers | grep certbot
  3. Load data as user $app_user (see docs/DEPLOY.md):
       cd $app_dir
       sudo -u $app_user BASAER_DB=$data_dir/basaer.sqlite node tools/seed.js
  4. Watch the logs:
       journalctl -u basaer -f
NEXT
