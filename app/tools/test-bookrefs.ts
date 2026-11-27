// Rulebook references (📖 chips) test: node tools/test-bookrefs.ts  (isolated servers on ports 3530-3531, exit code != 0 on failure)
// - every catalog entry (and martial-art technique) has a parseable « CODE page » reference of a known Chummer book;
// - shared/bookrefs.js tables: every SR5 skill has a page, rule pages hold their heading (checked in the SR5 text index
//   when data/books/index/SR5.json is present), complex forms, parsers;
// - server/lib/bookrefs.js: seed actors and bestiary templates resolve their items to a reference, fill is idempotent;
// - imports keep / derive source + page (Chummer <source>/<page>, Foundry system.description.source after the merge snapshot);
// - over the server: boot backfill of an old actor, GM catalog add / nested add, shop purchase, training, templates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, login, client, settle } from './test-client.ts';
import { SKILL_PAGES, RULE_REFS, CHARGEN_STEP_REFS, COMPLEX_FORM_PAGES, REF_LISTS, itemRef, normRef, parseRefText, refFromNotes, skillRef, complexFormRef } from '../shared/bookrefs.ts';
import { SKILLS } from '../shared/sr5.ts';
import { COMPLEX_FORMS } from '../shared/chargen.ts';
import { SUB_LISTS } from '../client/modules/sheet/sheet-data.ts';
import { parseSourceRef } from '../client/modules/books/refs.ts';
import { fillActorRefs, resolveItemRef, catalogRef } from '../server/lib/bookrefs.ts';
import { parseChum5 } from '../server/lib/chummer/parse.ts';
import { convertSheet } from '../server/lib/foundry/convert-actor.ts';
import { buildPc } from '../server/lib/foundry/importer.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else {
    failures++;
    console.error('  ✗', msg);
  }
}

// ---------------------------------------------------------------------------
console.log('• catalog entries: parseable source + page of a known book');
// Chummer data with no page at all (bookkeeping items, « 0 » in Chummer 5.226): the chip opens the book at its first page.
const KNOWN_NO_PAGE = new Set(['cyberware:Essence Hole', 'cyberware:Essence Antihole', 'weapons:HK MP75']);
const bookNames = readJson('server', 'lib', 'books', 'book-names.json');
const CATALOG_FILES = fs.readdirSync(path.join(ROOT, 'data', 'catalog')).filter((f) => f.endsWith('.json') && !['index.json', 'effects.json'].includes(f));
let entries = 0;
const badEntries = [];
for (const f of CATALOG_FILES) {
  const file = f.replace(/\.json$/, '');
  const list = readJson('data', 'catalog', f);
  ok(Array.isArray(list) && list.length > 0, `${f} is a non-empty list`);
  const check = (e, label) => {
    entries++;
    const r = normRef(e.source, e.page);
    const known = r && Object.prototype.hasOwnProperty.call(bookNames, r.source);
    const paged = r && r.page > 0;
    if (!r || !known || (!paged && !KNOWN_NO_PAGE.has(label))) badEntries.push(`${label} (${e.source} / ${e.page})`);
    // The client parser agrees (BookRef renders exactly this reference).
    const c = parseSourceRef(e.source, e.page);
    if (r && paged && !(c && c.code === r.source && c.page === r.page)) badEntries.push(`${label}: client parser gives ${JSON.stringify(c)}`);
  };
  for (const e of Array.isArray(list) ? list : []) {
    check(e, `${file}:${e.name}`);
    for (const tq of e.stats?.techniques || []) check(tq, `${file}:${e.name} › ${tq.name}`);
  }
}
ok(entries > 4000, `catalog entries checked: ${entries}`);
ok(!badEntries.length, `catalog entries without a usable reference: ${badEntries.slice(0, 12).join(', ')}${badEntries.length > 12 ? ` … (${badEntries.length})` : ''}`);
ok(catalogRef(readJson('data', 'catalog', 'qualities.json').find((q) => q.name === 'Ambidextrous').id)?.source === 'SR5', 'catalogRef(id) finds a catalog entry');
const tech = readJson('data', 'catalog', 'martialarts.json').flatMap((m) => m.stats?.techniques || []).find((x) => x.id);
ok(catalogRef(tech.id)?.page === Number(tech.page), 'catalogRef(id) finds a martial-art technique');
const smartTires = readJson('data', 'catalog', 'vehiclemods.json').find((m) => m.name === 'Smart Tires');
ok(smartTires && Number(smartTires.page) > 0, `model-specific vehicle mods get their vehicle's page (Smart Tires: ${smartTires?.source} ${smartTires?.page})`);

