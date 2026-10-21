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

What the server answers. The academy's public website, which used to be on Firebase Hosting, is
served from here too, at the addresses it had there:

- `/` is the home page and `/student-guide` the student guide (`/student-guide.pdf` its PDF).
  `/assets/...`, `/favicon.ico`, `/robots.txt` and `/sitemap.xml` are the website's files, kept in
  `server/client/site/`. The old names `/index.html`, `/platform.html` and `/student-guide.html`
  redirect to the addresses without `.html`.
- `/platform` is the address to give people: the header bar with the logo, and the app below it in a
  frame. Its query string is passed on to the app (`/platform?logout=1` opens `/app?logout=1`), and
  the open view shows in its address: the app reports its view to the page, which shows it as
  `/platform/p/<view>`, and that address frames `/app/p/<view>` again on a refresh or from a bookmark.
- `/app` is the app itself, the address of the frame inside `/platform`; it keeps the open view as
  `/app/p/<view>` (the older `/p/<view>` addresses redirect there). Opened directly in a tab it
  redirects to the same view under `/platform`, so the header bar is always there.
- `/relay/...`, `/api/...`, `/exec`, `/files/...`, `/thumb`, `/doc/...`, `/partials/...`, `/fonts/...`
  and `/site-assets/...` are used by the app, and `/healthz` is the check in step 5.

The website's pages give `https://basaerbh.com/` as their address (to search engines and link
previews), so they belong on that domain, although they work the same under another name such as
`app.basaerbh.com`. Read section 5, step 4 before pointing `basaerbh.com` itself at this server:
Google sign-in needs `https://basaerbh.com/__/auth/handler`, which only Firebase Hosting serves.

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

The aim is that nothing is left on Google. Two things come over: the spreadsheets, and every Drive
file they link to (student folders, certificates, ID cards, course material). The files keep their
original Google ids, and the links stored in the sheets are then rewritten to this server's own
addresses. The access to Google is read-only, so nothing is ever written to it.

Run the whole section on the server, in `/opt/basaer/app`, as the `basaer` user, so that the
database and the files end up owned by the service. The service stays stopped while you work.
Check the free disk space first (`df -h`): for a while every file exists twice, once in the working
copy and once in the file store. Copying can take hours, so start `tmux` (or `screen`) first and a
dropped SSH connection will not stop it. The tools read `BASAER_DB` and `BASAER_FILES`, so set them
once here instead of adding `--db` and `--files-dir` to every command (a flag still overrides them):
```
sudo systemctl stop basaer
sudo -u basaer -H bash
cd /opt/basaer/app
export BASAER_DB=/var/lib/basaer/basaer.sqlite BASAER_FILES=/var/lib/basaer/files
```
Everything below is typed in that shell until step 11.

1. Give the server read-only access to Drive. This is done once. rclone must be installed
   (rclone.org/install); `deploy/install.sh` does not install it.
   ```
   bash tools/google-exports.sh setup
   rclone config reconnect gdrive:
   rclone lsd gdrive:
   ```
   `setup` creates the rclone remote `gdrive` with the read-only scope `drive.readonly`. Sign in
   with the Google account the admin shared the files with. On a machine with a browser,
   `rclone config reconnect gdrive:` is all it takes. The server has no browser, so use the other
   way that `setup` prints: on a machine that has a browser and rclone, run
   `rclone authorize "drive" "" "" --drive-scope drive.readonly`, sign in, and copy the token it
   prints. Then run `rclone config reconnect gdrive:` on the server and paste the token when it
   asks for the result of `rclone authorize`. `rclone lsd gdrive:` should now list the account's
   top-level folders.
