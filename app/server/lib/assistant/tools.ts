// GM assistant — tools the model may call.
// Read tools return live game data (GM view). Propose tools never change the game: they validate the change by
// running the real action(s) on a throwaway copy of the state (simulateAction) and store a proposal the GM
// applies with one click (runAction, same path as the GM's own clicks).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uid } from '../../../shared/util.ts';
import { listDocs, docPath } from './context.ts';
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
export type BuiltOps = { ops: ProposalOp[]; label?: string; error?: undefined } | { error: string; ops?: undefined; label?: undefined };
/** A tool's own result: text for the model, or an error it may fix. */
type ToolOut = string | { error: string };
export interface ToolLabel {
  key: string;
  params?: I18nParams;
}

/** Marks a French key for tools/i18n-check.js (translated by the client). */
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
  { name: 'get_campaign', description: 'Acts, quests (status, phases), sessions (plans and recaps, truncated), plot threads, handouts (title, revealed or not) and the GM notes, as stored in the app.', input_schema: obj({}) },
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
    description: 'Propose an addition to the campaign tracker: a quest, a plot thread, text appended to a session plan, or text appended to the GM notes.',
    input_schema: obj({
      kind: { type: 'string', enum: ['quest', 'thread', 'session_plan', 'gm_notes'] },
      title: { type: 'string', description: 'Quest title or thread label.' },
      summary: { type: 'string', description: 'Quest summary.' },
      phases: { type: 'array', items: S, description: 'Quest phases (titles).' },
      actId: { type: 'string', description: 'Act id for a quest (from get_campaign); default = first act.' },
      sessionId: { type: 'string', description: 'Session id for session_plan (from get_campaign); default = the next unplayed session.' },
      text: { type: 'string', description: 'Markdown to append (session_plan, gm_notes) or thread notes.' },
    }, ['kind']),
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
  };
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
    default:
      return { error: `Type de proposition inconnu : ${kind}` };
  }
}

const KIND_OF_TOOL: Record<string, ProposalKind> = { propose_map: 'map', propose_map_edits: 'map_edits', propose_npc: 'npc', propose_handout: 'handout', propose_campaign_entry: 'campaign' };

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
    title = input.title || built.label || ({ session_plan: 'Plan de séance', gm_notes: 'Notes MJ' } as Record<string, string>)[input.kind] || input.kind;
    preview.text = input.text || input.summary || '';
    preview.phases = input.phases || [];
  }
  const p: Proposal = {
    id: uid('prop'), kind, sub: kind === 'campaign' ? input.kind : undefined, title: clip(title, 120), input,
    preview, status: 'pending', toolUseId: env.toolUseId, createdAt: Date.now(),
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
    case 'read_doc': return { key: tk('Lu : {name}'), params: { name: input.name } };
    case 'search_docs': return { key: tk('Recherche dans les documents : {q}'), params: { q: input.query } };
    case 'list_docs': return { key: tk('Liste des documents') };
    case 'get_campaign': return { key: tk('Suivi de campagne') };
    case 'list_actors': return { key: tk('Liste des personnages') };
    case 'get_actor': return { key: tk('Fiche : {name}'), params: { name: input.id } };
    case 'list_maps': return { key: tk('Liste des cartes') };
    case 'get_map': return { key: tk('Carte : {name}'), params: { name: input.id } };
    case 'get_bestiary': return input.id ? { key: tk('Bestiaire : {name}'), params: { name: input.id } } : { key: tk('Bestiaire') };
    case 'get_combat': return { key: tk('Combat en cours') };
    case 'get_log': return { key: tk('Journal de la table') };
    case 'search_catalog': return { key: tk('Catalogue : {q}'), params: { q: input.query } };
    default: return { key: name };
  }
}
