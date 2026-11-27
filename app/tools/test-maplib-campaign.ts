#!/usr/bin/env node
// Project Lazarus × map library: the campaign's table maps made from library fragmaps (data/seed/maps/lib-*.json,
// written by tools/maplib-campaign-seeds.ts; choices in Shadowrun/cartes-campagne.md).
//   node tools/test-maplib-campaign.ts        (ports 3940-3941)
// 1) Static: every lib-* seed points at a library entry, each fragmap backs one campaign location only, the walls are the
//    library's, every quest map id exists.  2) Isolated server: the Lazarus table gets the instances, the images resolve
//    behind the signed key (real files when tools/maplib-build.ts has run into the test runtime — done here when ../fragmap
//    exists — else the placeholder), the instances are in sync with the library, a player sees an instance with walls and
//    fog but no library / GM data.  3) A table seeded with the previous quest maps: untouched quests take the new maps,
//    a GM-edited quest keeps its own, existing maps are never replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import { readCampaignSeeds, mergeSeeds, applySeed } from '../server/modules/70-campaign.ts';
import type { Campaign, GameMap, MapId } from '../shared/types.ts';
import type { LibraryDiff, LibWall } from '../shared/maplib.ts';

/** A seed map file (data/seed/maps/*.json) plus its file name. */
type SeedMap = GameMap & { file: string };
/** A raw seed quest (mergeSeeds returns untyped collections). */
type SeedQuest = { id: string; maps?: MapId[] };

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(APP, 'data', 'seed');
const MAPS_DIR = path.join(SEED, 'maps');
let pass = 0, fail = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) pass++;
  else {
    fail++;
    console.log('  ✗ ' + msg);
  }
};

// ---------------------------------------------------------------------------------------------------------- static
const seedMaps: Record<string, SeedMap> = Object.fromEntries(fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
  const m = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));
  return [m.id, { ...m, file: f }];
}));
const libSeeds = Object.values(seedMaps).filter((m) => m.file.startsWith('lib-'));
// Raw library entry files (data/maplib/*.json): parsed JSON, read loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gitLib: Record<string, any> = Object.fromEntries(fs.readdirSync(path.join(APP, 'data', 'maplib')).filter((f) => f.endsWith('.json')).map((f) => {
  const m = JSON.parse(fs.readFileSync(path.join(APP, 'data', 'maplib', f), 'utf8'));
  return [m.slug, m];
}));
const FREE = new Set(['nomad-camp', 'server-room']); // fragmaps-free scenes (library entries made from the Foundry seeds)
ok(libSeeds.length >= 15, `lib-* seeds: ${libSeeds.length}`);
const slugs = new Map<string, string>();
for (const m of libSeeds) {
  const slug = m.library?.slug as string; // checked by the first ok() below
  ok(slug && m.file === `lib-${slug}.json` && m.id === `map_lib_${slug}`, `${m.file}: id / file / library.slug agree`);
  ok(gitLib[slug] || FREE.has(slug), `${m.file}: library entry ${slug} exists`);
  ok(!slugs.has(slug), `${slug} used by one campaign location only`);
  slugs.set(slug, m.id);
  ok(m.background?.url === `/api/maplib/image/${slug}` && m.background.mode === 'image', `${m.file}: background is the signed library image`);
  ok(/^Acte [123]$/.test(m.folder!), `${m.file}: folder ${m.folder}`);
  ok(m.notes.every((n) => n.gmOnly && n.x >= 0 && n.y >= 0 && n.x < m.width && n.y < m.height), `${m.file}: GM notes inside the map`);
  ok(!m.tokens.length && m.fog === true, `${m.file}: no tokens, fog on`);
  const g = gitLib[slug];
  if (g) {
    ok(m.walls.length === g.walls.length && m.lights.length === g.lights.length, `${m.file}: walls / lights = library (${m.walls.length}/${g.walls.length})`);
    ok(m.width === g.width && m.height === g.height, `${m.file}: size = library`);
    ok(m.walls.filter((w) => w.door).length === g.walls.filter((w: LibWall) => w.door).length, `${m.file}: doors = library`);
  }
}
const merged = mergeSeeds(readCampaignSeeds(SEED));
for (const q of merged.quests as SeedQuest[]) for (const id of q.maps || []) ok(seedMaps[id], `quest ${q.id}: map ${id} exists`);
const questMaps = new Set((merged.quests as SeedQuest[]).flatMap((q) => q.maps || []));
for (const m of libSeeds) ok(questMaps.has(m.id), `${m.id} is linked to a quest`);
for (const m of Object.values(seedMaps)) if (m.folder === 'Cartes maison (anciennes)') ok(!questMaps.has(m.id), `old custom map ${m.id} is no longer linked`);

