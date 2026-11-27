# Core: config, users, chat & log

Core-owned slices (`server/index.ts`, actions in `server/modules/00-core.ts`). Types: `TableConfig`, `User`, `ViewMe`,
`LogEntry` in `shared/types.ts`. Logins, sessions and tables: [multi-table.md](multi-table.md).

## State

```js
config: { gmPassword, campaignName, lang: 'fr'|'en' (table default), gmLang?: 'fr'|'en'|null } // view: { campaignName, lang, table: { id, slug, name, lang } } (no password, no gmLang)
users: { [id]: { id, name, pin, characterIds, lang?: 'fr'|'en'|null } }   // lang = the player's own choice (null = follow the table)
sessions: { [token]: userId }                    // never sent
log: [LogEntry]                                  // max 600
ui: { announcement: string|null }
online: [userId]                                 // view only
me: { id, role, name, characterIds, lang }       // view only; lang = own choice or null (GM: config.gmLang)
```
`LogEntry = { id, ts, kind: 'chat'|'whisper'|'roll'|'system'|'combat'|'shop'|'training'|'matrix', userId?, author,
text, i18n?: { key, params? }, to?: userId[] (whisper; 'gm' always included), gmOnly?: bool, roll?: RollResult & {
label, pool, actorId?, edge? } }` — display with `logText(entry)`; `text` is the French rendering (filled from `i18n`
when omitted). Rolls: [dice.md](dice.md).
Players never see `gmOnly` entries or whispers not addressed to them (core filter).

`config.campaignName` is also the table's display name ([multi-table.md](multi-table.md)).

## Actions (`00-core.ts`)

| action | role | payload / effect |
|---|---|---|
| `chat/send` | any | `{ text, to?: userId[] (whisper), as?: actorId (speak as character/NPC, GM or owner) }` |
| `log/clear`, `log/delete` | GM | clear the log / delete one entry |
| `config/update` | GM | `{ campaignName?, gmPassword?, lang?: 'fr'\|'en' }` |
| `users/setLang` | any | `{ lang: 'fr'\|'en'\|null }` own UI language (players: `users[id].lang`, GM: `config.gmLang`), see [i18n](../i18n.md) |
| `users/assign` | GM | `{ userId, characterId, assign }` give or remove a character |
| `users/remove`, `users/resetPin` | GM | `users/resetPin` logs a notice to the player (without a PIN anyone could log in under their name) |
| `ui/announce` | GM | banner text shown on every screen (null to clear) |
| `ui/ping` | any | transient « look here » ping `{ mapId, x, y }` (cell coords, may be fractional) |