// ---------------------------------------------------------------------------
console.log('• shared/bookrefs.js tables and parsers');
for (const s of SKILLS) ok(SKILL_PAGES[s.id] > 0 && skillRef(s.id)?.source === 'SR5', `skill ${s.id} has an SR5 page`);
ok(skillRef('pistols').page === 132 && skillRef('hacking').page === 145 && skillRef('con').page === 138, 'skill pages from Chummer skills.xml (Pistols 132, Hacking 145, Con 138)');
ok(skillRef('custom_thing') === null, 'custom skill: no reference');
for (const f of COMPLEX_FORMS) ok(complexFormRef(f)?.page === COMPLEX_FORM_PAGES[f.id], `complex form ${f.id} → SR5 ${COMPLEX_FORM_PAGES[f.id]}`);
ok(complexFormRef({ name: 'Resonance Spike' })?.page === 253 && complexFormRef({ name: 'Nettoyeur' })?.page === 252 && complexFormRef({ name: 'Diffusion of Firewall' })?.page === 252, 'complex forms by English / French name');
ok(RULE_REFS.limits.page === 46 && RULE_REFS.initiative.page === 159 && RULE_REFS.conditionMonitor.page === 169, 'limits SR5 46, initiative SR5 159, condition monitor SR5 169');
for (const [k, r] of [...Object.entries(RULE_REFS), ...Object.entries(CHARGEN_STEP_REFS)]) ok(bookNames[r.source] && r.page > 0, `rule ${k}: ${r.source} ${r.page}`);
ok(JSON.stringify(parseRefText('SR5 435')) === '{"source":"SR5","page":435}', 'parseRefText « SR5 435 »');
ok(parseRefText('SR5 p. 240')?.page === 240 && parseRefText('RG:62')?.source === 'RG' && parseRefText('RF 221, SR5 12')?.source === 'RF', 'parseRefText variants');
ok(parseRefText('GH3') === null && parseRefText('') === null && parseRefText('Run & Gun') === null, 'parseRefText: a code alone / free text is not a page reference');
ok(normRef('sr5', '435')?.source === 'SR5' && normRef('SR5 p.12')?.page === 12 && normRef('SHB2', 0)?.page === null && normRef('', 3) === null, 'normRef');
ok(refFromNotes('Low-Light Vision · SR5 66')?.page === 66 && refFromNotes('SR5 p.71 — trait du métatype')?.page === 71, 'refFromNotes (Foundry « · SR5 66 », Chummer « SR5 p.71 — … »)');
ok(refFromNotes('Indice 4 · 12 balles') === null && refFromNotes('Contact 3') === null, 'refFromNotes ignores numbers that are not book references');
ok(itemRef({ source: 'RG', page: 62 })?.page === 62 && itemRef({ name: 'x' }) === null, 'itemRef');

