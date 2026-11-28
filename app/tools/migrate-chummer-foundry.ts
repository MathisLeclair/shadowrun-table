// Migrate a PC that came from Foundry VTT onto its old Chummer file: the Chummer file gives back what the Chummer →
// Foundry conversion lost (ware grade and subsystems, nested gear, vehicle mods, languages, guids, portrait), the app
// actor keeps what changed in play since (karma, nuyen, ratings, new contacts and gear, ammo). Merge rules:
// tools/lib/chummer-foundry-merge.ts. Background: ../Shadowrun/historique-chummer.md.
//
//   node tools/migrate-chummer-foundry.ts --actor pc_christopher --seed [--dry-run]
//   node tools/migrate-chummer-foundry.ts --actor pc_christopher --url http://host:8095 [--table lazarus] --password <gm password> [--dry-run]
//
// Options:
//   --actor <id>      actor to migrate (required)
//   --seed            rewrite data/seed/actors/pcs.json (no Chummer XML or portrait stored: *.chum5 stays out of git)
//   --url <url>       running server (a table URL http://host/t/<slug>/ also selects the table); the actor is replaced
//                     through actor/update, the XML is stored (later Chummer re-imports merge against it) and the
//                     Chummer mugshots are uploaded (portrait set if the actor has none)
//   --table <slug>    table slug (default: the server's default table)
//   --password <pw>   GM password of that table (or env SR_GM_PASSWORD)
//   --chum5 <file>    Chummer file (default: ../Shadowrun_chum5_files/<chummerFile> from data/seed/upgrades-restore.json)
//   --date <text>     file date for the « to check » notes (default: chummerDate from the same spec)
//   --force           migrate even if the actor is already linked to that Chummer file
//   --dry-run         print what would change, write / send nothing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChum5 } from '../server/lib/chummer/parse.ts';
import { detachMugshots } from '../server/lib/chummer/export.ts';
import { fillActorRefs } from '../server/lib/bookrefs.ts';
import { normalizeActor } from '../client/modules/sheet/sheet-data.ts';
import { uid } from '../shared/util.ts';
import { login, client } from './test-client.ts';
import { mergeChummerFoundry } from './lib/chummer-foundry-merge.ts';
import type { MergeReport } from './lib/chummer-foundry-merge.ts';
import type { Actor, ChummerLink } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(ROOT, 'data/seed/actors/pcs.json');

