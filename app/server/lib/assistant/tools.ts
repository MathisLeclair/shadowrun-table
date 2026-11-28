// GM assistant — tools the model may call.
// Read tools return live game data (GM view). Propose tools never change the game: they validate the change by
// running the real action(s) on a throwaway copy of the state (simulateAction) and store a proposal the GM
// applies with one click (runAction, same path as the GM's own clicks).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { uid } from '../../../shared/util.ts';
import { listDocs, docPath, docName, docTarget } from './context.ts';
import { applyEdits, cleanEdits, diffLines, toLF } from './diff.ts';
import type { FieldDiff } from './diff.ts';
import { QUEST_STATUS, THREAD_STATES } from '../../modules/70-campaign.ts';
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ActionPayload, ActionResponse, Actor, Campaign, GameMap, I18nParams, TableState } from '../../../shared/types.ts';
import type { Proposal, ProposalKind, ProposalPreview, ToolInput } from './conversations.ts';

/** Runs an action on a throwaway copy of the state (server/index.ts simulateAction, bound to the table and the GM). */
export type SimulateFn = (type: string, payload: ActionPayload, state?: TableState) => ActionResponse & { state: TableState };
/** What a tool call gets: the live state (GM view), the docs folder, and the proposal plumbing. */
export interface ToolEnv {
  state: TableState;
  docsDir: string;
  simulate: SimulateFn;
  toolUseId: string;
  addProposal(p: Proposal): void;
}
/** One action of a proposal. */
export interface ProposalOp {
  type: string;
  payload: ActionPayload;
}
/**
 * Actions of a proposal, built from the CURRENT state. `changes` = before/after diff for the card; `guard` = hash of
 * the texts a whole-text `set` replaces (apply refuses when they changed since the proposal); `playersSee` = the
 * change is visible to players (player recap, revealed handout); `resolved` = ids of the entries named by title, kept in
 * the stored input so that a rename before « Appliquer » does not lose the entry.
 */
export type BuiltOps =
  | { ops: ProposalOp[]; label?: string; changes?: FieldDiff[]; guard?: string; playersSee?: boolean; resolved?: Record<string, string>; error?: undefined }
  | { error: string; ops?: undefined; label?: undefined; changes?: undefined; guard?: undefined; playersSee?: undefined; resolved?: undefined };
/** A tool's own result: text for the model, or an error it may fix. */
type ToolOut = string | { error: string };
export interface ToolLabel {
  key: string;
  params?: I18nParams;
}

/** Marks a French key for tools/i18n-check.ts (translated by the client). */
const tk = (s: string): string => s;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = path.resolve(HERE, '../../../data/catalog');
const MAX_RESULT_CHARS = 60_000;
const DOC_PAGE = 40_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const json = (v: unknown): string => {
  const s = JSON.stringify(v, null, 1);
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + '\n…[tronqué]' : s;
};
// Non-string values pass through unchanged (as stored).
const clip = <T,>(s: T, n: number): T | string => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s ?? '');
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Actor as the GM sees it, minus heavy/import-only fields. */
function actorForModel(a: Actor | undefined) {
  if (!a) return null;
  const { chummer, foundry, history, ...rest } = a;
  return { ...rest, history: (history || []).slice(-10) };
}
function actorSummary(a: Actor) {
  return {
    id: a.id, name: a.name, type: a.type, metatype: a.metatype, concept: a.concept || '', player: a.player || undefined,
    hidden: a.hidden || undefined, retired: a.retired || undefined, templateId: a.templateId || undefined,
    condition: a.condition, karma: a.type === 'pc' ? a.karma : undefined, nuyen: a.type === 'pc' ? a.nuyen : undefined,
  };
}
function mapForModel(m: GameMap | undefined) {
  if (!m) return null;
  const { explored, ...rest } = m;
  return rest;
}

let catalogCache: any[] | null = null; // catalog JSON (foreign data)
function catalogItems(): any[] {
  if (catalogCache) return catalogCache;
  catalogCache = [];
  try {
    for (const f of fs.readdirSync(CATALOG_DIR)) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      const data = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8'));
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      for (const it of list) catalogCache.push({ file: f.replace(/\.json$/, ''), ...it });
    }
  } catch (err) {
    console.error('[assistant] catalog load failed', err);
  }
  return catalogCache;
}
const norm = (s: unknown): string => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------------------
// Tool definitions (order is fixed: it is part of the cached prefix)
// ---------------------------------------------------------------------------
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const S = { type: 'string' };
const I = { type: 'integer' };
const cellList = (props: Record<string, unknown>) => ({ type: 'array', items: { type: 'object', properties: props, required: ['x', 'y'] } });

const REGION = { name: S, x: I, y: I, w: I, h: I, color: S, gmOnly: { type: 'boolean' } };
const NOTE = { x: I, y: I, text: S };
const LIGHT = { x: I, y: I, radius: { type: 'number' }, color: S };
const DOOR = { x: I, y: I, state: { type: 'string', enum: ['open', 'closed', 'locked'] }, kind: { type: 'string', enum: ['door', 'gate', 'shutter', 'secret'] }, name: S };