// Pages checked against the book text (only where the SR5 index exists: the GM's PC / the VPS).
const SR5_INDEX = path.join(ROOT, 'data', 'books', 'index', 'SR5.json');
if (fs.existsSync(SR5_INDEX) && fs.existsSync(path.join(ROOT, 'data', 'books', 'library.json'))) {
  const lib = readJson('data', 'books', 'library.json');
  const indexes = {};
  const text = (code, page) => {
    const b = lib.books.find((x) => x.code === code);
    const f = path.join(ROOT, 'data', 'books', 'index', `${code}.json`);
    if (!b || !fs.existsSync(f)) return null;
    indexes[code] ||= JSON.parse(fs.readFileSync(f, 'utf8'));
    return indexes[code].texts[page + (Number(b.offset) || 0) - 1] || '';
  };
  const HEADINGS = {
    limits: 'LIMITS', derived: 'FINAL CALCULATIONS', initiative: 'INITIATIVE', matrixInitiative: 'USER MODES', conditionMonitor: 'Condition Monitor',
    woundModifiers: 'WOUND MODIFIERS', armor: 'ARMOR', defense: 'DEFENDING IN COMBAT', soak: 'COMBAT SEQUENCE', attributeTests: 'COMPOSURE', movement: 'MOVEMENT',
    edge: 'EDGE', drain: 'DRAIN', powerPoints: 'POWER POINTS', adeptPowers: 'ADEPT POWERS', spellcasting: 'SPELLCASTING', complexForms: 'complex form',
    matrixDamage: 'MATRIX DAMAGE', biofeedback: 'BIOFEEDBACK', matrixActions: 'MATRIX ACTIONS', programs: 'PROGRAMS', ic: 'IC', overwatch: 'OVERWATCH', hosts: 'HOST',
    knowledgeSkills: 'KNOWLEDGE SKILLS', skillGroups: 'SKILL GROUPS', specializations: 'SPECIALIZATIONS', qualities: 'QUALITIES', lifestyles: 'LIFESTYLES', fakeSin: 'CHECKING A FAKE SIN', contacts: 'USING CONTACTS',
    martialArts: 'MARTIAL ARTS', priorityTable: 'PRIORITY TABLE', metatypes: 'METATYPE ATTRIBUTE TABLE', karmaAdvancement: 'CHARACTER ADVANCEMENT',
    initiation: 'INITIATION', submersion: 'SUBMERSION',
  };
  for (const [k, r] of Object.entries(RULE_REFS)) {
    const tx = text(r.source, r.page);
    if (tx === null) continue;
    ok(HEADINGS[k] && tx.includes(HEADINGS[k]), `rule « ${k} »: ${r.source} p. ${r.page} contains « ${HEADINGS[k]} »`);
  }
  const STEP_HEADINGS = { concept: 'CHOOSE CONCEPT', priorities: 'PRIORITY TABLE', metatype: 'METATYPE', attributes: 'ATTRIBUTE', magic: 'MAGIC OR RESONANCE', skills: 'PURCHASE SKILLS', qualities: 'PURCHASE QUALITIES', gear: 'RESOURCES', contacts: 'CONTACTS', summary: 'FINAL CALCULATIONS' };
  for (const [k, r] of Object.entries(CHARGEN_STEP_REFS)) ok(text(r.source, r.page)?.includes(STEP_HEADINGS[k]), `creator step « ${k} »: SR5 p. ${r.page} contains « ${STEP_HEADINGS[k]} »`);
  const SKILL_WORD = { exotic_weapon: 'EXOTIC', free_fall: 'FREE-FALL' };
  for (const s of SKILLS) {
    const w = SKILL_WORD[s.id] || s.id.replace(/_/g, ' ').toUpperCase().split(' ')[0];
    ok(text('SR5', SKILL_PAGES[s.id]).toUpperCase().includes(w), `skill ${s.id}: SR5 p. ${SKILL_PAGES[s.id]} mentions « ${w} »`);
  }
} else console.log('  (no SR5 text index: rule pages not checked against the book)');

