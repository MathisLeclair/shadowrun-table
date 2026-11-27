#!/usr/bin/env node
// Foundry VTT → app seeds.
//   node tools/foundry-import.ts                       analyse the detected world and print a summary
//   node tools/foundry-import.ts --write-seeds         regenerate the seeds from Foundry (PCs, bestiary, maps, audio,
//                                                      quest map links), copy assets, write journals to ../Shadowrun/foundry
// Options: --world <path>   Foundry world folder (default: auto-detected from %LOCALAPPDATA%/FoundryVTT/Config/options.json)
//          --dump <dir>     read an exploration dump ({actors,scenes,…}.json) instead of the LevelDB
//          --no-audio       do not copy playlist files (tracks are still added)   --no-journals   skip journals
// Foundry folders are only read (LevelDB from a temp copy).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorld, readDump, detectWorldPath } from '../server/lib/foundry/world.ts';
import { buildBundle, buildPc, buildTemplate, buildMap, scanBundle } from '../server/lib/foundry/importer.ts';
import { createAssets, formatBytes } from '../server/lib/foundry/assets.ts';
import type { Actor, AudioState, AudioTrack, Campaign, GameMap, Template } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'data', 'seed');
const DOCS_OUT = path.resolve(ROOT, '..', 'Shadowrun', 'foundry');

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};
const readJson = <T>(f: string, fb: T): T => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};
const writeJson = (f: string, v: unknown, indent = 2) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, indent) + '\n', 'utf8');
};

const worldPath = opt('--world') || detectWorldPath();
const dump = opt('--dump');
console.log(`Foundry world: ${worldPath}${dump ? ` (dump ${dump})` : ''}`);
const world = dump ? readDump(dump, worldPath) : await readWorld(worldPath);
const now = Date.now();
const assets = createAssets({ dataRoot: world.dataRoot });
const bundle = buildBundle(world, { now, assets });

// Pseudo-state from the current seeds, for status/diffs.
const seedPcs = readJson<Actor[]>(path.join(SEED, 'actors', 'pcs.json'), []);
const corePath = path.join(SEED, 'bestiary', 'core.json');
const foundryTplPath = path.join(SEED, 'bestiary', 'foundry.json');
/** A seed template; older seeds still carry the Foundry id at the top level. */
type SeedTemplate = Template & { foundryId?: string };
const core = readJson<SeedTemplate[]>(corePath, []);
const foundryTpl = readJson<Template[]>(foundryTplPath, []);
const mapsDir = path.join(SEED, 'maps');
const seedMaps = Object.fromEntries(
  fs.readdirSync(mapsDir).filter((f) => f.endsWith('.json')).map((f) => readJson<GameMap | null>(path.join(mapsDir, f), null)).filter((m): m is GameMap => !!m).map((m) => [m.id, m]),
);
const pseudo = {
  actors: Object.fromEntries(seedPcs.map((a) => [a.id, a])),
  bestiary: Object.fromEntries([...core, ...foundryTpl].map((t) => [t.id, t])),
  maps: seedMaps,
  audio: readJson(path.join(SEED, 'audio.json'), { tracks: [] as AudioTrack[] }) as AudioState,
};
const scan = scanBundle(pseudo, bundle, { docsDir: DOCS_OUT });
console.log(`\nPCs: ${scan.pcs.map((p) => `${p.name} [${p.status}]`).join(', ')}`);
for (const p of scan.pcs) if (p.diff.length) console.log(`  ${p.name}:\n    - ${p.diff.join('\n    - ')}`);
console.log(`NPCs: ${scan.npcs.length} (${scan.npcs.filter((n) => n.matched).length} linked to the existing bestiary)`);
console.log(`Scenes: ${scan.scenes.length}${scan.skippedScenes.length ? ` (+${scan.skippedScenes.length} skipped)` : ''}`);
console.log(`Journals: ${scan.journals.docs.length} (+${scan.journals.pdfs} PDFs listed)`);
console.log(`Playlists: ${scan.playlists.map((p) => `${p.name} ${p.tracks} tracks ${p.size}`).join(', ')} — audio total ${scan.audio.size}`);
if (scan.missingAssets.length) console.log(`Missing files: ${scan.missingAssets.length} (e.g. ${scan.missingAssets.slice(0, 3).join(', ')})`);

if (!flag('--write-seeds')) {
  console.log('\n(analysis only — add --write-seeds to regenerate the seeds)');
  process.exit(0);
}

