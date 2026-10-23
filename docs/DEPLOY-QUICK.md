# Basaer deploy: quick sequence

The sequence only. Read `docs/DEPLOY.md` once first; `§` numbers point into it.

Placeholders: `<ip>` Elastic IP · `<domain>` public name (`basaerbh.com`, or a temporary one) ·
`<temp-domain>` the temporary name, if used · `<key.pem>` SSH key path in WSL (`chmod 600`, not under `/mnt/c`) ·
`<email>` your address for Let's Encrypt · `<repo>` the repo in WSL (`/mnt/c/Users/igopaah/Claude/Basaer`) ·
`<stamp>` backup time `YYYYMMDD-HHMM`.

## Sequence

1. **Create the instance** (§1.1–1.3). AWS console: t3.small, Ubuntu 26.04 LTS; root gp3 **8 GB**;
   data gp3 **30 GB**, tag `Name=basaer-data`. Security group: 22 your IP, 80 + 443 anywhere, never 3000.
   Elastic IP → `<ip>`.
   Check (PC, WSL): `ssh -i <key.pem> ubuntu@<ip> true && echo ssh ok` → `ssh ok`.
2. **DNS** (§1.4). Squarespace → Domains → basaerbh.com → DNS: A `@` → `<ip>`; CNAME `www` → `basaerbh.com`.
   Keep MX and `google-site-verification` TXT.
   Check (PC, WSL): `dig +short basaerbh.com` → `<ip>`.
3. **Push and clone** (§2.1).
   ```
   # on your PC, in WSL
   cd <repo> && git push origin master
   ```
   ```
   # on the server, as ubuntu (ssh)
   cd / && sudo mkdir -p /opt/basaer
   sudo git clone https://github.com/AlmiqdadAlbanki/basaer.git /opt/basaer/app
   ```
   Check: `ls /opt/basaer/app/deploy/install.sh` prints the path.
4. **Mount the data volume** (§2.2). Before the bootstrap.
   ```
   # on the server, as ubuntu (ssh)
   cd /
   lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS             # the 30G disk with no FSTYPE, usually nvme1n1
   sudo mkfs.ext4 -L basaer-data /dev/nvme1n1        # ONCE, new empty volume only
   sudo mkdir -p /var/lib/basaer
   echo "LABEL=basaer-data /var/lib/basaer ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
   sudo mount -a && df -h /var/lib/basaer
   ```
   Check: `df` shows ~29G on `/var/lib/basaer` (not `/`, 8G).
5. **Bootstrap** (§2.2).
   ```
   # on the server, as ubuntu (ssh)
   cd /opt/basaer/app && sudo bash deploy/install.sh
   ```
   Check: ends with `Install finished.`; `systemctl is-active basaer nginx` → `active` ×2.
6. **Config** (§2.3). Set `BASE_URL=https://<domain>`.
   ```
   # on the server, as ubuntu (ssh)
   cd / && sudo nano /etc/basaer.env && sudo systemctl restart basaer
   ```
   Check: `journalctl -u basaer -n 20 --no-pager | grep listening` → `listening on https://<domain>`.
7. **HTTPS** (§2.4). Needs DNS (step 2).
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d basaerbh.com -d www.basaerbh.com --redirect -m <email> --agree-tos
   ```
   Check: `systemctl list-timers | grep certbot` shows one line.
8. **Health** (§2.5).
   ```
   # on the server, as ubuntu (ssh)
   cd / && curl -s https://<domain>/healthz
   ```
   Check: `{"ok":true,"mode":"dry-run","rpc":{"size":1,...},"background":{"size":1,...},"readCache":{...}}`.
9. **Snapshots** (§6). AWS console → EC2 → Lifecycle Manager → EBS snapshot policy: tag `Name=basaer-data`, daily, retain 14.
   Check: next day, EC2 → Snapshots lists one.
10. **Copy the data from the PC** (§4, "Copy from the PC"). Straight onto the data volume.
    ```
    # on the server, as ubuntu (ssh)
    cd / && sudo systemctl stop basaer && df -h /var/lib/basaer      # must be the ~29G data volume
    sudo rm -f /var/lib/basaer/basaer.sqlite-wal /var/lib/basaer/basaer.sqlite-shm
    ```
    ```
    # on your PC, in WSL (in tmux; re-run to resume or top up)
    cd <repo>
    rsync -av --partial --info=progress2 --rsync-path="sudo rsync" -e "ssh -i <key.pem>" data/files/ ubuntu@<ip>:/var/lib/basaer/files/
    node -e "require('./server/storage.js').Storage && new (require('./server/storage.js').Storage)('data/basaer.sqlite').db.backup('/tmp/basaer-copy.sqlite').then(() => console.log('copy ready'))"
    rsync -av --rsync-path="sudo rsync" -e "ssh -i <key.pem>" /tmp/basaer-copy.sqlite ubuntu@<ip>:/var/lib/basaer/basaer.sqlite
    ```
    ```
    # on the server, as ubuntu (ssh)
    cd /opt/basaer/app && sudo chown -R basaer:basaer /var/lib/basaer
    sudo -u basaer node tools/rewrite-drive-links.js --base-url https://<domain> --rebase-from http://localhost:3000 --db /var/lib/basaer/basaer.sqlite
    sudo systemctl start basaer
    ```
    Check: rewrite with `--dry-run` again → `links re-pointed:   0`; `/healthz` → `{"ok":true,...}`.
11. **Browser check** (§4.11). `https://<domain>/platform`: sign in with a real account, open a folder link,
    an ID card, render a certificate (first PDF takes 30–60 s).