// Campaign tracker entries the assistant can edit: their collection, update action and editable fields.
type FieldKind = 'text' | 'short' | 'bool' | 'int' | 'enum';
interface CampaignTarget {
  /** Campaign collection (none: phase, gm_notes, player_recap). */
  coll?: 'acts' | 'quests' | 'sessions' | 'threads' | 'handouts';
  action: string;
  /** Payload key of the entry id. */
  idKey?: string;
  fields: Record<string, FieldKind>;
  /** Field edited when an edit names none. */
  main: string;
}
const TARGETS: Record<string, CampaignTarget> = {
  act: { coll: 'acts', action: 'campaign/updateAct', idKey: 'actId', fields: { title: 'short', summary: 'text' }, main: 'summary' },
  quest: { coll: 'quests', action: 'campaign/updateQuest', idKey: 'questId', fields: { title: 'short', status: 'enum', actId: 'short', summary: 'text', rewards: 'text', gmNotes: 'text', doc: 'short' }, main: 'summary' },
  phase: { action: 'campaign/updatePhase', fields: { title: 'short', text: 'text', done: 'bool' }, main: 'text' },
  session: { coll: 'sessions', action: 'campaign/updateSession', idKey: 'sessionId', fields: { number: 'int', title: 'short', date: 'short', plan: 'text', recap: 'text', played: 'bool', doc: 'short' }, main: 'plan' },
  thread: { coll: 'threads', action: 'campaign/updateThread', idKey: 'threadId', fields: { label: 'short', state: 'enum', notes: 'text' }, main: 'notes' },
  handout: { coll: 'handouts', action: 'campaign/updateHandout', idKey: 'handoutId', fields: { title: 'short', body: 'text', gmNotes: 'text' }, main: 'body' },
  gm_notes: { action: 'campaign/updateNotes', fields: { text: 'text' }, main: 'text' },
  player_recap: { action: 'campaign/updatePlayerRecap', fields: { text: 'text' }, main: 'text' },
};
const ENUMS: Record<string, readonly string[]> = { status: QUEST_STATUS, state: THREAD_STATES };
const CAMPAIGN_TARGETS = Object.keys(TARGETS);
const CAMPAIGN_FIELDS_HELP = Object.entries(TARGETS)
  .map(([k, d]) => `${k}: ${Object.entries(d.fields).map(([f, kind]) => (kind === 'enum' ? `${f} (${ENUMS[f].join('|')})` : f)).join(', ')}`)
  .join('; ');