// ---------------------------------------------------------------------------------------------------------- server
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-maplib-campaign-'));
const haveArt = fs.existsSync(path.resolve(APP, '..', 'fragmap'));
if (haveArt) {
  const only = libSeeds.map((m) => m.library!.slug).filter((s) => gitLib[s]).join(',');
  const r = spawnSync(process.execPath, [...process.execArgv.filter((a) => a === '--experimental-strip-types' || a === '--no-warnings'), 'tools/maplib-build.ts', '--only', only], { cwd: APP, env: { ...process.env, SR_RUNTIME_DIR: runtime }, encoding: 'utf8' });
  ok(r.status === 0, `maplib-build into the test runtime (${r.stderr || ''})`);
}
const srv = await startServer({ port: 3940, runtime });
try {
  const gmTok = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, gmTok);
  await settle();
  const st = gm.state;
  for (const m of libSeeds) {
    const tm = st.maps[m.id];
    ok(tm && tm.library?.slug === m.library!.slug, `${m.id} in the Lazarus table, linked to ${m.library!.slug}`);
  }
  for (const q of (st.campaign as Campaign).quests) for (const id of q.maps) ok(st.maps[id], `live quest ${q.id}: ${id} resolves`);
  const key = await (await fetch(srv.url + '/api/maplib/key', { headers: { authorization: `Bearer ${gmTok}` } })).json();
  ok(key.k, 'signed library key');
  for (const m of libSeeds) {
    const r = await fetch(`${srv.url}/api/maplib/image/${m.library!.slug}?k=${encodeURIComponent(key.k)}`);
    const missing = r.headers.get('x-maplib-missing') === '1';
    ok(r.status === 200, `${m.library!.slug}: image 200 (${r.status})`);
    if (haveArt || FREE.has(m.library!.slug)) ok(!missing && /^image\/(jpeg|png|webp)/.test(r.headers.get('content-type') || ''), `${m.library!.slug}: real artwork served (${r.headers.get('content-type')})`);
    await r.arrayBuffer();
    const d = await gm.send<{ current: number; latest: number; diff: LibraryDiff }>('maps/libraryDiff', { mapId: m.id });
    // Lights are not compared: table maps keep lights on whole cells (20-maps.js cleanLight), library lights may be fractional.
    const dd = d.diff;
    ok(d.current === d.latest && !dd.resized && (['walls', 'doors', 'regions'] as const).every((k) => !dd[k].add && !dd[k].remove) && dd.lights.add === dd.lights.remove,
      `${m.id}: in sync with library v${d.latest} (current ${d.current}, ${JSON.stringify(dd)})`);
  }
  const noKey = await fetch(`${srv.url}/api/maplib/image/office-floor`);
  ok(noKey.status === 401, 'library image without key → 401');

  // Player view of an instance: walls, fog, no library link / GM notes / description / GM regions.
  const mapId = 'map_lib_office-floor';
  await gm.send('maps/setActive', { mapId });
  const placed = await gm.send('maps/placePCs', { mapId, actorIds: ['pc_bricks'] });
  ok(Array.isArray(placed) && placed.length === 1, 'PC placed at the library entry point');
  const pTok = await login(srv.url, { role: 'player', name: 'Testeur', characterId: 'pc_bricks' });
  const p = await client(srv.url, pTok);
  await settle();
  const pm = p.state.maps?.[mapId];
  ok(pm, 'player receives the active instance');
  if (pm) {
    ok(!('library' in pm) && !pm.description && !(pm.notes || []).length, 'player view: no library link, description or GM notes');
    ok(!(pm.regions || []).some((r) => r.gmOnly), 'player view: no GM-only region');
    ok((pm.walls || []).length > 0, `player view: walls (${(pm.walls || []).length})`);
    ok(pm.background?.url === '/api/maplib/image/office-floor', 'player view: library background');
    ok(pm.fog === true && typeof pm.visible === 'string' && Object.values(pm.explored || {}).length === 1, 'player view: fog on, own visibility + explored mask');
    ok(pm.regions.length < st.maps[mapId].regions.length, 'player view: GM / unseen regions filtered');
    const tok = pm.tokens.find((t) => t.actorId === 'pc_bricks');
    ok(tok, 'player sees own token');
    const door = st.maps[mapId].walls.find((w) => w.door);
    ok(door, 'instance has doors');
  }
  p.socket.close();
  gm.socket.close();
} finally {
  await srv.stop();
}

// ---------------------------------------------------------------------------------- deploy onto an existing table
// Previous seed = the current one with the old quest map lists; quest q_open_book was edited by the GM (status / a
// phase ticked) — it must keep its maps; the other quests follow the seed. A map the GM already has is never replaced.
{
  const OLD = 'map_corp_lobby';
  const old = JSON.parse(JSON.stringify(merged));
  for (const q of old.quests) q.maps = [OLD, 'map_server_room'];
  const campaign = { acts: [], quests: [], sessions: [], threads: [], handouts: [] } as unknown as Campaign; // partial: applySeed fills it
  applySeed(campaign, old, (p) => `${p}_x`);
  const edited = campaign.quests.find((q) => q.id === 'q_open_book')!;
  edited.gmNotes = 'Note du MJ';
  const map = JSON.parse(JSON.stringify(seedMaps['map_lib_office-floor']));
  map.name = 'Renommée par le MJ';
  map.tokens = [];
  const state = { version: 1, config: { gmPassword: 'lazarus', campaignName: 'Lazarus', lang: 'fr' }, users: {}, actors: {}, log: [], campaign, maps: { [map.id]: map } };
  const srv2 = await startServer({ port: 3941, tables: [{ id: 'lazarus', name: 'Lazarus', state }] });
  try {
    const gm = await client(srv2.url, await login(srv2.url, { role: 'gm', password: 'lazarus', table: 'lazarus' }), { table: 'lazarus' });
    await settle();
    const qs = Object.fromEntries((gm.state.campaign as Campaign).quests.map((q) => [q.id, q]));
    ok(qs.q_open_book.maps.includes(OLD), 'GM-edited quest keeps its own maps');
    const want = Object.fromEntries((merged.quests as SeedQuest[]).map((q) => [q.id, q.maps]));
    for (const id of Object.keys(qs).filter((id) => id !== 'q_open_book' && want[id])) ok(JSON.stringify(qs[id].maps) === JSON.stringify(want[id]), `untouched quest ${id} takes the new maps`);
    ok(gm.state.maps['map_lib_office-floor'].name === 'Renommée par le MJ', 'existing table map is not replaced by the seed');
    ok(gm.state.maps['map_lib_tailor-shop'], 'missing seed maps are added');
    gm.socket.close();
  } finally {
    await srv2.stop();
  }
}
fs.rmSync(runtime, { recursive: true, force: true });
console.log(`${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
