# Shadowrun Table — Project Lazarus

Real-time web app to run the campaign: the GM runs it on their PC, players join from their browser (laptop, tablet or phone) on the same network.

## Start a session

1. Double-click **`Lancer la table.bat`** (or run `npm start` in this folder). Node.js 20+ is required; the first launch installs dependencies automatically.
2. The console prints the addresses:
   - GM: `http://localhost:3000` → tab **Maître de jeu**, password **`lazarus`** (change it in **Réglages**).
   - Players: `http://<your-LAN-IP>:3000` (e.g. `http://192.168.1.110:3000`) → they type their name, optionally a PIN, and pick their character.
3. Windows may ask to allow Node.js through the firewall the first time: allow it on **private networks**, otherwise players can't connect.
4. Stop with **Ctrl+C**. Everything is saved continuously in `data/state.json`, with a backup every 15 minutes in `data/backups/` (and **Réglages → Créer une sauvegarde** any time).

Playing remotely (not on the same Wi-Fi)? Use a tunnel such as Tailscale, ZeroTier or `cloudflared tunnel --url http://localhost:3000` and send players the address it gives.

## What's in it

| Tab | GM | Players |
|---|---|---|
| **Carte** | Live map: fog of war, line of sight, lights, doors (click to open/close/lock), drag tokens, spawn enemies from the bestiary, show a map to players, lock movement, player-view preview | Move their own token (path & distance in metres), open nearby doors, ping (Alt+click / long press) |
| **Personnages / Ma fiche** | Every sheet, editable; end-of-session rewards (karma/nuyen); rest; Chummer import/export | Their full SR5 sheet: click a skill or weapon to roll, condition monitors, Edge |
| **Bestiaire** | ~60 NPC templates (Project Lazarus cast, gangs, corp security, specialists, IC, critters, Acts 2–3 villains); spawn onto the map | — |
| **Cartes** | Map list + editor (tiles, walls, doors, lights, rooms, notes, image backgrounds) — includes your 28 Foundry scenes with artwork and walls | — |
| **Boutique** | Approve orders, Cabana's deals, prices/availability rules | Buy & sell gear from the full Chummer catalogue (French names), 'ware grades |
| **Progression** | Approve training, advance downtime | Spend karma with SR5 costs & training times |
| **Ambiance** | Synced ambience/music (built-in generative tracks + your Foundry playlists), scenes, SFX board | Hear it (click « Activer le son » once) |
| **Campagne** | Acts, quests & phases, sessions, narrative threads, handouts, all campaign docs (incl. Foundry journals), GM notes | **Dossiers**: handouts you reveal + the player recap |
| Dock (right) | Journal & dice (secret rolls, speak as an NPC), initiative tracker, quick sounds | Chat, whispers, dice with Edge, initiative |

## Foundry VTT

Your Foundry world is the source of truth for the sheets. **Réglages → Foundry VTT — synchronisation → Analyser** shows what changed since the last import (per PC: karma, nuyen, attributes, skills, items), then **Importer la sélection**. *Fusionner* keeps purchases/training done in the app; *Remplacer* takes Foundry as-is. The importer reads a copy of the world, so Foundry can stay open.

## Chummer5a

On any sheet (GM or the owning player): **Exporter vers Chummer (.chum5)** and **Mettre à jour depuis un .chum5** (shows a diff before applying). The GM can import new characters from **Personnages** and decide whether players may update their own sheet from Chummer without approval. After opening an exported file in Chummer, run *Réappliquer les améliorations* if bonuses look off.

## Story documents

The campaign docs live in `../Shadowrun/` and are readable in **Campagne → Documents**:
`session-4-plan.md` (next session), `act2-creuser-plus-profond.md`, `act3-confrontation.md`, `bible-mj-project-lazarus.md` (hidden truth, clocks, three-clue map, payouts), plus the earlier docs and `foundry/` (your Foundry journals).

## For developers

See `ARCHITECTURE.md`. Tests: `node tools/test-<module>.js` (each starts an isolated server), `node tools/smoke.js`. Regenerate the gear catalogue: `npm run build:catalog`. Re-generate seeds from Foundry: `node tools/foundry-import.js --write-seeds`.