2. Pull the sheets, the templates and the folders the code names, and import them. `pull` fetches
   six workbooks (.xlsx), five templates (.docx) and the seven folders named in the code into
   `data/google-exports/`. The import loads the sheets, registers the templates under their legacy
   Drive ids, imports those seven folders (whole) with their original folder and file ids, and ends
   with a header check:
   ```
   bash tools/google-exports.sh pull
   TZ=Asia/Qatar node tools/import-google-exports.js
   ```
   `pull` prints one line per item. An item the admin has not shared with your account shows
   `ACCESS DENIED (not shared with you)`; that is reported, not fatal. Ask the admin to share it and
   run `pull` again, which is safe to repeat. Read every `WARN` line the import prints. The result
   you want ends with `Header check: all expected headers present, in order`.

   `TZ=Asia/Qatar` is still required, so dates keep their local time. The importer converts the
   spreadsheets' date numbers itself, because the xlsx library's own conversion came out 8 seconds
   early and so moved every date-only cell to the previous day.

   **Warning:** the import replaces every sheet it loads. Do not run it again once people use the
   new system. If you run it again before then, run step 9 again afterwards, because the workbooks
   hold Google links.
3. Find the greeting-card templates, and register any other templates. The greeting templates
   (Slides) are not named in the code: their ids are in the `refID` workbook, which step 2 has put
   in the database. So a second pass finds them, fetches them and imports again:
   ```
   bash tools/google-exports.sh discover
   bash tools/google-exports.sh pull
   TZ=Asia/Qatar node tools/import-google-exports.js
   ```
   `discover` adds them to `tools/google-files.json` and prints one line for each. Any other
   template id used in the Certificates and stages sheets is registered by hand, from a copy of the
   file:
   ```
   node tools/register-template.js --id <legacyDriveId> --file <path.docx|.pptx> --name "<name>"
   ```
4. List the two Drive trees the rest of the referenced files live in: the account's My Drive, and
   the folders shared with it. Run them one after the other. The three throttling flags are there
   because a plain run against a large tree died with `rateLimitExceeded`. **Never run two rclone
   jobs at once** (this includes `pull` and the copy in step 6): they compete for the same limit.
   ```
   mkdir -p data/google-exports/trees
   rclone lsjson -R --drive-export-formats pdf \
     --tpslimit 4 --retries 20 --low-level-retries 40 \
     gdrive: > data/google-exports/trees/mydrive.lsjson
   rclone lsjson -R --drive-shared-with-me --drive-export-formats pdf \
     --tpslimit 4 --retries 20 --low-level-retries 40 \
     gdrive: > data/google-exports/trees/shared.lsjson
   ```
   A big Drive takes a long time. If rclone stops with an error, delete the half-written file and
   run it again: the importer refuses a listing that is not complete JSON.
5. Make the list of ids to bring over: a JSON array of Google ids in a file, for example
   `data/google-exports/referenced-ids.json`:
   ```
   ["1AbCdEf...", "1GhIjKl..."]
   ```
   It must hold every Google id that appears in any cell of any sheet, whether inside a link or on
   its own, and every id written into the pages (the logo, the default avatar and the carousel
   pictures, and any other id in `gas/*.html` and `gas/*.js`). Only what is on the list comes over,
   and the id of a folder brings everything inside it. Nothing else is copied, because every
   imported file becomes readable by its link.

   The tool that writes it reads every sheet cell for Google links and adds the ids listed in
   `data/google-exports/code-assets/ids.tsv` (step 8):
   ```
   node tools/list-referenced-ids.js --out data/google-exports/referenced-ids.json
   ```
   A dry run of the link rewriter is a useful check of where the Google links are, per sheet and
   column (it changes nothing; the report holds counts and a few sample ids per column):
   ```
   node tools/rewrite-drive-links.js --base-url https://<domain> --dry-run --report /tmp/links.json
   ```
