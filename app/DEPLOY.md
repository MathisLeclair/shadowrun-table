# Deploying the Shadowrun table on the VPS

The app runs on the OVH VPS (Ubuntu, Docker) as its **own** docker compose project named `shadowrun`, plain HTTP on
**host port 8095**. Another stack owns ports 80/443 on this VPS: nothing here touches it (no shared network, no shared
volume, no reverse-proxy change, image prune limited to this app's label).

One server hosts several **tables** (independent campaigns, each with its own GM password, players, maps, story,
uploads and backups). The owner is the **admin** (`/admin`) and creates the tables; each GM only sees their own table.

| URL | What |
|---|---|
| `http://152.228.134.90:8095/` | table picker (redirects straight to the table when there is only one; `/?choisir` always shows the list) |
| `http://152.228.134.90:8095/t/<table>/` | a table (players and GM log in here) |
| `http://152.228.134.90:8095/admin` | server administration (admin password) |
| `http://152.228.134.90:8095/api/health` | health check (used by Docker) |

## Layout on the VPS

```
~/shadowrun/                      git clone of github.com/MathisLeclair/shadowrun-table
~/shadowrun/app/docker-compose.yml
~/shadowrun/app/.env              SR_ADMIN_PASSWORD=…, assistant federation ids   (chmod 600, never committed)
~/shadowrun/app/runtime/          ← all game data (bind mount → /app/runtime in the container)
    server.json                   table registry + admin password hash
    tables/<id>/state.json        a table's game state (+ backups/ uploads/ docs/ assets/ foundry/ table.json)
    deleted/                      .zip of deleted / replaced tables
~/shadowrun/app/data/assets/foundry/   ← Foundry images & music of Project Lazarus (~490 MB, bind mount)
~/shadowrun-backups/              data snapshots taken before each update/migration (10 newest kept)
```

A table's campaign docs (Campagne → Documents, also read by the GM assistant) are plain markdown files in
`runtime/tables/<id>/docs/` (one sub-folder level, e.g. `foundry/`). They are not in git: to update Project Lazarus's
docs from the PC, copy them over, e.g.
`scp -i $HOME\.ssh\gachabackend_deploy ..\Shadowrun\session-5-plan.md ubuntu@152.228.134.90:~/shadowrun/app/runtime/tables/lazarus/docs/`
(the **↻** button in Documents reloads the list; no restart needed).

The image contains only code and static content; rebuilding it never touches `runtime/` or `data/assets/foundry/`.
The container runs as uid 1000 (`node`), which is also the `ubuntu` user on the VPS, so both folders belong to it.

## Prerequisites (once)

- On your PC: the Windows OpenSSH client (`C:\Windows\System32\OpenSSH\ssh.exe`) and the key
  `~/.ssh/gachabackend_deploy` that already opens `ubuntu@152.228.134.90`.
- On the VPS: Docker with the compose v2 plugin (`docker compose version`), git.
- The code you want to run is **pushed** to GitHub (`main`): the VPS pulls from GitHub, not from your PC.

All commands below are run in PowerShell from the `app` folder:

```powershell
cd "D:\projet perso\shadowrun\app"
powershell -ExecutionPolicy Bypass -File .\deploy\deploy.ps1 -Action <action>
```

Options: `-VpsHost`, `-VpsUser`, `-KeyFile`, `-Branch` (default `main`), `-BackupDir`, `-Yes` (no confirmations).

## 1. First install — `-Action setup`

```powershell
.\deploy\deploy.ps1 -Action setup
```

It:
1. checks Docker/compose on the VPS and that port 8095 is free;
2. creates a **read-only deploy key** on the VPS (`~/.ssh/shadowrun_deploy`, ssh alias `github-shadowrun`) and prints its
   public key. Add it on GitHub: *repo → Settings → Deploy keys → Add deploy key*, title "VPS OVH",
   **leave "Allow write access" unchecked**, then press Enter in the script;
3. clones the repo into `~/shadowrun`;
4. asks for the **admin password** (12+ ASCII characters, no space/quote/`$`/backslash) and writes
   `~/shadowrun/app/.env` through stdin (it never appears on a command line);
5. creates `runtime/` and `data/assets/foundry/`, opens `8095/tcp` in ufw if ufw is active;
6. `docker compose up -d --build` and waits until the container is healthy.

> Alternative to the deploy key: a GitHub **fine-grained personal access token** limited to this repository with
> *Contents: Read-only*. On the VPS: `git clone https://github.com/MathisLeclair/shadowrun-table.git ~/shadowrun`,
> username = your GitHub login, password = the token, then `git config --global credential.helper store` so pulls
> keep working. Never use your GitHub password.

Firewall notes: ports published by Docker bypass ufw rules (Docker writes its own iptables rules), so 8095 is reachable
even if ufw blocks it. If the OVH control panel has a *Network firewall* enabled for this IP, allow TCP 8095 there.

## 2. Foundry assets — `-Action assets`

```powershell
.\deploy\deploy.ps1 -Action assets
```

Packs `app\data\assets\foundry` into one tar (≈490 MB, temp file in `%TEMP%`), copies it with scp and unpacks it on the
VPS. Re-run it whenever you import new Foundry content on your PC. No restart needed.

**Music library** — `.\deploy\deploy.ps1 -Action music` does the same for `app\data\assets\music` (≈330 MB, Karl Casey /
White Bat Audio and Dan Cramp tracks shared by every table, served at `/assets/music/…`, credits in its `CREDITS.md`).
Not in git: the licences don't allow redistributing the files. Without it, the `trk_lib_*` tracks of the audio seed
are silent on the VPS.

## 2b. Rulebooks (PDFs, « Règles » tab)

The SR5 PDFs are **not** in git or in the image: they live in `runtime/books/` on the VPS (`<CODE>.pdf` +
`index/<CODE>.json` extracted text + `library.json`), shared by every table the admin allows. Two ways to fill it:

- **Copy the library built on your PC** (fastest, offsets already checked): on the PC run
  `node tools/books-setup.js --from "C:\Users\mathi\Documents\Foundry\Data\PDFs"` (fills `app\data\books\`), then copy
  the whole folder to `~/shadowrun/app/runtime/books/` (e.g. `scp -r app\data\books ubuntu@152.228.134.90:~/shadowrun/app/runtime/`).
  The server reads `library.json` on the fly: no restart. Keep the folder owned by uid 1000 (`ubuntu`).
- **Upload from `/admin` → « Livres de règles »** (one PDF at a time, streamed, 120 MB max): the server extracts the
  text in a worker thread (≈ 5 s for the core rulebook, ~250 MB of RAM while it runs, one book at a time) and detects
  the page offset. The worker lives in the server's process, so a job only starts when the container's memory limit
  leaves ≈ 6× the PDF's size free (otherwise « Mémoire insuffisante »: index that book on the PC and copy it instead).

The short-lived PDF links are signed with `runtime/books-sign.key` (per server, created automatically, **outside** the
books folder so copying the library never shares it; deleting it only invalidates the links currently open). A link
only works while the session that asked for it exists (logout, kicked player or GM password change → dead link).
An older version kept the key as `books/.sign-key`: the server deletes that file, never copy it.

## Map library images (« Bibliothèque de cartes »)

The wall data of the library is in git (`app/data/maplib/<slug>.json`) and arrives with every deploy; the server builds its own
`runtime/maplib/library.json` from it at start-up. The **images are not in git** (paid Fragmaps content) and must be copied by hand:

1. On the PC: `node tools/maplib-build.js` — copies the images used by `data/maplib/*.json` from `..\fragmap` into `data/maplib/images/` and makes
   the thumbnails in `data/maplib/thumbs/`.
2. Copy **only** those two folders to the VPS (never `library.json` nor `entries/`: they hold the VPS's own versions, GM publications and history):
   ```powershell
   scp -i $HOME\.ssh\gachabackend_deploy -r app\data\maplib\images app\data\maplib\thumbs ubuntu@152.228.134.90:~/shadowrun/app/runtime/maplib/
   ```
   (create `~/shadowrun/app/runtime/maplib/` first if it does not exist; it must belong to uid 1000 / `ubuntu`). No restart needed: images are read
   on each request. Re-run both steps when new fragmaps are traced. A missing image shows a grey placeholder in the app.
3. The fragmaps-free scenes already imported from Foundry use the existing `data/assets/foundry/scenes/` images (`-Action assets`).

Images are only served to logged-in users (signed links, key `runtime/maplib-sign.key`, created automatically, per server). An admin can also
upload one image at a time in `/admin` → « Bibliothèque de cartes » (60 MB max, thumbnail made on the server for JPEGs).

## 3. Move the Project Lazarus game — `-Action migrate`

Close the local server first (so the latest state is on disk), then:

```powershell
.\deploy\deploy.ps1 -Action migrate
```

It takes `app\data\tables\lazarus\` (or the old `app\data\state.json` + `data\uploads\` if you never started the new
version locally), adds the campaign documents from `..\Shadowrun\*.md` (+ `foundry\`) as the table's `docs/`, stops
the container, installs everything as `runtime/tables/lazarus/` (an existing one is moved to `~/shadowrun-backups/`),
and restarts. The table keeps its GM password, players, PINs and the historical URLs (`/uploads/…`,
`/assets/foundry/…`), so nothing in the game state needs rewriting. It is at `http://152.228.134.90:8095/t/lazarus/`.

Players who join from the VPS must log in again once (sessions are per browser and per host).

Alternative without the script: in the local `/admin` page download the table's **Sauvegarde .zip**, then on the
VPS `/admin` use **Restaurer une table** (same id `lazarus`). The Foundry assets still go with `-Action assets`.

## 4. The friend's table

Open `http://152.228.134.90:8095/admin` → **Nouvelle table**: name, id (the URL), content **Campagne vierge**
(generic bestiary only, no PCs, no maps, no campaign story) or **Project Lazarus**, language, GM password.
Send the friend the table link and the GM password. **Masquer de l'accueil** keeps a table off the picker (reachable by
its link only). From the admin page you can also rename, archive/unarchive, reset the GM password, open the table as
GM, download a backup zip or delete it (an archive zip is kept in `runtime/deleted/`).

Foundry on the VPS: the server cannot read Foundry on a PC. In the table, **Réglages → Foundry VTT — monde sur le
serveur → Téléverser un monde Foundry (.zip)**: zip the world folder (`Foundry/Data/worlds/<world>`), optionally a
second zip with extra Data folders (`Music/`, `img/`…), then **Analyser** / **Importer** as usual. Max 1.5 GB per zip
(`SR_MAX_UPLOAD_BYTES`). A GM can only read worlds uploaded to their own table.

## 4b. Public demo table

A table anyone can open from the README to try the GM and player sides, without a password. It is rebuilt from the
`demo` content pack (generic: pre-made runners, a warehouse map, bestiary NPCs, a Matrix host — no Project Lazarus) at
every start, every night, and 30 minutes after the last visitor leaves. On it, the GM assistant, the rulebooks, Foundry,
state import/backup and map-library browsing are off; uploads are small images only (see ARCHITECTURE.md « Demo table »).

To enable it on the VPS:

1. In `~/shadowrun/app/.env`, add `SR_DEMO_TABLE=demo` (optionally `SR_DEMO_NAME=…`, `SR_DEMO_LANG=en`,
   `SR_DEMO_RESET_HOUR=4` — container time is UTC).
2. `.\deploy\deploy.ps1` (or `docker compose up -d` on the VPS). The log shows
   `[demo] table publique de démonstration créée : /t/demo/`.
3. In `/admin`, tick **Masquer de l'accueil** on every real table (Project Lazarus, the friend's table). The picker then
   lists only the demo and `/` redirects to it; real tables stay reachable by their link and still need their password.
4. Once HTTPS is set up through Caddy (a host name → `http://127.0.0.1:8095`), set `SR_TRUST_PROXY=1` in `.env` so the
   per-IP login limits see the visitors' real address, and replace the placeholder link in the root `README.md`.

`SR_DEMO_TABLE` only ever creates a table: if the id already belongs to a real table, it is left untouched and the log
says so. To remove the demo: delete `SR_DEMO_TABLE` from `.env` and delete the table in `/admin`. The map-library copy in
the demo shows its artwork only if that image (`dive-bar`) is in the server's library; its walls and doors work anyway.
Locally: `SR_DEMO_TABLE=demo npm start` (PowerShell: `$env:SR_DEMO_TABLE='demo'; npm start`).

## 5. Updates — `-Action update` (default)

```powershell
git push            # from the repo, first
.\deploy\deploy.ps1
```

Snapshot of `runtime/` → `~/shadowrun-backups/runtime-<date>-before-update.tar.gz`, current image tagged
`shadowrun-app:previous`, `git pull --ff-only`, `docker compose up -d --build`, wait for healthy. Connected players are
disconnected for a few seconds and reconnect automatically. The state is flushed on SIGTERM, so `docker compose
restart/stop` never loses data.

## 6. Backups

Automatic, per table, inside `runtime/tables/<id>/backups/`: one at every start and stop, one every 15 minutes when
something changed (30 kept), plus manual ones (*Réglages → Créer une sauvegarde*) and before imports/resets (20 kept).

- **Download everything to the PC**: `.\deploy\deploy.ps1 -Action backup` → `Documents\shadowrun-vps-backups\shadowrun-<date>.tar.gz`
  (uploaded Foundry world sources are excluded — re-uploadable).
- **One table**: `/admin` → *Sauvegarde .zip* (state, uploads, docs, imported assets).
- **Snapshots** before each update/migration: `~/shadowrun-backups/` on the VPS (10 kept).

### Restore

- A table from a zip or a JSON export: `/admin` → **Restaurer une table** (tick *Remplacer* to overwrite; the replaced
  version is kept in `runtime/deleted/`).
- A table from its own automatic backups (on the VPS):
  ```bash
  cd ~/shadowrun/app && docker compose stop
  cp runtime/tables/<id>/backups/state-<date>-auto.json runtime/tables/<id>/state.json
  docker compose up -d
  ```
- Everything from a snapshot:
  ```bash
  cd ~/shadowrun/app && docker compose stop
  mv runtime runtime.broken-$(date +%s)
  tar -xzf ~/shadowrun-backups/runtime-<date>.tar.gz -C ~/shadowrun/app
  docker compose up -d
  ```

## 7. Rollback — `-Action rollback`

Restarts the image that ran before the last update (`shadowrun-app:previous`) and checks out the previous commit
(detached), without touching data. The next `update` goes back to the head of `main`. Manual equivalent:

```bash
cd ~/shadowrun/app
docker tag shadowrun-app:previous shadowrun-app:latest
git -C ~/shadowrun checkout --detach "$(cat ~/shadowrun-backups/previous-commit)"
docker compose up -d --no-build
```

If an update also changed data in a bad way, restore the matching `runtime-…-before-update.tar.gz` snapshot (above).

## 8. Day-to-day commands

```powershell
.\deploy\deploy.ps1 -Action status     # container, health, commit, disk usage, latest snapshots
.\deploy\deploy.ps1 -Action logs       # last 200 log lines
ssh -i $HOME\.ssh\gachabackend_deploy ubuntu@152.228.134.90
```
```bash
cd ~/shadowrun/app
docker compose ps | logs -f --tail 100 | restart | stop | up -d
```

### Admin password

Set in `~/shadowrun/app/.env` (`SR_ADMIN_PASSWORD=…`). It is applied at start-up **whenever its value changes**; a
password changed in the admin page is kept across restarts until you change `.env` again. Forgotten password: edit
`.env` on the VPS, then `docker compose up -d` (recreates the container with the new value).
Without the variable (local PC use), a password is generated at the first start and printed once in the console.

GM password of a table forgotten: `/admin` → *Mot de passe MJ*.

## GM assistant (Claude) — `-Action ai-setup`

The GM dock « Assistant » calls the Claude API. There is **no API key on the server**: the app authenticates with
**Workload Identity Federation**. It is its own small OIDC issuer: an EC key pair is created in
`runtime/assistant/signing-key.pem` (0600, stays on the VPS, left out of `-Action backup` downloads). Its public half is
registered in the Claude Console. Each token exchange signs a fresh 10-minute JWT, which the SDK trades for a
short-lived token scoped to one workspace.

One-time setup (≈ 5 min):

1. **Deploy this version**, open `http://152.228.134.90:8095/admin` → **Assistant IA**. It shows the *issuer URL*,
   the *subject prefix* (`shadowrun-table:`) and the **JWKS** (public key) with copy buttons.
2. **Claude Console → Workspaces** → create `shadowrun-table`, set its **monthly spend limit** (e.g. $80). This is
   the hard stop, outside the app.
3. **Console → Workload identity → Connect workload → Custom OIDC**:
   - issuer URL = the one shown in /admin, JWKS **inline** = paste the JWKS from /admin;
   - service account `shadowrun-table`, member of the `shadowrun-table` workspace only;
   - rule: workspace = `shadowrun-table`, scope **`workspace:inference`** (Messages only), match
     **subject prefix `shadowrun-table:`**, token lifetime 600 s.
   Note the **organization ID** and the **rule ID** (`fdrl_…`).
4. On your PC: `.\deploy\deploy.ps1 -Action ai-setup`. Paste the organization ID and the rule ID (the workspace ID and
   service account ID are optional). It writes them to `~/shadowrun/app/.env`, removes any `ANTHROPIC_API_KEY` (it would
   outrank federation) and recreates the container.
5. /admin → Assistant IA → **Tester la connexion** (one tiny call). Then switch on **Lazarus** under *Tables
   autorisées*, and set the in-app **monthly cap** (default $80, all tables together).

Day to day: the dock shows this month's spend. At the cap, questions are refused until the next month (or until you
raise the cap / reset the counter in /admin). To revoke access at once, archive the rule in the Console. To rotate the
key: stop the container, delete `runtime/assistant/signing-key.pem`, start it, then paste the new JWKS in the Console.
Restoring a PC backup creates a new key: paste the new JWKS in the Console.

Local development: set `ANTHROPIC_API_KEY` in the shell that starts the server (the dock then works with that key), or
add the PC's own JWKS (/admin on localhost) to the same issuer in the Console; the inline JWKS takes several keys.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SR_ADMIN_PASSWORD` | — (generated & printed once) | admin password for `/admin` |
| `SR_RUNTIME_DIR` | `app/data` (image: `/app/runtime`) | registry + tables |
| `SR_BOOTSTRAP_TABLE` | `lazarus` (image: `none`) | table created on an empty install (`none` = no table) |
| `SR_FOUNDRY_LOCAL_PATHS` | allowed (image: `0`) | `0` = GMs may only read Foundry worlds uploaded to their table |
| `SR_MAX_UPLOAD_BYTES` | `1500000000` | max size of an uploaded zip (Foundry world, table restore) |
| `SR_MAX_UNZIPPED_BYTES` | `6000000000` | max uncompressed size of an uploaded Foundry zip |
| `SR_BOOKS_DIR` | `<SR_RUNTIME_DIR>/books` | rulebook library (PDFs + index + library.json) |
| `SR_MAX_BOOK_BYTES` | `120000000` | max size of one rulebook PDF uploaded from `/admin` |
| `SR_BOOKS_WORKER_MB` | `320` | heap limit of the PDF indexing worker thread |
| `SR_BOOKS_JOBS` | `1` | PDF indexing jobs run at the same time |
| `SR_MAPLIB_DIR` | `<SR_RUNTIME_DIR>/maplib` | map library of this server (library.json, entries/, images/, thumbs/) |
| `SR_MAPLIB_KEY_FILE` | `<SR_RUNTIME_DIR>/maplib-sign.key` | HMAC key of the map image links |
| `SR_MAX_MAPLIB_IMAGE_BYTES` | `60000000` | max size of a map image uploaded from `/admin` |
| `SR_BOOKS_KEY_FILE` | `<SR_RUNTIME_DIR>/books-sign.key` | HMAC key of the PDF links (never inside the books folder) |
| `SR_MEMORY_LIMIT_BYTES` | cgroup `memory.max` | memory limit used to refuse an indexing job that would not fit |
| `SR_TRUST_PROXY` | off | `1` when served behind a reverse proxy (real client IP for the login rate limit) |
| `SR_DEMO_TABLE` | — | id of the public demo table to create (e.g. `demo`, see « 4b ») |
| `SR_DEMO_NAME`, `SR_DEMO_LANG` | `Table de démonstration`, `fr` | name and language of the demo table on creation |
| `SR_DEMO_RESET_HOUR` | `4` | nightly demo reset, server local hour (`none` = off) |
| `SR_DEMO_IDLE_MINUTES` | `30` | demo reset after this long with nobody connected |
| `SR_DEMO_UPLOAD_KB`, `SR_DEMO_UPLOAD_QUOTA_MB` | `1024`, `20` | demo uploads: max image size, total per reset |
| `SR_DEMO_MAX_USERS`, `SR_DEMO_LOGIN_MAX` | `40`, `30` | demo player accounts, logins per IP per 10 min |
| `SR_DEMO_MAX_STATE_MB` | `12` | demo reset at once when its state grows past this |
| `PORT` | `3000` | port inside the container |
| `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_FEDERATION_RULE_ID` | — | GM assistant through Workload Identity Federation (`-Action ai-setup`) |
| `ANTHROPIC_WORKSPACE_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` | — | optional, when the rule covers several workspaces / accounts |
| `ANTHROPIC_API_KEY` | — | local development only: GM assistant with an API key instead of federation |
| `SR_ASSISTANT_HOST` | hostname (image: `ovh-vps`) | stable part of the assistant's JWT subject (`shadowrun-table:<host>`) |
| `SR_ASSISTANT_ISSUER` | `https://shadowrun-table.internal` | issuer string of the assistant's JWTs (must match the Console) |
| `SR_ASSISTANT_DIR` | `<runtime>/assistant` | signing key, assistant settings, spend ledger |

## Security notes

- **Plain HTTP**: passwords and game traffic are not encrypted on the way. Acceptable for a game between friends;
  for TLS later, put the app behind the existing reverse proxy (a new host name → `http://127.0.0.1:8095`, set
  `SR_TRUST_PROXY=1`) — that is a change to the other stack, to do deliberately, not part of this deployment.
- GM and admin logins are rate-limited per IP (10 failures / 10 min for GM passwords and PINs, 8 / 15 min for admin).
- Anyone with a table link can join it as a **player** (as before on the LAN); PINs protect player names. Hide a table
  from the picker if you don't want it listed.
- The **demo table** (if enabled) has no GM password by design; it never reaches the assistant's API, the rulebooks,
  Foundry, the other tables' files or the map library's artwork, and it is wiped back to its pack automatically.
- Uploaded files are served with a sandbox CSP and `nosniff`; zip uploads are extracted with path-traversal checks,
  size caps and CRC verification.

## Local PC (unchanged usage)

`Lancer la table.bat` / `npm start` still works. At the first start of this version, the old `data/state.json`,
`data/backups/` and `data/uploads/` are moved into `data/tables/lazarus/` (the original state file is kept as
`data/tables/lazarus/backups/legacy-state-<date>.json`); `http://localhost:3000/` redirects to `/t/lazarus/`, old
sessions stay valid. To undo: stop the server, copy `data/tables/lazarus/state.json` back to `data/state.json`, move
`uploads/` and `backups/` back to `data/`, delete `data/server.json` and `data/tables/`, and start the previous version.

## Auto-deploy on push to `main`

The GitHub Action `.github/workflows/deploy.yml` runs on every push to `main` (and by hand: *Actions → Deploy → Run
workflow*). It SSHes into the VPS, which runs `app/deploy/autodeploy.sh`:

1. fetches `origin/main` with the VPS's read-only deploy key (`~/.ssh/shadowrun_deploy`, ssh alias `github-shadowrun`);
   nothing to do if it is already there;
2. snapshots `app/runtime/` (all tables) into `~/shadowrun-backups/runtime-<date>-<oldcommit>.tgz` (10 newest kept);
3. tags the running image `shadowrun-app:previous`, `git reset --hard` to the new commit, `docker compose up -d --build`;
4. waits up to 3 minutes for `/api/health`;
5. on failure: goes back to the previous commit and image and the job fails (GitHub emails you). Game data is never
   rolled back automatically (restore a snapshot by hand if needed). *Re-run jobs* retries the same commit.

So: **push to `main` → live about 1 minute later**, with the deploy log in the Actions tab. Pushes are deployed one at
a time (workflow `concurrency`), and a deploy keeps running on the VPS even if the job is cancelled (`ci-trigger.sh`
starts it in its own session; log in `/tmp/shadowrun-ci-deploy.log`).

How the Action gets in: repo secret `VPS_DEPLOY_KEY` is an SSH key whose line in the VPS's `~/.ssh/authorized_keys` is

```
restrict,command="/bin/bash /home/ubuntu/shadowrun/app/deploy/ci-trigger.sh" ssh-ed25519 AAAA… github-actions shadowrun-table deploy
```

so it can only start that script: no shell, no file access, no forwarding. `VPS_KNOWN_HOSTS` pins the VPS's ed25519
host key. To rotate the key: `ssh-keygen -t ed25519 -N "" -f gha_deploy`, replace that line on the VPS, then
`gh secret set VPS_DEPLOY_KEY < gha_deploy` and delete the local files. To pause auto-deploy: *Actions → Deploy →
⋯ → Disable workflow*. `deploy.ps1 -Action update` still deploys by hand.

(Until 2026-11-26 a systemd timer polled GitHub every minute instead; it has been removed from the VPS.)