export const TOOL_DEFS: BetaTool[] = [
  { name: 'list_docs', description: 'List the campaign documents (markdown) with their sizes.', input_schema: obj({}) },
  {
    name: 'read_doc',
    description: `Read a campaign document. Long documents come in pages of ${DOC_PAGE} characters: pass offset to continue.`,
    input_schema: obj({ name: { type: 'string', description: 'Document name as listed, e.g. "act2-creuser-plus-profond.md" or "foundry/Seattle - Redmond.md".' }, offset: I }, ['name']),
  },
  {
    name: 'search_docs',
    description: 'Search every campaign document for words (case and accent insensitive). Returns matching lines with their document and line number, plus a little context.',
    input_schema: obj({ query: { type: 'string', description: 'One or more words; lines containing all of them match.' } }, ['query']),
  },
  { name: 'get_campaign', description: 'Acts, quests (status, phases), sessions (plans and recaps), plot threads, handouts (title, revealed or not), the GM notes and the player recap, as stored in the app, with ids. Long texts are shortened: read one entry in full with get_campaign_entry.', input_schema: obj({}) },
  {
    name: 'get_campaign_entry',
    description: 'One campaign tracker entry in full (no text shortened), to quote it exactly before editing it.',
    input_schema: obj({
      target: { type: 'string', enum: CAMPAIGN_TARGETS },
      id: { type: 'string', description: 'Id (or exact title) of the act, quest, session, thread or handout; for a phase, the phase id or title (with questId). Not needed for gm_notes and player_recap.' },
      questId: { type: 'string', description: 'Quest of the phase (target phase).' },
    }, ['target']),
  },
  { name: 'list_actors', description: 'List characters: PCs and spawned NPCs (id, name, metatype, concept, condition…).', input_schema: obj({ type: { type: 'string', enum: ['pc', 'npc', 'all'] } }) },
  { name: 'get_actor', description: 'Full sheet of one character (attributes, skills, gear, augmentations, notes incl. GM notes).', input_schema: obj({ id: S }, ['id']) },
  { name: 'list_maps', description: 'List the maps (id, name, folder, size, theme, whether players currently see it).', input_schema: obj({}) },
  { name: 'get_map', description: 'One map in full: tiles, doors, lights, regions, GM notes, tokens (including hidden ones).', input_schema: obj({ id: S }, ['id']) },
  { name: 'get_bestiary', description: 'NPC templates of the bestiary. Without id: the list (id, name, folder, concept). With id: one template in full.', input_schema: obj({ id: S }) },
  { name: 'get_combat', description: 'Current combat: round, pass, initiative order and who acted.', input_schema: obj({}) },
  { name: 'get_log', description: 'Recent entries of the table log (chat, rolls, system messages), newest last.', input_schema: obj({ limit: { type: 'integer', description: 'Default 40, max 150.' } }) },
  {
    name: 'search_catalog',
    description: 'Search the gear catalog (weapons, armor, gear, cyberware, bioware, vehicles, spells, adept powers, qualities, programs, lifestyles) by name in English or French. Returns name, category, cost, availability and stats.',
    input_schema: obj({ query: S, file: { type: 'string', enum: ['weapons', 'armor', 'gear', 'cyberware', 'bioware', 'vehicles', 'spells', 'powers', 'qualities', 'programs', 'lifestyles'] } }, ['query']),
  },
  {
    name: 'propose_map',
    description: 'Propose a NEW map (tile grid). Creates a proposal card with a preview; the map is created only if the GM applies it, and is never shown to players until the GM activates it.',
    eager_input_streaming: true,
    input_schema: obj({
      name: S,
      folder: { type: 'string', description: 'Folder in the maps list, e.g. "Acte 2".' },
      description: { type: 'string', description: 'GM-only markdown description: what is here, guards, loot, hooks.' },
      theme: { type: 'string', enum: ['street', 'bar', 'corp', 'lab', 'industrial', 'residential', 'matrix', 'club'] },
      lighting: { type: 'string', enum: ['bright', 'dim', 'dark'] },
      width: I,
      height: I,
      tiles: { type: 'array', items: S, description: 'height rows of exactly width characters each.' },
      doors: cellList(DOOR),
      regions: cellList(REGION),
      notes: cellList(NOTE),
      lights: cellList(LIGHT),
    }, ['name', 'width', 'height', 'tiles']),
  },
  {
    name: 'propose_map_edits',
    description: 'Propose changes to an EXISTING map: repaint cells, add doors, labelled regions, GM notes or lights. Applied only when the GM clicks « Appliquer ».',
    eager_input_streaming: true,
    input_schema: obj({
      mapId: S,
      summary: { type: 'string', description: 'One line describing the change.' },
      paint: { type: 'array', items: { type: 'object', properties: { x: I, y: I, ch: { type: 'string', description: 'One tile character.' } }, required: ['x', 'y', 'ch'] } },
      doors: cellList(DOOR),
      regions: cellList(REGION),
      notes: cellList(NOTE),
      lights: cellList(LIGHT),
    }, ['mapId', 'summary']),
  },
  {
    name: 'propose_npc',
    description: 'Propose a new NPC template for the bestiary (SR5 stats). Nothing is spawned on a map.',
    eager_input_streaming: true,
    input_schema: obj({
      template: { type: 'object', description: 'Bestiary template (actor schema, see the system prompt).' },
      folder: { type: 'string', description: 'Bestiary folder, e.g. "Project Lazarus", "Gangs", "Sécurité corpo".' },
    }, ['template']),
  },
  {
    name: 'propose_handout',
    description: 'Propose a handout (document, message, image caption the players may receive later). It is created UNREVEALED; the GM reveals it when ready.',
    input_schema: obj({ title: S, body: { type: 'string', description: 'Markdown, written in the voice of the in-game document.' }, gmNotes: S }, ['title', 'body']),
  },
  {
    name: 'propose_campaign_entry',
    description: 'Propose a NEW entry in the campaign tracker: an act, a quest, a phase of an existing quest, a session, a plot thread, or text appended at the end of a session plan or of the GM notes. To change an existing entry use propose_campaign_edit.',
    input_schema: obj({
      kind: { type: 'string', enum: ['act', 'quest', 'phase', 'session', 'thread', 'session_plan', 'gm_notes'] },
      title: { type: 'string', description: 'Title of the act, quest, phase or session; label of the thread.' },
      summary: { type: 'string', description: 'Act or quest summary.' },
      phases: { type: 'array', items: S, description: 'Quest phases (titles).' },
      actId: { type: 'string', description: 'Act id for a quest (from get_campaign); default = first act.' },
      questId: { type: 'string', description: 'Quest of a new phase.' },
      sessionId: { type: 'string', description: 'Session id for session_plan (from get_campaign); default = the next unplayed session.' },
      date: { type: 'string', description: 'Date of a new session (free text).' },
      text: { type: 'string', description: 'Markdown: text to append (session_plan, gm_notes), thread notes, phase text or the plan of a new session.' },
    }, ['kind']),
  },
  {
    name: 'propose_campaign_edit',
    description: `Propose changes to an EXISTING campaign entry: an act, a quest, a quest phase, a session, a plot thread, a handout, the GM notes or the player recap. Fields by target: ${CAMPAIGN_FIELDS_HELP}. Applied only when the GM clicks « Appliquer »; the card shows a before/after diff.`,
    eager_input_streaming: true,
    input_schema: obj({
      target: { type: 'string', enum: CAMPAIGN_TARGETS },
      id: { type: 'string', description: 'Id (or exact title) of the entry; for a phase, the phase id or title (with questId). Not needed for gm_notes and player_recap.' },
      questId: { type: 'string', description: 'Quest of the phase (target phase).' },
      summary: { type: 'string', description: 'One line describing the change.' },
      set: { type: 'object', description: 'Fields set to a new value, e.g. { "status": "done" } or { "title": "…" }. A long text set here replaces the whole text: read it in full first.' },
      edits: {
        type: 'array',
        description: 'Exact replacements inside text fields, applied in order.',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', description: 'Text field; default = the main text (act/quest summary, phase text, session plan, thread notes, handout body, the notes or recap text).' },
            find: { type: 'string', description: 'Exact current passage, copied character for character; must appear once unless all is true.' },
            replace: { type: 'string', description: 'New passage (empty string = remove the passage).' },
            all: { type: 'boolean', description: 'Replace every occurrence.' },
          },
          required: ['find', 'replace'],
        },
      },
    }, ['target', 'summary']),
  },
  {
    name: 'propose_doc_edit',
    description: `Propose a change to a campaign document (markdown file in the docs list), or a new document. Either \`edits\` (exact replacements, for an existing document) or \`content\` (the whole text: a new document, or a full rewrite of a document under ${DOC_PAGE} characters that you have read in full). The card shows a before/after diff; the previous version is backed up when applied.`,
    eager_input_streaming: true,
    input_schema: obj({
      name: { type: 'string', description: 'Document name as listed (e.g. "session-4-plan.md" or "pnj/Mr Johnson.md"); a new name creates the document (at most one folder level).' },
      summary: { type: 'string', description: 'One line describing the change.' },
      edits: {
        type: 'array',
        description: 'Exact replacements, applied in order.',
        items: {
          type: 'object',
          properties: {
            find: { type: 'string', description: 'Exact current passage, copied character for character; must appear once unless all is true.' },
            replace: { type: 'string', description: 'New passage (empty string = remove the passage).' },
            all: { type: 'boolean', description: 'Replace every occurrence.' },
          },
          required: ['find', 'replace'],
        },
      },
      content: { type: 'string', description: 'Whole markdown text of the document.' },
    }, ['name', 'summary']),
  },
];

