# Basaer deployment runbook

For the operator. The short version, once you have read this file, is `docs/DEPLOY-QUICK.md`.

## How to read this runbook

Every command block starts with a comment line that says where it runs and as whom:

- `# on your PC, in WSL`: the development PC, in a WSL (Linux) terminal.
- `# on the server, as ubuntu (ssh)`: logged in with `ssh -i <key.pem> ubuntu@<ip>`. Commands
  that need root carry `sudo`; commands that must run as the service user carry `sudo -u basaer`.
- `# on the server, as basaer (the shell from section 4)`: the service user's shell that
  section 4 opens. Only section 4 uses it.
- `# AWS console`, `# Squarespace`: a web console, no shell.

Every block starts with the `cd` it needs. No block relies on the directory, machine or user of
the block before it. Each step says what it needs from earlier steps (**Needs:**) and how to see
that it worked (**Check:**).

Placeholders. Replace them everywhere with the same value:

| Placeholder | What it is |
|---|---|
| `<ip>` | The instance's Elastic IP (section 1, step 3). |
| `<domain>` | The public name the server answers at: `basaerbh.com` at go-live, or a temporary name while you test (section 2, "Changing the domain"). |
| `<temp-domain>` | The temporary name, if you test under one first. |
| `<key.pem>` | The path, in WSL, of the instance's SSH private key, for example `~/.ssh/basaer.pem`. |
| `<email>` | Your e-mail address. Let's Encrypt sends certificate expiry notices to it. |
| `<repo>` | The repository on your PC, as WSL sees it, for example `/mnt/c/Users/igopaah/Claude/Basaer`. |
| `<stamp>` | The date and time in a backup file name, `YYYYMMDD-HHMM` (section 6). |

Paths on the server:

- the app: `/opt/basaer/app` (on the 8 GB root volume);
- the data: `/var/lib/basaer` (the 30 GB data volume): database `basaer.sqlite`, file store
  `files/`, signing keys `keys/`;
- the local backups: `/var/lib/basaer/backups`;
- the config: `/etc/basaer.env`;
- the nginx site: `/etc/nginx/sites-available/basaer`.

Before you start, put the SSH key where ssh accepts it. ssh refuses a key that other users can
read, and every file under `/mnt/c` looks readable to everyone:

```
# on your PC, in WSL
mkdir -p ~/.ssh
cp /mnt/c/<path to the downloaded key>.pem ~/.ssh/basaer.pem
chmod 600 ~/.ssh/basaer.pem
```

Check (after section 1): `ssh -i <key.pem> ubuntu@<ip> true` returns without an error.

## 1. Prerequisites

All of this section is done in the AWS console and at Squarespace, except the checks.

1. Create the EC2 instance.
   ```
   # AWS console → EC2 → Launch instance
   ```
   - Type t3.small. Image Ubuntu 26.04 LTS (the release the port was developed and tested on;
     24.04 works too).
   - Two volumes, both gp3:
     - the root volume, **8 GB**. It holds the operating system (~3 GB), LibreOffice (~1 GB), the
       app and the logs. The logs are capped (journal 200 MB, nginx logs rotated). Nothing on it
       needs a backup: all of it can be rebuilt.
     - the data volume, **30 GB**. Add it on the launch page under "Configure storage" → "Add new
       volume". Give it the tag `Name=basaer-data`: the snapshot policy in section 6 finds it by
       that tag. It is mounted at `/var/lib/basaer` in section 2, step 2, and holds the database
       (30 MB), the file store (15 GB, ~6,000 files, at 2026-10) and the signing keys.

   The data has its own volume so that it can be resized, snapshotted and attached to a
   replacement instance on its own.

   **Growing the data volume.** The file store grows by about 10 GB a year, mostly audio and
   video lectures, so 30 GB is a year of headroom. When `df -h /var/lib/basaer` shows more than
   80 % used, grow it. Both steps are online, with no downtime:
   ```
   # AWS console → EC2 → Volumes → select basaer-data → Modify → new size
   ```
   ```
   # on the server, as ubuntu (ssh)
   cd /
   lsblk -o NAME,SIZE,MOUNTPOINTS           # the data disk shows the new size, mounted at /var/lib/basaer
   sudo resize2fs /dev/nvme1n1              # use the device name lsblk shows for /var/lib/basaer
   df -h /var/lib/basaer
   ```
   Check: `df -h /var/lib/basaer` shows the new size.

   Turn on the daily snapshot of the data volume (section 6) once the instance exists.
2. Set the security group's inbound rules: 22 from your IP only; 80 and 443 from anywhere. Do not
   open 3000.
   ```
   # AWS console → EC2 → Security groups
   ```
3. Allocate an Elastic IP and associate it with the instance. This is `<ip>`.
   ```
   # AWS console → EC2 → Elastic IPs → Allocate → Associate
   ```
   Check:
   ```
   # on your PC, in WSL
   cd ~
   ssh -i <key.pem> ubuntu@<ip> true && echo ssh ok
   ```
   Expected: `ssh ok`.
4. Point the domain at the Elastic IP. **Needs:** `<ip>` (step 3).
   ```
   # Squarespace: account.squarespace.com → Domains → basaerbh.com → DNS
   ```
   - Set the A record `@` (the apex `basaerbh.com`) to `<ip>`. Today it is Firebase Hosting's
     `199.36.158.100`.
   - Add a CNAME `www` → `basaerbh.com`. There is no `www` record today.

   This server also serves the public website, so the apex domain moves here, not a separate
   `app.` name. The DNS is at Squarespace Domains (the former Google Domains; name servers
   `nse1-4.squarespacedns.com`). Keep the MX record (`smtp.google.com`) and the
   `google-site-verification` TXT: they are the domain's e-mail. The
   `hosting-site=coming-soon-basaer` TXT belongs to Firebase Hosting and can go.

   Read section 5, step 4 before you move `basaerbh.com`: it ends Google sign-in.

   Check:
   ```
   # on your PC, in WSL
   cd ~
   dig +short basaerbh.com
   dig +short www.basaerbh.com
   ```
   Expected: the first prints `<ip>`; the second prints `basaerbh.com.` and `<ip>`. certbot
   (section 2, step 4) cannot issue the certificate until this is true.

## 2. Install

**Needs:** section 1 (the instance with both volumes, the security group, the Elastic IP).

1. Push the code, then clone it on the server. The server clones from GitHub, so push your
   commits first:
   ```
   # on your PC, in WSL
   cd <repo>
   git push origin master
   git status -sb
   ```
   Check: the first line of `git status -sb` is `## master...origin/master` with no `[ahead …]`.

   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo mkdir -p /opt/basaer
   sudo git clone https://github.com/AlmiqdadAlbanki/basaer.git /opt/basaer/app
   ```
   The repository is `https://github.com/AlmiqdadAlbanki/basaer.git` and stays private, so git asks
   for your GitHub user name and an access token.

   Check: `ls /opt/basaer/app/deploy/install.sh` prints the path.
2. Mount the data volume at `/var/lib/basaer`, then run the bootstrap. **Needs:** step 1.

   The mount comes first, so that the directories the bootstrap creates land on the data volume.
   Find the device: it is the 30 GB disk with no file system and no mount point, usually
   `nvme1n1`:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS
   ```
   Format it once, record it in `/etc/fstab` by its label (so it comes back after a reboot), and
   mount it:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo mkfs.ext4 -L basaer-data /dev/nvme1n1        # ONCE, on the new empty volume only
   sudo mkdir -p /var/lib/basaer
   echo "LABEL=basaer-data /var/lib/basaer ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
   sudo mount -a && df -h /var/lib/basaer
   ```
   `mkfs.ext4` erases the disk. Run it only on the new, empty volume, and never on a volume made
   from a snapshot (section 6).

   Check: `df -h /var/lib/basaer` shows a size of about 29G, mounted on `/var/lib/basaer`. If it
   shows `/` and 8G, the mount failed: do not continue.

   Run the bootstrap. It installs the packages, Node 22, nginx and certbot, creates the `basaer`
   user and the data directories, installs the systemd units and the backup timer, caps the
   journal, installs `/etc/basaer.env` and the nginx site, and starts the service:
   ```
   # on the server, as ubuntu (ssh)
   cd /opt/basaer/app
   sudo bash deploy/install.sh
   ```
   It is safe to run again. If it prints `NOTE: /opt/basaer/app not found`, the clone (step 1) is
   missing: clone, then run it again, so that `npm ci` runs.

   Check:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   systemctl is-active basaer nginx
   ls -ld /var/lib/basaer/files /var/lib/basaer/keys /var/lib/basaer/backups
   ```
   Expected: `active` twice; the three directories owned by `basaer basaer`. The script ended with
   `Install finished. Next steps:`.
3. Set `BASE_URL` in the config. **Needs:** step 2 (it created `/etc/basaer.env`).
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo nano /etc/basaer.env
   sudo systemctl restart basaer
   ```
   Set `BASE_URL=https://<domain>`. It must be the final public address: section 4 writes it into
   the links in the sheets. The other settings are listed under "Settings in /etc/basaer.env"
   below.

   Check:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo grep '^BASE_URL=' /etc/basaer.env
   journalctl -u basaer -n 20 --no-pager | grep listening
   ```
   Expected: `BASE_URL=https://<domain>` and `Basaer server listening on https://<domain>`.
