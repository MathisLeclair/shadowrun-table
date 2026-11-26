// Tests of tools/restore-lifestyles.js (ports 3290-3291): historic Chummer lifestyle upgrades applied to a running table
// through GM actions — dry-run sends nothing, real run restores, second run is a no-op, nothing removed, money untouched.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = Number(process.env.SR_TEST_PORT) || 3290;
let failed = 0;
const ok = (c, msg) => { console.log(`${c ? '  ok  ' : '  FAIL'} ${msg}`); if (!c) failed++; };

const pcs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/actors/pcs.json'), 'utf8'));
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/upgrades-restore.json'), 'utf8'));
const DOC_GOLD = '4f2d39cd-fbc7-4d02-a3eb-f8decdb9a415';
const EXTRA_SECURE = '4fb84713-6171-409d-ad7c-ccbc44b891ad';

/** The PCs as the live table had them before the lifestyles[] version: one legacy `lifestyle`, Foundry total rent. */
const LIVE_RENT = { pc_anthony: 7083, pc_jane: 5000, pc_bricks: 5000, pc_anklay: 2000, pc_christopher: 10000 };
function legacyActors() {
  const out = {};
  for (const a of pcs) {
    const x = JSON.parse(JSON.stringify(a));
    const l = x.lifestyles.find((y) => y.primary) || x.lifestyles[0];
    x.lifestyle = { name: l.name, monthlyCost: LIVE_RENT[x.id] ?? l.monthlyCost, monthsPaid: l.monthsPaid };
    delete x.lifestyles;
    out[x.id] = x;
  }
  return out;
}
const tableState = (actors, shop) => ({ version: 1, config: { gmPassword: 'pw-restore', campaignName: 'Restore', lang: 'fr' }, users: {}, log: [], actors, ...(shop ? { shop } : {}) });

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['tools/restore-lifestyles.js', ...args], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
}
const life = (c, id) => c.state.actors[id].lifestyles;
const prim = (c, id) => life(c, id).find((l) => l.primary);