interface Options {
  actor?: string;
  seed: boolean;
  url?: string;
  table?: string;
  password?: string;
  chum5?: string;
  date?: string;
  force: boolean;
  dryRun: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { seed: false, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    const k = a.replace(/=.*/, '');
    if (k === '--actor') o.actor = val();
    else if (k === '--seed') o.seed = true;
    else if (k === '--url') o.url = val();
    else if (k === '--table') o.table = val();
    else if (k === '--password') o.password = val();
    else if (k === '--chum5') o.chum5 = val();
    else if (k === '--date') o.date = val();
    else if (k === '--force') o.force = true;
    else if (k === '--dry-run') o.dryRun = true;
    else if (k === '--help' || k === '-h') o.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

interface Source {
  file: string;
  fileName: string;
  date: string;
}

/** The Chummer file of an actor: --chum5 / --date, else data/seed/upgrades-restore.json (`chummerFile`, `chummerDate`). */
function sourceFor(o: Options): Source {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/upgrades-restore.json'), 'utf8')) as { actors?: Record<string, { chummerFile?: string; chummerDate?: string }> };
  const s = spec.actors?.[o.actor!] || {};
  const file = o.chum5 || (s.chummerFile ? path.join(ROOT, '..', 'Shadowrun_chum5_files', s.chummerFile) : '');
  if (!file) throw new Error(`No Chummer file known for ${o.actor}: pass --chum5 <file>`);
  if (!fs.existsSync(file)) throw new Error(`Chummer file not found: ${file}`);
  const date = o.date || s.chummerDate || new Date(fs.statSync(file).mtimeMs).toLocaleDateString('fr-FR');
  return { file, fileName: path.basename(file), date };
}

/** Image type of a Chummer mugshot (base64), for the upload file name. */
function imageExt(b64: string): string | null {
  const head = Buffer.from(b64.slice(0, 16), 'base64');
  if (head[0] === 0x89 && head[1] === 0x50) return '.png';
  if (head[0] === 0xff && head[1] === 0xd8) return '.jpg';
  if (head.slice(0, 3).toString() === 'GIF') return '.gif';
  if (head.slice(8, 12).toString() === 'WEBP') return '.webp';
  return null;
}

interface Prepared {
  actor: Actor;
  report: MergeReport;
  mugshots: Array<{ b64: string; ext: string }>;
  mainIndex: number;
}

/** Parse the Chummer file and merge it into `app`. `keepXml`: store the XML in actor.chummer (running tables only). */
export function prepare(app: Actor, src: Source, { keepXml, now = Date.now() }: { keepXml: boolean; now?: number }): Prepared {
  const raw = fs.readFileSync(src.file, 'utf8').replace(/^﻿/, '');
  const mugshots: Prepared['mugshots'] = [];
  // Mugshots come out of the XML (a Chummer file is mostly images); unknown image types leave the file untouched.
  const det = detachMugshots(raw, (b64) => {
    const ext = imageExt(b64);
    if (!ext) return null;
    mugshots.push({ b64, ext });
    return `mugshot:${mugshots.length - 1}`;
  });
  const parsed = parseChum5(det.xml, { fileName: src.fileName, now, lang: 'fr' });
  const link = parsed.actor.chummer as ChummerLink;
  const chummer: ChummerLink = keepXml ? link : { ...link, xml: undefined };
  if (!keepXml) delete chummer.xml;
  const note = `Restauré depuis Chummer (fichier du ${src.date}) — à vérifier`;
  const history = {
    ts: now,
    text: `Migrated from Chummer (${src.fileName}, ${src.date}) and Foundry`,
    i18n: { key: 'Migrated from Chummer ({file}, {date}) and Foundry', params: { file: src.fileName, date: src.date } },
    chummer: true,
  };
  const gmNote = `Migré depuis Chummer (fichier du ${src.date}) et Foundry : la structure vient de Chummer (grade et sous-systèmes des implants, équipement imbriqué, véhicules, langues), l'état en jeu de Foundry (karma, nuyens, indices, contacts et objets ajoutés, munitions). Les objets notés « ${note} » étaient dans Chummer mais pas dans Foundry.`;
  const { actor, report } = mergeChummerFoundry(app, parsed.actor, { chummer, note, history, gmNote });
  normalizeActor(actor, uid);
  fillActorRefs(actor);
  return { actor, report, mugshots: det.urls.length ? mugshots : [], mainIndex: Math.max(0, det.mainIndex) };
}

function printReport(name: string, r: MergeReport): void {
  console.log(`${name}: ${r.matched} item(s) matched (Chummer structure, app play state)`);
  for (const s of r.scalars) console.log(`  value      ${s}`);
  for (const s of r.restored) console.log(`  restored   ${s}`);
  for (const s of r.kept) console.log(`  app only   ${s}`);
  for (const s of r.dropped) console.log(`  not taken  ${s}`);
}

function migrateSeed(o: Options, src: Source): number {
  const pcs = JSON.parse(fs.readFileSync(SEED, 'utf8')) as Actor[];
  const i = pcs.findIndex((a) => a.id === o.actor);
  if (i < 0) throw new Error(`${o.actor} is not in ${SEED}`);
  if (pcs[i].chummer?.fileName === src.fileName && !o.force) {
    console.log(`${pcs[i].name} is already migrated from ${src.fileName} (--force to redo it).`);
    return 0;
  }
  const { actor, report } = prepare(pcs[i], src, { keepXml: false });
  printReport(actor.name, report);
  if (o.dryRun) {
    console.log('[dry-run] seed not written.');
    return 0;
  }
  pcs[i] = actor;
  fs.writeFileSync(SEED, JSON.stringify(pcs, null, 2) + '\n');
  console.log(`Written: ${path.relative(ROOT, SEED)}`);
  return 0;
}

async function migrateLive(o: Options, src: Source): Promise<number> {
  const u = new URL(o.url!);
  const m = /^\/t\/([^/]+)/.exec(u.pathname);
  const table = o.table || (m ? decodeURIComponent(m[1]) : undefined);
  const url = u.origin;
  const password = o.password ?? process.env.SR_GM_PASSWORD;
  if (!password) throw new Error('GM password required (--password or SR_GM_PASSWORD)');
  console.log(`${o.dryRun ? '[dry-run] ' : ''}${url}${table ? ` table « ${table} »` : ' (default table)'}`);
  const token = await login(url, { role: 'gm', password, ...(table ? { table } : {}) });
  const gm = await client(url, token, table ? { table } : {});
  try {
    const live = gm.state.actors?.[o.actor as Actor['id']];
    if (!live) throw new Error(`${o.actor} is not on that table`);
    if (live.chummer?.fileName === src.fileName && !o.force) {
      console.log(`${live.name} is already migrated from ${src.fileName} (--force to redo it).`);
      return 0;
    }
    const { actor, report, mugshots, mainIndex } = prepare(live, src, { keepXml: true });
    printReport(actor.name, report);
    if (o.dryRun) {
      console.log(`[dry-run] nothing sent${mugshots.length ? ` (${mugshots.length} portrait(s) would be uploaded)` : ''}.`);
      return 0;
    }
    const urls: string[] = [];
    for (const [k, img] of mugshots.entries()) {
      const r = await fetch(`${url}/api/upload${table ? `?table=${encodeURIComponent(table)}` : ''}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-filename': `${o.actor}-chummer-${k}${img.ext}`, 'content-type': 'application/octet-stream' },
        body: Buffer.from(img.b64, 'base64'),
      });
      const j = (await r.json()) as { url?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(`Portrait upload failed: ${j.error || r.status}`);
      urls.push(j.url);
    }
    if (urls.length) actor.chummer!.mugshots = urls;
    const { id: _id, portrait: _portrait, ...patch } = actor;
    await gm.send('actor/update', { actorId: actor.id, patch });
    // Portrait apart: servers before 2026-11-28 refuse /t/<slug>/uploads URLs, which must not block the migration.
    if (urls.length && !actor.portrait) {
      try {
        await gm.send('actor/update', { actorId: actor.id, patch: { portrait: urls[mainIndex] || urls[0] } });
      } catch (e) {
        console.log(`! portrait not set (${(e as Error).message}): pick it on the sheet, the files are uploaded (${urls.join(', ')}).`);
      }
    }
    await Promise.race([gm.nextState(), new Promise((r) => setTimeout(r, 1500))]);
    const after = gm.state.actors[actor.id];
    console.log(`Done: ${after.name} — karma ${after.karma}/${after.karmaTotal}, ${after.nuyen} ¥, ${after.augmentations.length} augmentation(s), ${after.gear.length} gear, ${after.vehicles.length} vehicle(s)${urls.length ? `, ${urls.length} portrait(s)` : ''}.`);
    return 0;
  } finally {
    gm.close();
  }
}

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.actor || (!o.seed && !o.url) || (o.seed && o.url)) {
    console.log('Usage: node tools/migrate-chummer-foundry.ts --actor <id> (--seed | --url <server url> [--table <slug>] --password <gm password>) [--chum5 <file>] [--date <text>] [--force] [--dry-run]');
    return o.help ? 0 : 2;
  }
  const src = sourceFor(o);
  return o.seed ? migrateSeed(o, src) : migrateLive(o, src);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code), (e: Error) => { console.error(`Error: ${e.message}`); process.exit(1); });
}
