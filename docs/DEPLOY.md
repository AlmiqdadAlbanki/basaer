# Basaer deployment runbook

For the operator. Everything below runs on the server unless it says otherwise.
Paths: app in `/opt/basaer/app`, data in `/var/lib/basaer`, backups in `/var/backups/basaer`,
config in `/etc/basaer.env`.

## 1. Prerequisites

1. An EC2 instance: t3.small, Ubuntu 24.04.
2. Security group inbound: 22 (your IP only), 80 and 443 (anywhere). Do not open 3000.
3. An Elastic IP attached to the instance.
4. A DNS A record for the app domain (for example `app.basaerbh.com`) pointing at the Elastic IP.
   Caddy needs this to issue the HTTPS certificate.

## 2. Install

1. Clone the repo:
   ```
   sudo mkdir -p /opt/basaer
   sudo git clone <repo-url> /opt/basaer/app
   ```
2. Run the bootstrap (installs packages, Node 22, Caddy, the `basaer` user, units, timer):
   ```
   cd /opt/basaer/app
   sudo bash deploy/install.sh
   ```
   If you ran it before cloning, run it again after the clone so `npm ci` happens.
3. Edit the config and set at least `BASE_URL`:
   ```
   sudo nano /etc/basaer.env
   sudo systemctl restart basaer
   ```
4. Set the domain in the Caddyfile (replace `app.basaerbh.com`) and reload:
   ```
   sudo nano /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
5. Check: `curl https://<domain>/healthz` should return `{"ok":true,"mode":"dry-run"}`.

All writable state (database, keys, uploaded files and generated documents) lives under
`/var/lib/basaer`, set by `BASAER_DB`, `BASAER_KEYS` and `BASAER_FILES` in `/etc/basaer.env`.
The app directory itself is read-only to the service.

## 3. First run with demo data

```
cd /opt/basaer/app
sudo -u basaer BASAER_DB=/var/lib/basaer/basaer.sqlite node tools/seed.js
sudo -u basaer BASAER_DB=/var/lib/basaer/basaer.sqlite node tools/make-demo-templates.js
```

Demo logins are printed by `seed.js` (default demo password `Test@1234`). Do not leave demo
data in a system that will hold real data: stop the service and delete
`/var/lib/basaer/basaer.sqlite*` before section 4.

## 4. Loading the real data

1. On your own machine, export each Google Sheet as .xlsx (File, Download, Microsoft Excel).
   Name each file after its logical name: `mainData.xlsx`, `attendanceData.xlsx`,
   `answersData.xlsx`, `dectationData.xlsx`, `refID.xlsx`, `archiveData.xlsx`.
2. Copy the folder to the server (`scp -r exports ubuntu@<ip>:/tmp/exports`).
3. Import. `TZ=Asia/Qatar` is required so dates keep their local time; `--db` is required:
   ```
   sudo systemctl stop basaer
   cd /opt/basaer/app
   sudo -u basaer TZ=Asia/Qatar node tools/import-xlsx.js --dir /tmp/exports --db /var/lib/basaer/basaer.sqlite
   sudo systemctl start basaer
   ```
4. Register the real document templates (.docx for certificates and cards, .pptx for greetings).
   The ids are the legacy Google Drive ids the code names. `tools/make-demo-templates.js`
   registers the same ids with stand-in files, so these are the ones to replace:
   - `certIdTemp` (certificate) and `cardID00`, `cardID01`, `cardID02`, `cardID03` (ID cards).
     The actual id values are the strings assigned to those variables in `gas/code.js` and
     `gas/oldJS.js`.
   - The greeting template: its id is the `templateId` column of the `greetingTemplates`
     sheet. The demo script uses `local_demo_greeting_template`.
   ```
   sudo -u basaer node tools/register-template.js --id <legacyDriveId> --file /tmp/cert.docx --name "Certificate"
   ```
   Add `--db /var/lib/basaer/basaer.sqlite` if you did not export `BASAER_DB`.
   Templates must also be registered for any other template id used in the Certificates and
   stages sheets.
5. Delete `/tmp/exports` when done; it holds personal data.

## 5. Going live

Until this step the server records emails, WhatsApp messages and push notifications and sends nothing.

1. Fill in the SMTP block of `/etc/basaer.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
   `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `OWNER_EMAIL`).
