// Re-import of a .chum5 into an existing actor: 3-way merge (base = the file the actor was last synced with,
// theirs = the uploaded file, ours = the actor as it is now in the app) + a human-readable diff for the
// confirmation dialog.
// Rules: a Chummer-side change (theirs ≠ base) wins; otherwise the app value is kept. Karma, career karma and
// nuyens merge as deltas (ours + theirs − base) so rewards given in the app while the player edited the
// file in Chummer are not lost. Items are matched by `chummerGuid`; items added in the app since the last
// sync (no guid yet) are kept. Without a base (first import into an app-made actor) the file wins.
import { ITEM_LISTS, SUB_LISTS } from '../../../client/modules/sheet/sheet-data.js';
import { ATTR_LABELS } from '../../../shared/sr5.js';
import { formatFr } from '../../../client/i18n/format.js';
import { nuyen as fmtNuyen } from '../../../shared/util.js';

const tk = (s) => s; // marks French keys stored as values (tools/i18n-check.js)

const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isEmpty = (v) => v === undefined || v === null || v === '';

/** Top-level fields that come from Chummer. */
const TEXT_FIELDS = ['name', 'realName', 'metatype', 'metavariant', 'gender', 'age', 'player', 'concept', 'bio', 'notes'];
const NUM_FIELDS = ['streetCred', 'notoriety', 'publicAwareness'];
const DELTA_FIELDS = ['karma', 'karmaTotal', 'nuyen'];
const OBJ_FIELDS = ['initiative', 'matrix', 'vision'];
const LISTS = ITEM_LISTS.filter((l) => !['skills', 'skillGroups'].includes(l));

const pick3 = (ours, theirs, base, hasBase) => (hasBase ? (!eq(theirs, base) ? theirs : ours) : theirs);

/** Nested lists of list items (accessories, mods, lifestyle options, techniques): merged entry by entry, by chummerGuid. */
const SUB_KEYS = new Set(Object.values(SUB_LISTS));

