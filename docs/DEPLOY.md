# Basaer deployment runbook

For the operator. Everything below runs on the server unless it says otherwise.
Paths: app in `/opt/basaer/app`, data in `/var/lib/basaer`, backups in `/var/backups/basaer`,
config in `/etc/basaer.env`.

## 1. Prerequisites

1. An EC2 instance: t3.small, Ubuntu 24.04.
2. Security group inbound: 22 (your IP only), 80 and 443 (anywhere). Do not open 3000.
3. An Elastic IP attached to the instance.
4. A DNS A record for the app domain (for example `app.basaerbh.com`) pointing at the Elastic IP.
   DNS must point at the IP before you run certbot, which needs it to issue the HTTPS certificate.

## 2. Install

1. Clone the repo:
   ```
   sudo mkdir -p /opt/basaer
   sudo git clone <repo-url> /opt/basaer/app
   ```
2. Run the bootstrap (installs packages, Node 22, nginx, certbot, the `basaer` user, units, timer):
   ```
   cd /opt/basaer/app
   sudo bash deploy/install.sh
   ```
   If you ran it before cloning, run it again after the clone so `npm ci` happens.
3. Edit the config and set at least `BASE_URL`. The other settings are listed below the steps:
   ```
   sudo nano /etc/basaer.env
   sudo systemctl restart basaer
   ```
4. Set the domain: edit `server_name` in `/etc/nginx/sites-available/basaer` (replace
   `app.basaerbh.com`), reload nginx, then get the certificate. certbot obtains it, adds the 443
   block and the HTTP to HTTPS redirect, and installs an auto-renew timer
   (`systemctl list-timers | grep certbot`):
   ```
   sudo nano /etc/nginx/sites-available/basaer
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d <domain> --redirect -m <email> --agree-tos
   ```
   After HTTPS works you may enable HSTS (see the comment in the site file).
   To test without a domain, use `server_name _;`, skip certbot, use plain HTTP, and set
   `BASE_URL=http://<ip>` in `/etc/basaer.env`. Logins do not stick over plain HTTP while
   `NODE_ENV=production`: the session cookie is marked Secure, so the browser throws it away. For
   a short test only, set `NODE_ENV=development` (this also turns on the admin-only `/dev/*`
   pages and shows raw error text), and put it back to `production` before real use.
5. Check: `curl https://<domain>/healthz` should return
   `{"ok":true,"mode":"dry-run","rpc":{"size":1,"busy":0,"queued":0},"background":{"size":1,"busy":0,"queued":0}}`.
   `journalctl -u basaer -n 20` shows the start-up lines, including `workers: 1 rpc + 1 background`
   and `google sign-in: enabled` or `disabled`.

All writable state (database, keys, uploaded files and generated documents) lives under
`/var/lib/basaer`, set by `BASAER_DB`, `BASAER_KEYS` and `BASAER_FILES` in `/etc/basaer.env`.
The app directory itself is read-only to the service.

Other settings in `/etc/basaer.env`. Each has a safe default and a comment in the example file.
Restart the service after changing any of them.

- `BASAER_RPC_WORKERS` (default `1`): how many worker threads run interactive calls. Keep it at 1;
  read section 10 before changing it.
- `SESSION_TTL_DAYS` (default `7`): how long a login lasts without use. Every visit renews it, up
  to an absolute limit of 30 days, after which the user signs in again.
- `FIREBASE_PROJECT_ID` (the example file sets `coming-soon-basaer`) and/or `GOOGLE_OAUTH_CLIENT_ID`:
  turn on server-side checking of Google sign-in tokens. With neither set, "sign in with Google"
  is refused. See section 5.
- `ALLOW_CPR_ONLY_LOGIN` (default off; only the value `1` turns it on): brings back "log in with
  the CPR alone, skip email verification". **Warning:** while it is on, anyone who knows or guesses
  a CPR can log in as that person, staff and administrators included, and CPRs are not secret.
  Leave it off. The server prints a WARNING line at start-up when it is on.
- `TRUST_PROXY` (default `loopback`): the app takes the client's address from nginx's
  `X-Forwarded-For` header, and only when the request comes from this machine. The rate limits
  depend on it. Change it only if the proxy runs on another host.

How sign-in works, for testing and support. A successful login sets an httpOnly cookie
`basaer_session` (SameSite=Lax, Secure in production) and gives the page a 15-minute access token
that it keeps in memory only. The browser stores no token in localStorage, only a non-secret
`basaer_user` hint. Logout revokes the session on the server, so a copied cookie stops working
too. A POST that relies on the cookie must send the header `X-Requested-With: basaer` (the app
does); without it the request counts as not logged in, which matters when you test with `curl`.
The keys in `BASAER_KEYS` sign everything, so losing them logs every user out.

