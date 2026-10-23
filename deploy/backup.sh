#!/usr/bin/env bash
# Nightly copy of the Basaer database and signing keys.
# Runs as the basaer user (see basaer-backup.service).
#
# What it keeps, under /var/lib/basaer/backups (on the data volume, docs/DEPLOY.md section 1):
#   basaer-<stamp>.sqlite.gz   a consistent copy of the database, one per night, 14 days (~5 MB each)
#   keys-<stamp>.tar.gz        the signing keys, one per night, 14 days (a few KB)
# These undo a bad day's edits in a minute. The file store (15 GB of audio, video and PDFs) is
# NOT copied here: the daily EBS snapshot of the data volume covers it, and the database copies
# as well, off the machine (docs/DEPLOY.md section 6).
set -euo pipefail

env_file=/etc/basaer.env
backup_dir=/var/lib/basaer/backups
retention_days=14

# /etc/basaer.env is not valid shell (unquoted spaces), so read single keys.
read_env_value() {
  grep -E "^$1=" "$env_file" | tail -n 1 | cut -d= -f2- || true
}

db_path=$(read_env_value BASAER_DB)
keys_dir=$(read_env_value BASAER_KEYS)
db_path=${db_path:-/var/lib/basaer/basaer.sqlite}
keys_dir=${keys_dir:-/var/lib/basaer/keys}

stamp=$(date +%Y%m%d-%H%M)
sqlite_copy="$backup_dir/basaer-$stamp.sqlite"
keys_archive="$backup_dir/keys-$stamp.tar.gz"

mkdir -p "$backup_dir"

# .backup is safe while the server is writing; a plain cp of a WAL database is not.
sqlite3 "$db_path" ".backup '$sqlite_copy'"
gzip -f "$sqlite_copy"

# -C keeps archive paths relative so a restore can target any location.
tar -czf "$keys_archive" -C "$(dirname "$keys_dir")" "$(basename "$keys_dir")"

find "$backup_dir" -maxdepth 1 -type f \( -name "basaer-*" -o -name "keys-*" \) -mtime +"$retention_days" -delete

echo "Backup written:"
ls -lh "$sqlite_copy.gz" "$keys_archive"
du -sh "$backup_dir"