function mergeItem(o, t, b) {
  const out = { ...o, ...t, id: o.id };
  if (b) for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) if (k !== 'id' && !SUB_KEYS.has(k)) out[k] = !eq(t[k], b[k]) ? t[k] : o[k];
  // Nested lists: a whole-array comparison would always see a change (the parses give sub-items fresh ids) and wipe
  // the entries added in the app (shop scope, Garage…). Merge them like the parent lists: by guid, app ids kept.
  for (const k of SUB_KEYS) {
    if (!Array.isArray(o[k]) && !Array.isArray(t[k])) continue;
    out[k] = mergeList(Array.isArray(o[k]) ? o[k] : [], Array.isArray(t[k]) ? t[k] : [], b ? (Array.isArray(b[k]) ? b[k] : []) : null);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Item without its app ids (its own and its nested entries': each parse gives fresh ids). */
const withoutIds = (it) => {
  const { id: _id, ...x } = it || {};
  for (const k of SUB_KEYS) if (Array.isArray(x[k])) x[k] = x[k].map((s) => (s && typeof s === 'object' ? withoutIds(s) : s));
  return x;
};
const sameItem = (a, b) => eq(withoutIds(a), withoutIds(b));

/**
 * oursGuids = chummerGuids present anywhere on the app actor (all lists): an item the app keeps in another list
 * than Chummer (shop Fake SIN in gear ↔ Chummer SIN, matrix device in actor.matrix ↔ Chummer gear) is never
 * added a second time.
 */
function mergeList(ours = [], theirs = [], base = null, oursGuids = null) {
  const byGuidO = new Map(ours.filter((i) => i.chummerGuid).map((i) => [i.chummerGuid, i]));
  const byGuidB = base ? new Map(base.filter((i) => i.chummerGuid).map((i) => [i.chummerGuid, i])) : new Map();
  const theirGuids = new Set(theirs.map((i) => i.chummerGuid).filter(Boolean));
  const out = [];
  for (const t of theirs) {
    const o = t.chummerGuid && byGuidO.get(t.chummerGuid);
    if (o) {
      out.push(mergeItem(o, t, byGuidB.get(t.chummerGuid)));
      continue;
    }
    if (base && t.chummerGuid) {
      if (oursGuids?.has(t.chummerGuid)) continue; // lives in another list in the app
      // In the file the app produced, untouched in Chummer, but not in this list in the app: deleted (or kept
      // elsewhere) in the app — do not bring it back.
      const b = byGuidB.get(t.chummerGuid);
      if (b && sameItem(t, b)) continue;
    }
    out.push(t);
  }
  if (base) for (const o of ours) if (!o.chummerGuid || (!theirGuids.has(o.chummerGuid) && !byGuidB.has(o.chummerGuid))) out.push(o);
  return out;
}

function mergeSkills(ours = [], theirs = [], base = null) {
  const O = new Map(ours.map((s) => [s.id, s]));
  const T = new Map(theirs.map((s) => [s.id, s]));
  const Bm = base ? new Map(base.map((s) => [s.id, s])) : null;
  const out = [];
  for (const id of new Set([...O.keys(), ...T.keys()])) {
    const o = O.get(id);
    const t = T.get(id);
    if (!Bm) {
      if (t) out.push(o ? { ...o, ...t } : t);
      continue;
    }
    const b = Bm.get(id);
    const rating = !eq(t?.rating || 0, b?.rating || 0) ? t?.rating || 0 : o?.rating || 0;
    const spec = !eq(t?.spec || '', b?.spec || '') ? t?.spec || '' : o?.spec || '';
    if (!rating) continue;
    const s = { ...(t || {}), ...(o || {}), rating };
    if (spec) s.spec = spec;
    else delete s.spec;
    out.push(s);
  }
  return out;
}

/**
 * Merge an uploaded file (`theirs`, a freshly parsed actor with .chummer) into the current actor.
 * `base` = parse of current.chummer.xml (or null). Returns the merged actor (a new object).
 */
export function mergeActor(current, theirs, base, { now = Date.now(), fileName = '' } = {}) {
  const hasBase = !!base;
  const m = { ...current };
  for (const k of TEXT_FIELDS) {
    const v = pick3(current[k], theirs[k], base?.[k], hasBase);
    if (isEmpty(v) && !isEmpty(current[k]) && !hasBase) continue; // an empty Chummer field never erases app text
    if (isEmpty(v)) delete m[k];
    else m[k] = v;
  }
  if (!m.name) m.name = current.name;
  for (const k of NUM_FIELDS) m[k] = pick3(current[k] || 0, theirs[k] || 0, base?.[k] || 0, hasBase);
  for (const k of DELTA_FIELDS) m[k] = hasBase ? (current[k] || 0) + (theirs[k] || 0) - (base[k] || 0) : theirs[k] || 0;
  m.karmaTotal = Math.max(m.karmaTotal, m.karma);
  for (const k of OBJ_FIELDS) {
    const v = pick3(current[k], theirs[k], base?.[k], hasBase);
    if (v === undefined || v === null) delete m[k];
    else m[k] = v;
  }
  // Attributes & augmentations, key by key
  m.attributes = { ...current.attributes };
  for (const k of new Set([...Object.keys(current.attributes || {}), ...Object.keys(theirs.attributes || {})])) {
    const v = pick3(current.attributes?.[k], theirs.attributes?.[k], base?.attributes?.[k], hasBase);
    if (v === undefined || v === null) delete m.attributes[k];
    else m.attributes[k] = v;
  }
  const aug = {};
  for (const k of new Set([...Object.keys(current.augmented || {}), ...Object.keys(theirs.augmented || {})])) {
    const v = pick3(current.augmented?.[k], theirs.augmented?.[k], base?.augmented?.[k], hasBase);
    if (v) aug[k] = v;
  }
  if (Object.keys(aug).length) m.augmented = aug;
  else delete m.augmented;
  m.condition = {};
  for (const k of ['physical', 'stun', 'overflow']) m.condition[k] = pick3(current.condition?.[k] || 0, theirs.condition?.[k] || 0, base?.condition?.[k] || 0, hasBase);
  const edge = pick3(current.edge?.current, theirs.edge?.current, base?.edge?.current, hasBase);
  m.edge = { ...(current.edge || {}), current: Math.max(0, Math.min(m.attributes.EDG ?? 0, Number(edge) || 0)) };

  m.skills = mergeSkills(current.skills, theirs.skills, base?.skills || null);
  const oursGuids = new Set();
  for (const l of LISTS) for (const it of Array.isArray(current[l]) ? current[l] : []) if (it?.chummerGuid) oursGuids.add(it.chummerGuid);
  for (const l of LISTS) {
    if (l === 'complexForms' && !current.complexForms && !theirs.complexForms) continue;
    m[l] = mergeList(current[l] || [], theirs[l] || [], base ? base[l] || [] : null, oursGuids);
  }
  if (!m.complexForms?.length) delete m.complexForms;
  // Keep the previous sync point when merging: app-side karma/nuyen entries made since then are not in the uploaded
  // file and must still become Chummer expenses at the next export (entries flagged `chummer` are skipped).
  m.chummer = { ...theirs.chummer, importedAt: current.chummer?.importedAt || theirs.chummer.importedAt, syncedAt: hasBase ? current.chummer?.syncedAt || now : now, updatedAt: now };
  const dk = m.karma - (current.karma || 0);
  const dn = m.nuyen - (current.nuyen || 0);
  const i18n = fileName ? { key: tk('Mise à jour depuis Chummer ({file})'), params: { file: fileName } } : { key: tk('Mise à jour depuis Chummer') };
  m.history = [...(current.history || []), { ts: now, chummer: true, text: formatFr(i18n.key, i18n.params), i18n, ...(dk ? { karma: dk } : {}), ...(dn ? { nuyen: dn } : {}) }];
  return m;
}

// ---------------------------------------------------------------------------
// Diff (shown before applying)
// ---------------------------------------------------------------------------
// Labels are French keys (stored with pending requests); the Chummer UI shows them with t().
const LIST_LABELS = {
  weapons: tk('Armes'), armor: tk('Armures'), augmentations: tk('Augmentations'), gear: tk('Équipement'), vehicles: tk('Véhicules'), contacts: tk('Contacts'), sins: tk('SIN'),
  qualities: tk('Qualités'), powers: tk('Pouvoirs'), spells: tk('Sorts'), knowledge: tk('Connaissances'), complexForms: tk('Formes complexes'),
  lifestyles: tk('Modes de vie'), martialArts: tk('Arts martiaux'),
};
const ITEM_FIELDS = {
  gear: ['qty', 'rating'], armor: ['rating', 'equipped'], augmentations: ['rating', 'grade', 'essence'], contacts: ['connection', 'loyalty'], powers: ['level'], knowledge: ['rating'], sins: ['rating'],
  lifestyles: ['monthsPaid', 'monthlyCost'], martialArts: ['rating'],
};
/** Nested lists compared by name in the diff (accessories, mods, lifestyle qualities, techniques). */
const SUB_DIFF = { weapons: 'accessories', armor: 'mods', vehicles: 'mods', lifestyles: 'qualities', martialArts: 'techniques' };
const subNames = (it, sub) => (Array.isArray(it?.[sub]) ? it[sub] : []).map((x) => x.name).sort();
const label = (it) => (it.rating && !['contacts'].includes(it.kind) ? `${it.name}` : it.name);

/** { scalars: [{ label, from, to }], attributes: [...], skills: [...], lists: [{ list, label, added, removed, changed }], empty } */
export function diffActors(before, after) {
  const scalars = [];
  const push = (lbl, a, b, fmt = (x) => x) => {
    if (!eq(a ?? '', b ?? '')) scalars.push({ label: lbl, from: isEmpty(a) ? '—' : fmt(a), to: isEmpty(b) ? '—' : fmt(b) });
  };
  push(tk('Nom'), before.name, after.name);
  push(tk('Métatype'), before.metatype, after.metatype);
  push(tk('Karma'), before.karma, after.karma);
  push(tk('Karma de carrière'), before.karmaTotal, after.karmaTotal);
  push(tk('Nuyens'), before.nuyen, after.nuyen, fmtNuyen);
  push(tk('Street Cred'), before.streetCred || 0, after.streetCred || 0);
  push(tk('Notoriété'), before.notoriety || 0, after.notoriety || 0);
  push(tk('Exposition'), before.publicAwareness || 0, after.publicAwareness || 0);
  push(tk('Dés d’initiative'), before.initiative?.dice || 1, after.initiative?.dice || 1);
  push(tk('Dommages physiques'), before.condition?.physical || 0, after.condition?.physical || 0);
  push(tk('Dommages étourdissants'), before.condition?.stun || 0, after.condition?.stun || 0);
  push(tk('Concept'), before.concept, after.concept);
  if (!eq(before.bio || '', after.bio || '')) scalars.push({ label: tk('Description'), from: '…', to: tk('modifiée') });
  if (!eq(before.notes || '', after.notes || '')) scalars.push({ label: tk('Notes'), from: '…', to: tk('modifiées') });

  const attributes = [];
  for (const k of ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES', 'ESS']) {
    const a = before.attributes?.[k];
    const b = after.attributes?.[k];
    const aa = before.augmented?.[k] || 0;
    const ba = after.augmented?.[k] || 0;
    if (!eq(a, b) || aa !== ba) attributes.push({ key: k, label: ATTR_LABELS[k] || k, from: isEmpty(a) ? '—' : `${a}${aa ? ` (+${aa})` : ''}`, to: isEmpty(b) ? '—' : `${b}${ba ? ` (+${ba})` : ''}` });
  }
  const skills = [];
  const S0 = new Map((before.skills || []).map((s) => [s.id, s]));
  const S1 = new Map((after.skills || []).map((s) => [s.id, s]));
  for (const id of new Set([...S0.keys(), ...S1.keys()])) {
    const a = S0.get(id);
    const b = S1.get(id);
    if ((a?.rating || 0) !== (b?.rating || 0) || (a?.spec || '') !== (b?.spec || '')) {
      skills.push({ id, name: (b || a).name, from: a ? `${a.rating}${a.spec ? ` (${a.spec})` : ''}` : '—', to: b ? `${b.rating}${b.spec ? ` (${b.spec})` : ''}` : '—' });
    }
  }
  const lists = [];
  for (const l of Object.keys(LIST_LABELS)) {
    const A = before[l] || [];
    const Bl = after[l] || [];
    const idsA = new Map(A.map((i) => [i.id, i]));
    const idsB = new Map(Bl.map((i) => [i.id, i]));
    const added = Bl.filter((i) => !idsA.has(i.id)).map(label);
    const removed = A.filter((i) => !idsB.has(i.id)).map(label);
    const changed = [];
    for (const i of Bl) {
      const o = idsA.get(i.id);
      if (!o) continue;
      const fields = (ITEM_FIELDS[l] || []).filter((f) => !eq(o[f], i[f]));
      const sub = SUB_DIFF[l];
      const subA = sub ? subNames(o, sub) : [];
      const subB = sub ? subNames(i, sub) : [];
      const subChange = sub && !eq(subA, subB) ? [...subB.filter((n) => !subA.includes(n)).map((n) => `+${n}`), ...subA.filter((n) => !subB.includes(n)).map((n) => `−${n}`)].join(', ') : '';
      if (fields.length) changed.push(`${i.name} (${fields.map((f) => `${f} ${o[f] ?? '—'} → ${i[f] ?? '—'}`).join(', ')}${subChange ? `, ${subChange}` : ''})`);
      else if (subChange) changed.push(`${i.name} (${subChange})`);
      else if (o.name !== i.name) changed.push(`${o.name} → ${i.name}`);
    }
    if (added.length || removed.length || changed.length) lists.push({ list: l, label: LIST_LABELS[l], added, removed, changed });
  }
  return { scalars, attributes, skills, lists, empty: !scalars.length && !attributes.length && !skills.length && !lists.length };
}
