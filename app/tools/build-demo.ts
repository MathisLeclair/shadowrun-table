// Builds the « demo » content pack (data/packs/demo/) used by the public demo table (SR_DEMO_TABLE, server/lib/demo.ts).
//   node tools/build-demo.ts            (re-run after changing the content below, then commit data/packs/demo)
// The pack is layered on the « vierge » pack (generic bestiary, shop, audio). This script holds the hand-written
// content (warehouse tile map, Matrix host, scenario) and generates the rest through the real app: it starts a
// throwaway server, creates the PCs with the NPC generator, copies a map-library map, spawns bestiary NPCs, then
// exports the state and writes the slices as seed files with stable ids. No Project Lazarus content.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import type { Actor, GameMap, TableState } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'packs', 'demo');

// ---------------------------------------------------------------------------
// Hand-written content
// ---------------------------------------------------------------------------
const W = 36;
const H = 22;
/** Warehouse on the Tacoma docks: street on the left, dock and water on the right, foreman's office upstairs-right. */
function warehouseMap() {
  const g = Array.from({ length: H }, () => Array(W).fill(','));
  const set = (x: number, y: number, ch: string) => {
    if (x >= 0 && y >= 0 && x < W && y < H) g[y][x] = ch;
  };
  const fill = (x: number, y: number, w: number, h: number, ch: string) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, ch);
  };
  const box = (x: number, y: number, w: number, h: number) => {
    fill(x, y, w, h, '#');
    fill(x + 1, y + 1, w - 2, h - 2, '.');
  };
  fill(33, 0, 1, H, '='); // dock railing
  fill(34, 0, 2, H, '~'); // Puget Sound
  set(33, 15, ','); // gap in the railing: ladder down to the water
  box(4, 2, 26, 16); // warehouse x4..29, y2..17
  fill(21, 2, 1, 7, '#'); // office wall
  fill(21, 8, 9, 1, '#');
  fill(24, 2, 3, 1, 'W'); // office window on the street side
  // Doors (tile D + a doors[] entry each)
  const doors = [
    { id: 'door_loading_1', x: 4, y: 8, kind: 'shutter', state: 'closed', name: 'Rideau de quai (nord)' },
    { id: 'door_loading_2', x: 4, y: 9, kind: 'shutter', state: 'closed', name: 'Rideau de quai (centre)' },
    { id: 'door_loading_3', x: 4, y: 10, kind: 'shutter', state: 'closed', name: 'Rideau de quai (sud)' },
    { id: 'door_back', x: 14, y: 17, kind: 'door', state: 'locked', name: 'Porte de service' },
    { id: 'door_dock_1', x: 29, y: 12, kind: 'gate', state: 'closed', name: 'Portail du quai' },
    { id: 'door_dock_2', x: 29, y: 13, kind: 'gate', state: 'closed', name: 'Portail du quai' },
    { id: 'door_office', x: 24, y: 8, kind: 'door', state: 'locked', name: 'Bureau du contremaître' },
  ];
  for (const d of doors) set(d.x, d.y, 'D');
  // Storage: shelves, crates, pillars, forklift, chemical spill
  fill(6, 4, 5, 1, 'm');
  fill(13, 4, 5, 1, 'm');
  fill(6, 6, 5, 1, 'm');
  fill(13, 6, 5, 1, 'm');
  set(12, 10, 'o');
  set(20, 10, 'o');
  fill(7, 12, 3, 3, 'c');
  fill(16, 11, 2, 2, 'c');
  fill(11, 14, 2, 2, 'c');
  fill(24, 13, 2, 2, 'c');
  set(20, 14, 'v');
  set(20, 15, 'v');
  fill(25, 10, 2, 1, 'x');
  // Office
  fill(24, 4, 2, 2, 'T');
  fill(27, 3, 2, 1, 'm');
  fill(22, 6, 1, 2, 'b');
  // Outside: the runners' van, rubble
  fill(1, 7, 2, 4, 'v');
  set(2, 15, 'r');
  set(1, 18, 'r');
  set(10, 19, 'r');
  set(27, 20, 'r');
  return {
    id: 'map_demo_entrepot',
    name: 'Entrepôt 23 — docks de Tacoma',
    folder: 'Démo',
    description:
      'Un entrepôt de transit sur les docks, loué au mois par une société-écran. Les Rats du port y stockent une cargaison volée ' +
      'pour le compte d’un acheteur inconnu. Rideaux de quai à l’ouest, portail sur le quai à l’est, bureau du contremaître au nord-est.',
    width: W,
    height: H,
    metersPerCell: 1.5,
    theme: 'industrial',
    lighting: 'dim',
    fog: true,
    sharedVision: true,
    tiles: g.map((r) => r.join('')),
    doors,
    lights: [
      { id: 'light_street', x: 2, y: 4, radius: 6, color: '#ffb766', on: true, name: 'Réverbère' },
      { id: 'light_hall_w', x: 10, y: 9, radius: 5, color: '#cfe8ff', on: true, name: 'Néons de l’entrepôt (ouest)' },
      { id: 'light_hall_e', x: 19, y: 13, radius: 5, color: '#cfe8ff', on: true, name: 'Néons de l’entrepôt (est)' },
      { id: 'light_office', x: 25, y: 5, radius: 4, color: '#ffd9a0', on: true, name: 'Lampe du bureau' },
      { id: 'light_dock', x: 31, y: 12, radius: 5, color: '#ff7a59', on: true, name: 'Projecteur du quai' },
    ],
    regions: [
      { id: 'reg_street', name: 'Rue des docks', x: 0, y: 0, w: 4, h: H, color: '#3a4a5c', gmOnly: false },
      { id: 'reg_hall', name: 'Entrepôt', x: 5, y: 3, w: 24, h: 14, color: '#4a4f3a', gmOnly: false },
      { id: 'reg_office', name: 'Bureau du contremaître', x: 22, y: 3, w: 7, h: 5, color: '#5c3a4a', gmOnly: false },
      { id: 'reg_dock', name: 'Quai', x: 30, y: 0, w: 3, h: H, color: '#2f4f5c', gmOnly: false },
      { id: 'reg_cameras', name: 'Champ des caméras', x: 5, y: 3, w: 16, h: 14, color: '#5c9be0', gmOnly: true },
    ],
    notes: [
      { id: 'note_cargo', x: 16, y: 11, text: 'La cargaison : 6 caisses de drones de livraison Ares reconditionnés. Une caisse est piégée (grenade, Perception 3 pour la repérer).', gmOnly: true },
      { id: 'note_safe', x: 24, y: 4, text: 'Coffre mural (Serrurerie 4, ou via le host). Contient 4 000 ¥ en créditubes et le contrat de l’acheteur.', gmOnly: true },
      { id: 'note_spill', x: 25, y: 10, text: 'Flaque de solvant : traverser = test d’Agilité + Réaction (2), sinon chute.', gmOnly: true },
    ],
    tokens: [],
  };
}