## 3. First run with demo data

```
cd /opt/basaer/app
sudo -u basaer BASAER_DB=/var/lib/basaer/basaer.sqlite node tools/seed.js
sudo -u basaer BASAER_DB=/var/lib/basaer/basaer.sqlite BASAER_FILES=/var/lib/basaer/files node tools/make-demo-templates.js
sudo systemctl restart basaer
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
   issue new ones (see the cut-over checklist). Browser push also needs step 5 below.
3. Turn on Google sign-in. Check that `/etc/basaer.env` has `FIREBASE_PROJECT_ID=coming-soon-basaer`
   (the Firebase project the relay page signs in with), then restart the service. The journal
   should say `google sign-in: enabled`. The server now checks the Google ID token itself and
   ignores any email or `ok` flag the relay page sends. With no project id set, "sign in with
   Google" is refused. If the page uses Google Identity Services directly instead of Firebase,
   set `GOOGLE_OAUTH_CLIENT_ID` to its client id.
4. Change the `google-signin-relay` page. It lives on Firebase Hosting, outside this repository,
   and must be edited and redeployed there. It has to POST to `https://<domain>/exec`:
   ```
   { "action": "oauthVerify", "verifyToken": "<the verifyToken it already uses>", "idToken": "<ID token>" }
   ```
   where `idToken` is `await firebase.auth().currentUser.getIdToken()`, a Firebase ID token for
   project `coming-soon-basaer`. The body is JSON; the server reads it whatever the Content-Type,
   so the page's `no-cors` text/plain post still works. A post without a valid `idToken` is
   refused (401), error reports from the page included. Until the relay is changed, "sign in with
   Google" fails and users sign in with the emailed code or their password.
5. Browser push (FCM) registration. `/exec` with `saveFcmToken` now needs a logged-in session, and
   the session cookie is only sent to the app's own domain. So the `platform.html` push page must
   be served from `https://<domain>`, not from Firebase Hosting. The server has no route for that
   page today; adding one is a code change. Until it is done, push registration from that page is
   refused (401) and FCM stays out of scope for go-live.
6. Leave `ALLOW_CPR_ONLY_LOGIN` unset (section 2). Send a test to yourself first, then set
   `OUTBOUND_MODE=live` in `/etc/basaer.env`:
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
`install.sh` never overwrites an existing `/etc/basaer.env`, so new settings do not appear on their
own. After an update, compare it with `deploy/basaer.env.example` (`diff /etc/basaer.env
deploy/basaer.env.example`) and add what is missing, for example `FIREBASE_PROJECT_ID`.
A restart does not log anyone out (sessions are signed with the keys on disk). It does clear the
in-memory rate-limit counters (section 9).

## 8. Cut-over checklist

1. Lower the DNS TTL a day ahead, then point the A record at the Elastic IP. Confirm
   `https://<domain>/healthz`.
2. Freeze the Apps Script: make it read-only, so nobody writes to the old system.
3. Export the final sheets and import them (section 4). Re-register templates if needed.
4. Verify counts: export from the new system and compare row counts per sheet with the Google Sheets.
   ```
   sudo -u basaer node tools/export-xlsx.js --dir /tmp/verify --db /var/lib/basaer/basaer.sqlite
   ```
5. Set `FIREBASE_PROJECT_ID=coming-soon-basaer` in `/etc/basaer.env`, restart, and check that the
   journal says `google sign-in: enabled`.
6. Repoint the two Firebase-hosted relay pages, `google-signin-relay` and `qr-scan-relay`,
   to `POST https://<domain>/exec`, and redeploy them on Firebase Hosting. `qr-scan-relay` only
   needs the new address. `google-signin-relay` must also change what it posts: `{ action:
   'oauthVerify', verifyToken, idToken }`, with `idToken` from
   `await firebase.auth().currentUser.getIdToken()` (section 5, step 4). Test both: sign in with
   Google using an account whose email is on file, and scan one QR code.
7. Serve `platform.html` (the push registration page) from the app's own domain, not from
   Firebase Hosting. Its `saveFcmToken` post to `/exec` needs the login cookie, so it must be
   same-origin and send the header `X-Requested-With: basaer`. This needs a code change (the
   server has no route for the page). Until it is done, FCM stays out of scope: leave push
   notifications out of the announcement.
8. Switch on `OUTBOUND_MODE=live` (section 5) once step 4 looks right.
9. Announce the new URL to staff, students and parents.
10. Rotate the keys and tokens listed in `docs/SECURITY-FINDINGS.md` (findings 1 and 11:
    Google OAuth access, the exposed keys, the Fonnte token), and revoke the old ones.
11. Keep the old Apps Script read-only for a few weeks as a fallback, then archive it.