4. Set the domain in nginx and get the HTTPS certificate. **Needs:** step 2, and DNS pointing at
   `<ip>` (section 1, step 4).

   `server_name` in `/etc/nginx/sites-available/basaer` is already
   `basaerbh.com www.basaerbh.com`. Edit it only for another domain:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo nano /etc/nginx/sites-available/basaer
   sudo nginx -t && sudo systemctl reload nginx
   dig +short basaerbh.com
   sudo certbot --nginx -d basaerbh.com -d www.basaerbh.com --redirect -m <email> --agree-tos
   ```
   Run certbot only when `dig` prints `<ip>`. certbot obtains the certificate for both names, adds
   the 443 block and the HTTP to HTTPS redirect, and installs a timer that renews it.

   Check:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   systemctl list-timers | grep certbot
   curl -sI http://basaerbh.com/healthz | head -n 1
   ```
   Expected: one certbot timer line; `HTTP/1.1 301 Moved Permanently`.

   After HTTPS works you may enable HSTS (see the comment in the site file).

   **Testing without a domain.** Set `server_name _;` in the site file, skip certbot, use plain
   HTTP, and set `BASE_URL=http://<ip>` in `/etc/basaer.env`. Logins do not stick over plain HTTP
   while `NODE_ENV=production`: the session cookie is marked Secure, so the browser drops it. For a
   short test only, set `NODE_ENV=development`. This also turns on the admin-only `/dev/*` pages
   and shows raw error text. Set it back to `production` before real use.
5. Check the service. **Needs:** steps 3 and 4.
   ```
   # on the server, as ubuntu (ssh)
   cd /
   curl -s https://<domain>/healthz
   journalctl -u basaer -n 20 --no-pager
   ```
   Expected from `curl` (the counter values vary):
   `{"ok":true,"mode":"dry-run","rpc":{"size":1,"busy":0,"queued":0},"background":{"size":1,"busy":0,"queued":0},"readCache":{"enabled":true,"entries":0,"bytes":0,"hits":0,"misses":0,"coalesced":0,"notModified":0,"evicted":0}}`.
   The journal shows the start-up lines, including `workers:  1 rpc + 1 background` and
   `google sign-in: enabled` (the example config sets `FIREBASE_PROJECT_ID`) or `disabled`.

### Changing the domain (testing under a temporary domain first)

You may test under `<temp-domain>` first and move to the real domain later. The domain lives in
three places only. Change all three:

1. nginx: `server_name` in `/etc/nginx/sites-available/basaer`, and the certificate. **Needs:** the
   real domain's DNS pointing at `<ip>` (section 1, step 4).
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo nano /etc/nginx/sites-available/basaer          # server_name basaerbh.com www.basaerbh.com;
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d basaerbh.com -d www.basaerbh.com --redirect -m <email> --agree-tos
   sudo certbot delete --cert-name <temp-domain>
   ```
   Check: `sudo certbot certificates` lists the new names only.
2. `BASE_URL` in `/etc/basaer.env`:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo nano /etc/basaer.env                            # BASE_URL=https://basaerbh.com
   sudo systemctl restart basaer
   ```
   Check: `journalctl -u basaer -n 20 --no-pager | grep listening` shows the new address.
3. The links already stored in the sheets. Every link this server wrote under `<temp-domain>`
   (links rewritten in section 4, certificates and cards it generated, uploads) carries that
   domain. Re-point them in one run, with the service stopped:
   ```
   # on the server, as ubuntu (ssh)
   cd /opt/basaer/app
   sudo systemctl stop basaer
   sudo -u basaer node tools/rewrite-drive-links.js --db /var/lib/basaer/basaer.sqlite --base-url https://basaerbh.com --rebase-from https://<temp-domain> --dry-run
   sudo -u basaer node tools/rewrite-drive-links.js --db /var/lib/basaer/basaer.sqlite --base-url https://basaerbh.com --rebase-from https://<temp-domain>
   sudo systemctl start basaer
   ```
   Always pass `--db`: without it the tool opens `/opt/basaer/app/data/basaer.sqlite`, not the
   live database. The service is stopped because the tool reads rows and writes them back whole.

   Check: run the `--dry-run` line again. It prints `links re-pointed:   0`.

The same command with `--rebase-from http://localhost:3000` fixes the links in a database copied
from the development PC (section 4, "Copy from the PC").

Logins belong to the host (the session cookie is per domain), so everyone signs in once again on
the new address. Nothing else is tied to the name.

### What the server answers

The academy's public website, which used to be on Firebase Hosting, is served from here too, at
the addresses it had there:

- `/` is the home page and `/student-guide` the student guide (`/student-guide.pdf` its PDF).
  `/assets/...`, `/favicon.ico`, `/robots.txt` and `/sitemap.xml` are the website's files, kept in
  `server/client/site/`. The old names `/index.html`, `/platform.html` and `/student-guide.html`
  redirect to the addresses without `.html`.
- `/platform` is the address to give people: the header bar with the logo, and the app below it in
  a frame. Its query string is passed on to the app (`/platform?logout=1` opens `/app?logout=1`).
  The open view shows in its address: the app reports its view to the page, which shows it as
  `/platform/p/<view>`, and that address frames `/app/p/<view>` again on a refresh or from a
  bookmark.
- `/app` is the app itself, the address of the frame inside `/platform`. It keeps the open view as
  `/app/p/<view>` (the older `/p/<view>` addresses redirect there). Opened directly in a tab, it
  redirects to the same view under `/platform`, so the header bar is always there.
- `/relay/...`, `/api/...`, `/exec`, `/files/...`, `/thumb`, `/doc/...`, `/partials/...`,
  `/fonts/...` and `/site-assets/...` are used by the app. `/healthz` is the check in step 5.

The website's pages give `https://basaerbh.com/` as their address (to search engines and link
previews), so they belong on that domain. They work the same under another name such as
`app.basaerbh.com`.

### Where the data lives

All writable state (database, keys, uploaded files and generated documents) lives under
`/var/lib/basaer`, set by `BASAER_DB`, `BASAER_KEYS` and `BASAER_FILES` in `/etc/basaer.env`. The
app directory is read-only to the service.

### Settings in /etc/basaer.env

Each setting has a safe default and a comment in `deploy/basaer.env.example`. Restart the service
after changing any of them:

```
# on the server, as ubuntu (ssh)
cd /
sudo nano /etc/basaer.env
sudo systemctl restart basaer
```

- `BASE_URL`: the public address (step 3, and "Changing the domain").
- `OUTBOUND_MODE` (default `dry-run`): `dry-run` records e-mails, WhatsApp messages and push
  notifications and sends nothing; `live` sends them. It stays `dry-run` until SMTP and WhatsApp
  are set (section 5).
- `BASAER_RPC_WORKERS` (default `1`): how many worker threads run interactive calls. Keep it at 1.
  Read section 10 before changing it.
- `RPC_READ_CACHE_TTL_MS` (default `60000`; `0` turns the cache off) and `RPC_READ_CACHE_MAX_MB`
  (default `32`): the shared cache of read-only calls (section 10).
- `SESSION_TTL_DAYS` (default `7`): how long a login lasts without use. Every visit renews it, up to
  an absolute limit of 30 days. After that the user signs in again.
- `FIREBASE_PROJECT_ID` (the example file sets `coming-soon-basaer`) and/or
  `GOOGLE_OAUTH_CLIENT_ID`: turn on the server-side check of Google sign-in tokens. With neither
  set, "sign in with Google" is refused. See section 5.