/** Pre-made runners, generated by the NPC generator (same code as the GM tool), then turned into PCs. */
const PCS = [
  { key: 'samurai', archetype: 'merc', metatype: 'Ork', seed: 2081, name: 'Rivet', concept: 'Samouraï des rues', color: '#e05c5c' },
  { key: 'decker', archetype: 'decker', metatype: 'Elfe', seed: 3142, name: 'Pixel', concept: 'Decker', color: '#3fd6d0' },
  { key: 'mage', archetype: 'mage', metatype: 'Humain', seed: 1771, name: 'Ombrelune', concept: 'Mage de combat', color: '#9d7ce0' },
  { key: 'face', archetype: 'face', metatype: 'Nain', seed: 4242, name: 'Velours', concept: 'Face', color: '#e0468f' },
];

/** Bestiary NPCs placed on the warehouse map (templates of the vierge pack). */
const NPCS = [
  { templateId: 'tpl_street_ganger', x: 14, y: 9, count: 3 },
  { templateId: 'tpl_crimson_sarge', x: 25, y: 6, count: 1, name: 'Sarge « Gros-Bill »' },
  { templateId: 'tpl_devil_rat', x: 9, y: 16, count: 2, hidden: true },
];

const HOST = {
  id: 'host_demo_entrepot',
  name: 'Host de l’entrepôt 23',
  folder: 'Démo',
  rating: 3,
  alert: 'none',
  visible: true,
  spider: 'tpl_spider_junior',
  description: 'Le host bon marché de la société-écran qui loue l’entrepôt : façade grise, logo de transporteur, sécurité minimale.',
  notes: 'Host de démonstration. Ses appareils sont liés à la carte « Entrepôt 23 » : un decker qui en prend le contrôle peut ouvrir les portes, couper les néons ou les caméras directement sur la carte.',
  ic: [
    { id: 'ic_demo_patrol', type: 'patrol', rating: 3, active: true, damage: 0 },
    { id: 'ic_demo_killer', type: 'killer', rating: 3, active: false, damage: 0 },
  ],
  files: [
    { id: 'file_demo_manifest', name: 'Manifeste de chargement', protected: false, protection: 0, bomb: 0, value: 300, content: '6 caisses « pièces détachées agricoles », expéditeur : Tacoma Freight Solutions. Poids incohérent avec le contenu déclaré.' },
    { id: 'file_demo_contract', name: 'Contrat de l’acheteur', protected: true, protection: 3, bomb: 0, value: 1500, content: 'Livraison prévue jeudi, 3 h, quai 23. Paiement à la livraison : 40 000 ¥. Contact : « M. Brun », numéro de commlink jetable.' },
    { id: 'file_demo_payroll', name: 'Planning des vigiles', protected: false, protection: 0, bomb: 2, value: 100, content: 'Une ronde toutes les deux heures, aucune la nuit du jeudi (« ordre de la direction »).' },
  ],
  devices: [
    { id: 'dev_demo_shutters', name: 'Rideaux de quai', rating: 3, link: { mapId: 'map_demo_entrepot', kind: 'door', targetId: 'door_loading_2' } },
    { id: 'dev_demo_office', name: 'Serrure du bureau', rating: 3, link: { mapId: 'map_demo_entrepot', kind: 'door', targetId: 'door_office' } },
    { id: 'dev_demo_back', name: 'Serrure de la porte de service', rating: 3, link: { mapId: 'map_demo_entrepot', kind: 'door', targetId: 'door_back' } },
    { id: 'dev_demo_lights', name: 'Néons de l’entrepôt', rating: 2, link: { mapId: 'map_demo_entrepot', kind: 'light', targetId: 'light_hall_w' } },
    { id: 'dev_demo_cams', name: 'Caméras de surveillance', rating: 3, link: { mapId: 'map_demo_entrepot', kind: 'camera', targetId: 'reg_cameras' } },
  ],
};

