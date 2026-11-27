<div align="center">

# ◢ SHADOWRUN TABLE ◣

**A real-time, self-hosted virtual tabletop built for Shadowrun 5th Edition.**

The GM runs one small Node server. Players join from any browser — laptop, tablet or phone.
Maps, sheets, dice, the Matrix, the shop and the soundtrack stay in sync for everyone.

![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=flat-square&logo=node.js&logoColor=white)
![Vite](https://img.shields.io/badge/vite-8-646cff?style=flat-square&logo=vite&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-migrating-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Socket.IO](https://img.shields.io/badge/socket.io-realtime-010101?style=flat-square&logo=socket.io&logoColor=white)
![Docker](https://img.shields.io/badge/docker-ready-2496ed?style=flat-square&logo=docker&logoColor=white)
![FR / EN](https://img.shields.io/badge/UI-FR%20%7C%20EN-05d9e8?style=flat-square)

**[▶ Try the live demo table](https://DEMO-URL-TO-COME/t/demo/)** — no account, no password: enter as GM or as a player.
<br><sub>A public sandbox, wiped every night. The link goes live once HTTPS is set up.</sub>

</div>

---

## Why

Generic VTTs make you fight the system: SR5 has dice pools, limits, Edge, three initiative passes, the Matrix, 'ware
grades, availability rolls and a 600-page catalogue. This app knows all of it, so the table spends its time on the run,
not on bookkeeping. It started as the engine for a French campaign, *Project Lazarus*, and grew into a general tool:
one server can host several independent tables.

## Features

<table>
<tr>
<td width="50%" valign="top">

### 🗺️ Live maps
Fog of war, line of sight, lights, doors you can open, close and lock, tokens with path and distance in metres, pings.
A built-in tile editor (walls, rooms, furniture) plus image backgrounds and imported Foundry scenes.

### 🎲 Full character sheets
Click a skill or weapon to roll the right pool with its limit. Condition monitors, Edge, modifiers from qualities,
'ware and spells applied automatically. Optional 3D dice.

### ⚔️ Combat
Initiative tracker with passes, an attack tray (firing modes, bursts, called shots, cover), a bestiary of ~60 NPC
templates and an **enemy generator** by archetype and Professional Rating.

### 🧬 Character creation
The SR5 Priority system, validated live. Players build drafts, the GM approves them, and they become ready sheets.

</td>
<td width="50%" valign="top">

### 💻 The Matrix
A decker cockpit (AR / cold sim / hot sim, ASDF swap, programs, marks, Overwatch Score, convergence), hosts and IC on
the GM side, agents that assist or act on their own, devices linked to the map.

### 🛒 Shop & progression
The full Chummer catalogue (French and English names), 'ware grades, availability tests, GM-approved orders. Karma
spending with SR5 costs and training times, downtime advances.

### 🎧 Ambience
Synced music and ambiences for the whole table: built-in generative tracks, your own playlists, scenes and an SFX
board.

### 📜 Campaign tools
Acts, quests, sessions, narrative threads, handouts you reveal to players, GM notes, contacts and SINs, rulebook page
references that open the right PDF page.

</td>
</tr>
</table>

**Also:** Chummer5a `.chum5` import/export · Foundry VTT world import (scenes, actors, journals, playlists) ·
multi-table hosting with an `/admin` panel · per-user French/English UI · zip backup and restore · an optional
Claude-powered GM assistant.

## Try it

The live demo is a **public table** on the author's server: open it, pick **Maître de jeu** (no password) or type a
name and pick one of the four pre-made runners. It comes with a warehouse map, a gang to fight, a Matrix host whose
devices open the map's doors, and a short scenario in the **Campagne** tab. Open it again in a private window to play
the players' side at the same time. Everything is visible to other visitors and wiped at the next reset; the GM
assistant, rulebooks and Foundry import are off there. Run your own with `SR_DEMO_TABLE=demo npm start`
(see [app/DEPLOY.md](app/DEPLOY.md#4b-public-demo-table)).

## Quick start

> Requires **Node.js 20+**.

```bash
cd app
npm install
npm run build   # sub-second Vite build of the browser client
npm start
```

For development, `npm run dev` runs the server with hot reload instead (no build needed).

Then open:

| Who | Where |
|---|---|
| GM | `http://localhost:3000` → **Maître de jeu**, default password `lazarus` (change it in **Réglages**) |
| Players | `http://<your-LAN-IP>:3000` → type a name, pick a character |
| Admin | `http://localhost:3000/admin` → password printed once in the console at first start |

On Windows you can just double-click **`app/Lancer la table.bat`**. Playing remotely? Put the server behind a tunnel
(Tailscale, ZeroTier, `cloudflared tunnel --url http://localhost:3000`) or deploy it.

## Deploying

The app ships with a `Dockerfile` and `docker-compose.yml`. All game data lives in a single bind-mounted `runtime/`
folder, so rebuilding the image never touches it. See **[app/DEPLOY.md](app/DEPLOY.md)** for the full VPS setup,
push-to-deploy GitHub Action and backup routine.

## Under the hood

```
app/
├── server/            Express + Socket.IO; one action dispatcher, per-user state views
│   ├── modules/       feature modules (maps, combat, shop, matrix, …), auto-loaded in order
│   └── lib/           tables, Chummer, Foundry, rulebooks, assistant
├── shared/            pure SR5 rules used by both server and browser (dice, derive, matrix, chargen…)
├── client/            browser UI, bundled by Vite (moving from Preact + htm to React + TypeScript)
│   ├── modules/       one folder per tab
│   └── i18n/en/       English dictionaries (French is the source text)
├── data/              rules catalogue, seed content, content packs
└── tools/             catalogue builders, importers, test suites
```

- **Fast loop.** `npm run dev` hot-reloads the client; the production build takes under a second.
- **Rules live in `shared/`**, so the server validates every action with the same code the UI uses to preview it.
- **Ambiguous rules follow Chummer**, so imported characters compute the same numbers in both tools.
- **State is a JSON file per table**, written atomically, with rolling backups every 15 minutes.

The full module contract is in **[app/ARCHITECTURE.md](app/ARCHITECTURE.md)** and the user guide in
**[app/README.md](app/README.md)**.

## Tests

Each area has its own script in `app/tools/` (they spin up a throwaway server):

```bash
cd app
node tools/test-combat.ts
node tools/test-matrix.ts
```

## Credits

- Rules data derived from **[Chummer5a](https://github.com/chummer5a/chummer5a)**.
- Music packs (not in the repo): **Karl Casey @ White Bat Audio** and **Dan Cramp — *Void*** (CC BY 4.0).

## Legal

This is an unofficial fan project, not affiliated with or endorsed by The Topps Company or Catalyst Game Labs.
*Shadowrun* is a registered trademark of The Topps Company, Inc. No rulebook text, artwork or paid map content is
included in this repository: rulebook PDFs and map images are loaded locally by their owner.