6. Copy only what is referenced. With `--list-paths` the tool imports nothing: it writes the paths
   of the referenced files to a text file and prints the counts, and `--unfound-ids` writes the
   referenced ids that are not in that tree. rclone then copies exactly those paths. Copy to a
   native Linux path such as `/var/tmp/drive-copy`, never under `/mnt/c` on WSL: thousands of small
   files are about 10 times slower through the Windows bridge. Google Docs, Sheets and Slides files
   come over as PDF. My Drive:
   ```
   node tools/import-drive-tree.js --listing data/google-exports/trees/mydrive.lsjson \
     --only-ids data/google-exports/referenced-ids.json \
     --list-paths data/google-exports/trees/mydrive-paths.txt \
     --unfound-ids data/google-exports/trees/mydrive-unfound.txt
   rclone copy gdrive: /var/tmp/drive-copy/mydrive \
     --files-from data/google-exports/trees/mydrive-paths.txt --drive-export-formats pdf
   ```
   The tree shared with the account (note the extra flag on the copy):
   ```
   node tools/import-drive-tree.js --listing data/google-exports/trees/shared.lsjson \
     --only-ids data/google-exports/referenced-ids.json \
     --list-paths data/google-exports/trees/shared-paths.txt \
     --unfound-ids data/google-exports/trees/shared-unfound.txt
   rclone copy gdrive: /var/tmp/drive-copy/shared \
     --files-from data/google-exports/trees/shared-paths.txt --drive-export-formats pdf \
     --drive-shared-with-me
   ```
   If rclone stops with `rateLimitExceeded`, add the three throttling flags from step 4 and run it
   again.

   Each `-unfound.txt` file lists the referenced ids that are missing from that one tree. An id
   that is in no tree at all appears in both files:
   ```
   comm -12 <(sort data/google-exports/trees/mydrive-unfound.txt) \
            <(sort data/google-exports/trees/shared-unfound.txt)
   ```
   Ask the admin to share those files or folders with the account, then list the trees again
   (step 4) and repeat. The page images of step 8 will be among them.
7. Import the copies. Add `--dry-run` to the first command to see the counts without writing
   anything.
   ```
   node tools/import-drive-tree.js --listing data/google-exports/trees/mydrive.lsjson \
     --dir /var/tmp/drive-copy/mydrive --root-id mydrive-root --root-name "My Drive" \
     --only-ids data/google-exports/referenced-ids.json --by-id-dir /var/tmp/drive-copy/by-id
   node tools/import-drive-tree.js --listing data/google-exports/trees/shared.lsjson \
     --dir /var/tmp/drive-copy/shared --root-id shared-root --root-name "Shared with me" \
     --only-ids data/google-exports/referenced-ids.json --by-id-dir /var/tmp/drive-copy/by-id
   ```
   The root id is a made-up id for the top of each tree (`mydrive-root` for the account's My Drive,
   `shared-root` for the shared one); the top-level entries become its children. Every file and
   folder keeps its Google id. The summary shows how many files were imported, how many are
   missing, and how many entries were skipped as not referenced. Running the import again is safe:
   it only adds what was missing.

   Drive lets two files in one folder share a name, but rclone writes by path, so such files cannot
   be copied in step 6. The import does not guess which is which. It writes their ids to
   `missing-ids.txt` in the copy folder and prints the command that fetches them one by one. For
   My Drive it is the loop below (for the shared tree, read
   `/var/tmp/drive-copy/shared/missing-ids.txt` instead). Run it, then run the same import again:
   ```
   while read id; do
     rclone backend copyid gdrive: "$id" /var/tmp/drive-copy/by-id/"$id" --drive-export-formats pdf
   done < /var/tmp/drive-copy/mydrive/missing-ids.txt
   ```
   A `WARN ... folders share this path` line means two folders of one name sit side by side. The
   files are fine, but the folder page may list them under the wrong one of the two.
8. Provide the page images. The pages themselves name a few images by Drive id: the logo, the
   sidebar wordmark, the default avatar, the congratulations banner, the page background and the
   carousel placeholders. The originals belong to a Google account nobody can read from any more
   (they are broken on the live site as well), so they are rebuilt from the academy's own logo
   files in `server/client/site-assets/`:
   ```
   node tools/build-page-assets.js
   node tools/import-code-assets.js
   ```
   The first writes the logo mark, wordmark, avatar and banner as `<id>.png` into
   `data/google-exports/code-assets/`; the second registers every image found there as a public
   file under its id (type sniffed from the bytes; anything that is not an image or a PDF is
   skipped with a `skip` line, `--dry-run` shows what would be registered). The background pattern
   and the three carousel placeholders are left absent on purpose: the carousel is filled from the
   announcements sheet, and the background falls back to the page colour, as on the live site.
   `node tools/import-code-assets.js --list` prints every id the pages use (writing
   `code-assets/ids.tsv`, which step 5 reads) and whether a file for it exists; if an original
   ever becomes readable, save it from a browser as `<id>` or `<id>.<ext>` into the same folder
   and re-run the import. Nothing needs editing in the pages: the server already serves them with
   `/thumb?id=<id>` in place of `drive.google.com/thumbnail?id=`.
