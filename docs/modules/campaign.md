# Campaign, handouts & docs

| | |
|---|---|
| server | `server/modules/70-campaign.ts` (owner of `state.campaign`); docs routes in `server/index.ts` |
| client | `client/modules/campaign/` (CampaignPage (GM), DossiersPage (players)) |
| tests | `node tools/test-campaign.ts` (port 3913) |

## State

Types `Campaign`, `Quest`, `CampaignSession`, `CampaignThread`, `Handout`, `PlayerCampaignView`.
```js
campaign: {
  acts: [{ id, title, summary }],
  quests: [{ id, actId, title, status: 'upcoming'|'active'|'done'|'skipped', summary, phases: [{ id, title, text, done }], npcs: [templateId|actorId], maps: [mapId], rewards, gmNotes, doc?: 'file.md' }],
  sessions: [{ id, number, title, date?, plan: md, recap: md, played: bool, doc?: 'session-3-plan.md' }],
  threads: [{ id, label, state: 'open'|'resolved'|'dormant'|'dead', notes }],
  handouts: [{ id, title, body: md, image?, revealedTo: 'all'|[userId], ts }],
  playerRecap: md,           // « L'histoire jusqu'ici » shown to players
  notes: md,                 // GM scratchpad
}
```
Players receive only `handouts` revealed to them and `playerRecap`. The « Dossiers » badge counts unread handouts
(`handoutsReadAt` in the UI store).

## Campaign docs

Campaign markdown docs (the table's docs folder: `data/tables/<id>/docs/`; the legacy table reads `../Shadowrun/`
instead when that folder exists, which is only on the GM's PC: it is not in git) are served GM-only at `GET /api/docs`
and `GET /api/docs/:name` (use `api()`). Foundry journals land in `docs/foundry/` ([foundry.md](foundry.md)). The GM
assistant reads them too ([assistant.md](assistant.md)). Updating them on the VPS: [deploy.md](../deploy.md).

## Actions

Acts `campaign/addAct|updateAct|deleteAct|setCurrentAct`; quests `campaign/addQuest|updateQuest|deleteQuest|moveQuest|
setQuestStatus`, phases `campaign/togglePhase|addPhase|updatePhase|deletePhase|movePhase`; `campaign/addSession|
updateSession|deleteSession`; `campaign/addThread|updateThread|deleteThread|moveThread`; handouts `campaign/addHandout|
updateHandout|deleteHandout|revealHandout|hideHandout`; `campaign/updateNotes`, `campaign/updatePlayerRecap`.

## Campaign facts (for content)

Seattle 2080, SR5. PCs: **Anthony Von Schloss** (street samurai / blades, player Anthony H.), **Jane** (face / social
adept / sniper, player Baptiste), **Bricks** (decker, ex-Knight Errant spider, player Sploadie). Ank'Lay (ork brawler)
retired. Full sheets in `../Shadowrun/campaign-recap.md`; plot in `campaign-outline.md`, `act1-loose-ends.md`, session
plans. Antagonist: AG Chemie via shell company Hollow Pine Holdings (Dorian Ashe), Project Lazarus. Fixer: Perrine
Cabana.
