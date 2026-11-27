// Builds the "vierge" (blank campaign) content pack from the Project Lazarus seeds: node tools/build-packs.ts
//   data/packs/vierge/bestiary/generic.json  generic NPC templates only (no campaign cast, no Foundry-specific NPCs)
//   data/packs/vierge/audio.json             generic audio scenes (no Foundry playlists, no map links)
//   data/packs/vierge/shop.json              no fixer deals
//   data/packs/vierge/campaign.json          empty acts/quests/sessions
// No actors/ and no maps/: a blank table starts without PCs nor maps. Re-run after editing data/seed/bestiary/core.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioScene, AudioTrack, Template } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'data', 'seed');
const OUT = path.join(ROOT, 'data', 'packs', 'vierge');

const GENERIC_FOLDERS = new Set(['Gangs', 'Sécurité corpo', 'Spécialistes', 'Matrice', 'Créatures']);
const EXCLUDED_IDS = new Set(['tpl_host_hollow_pine']);
const CAMPAIGN_WORDS = /lazarus|ag chemie|hollow pine|dorian|ashe\b|cabana|porfla|passeur|nachtigall|family business|open book|cleanup crew/i;

/** Remove campaign-specific sentences / Foundry notes from a markdown description. */
function scrub(text: unknown): string {
  let s = String(text || '').replace(/\n*---\n\*Foundry :\*[\s\S]*$/, '');
  s = s
    .split('\n')
    .map((line) => line.split(/(?<=[.!?;])\s+/).filter((sentence) => !CAMPAIGN_WORDS.test(sentence)).join(' '))
    .filter((line, i, arr) => line.trim() || (arr[i - 1] || '').trim())
    .join('\n')
    .trim();
  return s;
}

/** A seed template; older seeds still carry the Foundry id at the top level. */
type SeedTemplate = Template & { foundryId?: string };

const templates: SeedTemplate[] = [];
for (const file of ['core.json']) {
  const list: SeedTemplate[] = JSON.parse(fs.readFileSync(path.join(SEED, 'bestiary', file), 'utf8'));
  for (const t of list) {
    if (!GENERIC_FOLDERS.has(t.folder) || EXCLUDED_IDS.has(t.id)) continue;
    const c = structuredClone(t);
    if (c.description) c.description = scrub(c.description);
    if (c.npc?.tactics) c.npc.tactics = scrub(c.npc.tactics);
    if (c.npc?.loot) c.npc.loot = scrub(c.npc.loot);
    if (c.gmNotes) c.gmNotes = scrub(c.gmNotes);
    if (c.matrix?.device && CAMPAIGN_WORDS.test(c.matrix.device)) c.matrix.device = c.matrix.device.replace(/Host\s+[^()]*?\s*(\(|$)/i, 'Host $1').replace(/\s+\(/, ' (').trim();
    // Imported Foundry portraits live in the Lazarus table's assets: not available to other tables.
    if (typeof c.portrait === 'string' && c.portrait.startsWith('/assets/')) delete c.portrait;
    delete c.foundryId;
    delete c.foundry;
    const left = JSON.stringify(c).match(CAMPAIGN_WORDS);
    if (left) console.warn(`  ! ${c.id}: still mentions « ${left[0]} »`);
    templates.push(c);
  }
}

const audioSeed: { tracks?: AudioTrack[]; scenes?: AudioScene[] } = JSON.parse(fs.readFileSync(path.join(SEED, 'audio.json'), 'utf8'));
const GENERIC_SCENES = new Set(['scn-matrice', 'scn-chantier', 'scn-combat', 'scn-poursuite', 'scn-victoire', 'scn-accueil']);
const scenes = (audioSeed.scenes || []).filter((s) => GENERIC_SCENES.has(s.id)).map(({ mapId, ...s }) => s);

fs.mkdirSync(path.join(OUT, 'bestiary'), { recursive: true });
const write = (rel: string, value: unknown) => fs.writeFileSync(path.join(OUT, rel), JSON.stringify(value, null, 2) + '\n');
write('bestiary/generic.json', templates);
// The music library (data/assets/music, shared by every table) is generic: Foundry playlists are not.
const tracks = (audioSeed.tracks || []).filter((t) => String(t.url || '').startsWith('/assets/music/'));
write('audio.json', { tracks, scenes });
write('shop.json', { specials: [] });
write('campaign.json', { acts: [], quests: [], sessions: [], threads: [], handouts: [], playerRecap: '', notes: '' });
console.log(`pack vierge : ${templates.length} modèles (${[...new Set(templates.map((t) => t.folder))].join(', ')}), ${scenes.length} scènes audio → ${path.relative(ROOT, OUT)}`);