// --- PCs
const order = ['pc_anthony', 'pc_jane', 'pc_bricks', 'pc_anklay', 'pc_christopher'];
const outPcs: Actor[] = [];
bundle.pcs.forEach((pc, i) => {
  const existing = seedPcs.find((a) => a.id === pc.appId) || null;
  const a = buildPc(pc, existing, { mode: 'replace', now, worldId: bundle.worldId, index: i });
  // Verification notes written from the old recap are obsolete now that Foundry is the source.
  if (/À vérifier/i.test(a.notes || '') || !a.notes) a.notes = `Fiche synchronisée depuis Foundry VTT (monde « ${bundle.worldTitle} »). Les changements faits dans Foundry arrivent ici quand le MJ relance l'import.`;
  outPcs.push(a);
});
for (const a of seedPcs) if (!outPcs.some((x) => x.id === a.id)) outPcs.push(a);
outPcs.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
writeJson(path.join(SEED, 'actors', 'pcs.json'), outPcs);
console.log(`\n✔ data/seed/actors/pcs.json: ${outPcs.map((a) => `${a.id}${a.retired ? ' (retired)' : ''}`).join(', ')}`);

// --- Bestiary
const newTpl: Template[] = [];
let updated = 0;
for (const npc of bundle.npcs) {
  const i = core.findIndex((t) => t.id === npc.templateId || (t.foundryId && t.foundryId === npc.fid));
  if (i >= 0) {
    core[i] = buildTemplate(npc, core[i], { now, worldId: bundle.worldId });
    updated++;
  } else {
    const prev = foundryTpl.find((t) => t.id === npc.templateId) || null;
    newTpl.push(buildTemplate(npc, prev, { now, worldId: bundle.worldId }));
  }
}
writeJson(corePath, core, 1);
writeJson(foundryTplPath, newTpl, 1);
console.log(`✔ bestiary: ${updated} templates updated (core.json), ${newTpl.length} new (foundry.json)`);

// --- Maps
const written = new Set<string>();
for (const sc of bundle.scenes) {
  const file = `foundry-${sc.map.id.replace(/^map_fvtt_/, '')}.json`;
  const m = buildMap(sc, null);
  writeJson(path.join(mapsDir, file), m);
  written.add(file);
}
for (const f of fs.readdirSync(mapsDir)) if (f.startsWith('foundry-') && !written.has(f)) fs.rmSync(path.join(mapsDir, f));
console.log(`✔ maps: ${written.size} files data/seed/maps/foundry-*.json`);

// --- Audio tracks
const audioPath = path.join(SEED, 'audio.json');
const audio = readJson<Pick<AudioState, 'tracks' | 'scenes'>>(audioPath, { tracks: [], scenes: [] });
const fvttTracks = bundle.playlists.flatMap((p) => p.tracks);
audio.tracks = [...(audio.tracks || []).filter((t) => !String(t.id).startsWith('trk_fvtt_')), ...fvttTracks];
const line = (o: unknown) => `    ${JSON.stringify(o)}`;
fs.writeFileSync(audioPath, `{\n  "tracks": [\n${audio.tracks.map(line).join(',\n')}\n  ],\n  "scenes": [\n${(audio.scenes || []).map(line).join(',\n')}\n  ]\n}\n`, 'utf8');
console.log(`✔ audio.json: ${fvttTracks.length} Foundry tracks`);

// --- Quest map links (campaign.json)
const campPath = path.join(SEED, 'campaign.json');
const camp = readJson<Campaign | null>(campPath, null);
let links = 0;
if (camp?.quests) {
  for (const sc of bundle.scenes) {
    if (!sc.appMapId) continue;
    for (const q of camp.quests) {
      if (Array.isArray(q.maps) && q.maps.includes(sc.appMapId) && !q.maps.includes(sc.map.id)) {
        q.maps.splice(q.maps.indexOf(sc.appMapId) + 1, 0, sc.map.id);
        links++;
      }
    }
  }
  writeJson(campPath, camp);
}
console.log(`✔ campaign.json: ${links} map links added to quests`);

// --- Journals
if (!flag('--no-journals')) {
  fs.mkdirSync(DOCS_OUT, { recursive: true });
  for (const d of bundle.journals.docs) fs.writeFileSync(path.join(DOCS_OUT, d.file), d.content, 'utf8');
  fs.writeFileSync(path.join(DOCS_OUT, '_index.md'), bundle.journals.index, 'utf8');
  console.log(`✔ journals: ${bundle.journals.docs.length} files in ${DOCS_OUT}`);
}

// --- Assets
const kinds = ['img', 'scene', 'thumb', 'journal', ...(flag('--no-audio') ? [] : ['audio'])];
const t0 = Date.now();
const res = assets.copySync(kinds);
console.log(`✔ files: ${res.copied} copied, ${res.skipped} already up to date — ${formatBytes(res.bytes)} in data/assets/foundry (${Math.round((Date.now() - t0) / 100) / 10} s)`);
const byKind: Record<string, number> = {};
for (const [, e] of assets.entries()) byKind[e.kind] = (byKind[e.kind] || 0) + e.size;
console.log(`  breakdown: ${Object.entries(byKind).map(([k, v]) => `${k} ${formatBytes(v)}`).join(', ')}`);
if (res.errors.length) console.log(`  errors: ${res.errors.slice(0, 5).join('; ')}`);