9. Point the links in the sheets at this server. Run it with `--dry-run` first; the real run is the
   same command without it:
   ```
   node tools/rewrite-drive-links.js --base-url https://<domain> --dry-run --report /tmp/links.json
   node tools/rewrite-drive-links.js --base-url https://<domain> --report /tmp/links.json
   ```
   **`--base-url` must be the final public URL**, the same address as `BASE_URL` in
   `/etc/basaer.env`. The links are stored in the sheets as full addresses, because the same cells
   are also sent in WhatsApp and e-mail messages. The tool cannot change an address it has already
   written. If you used a wrong one, run step 2 again (it brings the Google links back) and then
   this step with the right one.

   A link to a file becomes `https://<domain>/files/<id>/<name>`, and a link to a folder becomes
   `https://<domain>/files/folder/<id>`; the text around a link is kept. The report lists what
   still points at Google, per sheet and column. `unresolved` is a link whose id is not in the file
   store: add the id to the list (step 5) and repeat steps 6 and 7, or ask the admin to share it.
   `unrecognized` is a `drive.google.com` or `docs.google.com` address of another shape, which the
   tool leaves alone. Read both. Running it again is harmless. It reads rows and writes them back
   whole, so run it only while nobody is editing, which the stopped service guarantees.
10. Import the existing passwords. The admin runs `firebase auth:export` for the Firebase project
    (to a file ending in `.json`) and copies the "Password hash parameters" block from the Firebase
    console (Authentication, Users) into a text file. Put both in `data/` and run:
    ```
    node tools/import-firebase-users.js --users data/firebase-users.json \
      --hash-params data/firebase-hash-params.txt --dry-run
    node tools/import-firebase-users.js --users data/firebase-users.json \
      --hash-params data/firebase-hash-params.txt --mark-verified
    ```
    `--mark-verified` also sets `emailVerified = true` in the `students` and `emp` sheets for every
    account Firebase had verified. Firebase was the authority for that flag and the sheets did not
    always follow; the page signs out any account whose cell is not true on every load, so without
    this those users are logged out at each refresh until they sign in once with a code.
    It prints counts only, never hashes. Imported accounts keep their Firebase hash until their
    first login, and are then re-hashed locally. Accounts with no password hash (Google-only
    accounts, for example) or no email are skipped, and an account that already has a local
    password is left as it is, so running it again is safe. Without the export, users sign in once
    with an emailed code and set a new password.
11. Check the result, then start the service:
    ```
    node tools/export-xlsx.js --dir /tmp/verify --db /var/lib/basaer/basaer.sqlite
    node tools/check-headers.js
    exit
    sudo systemctl start basaer
    ```
    `export-xlsx.js` writes the sheets back out and prints the row count of each: compare them with
    the workbooks that `pull` fetched into `data/google-exports/` (or with the Google Sheets
    themselves). `check-headers.js` repeats the header check. After `exit` you are back in your own
    shell and can start the service. Then open the app, sign in with a real account, open one
    student's folder link and one ID-card link from a sheet row, and render one certificate (the
    first PDF is slow, section 9).
12. When you are satisfied, delete what you no longer need. It holds personal data and password
    hashes, and the rclone token can read the whole Drive of that account:
    ```
    cd /opt/basaer/app
    sudo rm -rf data/google-exports data/firebase-users.json data/firebase-hash-params.txt \
      /var/tmp/drive-copy /tmp/links.json /tmp/verify
    sudo -u basaer -H rclone config delete gdrive
    ```
    Then remove the access in the Google account itself (myaccount.google.com, Security,
    Third-party access).

