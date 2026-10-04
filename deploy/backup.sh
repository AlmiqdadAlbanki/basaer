#!/usr/bin/env bash
# Nightly backup of the Basaer database, uploaded files and keys.
# Runs as the basaer user (see basaer-backup.service).
set -euo pipefail

env_file=/etc/basaer.env
backup_dir=/var/backups/basaer
retention_days=14

# /etc/basaer.env is not valid shell (unquoted spaces), so read single keys.
read_env_value() {
  grep -E "^$1=" "$env_file" | tail -n 1 | cut -d= -f2- || true
}

db_path=$(read_env_value BASAER_DB)
keys_dir=$(read_env_value BASAER_KEYS)
files_dir=$(read_env_value BASAER_FILES)
db_path=${db_path:-/var/lib/basaer/basaer.sqlite}
keys_dir=${keys_dir:-/var/lib/basaer/keys}
files_dir=${files_dir:-/var/lib/basaer/files}

stamp=$(date +%Y%m%d-%H%M)
sqlite_copy="$backup_dir/basaer-$stamp.sqlite"
archive="$backup_dir/basaer-data-$stamp.tar.gz"

mkdir -p "$backup_dir"

# .backup is safe while the server is writing; a plain cp of a WAL database is not.
sqlite3 "$db_path" ".backup '$sqlite_copy'"
gzip -f "$sqlite_copy"

# -C keeps archive paths relative so a restore can target any location.
tar -czf "$archive" \
  -C "$(dirname "$files_dir")" "$(basename "$files_dir")" \
  -C "$(dirname "$keys_dir")" "$(basename "$keys_dir")"

find "$backup_dir" -maxdepth 1 -type f -name "basaer-*" -mtime +"$retention_days" -delete

echo "Backup written:"
ls -lh "$sqlite_copy.gz" "$archive"
du -sh "$backup_dir"
