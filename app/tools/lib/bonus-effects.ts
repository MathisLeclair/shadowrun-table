// Chummer <bonus> / <wirelessbonus> → normalized `effects` array of a catalog entry (see ARCHITECTURE.md « Modifiers »).
// Pure: takes the fast-xml-parser node (attributes prefixed '@', text in '#text', parseTagValue: false).
// Used by tools/build-catalog.ts and unit-tested by tools/test-modifiers.ts.
//
// Effect = { type, target?, value?, condition?, exclude?, choice?, wireless?, tag }
//   value: number, or a formula string evaluated with the item's rating at runtime ('Rating', '-Rating', 'FixedValues(3,6,9)'…)
//   condition: stable key of shared/modifiers.js CONDITIONS (LimitCondition_Visible → 'visible', free text → 't-urban'…)
//   choice: { kind: 'skill'|'text'|'matrixAction'|'attribute'|'limit', limitTo?, categories? } — the effect targets item.choice ('$choice')
//   tag: the Chummer tag it comes from (coverage report). Unknown tags → { type: 'unsupported', tag }.
import { SKILL_BY_ID, SKILL_GROUPS } from '../../shared/sr5.ts';

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const txt = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();
const isNum = (s) => /^[+-]?\d+(\.\d+)?$/.test(String(s).trim());

/** '2' → 2, '+1' → 1, 'Rating' → 'Rating', '{Rating}' → 'Rating', '' → undefined. */
export function effValue(raw) {
  let s = txt(raw).replace(/\{([A-Za-z ]+)\}/g, '$1').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (isNum(s)) return Number(s);
  if (s.startsWith('+')) s = s.slice(1).trim();
  return s;
}

const SKILL_ALIASES = {
  'exotic melee weapon': 'exotic_weapon', 'exotic ranged weapon': 'exotic_weapon', lockpicking: 'locksmith', 'pilot aerospace': 'pilot_aerospace',
  'pilot aircraft': 'pilot_aircraft', 'pilot walker': 'pilot_walker', 'pilot ground craft': 'pilot_ground_craft', 'pilot watercraft': 'pilot_watercraft',
};
/** Chummer English skill name → shared/sr5.js SKILLS id, or null (knowledge / exotic / unknown). */
export function skillIdOf(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return null;
  if (SKILL_ALIASES[s]) return SKILL_ALIASES[s];
  const id = s.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return SKILL_BY_ID[id] ? id : null;
}
/** 'Close Combat' → 'close_combat' (SKILL_GROUPS key) or null. */
export function groupIdOf(name) {
  const id = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return SKILL_GROUPS[id] ? id : null;
}
const CATEGORY = {
  'Social Active': 'social', 'Physical Active': 'physical', 'Combat Active': 'combat', 'Technical Active': 'technical', 'Vehicle Active': 'vehicle',
  'Magical Active': 'magic', 'Resonance Active': 'resonance', Academic: 'knowledge:academic', Interest: 'knowledge:interest', Language: 'knowledge:language',
  Professional: 'knowledge:professional', Street: 'knowledge:street',
};
export const categoryIdOf = (name) => CATEGORY[String(name || '').trim()] || null;
const ATTRS = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES', 'ESS', 'DEP'];

