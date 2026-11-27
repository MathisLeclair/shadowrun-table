// Restore the lifestyle upgrades (DocWagon, Extra Secure, Garage…) the PCs had in their old Chummer files on a RUNNING
// table, through the normal GM actions (actor/addSubItem, actor/updateItem). Idempotent: an upgrade already present
// (same catalog id or name) is skipped, nothing is ever removed, karma / nuyen / items are never touched.
//
//   node tools/restore-lifestyles.ts --url http://host:8095 --table lazarus --password <gm password> [--dry-run]
//
// Options:
//   --url <url>          server URL (required). A table URL (http://host/t/<slug>/) also selects the table.
//   --table <slug>       table slug (default: the server's default table)
//   --password <pw>      GM password of that table (or env SR_GM_PASSWORD)
//   --dry-run            print what would change, send nothing
//   --spec <file>        restore spec (default data/seed/upgrades-restore.json: `lifestyle`, `lifestyleNote`, `note` per actor)
//   --include-inferred   also apply specs marked `inferred` (not from a Chummer file: Anthony), skipped by default
//
// The server must already run the lifestyles[] version (actor.lifestyles). The shop module applies the same spec once per
// actor at boot (shop.restored), so on an up-to-date server this script usually reports « nothing to do »; it catches the
// cases the boot restore skips (lifestyle renamed, actor re-imported under another id, an option already added by hand…).
// Background: ../Shadowrun/historique-chummer.md. Tested by tools/test-restore-lifestyles.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, client } from './test-client.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { dryRun: false, includeInferred: false, spec: path.join(ROOT, 'data/seed/upgrades-restore.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    const k = a.split('=')[0];
    if (k === '--url') o.url = val();
    else if (k === '--table') o.table = val();
    else if (k === '--password') o.password = val();
    else if (k === '--spec') o.spec = val();
    else if (k === '--dry-run') o.dryRun = true;
    else if (k === '--include-inferred') o.includeInferred = true;
    else if (k === '--help' || k === '-h') o.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return o;
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const readCatalog = (name) => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/catalog', `${name}.json`), 'utf8'));
  return Array.isArray(j) ? j : j.items || [];
};
const fmt = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/ | /g, ' ')} ¥`;

/** Quality (lifestyle option) payload for actor/addSubItem, from a catalog entry. */
export function qualityPayload(item, notes) {
  const st = item.stats || {};
  const q = { catalogId: item.id, name: item.name, category: item.category || '', cost: Math.round(Number(item.cost) || 0), multiplier: Number(st.multiplier) || 0, ...(st.baseOnly ? { baseOnly: true } : {}) };
  if (item.nameFr) q.nameFr = item.nameFr;
  if (st.lp !== undefined) q.lp = Number(st.lp) || 0;
  if (notes) q.notes = String(notes).slice(0, 500);
  return q;
}

/** Find the actor of a spec: same id, else a PC with the same name. */
function findActor(actors, id, spec) {
  const byId = actors[id];
  if (byId) return byId;
  const want = fold(spec.actorName);
  return want ? Object.values(actors).find((a) => a && a.type === 'pc' && fold(a.name) === want) || null : null;
}

/** Find the lifestyle a spec targets: name match, else the only / primary lifestyle. Returns { l, how }. */
function findLifestyle(actor, match) {
  const list = actor.lifestyles || [];
  const m = fold(match);
  const byName = m && list.find((l) => fold(l.name).includes(m));
  if (byName) return { l: byName, how: 'name' };
  if (list.length === 1) return { l: list[0], how: 'only' };
  const prim = list.find((l) => l.primary);
  return prim ? { l: prim, how: 'primary' } : { l: null, how: 'none' };
}

/**
 * Plan the changes for every actor of the spec (pure: reads `actors`, returns steps). A step is
 * { actorId, actorName, kind: 'patch'|'addQuality'|'addLifestyle'|'note', payload, text } ; info/warn lines go to `messages`.
 */
export function planRestore(actors, spec, { qualities, lifestyles, includeInferred = false }) {
  const qById = new Map(qualities.map((q) => [q.id, q]));
  const steps = [];
  const messages = [];
  for (const [id, s] of Object.entries(spec.actors || {})) {
    if (!s.lifestyle && !s.lifestyleNote) continue;
    const a = findActor(actors, id, s);
    const label = s.actorName || id;
    if (!a) { messages.push({ level: 'warn', text: `${label}: actor not found (id ${id}), skipped` }); continue; }
    if (!Array.isArray(a.lifestyles)) throw new Error(`${a.name}: no actor.lifestyles on this server — deploy the lifestyles[] version first (old single lifestyle: ${JSON.stringify(a.lifestyle || null)})`);
    if (s.inferred && !includeInferred) {
      const l = s.lifestyle ? findLifestyle(a, s.lifestyle.match).l : null;
      const have = l ? (l.qualities || []).map((q) => q.nameFr || q.name).join(', ') || 'no option' : 'no lifestyle';
      messages.push({ level: 'warn', text: `${a.name}: not restored (no Chummer file). ${s.note || ''} Current: ${l ? `${l.name}, ${fmt(l.monthlyCost)}/month, ${have}` : have}. Use --include-inferred to apply.` });
      continue;
    }
    const base = { actorId: a.id, actorName: a.name };
    if (s.lifestyle) {
      const { l, how } = findLifestyle(a, s.lifestyle.match);
      const baseItem = lifestyles.find((x) => x.name === s.lifestyle.base);
      if (!l) {
        if (a.lifestyles.length) { messages.push({ level: 'warn', text: `${a.name}: several lifestyles and none named « ${s.lifestyle.match} », skipped` }); continue; }
        if (!baseItem) { messages.push({ level: 'warn', text: `${a.name}: unknown base lifestyle ${s.lifestyle.base}, skipped` }); continue; }
        // No lifestyle at all: add the historic one (no months paid), then its options.
        const item = { name: s.lifestyle.match, base: s.lifestyle.base, catalogId: baseItem.id, baseCost: Math.round(Number(baseItem.cost) || 0), monthsPaid: 0, primary: true, notes: s.note || '',
          qualities: (s.lifestyle.qualities || []).map((qid) => qById.get(qid)).filter(Boolean).map((q) => qualityPayload(q, s.note)) };
        steps.push({ ...base, kind: 'addLifestyle', payload: { actorId: a.id, list: 'lifestyles', item }, text: `add lifestyle « ${item.name} » (${s.lifestyle.base}) with ${item.qualities.length} option(s)` });
        continue;
      }
      if (how !== 'name') messages.push({ level: 'info', text: `${a.name}: lifestyle « ${l.name} » used (${how}; the Chummer one was « ${s.lifestyle.match} »)` });
      const present = l.qualities || [];
      const toAdd = [];
      for (const qid of s.lifestyle.qualities || []) {
        const q = qById.get(qid);
        if (!q) { messages.push({ level: 'warn', text: `${a.name}: option ${qid} not in data/catalog/lifestylequalities.json, skipped` }); continue; }
        const names = new Set([fold(q.name), fold(q.nameFr)].filter(Boolean));
        const dup = present.find((p) => p.catalogId === q.id || names.has(fold(p.name)) || names.has(fold(p.nameFr)));
        if (dup) { messages.push({ level: 'info', text: `${a.name} / ${l.name}: ${q.nameFr || q.name} already present` }); continue; }
        toAdd.push(q);
      }
      // Base lifestyle: only fill what the legacy migration could not know (catalog id; base cost = old TOTAL rent).
      if (baseItem && !l.catalogId) {
        if (l.base && l.base !== s.lifestyle.base) {
          messages.push({ level: 'warn', text: `${a.name} / ${l.name}: base ${l.base} on the sheet, ${s.lifestyle.base} in Chummer — base left as is` });
        } else {
          const patch = { catalogId: baseItem.id };
          if (!l.base) patch.base = s.lifestyle.base;
          const catCost = Math.round(Number(baseItem.cost) || 0);
          if (toAdd.length && !present.length && Number(l.baseCost) !== catCost) patch.baseCost = catCost;
          steps.push({ ...base, kind: 'patch', payload: { actorId: a.id, list: 'lifestyles', itemId: l.id, patch },
            text: `${l.name}: set ${Object.entries(patch).map(([k, v]) => `${k}=${k === 'baseCost' ? fmt(v) : v}`).join(', ')}` });
        }
      }
      for (const q of toAdd) {
        const item = qualityPayload(q, s.note);
        const effect = item.multiplier ? `${item.multiplier > 0 ? '+' : ''}${item.multiplier} %` : `${fmt(item.cost)}/month`;
        steps.push({ ...base, kind: 'addQuality', payload: { actorId: a.id, list: 'lifestyles', itemId: l.id, sub: 'qualities', item }, text: `${l.name}: add ${q.nameFr || q.name} (${q.name}, ${effect})` });
      }
    }
    if (s.lifestyleNote) {
      const l = (a.lifestyles || []).find((x) => x.primary) || a.lifestyles[0];
      if (!l) messages.push({ level: 'warn', text: `${a.name}: no lifestyle to carry the historic note` });
      else if (String(l.notes || '').includes(String(s.lifestyleNote).slice(0, 60))) messages.push({ level: 'info', text: `${a.name} / ${l.name}: historic note already present` });
      else {
        const notes = (l.notes ? `${l.notes}\n\n` : '') + s.lifestyleNote;
        steps.push({ ...base, kind: 'note', payload: { actorId: a.id, list: 'lifestyles', itemId: l.id, patch: { notes } }, text: `${l.name}: append the historic Chummer lifestyle to the notes (not restored)` });
      }
    }
  }
  return { steps, messages };
}

const ACTION = { patch: 'actor/updateItem', note: 'actor/updateItem', addQuality: 'actor/addSubItem', addLifestyle: 'actor/addItem' };

function summary(a) {
  return (a.lifestyles || []).map((l) => `${l.primary ? '*' : ' '} ${l.name} [${l.base || '?'}] ${fmt(l.monthlyCost)}/month — ${(l.qualities || []).map((q) => q.nameFr || q.name).join(', ') || 'no option'}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.url) {
    console.log('Usage: node tools/restore-lifestyles.ts --url <server url> [--table <slug>] --password <gm password> [--dry-run] [--spec <file>] [--include-inferred]');
    process.exit(o.help ? 0 : 2);
  }
  const u = new URL(o.url);
  const m = /^\/t\/([^/]+)/.exec(u.pathname);
  const table = o.table || (m ? decodeURIComponent(m[1]) : undefined);
  const url = u.origin;
  const password = o.password ?? process.env.SR_GM_PASSWORD;
  if (!password) throw new Error('GM password required (--password or SR_GM_PASSWORD)');
  const spec = JSON.parse(fs.readFileSync(o.spec, 'utf8'));
  const catalogs = { qualities: readCatalog('lifestylequalities'), lifestyles: readCatalog('lifestyles') };

  console.log(`${o.dryRun ? '[dry-run] ' : ''}${url}${table ? ` table « ${table} »` : ' (default table)'}`);
  const token = await login(url, { role: 'gm', password, ...(table ? { table } : {}) });
  const gm = await client(url, token, table ? { table } : {});
  try {
    const actors = gm.state.actors || {};
    const { steps, messages } = planRestore(actors, spec, { ...catalogs, includeInferred: o.includeInferred });
    for (const msg of messages) console.log(`${msg.level === 'warn' ? '!' : '-'} ${msg.text}`);
    if (!steps.length) {
      console.log('Nothing to do: every restorable lifestyle upgrade is already present.');
      return 0;
    }
    const touched = [...new Set(steps.map((s) => s.actorId))];
    const before = Object.fromEntries(touched.map((id) => [id, { karma: actors[id].karma, nuyen: actors[id].nuyen, lines: summary(actors[id]) }]));
    for (const s of steps) {
      if (o.dryRun) { console.log(`  would: ${s.actorName}: ${s.text}`); continue; }
      await gm.send(ACTION[s.kind], s.payload);
      console.log(`  done:  ${s.actorName}: ${s.text}`);
    }
    if (o.dryRun) {
      console.log(`[dry-run] ${steps.length} change(s) planned, nothing sent.`);
      return 0;
    }
    // Let the last broadcast arrive, then show the result and check that money / karma did not move.
    await Promise.race([gm.nextState(), new Promise((r) => setTimeout(r, 1500))]);
    await new Promise((r) => setTimeout(r, 300));
    let bad = 0;
    for (const id of touched) {
      const a = gm.state.actors[id];
      console.log(`${a.name}:`);
      for (const line of before[id].lines) console.log(`  before ${line}`);
      for (const line of summary(a)) console.log(`  after  ${line}`);
      if (a.karma !== before[id].karma || a.nuyen !== before[id].nuyen) { bad++; console.log(`  ! karma/nuyen changed: ${before[id].karma}/${before[id].nuyen} → ${a.karma}/${a.nuyen}`); }
    }
    console.log(`${steps.length} change(s) applied.`);
    return bad ? 1 : 0;
  } finally {
    gm.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code), (e) => { console.error(`Error: ${e.message}`); process.exit(1); });
}