const CAMPAIGN = {
  acts: [
    {
      id: 'act_demo',
      title: 'Démo — Cargaison volée',
      summary:
        'Un petit scénario pour essayer la table. Un fixer engage les runners pour récupérer une cargaison de drones volée par un gang ' +
        'des docks avant qu’elle ne soit revendue. Tout ce que vous faites ici est **public** et **effacé** à la prochaine remise à zéro.',
    },
  ],
  quests: [
    {
      id: 'q_demo_cargo',
      actId: 'act_demo',
      title: 'Récupérer la cargaison',
      status: 'active',
      summary: 'Six caisses de drones reconditionnés dorment dans l’entrepôt 23, gardées par les Rats du port. Le fixer paie 12 000 ¥ pour les récupérer.',
      phases: [
        { id: 'p1', title: 'Repérage', text: 'Observer l’entrepôt depuis la rue : rondes, caméras, rideaux de quai. Essayez le brouillard de guerre et la vision partagée en déplaçant les pions.' },
        { id: 'p2', title: 'Entrer', text: 'Par les rideaux de quai, la porte de service (verrouillée) ou le quai. Le decker peut aussi ouvrir les portes depuis le host (onglet Matrice).' },
        { id: 'p3', title: 'Le gang', text: 'Trois gangers et leur sergent. Lancez un combat depuis la carte (onglet Combat) : initiative, attaques, encaissement, dégâts automatiques.' },
        { id: 'p4', title: 'Le bureau', text: 'Le coffre mural contient le contrat de l’acheteur — aussi lisible dans le host (fichier protégé).' },
      ],
      maps: ['map_demo_entrepot'],
      rewards: '12 000 ¥ et 5 karma chacun.',
      gmNotes: 'Les rats du diable cachés au fond de l’entrepôt (pions masqués) n’apparaissent qu’aux yeux du MJ : révélez-les quand quelqu’un s’approche.',
    },
    {
      id: 'q_demo_buyer',
      actId: 'act_demo',
      title: 'Qui est « M. Brun » ?',
      status: 'upcoming',
      summary: 'Le contrat trouvé dans le bureau mène à un acheteur pressé. Une piste pour la suite (à inventer !).',
      phases: [],
    },
  ],
  threads: [
    { id: 'th_demo_buyer', label: 'L’acheteur de la cargaison', state: 'open', notes: 'Paie 40 000 ¥ pour des drones de livraison ? Il y a autre chose dans les caisses.' },
  ],
  handouts: [
    {
      id: 'ho_demo_brief',
      title: 'Message du fixer',
      body:
        '« Entrepôt 23, docks de Tacoma. Six caisses marquées *Tacoma Freight*. Les Rats du port les ont piquées hier et veulent les ' +
        'revendre jeudi. Ramenez-les intactes : 12 000 ¥. Discrétion appréciée, mais je ne vous paie pas pour faire dans la dentelle. »',
      revealedTo: 'all',
    },
  ],
  playerRecap: 'Le fixer vous a confié un job : récupérer six caisses volées dans l’entrepôt 23 des docks de Tacoma.',
  notes:
    'Bienvenue sur la table de démonstration ! Côté MJ, essayez : la carte (pions, portes, lumières, brouillard), le combat, ' +
    'le bestiaire et le générateur de PNJ, la Matrice (host lié aux portes de la carte), la boutique, les notes et la campagne. ' +
    'Ouvrez la table dans une fenêtre de navigation privée et entrez en joueur pour voir ce que voient les joueurs.',
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
const srv = await startServer({ port: 3790, tables: [{ id: 'build', pack: 'vierge', gmPassword: 'build-demo-pw', name: 'Démo' }] });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'build-demo-pw', table: 'build' }), { table: 'build' });
  const ids: Record<string, string> = {}; // generated id -> stable id

  const mapId = await gm.send<string>('maps/import', { map: warehouseMap() });
  ids[mapId] = 'map_demo_entrepot';

  const pcIds: string[] = [];
  for (const p of PCS) {
    const r = await gm.send<{ actorIds: string[] }>('npcgen/create', { archetype: p.archetype, tier: 4, metatype: p.metatype, seed: p.seed, name: p.name, grunt: false, spawn: { mapId: null, count: 1 } });
    ids[r.actorIds[0]] = `pc_demo_${p.key}`;
    pcIds.push(r.actorIds[0]);
  }
  for (const n of NPCS) {
    const r = await gm.send<{ actorIds: string[] }>('bestiary/spawn', { templateId: n.templateId, mapId, x: n.x, y: n.y, count: n.count, hidden: !!n.hidden });
    r.actorIds.forEach((id, i) => (ids[id] = `npc_demo_${n.templateId.replace(/^tpl_/, '')}_${i + 1}`));
    if (n.name) for (const id of r.actorIds) await gm.send('actor/update', { actorId: id, patch: { name: n.name } });
  }

  // A map-library copy (its artwork shows only where the server has the library images; walls and doors always work).
  let barId: string | null = null;
  try {
    barId = await gm.send<string>('maps/fromLibrary', { slug: 'dive-bar', name: 'Le Néon rouillé (bar des dockers)', folder: 'Démo' });
    ids[barId] = 'map_demo_bar';
  } catch (err) {
    console.warn('  (library map skipped:', (err as Error).message + ')');
  }
  await settle();

  const res = await fetch(`${srv.url}/api/admin/export`, { headers: { Authorization: `Bearer ${(gm.socket.auth as { token: string }).token}`, 'X-SR-Table': 'build' } });
  const state = (await res.json()) as TableState;
  gm.close();

  // Stable ids everywhere (actor ids in tokens, combat, etc.).
  let text = JSON.stringify({ actors: state.actors, maps: state.maps });
  for (const [from, to] of Object.entries(ids)) text = text.split(`"${from}"`).join(`"${to}"`);
  const { actors, maps } = JSON.parse(text) as { actors: Record<string, Actor>; maps: Record<string, GameMap> };

  // Generated runners → PCs (unowned: anyone joining can take one).
  const pcs: Actor[] = [];
  for (const [i, p] of PCS.entries()) {
    const a = actors[ids[pcIds[i]]];
    a.type = 'pc';
    a.player = '';
    a.concept = p.concept;
    a.color = p.color;
    a.karma = 5;
    a.karmaTotal = 5;
    a.nuyen = 5000;
    // NPC-only data of the generator (tactics, loot, professional rating, generator settings).
    for (const k of ['templateId', 'grunt', 'hidden', 'npc', 'gmNotes', 'genArchetype', 'genTier', 'genSeed', 'genLieutenant', 'disposition']) delete (a as unknown as Record<string, unknown>)[k];
    a.history = [{ ts: Date.UTC(2080, 0, 1), text: 'Personnage prétiré de la table de démonstration' }];
    pcs.push(a);
  }
  const npcs = Object.values(actors).filter((a) => String(a.id).startsWith('npc_demo_'));
  for (const a of npcs) {
    a.history = [];
    delete (a as Partial<Actor>).templateId;
  }

  // PCs wait in the street next to their van.
  const wh = maps.map_demo_entrepot;
  pcs.forEach((a, i) => wh.tokens.push({ id: `tok_${a.id}`, actorId: a.id, name: a.name, x: 3, y: 12 + i, size: 1, disposition: 'pc', hidden: false, color: a.color }));
  for (const m of Object.values(maps)) {
    m.explored = {};
    delete m.library?.linkedAt;
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'actors'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'maps'), { recursive: true });
  const write = (rel: string, v: unknown) => fs.writeFileSync(path.join(OUT, rel), JSON.stringify(v, null, 1) + '\n');
  write('actors/demo.json', [...pcs, ...npcs]);
  write('maps/01-entrepot.json', wh); // first map file = the active map
  if (maps.map_demo_bar) write('maps/02-bar.json', maps.map_demo_bar);
  write('matrix.json', { hosts: [HOST] });
  write('campaign.json', CAMPAIGN);
  fs.writeFileSync(path.join(OUT, 'README.md'),
    '# Demo pack\n\nContent of the public demo table (`SR_DEMO_TABLE`), layered on the `vierge` pack. **Generated** by `node tools/build-demo.ts`:\n' +
    'edit the script, not these files. No Project Lazarus content.\n');
  console.log(`Demo pack written to ${path.relative(ROOT, OUT)}: ${pcs.length} PCs, ${npcs.length} NPCs, ${Object.keys(maps).length} map(s), 1 host.`);
} finally {
  await srv.stopAndWait();
}