/** LimitCondition_IntimidationVisible → 'intimidation-visible'; free text → 't-' + slug; 'career' → null; 'create' → false (chargen only). */
export function conditionKey(raw) {
  const s = txt(raw);
  if (!s) return null;
  if (s === 'career') return null;
  if (s === 'create') return false;
  const m = s.match(/^LimitCondition_(.+)$/);
  if (m) return m[1].replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase();
  return 't-' + s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// Single-value tags → stat targets (applied to the derived value of the same name, or to the matching test).
const STATS = {
  damageresistance: 'soak', composure: 'composure', memory: 'memory', liftandcarry: 'liftCarry', dodge: 'defense', defensetest: 'defense',
  reach: 'reach', unarmedreach: 'reach', unarmeddv: 'unarmedDV', unarmedap: 'unarmedAP', drainresist: 'drainResist', fadingresist: 'fadingResist',
  surprise: 'surprise', spellresistance: 'spellResistance', physicalcmrecovery: 'physicalRecovery', stuncmrecovery: 'stunRecovery',
  judgeintentionsdefense: 'judgeIntentionsDefense', judgeintentionsoffense: 'judgeIntentions', fatigueresist: 'fatigueResist',
  throwstr: 'throwSTR', throwrangestr: 'throwRangeSTR',
};
const RESISTS = new Set([
  'toxincontactresist', 'toxiningestionresist', 'toxininhalationresist', 'toxininjectionresist', 'pathogencontactresist', 'pathogeningestionresist',
  'pathogeninhalationresist', 'pathogeninjectionresist', 'toxincontactimmune', 'toxininhalationimmune', 'pathogencontactimmune', 'pathogeninhalationimmune',
  'firearmor', 'coldarmor', 'electricityarmor', 'acidarmor', 'fallingarmor', 'radiationresist', 'sonicresist', 'mentalmanipulationresist',
  'manaillusionresist', 'physicalillusionresist', 'detectionspellresist', 'directmanaspellresist', 'decreasebodresist', 'decreaseagiresist',
  'decreaserearesist', 'decreasestrresist', 'decreasecharesist', 'decreaseintresist', 'decreaselogresist', 'decreasewilresist',
]);
const LIMIT_TAGS = { physicallimit: 'physical', mentallimit: 'mental', sociallimit: 'social', astrallimit: 'astral' };
const MONITOR_KEYS = { physical: 'physical', stun: 'stun', overflow: 'overflow', threshold: 'threshold', thresholdoffset: 'thresholdOffset', sharedthresholdoffset: 'sharedThresholdOffset' };

/** Skill choice constraints of a <selectskill> node. */
function skillChoice(node) {
  if (!node || typeof node !== 'object') return { kind: 'skill' };
  const out = { kind: 'skill' };
  const lim = txt(node['@limittoskill']);
  if (lim) out.limitTo = lim.split(',').map((s) => skillIdOf(s) || s.trim()).filter(Boolean);
  const cats = [txt(node['@skillcategory']), ...arr(node.skillcategories?.category).map(txt)].join(',');
  if (cats.replace(/,/g, '')) out.categories = cats.split(',').map((c) => categoryIdOf(c) || c.trim()).filter(Boolean);
  const ex = txt(node['@excludecategory']);
  if (ex) out.excludeCategories = ex.split(',').map((c) => categoryIdOf(c) || c.trim()).filter(Boolean);
  const exs = txt(node['@excludeskill']);
  if (exs) out.excludeSkills = exs.split(',').map((s) => skillIdOf(s) || s.trim()).filter(Boolean);
  if (txt(node['@knowledgeskills']) === 'True') out.knowledge = true;
  if (txt(node['@limittoattribute'])) out.attrs = txt(node['@limittoattribute']).split(',').map((s) => s.trim());
  return out;
}

/**
 * Normalize one <bonus> (or <wirelessbonus>) node. Returns an array of effects (possibly empty).
 * opts.wireless → every effect gets wireless: true (applies while the item's wireless bonus is on).
 */
export function normalizeBonus(node, { wireless = false } = {}) {
  if (!node || typeof node !== 'object') return [];
  const out = [];
  const push = (e, tag) => {
    if (e.condition === false) return; // chargen-only ('create')
    if (e.condition === null || e.condition === undefined) delete e.condition;
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    out.push({ ...e, tag, ...(wireless ? { wireless: true } : {}) });
  };
  const unsupported = (tag) => out.push({ type: 'unsupported', tag, ...(wireless ? { wireless: true } : {}) });
  for (const [tag, raw] of Object.entries(node)) {
    if (tag.startsWith('@') || tag === '#text') continue;
    for (const v of arr(raw)) {
      if (tag === 'limitmodifier') {
        const target = txt(v.limit).toLowerCase();
        if (!['physical', 'mental', 'social', 'astral'].includes(target)) { unsupported(tag); continue; }
        push({ type: 'limit', target, value: effValue(v.value), condition: conditionKey(v.condition) }, tag);
      } else if (LIMIT_TAGS[tag]) {
        push({ type: 'limit', target: LIMIT_TAGS[tag], value: effValue(v) }, tag);
      } else if (tag === 'specificskill') {
        const id = skillIdOf(txt(v.name));
        push({ type: 'skill', target: id || `name:${txt(v.name)}`, value: effValue(v.bonus), condition: conditionKey(v.condition) }, tag);
      } else if (tag === 'skillcategory') {
        const cat = categoryIdOf(txt(v.name));
        if (!cat) { unsupported(tag); continue; }
        push({ type: 'skillCategory', target: cat, value: effValue(v.bonus), condition: conditionKey(v.condition),
          exclude: txt(v.exclude) ? [skillIdOf(txt(v.exclude)) || txt(v.exclude)] : undefined }, tag);
      } else if (tag === 'skillgroup') {
        const g = groupIdOf(txt(v.name));
        if (!g) { unsupported(tag); continue; }
        push({ type: 'skillGroup', target: g, value: effValue(v.bonus), condition: conditionKey(v.condition),
          exclude: txt(v.exclude) ? [skillIdOf(txt(v.exclude)) || txt(v.exclude)] : undefined }, tag);
      } else if (tag === 'skillattribute' || tag === 'skilllinkedattribute') {
        const a = txt(v.name).toUpperCase();
        if (!ATTRS.includes(a)) { unsupported(tag); continue; }
        push({ type: 'skillAttribute', target: a, value: effValue(v.bonus), condition: conditionKey(v.condition) }, tag);
      } else if (tag === 'specificattribute') {
        const a = txt(v.name).toUpperCase();
        if (!ATTRS.includes(a)) { unsupported(tag); continue; }
        if (txt(v.val)) push({ type: 'attribute', target: a, value: effValue(v.val) }, tag);
        if (txt(v.max) || txt(v.min)) push({ type: 'attributeMax', target: a, value: effValue(v.max) ?? effValue(v.min) }, tag);
      } else if (tag === 'initiativepass' || tag === 'initiativedice') {
        push({ type: 'initiativeDice', value: effValue(v) }, tag);
      } else if (tag === 'initiative') {
        push({ type: 'initiative', value: effValue(v) }, tag);
      } else if (tag === 'matrixinitiativedice' || tag === 'matrixinitiativediceadd') {
        push({ type: 'matrixInitiativeDice', value: effValue(v) }, tag);
      } else if (tag === 'armor') {
        push({ type: 'armor', value: effValue(v) }, tag);
      } else if (tag === 'conditionmonitor') {
        let any = false;
        for (const [k, target] of Object.entries(MONITOR_KEYS)) {
          if (v && typeof v === 'object' && txt(v[k])) {
            push({ type: 'monitor', target, value: effValue(v[k]) }, tag);
            any = true;
          }
        }
        if (!any) unsupported(tag);
      } else if (tag === 'judgeintentions') {
        push({ type: 'stat', target: 'judgeIntentions', value: effValue(v) }, tag);
        push({ type: 'stat', target: 'judgeIntentionsDefense', value: effValue(v) }, tag);
      } else if (STATS[tag]) {
        push({ type: 'stat', target: STATS[tag], value: effValue(v) }, tag);
      } else if (RESISTS.has(tag)) {
        push({ type: 'resist', target: tag, value: /immune$/.test(tag) ? 'immune' : effValue(v) }, tag);
      } else if (tag === 'unarmeddvphysical') {
        push({ type: 'flag', target: 'unarmedPhysical', value: 1 }, tag);
      } else if (tag === 'smartlink') {
        push({ type: 'flag', target: 'smartlink', value: effValue(v) ?? 1 }, tag);
      } else if (tag === 'spellcategory') {
        // Spellcasting focus: + Rating dice to Spellcasting for spells of that category (toggle « Sort de type … »).
        const cat = txt(v.name);
        if (!cat) { unsupported(tag); continue; }
        push({ type: 'skill', target: 'spellcasting', value: effValue(v.val), condition: `spell-${cat.toLowerCase().replace(/[^a-z]+/g, '-')}` }, tag);
      } else if (tag === 'selecttext') {
        push({ type: 'choice', choice: { kind: 'text' } }, tag);
      } else if (tag === 'selectskill') {
        const c = skillChoice(v);
        const val = effValue(v?.val) ?? effValue(v?.max);
        if (val !== undefined && txt(v?.val)) push({ type: 'skill', target: '$choice', value: val, choice: c }, tag);
        else push({ type: 'choice', choice: c, value: val }, tag);
      } else if (tag === 'selectattribute' && v && typeof v === 'object' && txt(v.val)) {
        push({ type: 'attribute', target: '$choice', value: effValue(v.val), choice: { kind: 'attribute', attrs: arr(v.attribute).map(txt).filter(Boolean) } }, tag);
      } else if (tag === 'selectlimit') {
        push({ type: 'limit', target: '$choice', value: effValue(v?.val), choice: { kind: 'limit' } }, tag);
      } else if (tag === 'weaponskillaccuracy') {
        push({ type: 'accuracy', target: '$choice', value: effValue(v.value), choice: skillChoice(v.selectskill) }, tag);
      } else if (tag === 'weaponaccuracy') {
        push({ type: 'accuracy', target: txt(v.name) ? `name:${txt(v.name)}` : 'all', value: effValue(v.value) }, tag);
      } else if (tag === 'actiondicepool' && txt(v?.['@category']) === 'Matrix') {
        // Codeslinger (SR5 p.72): +2 dice to one chosen Matrix action.
        push({ type: 'matrixAction', target: '$choice', value: 2, choice: { kind: 'matrixAction' } }, tag);
      } else if (tag === 'addweapon') {
        push({ type: 'info', target: 'weapon', note: txt(v.name) || txt(v) }, tag);
      } else {
        unsupported(tag);
      }
    }
  }
  return out;
}

/** Effects of a catalog XML entry: its <bonus> + <wirelessbonus> (wireless: true). */
export function entryEffects(x) {
  if (!x || typeof x !== 'object') return [];
  return [...normalizeBonus(x.bonus), ...normalizeBonus(x.wirelessbonus, { wireless: true })];
}