- `ALLOW_CPR_ONLY_LOGIN` (default off; only the value `1` turns it on): brings back "log in with the
  CPR alone, skip email verification". **Warning:** while it is on, anyone who knows or guesses a
  CPR can log in as that person, staff and administrators included, and CPRs are not secret. Leave
  it off. The server prints a WARNING line at start-up when it is on.
- `TRUST_PROXY` (default `loopback`): the app takes the client's address from nginx's
  `X-Forwarded-For` header, and only when the request comes from this machine. The rate limits
  depend on it. Change it only if the proxy runs on another host.

### How sign-in works (for testing and support)

A successful login sets an httpOnly cookie `basaer_session` (SameSite=Lax, Secure in production)
and gives the page a 15-minute access token that it keeps in memory only. The browser stores no
token in localStorage, only a non-secret `basaer_user` hint. Logout revokes the session on the
server, so a copied cookie stops working too. A POST that relies on the cookie must send the header
`X-Requested-With: basaer` (the app does). Without it the request counts as not logged in, which
matters when you test with `curl`. The keys in `BASAER_KEYS` sign everything, so losing them logs
every user out.

## 3. First run with demo data

**Needs:** section 2. Optional: skip this section if you load the real data straight away.

```
# on the server, as ubuntu (ssh)
cd /opt/basaer/app
sudo -u basaer BASAER_DB=/var/lib/basaer/basaer.sqlite node tools/seed.js
sudo -u basaer BASAER_DB=/var/lib/basaer/basaer.sqlite BASAER_FILES=/var/lib/basaer/files node tools/make-demo-templates.js
sudo systemctl restart basaer
```

Check: `seed.js` prints `Seeded database at /var/lib/basaer/basaer.sqlite` and the demo logins
(CPRs with the demo password `Test@1234`). Sign in with one at `https://<domain>/platform`.

Do not leave demo data in a system that will hold real data. Remove the demo database before
section 4:

```
# on the server, as ubuntu (ssh)
cd /
sudo systemctl stop basaer
sudo rm -f /var/lib/basaer/basaer.sqlite*
```

Check: `ls /var/lib/basaer` shows no `basaer.sqlite` file.

## 4. Loading the real data

The aim is that nothing is left on Google. Two things come over: the spreadsheets, and every Drive
file they link to (student folders, certificates, ID cards, course material). The files keep their
original Google ids, and the links stored in the sheets are then rewritten to this server's own
addresses. Access to Google is read-only, so nothing is ever written to it.

There are two ways:

- **Copy from the PC** (below). The import was already done on the development PC:
  `data/basaer.sqlite` (30 MB) and `data/files/` (16 GB). Copying that result is simpler than
  repeating the Google pull on the server. Use this way now.
- **The Google pull on the server** (steps 1 to 12). The cut-over (section 8, step 3) runs parts of
  it again for the final refresh.

### Copy from the PC

**Needs:** section 2 done: the data volume mounted at `/var/lib/basaer` (step 2), the bootstrap
run (step 2), and `BASE_URL` set (step 3).

Ship the data straight onto the data volume. Never stage it under `/tmp` on the server: `/tmp` is
on the 8 GB root volume, and 16 GB does not fit there.

1. Stop the service and prepare the destination:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo systemctl stop basaer
   df -h /var/lib/basaer
   sudo rm -f /var/lib/basaer/basaer.sqlite-wal /var/lib/basaer/basaer.sqlite-shm
   ```
   Check: `df -h /var/lib/basaer` shows the ~29G data volume, not the 8G root (`/`). If it shows
   `/`, stop: go back to section 2, step 2. The old `-wal` and `-shm` files are removed so that
   they cannot be applied to the database you copy in.
2. Copy the file store. 16 GB over a home connection takes hours, so run it inside `tmux` or
   `screen`:
   ```
   # on your PC, in WSL
   cd <repo>
   rsync -av --partial --info=progress2 --rsync-path="sudo rsync" -e "ssh -i <key.pem>" data/files/ ubuntu@<ip>:/var/lib/basaer/files/
   ```
   `--rsync-path="sudo rsync"` writes as root, straight into the data volume. If the connection
   drops, run the same command again: it resumes. Run it again later to top the copy up: it sends
   only what changed.

   Check: run the same command again. It lists no file names.
3. Copy the database, as a **consistent copy**, not the bare file. A running development server
   keeps recent changes in `basaer.sqlite-wal`, so a plain copy of `basaer.sqlite` can miss them or
   be torn:
   ```
   # on your PC, in WSL
   cd <repo>
   node -e "new (require('./server/storage.js').Storage)('data/basaer.sqlite').db.backup('/tmp/basaer-copy.sqlite').then(() => console.log('copy ready'))"
   rsync -av --rsync-path="sudo rsync" -e "ssh -i <key.pem>" /tmp/basaer-copy.sqlite ubuntu@<ip>:/var/lib/basaer/basaer.sqlite
   ```
   This `/tmp` is on your PC, not on the server.

   Check: `node` prints `copy ready`; `rsync` ends without an error.
4. Hand the data to the service user, re-point the links, and start the service. The copied
   sheets still say `http://localhost:3000`, the address the development PC used:
   ```
   # on the server, as ubuntu (ssh)
   cd /opt/basaer/app
   sudo chown -R basaer:basaer /var/lib/basaer
   sudo -u basaer node tools/rewrite-drive-links.js --base-url https://<domain> --rebase-from http://localhost:3000 --db /var/lib/basaer/basaer.sqlite
   sudo systemctl start basaer
   ```
   `--base-url` must equal `BASE_URL` in `/etc/basaer.env` (section 2, step 3). The rewrite runs
   before the start, while nobody can edit.

   Check:
   ```
   # on the server, as ubuntu (ssh)
   cd /opt/basaer/app
   sudo -u basaer node tools/rewrite-drive-links.js --base-url https://<domain> --rebase-from http://localhost:3000 --db /var/lib/basaer/basaer.sqlite --dry-run
   curl -s https://<domain>/healthz
   ```
   Expected: `links re-pointed:   0`; `/healthz` answers `{"ok":true,...}`. Then do the checks of
   step 11 in the browser (sign in, open a folder link, an ID card, a certificate).

The database copy still holds the test admin `191919191`. It is removed at cut-over (section 8,
step 3).

### The Google pull on the server

Run steps 1 to 11 on the server, in `/opt/basaer/app`, as the `basaer` user, so that the database
and the files end up owned by the service. The service stays stopped while you work.

**Needs:** section 2. If section 3 was run, its demo database is removed (end of section 3).

**Disk space.** `data/google-exports/` (in `/opt/basaer/app`) and `/var/tmp/drive-copy` (step 6)
are on the 8 GB root volume, and for a while every copied file exists twice: once in the working
copy and once in the file store. The full set of referenced files is ~16 GB, which does not fit on
the root volume. Check before steps 2 and 6:

```
# on the server, as ubuntu (ssh)
cd /
df -h / /var/tmp /var/lib/basaer
```

Install rclone first. It needs root, so do it as ubuntu, before you open the `basaer` shell;
`deploy/install.sh` does not install it. Follow rclone.org/install:

```
# on the server, as ubuntu (ssh)
cd /
sudo -v ; curl https://rclone.org/install.sh | sudo bash
rclone version
```

Check: `rclone version` prints a version.

Open the `basaer` shell. Copying takes hours, so start `tmux` (or `screen`) first: a dropped SSH
connection then does not stop it. The tools read `BASAER_DB` and `BASAER_FILES`, so set them once
here instead of adding `--db` and `--files-dir` to every command (a flag still overrides them):

```
# on the server, as ubuntu (ssh)
cd /
tmux
sudo systemctl stop basaer
sudo -u basaer -H bash
cd /opt/basaer/app
export BASAER_DB=/var/lib/basaer/basaer.sqlite BASAER_FILES=/var/lib/basaer/files
```

Check: `whoami` prints `basaer`; `echo $BASAER_DB` prints `/var/lib/basaer/basaer.sqlite`.

Steps 1 to 11 are typed in that shell. If you lose it, open it again with the block above.