## 9. Troubleshooting

- Logs: `journalctl -u basaer -f` (app), `sudo tail -f /var/log/nginx/basaer.access.log /var/log/nginx/basaer.error.log` (web).
- Request log: every API request (`/api`, `/exec`, `/files`) writes one JSON line to the journal,
  with no request body:
  `{"t":"2026-10-20T08:15:02.113Z","ip":"203.0.113.7","m":"POST","p":"/api/rpc/getPersons","s":200,"ms":12.4,"cpr":"<caller>","ref":"a1b2c3d4"}`
  `ip` is the client's address, `s` the HTTP status, `ms` the time taken, `cpr` the logged-in
  caller (so treat the journal as personal data). `ref` appears only when the request failed on
  the server. In production the user sees a generic message ending with a reference
  (`المرجع a1b2c3d4`). Find the cause with `journalctl -u basaer | grep a1b2c3d4`: the line
  `RPC <function> failed [a1b2c3d4]:` (or `/exec <action> failed [...]`) is followed by the error
  and its stack. To list server errors: `journalctl -u basaer -o cat | grep '"s":5'`.
- Health: `curl http://localhost:3000/healthz` on the server, `curl https://<domain>/healthz` outside.
  It also reports the worker pools, for example
  `"rpc":{"size":1,"busy":1,"queued":3}`. `busy` is how many workers are running a call right now
  and `queued` how many calls are waiting for a free worker. `queued` that stays above 0 for a
  minute means a slow call is holding the worker, or the load is too much for it (section 10).
  More than 500 waiting calls are refused with "server busy, try again shortly" (503).
  `/healthz` is answered by the HTTP thread, so it can say ok while interactive calls are slow.
- The service restarts every 3 seconds if it crashes; `systemctl status basaer` shows the last error.
- A worker crashed or hung: the journal has lines starting `[rpc]` or `[background]`:
  `worker exited with code N; respawning` (the pool starts a new worker at once; the call that
  was running fails with a generic error and a reference), `worker error: ...`, and
  `job call <function> exceeded 300000ms; terminating worker` (a call ran for more than 5 minutes
  and was cut off). If one function keeps appearing, note its name and the stack trace printed
  before the line and pass them to the developer. If a worker cannot start at all, the service
  logs `startup failed:` and systemd retries every 3 seconds.
- 429 Too Many Requests: the app's own rate limits. The reply has a `Retry-After` header
  (seconds) and a `scope` field naming the limit that was hit:
  - `auth` (session endpoints): 30 per minute per IP.
  - `rpc`: 120 per minute per IP when not logged in; 600 per minute per user when logged in.
  - `login` (password login, login-code check, registration-code check, Google login,
    skip-verification login): 30 per 10 minutes per IP, and 10 per 10 minutes for the same CPR
    or email.
  - `otp` (asking for a login or registration code): 5 per 10 minutes for the same CPR or email.
  - `exec` (the relay pages): 60 per minute per IP.
  The counters are in memory. They clear by themselves when the window ends, and at once with
  `sudo systemctl restart basaer`. A whole class signing in from one Wi-Fi shares one IP and can
  reach the `login` limit. If everyone gets 429, every request looks like it comes from one
  client: check that the nginx site file still has the `X-Forwarded-For` line, that `TRUST_PROXY`
  is not changed, and that `ip` in the request log shows real addresses and not `127.0.0.1`.
- A user with the right password is refused, or the app says there were too many attempts: the
  account is locked for that user's network address. 10 wrong passwords within 15 minutes lock
  the (email, address) pair for 15 minutes, and the lock ends by itself; the same user from
  another address, or a successful login, is not affected. Rows in the table `auth_attempts`
  are keyed `email|address` (email in lower case) and survive restarts. To see who is locked and
  to lift a lock now (the service can keep running):
  ```
  sudo -u basaer sqlite3 -cmd ".timeout 5000" /var/lib/basaer/basaer.sqlite \
    "SELECT email, failures, datetime(locked_until/1000,'unixepoch') AS locked_until_utc FROM auth_attempts WHERE locked_until > strftime('%s','now')*1000;"
  sudo -u basaer sqlite3 -cmd ".timeout 5000" /var/lib/basaer/basaer.sqlite \
    "DELETE FROM auth_attempts WHERE email LIKE 'student@example.com|%';"
  ```
- "Sign in with Google" fails: check the start-up line `google sign-in:` in the journal.
  `disabled` means neither `FIREBASE_PROJECT_ID` nor `GOOGLE_OAUTH_CLIENT_ID` is set (the relay's
  post gets 503). If it says `enabled`, the relay is probably still posting the old payload
  without an `idToken` (401), or its ID token comes from another Firebase project than
  `FIREBASE_PROJECT_ID`. See section 5, step 4. Users can use the emailed code or their password
  meanwhile.
