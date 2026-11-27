# Notes (private & party notes)

| | |
|---|---|
| server | `server/modules/75-notes.ts` (owner of `state.notes`) |
| client | `client/modules/notes/` (NotesPage, NoteEditor, `notes-md.ts`); English `client/i18n/en/notes.json` |
| tests | `node tools/test-notes.ts` (ports 3150-3199) |

Main tab `notes` (GM + players): each user has a **private** note space, the party has a **collaborative** one the GM
reads too.

## State

Types `NotesState`, `NotePage`, `NoteComment`, `NotesView`.
```js
notes: {
  pages: { [id]: { id, scope: 'private'|'party', ownerId (userId, private only), title (≤120), body (markdown, ≤100 000 chars), shareWithGM (private only),
    folder (≤60, '' = none), pinned, createdBy, updatedBy, createdAt, updatedAt, version (counts BODY changes),
    lock?: { userId, name, until } (party only, 60 s), deleted?: { at, by } (trash, purged after 7 days) } },
  comments: { [pageId]: [{ id, userId, author, text (≤2000), ts }] },
  settings: { gmCanEditParty: false },
}
// view only: notes.now = server time (clients estimate the clock skew for lock expiry)
```
`state.notes` is excluded from the core's deep clone in `buildView`; the module builds `view.notes` per user
(filter/gmFilter).

## Visibility and rights

- **Visibility** (`filter` AND `gmFilter`, the GM view is filtered too): a private page goes to its owner only, and to
  the GM while `shareWithGM` (read-only, the GM may comment). Party pages go to every user of the table. Comments
  follow their page. Any action on a page the user cannot read answers « Note introuvable » (existence never
  revealed). Private actions never log nor emit to anyone else.
- **Limits** (`MAX_*` constants of 75-notes.ts): 300 private pages per owner and 500 party pages per table (trash
  included), 100 000 chars per note, 1 M private chars per owner (trash included), 5 M chars per table (bodies +
  comments), 300 comments per page, 1000 comments per author. Private pages of removed users are dropped.
- **Write rights**: private → owner only (the GM may keep private GM notes the same way). Party → any player; the GM
  only with `settings.gmCanEditParty` (`notes/settings`, GM). Delete = soft (trash, restorable 7 days): private →
  owner; party → any player or the GM. Purge (only from the trash): private → owner; party → creator or GM.
- The GM's « Télécharger la partie » (`/api/admin/export`) leaves out unshared private notes; server backups (host/admin)
  keep everything. `users/resetPin` logs a notice to the player.

## Actions

All `role: 'any'` except settings:
- `notes/create { scope, title, folder?, body? } → { id }` (party: logs `kind:'system'` « Nouvelle note de groupe :
  {title} »).
- `notes/save { id, body?, title?, baseVersion } → { version, updatedAt } | { conflict: true, server: { title, body,
  version, updatedBy, updatedAt } }` (conflict only when the body changes from a stale `baseVersion`; titles/folders/
  pins are last-write-wins).
- `notes/rename { id, title?, folder?, pinned? }`, `notes/delete { id, force? }` (refused while another user holds a
  live lock on the party page, unless `force`), `notes/restore`, `notes/purge { id }`, `notes/setShare { id,
  shareWithGM }` (owner).
- `notes/lock { id, force? } → { locked: false, until } | { locked: true, lock }` (party pages; private → `{ locked:
  false, until: null }`), `notes/unlock { id }`.
- `notes/comment { id, text }` (party pages, or private pages shared with the GM: owner + GM), `notes/deleteComment {
  id, commentId }` (author, GM, or the private page's owner), `notes/settings { gmCanEditParty }` (GM).
- Transient event `notes:comment { pageId, title, author }` → the page's other readers only.

## Client

Two panes (« Mes notes », « Notes du groupe », GM: « Notes partagées par les joueurs » grouped by player; search in
titles/bodies/folders; folders; pinned first; « Corbeille ») | editor (title, folder, pin, share toggle, Écrire / Côte
à côte / Aperçu, toolbar bold/italic/heading/list/checkbox/quote/[[link]], Ctrl+B/I/S, comments). Single pane with a
back button under 800 px. Autosave 1.5 s after typing stops, on blur, on leave/hidden tab; status Enregistré /
Modifié… / Enregistrement… / Conflit; conflict dialog: keep mine (re-save on the server version) / take theirs / copy
mine. Soft lock: taken on focus/typing of a party page, renewed every 20 s while typing (released after 45 s idle or on
leave); others see « X est en train d’écrire… » and may « Modifier quand même » after a confirm (`force`).

Markdown (`client/modules/notes/notes-md.ts`, pure, tested in Node): the shared `renderMarkdown()` + `[[Titre]]` links
(`#note:<id>`, or `#new:<title>` to create the missing page), `@Nom` mention badges (PC names, first names, player
names), clickable `- [ ]` task checkboxes (toggling edits the source line). Checkboxes carry `data-line`;
`toggleCheckboxAt(body, line)` toggles them outside code blocks.

## Tests

`node tools/test-notes.ts` (ports 3150-3199): pure helpers, private isolation (other player, GM before/after share,
other table), party visibility across one table only (second table created through the admin API), permissions,
version conflict, lock lifecycle, trash/restore/purge, comments + events, payload validation. i18n:
`node tools/i18n-check.ts --area notes --strict` (client) and `node tools/i18n-check.ts server/modules/75-notes.ts
--strict` (server keys).