No rclone? The sheets alone can be loaded from workbooks you export by hand from Google Sheets
(File, Download, Microsoft Excel), named `mainData.xlsx`, `attendanceData.xlsx`, `answersData.xlsx`,
`dectationData.xlsx`, `refID.xlsx` and `archiveData.xlsx`. This tool needs `--db`:
`TZ=Asia/Qatar node tools/import-xlsx.js --dir <folder> --db /var/lib/basaer/basaer.sqlite`. No
Drive file comes over that way and the links stay pointed at Google, so treat it as a stop-gap.

## 5. Going live

Until this step the server records emails, WhatsApp messages and push notifications and sends nothing.

1. Fill in the SMTP block of `/etc/basaer.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
   `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `OWNER_EMAIL`).
2. Re-enter the WhatsApp (Fonnte / Meta) and FCM push settings the Apps Script kept in Script
   Properties, using the admin screens of the app. Do not copy old secrets from the spreadsheet;
   issue new ones (see the cut-over checklist). Browser push also needs step 5 below.
3. Turn on Google sign-in. Check that `/etc/basaer.env` has `FIREBASE_PROJECT_ID=coming-soon-basaer`
   (the Firebase project the sign-in page signs in with), then restart the service. The journal
   should say `google sign-in: enabled`. The server checks the Google ID token itself and ignores
   any email or `ok` flag the sign-in page sends. With no project id set, "sign in with Google" is
   refused. The page uses Firebase, so `GOOGLE_OAUTH_CLIENT_ID` is not needed.
4. Let Firebase accept the app's domain. The Google sign-in window and the QR scanner window are
   pages of this server, ported from the originals: `https://<domain>/relay/google-signin` and
   `https://<domain>/relay/qr-scan`. Nothing is redeployed on Firebase Hosting any more. The
   sign-in page already posts the Firebase ID token to `/exec` on the same origin, and the server
   refuses (401) a post without a valid one. The QR scanner needs nothing from Firebase. For the
   sign-in page, the admin of the Firebase project `coming-soon-basaer` has to do three things:
   - Add `<domain>` in the Firebase console, under Authentication, Settings, Authorized domains.
     Without it Google sign-in fails with `auth/unauthorized-domain`.
   - If the project's web API key is restricted to certain HTTP referrers (Google Cloud console,
     APIs & Services, Credentials), add `https://<domain>/*` to that list too.
   - Keep `https://basaerbh.com/__/auth/handler` working. The sign-in page still uses `basaerbh.com`
     as its Firebase sign-in domain, so Google sends the user back through that address. Firebase
     Hosting serves it for that domain, so for as long as Google sign-in is wanted, do not point
     `basaerbh.com` at another host. The website no longer needs Firebase Hosting (this server
     serves it, section 2); only this address does. Moving `basaerbh.com` here therefore needs a
     way to keep it answering first, which this runbook does not cover yet.

   Until this is done, "sign in with Google" fails and users sign in with the emailed code or
   their password.
5. Browser push (FCM) registration is not available. The platform page is served by this server at
   `/platform` (section 2), but without its "تفعيل إشعارات المتابعة" button, the dialog behind it
   and the Firebase scripts: they registered the device with Firebase Cloud Messaging through the
   old Apps Script, and come back only when FCM is replaced by Web Push (section 11). `/exec` with
   `saveFcmToken` still needs a logged-in session (401 otherwise). FCM stays out of scope for
   go-live.
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
3. Load the final data (section 4). The long part, the Drive file copy (steps 4 to 7), can be done
   ahead of the freeze and repeated: it only adds what is missing. After the freeze, run steps 2,
   4 to 7 and 9 again, so that the final sheets, the newest files and the rewritten links all match.
   Step 9 is not optional: freshly imported sheets hold Google links again.
4. Verify counts: export from the new system and compare row counts per sheet with the Google Sheets.
   ```
   sudo -u basaer node tools/export-xlsx.js --dir /tmp/verify --db /var/lib/basaer/basaer.sqlite
   ```
5. Set `FIREBASE_PROJECT_ID=coming-soon-basaer` in `/etc/basaer.env`, restart, and check that the
   journal says `google sign-in: enabled`.
