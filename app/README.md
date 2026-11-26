# Shadowrun Table — Project Lazarus

Real-time web app to run Shadowrun 5E campaigns: the GM runs it on their PC (or a VPS, see `DEPLOY.md`), players join from their browser (laptop, tablet or phone). One server can host several independent tables. The interface is in **French or English**.

## Start a session

1. Double-click **`Lancer la table.bat`** (or run `npm start` in this folder). Node.js 20+ is required; the first launch installs dependencies automatically.
2. The console prints the addresses:
   - GM: `http://localhost:3000` → tab **Maître de jeu**, password **`lazarus`** (change it in **Réglages**).
   - Players: `http://<your-LAN-IP>:3000` (e.g. `http://192.168.1.110:3000`) → they type their name, optionally a PIN, and pick their character.
3. Windows may ask to allow Node.js through the firewall the first time: allow it on **private networks**, otherwise players can't connect.
4. Stop with **Ctrl+C**. Everything is saved continuously in `data/tables/<table>/state.json`, with a backup every 15 minutes in `data/tables/<table>/backups/` (and **Réglages → Créer une sauvegarde** any time). An old `data/state.json` is migrated automatically to the table « lazarus ».

Playing remotely (not on the same Wi-Fi)? Use a tunnel such as Tailscale, ZeroTier or `cloudflared tunnel --url http://localhost:3000` and send players the address it gives.

## What's in it

| Tab | GM | Players |
|---|---|---|
| **Carte** | Live map: fog of war, line of sight, lights, doors (click to open/close/lock), drag tokens, spawn enemies from the bestiary, show a map to players, lock movement, player-view preview | Move their own token (path & distance in metres), open nearby doors, ping (Alt+click / long press) |
| **Personnages / Ma fiche** | Every sheet, editable; end-of-session rewards (karma/nuyen); rest; Chummer import/export | Their full SR5 sheet: click a skill or weapon to roll, condition monitors, Edge |
| **Bestiaire** | ~60 NPC templates (Project Lazarus cast, gangs, corp security, specialists, IC, critters, Acts 2–3 villains); spawn onto the map; **enemy generator** (archetype × Professional Rating 0–6, optional lieutenant → bestiary and/or straight onto the map/initiative) | — |
| **Matrice** | Every persona (Overwatch Score, marks, damage, convergence), hosts and IC to run, files to hide | Decker cockpit: connection mode (AR / cold / hot sim), ASDF swap, programs, marks, Matrix actions with dice, **agent** that assists (teamwork) or acts on its own |
| **Création** | Approval queue for player-made characters (review, approve/send back, create directly), open/close creation | SR5 Priority character creator, checked live, saved as drafts, sent to the GM; approved = a ready sheet |
| **Cartes** | Map list + editor (tiles, walls, doors, lights, rooms, notes, image backgrounds) — includes your 28 Foundry scenes with artwork and walls | — |
| **Boutique** | Approve orders, Cabana's deals, prices/availability rules | Buy & sell gear from the full Chummer catalogue (French names), 'ware grades |
| **Progression** | Approve training, advance downtime | Spend karma with SR5 costs & training times |
| **Ambiance** | Synced ambience/music (built-in generative tracks + your Foundry playlists), scenes, SFX board | Hear it (click « Activer le son » once) |
| **Campagne** | Acts, quests & phases, sessions, narrative threads, handouts, all campaign docs (incl. Foundry journals), GM notes | **Dossiers**: handouts you reveal + the player recap |
| Dock (right) | Journal & dice (secret rolls, speak as an NPC), initiative tracker, quick sounds | Chat, whispers, dice with Edge, initiative |

## Language

French and English. Everyone picks their own: the **FR / EN** switch in the top bar (also on the login screen, the table picker and `/admin`). The GM sets the table's default language in **Réglages → Langue de la table** (players who never chose follow it). Story content (campaign, handouts, names typed by the GM) is not translated. Missing English strings are listed in **Réglages → Traductions**.

## Several tables

`/` lists the tables, `/t/<table>/` opens one, **`/admin`** is the table manager (admin password printed once at first start, or `SR_ADMIN_PASSWORD`): create a table (empty « vierge » content or the Project Lazarus pack, default language, GM password), rename, hide, archive, download/restore a zip, open it as GM, delete (a zip is kept). Each table has its own GM password, players, sheets, maps, uploads and backups.

## Character creator

Tab **Création**: players build a runner step by step (priorities, metatype, attributes, magic, skills, qualities, gear, contacts), everything checked against SR5 rules as they go; **Envoyer au MJ** submits it. The GM reviews it in the same tab, approves (the sheet is created and assigned to the player, starting nuyen rolled if asked) or sends it back with a note, and can close creation in the queue settings.

## Matrix & agents

Tab **Matrice**: a decker connects (AR, cold or hot sim), arranges ASDF, loads programs and rolls Matrix actions against hosts, IC and devices; the Overwatch Score climbs with illegal actions. With an Agent owned and loaded (cockpit Agent panel), the action window offers **Faire assister mon agent** (teamwork roll: bonus dice and +1 limit on your next test) and **Laisser mon agent agir** (it performs the action itself, Rating × 2 dice; its Overwatch adds to yours). The GM creates hosts (make them visible to let players target them), launches IC and sees every persona.

## Foundry VTT

Your Foundry world is the source of truth for the sheets. **Réglages → Foundry VTT — synchronisation → Analyser** shows what changed since the last import (per PC: karma, nuyen, attributes, skills, items), then **Importer la sélection**. *Fusionner* keeps purchases/training done in the app; *Remplacer* takes Foundry as-is. The importer reads a copy of the world, so Foundry can stay open.

## Chummer5a

On any sheet (GM or the owning player): **Exporter vers Chummer (.chum5)** and **Mettre à jour depuis un .chum5** (shows a diff before applying). The GM can import new characters from **Personnages** and decide whether players may update their own sheet from Chummer without approval. After opening an exported file in Chummer, run *Réappliquer les améliorations* if bonuses look off.

## Story documents

The campaign docs live in `../Shadowrun/` and are readable in **Campagne → Documents**:
`session-4-plan.md` (next session), `act2-creuser-plus-profond.md`, `act3-confrontation.md`, `bible-mj-project-lazarus.md` (hidden truth, clocks, three-clue map, payouts), plus the earlier docs and `foundry/` (your Foundry journals).

## For developers

See `ARCHITECTURE.md`. Tests: `node tools/test-<module>.js` (each starts an isolated server), `node tools/smoke.js`, translations `node tools/i18n-check.js`. Regenerate the gear catalogue: `npm run build:catalog`. Re-generate seeds from Foundry: `node tools/foundry-import.js --write-seeds`.

## Live server

Hosted at **http://152.228.134.90:8095** (admin: `/admin`). Every push to `main` is deployed automatically by a GitHub Action (about a minute), with a data snapshot before each deploy and an automatic rollback if the new version doesn't start. See `DEPLOY.md` → « Auto-deploy ».
