// Tests of tools/migrate-chummer-foundry.ts (port 3273): the merge rules on hand-made actors, then the CLI against a
// running table (seed Jane, from Foundry, + the committed export of her Chummer file): dry-run sends nothing, a real
// run keeps play state and every app item, re-run is a no-op. Also: a portrait in the table's own uploads is accepted.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import { mergeChummerFoundry } from './lib/chummer-foundry-merge.ts';
import type { Actor } from '../shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SR_TEST_PORT) || 3273;
let failed = 0;
const ok = (c: unknown, msg: string) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${msg}`); if (!c) failed++; };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

// ---------- merge rules ----------
console.log('merge rules');
{
  const NOTE = 'Restauré depuis Chummer — à vérifier';
  const chum: Rec = {
    name: 'X', karma: 16, karmaTotal: 56, nuyen: 1000, streetCred: 7, notoriety: 8, publicAwareness: 0, player: 'Mathis',
    attributes: { STR: 2 }, matrix: { device: 'Fairlight Caliban' },
    skills: [{ id: 'pistols', name: 'Pistolets', rating: 5, spec: 'Revolvers' }, { id: 'perception', name: 'Perception', rating: 4 }],
    knowledge: [{ id: 'k1', name: 'Japanese', rating: 0, type: 'language', chummerGuid: 'gk' }, { id: 'k2', name: 'Yakuza', rating: 2, spec: 'Organizations' }],
    weapons: [
      { id: 'c1', name: 'Colt', catalogId: 'W1', chummerGuid: 'g1', accessories: [{ id: 's1', name: 'Laser Sight', catalogId: 'L1', chummerGuid: 'gs1' }] },
      { id: 'c2', name: 'Knife (Survival Kit)', catalogId: 'K2', chummerGuid: 'g2' },
    ],
    armor: [{ id: 'c3', name: 'Nice Undergarments', catalogId: 'N1', chummerGuid: 'g3', rating: 0 }],
    augmentations: [
      { id: 'c4', name: 'Cybereyes', catalogId: 'E1', grade: 'delta', chummerGuid: 'g4' },
      { id: 'c5', name: 'Thermo', catalogId: 'T1', grade: 'delta', notes: 'Sous-système de Cybereyes — SR5 p.453', chummerGuid: 'g5' },
    ],
    gear: [
      { id: 'c6', name: 'Ammo', catalogId: 'A1', qty: 50, chummerGuid: 'g6', location: 'chum_r' },
      { id: 'c7', name: 'Ammo', catalogId: 'A1', qty: 20, chummerGuid: 'g7' },
      { id: 'c8', name: 'Gas mask', catalogId: 'G1', qty: 1, chummerGuid: 'g8' },
      { id: 'c9', name: 'Fairlight Caliban', catalogId: 'F1', qty: 1, chummerGuid: 'g9' },
      { id: 'c10', name: 'Earbuds', catalogId: 'B1', qty: 1, rating: 1, chummerGuid: 'g10' },
    ],
    vehicles: [{ id: 'c11', name: 'Roadmaster', catalogId: 'V1', chummerGuid: 'g11' }],
    contacts: [{ id: 'c12', name: 'Dan', role: 'Police Chief', connection: 4, loyalty: 4, chummerGuid: 'g12' }],
    sins: [{ id: 'c13', name: 'Johnathan Doe', choice: 'Johnathan Doe', rating: 6, catalogId: 'S1', chummerGuid: 'g13', licenses: ['Weapon License'] }],
    lifestyles: [{ id: 'c14', name: 'The Hut', chummerGuid: 'g14' }],
    containers: [{ id: 'chum_r', name: 'Roadmaster', kind: 'other' }],
  };
  const app = {
    id: 'pc_x', type: 'pc', name: 'X', karma: 5, karmaTotal: 69, nuyen: 207159, streetCred: 2, notoriety: 0, publicAwareness: 0, player: '',
    attributes: { STR: 3 }, matrix: { device: 'Fairlight Caliban (commlink)', rating: 7 },
    skills: [{ id: 'pistols', name: 'Pistolets', rating: 6 }, { id: 'artillery', name: 'Artillerie', rating: 1 }],
    knowledge: [{ id: 'fk', name: 'Yakuza', rating: 3 }],
    weapons: [
      { id: 'f1', name: 'Colt', catalogId: 'W1', accessories: [{ id: 'r1', name: 'Laser Sight', catalogId: 'L1', notes: NOTE }, { id: 'r2', name: 'Silencer', catalogId: 'L2' }] },
      { id: 'f2', name: 'Couteau', catalogId: 'K9', notes: 'Knife (Survival Kit) (SR5 422)' },
    ],
    gear: [
      { id: 'f3', name: 'Nice Undergarments', catalogId: 'N1', qty: 1 },
      { id: 'f4', name: 'Ammo', catalogId: 'A1', qty: 20 },
      { id: 'f5', name: 'Ammo', catalogId: 'A1', qty: 31 },
      { id: 'f6', name: 'Earbuds', catalogId: 'B1', qty: 1, rating: 3 },
      { id: 'f7', name: 'Rope', catalogId: 'R1', qty: 1 },
    ],
    augmentations: [{ id: 'f8', name: 'Cybereyes', catalogId: 'E1', grade: 'standard' }],
    contacts: [{ id: 'f9', name: 'Dan', connection: 4, loyalty: 5, notes: 'Police Chief' }, { id: 'f10', name: 'Erik', connection: 4, loyalty: 1 }],
    sins: [{ id: 'f11', name: 'Faux SIN — Johnathan Doe', rating: 6, licenses: [], burned: true }],
    lifestyles: [{ id: 'f12', name: 'The Lounge (Haut)', monthlyCost: 10000 }],
    gmNotes: 'Old note',
  } as unknown as Actor;
  const before = JSON.stringify(app);
  const { actor, report } = mergeChummerFoundry(app, chum, { chummer: { fileName: 'x.chum5' }, note: NOTE, gmNote: 'Migré.', history: { ts: 1, text: 'm' } });
  const a = actor as unknown as Rec;
  const find = (l: string, id: string) => (a[l] as Rec[]).find((x) => x.id === id);
  ok(JSON.stringify(app) === before, 'the input actor is not changed');
  ok(a.karma === 5 && a.karmaTotal === 69 && a.nuyen === 207159 && a.attributes.STR === 3, 'karma, nuyen, attributes: app values');
  ok(a.streetCred === 8 && a.notoriety === 8, `street cred recomputed with the app career karma (${a.streetCred}), notoriety from Chummer (${a.notoriety})`);
  ok(a.player === 'Mathis', 'empty identity field filled from Chummer');
  ok(a.matrix.device === 'Fairlight Caliban' && a.matrix.rating === 7, 'matrix device named like the Chummer gear, app values kept');
  const pistols = a.skills.find((s: Rec) => s.id === 'pistols');
  ok(pistols.rating === 6 && pistols.spec === 'Revolvers', 'skill: app rating, Chummer specialization when the app has none');
  ok(a.skills.some((s: Rec) => s.id === 'artillery') && a.skills.some((s: Rec) => s.id === 'perception'), 'app-only and Chummer-only skills both kept');
  ok(a.knowledge.some((k: Rec) => k.name === 'Japanese' && k.type === 'language'), 'language restored');
  ok(a.knowledge.find((k: Rec) => k.name === 'Yakuza')?.rating === 3 && a.knowledge.find((k: Rec) => k.name === 'Yakuza')?.id === 'fk', 'knowledge: app rating and id');
  const colt = find('weapons', 'f1');
  ok(colt?.chummerGuid === 'g1', 'matched item keeps the app id and gets the Chummer guid');
  ok(colt?.accessories.length === 2 && colt.accessories.find((x: Rec) => x.catalogId === 'L1')?.id === 'r1' && !colt.accessories.find((x: Rec) => x.catalogId === 'L1').notes, 'restored accessory merged with Chummer\'s (app id, no restore note), app-added accessory kept');
  ok(find('weapons', 'f2')?.catalogId === 'K2', 'item matched through the English name in the Foundry notes');
  ok(find('armor', 'f3') && !find('gear', 'f3'), 'item matched across lists (Chummer armor ↔ Foundry gear) goes to the Chummer list');
  ok(find('gear', 'f4')?.chummerGuid === 'g7' && find('gear', 'f5')?.chummerGuid === 'g6' && find('gear', 'f5')?.qty === 31, 'same-catalog items paired by quantity first; app quantity kept');
  ok(find('gear', 'f5')?.location === 'chum_r', 'Chummer location kept');
  ok(find('gear', 'f6')?.rating === 3, 'gear rating: app value');
  ok(find('gear', 'f7'), 'app-only gear kept');
  ok(find('augmentations', 'f8')?.grade === 'delta', 'ware grade from Chummer');
  const thermo = a.augmentations.find((x: Rec) => x.name === 'Thermo');
  ok(thermo && !String(thermo.notes).includes(NOTE), 'subsystem restored without the « to check » note');
  ok(String(a.gear.find((x: Rec) => x.name === 'Gas mask')?.notes).includes(NOTE), 'Chummer-only top-level item restored with the note');
  ok(!String(a.gear.find((x: Rec) => x.name === 'Fairlight Caliban')?.notes || '').includes(NOTE), 'the matrix device gear is not marked « to check »');
  ok(String(a.vehicles[0]?.notes).includes(NOTE), 'vehicle restored with the note');
  ok(a.containers[0].kind === 'vehicle', 'a location named after a vehicle becomes a vehicle container');
  const dan = find('contacts', 'f9');
  ok(dan?.loyalty === 5 && dan.role === 'Police Chief' && dan.chummerGuid === 'g12', 'contact: app ratings, Chummer role and guid');
  ok(find('contacts', 'f10'), 'app-only contact kept');
  const sin = find('sins', 'f11');
  ok(sin?.chummerGuid === 'g13' && sin.burned === true && sin.licenses.length === 1, 'SIN matched by name: Chummer licenses, app burned state');
  ok(a.lifestyles.length === 1 && a.lifestyles[0].id === 'f12' && report.dropped.length === 1, 'lifestyles: the app\'s only, Chummer-only one not restored');
  ok(a.gmNotes === 'Old note\n\nMigré.' && a.history.length === 1 && a.chummer.fileName === 'x.chum5', 'GM note, history entry and Chummer link added');
  const again = mergeChummerFoundry(actor, chum, { chummer: { fileName: 'x.chum5' }, note: NOTE, gmNote: 'Migré.' }).actor as unknown as Rec;
  ok(again.gmNotes === a.gmNotes && again.gear.length === a.gear.length && again.augmentations.length === a.augmentations.length, 'merging twice adds nothing');
}

// ---------- CLI on a running table ----------
function run(...args: string[]): Promise<{ code: number | null; out: string }> {
  const stripTypes = process.execArgv.filter((a) => a === '--experimental-strip-types' || a === '--no-warnings');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [...stripTypes, 'tools/migrate-chummer-foundry.ts', ...args], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d: Buffer) => { out += d; });
    p.stderr.on('data', (d: Buffer) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

console.log('CLI on a running table');
const srv = await startServer({ port: PORT });
try {
  const token = await login(srv.url, { role: 'gm', password: 'lazarus' });
  const gm = await client(srv.url, token);
  const jane0 = structuredClone(gm.state.actors.pc_jane) as unknown as Rec;
  const LISTS = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'contacts', 'sins', 'qualities', 'lifestyles', 'knowledge'];
  const ids0 = LISTS.flatMap((l) => (jane0[l] || []).map((x: Rec) => x.id));
  const args = ['--actor', 'pc_jane', '--url', srv.url, '--password', 'lazarus', '--chum5', 'tools/fixtures/export-sample-jane.chum5', '--date', '28/11/2026'];

  const dry = await run(...args, '--dry-run');
  await settle();
  ok(dry.code === 0 && /\[dry-run\] nothing sent/.test(dry.out), 'dry-run exits 0 and says nothing was sent');
  ok(!gm.state.actors.pc_jane.chummer && gm.state.actors.pc_jane.gear.length === jane0.gear.length, 'dry-run changed nothing');

  const real = await run(...args);
  await settle(600);
  ok(real.code === 0 && /^Done: Jane/m.test(real.out), `real run exits 0 (${real.out.trim().split('\n').pop()})`);
  const j = gm.state.actors.pc_jane as unknown as Rec;
  ok(j.karma === jane0.karma && j.karmaTotal === jane0.karmaTotal && j.nuyen === jane0.nuyen, 'karma and nuyen untouched');
  const ids1 = new Set(LISTS.flatMap((l) => (j[l] || []).map((x: Rec) => x.id)));
  ok(ids0.every((id: string) => ids1.has(id)), 'every app item is still there, under the same id');
  ok(LISTS.every((l) => (j[l] || []).length >= (jane0[l] || []).length), 'no list got shorter');
  ok(j.gear.filter((x: Rec) => x.chummerGuid).length > 10, 'items carry their Chummer guid');
  ok(j.chummer?.fileName === 'export-sample-jane.chum5' && j.chummer.hasFile === true, 'Chummer link stored with its file (later re-imports merge against it)');
  ok(Array.isArray(j.chummer?.mugshots) && j.chummer.mugshots.length >= 1 && j.portrait === jane0.portrait, 'Chummer portraits uploaded, existing portrait kept');
  ok(j.history.at(-1)?.i18n?.key === 'Migrated from Chummer ({file}, {date}) and Foundry', 'history entry');
  ok(JSON.stringify(j.lifestyles.map((l: Rec) => [l.name, l.monthlyCost])) === JSON.stringify(jane0.lifestyles.map((l: Rec) => [l.name, l.monthlyCost])), 'lifestyles unchanged');

  const again = await run(...args);
  ok(again.code === 0 && /already migrated/.test(again.out), 're-run is a no-op');

  // Portraits in a table's own files (/t/<slug>/uploads|assets/…, non-legacy tables) are valid actor/update values.
  for (const url of [j.chummer.mugshots[0], '/t/other-table/uploads/abc-portrait.png', '/t/other-table/assets/foundry/img/x.png']) {
    await gm.send('actor/update', { actorId: 'pc_jane', patch: { portrait: url } });
    await settle();
    ok(gm.state.actors.pc_jane.portrait === url, `portrait accepted: ${url}`);
  }
  let refused = false;
  try { await gm.send('actor/update', { actorId: 'pc_jane', patch: { portrait: 'javascript:alert(1)' } }); } catch { refused = true; }
  ok(refused, 'other portrait URLs still refused');
  gm.close();
} finally {
  await srv.stopAndWait();
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