export const PROPOSE_TOOLS: Set<string> = new Set(TOOL_DEFS.filter((t) => t.name.startsWith('propose_')).map((t) => t.name));

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------
function searchDocs(dir: string, query: unknown): string {
  const words = norm(query).split(/\s+/).filter((w) => w.length > 1).slice(0, 8);
  if (!words.length) return 'Requête vide.';
  const hits: string[] = [];
  for (const name of listDocs(dir)) {
    const file = docPath(dir, name);
    if (!file) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const n = norm(line);
      if (words.every((w) => n.includes(w))) hits.push(`${name}:${i + 1}: ${clip(lines[i - 1] ? lines[i - 1].trim() + ' ⏎ ' : '', 200)}${clip(line.trim(), 400)}`);
    });
    if (hits.length > 120) break;
  }
  return hits.length ? hits.slice(0, 120).join('\n') + (hits.length > 120 ? '\n…(plus de résultats : affine la recherche)' : '') : 'Aucun résultat.';
}

function campaignForModel(c: Campaign | undefined) {
  if (!c) return {};
  return {
    currentActId: c.currentActId || null,
    acts: c.acts,
    quests: (c.quests || []).map((q) => ({ id: q.id, actId: q.actId, title: q.title, status: q.status, summary: clip(q.summary, 1500), phases: (q.phases || []).map((p) => ({ title: p.title, done: p.done })), rewards: clip(q.rewards, 500), gmNotes: clip(q.gmNotes, 1500), doc: q.doc })),
    sessions: (c.sessions || []).map((s) => ({ id: s.id, number: s.number, title: s.title, date: s.date, played: s.played, doc: s.doc, plan: clip(s.plan, 3000), recap: clip(s.recap, 3000) })),
    threads: c.threads,
    handouts: (c.handouts || []).map((h) => ({ id: h.id, title: h.title, revealedTo: h.revealedTo })),
    notes: clip(c.notes, 8000),
    playerRecap: clip(c.playerRecap, 3000),
  };
}

/** Find a campaign entry by id, else by exact title/label (accent and case insensitive). */
function findEntry<T extends { id: string; title?: string; label?: string }>(list: T[] | undefined, key: unknown): T | undefined {
  const items = list || [];
  return items.find((x) => x.id === key) || (key ? items.find((x) => norm(x.title ?? x.label) === norm(key)) : undefined);
}

/** The entry an edit or a read targets, with its current editable values. */
function resolveTarget(target: string, input: ToolInput, state: TableState):
  | { def: CampaignTarget; item?: Record<string, any>; questId?: string; name: string; values: Record<string, unknown> }
  | { error: string } {
  const def = TARGETS[target];
  if (!def) return { error: `target inconnu : ${target} (${CAMPAIGN_TARGETS.join(', ')}).` };
  const c: Partial<Campaign> = state.campaign || {};
  const pickValues = (item: Record<string, any>) => Object.fromEntries(Object.keys(def.fields).map((f) => [f, item[f] ?? (def.fields[f] === 'bool' ? false : '')]));
  if (target === 'gm_notes') return { def, name: '', values: { text: c.notes || '' } };
  if (target === 'player_recap') return { def, name: '', values: { text: c.playerRecap || '' } };
  if (target === 'phase') {
    const quest = findEntry(c.quests, input.questId);
    if (!quest) return { error: `Quête introuvable : ${input.questId ?? '(questId manquant)'}` };
    const phase = findEntry(quest.phases, input.id);
    if (!phase) return { error: `Phase introuvable dans « ${quest.title} » : ${input.id ?? '(id manquant)'}` };
    return { def, item: phase, questId: quest.id, name: `${quest.title} — ${phase.title}`, values: pickValues(phase) };
  }
  const list = c[def.coll!] as Array<{ id: string; title?: string; label?: string }> | undefined;
  const item = findEntry(list, input.id) as Record<string, any> | undefined;
  if (!item) return { error: `Introuvable (${target}) : ${input.id ?? '(id manquant)'}. Les ids sont dans get_campaign.` };
  const name = target === 'session' ? `Séance ${item.number}${item.title ? ` — ${item.title}` : ''}` : String(item.title ?? item.label ?? '');
  return { def, item, name, values: pickValues(item) };
}