- Users are logged out unexpectedly: the files in `BASAER_KEYS` were lost or replaced. Over plain
  HTTP with `NODE_ENV=production` the browser also drops the Secure session cookie (section 2).
- A page shows data that someone else just changed: the page keeps the results of read-only calls
  until it is reloaded, and clears them whenever that user saves something. Reloading fetches
  fresh data.
- certbot fails: DNS probably has not propagated. `dig +short <domain>` must print the Elastic IP,
  and ports 80 and 443 must be open. See `/var/log/letsencrypt/letsencrypt.log`.
- `nginx -t` reports a syntax error: fix the line it names in `/etc/nginx/sites-available/basaer`
  (often a missing `;`), then run `sudo nginx -t` again before reloading.
- 502 Bad Gateway: the Node service is down. `systemctl status basaer`, `journalctl -u basaer -e`.
- 413 Request Entity Too Large: the upload exceeds `client_max_body_size` (50m) in the site file.
  Raise it, then `sudo nginx -t && sudo systemctl reload nginx`.
- First certificate or PDF generation is slow (30 to 60 seconds): LibreOffice builds its profile
  in `/var/lib/basaer` on first use. Later runs are fast.
- Arabic text looks wrong in documents: check `fc-list | grep -i amiri`.
- `EADDRINUSE` (port in use): another process holds port 3000. Find it with `sudo ss -ltnp | grep 3000`,
  stop it, then `sudo systemctl restart basaer`.
- Permission errors writing files: `/var/lib/basaer` and everything under it must be owned by
  `basaer` (`sudo chown -R basaer:basaer /var/lib/basaer`), and `BASAER_FILES` in `/etc/basaer.env`
  must point inside it.

## 10. Capacity and scaling

How the server runs. It is one Node process on one machine, started by systemd. Inside it:

- The HTTP thread serves pages, files and `/healthz`, checks logins and applies the rate limits.
  It never runs the legacy (Apps Script) code, so a slow job cannot stop pages from loading.
- One worker thread, the "rpc" pool, runs the interactive calls from the browser, one at a time.
- One worker thread, the "background" pool, runs the timed jobs: WhatsApp and push queue ticks,
  exam monitors and certificate batches. A long batch no longer freezes users.

The Apps Script `LockService` is a real lock shared by all workers, so code the legacy source
guards with a lock stays exclusive even between an interactive call and a background job.

`BASAER_RPC_WORKERS` sets how many threads run interactive calls (default 1). Keep it at 1: the
legacy code has many check-then-write steps (look for a duplicate scan, then append a row;
remember a row number, then delete rows) that are only safe when interactive calls run one at a
time, so raise it only after those code paths have been reviewed. With 1, a slow call, such as
a certificate or PDF (a second or two; 30 to 60 seconds for the first LibreOffice run), makes
other users' calls wait behind it, while pages and files are unaffected. Each worker also holds
its own in-memory copy of the data it has read, so more workers means more memory. At 1 worker,
users' calls cannot overlap each other; they can still overlap a background job where the legacy
code takes no lock, as they could on Apps Script.

Scaling up: make the machine bigger rather than adding processes. A t3.small has 2 vCPU and 2 GB
of memory; a t3.medium has 2 vCPU and 4 GB. Move up when `free -m` shows little free memory
(LibreOffice is the biggest user), when `queued` in `/healthz` stays above 0, or when the `ms`
field in the request log climbs. To resize:

1. Take a backup (section 6).
2. In the EC2 console, stop the instance, choose Actions, Instance settings, Change instance
   type, pick the new type, and start it. The Elastic IP stays attached. The site is down for a
   few minutes.
3. Check `curl https://<domain>/healthz`.

Do not run a second copy of the server against the same database, or put two behind a load
balancer. The shared lock, the rate limits and the five-minute record of Google-verified emails
live in the memory of the one process.

Why SQLite is the right store for this app:

- The data is bounded by what the Google Sheets held, which is small for a database.
- Reads are served from memory. Each sheet is loaded into memory on first use; SQLite is read
  again only when another worker has changed that sheet.
- Writes are serialised: SQLite takes one writer at a time, and interactive calls already run one
  at a time.
- There is one file to back up (`sqlite3 .backup`, section 6), plus the files directory.

The honest limits:

- It is one machine. There is no failover. If the instance or its disk is lost, you build a new
  one and restore the last backup, and anything written since the 03:30 backup is gone unless you
  also take EBS snapshots.
- Moving to PostgreSQL or another networked database is not a configuration change. The legacy
  code is synchronous (it reads or writes a sheet and carries on with the next line), and a
  networked database driver is asynchronous, so the legacy code would have to be rewritten.