6. Test the two relay pages. This server now serves them (`/relay/google-signin` and
   `/relay/qr-scan`), so nothing is redeployed on Firebase Hosting. The admin must have done
   section 5, step 4 first: the domain under Authorized domains, and `basaerbh.com/__/auth/handler`
   still answering. Sign in with Google using an account whose email is on file, and scan one QR
   code.
7. Leave push notifications out of the announcement: `/platform` is served by this server, but
   without its push button until FCM is replaced by Web Push (section 5, step 5).
8. Switch on `OUTBOUND_MODE=live` (section 5) once step 4 looks right.
9. Announce the new URL to staff, students and parents: `https://<domain>/platform` opens the app
   (section 2).
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
  `disabled` means neither `FIREBASE_PROJECT_ID` nor `GOOGLE_OAUTH_CLIENT_ID` is set (the sign-in
  page's post gets 503). If it says `enabled`, read the diagnostic log at the bottom of the
  sign-in window (it is in Arabic and shows the Firebase error code). `auth/unauthorized-domain`
  means the app's domain is missing from Authorized domains in Firebase. If the window goes to
  Google and never comes back, check that `https://basaerbh.com/__/auth/handler` still answers. A
  refusal from the server (401) means the ID token comes from another Firebase project than
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

## 11. What still touches Google after migration

Once section 4 is done and the cut-over is over, the app does not depend on a Google account for
its data. What still reaches Google, honestly:

- **Nothing for data, files, sending e-mail or QR codes.** The sheets are in the database, the
  Drive files are in `/var/lib/basaer/files` under their old ids, mail leaves through the SMTP
  server you set in `/etc/basaer.env` (pointing `SMTP_HOST` at a Google mail server would be your
  own choice of provider, not something the app needs), and QR codes are drawn on this server.
  Fonts and the old site's assets are served from this server, and so is the public website
  (section 2), without its Google Analytics.
- **The "sign in with Google" button, which is optional.** Firebase Authentication is used as the
  identity provider only. The sign-in window loads the Firebase script from Google, the user signs
  in at Google and comes back through `https://basaerbh.com/__/auth/handler`, and the server checks
  the token it gets, fetching Google's public signing keys to do so. The window deletes the
  temporary Firebase user it creates as soon as it has the email address; passwords and accounts
  live in this server's database. Without `FIREBASE_PROJECT_ID` the button is refused, and the
  emailed code and the password keep working (section 5, step 3).
- **Push notifications, if you ever turn them on.** They go through Google's Firebase Cloud
  Messaging. They are out of scope for go-live (section 5, step 5). Push notifications (the
  platform page's تفعيل إشعارات المتابعة button) are not available until FCM is replaced by Web
  Push: the button, its dialog and the Firebase scripts were taken out of `/platform`, so no new
  device can register.
- **The fatawa panel on the website's home page** used to load its fatawa from a public Google
  Sheet (the `fatawa` sheet of the basaer-REF workbook, through a `docs.google.com/.../gviz`
  `<script>` run by the visitor's browser). It now reads `server/client/site/assets/data/fatawa.json`,
  a snapshot of that sheet's rows (`title`, `question`, `answer`, `category`) taken on 2026-10-21;
  edit that file to change the fatawa (the sheet is no longer consulted). When the file cannot be
  loaded the panel shows the three sample fatawa built into the script. The website also uses
  three services that are not Google: `cdn.jsdelivr.net` (icon fonts, as the app does),
  `api.aladhan.com` (prayer times) and `api.web3forms.com` (the contact form).
- **The area lookup when a student registers.** Typing a block number makes the server ask a
  separate Apps Script web app on `script.google.com` for the area name (`lookupBlockArea` in
  `gas/dataGet.js`). That script is not part of this repository and is not migrated. The server
  calls it only with `OUTBOUND_MODE=live`, and if it is ever switched off the area field stays
  empty.
- **Mail programs.** The HTML e-mails link a Google Fonts stylesheet (`gas/emailTemplates.js`),
  which some mail programs fetch when a message is opened. The server does not.
