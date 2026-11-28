# GM assistant (Claude)

| | |
|---|---|
| server | `server/modules/95-assistant.ts`, `server/lib/assistant/` (`auth.ts`, `config.ts`, `budget.ts`, `run.ts`, `context.ts`, `tools.ts`, `diff.ts`, `conversations.ts`, `admin-routes.ts`) |
| client | `client/modules/assistant/` (AssistantDock) + `client/modules/admin/AssistantAdmin.tsx`; French `client/i18n/fr/assistant.json` |
| tests | `node tools/test-assistant.ts` (ports 3990-3999) |

GM dock tab « Assistant » (GM only): a chat with Claude about the campaign, the SR5 rules and the live game. **No state
slice**: conversations and proposals live in `tables/<id>/assistant.json` (never broadcast, never in any view);
server-wide settings, spend ledger and signing key in `<runtime>/assistant/` (`SR_ASSISTANT_DIR`). Setup on the VPS:
[deploy.md](../deploy.md) « GM assistant ».

- **Auth** (`auth.ts`): Workload Identity Federation. The server is its own OIDC issuer: EC P-256 key `signing-key.pem`
  (0600), public JWKS shown in /admin to paste in the Claude Console (Custom OIDC, inline JWKS); each token exchange
  signs a fresh ES256 JWT (`iss` = `SR_ASSISTANT_ISSUER`, `sub` = `shadowrun-table:<SR_ASSISTANT_HOST>`, 10 min, unique
  `jti`) passed to the SDK's `oidcFederationProvider` (env `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`,
  optional `ANTHROPIC_WORKSPACE_ID` / `ANTHROPIC_SERVICE_ACCOUNT_ID`). `ANTHROPIC_API_KEY` is the local-development
  fallback.
- **Settings** (`config.ts`, /admin → Assistant IA, `GET/PATCH /api/admin/assistant`, `POST …/test`, `POST
  …/reset-month`): `enabledTables` (off by default), `model` (`claude-opus-5-5` default, Sonnet/Haiku 5.5), `effort`
  (`medium`), `monthlyCapUsd` (80, all tables together).
- **Budget** (`budget.ts`): every API response's `usage` is priced (input, output, cache reads, cache writes at the
  1-hour rate unless split) and added to `usage.json` per UTC month and per table. Questions are refused (402) when
  `spent + 0.50 > cap`, re-checked before each tool-loop step. The Console workspace spend limit is the hard stop.
- **Request** (`run.ts`, `context.ts`): streamed `client.beta.messages.stream` with adaptive thinking,
  `output_config.effort`, server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`,
  Opus/Sonnet), `max_tokens` 32000, at most `MAX_STEPS` = 8 API calls per question. Cached prefix (1-hour TTL): tool
  definitions + instructions + core docs (GM bible, recap, outline, latest `session-N-plan`, ≤ 160 K chars) + the list
  of every doc. Live state is NOT in the prefix: tools read it, and each question carries one « [État de la table …] »
  line. Text deltas → `emitTo('gm', 'assistant:delta', { conversationId, text })`, then `assistant:step { phase }` and
  `assistant:done`. One run per table at a time (409); `POST /api/assistant/stop` aborts.
- **Tools** (`tools.ts`): read — `list_docs`, `read_doc` (pages of 40 K chars), `search_docs`, `get_campaign`
  (long texts shortened), `get_campaign_entry` (one entry in full), `list_actors`, `get_actor` (minus Chummer XML),
  `list_maps`, `get_map`, `get_bestiary`, `get_combat`, `get_log`, `search_catalog`. Propose — `propose_map` (full
  tile map + doors/regions/GM notes/lights → `maps/import`), `propose_map_edits`
  (`maps/paint|addDoor|addRegion|addNote|addLight`), `propose_npc` (`bestiary/create`), `propose_handout`
  (`campaign/addHandout`, unrevealed), `propose_campaign_entry` (new act, quest, phase, session, thread; text appended
  to a session plan or the GM notes), `propose_campaign_edit`, `propose_doc_edit`. A proposal is validated by running
  its actions on a deep copy of the state (`simulateAction`, core) and stored with a preview; nothing changes until
  `POST /api/assistant/proposals/:id/apply`, which rebuilds the ops from the current state and runs them with
  `runAction` (core: the same path as socket actions — save, broadcast). No tool reveals anything to players, touches
  PCs, deletes, rolls or posts in the chat.
- **Campaign edits** (`propose_campaign_edit`): any existing act, quest, quest phase, session, plot thread, handout,
  the GM notes or the player recap (`TARGETS` in `tools.ts` lists the editable fields and the `campaign/update*`
  action of each). `set` gives fields a new value; `edits` are exact find/replace steps inside text fields
  (`diff.ts` `applyEdits`: the passage must appear once unless `all`). The ops are rebuilt at apply time, so edits
  land on the text as it is then and the GM's changes in between are kept; a passage no longer there fails the
  proposal. A long text replaced whole by `set` is guarded: the proposal stores a hash of the old text (`guard`,
  never sent to the client) and apply refuses when it changed. An entry named by title is pinned to its id when
  proposed. Edits to the player recap or to a revealed handout are flagged on the card (`preview.playersSee`).
- **Document edits** (`propose_doc_edit`, kind `doc`): `edits` (exact find/replace) on an existing doc of the table's
  docs folder, or `content` for a new doc (one folder level at most, `context.ts` `docName`) or a whole rewrite of a
  doc under 40 K chars (guarded like `set`). Line endings of the file are kept. Apply writes a temp file then renames
  it; the previous version is copied first to `tables/<id>/doc-backups/<timestamp>__<name>`. Not a game action: the
  file is written by the apply route itself (`buildDocWrite`, `writeDocFile`).
- **Preview diff** (`diff.ts` `diffLines`): line diff (common prefix/suffix, then LCS) as hunks with 2 lines of
  context, at most 400 lines shown; the card (`DiffView` in AssistantDock) shows removed lines red, added green.
- **Routes** (GM, table must be enabled): `GET /api/assistant/status`, `GET|POST /api/assistant/conversations`,
  `GET|DELETE /api/assistant/conversations/:id` (view = items `user | assistant | tool | proposal | notice`; raw API
  messages stay server-side), `POST /api/assistant/ask { conversationId?, text, lang }` → `{ conversationId }` (the
  answer streams over the socket), `POST /api/assistant/stop`, `POST /api/assistant/proposals/:id/apply|dismiss`.
- Core additions: `runAction` / `simulateAction` ([architecture.md](../architecture.md#server-module-contract)).
- Demo tables refuse the assistant ([demo-table.md](demo-table.md)).
- Tests: `node tools/test-assistant.ts` (ports 3990-3999) — a local fake Claude API (`ANTHROPIC_BASE_URL`) replays
  scripted streamed responses: JWT signature/claims, pricing and ledger, gating (admin/GM/player/disabled table), tool
  loop and step limit, proposals (map, invalid map → tool error, NPC, unrevealed handout, quest) applied through the
  normal actions, campaign edits (exact edits re-applied after a GM change, `set` refused when the text changed,
  player recap flagged), document edits and new documents (line endings kept, backup written), nothing leaks to
  players, cap → 402. i18n: `node tools/i18n-check.ts --area assistant --strict`.