// --- 1. Boot restore skipped (shop.restored already lists the PCs): the script does the work ------------------------
const ids = Object.keys(LIVE_RENT);
const actors = legacyActors();
let srv = await startServer({
  port: BASE,
  tables: [
    { id: 'lazarus', pack: 'project-lazarus', gmPassword: 'pw-restore', state: tableState(actors, { restored: ids }) },
    { id: 'autre', pack: 'vierge', gmPassword: 'pw-other' },
  ],
});
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'pw-restore', table: 'lazarus' }), { table: 'lazarus' });
  await settle();
  // A GM already added Extra Secure by hand on Jane (must be kept, not duplicated); Bricks' lifestyle was renamed.
  const jl = prim(gm, 'pc_jane');
  ok(jl && !jl.qualities.length && jl.monthlyCost === 5000, 'legacy lifestyle migrated, no upgrade yet (boot restore skipped)');
  await gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'lifestyles', itemId: jl.id, sub: 'qualities', item: { catalogId: EXTRA_SECURE, name: 'Extra Secure', category: 'Positive', cost: 0, multiplier: 20, notes: 'ajout MJ' } });
  await gm.send('actor/updateItem', { actorId: 'pc_bricks', list: 'lifestyles', itemId: prim(gm, 'pc_bricks').id, patch: { name: 'Planque de Bricks' } });
  await settle();
  const money0 = Object.fromEntries(ids.map((id) => [id, [gm.state.actors[id].karma, gm.state.actors[id].nuyen]]));
  const snap0 = JSON.stringify(ids.map((id) => life(gm, id)));

  console.log('• errors');
  let r = await run(['--url', srv.url, '--table', 'lazarus', '--password', 'wrong', '--dry-run']);
  ok(r.code === 1 && /Error/.test(r.out), 'wrong GM password → exit 1');
  r = await run(['--table', 'lazarus']);
  ok(r.code === 2 && /Usage/.test(r.out), 'missing --url → usage');

  console.log('• dry-run');
  r = await run(['--url', `${srv.url}/t/lazarus/`, '--password', 'pw-restore', '--dry-run']);
  ok(r.code === 0, `dry-run exit 0 (got ${r.code})`);
  ok(/would: Jane: Best Home \(Moyen\): add Contrat DocWagon \(Or\)/.test(r.out), 'plans DocWagon Gold for Jane');
  ok(/Ultra-sécurisé already present/.test(r.out) && !/would: Jane: .*Ultra-sécurisé/.test(r.out), 'Extra Secure added by the GM is detected, not planned again');
  ok(/would: Bricks: Planque de Bricks: add Contrat DocWagon/.test(r.out) && /lifestyle « Planque de Bricks » used \(only/.test(r.out), 'renamed single lifestyle still targeted');
  ok(/would: Ank’ Lay: Home \(Bas\): set catalogId=/.test(r.out), 'Ank’Lay: base lifestyle linked to the catalog (Low)');
  ok(/would: Christopher Armingstar: The Lounge \(Haut\): append the historic Chummer lifestyle/.test(r.out), 'Christopher: historic lifestyle as a note only');
  ok(/Anthony Von Schloss: not restored \(no Chummer file\)/.test(r.out) && !/would: Anthony/.test(r.out), 'Anthony (inferred) flagged, not changed');
  await settle();
  ok(JSON.stringify(ids.map((id) => life(gm, id))) === snap0, 'dry-run changed nothing');

  console.log('• real run');
  r = await run(['--url', srv.url, '--table', 'lazarus', '--password', 'pw-restore']);
  ok(r.code === 0, `real run exit 0 (got ${r.code})${r.code ? `\n${r.out}` : ''}`);
  await settle();
  const j = prim(gm, 'pc_jane');
  ok(j.qualities.length === 4 && j.qualities.filter((q) => q.catalogId === EXTRA_SECURE).length === 1, 'Jane: 4 options, Extra Secure not duplicated');
  ok(j.qualities.find((q) => q.catalogId === EXTRA_SECURE).notes === 'ajout MJ', 'existing option kept untouched');
  ok(j.monthlyCost === 8583 && j.baseCost === 5000 && j.catalogId, `Jane: 8583 ¥/month (got ${j.monthlyCost})`);
  const dg = j.qualities.find((q) => q.catalogId === DOC_GOLD);
  ok(dg && dg.notes === spec.actors.pc_jane.note && /fichier du 01\/08\/2020/.test(dg.notes) && dg.nameFr === 'Contrat DocWagon (Or)', 'restored option carries « Restauré depuis Chummer (fichier du …) — à vérifier »');
  const b = prim(gm, 'pc_bricks');
  ok(b.name === 'Planque de Bricks' && b.qualities.length === 1 && b.monthlyCost === 7083, `Bricks: DocWagon Gold, 7083 ¥/month (got ${b.monthlyCost})`);
  const k = prim(gm, 'pc_anklay');
  ok(k.base === 'Low' && k.baseCost === 2000 && !k.qualities.length && k.catalogId === '451eef87-d18e-4bee-a972-1ee165b08522', 'Ank’Lay: Home (Low), no option');
  const c = prim(gm, 'pc_christopher');
  ok(c.name === 'The Lounge (Haut)' && c.monthlyCost === 10000 && !c.qualities.length && /The Hut/.test(c.notes) && /Garage/.test(c.notes), 'Christopher: current lifestyle kept, historic one in the notes');
  const an = prim(gm, 'pc_anthony');
  ok(!an.qualities.length && an.monthlyCost === 7083, 'Anthony untouched (7083 ¥/month)');
  ok(ids.every((id) => JSON.stringify([gm.state.actors[id].karma, gm.state.actors[id].nuyen]) === JSON.stringify(money0[id])), 'karma and nuyen unchanged');
  ok(/after  \* Best Home \(Moyen\) \[Medium\] 8 583 ¥\/month/.test(r.out), 'prints the result per lifestyle');

  console.log('• idempotent');
  const snap1 = JSON.stringify(ids.map((id) => life(gm, id)));
  r = await run(['--url', srv.url, '--table', 'lazarus', '--password', 'pw-restore']);
  ok(r.code === 0 && /Nothing to do/.test(r.out), 'second run: nothing to do');
  await settle();
  ok(JSON.stringify(ids.map((id) => life(gm, id))) === snap1, 'second run changed nothing');

  console.log('• --include-inferred');
  r = await run(['--url', srv.url, '--table', 'lazarus', '--password', 'pw-restore', '--include-inferred']);
  await settle();
  const an2 = prim(gm, 'pc_anthony');
  ok(r.code === 0 && an2.qualities.length === 1 && an2.baseCost === 5000 && an2.monthlyCost === 7083, `Anthony: rent split into Medium 5000 + DocWagon Gold, still 7083 (got ${an2.baseCost}/${an2.monthlyCost})`);

  console.log('• other table / server without lifestyles[]');
  r = await run(['--url', srv.url, '--table', 'autre', '--password', 'pw-other', '--dry-run']);
  ok(r.code === 0 && /actor not found/.test(r.out) && /Nothing to do/.test(r.out), 'table without these PCs: nothing to do');
  const { planRestore } = await import('./restore-lifestyles.js');
  let threw = '';
  try { planRestore({ pc_jane: { id: 'pc_jane', name: 'Jane', type: 'pc', lifestyle: { name: 'Best Home', monthlyCost: 5000 } } }, spec, { qualities: [], lifestyles: [] }); } catch (e) { threw = e.message; }
  ok(/deploy the lifestyles\[\] version first/.test(threw), 'old server (legacy lifestyle) → refuses with a clear message');
  gm.close();
} finally {
  await srv.stopAndWait();
}

// --- 2. Normal boot: the shop module already restored at boot, the script has nothing left to do -----------------
srv = await startServer({ port: BASE + 1, tables: [{ id: 'lazarus', pack: 'project-lazarus', gmPassword: 'pw-restore', state: tableState(legacyActors()) }] });
try {
  const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'pw-restore', table: 'lazarus' }), { table: 'lazarus' });
  await settle();
  console.log('• after the boot restore');
  const j = prim(gm, 'pc_jane');
  ok(j.qualities.length === 4 && j.monthlyCost === 8583 && j.qualities.every((q) => q.notes === spec.actors.pc_jane.note), 'boot restore: Jane 8583 ¥, notes « Restauré depuis Chummer (fichier du 01/08/2020) — à vérifier »');
  ok(/The Hut/.test(prim(gm, 'pc_christopher').notes || ''), 'boot restore: Christopher historic note');
  ok(!prim(gm, 'pc_anthony').qualities.length && prim(gm, 'pc_anthony').monthlyCost === 7083, 'boot restore: Anthony (inferred, no Chummer file) left alone — only --include-inferred applies it');
  const r = await run(['--url', srv.url, '--table', 'lazarus', '--password', 'pw-restore', '--dry-run']);
  ok(r.code === 0 && /Nothing to do/.test(r.out), 'script after the boot restore: nothing to do');
  gm.close();
} finally {
  await srv.stopAndWait();
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok');
process.exit(failed ? 1 : 0);