1. Give the server read-only access to Drive. This is done once.
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   bash tools/google-exports.sh setup
   ```
   `setup` creates the rclone remote `gdrive` with the read-only scope `drive.readonly`. Sign in
   with the Google account the admin shared the files with. The server has no browser, so get the
   token on a machine that has a browser and rclone:
   ```
   # on your PC (any machine with a browser and rclone)
   rclone authorize "drive" "" "" --drive-scope drive.readonly
   ```
   Sign in, and copy the token it prints. Then, on the server, paste it when rclone asks for the
   result of `rclone authorize`:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   rclone config reconnect gdrive:
   rclone lsd gdrive:
   ```
   On a machine with a browser, `rclone config reconnect gdrive:` alone is enough.

   Check: `rclone lsd gdrive:` lists the account's top-level folders.
2. Pull the sheets, the templates and the folders the code names, and import them. **Needs:**
   step 1.
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   bash tools/google-exports.sh pull
   TZ=Asia/Qatar node tools/import-google-exports.js
   ```
   `pull` fetches six workbooks (.xlsx), five templates (.docx) and the seven folders named in the
   code into `data/google-exports/`, and prints one line per item. An item the admin has not shared
   with the account shows `ACCESS DENIED (not shared with you)`. That is reported, not fatal: ask
   the admin to share it and run `pull` again, which is safe to repeat.

   The import loads the sheets, registers the templates under their legacy Drive ids, imports the
   seven folders (whole) with their original folder and file ids, and ends with a header check.
   Read every `WARN` line it prints.

   Keep `TZ=Asia/Qatar`: it keeps dates in their local time. (The importer converts the
   spreadsheets' date numbers itself, because the xlsx library's own conversion came out 8 seconds
   early and moved every date-only cell to the previous day.)

   Check: the import ends with `Header check: all expected headers present, in order`.

   **Warning:** the import replaces every sheet it loads. Do not run it again once people use the
   new system. If you run it again before then, run step 9 again afterwards (the workbooks hold
   Google links), and step 10 with `--mark-verified` (it writes into the `students` and `emp`
   sheets that the import has just replaced).
3. Find the greeting-card templates, and register any other templates. **Needs:** step 2.

   The greeting templates (Slides) are not named in the code. Their ids are in the `refID`
   workbook, which step 2 put in the database, so a second pass finds them, fetches them and
   imports again:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   bash tools/google-exports.sh discover
   bash tools/google-exports.sh pull
   TZ=Asia/Qatar node tools/import-google-exports.js
   ```
   Check: `discover` adds them to `tools/google-files.json` and prints one line for each; the
   import ends with the header check line of step 2.

   Register any other template id used in the Certificates and stages sheets by hand, from a copy
   of the file:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   node tools/register-template.js --id <legacyDriveId> --file <path.docx|.pptx> --name "<name>"
   ```
4. List the two Drive trees the other referenced files live in: the account's My Drive, and the
   folders shared with it. **Needs:** step 1.

   **Never run two rclone jobs at once** (this includes `pull` and the copy in step 6): they
   compete for the same rate limit. Run the two listings one after the other. The three throttling
   flags are there because a plain run against a large tree died with `rateLimitExceeded`.
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   mkdir -p data/google-exports/trees
   rclone lsjson -R --drive-export-formats pdf \
     --tpslimit 4 --retries 20 --low-level-retries 40 \
     gdrive: > data/google-exports/trees/mydrive.lsjson
   rclone lsjson -R --drive-shared-with-me --drive-export-formats pdf \
     --tpslimit 4 --retries 20 --low-level-retries 40 \
     gdrive: > data/google-exports/trees/shared.lsjson
   ```
   A big Drive takes a long time. If rclone stops with an error, delete the half-written file and
   run that listing again: the importer refuses a listing that is not complete JSON.

   Check:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   python3 -m json.tool data/google-exports/trees/mydrive.lsjson > /dev/null && echo mydrive ok
   python3 -m json.tool data/google-exports/trees/shared.lsjson > /dev/null && echo shared ok
   ```
   Expected: `mydrive ok` and `shared ok`.
5. Make the list of ids to bring over. **Needs:** step 2 (the sheets in the database).

   The list is a JSON array of Google ids in a file, `data/google-exports/referenced-ids.json`:
   ```
   ["1AbCdEf...", "1GhIjKl..."]
   ```
   It must hold every Google id that appears in any cell of any sheet, whether inside a link or on
   its own, and every id written into the pages (the logo, the default avatar and the carousel
   pictures, and any other id in `gas/*.html` and `gas/*.js`). Only what is on the list comes over,
   and the id of a folder brings everything inside it. Nothing else is copied, because every
   imported file becomes readable by its link.

   The tool that writes it reads every sheet cell for Google links and adds the ids the pages use,
   from `data/google-exports/code-assets/ids.tsv`. It skips that file without a word if it is
   missing, so write it first (the `--list` command of step 8):
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   node tools/import-code-assets.js --list
   node tools/list-referenced-ids.js --out data/google-exports/referenced-ids.json
   ```
   Check: the second command prints `referenced ids: N (X from sheet links, Y from the pages)`, with
   Y above 0.

   A dry run of the link rewriter shows where the Google links are, per sheet and column. It
   changes nothing; the report holds counts and a few sample ids per column:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   node tools/rewrite-drive-links.js --base-url https://<domain> --dry-run --report /tmp/links.json
   ```
6. Copy only what is referenced. **Needs:** steps 4 and 5.

   With `--list-paths` the tool imports nothing: it writes the paths of the referenced files to a
   text file and prints the counts. `--unfound-ids` writes the referenced ids that are not in that
   tree. rclone then copies exactly those paths. Google Docs, Sheets and Slides files come over as
   PDF.

   The copy goes to `/var/tmp/drive-copy`, a native Linux path. (On WSL, never copy under `/mnt/c`:
   thousands of small files are about 10 times slower through the Windows bridge.) **`/var/tmp` is
   on the 8 GB root volume.** The copy needs as much free space as the files it brings over, and the
   full set is ~16 GB. Run `df -h /var/tmp` first; if the files do not fit, do not start the copy.

   My Drive:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   node tools/import-drive-tree.js --listing data/google-exports/trees/mydrive.lsjson \
     --only-ids data/google-exports/referenced-ids.json \
     --list-paths data/google-exports/trees/mydrive-paths.txt \
     --unfound-ids data/google-exports/trees/mydrive-unfound.txt
   rclone copy gdrive: /var/tmp/drive-copy/mydrive \
     --files-from data/google-exports/trees/mydrive-paths.txt --drive-export-formats pdf
   ```
   The tree shared with the account (note the extra flag on the copy):
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
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

   Check: each `-unfound.txt` file lists the referenced ids missing from that one tree. An id that
   is in no tree at all appears in both files:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   comm -12 <(sort data/google-exports/trees/mydrive-unfound.txt) \
            <(sort data/google-exports/trees/shared-unfound.txt)
   ```
   Ask the admin to share those files or folders with the account, then list the trees again
   (step 4) and repeat from step 6. The page images of step 8 are among them.
7. Import the copies. **Needs:** step 6. Add `--dry-run` to a command to see the counts without
   writing anything.
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   node tools/import-drive-tree.js --listing data/google-exports/trees/mydrive.lsjson \
     --dir /var/tmp/drive-copy/mydrive --root-id mydrive-root --root-name "My Drive" \
     --only-ids data/google-exports/referenced-ids.json --by-id-dir /var/tmp/drive-copy/by-id
   node tools/import-drive-tree.js --listing data/google-exports/trees/shared.lsjson \
     --dir /var/tmp/drive-copy/shared --root-id shared-root --root-name "Shared with me" \
     --only-ids data/google-exports/referenced-ids.json --by-id-dir /var/tmp/drive-copy/by-id
   ```
   The root id is a made-up id for the top of each tree (`mydrive-root` for My Drive, `shared-root`
   for the shared tree); the top-level entries become its children. Every file and folder keeps
   its Google id. Running the import again is safe: it only adds what was missing.

   Check: the summary shows how many files were imported, how many are missing, and how many
   entries were skipped as not referenced.

   Drive lets two files in one folder share a name, but rclone writes by path, so step 6 cannot
   copy such files. The import does not guess which is which: it writes their ids to
   `missing-ids.txt` in the copy folder and prints the command that fetches them one by one. For
   My Drive it is the loop below; for the shared tree, read
   `/var/tmp/drive-copy/shared/missing-ids.txt` instead. Run it, then run the same import again:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   while read id; do
     rclone backend copyid gdrive: "$id" /var/tmp/drive-copy/by-id/"$id" --drive-export-formats pdf
   done < /var/tmp/drive-copy/mydrive/missing-ids.txt
   ```
   A `WARN ... folders share this path` line means two folders of one name sit side by side. The
   files are fine, but the folder page may list them under the wrong one of the two.
8. Provide the page images. The pages name a few images by Drive id: the logo, the sidebar
   wordmark, the default avatar, the congratulations banner, the page background and the carousel
   placeholders. The originals belong to a Google account nobody can read from any more (they are
   broken on the live site as well), so they are rebuilt from the academy's own logo files in
   `server/client/site-assets/`:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   node tools/build-page-assets.js
   node tools/import-code-assets.js
   ```
   The first writes the logo mark, wordmark, avatar and banner as `<id>.png` into
   `data/google-exports/code-assets/`. The second registers every image found there as a public
   file under its id (type sniffed from the bytes). Anything that is not an image or a PDF is
   skipped with a `skip` line; `--dry-run` shows what would be registered. The background pattern
   and the three carousel placeholders are left absent on purpose: the carousel is filled from the
   announcements sheet, and the background falls back to the page colour, as on the live site.

   Check: `node tools/import-code-assets.js --list` prints every id the pages use and whether a
   file for it exists. (It also writes `code-assets/ids.tsv`, which step 5 reads.)

   If an original ever becomes readable, save it from a browser as `<id>` or `<id>.<ext>` into the
   same folder and run the import again. Nothing needs editing in the pages: the server already
   serves them with `/thumb?id=<id>` in place of `drive.google.com/thumbnail?id=`.
9. Point the links in the sheets at this server. **Needs:** steps 7 and 8 (the files in the
   store), and `BASE_URL` (section 2, step 3). Run it with `--dry-run` first; the real run is the
   same command without it:
   ```
   # on the server, as basaer (the shell from section 4)
   cd /opt/basaer/app
   node tools/rewrite-drive-links.js --base-url https://<domain> --dry-run --report /tmp/links.json
   node tools/rewrite-drive-links.js --base-url https://<domain> --report /tmp/links.json
   ```
   **`--base-url` must be the final public URL**, the same address as `BASE_URL` in
   `/etc/basaer.env`. The links are stored in the sheets as full addresses, because the same cells
   are also sent in WhatsApp and e-mail messages. To move them to another address later, use
   "Changing the domain" in section 2. To bring the Google links back, run step 2 again, then this
   step.

   A link to a file becomes `https://<domain>/files/<id>/<name>`, and a link to a folder becomes
   `https://<domain>/files/folder/<id>`; the text around a link is kept. It reads rows and writes
   them back whole, so run it only while nobody is editing, which the stopped service guarantees.
   Running it again is harmless.

   Check: the output and the report list what still points at Google, per sheet and column. Read
   both kinds:
   - `unresolved`: a link whose id is not in the file store. Add the id to the list (step 5) and
     repeat steps 6 and 7, or ask the admin to share it.
   - `unrecognized`: a `drive.google.com` or `docs.google.com` address of another shape, which the
     tool leaves alone.
10. Import the existing passwords. **Needs:** step 2 (the `students` and `emp` sheets).

    The admin runs `firebase auth:export` for the Firebase project (to a file ending in `.json`)
    and copies the "Password hash parameters" block from the Firebase console (Authentication,
    Users) into a text file. Put both in `/opt/basaer/app/data/` as `firebase-users.json` and
    `firebase-hash-params.txt`, owned by `basaer`:
    ```
    # on your PC, in WSL
    cd <folder that holds the two files>
    scp -i <key.pem> firebase-users.json firebase-hash-params.txt ubuntu@<ip>:
    ```
    ```
    # on the server, as ubuntu (ssh), in a second ssh session
    cd ~
    sudo mv ~/firebase-users.json ~/firebase-hash-params.txt /opt/basaer/app/data/
    sudo chown basaer:basaer /opt/basaer/app/data/firebase-users.json /opt/basaer/app/data/firebase-hash-params.txt
    ```
    Then import:
    ```
    # on the server, as basaer (the shell from section 4)
    cd /opt/basaer/app
    node tools/import-firebase-users.js --users data/firebase-users.json \
      --hash-params data/firebase-hash-params.txt --dry-run
    node tools/import-firebase-users.js --users data/firebase-users.json \
      --hash-params data/firebase-hash-params.txt --mark-verified
    ```
    It prints counts only, never hashes.

    Check: the real run prints `emailVerified in sheets: marked N, already true M, not in sheets K`.

    `--mark-verified` also sets `emailVerified = true` in the `students` and `emp` sheets for every
    account Firebase had verified. Firebase was the authority for that flag and the sheets did not
    always follow. The page signs out any account whose cell is not true on every load, so without
    this those users are logged out at each refresh until they sign in once with a code.

    Imported accounts keep their Firebase hash until their first login and are then re-hashed
    locally. Accounts with no password hash (Google-only accounts, for example) or no email are
    skipped. An account that already has a local password is left as it is, so running it again is
    safe. Without the export, users sign in once with an emailed code and set a new password.
11. Check the result, then start the service. **Needs:** steps 2 to 10.
    ```
    # on the server, as basaer (the shell from section 4)
    cd /opt/basaer/app
    node tools/export-xlsx.js --dir /tmp/verify --db /var/lib/basaer/basaer.sqlite
    node tools/check-headers.js
    exit
    ```
    `export-xlsx.js` writes the sheets back out and prints the row count of each. Compare them with
    the workbooks that `pull` fetched into `data/google-exports/` (or with the Google Sheets
    themselves). `check-headers.js` repeats the header check. `exit` leaves the `basaer` shell.
    ```
    # on the server, as ubuntu (ssh)
    cd /
    sudo systemctl start basaer
    curl -s https://<domain>/healthz
    ```
    Check: `/healthz` answers `{"ok":true,...}`. Then, in the browser, open
    `https://<domain>/platform`, sign in with a real account, open one student's folder link and
    one ID-card link from a sheet row, and render one certificate (the first PDF is slow,
    section 9).
12. Delete what you no longer need. It holds personal data and password hashes, and the rclone
    token can read the whole Drive of that account. If the cut-over refresh (section 8, step 3) is
    still ahead, do this step after it: the refresh needs the rclone remote and a fresh Firebase
    export.
    ```
    # on the server, as ubuntu (ssh)
    cd /opt/basaer/app
    sudo rm -rf data/google-exports data/firebase-users.json data/firebase-hash-params.txt \
      /var/tmp/drive-copy /tmp/links.json /tmp/verify
    sudo -u basaer -H rclone config delete gdrive
    ```
    Then remove the access in the Google account itself (myaccount.google.com, Security,
    Third-party access).

    Check: `sudo -u basaer -H rclone listremotes` prints nothing.

**No rclone?** The sheets alone can be loaded from workbooks you export by hand from Google Sheets
(File, Download, Microsoft Excel), named `mainData.xlsx`, `attendanceData.xlsx`,
`answersData.xlsx`, `dectationData.xlsx`, `refID.xlsx` and `archiveData.xlsx`. This tool needs
`--db`:

```
# on the server, as basaer (the shell from section 4)
cd /opt/basaer/app
TZ=Asia/Qatar node tools/import-xlsx.js --dir <folder> --db /var/lib/basaer/basaer.sqlite
```

No Drive file comes over that way and the links stay pointed at Google. Treat it as a stop-gap.

## 5. Going live

**Needs:** section 4 (the real data loaded and checked).

Until step 6 the server records e-mails, WhatsApp messages and push notifications and sends
nothing (`OUTBOUND_MODE=dry-run`).

Out of scope at go-live: Google sign-in (steps 3 and 4) and push notifications (step 5). Once
`basaerbh.com` points at this server, Google sign-in fails (step 4, last point), and users sign in
with the emailed code or their password. Steps 3 and 4 are kept for when that is solved.

1. Fill in the SMTP block of `/etc/basaer.env`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
   `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `OWNER_EMAIL`.
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo nano /etc/basaer.env
   sudo systemctl restart basaer
   ```
   Check: `sudo grep '^SMTP_HOST=' /etc/basaer.env` shows your mail server.
2. Re-enter the WhatsApp (Fonnte / Meta) and FCM push settings that the Apps Script kept in Script
   Properties, in the admin screens of the app (`https://<domain>/platform`). Do not copy old
   secrets from the spreadsheet: issue new ones (section 8, step 10). Browser push also needs
   step 5.
3. Turn on Google sign-in (out of scope at go-live, see above; `FIREBASE_PROJECT_ID` is commented
   out in `/etc/basaer.env` by default, so the journal says `google sign-in: disabled`). To bring
   it back, uncomment `FIREBASE_PROJECT_ID=coming-soon-basaer` (the Firebase project the sign-in
   page signs in with), then restart:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo grep '^FIREBASE_PROJECT_ID=' /etc/basaer.env
   sudo systemctl restart basaer
   journalctl -u basaer -n 20 --no-pager | grep 'google sign-in'
   ```
   Check: `google sign-in: enabled`.

   The server checks the Google ID token itself and ignores any email or `ok` flag the sign-in page
   sends. With no project id set, "sign in with Google" is refused. The page uses Firebase, so
   `GOOGLE_OAUTH_CLIENT_ID` is not needed.
4. Let Firebase accept the app's domain (out of scope at go-live, see above). The Google sign-in
   window and the QR scanner window are pages of this server, ported from the originals:
   `https://<domain>/relay/google-signin` and `https://<domain>/relay/qr-scan`. Nothing is
   redeployed on Firebase Hosting any more. The sign-in page posts the Firebase ID token to `/exec`
   on the same origin, and the server refuses (401) a post without a valid one. The QR scanner needs
   nothing from Firebase. For the sign-in page, the admin of the Firebase project
   `coming-soon-basaer` does three things:
   - Add `<domain>` in the Firebase console, under Authentication, Settings, Authorized domains.
     Without it Google sign-in fails with `auth/unauthorized-domain`.
   - If the project's web API key is restricted to certain HTTP referrers (Google Cloud console,
     APIs & Services, Credentials), add `https://<domain>/*` to that list.
   - Keep `https://basaerbh.com/__/auth/handler` working. The sign-in page uses `basaerbh.com` as
     its Firebase sign-in domain, so Google sends the user back through that address, and only
     Firebase Hosting serves it. The website no longer needs Firebase Hosting (this server serves
     it, section 2); only this address does. So moving `basaerbh.com` here (section 1, step 4)
     breaks Google sign-in, until there is a way to keep that address answering. This runbook does
     not cover that yet.

   Until this is done, "sign in with Google" fails and users sign in with the emailed code or their
   password.
5. Browser push (FCM) registration is not available (out of scope at go-live). `/platform` is served
   by this server (section 2) without its "تفعيل إشعارات المتابعة" button, the dialog behind it
   and the Firebase scripts. They registered the device with Firebase Cloud Messaging through the
   old Apps Script, and come back only when FCM is replaced by Web Push (section 11). `/exec` with
   `saveFcmToken` still needs a logged-in session (401 otherwise).
6. Switch to live sending. **Needs:** steps 1 and 2. Leave `ALLOW_CPR_ONLY_LOGIN` unset
   (section 2, "Settings"). Send a test to yourself first, then set `OUTBOUND_MODE=live`:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo nano /etc/basaer.env                    # OUTBOUND_MODE=live
   sudo systemctl restart basaer
   curl -s https://<domain>/healthz
   ```
   Check: `/healthz` shows `"mode":"live"`.

   **Warning:** from now on real messages go to real students and parents.

## 6. Backups and restore

There are two layers.

**Off the machine: a daily EBS snapshot of the data volume.** It holds the database, the file
store and the keys, and survives the loss of the instance or the volume. Set it up once:

```
# AWS console → EC2 → Lifecycle Manager → Create lifecycle policy → EBS snapshot policy
```

Target the data volume by its tag `Name=basaer-data` (section 1, step 1), daily at a quiet hour,
retain 14. Snapshots are incremental, so they cost roughly the size of the data plus the daily
change.

Check: the next day, EC2 → Snapshots lists a snapshot of the data volume.

**On the machine: nightly database and key copies.** A timer runs `deploy/backup.sh` every night
at 03:30 Asia/Qatar. It writes to `/var/lib/basaer/backups` (on the data volume):

- `basaer-<stamp>.sqlite.gz`: a consistent copy of the database (~5 MB);
- `keys-<stamp>.tar.gz`: the signing keys.

One of each per night, kept 14 days (~70 MB in all). They undo a bad day's edits in a minute,
without touching snapshots. The file store is not copied on the machine: the snapshots cover it.

Check the timer and run a backup by hand:
```
# on the server, as ubuntu (ssh)
cd /
systemctl list-timers basaer-backup.timer
sudo systemctl start basaer-backup.service
ls -lh /var/lib/basaer/backups
```
Check: the timer shows the next 03:30 run; the listing shows a new `basaer-<stamp>.sqlite.gz` and
`keys-<stamp>.tar.gz`.

Restore one database backup:
```
# on the server, as ubuntu (ssh)
cd /
ls -lh /var/lib/basaer/backups                 # pick the <stamp>
sudo systemctl stop basaer
sudo -u basaer rm -f /var/lib/basaer/basaer.sqlite-wal /var/lib/basaer/basaer.sqlite-shm
gunzip -c /var/lib/basaer/backups/basaer-<stamp>.sqlite.gz | sudo -u basaer tee /var/lib/basaer/basaer.sqlite > /dev/null
sudo systemctl start basaer
```
Check: `curl -s https://<domain>/healthz` answers `{"ok":true,...}`.

Restore the keys (only if they were lost):
```
# on the server, as ubuntu (ssh)
cd /
sudo -u basaer tar -xzf /var/lib/basaer/backups/keys-<stamp>.tar.gz -C /var/lib/basaer
sudo systemctl restart basaer
```

Restore files, or everything after the loss of the volume or the instance:

1. Create a volume from the latest snapshot and attach it to the instance in place of the damaged
   one:
   ```
   # AWS console → EC2 → Snapshots → select the latest → Create volume (same availability zone) → Volumes → Attach
   ```
2. Mount it at `/var/lib/basaer` as in section 2, step 2, **without** the `mkfs.ext4` line. The
   volume keeps the label `basaer-data`, so the existing `/etc/fstab` line finds it:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo mount -a && df -h /var/lib/basaer
   sudo systemctl restart basaer
   ```
   Check: `df -h /var/lib/basaer` shows the data volume; `/healthz` answers.

To get single files back, attach the snapshot's volume beside the live one, mount it by device at
another path (say `/mnt/restore`), and copy what you need. Both volumes carry the label
`basaer-data`, so unmount and detach the extra one before the next reboot.

## 7. Updating

**Needs:** the new commits pushed to GitHub. The server pulls from there.

```
# on your PC, in WSL
cd <repo>
git push origin master
git log -1 --oneline
```

```
# on the server, as ubuntu (ssh)
cd /opt/basaer/app
sudo -u basaer git pull
sudo -u basaer npm ci --omit=dev
sudo systemctl restart basaer
```

If files under `deploy/` changed, run the bootstrap again:

```
# on the server, as ubuntu (ssh)
cd /opt/basaer/app
sudo bash deploy/install.sh
```

`install.sh` never overwrites an existing `/etc/basaer.env`, so new settings do not appear on their
own. After every update, compare the two and add what is missing (for example
`FIREBASE_PROJECT_ID`):

```
# on the server, as ubuntu (ssh)
cd /opt/basaer/app
sudo diff /etc/basaer.env deploy/basaer.env.example
```

Check: `sudo -u basaer git -C /opt/basaer/app log -1 --oneline` shows the same commit as on your
PC; `curl -s https://<domain>/healthz` answers `{"ok":true,...}`.

A restart does not log anyone out (sessions are signed with the keys on disk). It does clear the
in-memory rate-limit counters (section 9).

## 8. Cut-over checklist

**Needs:** sections 2 to 5 done and checked.

1. Point the real domain at the server. Lower the DNS TTL a day ahead, then point the A record at
   the Elastic IP (section 1, step 4). If you tested under `<temp-domain>`, also do "Changing the
   domain" (section 2): certificate, `BASE_URL`, and the links.

   Check:
   ```
   # on your PC, in WSL
   cd ~
   dig +short basaerbh.com
   curl -s https://basaerbh.com/healthz
   ```
   Expected: `<ip>`; `{"ok":true,...}`.
2. Freeze the Apps Script: make it read-only, so nobody writes to the old system.
3. Load the final data. **Needs:** step 2. Do the refresh **on the development PC**, which has
   the rclone remote, the Google exports and room for the working copy (the server has neither
   the space — the pull needs ~16 GB beside the store — nor any Google credentials, and keeps it
   that way), then ship the result exactly as in section 4, "Copy from the PC".

   On the PC: section 4 steps 2, 4 to 7 and 10 against the PC's `data/basaer.sqlite`, with a fresh
   Firebase export for step 10, so that the final sheets, the newest files and the `emailVerified`
   flags all match. The long part, the Drive file copy (steps 4 to 7), can be done ahead of the
   freeze and repeated: it only adds what is missing. Then "Copy from the PC": the rsync of
   `data/files/` tops up what the server already has, a fresh consistent copy of the database
   replaces the server's, and the `--rebase-from http://localhost:3000` run re-points the links
   (the equivalent of step 9; not optional, freshly imported sheets hold Google links again).

   Test accounts made during development disappear with the rebuilt sheets (their rows were only in
   the local copy), but their login rows in the identity store do not. Delete those by hand. The
   development admin was CPR `191919191`:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo -u basaer sqlite3 /var/lib/basaer/basaer.sqlite "DELETE FROM auth_users WHERE uid = 'u191919191'"
   ```
   Check:
   ```
   # on the server, as ubuntu (ssh)
   cd /
   sudo -u basaer sqlite3 /var/lib/basaer/basaer.sqlite "SELECT count(*) FROM auth_users WHERE uid = 'u191919191'"
   ```
   Expected: `0`.
4. Verify the counts: export from the new system and compare the row count of each sheet with the
   Google Sheets.
   ```
   # on the server, as ubuntu (ssh)
   cd /opt/basaer/app
   sudo -u basaer node tools/export-xlsx.js --dir /tmp/verify --db /var/lib/basaer/basaer.sqlite
   ```
5. Google sign-in: out of scope at go-live (section 5, steps 3 and 4). When it is brought back: set
   `FIREBASE_PROJECT_ID=coming-soon-basaer` in `/etc/basaer.env`, restart, and check that the
   journal says `google sign-in: enabled` (section 5, step 3).
6. Test the relay pages. This server serves them (`/relay/google-signin` and `/relay/qr-scan`), so
   nothing is redeployed on Firebase Hosting. Scan one QR code. The Google sign-in test (sign in
   with Google using an account whose email is on file) belongs with section 5, step 4, and needs
   the admin's part of that step first: the domain under Authorized domains, and
   `basaerbh.com/__/auth/handler` still answering.
7. Leave push notifications out of the announcement (section 5, step 5).
8. Switch on `OUTBOUND_MODE=live` (section 5, step 6) once step 4 looks right.
9. Announce the new URL to staff, students and parents: `https://basaerbh.com/platform` opens the
   app (section 2, "What the server answers").
10. Rotate the keys and tokens listed in `docs/SECURITY-FINDINGS.md` (findings 1 and 11: Google
    OAuth access, the exposed keys, the Fonnte token), and revoke the old ones.
11. Keep the old Apps Script read-only for a few weeks as a fallback, then archive it.
12. Clean up the import leftovers (section 4, step 12).

## 9. Troubleshooting

Every command in this section runs on the server, as ubuntu (ssh), unless it says otherwise.

- Logs: `journalctl -u basaer -f` (app);
  `sudo tail -f /var/log/nginx/basaer.access.log /var/log/nginx/basaer.error.log` (web);
  `journalctl -u basaer-backup` (nightly backup).
- Request log: every API request (`/api`, `/exec`, `/files`) writes one JSON line to the journal,
  with no request body:
  `{"t":"2026-10-20T08:15:02.113Z","ip":"203.0.113.7","m":"POST","p":"/api/rpc/getPersons","s":200,"ms":12.4,"cpr":"<caller>","ref":"a1b2c3d4"}`
  `ip` is the client's address, `s` the HTTP status, `ms` the time taken, `cpr` the logged-in caller
  (so treat the journal as personal data). `ref` appears only when the request failed on the
  server. In production the user sees a generic message ending with a reference
  (`المرجع a1b2c3d4`). Find the cause with `journalctl -u basaer | grep a1b2c3d4`: the line
  `RPC <function> failed [a1b2c3d4]:` (or `/exec <action> failed [...]`) is followed by the error
  and its stack. To list server errors: `journalctl -u basaer -o cat | grep '"s":5'`.
- Health: `curl http://localhost:3000/healthz` on the server, `curl https://<domain>/healthz` from
  outside. It also reports the worker pools, for example `"rpc":{"size":1,"busy":1,"queued":3}`.
  `busy` is how many workers are running a call right now, and `queued` how many calls are waiting
  for a free worker. `queued` that stays above 0 for a minute means a slow call is holding the
  worker, or the load is too much for it (section 10). More than 500 waiting calls are refused with
  "server busy, try again shortly" (503). `/healthz` is answered by the HTTP thread, so it can say
  ok while interactive calls are slow.
- The service restarts 3 seconds after a crash. `systemctl status basaer` shows the last error.
- A worker crashed or hung: the journal has lines starting `[rpc]` or `[background]`:
  `worker exited with code N; respawning` (the pool starts a new worker at once; the call that was
  running fails with a generic error and a reference), `worker error: ...`, and
  `job call <function> exceeded 300000ms; terminating worker` (a call ran for more than 5 minutes
  and was cut off). If one function keeps appearing, note its name and the stack trace printed
  before the line and pass them to the developer. If a worker cannot start at all, the service logs
  `startup failed:` and systemd retries every 3 seconds.
- 429 Too Many Requests: the app's own rate limits. The reply has a `Retry-After` header (seconds)
  and a `scope` field naming the limit that was hit:
  - `auth` (session endpoints): 30 per minute per IP.
  - `rpc`: 120 per minute per IP when not logged in; 600 per minute per user when logged in.
  - `login` (password login, login-code check, registration-code check, Google login,
    skip-verification login): 30 per 10 minutes per IP, and 10 per 10 minutes for the same CPR or
    email.
  - `otp` (asking for a login or registration code): 5 per 10 minutes for the same CPR or email.
  - `exec` (the relay pages): 60 per minute per IP.

  The counters are in memory. They clear by themselves when the window ends, and at once with
  `sudo systemctl restart basaer`. A whole class signing in from one Wi-Fi shares one IP and can
  reach the `login` limit. If everyone gets 429, every request looks like it comes from one client:
  check that the nginx site file still has the `X-Forwarded-For` line, that `TRUST_PROXY` is not
  changed, and that `ip` in the request log shows real addresses and not `127.0.0.1`.
- A user with the right password is refused, or the app says there were too many attempts: the
  account is locked for that user's network address. 10 wrong passwords within 15 minutes lock the
  (email, address) pair for 15 minutes, and the lock ends by itself. The same user from another
  address, or a successful login, is not affected. Rows in the table `auth_attempts` are keyed
  `email|address` (email in lower case) and survive restarts. To see who is locked, and to lift a
  lock now (the service can keep running):
  ```
  # on the server, as ubuntu (ssh)
  cd /
  sudo -u basaer sqlite3 -cmd ".timeout 5000" /var/lib/basaer/basaer.sqlite \
    "SELECT email, failures, datetime(locked_until/1000,'unixepoch') AS locked_until_utc FROM auth_attempts WHERE locked_until > strftime('%s','now')*1000;"
  sudo -u basaer sqlite3 -cmd ".timeout 5000" /var/lib/basaer/basaer.sqlite \
    "DELETE FROM auth_attempts WHERE email LIKE 'student@example.com|%';"
  ```
- "Sign in with Google" fails: check the start-up line `google sign-in:` in the journal. `disabled`
  means neither `FIREBASE_PROJECT_ID` nor `GOOGLE_OAUTH_CLIENT_ID` is set (the sign-in page's post
  gets 503). If it says `enabled`, read the diagnostic log at the bottom of the sign-in window (it
  is in Arabic and shows the Firebase error code). `auth/unauthorized-domain` means the app's
  domain is missing from Authorized domains in Firebase. If the window goes to Google and never
  comes back, check that `https://basaerbh.com/__/auth/handler` still answers. A refusal from the
  server (401) means the ID token comes from another Firebase project than `FIREBASE_PROJECT_ID`.
  See section 5, step 4. Users can use the emailed code or their password meanwhile.
- Users are logged out unexpectedly: the files in `BASAER_KEYS` were lost or replaced. Over plain
  HTTP with `NODE_ENV=production` the browser also drops the Secure session cookie (section 2,
  step 4).
- A page shows data that someone else just changed: the page keeps the results of read-only calls
  until it is reloaded, and clears them whenever that user saves something. Reloading fetches
  fresh data.
- certbot fails: DNS has probably not propagated. `dig +short <domain>` must print the Elastic IP,
  and ports 80 and 443 must be open. See `/var/log/letsencrypt/letsencrypt.log`.
- `nginx -t` reports a syntax error: fix the line it names in `/etc/nginx/sites-available/basaer`
  (often a missing `;`), then run `sudo nginx -t` again before reloading.
- 502 Bad Gateway: the Node service is down. Run `systemctl status basaer` and
  `journalctl -u basaer -e`.
- 413 Request Entity Too Large: the upload exceeds `client_max_body_size` (50m) in the site file.
  Raise it, then run `sudo nginx -t && sudo systemctl reload nginx`.
- The first certificate or PDF is slow (30 to 60 seconds): LibreOffice builds its profile in
  `/var/lib/basaer` on first use. Later runs are fast.
- Arabic text looks wrong in documents: check `fc-list | grep -i amiri`.
- `EADDRINUSE` (port in use): another process holds port 3000. Find it with
  `sudo ss -ltnp | grep 3000`, stop it, then run `sudo systemctl restart basaer`.
- Permission errors writing files: `/var/lib/basaer` and everything under it must be owned by
  `basaer` (`sudo chown -R basaer:basaer /var/lib/basaer`), and `BASAER_FILES` in `/etc/basaer.env`
  must point inside it.
- The disk is full: `df -h / /var/lib/basaer`. The data volume grows online (section 1, step 1,
  "Growing the data volume").

## 10. Capacity and scaling

The server is one Node process on one machine, started by systemd. Inside it:

- The HTTP thread serves pages, files and `/healthz`, checks logins and applies the rate limits. It
  never runs the legacy (Apps Script) code, so a slow job cannot stop pages from loading.
- One worker thread, the "rpc" pool, runs the interactive calls from the browser, one at a time.
- One worker thread, the "background" pool, runs the timed jobs: WhatsApp and push queue ticks,
  exam monitors and certificate batches. A long batch does not freeze users.

The Apps Script `LockService` is a real lock shared by all workers, so code that the legacy source
guards with a lock stays exclusive, even between an interactive call and a background job.

The pages load whole tables (the legacy code was written that way: the admin page's reads are about
5 MB of JSON, and the browser pages them on screen). Three things keep that cheap, for every page
and every role:

- Responses are gzip-compressed (JSON shrinks 8-10x). nginx does this too; the server does it
  itself so every path is covered.
- Read-only calls (policy kind `read`) are computed once and shared by every caller
  (`server/rpc-read-cache.js`). The same function with the same arguments is answered from memory
  until any sheet, file or property changes (the database carries a version stamp that moves on
  every write, from any connection, tools included), and for at most `RPC_READ_CACHE_TTL_MS`
  (default 60000; `0` switches the cache off), so clock-dependent replies cannot go stale. Memory
  is capped by `RPC_READ_CACHE_MAX_MB` (default 32; the least recently used entries go first).
  `/healthz` shows the `readCache` hits, misses, entries and bytes.
- The browser keeps every read reply (IndexedDB, per signed-in user) with the ETag the server sent,
  and revalidates it on the next page load with `If-None-Match`. Unchanged data is a bodiless
  `304`, so a reload downloads only what changed since the last visit.

`BASAER_RPC_WORKERS` sets how many threads run interactive calls (default 1). Keep it at 1. The
legacy code has many check-then-write steps (look for a duplicate, then append a row; remember a
row number, then delete rows) that are only safe when interactive calls run one at a time. Raise it
only after those code paths have been reviewed. With 1, a slow call, such as a certificate or PDF
(a second or two; 30 to 60 seconds for the first LibreOffice run), makes other users' calls wait
behind it, while pages and files are unaffected. Each worker holds its own in-memory copy of the
data it has read, so more workers means more memory. At 1 worker, users' calls cannot overlap each
other. They can still overlap a background job where the legacy code takes no lock, as they could
on Apps Script.

**Scaling up:** make the machine bigger rather than adding processes. A t3.small has 2 vCPU and
2 GB of memory; a t3.medium has 2 vCPU and 4 GB. Move up when `free -m` shows little free memory
(LibreOffice is the biggest user), when `queued` in `/healthz` stays above 0, or when the `ms`
field in the request log climbs. To resize:

1. Take a backup (section 6).
2. In the EC2 console, stop the instance, choose Actions, Instance settings, Change instance type,
   pick the new type, and start it. The Elastic IP stays attached. The site is down for a few
   minutes.
   ```
   # AWS console → EC2 → Instances → Stop → Actions → Instance settings → Change instance type → Start
   ```
3. Check: `curl -s https://<domain>/healthz` answers `{"ok":true,...}`.

Do not run a second copy of the server against the same database, or put two behind a load
balancer. The shared lock, the rate limits and the five-minute record of Google-verified emails live
in the memory of the one process.

Why SQLite is the right store for this app:

- The data is bounded by what the Google Sheets held, which is small for a database.
- Reads are served from memory. Each sheet is loaded into memory on first use; SQLite is read again
  only when another worker has changed that sheet.
- Writes are serialised: SQLite takes one writer at a time, and interactive calls already run one
  at a time.
- There is one file to back up (`sqlite3 .backup`, section 6), plus the files directory.

The limits:

- It is one machine. There is no failover. If the instance or its data volume is lost, you build a
  new one and restore from the last snapshot (section 6). Anything written since that snapshot is
  gone.
- Moving to PostgreSQL or another networked database is not a configuration change. The legacy code
  is synchronous (it reads or writes a sheet and carries on with the next line), and a networked
  database driver is asynchronous, so the legacy code would have to be rewritten.

## 11. What still touches Google after migration

Once section 4 is done and the cut-over is over, the app does not depend on a Google account for
its data. What still reaches Google:

- **Nothing for data, files, sending e-mail or QR codes.** The sheets are in the database, the
  Drive files are in `/var/lib/basaer/files` under their old ids, mail leaves through the SMTP
  server you set in `/etc/basaer.env` (pointing `SMTP_HOST` at a Google mail server would be your
  own choice of provider, not something the app needs), and QR codes are drawn on this server.
  Fonts and the old site's assets are served from this server, and so is the public website
  (section 2), without its Google Analytics.
- **The "sign in with Google" button, which is optional.** Firebase Authentication is the identity
  provider only. The sign-in window loads the Firebase script from Google, the user signs in at
  Google and comes back through `https://basaerbh.com/__/auth/handler`, and the server checks the
  token it gets, fetching Google's public signing keys to do so. The window deletes the temporary
  Firebase user it creates as soon as it has the email address; passwords and accounts live in this
  server's database. Without `FIREBASE_PROJECT_ID` the button is refused, and the emailed code and
  the password keep working (section 5, step 3).
- **Push notifications, if you ever turn them on.** They go through Google's Firebase Cloud
  Messaging, and are out of scope for go-live (section 5, step 5). The platform page's
  تفعيل إشعارات المتابعة button, its dialog and the Firebase scripts were taken out of `/platform`,
  so no new device can register until FCM is replaced by Web Push.
- **The fatawa panel on the website's home page** used to load its fatawa from a public Google Sheet
  (the `fatawa` sheet of the basaer-REF workbook, through a `docs.google.com/.../gviz` `<script>`
  run by the visitor's browser). It now reads `server/client/site/assets/data/fatawa.json`, a
  snapshot of that sheet's rows (`title`, `question`, `answer`, `category`) taken on 2026-10-21.
  Edit that file to change the fatawa; the sheet is no longer consulted. When the file cannot be
  loaded, the panel shows the three sample fatawa built into the script. The website also uses
  three services that are not Google: `cdn.jsdelivr.net` (icon fonts, as the app does),
  `api.aladhan.com` (prayer times) and `api.web3forms.com` (the contact form).
- **The area lookup when a student registers.** Typing a block number makes the server ask a
  separate Apps Script web app on `script.google.com` for the area name (`lookupBlockArea` in
  `gas/dataGet.js`). That script is not part of this repository and is not migrated. The server
  calls it only with `OUTBOUND_MODE=live`. If it is ever switched off, the area field stays empty.
- **Mail programs.** The HTML e-mails link a Google Fonts stylesheet (`gas/emailTemplates.js`),
  which some mail programs fetch when a message is opened. The server does not.