2. Re-enter the WhatsApp (Fonnte / Meta) and FCM push settings the Apps Script kept in Script
   Properties, using the admin screens of the app. Do not copy old secrets from the spreadsheet;
   issue new ones (see the cut-over checklist).
3. Send a test to yourself first, then set `OUTBOUND_MODE=live` in `/etc/basaer.env`:
   ```
   sudo systemctl restart basaer
   curl https://<domain>/healthz     # mode should say "live"
   ```
   Warning: from now on real messages go to real students and parents.

## 6. Backups and restore

A timer runs `deploy/backup.sh` every night at 03:30 Asia/Qatar. Each run writes to
`/var/backups/basaer`: `basaer-<stamp>.sqlite.gz` (database) and `basaer-data-<stamp>.tar.gz`
(files and keys). Files older than 14 days are deleted.

Check and run by hand:
```
systemctl list-timers basaer-backup.timer
sudo systemctl start basaer-backup.service
ls -lh /var/backups/basaer
```

Restore one database backup:
```
sudo systemctl stop basaer
sudo -u basaer rm -f /var/lib/basaer/basaer.sqlite-wal /var/lib/basaer/basaer.sqlite-shm
gunzip -c /var/backups/basaer/basaer-<stamp>.sqlite.gz | sudo -u basaer tee /var/lib/basaer/basaer.sqlite > /dev/null
sudo systemctl start basaer
```
Restore files and keys (only if they were lost):
```
sudo -u basaer tar -xzf /var/backups/basaer/basaer-data-<stamp>.tar.gz -C /var/lib/basaer
```
Backups live on the same disk. Copy them off the instance regularly (for example to S3 or your
own machine) or enable EBS snapshots.

## 7. Updating

```
cd /opt/basaer/app
sudo -u basaer git pull
sudo -u basaer npm ci --omit=dev
sudo systemctl restart basaer
```
If `deploy/` files changed, run `sudo bash deploy/install.sh` again.

## 8. Cut-over checklist

1. Lower the DNS TTL a day ahead, then point the A record at the Elastic IP. Confirm
   `https://<domain>/healthz`.
2. Freeze the Apps Script: make it read-only, so nobody writes to the old system.
3. Export the final sheets and import them (section 4). Re-register templates if needed.
4. Verify counts: export from the new system and compare row counts per sheet with the Google Sheets.
   ```
   sudo -u basaer node tools/export-xlsx.js --dir /tmp/verify --db /var/lib/basaer/basaer.sqlite
   ```
5. Repoint the two Firebase-hosted relay pages, `google-signin-relay` and `qr-scan-relay`,
   to `POST https://<domain>/exec`, and redeploy them on Firebase Hosting.
6. Switch on `OUTBOUND_MODE=live` (section 5) once step 4 looks right.
7. Announce the new URL to staff, students and parents.
8. Rotate the keys and tokens listed in `docs/SECURITY-FINDINGS.md` (findings 1 and 11:
   Google OAuth access, the exposed keys, the Fonnte token), and revoke the old ones.
9. Keep the old Apps Script read-only for a few weeks as a fallback, then archive it.

## 9. Troubleshooting

- Logs: `journalctl -u basaer -f` (app), `sudo tail -f /var/log/caddy/basaer.log` (web).
- Health: `curl http://localhost:3000/healthz` on the server, `curl https://<domain>/healthz` outside.
- The service restarts every 3 seconds if it crashes; `systemctl status basaer` shows the last error.
- Certificate not issued: the DNS A record must resolve to the Elastic IP and ports 80 and 443
  must be open. Check `journalctl -u caddy`.
- First certificate or PDF generation is slow (30 to 60 seconds): LibreOffice builds its profile
  in `/var/lib/basaer` on first use. Later runs are fast.
- Arabic text looks wrong in documents: check `fc-list | grep -i amiri`.
- `EADDRINUSE` (port in use): another process holds port 3000. Find it with `sudo ss -ltnp | grep 3000`,
  stop it, then `sudo systemctl restart basaer`.
- Permission errors writing files: `/var/lib/basaer` and everything under it must be owned by
  `basaer` (`sudo chown -R basaer:basaer /var/lib/basaer`), and `BASAER_FILES` in `/etc/basaer.env`
  must point inside it.