// ---------------------------------------------------------------------------
console.log('• seed actors and bestiary resolve their items');
// Flavour items without any rulebook entry (custom Foundry gear).
const NO_BOOK = new Set(['Fancy Whiskey']);
const subOf = (list) => SUB_LISTS[list];
function unresolved(actor) {
  const out = [];
  for (const list of REF_LISTS) {
    for (const it of actor[list] || []) {
      if (!itemRef(it) && !NO_BOOK.has(it.name)) out.push(`${list}:${it.name}`);
      for (const x of (subOf(list) && it[subOf(list)]) || []) if (!itemRef(x)) out.push(`${list}.${subOf(list)}:${x.name}`);
    }
  }
  return out;
}
const pcs = readJson('data', 'seed', 'actors', 'pcs.json');
for (const a of pcs) {
  const copy = clone(a);
  const n = fillActorRefs(copy);
  const miss = unresolved(copy);
  ok(!miss.length, `${a.name}: every item has a rulebook reference (filled ${n}) — missing: ${miss.join(', ')}`);
  const again = clone(copy);
  ok(fillActorRefs(again) === 0 && JSON.stringify(again) === JSON.stringify(copy), `${a.name}: fill is idempotent`);
}
const jane = clone(pcs.find((a) => a.id === 'pc_jane'));
fillActorRefs(jane);
const lowLight = jane.qualities.find((q) => /low-light/i.test(q.name));
ok(lowLight && lowLight.source === 'SR5' && lowLight.page === 66, `Foundry quality without catalog id: reference read from its notes « · SR5 66 » (${JSON.stringify(lowLight && { s: lowLight.source, p: lowLight.page })})`);
const unarmed = jane.weapons.find((w) => w.name === 'Mains nues');
ok(unarmed && unarmed.source === 'SR5' && unarmed.page === 132, 'unarmed attack → Unarmed Combat (SR5 132)');
const heritage = jane.armor.find((x) => /heritage/i.test(x.name));
ok(!heritage || (heritage.source === 'RG' && heritage.page === 62), 'Zoé : Heritage → RG 62');
for (const dir of [['data', 'seed', 'bestiary'], ['data', 'packs', 'vierge', 'bestiary']]) {
  const full = path.join(ROOT, ...dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.json'))) {
    const list = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8'));
    let withCat = 0;
    let total = 0;
    let resolved = 0;
    const missCat = [];
    for (const tpl of Array.isArray(list) ? list : list.templates || []) {
      const copy = clone(tpl);
      fillActorRefs(copy);
      for (const l of REF_LISTS) {
        for (const it of copy[l] || []) {
          total++;
          if (itemRef(it)) resolved++;
          if (it.catalogId) {
            withCat++;
            if (!itemRef(it)) missCat.push(`${tpl.name} › ${it.name}`);
          }
        }
      }
    }
    ok(!missCat.length, `${dir.join('/')}/${f}: items with a catalog id resolve (${withCat}) — missing: ${missCat.join(', ')}`);
    console.log(`  ${dir.slice(-2).join('/')}/${f}: ${resolved}/${total} items with a reference (GM-typed French items without a catalog match stay without chip)`);
  }
}
ok(resolveItemRef('augmentations', { name: 'Réflexes câblés 2' })?.page === 455, 'French name with a rating: « Réflexes câblés 2 » → SR5 455');
ok(resolveItemRef('weapons', { name: 'Ares Predator V (smartlink)' })?.page === 426, 'name with a parenthesised note: « Ares Predator V (smartlink) » → SR5 426');
ok(resolveItemRef('weapons', { name: 'Grenade: Flash-Bang' })?.page === 435, 'weapons also look in gear (grenades)');
ok(resolveItemRef('gear', { name: 'Objet inventé par le MJ' }) === null, 'unknown free-text item: no reference');
ok(resolveItemRef('weapons', { name: 'X' }, null, { sourceText: 'SR5 p. 424' })?.page === 424, 'import source text (Foundry) used when nothing else matches');

// ---------------------------------------------------------------------------
console.log('• imports');
{
  const fixture = fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'chummer-test.chum5'), 'utf8');
  const a = parseChum5(fixture, { fileName: 'chummer-test.chum5' }).actor;
  const lists = ['weapons', 'armor', 'augmentations', 'gear', 'qualities', 'powers', 'spells', 'vehicles', 'lifestyles', 'martialArts'];
  let n = 0;
  const miss = [];
  for (const l of lists) {
    for (const it of a[l] || []) {
      n++;
      if (!itemRef(it)) miss.push(`${l}:${it.name}`);
      for (const x of (SUB_LISTS[l] && it[SUB_LISTS[l]]) || []) {
        n++;
        if (!itemRef(x)) miss.push(`${l}.${SUB_LISTS[l]}:${x.name}`);
      }
    }
  }
  ok(n > 0 && !miss.length, `Chummer import: <source>/<page> stored on every item (${n}) — missing: ${miss.join(', ')}`);
}
{
  const fa = {
    _id: 'pcr', name: 'Testeur', type: 'character', system: { attributes: {} },
    items: [
      { _id: 'q1', type: 'quality', name: 'Mysterious Homebrew Quality', system: { type: 'positive', karma: 3, description: { source: 'RG 99' } } },
      { _id: 'q2', type: 'quality', name: 'Ambidextrous', system: { type: 'positive', karma: 4, description: { source: 'SR5 71' } } },
    ],
  };
  const sheet = convertSheet(fa, {});
  ok(sheet.itemSources?.fvtt_q1 === 'RG 99', 'Foundry: convertSheet lists system.description.source per item id');
  ok(sheet.qualities.every((q) => q.source === undefined), 'Foundry: converted items carry no source (merge snapshot hashes unchanged)');
  const pc = { appId: 'pc_r', fid: 'pcr', name: 'Testeur', sheet, owner: { name: 'P' } };
  const a = buildPc(pc, null, {});
  const hb = a.qualities.find((q) => q.id === 'fvtt_q1');
  ok(hb?.source === 'RG' && hb?.page === 99, `Foundry: the item's own source becomes source/page after the import (${JSON.stringify(hb && { s: hb.source, p: hb.page })})`);
  const amb = a.qualities.find((q) => q.id === 'fvtt_q2');
  ok(amb?.source === 'SR5' && amb?.page === 71, 'Foundry: catalog item keeps its catalog reference');
  const merged = buildPc(pc, a, { mode: 'merge' });
  ok(merged.qualities.find((q) => q.id === 'fvtt_q1')?.page === 99, 'Foundry merge re-import keeps the reference');
}