function runRead(name: string, input: ToolInput, { state, docsDir }: ToolEnv): ToolOut {
  switch (name) {
    case 'list_docs':
      return json(listDocs(docsDir).map((n) => ({ name: n, chars: fs.statSync(docPath(docsDir, n) as string).size })));
    case 'read_doc': {
      const file = docPath(docsDir, input.name);
      if (!file) return { error: `Document introuvable : ${input.name}` };
      const text = fs.readFileSync(file, 'utf8');
      const offset = Math.max(0, Number(input.offset) || 0);
      const page = text.slice(offset, offset + DOC_PAGE);
      const more = offset + DOC_PAGE < text.length ? `\n\n[… suite : read_doc avec offset=${offset + DOC_PAGE} — ${text.length} caractères au total]` : '';
      return page + more;
    }
    case 'search_docs':
      return searchDocs(docsDir, input.query);
    case 'get_campaign':
      return json(campaignForModel(state.campaign));
    case 'get_campaign_entry': {
      const r = resolveTarget(String(input.target || ''), input, state);
      if ('error' in r) return { error: r.error };
      if (!r.item) return String(r.values.text || '') || '(vide)';
      return json(input.target === 'phase' ? { questId: r.questId, ...r.item } : r.item);
    }
    case 'list_actors': {
      const type = input.type === 'pc' || input.type === 'npc' ? input.type : null;
      return json(Object.values(state.actors || {}).filter((a) => !type || a.type === type).map(actorSummary));
    }
    case 'get_actor': {
      const a = state.actors?.[input.id] || Object.values(state.actors || {}).find((x) => norm(x.name) === norm(input.id));
      return a ? json(actorForModel(a)) : { error: `Personnage introuvable : ${input.id}` };
    }
    case 'list_maps':
      return json(Object.values(state.maps || {}).map((m) => ({ id: m.id, name: m.name, folder: m.folder || '', width: m.width, height: m.height, theme: m.theme, lighting: m.lighting, active: state.scene?.activeMapId === m.id, tokens: (m.tokens || []).length })));
    case 'get_map': {
      const m = state.maps?.[input.id];
      return m ? json(mapForModel(m)) : { error: `Carte introuvable : ${input.id}` };
    }
    case 'get_bestiary': {
      if (input.id) {
        const t = state.bestiary?.[input.id];
        return t ? json(t) : { error: `Modèle introuvable : ${input.id}` };
      }
      return json(Object.values(state.bestiary || {}).map((t) => ({ id: t.id, name: t.name, folder: t.folder, concept: t.concept, pr: t.npc?.professionalRating })));
    }
    case 'get_combat':
      return json(state.combat || { active: false });
    case 'get_log': {
      const limit = Math.min(150, Math.max(1, Number(input.limit) || 40));
      return (state.log || []).slice(-limit).map((e) => {
        const roll = e.roll ? ` [${e.roll.label || ''} ${e.roll.pool ?? ''}d → ${e.roll.hits ?? '?'} succès${e.roll.glitch ? ', complication' : ''}]` : '';
        const to = e.to ? ` (chuchoté à ${e.to.join(', ')})` : '';
        return `${new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ')} ${e.kind} ${e.author || ''}${to}: ${clip(e.text || '', 500)}${roll}`;
      }).join('\n') || 'Journal vide.';
    }
    case 'search_catalog': {
      const words = norm(input.query).split(/\s+/).filter(Boolean);
      if (!words.length) return 'Requête vide.';
      const res = catalogItems()
        .filter((it) => (!input.file || it.file === input.file) && words.every((w) => norm(`${it.name} ${it.nameFr || ''} ${it.category} ${it.categoryFr || ''}`).includes(w)))
        .slice(0, 25)
        .map(({ id, file, name, nameFr, category, cost, costFormula, avail, rating, essence, source, page, stats }) => ({ file, name, nameFr, category, cost, costFormula, avail, rating, essence, source, page, stats }));
      return res.length ? json(res) : 'Aucun objet trouvé.';
    }
    default:
      return { error: `Outil inconnu : ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Proposals: build the action list, simulate it on a copy of the state, keep a preview.
// ---------------------------------------------------------------------------
const cleanCells = (list: unknown, max = 400): Record<string, any>[] => (Array.isArray(list) ? list.filter(isObj).slice(0, max) : []);

/**
 * Build the action ops of a proposal from its input and the CURRENT state (append-type entries read the state
 * at apply time, so the GM's edits made in between are kept). Returns { ops } or { error }.
 */
export function buildOps(kind: string, input: ToolInput, state: TableState): BuiltOps {
  switch (kind) {
    case 'map': {
      const map = {
        name: input.name, folder: input.folder || '', description: input.description || '', theme: input.theme, lighting: input.lighting,
        width: input.width, height: input.height, tiles: Array.isArray(input.tiles) ? input.tiles.map((r: unknown) => String(r ?? '')) : [],
        doors: cleanCells(input.doors), regions: cleanCells(input.regions), notes: cleanCells(input.notes).map((n) => ({ ...n, gmOnly: true })), lights: cleanCells(input.lights),
        tokens: [], fog: true,
      };
      return { ops: [{ type: 'maps/import', payload: { map } }] };
    }
    case 'map_edits': {
      const mapId = input.mapId;
      if (!state.maps?.[mapId]) return { error: `Carte introuvable : ${mapId}` };
      const ops: ProposalOp[] = [];
      const paint = cleanCells(input.paint, 25600);
      if (paint.length) ops.push({ type: 'maps/paint', payload: { mapId, cells: paint.map((c) => ({ x: c.x | 0, y: c.y | 0, ch: String(c.ch || '').slice(0, 1) })) } });
      for (const door of cleanCells(input.doors)) ops.push({ type: 'maps/addDoor', payload: { mapId, door } });
      for (const region of cleanCells(input.regions)) ops.push({ type: 'maps/addRegion', payload: { mapId, region } });
      for (const note of cleanCells(input.notes)) ops.push({ type: 'maps/addNote', payload: { mapId, note } });
      for (const light of cleanCells(input.lights)) ops.push({ type: 'maps/addLight', payload: { mapId, light: { on: true, ...light } } });
      if (!ops.length) return { error: 'Aucune modification dans la proposition.' };
      return { ops };
    }
    case 'npc': {
      if (!isObj(input.template)) return { error: 'template doit être un objet.' };
      return { ops: [{ type: 'bestiary/create', payload: { template: input.template, folder: input.folder || input.template.folder || 'Assistant' } }] };
    }
    case 'handout':
      return { ops: [{ type: 'campaign/addHandout', payload: { title: input.title, body: input.body, gmNotes: input.gmNotes || '' } }] };
    case 'campaign': {
      const c: Partial<Campaign> = state.campaign || {};
      switch (input.kind) {
        case 'act':
          if (!input.title) return { error: 'title est requis pour un acte.' };
          return { ops: [{ type: 'campaign/addAct', payload: { title: input.title, summary: input.summary || input.text || '' } }] };
        case 'session':
          if (!input.title) return { error: 'title est requis pour une séance.' };
          return { ops: [{ type: 'campaign/addSession', payload: { title: input.title, date: input.date || '', plan: input.text || input.summary || '' } }] };
        case 'phase': {
          const quest = findEntry(c.quests, input.questId);
          if (!quest) return { error: `Quête introuvable : ${input.questId ?? '(questId manquant)'}` };
          if (!input.title) return { error: 'title est requis pour une phase.' };
          return { ops: [{ type: 'campaign/addPhase', payload: { questId: quest.id, title: input.title, text: input.text || '' } }], label: `${quest.title} — ${input.title}`, resolved: { questId: quest.id } };
        }
        case 'quest':
          if (!input.title) return { error: 'title est requis pour une quête.' };
          return { ops: [{ type: 'campaign/addQuest', payload: { title: input.title, summary: input.summary || input.text || '', actId: input.actId, status: 'upcoming', phases: (input.phases || []).map((t: unknown) => ({ title: String(t), done: false })) } }] };
        case 'thread':
          if (!input.title) return { error: 'title est requis pour un fil.' };
          return { ops: [{ type: 'campaign/addThread', payload: { label: input.title, notes: input.text || input.summary || '', state: 'open' } }] };
        case 'session_plan': {
          const ses = input.sessionId ? (c.sessions || []).find((s) => s.id === input.sessionId) : (c.sessions || []).find((s) => !s.played);
          if (!ses) return { error: 'Aucune séance trouvée (crée-la d’abord dans Campagne, ou donne sessionId).' };
          if (!input.text) return { error: 'text est requis.' };
          return { ops: [{ type: 'campaign/updateSession', payload: { sessionId: ses.id, patch: { plan: `${ses.plan ? ses.plan.trimEnd() + '\n\n' : ''}${input.text}` } } }], label: `Séance ${ses.number} — ${ses.title}` };
        }
        case 'gm_notes':
          if (!input.text) return { error: 'text est requis.' };
          return { ops: [{ type: 'campaign/updateNotes', payload: { text: `${c.notes ? c.notes.trimEnd() + '\n\n' : ''}${input.text}` } }] };
        default:
          return { error: `kind inconnu : ${input.kind}` };
      }
    }
    case 'campaign_edit':
      return buildCampaignEdit(input, state);
    default:
      return { error: `Type de proposition inconnu : ${kind}` };
  }
}

const sha = (v: unknown): string => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** Value of a `set` field, checked against its kind. */
function setValue(field: string, kind: FieldKind, v: unknown, state: TableState): { value: unknown } | { error: string } {
  if (kind === 'bool') return typeof v === 'boolean' ? { value: v } : { error: `${field} doit être true ou false.` };
  if (kind === 'int') return Number.isInteger(Number(v)) && Number(v) > 0 ? { value: Number(v) } : { error: `${field} doit être un entier positif.` };
  if (kind === 'enum') return ENUMS[field].includes(String(v)) ? { value: String(v) } : { error: `${field} doit valoir ${ENUMS[field].join(' | ')}.` };
  if (typeof v !== 'string') return { error: `${field} doit être un texte.` };
  if (field === 'actId' && !(state.campaign?.acts || []).some((a) => a.id === v)) return { error: `Acte introuvable : ${v}` };
  return { value: v };
}

/** propose_campaign_edit → one update action of the entry, with the before/after diff of every changed field. */
function buildCampaignEdit(input: ToolInput, state: TableState): BuiltOps {
  const target = String(input.target || '');
  const r = resolveTarget(target, input, state);
  if ('error' in r) return { error: r.error };
  const { def, values } = r;
  const next: Record<string, unknown> = { ...values };
  const guarded: Record<string, unknown> = {};
  const set = isObj(input.set) ? input.set : {};
  for (const [field, v] of Object.entries(set)) {
    const kind = def.fields[field];
    if (!kind) return { error: `Champ inconnu « ${field} » pour ${target} (champs : ${Object.keys(def.fields).join(', ')}).` };
    const res = setValue(field, kind, v, state);
    if ('error' in res) return { error: res.error };
    next[field] = res.value;
    if (kind === 'text') guarded[field] = toLF(values[field]);
  }
  for (const e of Array.isArray(input.edits) ? input.edits : []) {
    const field = isObj(e) && e.field ? String(e.field) : def.main;
    const kind = def.fields[field];
    if (kind !== 'text' && kind !== 'short') return { error: `Les edits ne s'appliquent qu'aux champs texte de ${target} : ${Object.entries(def.fields).filter(([, k]) => k === 'text' || k === 'short').map(([f]) => f).join(', ')}.` };
    const edits = cleanEdits([e]);
    if (!edits.length) return { error: 'Chaque edit doit avoir find et replace (textes).' };
    const res = applyEdits(String(next[field] ?? ''), edits, `${target}.${field}`);
    if ('error' in res) return { error: res.error };
    next[field] = res.text;
  }
  const same = (a: unknown, b: unknown) => (typeof a === 'string' || typeof b === 'string' ? toLF(a) === toLF(b) : a === b);
  const changed = Object.keys(def.fields).filter((f) => !same(values[f], next[f]));
  if (!changed.length) return { error: 'Aucune modification : le résultat est identique au texte actuel.' };
  const patch = Object.fromEntries(changed.map((f) => [f, next[f]]));
  let payload: ActionPayload;
  if (target === 'gm_notes' || target === 'player_recap') payload = { text: next.text };
  else if (target === 'phase') payload = { questId: r.questId, phaseId: r.item!.id, patch };
  else payload = { [def.idKey!]: r.item!.id, patch };
  const revealed = target === 'handout' && (r.item!.revealedTo === 'all' || (Array.isArray(r.item!.revealedTo) && r.item!.revealedTo.length > 0));
  return {
    ops: [{ type: def.action, payload }],
    label: r.name,
    ...(r.item ? { resolved: { id: r.item.id, ...(r.questId ? { questId: r.questId } : {}) } } : {}),
    changes: changed.map((f) => diffLines(String(values[f] ?? ''), String(next[f] ?? ''), f)),
    ...(Object.keys(guarded).length ? { guard: sha(guarded) } : {}),
    ...(target === 'player_recap' || (revealed && (changed.includes('title') || changed.includes('body'))) ? { playersSee: true } : {}),
  };
}

const MAX_DOC_CHARS = 400_000;
/** A document change, computed from the file as it is now. `text` keeps the file's own line endings. */
export type DocWrite =
  | { name: string; file: string; created: boolean; text: string; changes: FieldDiff[]; guard?: string; error?: undefined }
  | { error: string };

/** propose_doc_edit → the new text of the document (validated; nothing is written here). */
export function buildDocWrite(input: ToolInput, docsDir: string): DocWrite {
  const name = docName(input.name);
  const file = name ? docTarget(docsDir, name) : null;
  if (!name || !file) return { error: 'Nom de document invalide : « nom.md » ou « dossier/nom.md », sans « .. » ni caractères spéciaux.' };
  const exists = fs.existsSync(file);
  if (exists && !fs.statSync(file).isFile()) return { error: `${name} n'est pas un fichier.` };
  const raw = exists ? fs.readFileSync(file, 'utf8') : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const before = toLF(raw);
  const edits = cleanEdits(input.edits);
  const hasContent = typeof input.content === 'string';
  if (hasContent && edits.length) return { error: 'Donne soit edits, soit content, pas les deux.' };
  let after: string;
  let guard: string | undefined;
  if (hasContent) {
    if (exists && before.length > DOC_PAGE) return { error: `${name} fait ${before.length} caractères : trop long pour être réécrit en entier. Utilise edits.` };
    after = toLF(input.content);
    if (exists) guard = sha(before);
  } else if (edits.length) {
    if (!exists) return { error: `Document introuvable : ${name}. Pour en créer un, donne content.` };
    const res = applyEdits(before, edits, name);
    if ('error' in res) return { error: res.error };
    after = res.text;
  } else return { error: 'Donne edits (remplacements) ou content (texte entier).' };
  if (!after.trim()) return { error: 'Le document ne peut pas être vide.' };
  if (after.length > MAX_DOC_CHARS) return { error: `Document trop long (${after.length} caractères, ${MAX_DOC_CHARS} au plus).` };
  if (exists && after === before) return { error: 'Aucune modification : le résultat est identique au document actuel.' };
  return { name, file, created: !exists, text: eol === '\n' ? after : after.split('\n').join(eol), changes: [diffLines(before, after, name)], ...(guard ? { guard } : {}) };
}

/**
 * Write a document change (GM's « Appliquer »). The previous version is copied to backupDir first; the new text is
 * written to a temporary file then renamed over the document.
 */
export function writeDocFile(w: Extract<DocWrite, { name: string }>, backupDir: string): void {
  if (!w.created) {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(w.file, path.join(backupDir, `${stamp}__${w.name.split('/').join('__')}`));
  }
  fs.mkdirSync(path.dirname(w.file), { recursive: true });
  const tmp = `${w.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, w.text, 'utf8');
  fs.renameSync(tmp, w.file);
}

const KIND_OF_TOOL: Record<string, ProposalKind> = {
  propose_map: 'map', propose_map_edits: 'map_edits', propose_npc: 'npc', propose_handout: 'handout', propose_campaign_entry: 'campaign',
  propose_campaign_edit: 'campaign_edit', propose_doc_edit: 'doc',
};

/** One-line card title: the entry's name and the model's summary. */
const cardTitle = (name: string | undefined, summary: unknown): string => [name, typeof summary === 'string' ? summary.trim() : ''].filter(Boolean).join(' — ');

/** Map tile rows must match the declared size: catch it here so the model can fix its own grid. */
function checkMapInput(input: ToolInput): string | null {
  const w = Number(input.width), h = Number(input.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 4 || h < 4 || w > 160 || h > 160) return 'width et height doivent être des entiers entre 4 et 160.';
  if (!Array.isArray(input.tiles) || input.tiles.length !== h) return `tiles doit contenir exactement ${h} lignes (reçu ${Array.isArray(input.tiles) ? input.tiles.length : 0}).`;
  const bad = (input.tiles as unknown[]).map((r, y) => ({ y, len: String(r ?? '').length })).filter((r) => r.len !== w);
  if (bad.length) return `Chaque ligne doit faire ${w} caractères. Lignes incorrectes : ${bad.slice(0, 12).map((b) => `y=${b.y} (${b.len})`).join(', ')}${bad.length > 12 ? '…' : ''}.`;
  const allowed = new Set(' .,#DW=Tcomvbs e~grxt_'.split(''));
  for (let y = 0; y < h; y++) {
    const row = String(input.tiles[y]);
    for (let x = 0; x < row.length; x++) if (!allowed.has(row[x])) return `Caractère inconnu « ${row[x]} » en x=${x}, y=${y}.`;
  }
  return null;
}

/**
 * Create a proposal from a propose_* tool call. Simulates its ops on a copy of the state; on success stores the
 * proposal (with a preview) in the conversation. Returns the tool_result content (string) or { error }.
 */
function runPropose(name: string, input: ToolInput, env: ToolEnv): ToolOut {
  const kind = KIND_OF_TOOL[name];
  if (kind === 'doc') {
    const w = buildDocWrite(input, env.docsDir);
    if (w.error !== undefined) return { error: w.error };
    const p: Proposal = {
      id: uid('prop'), kind, title: clip(cardTitle(w.name, input.summary), 120) as string, input,
      preview: { changes: w.changes, ...(w.created ? { created: true } : {}) }, status: 'pending', toolUseId: env.toolUseId, createdAt: Date.now(),
      ...(w.guard ? { guard: w.guard } : {}),
    };
    env.addProposal(p);
    return `Proposition créée (${p.id}) : « ${p.title} ». Le MJ voit le diff et un bouton « Appliquer ». Rien n'est encore modifié.`;
  }
  if (kind === 'map') {
    const err = checkMapInput(input);
    if (err) return { error: err };
  }
  const built = buildOps(kind, input, env.state);
  if (built.error) return { error: built.error };
  let state: TableState | undefined;
  const results: unknown[] = [];
  for (const op of built.ops!) { // no error: ops are set
    const r = env.simulate(op.type, op.payload, state);
    state = r.state;
    if (!r.ok) return { error: `Proposition invalide (${op.type}) : ${r.error}` };
    results.push(r.result);
  }
  const sim = state as TableState; // every proposal has at least one op
  const preview: ProposalPreview = {};
  let title = '';
  if (kind === 'map') {
    const m = sim.maps[results[0] as string];
    preview.map = mapForModel({ ...m, tokens: [] });
    title = m.name;
  } else if (kind === 'map_edits') {
    preview.map = mapForModel(sim.maps[input.mapId]);
    preview.before = env.state.maps[input.mapId]?.name;
    title = `${env.state.maps[input.mapId]?.name} — ${clip(input.summary || '', 80)}`;
  } else if (kind === 'npc') {
    const t = sim.bestiary[(results[0] as { templateId: string }).templateId];
    preview.template = t;
    title = t.name;
  } else if (kind === 'handout') {
    title = input.title;
    preview.body = input.body;
  } else if (kind === 'campaign') {
    title = built.label || input.title || ({ session_plan: 'Plan de séance', gm_notes: 'Notes MJ' } as Record<string, string>)[input.kind] || input.kind;
    preview.text = input.text || input.summary || '';
    preview.phases = input.phases || [];
  } else if (kind === 'campaign_edit') {
    title = cardTitle(built.label, input.summary);
    preview.changes = built.changes;
    if (built.playersSee) preview.playersSee = true;
  }
  const p: Proposal = {
    id: uid('prop'), kind, sub: kind === 'campaign' || kind === 'campaign_edit' ? input.kind || input.target : undefined, title: clip(title, 120) as string,
    input: built.resolved ? { ...input, ...built.resolved } : input,
    preview, status: 'pending', toolUseId: env.toolUseId, createdAt: Date.now(),
    ...(built.guard ? { guard: built.guard } : {}),
  };
  env.addProposal(p);
  return `Proposition créée (${p.id}) : « ${p.title} ». Le MJ la verra comme une carte avec un bouton « Appliquer ». Rien n'est encore modifié.`;
}

/**
 * Run one tool. env = { state, docsDir, simulate(type, payload, state?), addProposal(p), toolUseId }.
 * Returns { content, isError }.
 */
export function runTool(name: string, input: unknown, env: ToolEnv): { content: string; isError: boolean } {
  try {
    const safeInput = isObj(input) ? input : {};
    const out = PROPOSE_TOOLS.has(name) ? runPropose(name, safeInput, env) : runRead(name, safeInput, env);
    if (isObj(out) && out.error) return { content: out.error, isError: true };
    return { content: typeof out === 'string' ? out : json(out), isError: false };
  } catch (err) {
    console.error(`[assistant] tool ${name} failed`, err);
    return { content: `Erreur interne de l'outil ${name} : ${(err as Error).message || err}`, isError: true };
  }
}

/** Short, human label of a read tool call for the chat transcript. */
export function toolLabel(name: string, input: ToolInput = {}): ToolLabel {
  switch (name) {
    case 'read_doc': return { key: tk('Read: {name}'), params: { name: input.name } };
    case 'search_docs': return { key: tk('Searched the documents: {q}'), params: { q: input.query } };
    case 'list_docs': return { key: tk('Document list') };
    case 'get_campaign': return { key: tk('Campaign tracker') };
    case 'get_campaign_entry': return { key: tk('Campaign tracker') };
    case 'list_actors': return { key: tk('Character list') };
    case 'get_actor': return { key: tk('Sheet: {name}'), params: { name: input.id } };
    case 'list_maps': return { key: tk('Map list') };
    case 'get_map': return { key: tk('Map: {name}'), params: { name: input.id } };
    case 'get_bestiary': return input.id ? { key: tk('Bestiary: {name}'), params: { name: input.id } } : { key: tk('Bestiary') };
    case 'get_combat': return { key: tk('Current combat') };
    case 'get_log': return { key: tk('Table log') };
    case 'search_catalog': return { key: tk('Catalog: {q}'), params: { q: input.query } };
    default: return { key: name };
  }
}