12. **Go live** (§5). SMTP block in `/etc/basaer.env`; new WhatsApp secrets in the admin screens; test to
    yourself; then `OUTBOUND_MODE=live`.
    ```
    # on the server, as ubuntu (ssh)
    cd / && sudo nano /etc/basaer.env && sudo systemctl restart basaer && curl -s https://<domain>/healthz
    ```
    Check: `"mode":"live"`. Real messages now reach real people.
13. **Cut-over** (§8). In order:
    - DNS at the real domain; if a temporary domain was used, do the three places (Need to know).
    - Freeze the Apps Script (read-only).
    - Final refresh on the server: §4 steps 1 (if not set up), 2, 4–7, 9, 10. Watch `/var/tmp` space (Need to know).
    - Delete the test admin:
      ```
      # on the server, as ubuntu (ssh)
      cd / && sudo -u basaer sqlite3 /var/lib/basaer/basaer.sqlite "DELETE FROM auth_users WHERE uid = 'u191919191'"
      ```
    - Compare row counts:
      ```
      # on the server, as ubuntu (ssh)
      cd /opt/basaer/app && sudo -u basaer node tools/export-xlsx.js --dir /tmp/verify --db /var/lib/basaer/basaer.sqlite
      ```
    - Scan one QR code (`/relay/qr-scan`). Google sign-in and push: out of scope.
    - `OUTBOUND_MODE=live` (step 12); announce `https://basaerbh.com/platform`.
    - Rotate the keys in `docs/SECURITY-FINDINGS.md` (findings 1, 11). Keep the Apps Script read-only a few weeks.
    - Clean up import leftovers and the rclone remote (§4.12).
    Check: `sudo -u basaer sqlite3 /var/lib/basaer/basaer.sqlite "SELECT count(*) FROM auth_users WHERE uid = 'u191919191'"` → `0`.

## Need to know

- **The domain lives in three places** (§2, "Changing the domain"): nginx `server_name` + certificate
  (certbot again, `certbot delete --cert-name <temp-domain>`); `BASE_URL` in `/etc/basaer.env`; the links in
  the sheets: service stopped, then
  `sudo -u basaer node tools/rewrite-drive-links.js --db /var/lib/basaer/basaer.sqlite --base-url https://basaerbh.com --rebase-from https://<temp-domain>`
  from `/opt/basaer/app`. Always pass `--db`. Everyone signs in again once.
- **Never stage data under `/tmp` (or `/var/tmp`) on the server**: both are on the 8 GB root. rsync with
  `--rsync-path="sudo rsync"` straight to `/var/lib/basaer`. The Google pull's `/var/tmp/drive-copy` is on
  the root too: check `df -h /var/tmp` first (§4.6).
- **Database = consistent copy** (`db.backup`, or `sqlite3 .backup`), never `cp` of a live WAL database.
- **dry-run vs live**: `OUTBOUND_MODE=dry-run` records mail/WhatsApp/push and sends nothing. `live` sends
  for real. Stay on dry-run until SMTP and WhatsApp are set (§5).
- **Out of scope at go-live**: Google sign-in (ends when `basaerbh.com` moves here, §5.4) and push (§5.5).
  Users sign in with password or emailed code.
- **Backups** (§6): nightly 03:30 Asia/Qatar → `/var/lib/basaer/backups` (`basaer-<stamp>.sqlite.gz`,
  `keys-<stamp>.tar.gz`, 14 days). Files: daily EBS snapshot of the data volume only.
  Run now: `sudo systemctl start basaer-backup.service`.
- **Grow the data volume** at 80 % (§1.1): EC2 → Volumes → Modify, then on the server
  `sudo resize2fs /dev/nvme1n1` (device from `lsblk`). Online.
- **Update the app** (§7): PC `git push origin master`; server `cd /opt/basaer/app && sudo -u basaer git pull &&
  sudo -u basaer npm ci --omit=dev && sudo systemctl restart basaer`. `deploy/` changed → `sudo bash deploy/install.sh`.
  Then `sudo diff /etc/basaer.env deploy/basaer.env.example`.
- **Logs** (§9): `journalctl -u basaer -f` (app); `/var/log/nginx/basaer.{access,error}.log` (web);
  `journalctl -u basaer-backup` (backup). Error ref `المرجع a1b2c3d4` → `journalctl -u basaer | grep a1b2c3d4`.
- **Keep** `BASAER_RPC_WORKERS=1` (§10). Read cache: `RPC_READ_CACHE_TTL_MS` (60000), `RPC_READ_CACHE_MAX_MB` (32).
- **Leave** `ALLOW_CPR_ONLY_LOGIN` unset. Test admin `191919191` goes at cut-over.