// ---------------------------------------------------------------------------
console.log('• server: backfill at boot, GM adds, shop, training, templates (ports 3530-3531)');
const catalog = (f) => readJson('data', 'catalog', `${f}.json`);
const byName = (f, n) => catalog(f).find((e) => e.name === n);
{
  // An actor stored before item.source existed (old table): filled at boot.
  const oldActor = {
    id: 'pc_old', type: 'pc', name: 'Ancien', metatype: 'Humain', attributes: { BOD: 3, AGI: 3, REA: 3, STR: 3, WIL: 3, LOG: 3, INT: 3, CHA: 3, EDG: 2, ESS: 6 },
    condition: { physical: 0, stun: 0, overflow: 0 }, edge: { current: 2 }, skills: [], knowledge: [], contacts: [], sins: [], history: [],
    weapons: [{ id: 'w1', name: 'Ares Predator V', catalogId: byName('weapons', 'Ares Predator V').id, kind: 'ranged', skill: 'pistols', accessories: [{ id: 's1', name: 'Smartgun System, Internal', catalogId: byName('accessories', 'Smartgun System, Internal')?.id }] }],
    qualities: [{ id: 'q1', name: 'Vision nocturne', karma: 0, positive: true, notes: 'Low-Light Vision · SR5 66' }],
    gear: [{ id: 'g1', name: 'Bricole', qty: 1 }],
    spells: [], powers: [], armor: [], augmentations: [], vehicles: [], lifestyles: [], martialArts: [],
  };
  const srv = await startServer({ port: 3531, tables: [{ id: 'old', pack: 'vierge', gmPassword: 'pw', state: { version: 1, config: { gmPassword: 'pw', campaignName: 'Old', lang: 'fr' }, users: {}, actors: { pc_old: oldActor }, log: [] } }] });
  try {
    const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'pw', table: 'old' }), { table: 'old' });
    await settle();
    const a = gm.state.actors.pc_old;
    ok(a.weapons[0].source === 'SR5' && a.weapons[0].page === 426, `boot backfill: weapon from its catalog id (${a.weapons[0].source} ${a.weapons[0].page})`);
    ok(!a.weapons[0].accessories[0].catalogId || a.weapons[0].accessories[0].source, 'boot backfill: nested accessory');
    ok(a.qualities[0].source === 'SR5' && a.qualities[0].page === 66, 'boot backfill: reference from the notes');
    ok(a.gear[0].source === undefined, 'boot backfill: an item without any reference stays without one');
    gm.close();
  } finally {
    srv.stop();
  }
}
{
  const srv = await startServer({ port: 3530 });
  try {
    const gm = await client(srv.url, await login(srv.url, { role: 'gm', password: 'lazarus' }));
    await settle();
    const jane0 = gm.state.actors.pc_jane;
    ok(jane0 && unresolved(jane0).length === 0, `seeded Lazarus PCs carry their references in the table state (${jane0 ? unresolved(jane0).join(', ') : 'no Jane'})`);
    // GM: add from the catalog (catalogToItem has no source) → filled by the server.
    const katana = byName('weapons', 'Katana');
    const wid = await gm.send('actor/addItem', { actorId: 'pc_jane', list: 'weapons', item: { name: 'Katana', catalogId: katana.id, kind: 'melee', skill: 'blades', damage: '(STR+3)P' } });
    await settle();
    let w = gm.state.actors.pc_jane.weapons.find((x) => x.id === wid);
    ok(w.source === katana.source && w.page === katana.page, `GM catalog add: ${w.source} ${w.page}`);
    const sil = byName('accessories', 'Silencer/Suppressor');
    const sid = await gm.send('actor/addSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: wid, sub: 'accessories', item: { name: sil.name, catalogId: sil.id, mount: 'Barrel' } });
    await settle();
    w = gm.state.actors.pc_jane.weapons.find((x) => x.id === wid);
    const sub = w.accessories.find((x) => x.id === sid);
    ok(sub.source === sil.source && sub.page === sil.page, `GM nested add (accessory): ${sub.source} ${sub.page}`);
    // GM edits keep / set the reference (sanitizeSub keeps source/page).
    await gm.send('actor/updateSubItem', { actorId: 'pc_jane', list: 'weapons', itemId: wid, sub: 'accessories', subId: sid, patch: { notes: 'x' } });
    await gm.send('actor/updateItem', { actorId: 'pc_jane', list: 'weapons', itemId: wid, patch: { source: 'rg', page: '62' } });
    await settle();
    w = gm.state.actors.pc_jane.weapons.find((x) => x.id === wid);
    ok(w.accessories.find((x) => x.id === sid).source === sil.source, 'nested item keeps its reference through a GM edit');
    ok(w.source === 'rg' && w.page === 62, 'GM can override an item reference (page normalized to a number)');
    // Shop purchase (GM gift: no price / approval).
    const jacket = byName('armor', 'Armor Jacket');
    await gm.send('shop/give', { actorId: 'pc_bricks', items: [{ ref: jacket.id, qty: 1 }] });
    await settle();
    const bought = gm.state.actors.pc_bricks.armor.filter((x) => x.catalogId === jacket.id).pop();
    ok(bought && bought.source === 'SR5' && bought.page === jacket.page, `shop: bought armor gets its reference (${bought?.source} ${bought?.page})`);
    // Martial art (GM grant).
    const style = catalog('martialarts').find((m) => (m.stats?.techniques || []).length >= 2);
    await gm.send('shop/martialArt', { actorId: 'pc_bricks', styleId: style.id, techniqueIds: [style.stats.techniques[0].id], free: true });
    await settle();
    const art = gm.state.actors.pc_bricks.martialArts.find((m) => m.catalogId === style.id);
    ok(art && art.source === style.source && art.techniques[0].source === style.stats.techniques[0].source, `martial art + technique references (${art?.source} ${art?.page} / ${art?.techniques?.[0]?.source} ${art?.techniques?.[0]?.page})`);
    // Training (GM request = approved at once): a new quality from the catalog.
    const amb = byName('qualities', 'Ambidextrous');
    await gm.send('training/updateSettings', { approval: 'never', useTime: false });
    await gm.send('training/request', { actorId: 'pc_bricks', kind: 'quality', catalogId: amb.id, name: amb.nameFr || amb.name, karma: 4 });
    await settle();
    const q = gm.state.actors.pc_bricks.qualities.find((x) => x.catalogId === amb.id);
    ok(q && q.source === 'SR5' && q.page === amb.page, `training: new quality gets its reference (${q?.source} ${q?.page})`);
    // Bestiary template created by the GM: sanitizeTemplate fills its items.
    const tid = await gm.send('bestiary/create', { template: { name: 'Garde', weapons: [{ name: 'Ares Predator V', kind: 'ranged', skill: 'pistols' }], armor: [{ name: 'Veste pare-balles', rating: 9 }] } });
    await settle();
    const tpl = gm.state.bestiary[tid?.templateId];
    ok(tpl && tpl.weapons[0].page === 426 && tpl.armor[0].source === 'SR5', `bestiary template items resolved by name (${tpl ? `${tpl.weapons[0].source} ${tpl.weapons[0].page}` : 'no template'})`);
    gm.close();
  } finally {
    srv.stop();
  }
}

console.log(failures ? `\n${failures} échec(s), ${passes} réussite(s)` : `\nOK — ${passes} vérifications`);
process.exit(failures ? 1 : 0);
