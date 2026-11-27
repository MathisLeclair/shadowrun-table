// Structured editor for a bestiary template (works on a local draft, saved in one action).
import { useState, useMemo, type ChangeEvent, type ReactNode } from 'react';
import { Button, IconButton, Modal, Tabs, Panel, TextInput, NumberInput, Select, Toggle, SearchBox, Empty, Badge, type SelectOption } from '../../lib/ui.tsx';
import { useCatalog, upload } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, tIfKnown, attrLabel, attrShort, skillLabel, skillCategoryLabel, itemName, metatypeLabel, getLang } from '../../lib/i18n.ts';
import { SKILLS, SKILL_BY_ID, SKILL_CATEGORIES, METATYPES, type SkillDef } from '/shared/sr5.ts';
import { uid, deepClone } from '/shared/util.ts';
import { npcKindOptions, initModeOptions, dispoLabel, poolFor, safeDerive } from './combat-common.tsx';
import StatBlock from './StatBlock.tsx';
import type { ActorMatrix, Armor, AttrKey, CatalogItem, Template, Weapon } from '../../../shared/types.ts';

const EDIT_ATTRS: AttrKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES'];
const attrOptions = () => EDIT_ATTRS.map((k) => ({ value: k, label: attrShort(k) as string }));
const COMBAT_SKILLS: SkillDef[] = SKILLS.filter((s: SkillDef) => ['combat', 'vehicle'].includes(s.cat) || ['unarmed_combat', 'cybercombat', 'spellcasting'].includes(s.id));
/** Suggested metatype values: stored as typed (French, kept for save compatibility), labelled in the UI language. */
const METATYPE_OPTIONS = [...Object.keys(METATYPES), 'Créature', 'Esprit', 'Drone', 'IC', 'Host', 'Autre'];

/** Label + control without a <label> wrapper (avoids nested-label clicks on steppers/toggles). */
function F({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={'field' + (className ? ' ' + className : '')}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** Immutable set: setIn(obj, ['a', 'b'], v). Paths are dynamic, hence `any`. */
function setIn(obj: any, pathArr: Array<string | number>, value: unknown): any {
  if (!pathArr.length) return value;
  const [k, ...rest] = pathArr;
  const base = Array.isArray(obj) ? [...obj] : { ...(obj || {}) };
  base[k] = setIn(base[k], rest, value);
  return base;
}

/** Native select with SR5 skills grouped by category (+ current custom value). */
function SkillSelect({ value, onChange, only }: { value: string | null | undefined; onChange: (id: string) => void; only?: SkillDef[] }) {
  const list: SkillDef[] = only || SKILLS;
  const cats = Object.keys(SKILL_CATEGORIES)
    .map((cat) => ({ cat, label: skillCategoryLabel(cat), skills: list.filter((s) => s.cat === cat) }))
    .filter((g) => g.skills.length);
  const custom = value && !SKILL_BY_ID[value];
  return (
    <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {custom && <option value={value}>{t('{name} (custom)', { name: value })}</option>}
      {cats.map((g) => (
        <optgroup key={g.cat} label={g.label}>
          {g.skills.map((s) => (
            <option key={s.id} value={s.id}>
              {skillLabel(s)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** A row of an edited item list: the item lists of a template have different shapes, edited by key. */
type EditRow = { id?: string; [key: string]: any };
interface ColDef {
  key: string;
  label: string;
  type: 'text' | 'num' | 'bool' | 'select' | 'custom';
  options?: SelectOption[];
  width?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  render?: (item: EditRow, patch: (p: EditRow) => void) => ReactNode;
}
interface ListEditorProps {
  items: EditRow[] | null | undefined;
  onChange: (items: EditRow[]) => void;
  cols: ColDef[];
  newItem: () => EditRow;
  addLabel?: string;
  extra?: ReactNode;
}

/**
 * Generic table editor for item lists.
 * cols: [{ key, label, type: 'text'|'num'|'bool'|'select'|'custom', options?, width?, render?(item, set) }]
 */
function ListEditor({ items, onChange, cols, newItem, addLabel, extra }: ListEditorProps) {
  const list = items || [];
  const update = (i: number, key: string, v: unknown) => onChange(list.map((it, j) => (j === i ? { ...it, [key]: v } : it)));
  const remove = (i: number) => onChange(list.filter((_, j) => j !== i));
  const move = (i: number, dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="col">
      {list.length > 0 && (
        <div className="bed-list-wrap">
          <table className="bed-list">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.key} style={{ width: c.width || '' }}>
                    {c.label}
                  </th>
                ))}
                <th style={{ width: '64px' }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((it, i) => (
                <tr key={`${it.id}-${i}`}>
                  {cols.map((c) => {
                    const set = (v: unknown) => update(i, c.key, v);
                    let ctl: ReactNode;
                    if (c.type === 'custom') ctl = c.render?.(it, (patch) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x))));
                    else if (c.type === 'num')
                      ctl = (
                        <NumberInput
                          small
                          value={Number(it[c.key]) || 0}
                          min={c.min ?? -99}
                          max={c.max ?? 999}
                          step={c.step || 1}
                          onChange={(v) => set(c.step && c.step < 1 ? Math.round(v * 100) / 100 : v)}
                        />
                      );
                    else if (c.type === 'bool') ctl = <Toggle value={!!it[c.key]} onChange={set} />;
                    else if (c.type === 'select') ctl = <Select value={it[c.key] ?? ''} options={c.options || []} onChange={set} />;
                    else ctl = <TextInput live value={it[c.key] ?? ''} placeholder={c.placeholder || ''} onChange={set} />;
                    return <td key={c.key}>{ctl}</td>;
                  })}
                  <td className="row gap-s" style={{ flexWrap: 'nowrap' }}>
                    <IconButton icon="↑" title={t('Move up')} onClick={() => move(i, -1)} />
                    <IconButton icon="✕" title={t('Delete')} onClick={() => remove(i)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row wrap">
        <Button small onClick={() => onChange([...list, { id: uid('it'), ...newItem() }])}>
          + {addLabel || t('Add')}
        </Button>
        {extra}
      </div>
    </div>
  );
}

type PickerCatalog = 'weapons' | 'armor';
/** Catalog entry of weapons.json / armor.json (stats read loosely: the editor accepts any shape). */
type LooseCatalogItem = CatalogItem<Record<string, any>>;

/** Catalog picker (weapons / armor). Catalogs may be empty during development. */
function CatalogPicker({ name, onPick, onClose }: { name: PickerCatalog; onPick: (it: LooseCatalogItem) => void; onClose: () => void }) {
  const items = useCatalog<LooseCatalogItem>(name);
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (items || []).filter((it) => !needle || `${it.nameFr || ''} ${it.name || ''} ${it.categoryFr || ''} ${it.category || ''}`.toLowerCase().includes(needle));
    return list.slice(0, 80);
  }, [items, q]);
  return (
    <Panel title={name === 'weapons' ? t('Weapons catalog') : t('Armor catalog')} actions={<IconButton icon="✕" title={t('Close the catalog')} onClick={onClose} />}>
      <div className="bed-cat">
        <SearchBox value={q} onChange={setQ} placeholder={t('Name, category…')} />
        {!items.length ? (
          <Empty>{t('Catalog unavailable (not generated yet). Add the item by hand.')}</Empty>
        ) : (
          <div className="bed-cat-list">
            {filtered.map((it) => {
              const s = it.stats || {};
              const info =
                name === 'weapons'
                  ? [s.damage, s.ap ? t('AP {n}', { n: s.ap }) : '', s.mode, s.accuracy ? t('Acc {n}', { n: s.accuracy }) : ''].filter(Boolean).join(' · ')
                  : t('Armor {n}', { n: s.armor ?? '?' });
              const category = getLang() === 'fr' ? it.categoryFr || it.category || '' : it.category || it.categoryFr || '';
              return (
                <div key={it.id} className="bed-cat-item" onClick={() => onPick(it)}>
                  <span className="grow">
                    <strong>{itemName(it)}</strong> <span className="faint small">{category}</span>
                  </span>
                  <span className="mono small muted">{info}</span>
                </div>
              );
            })}
            {!filtered.length && <Empty>{t('No results.')}</Empty>}
          </div>
        )}
      </div>
    </Panel>
  );
}

function weaponFromCatalog(it: LooseCatalogItem): Partial<Weapon> {
  const s = it.stats || {};
  const n = (v: unknown) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    id: uid('w'),
    name: itemName(it),
    category: getLang() === 'fr' ? it.categoryFr || it.category || '' : it.category || it.categoryFr || '',
    kind: s.type === 'melee' ? 'melee' : 'ranged',
    skill: s.skill || (s.type === 'melee' ? 'clubs' : 'pistols'),
    accuracy: n(s.accuracy),
    damage: String(s.damage || ''),
    ap: n(s.ap) || 0,
    mode: s.mode || '',
    rc: n(s.rc) || 0,
    ammo: s.ammo || '',
    reach: n(s.reach) || 0,
    catalogId: it.id,
  };
}
function armorFromCatalog(it: LooseCatalogItem): Partial<Armor> {
  const raw = String(it.stats?.armor ?? '0');
  return { id: uid('a'), name: itemName(it), rating: parseInt(raw.replace('+', ''), 10) || 0, stack: raw.trim().startsWith('+'), equipped: true, catalogId: it.id };
}

type TabId = 'id' | 'attr' | 'skills' | 'gear' | 'magic' | 'notes' | 'preview';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'id', label: tk('Identity') },
  { id: 'attr', label: tk('Attributes') },
  { id: 'skills', label: tk('Skills') },
  { id: 'gear', label: tk('Weapons & armor') },
  { id: 'magic', label: tk('Powers & spells') },
  { id: 'notes', label: tk('Notes & tactics') },
  { id: 'preview', label: tk('Preview') },
];
/** Stored spell categories (French values, as in the seed bestiary: kept for save compatibility), shown with t(). */
const SPELL_CATS = ['Combat', 'Détection', 'Santé', 'Illusion', 'Manipulation'];
const DEFAULT_FOLDER = 'Divers'; // stored default folder name (server side), shown translated

interface TemplateEditorProps {
  template: Template;
  folders: string[];
  onSave: (draft: Template) => Promise<unknown>;
  onClose: () => void;
}
/** props: { template, folders: [string], onSave(draft) → Promise, onClose } */
export default function TemplateEditor({ template, folders, onSave, onClose }: TemplateEditorProps) {
  const [draft, setDraft] = useState<Template>(() => {
    const tpl: Template = deepClone(template);
    tpl.npc = tpl.npc || {};
    tpl.attributes = tpl.attributes || {};
    tpl.initiative = tpl.initiative || { dice: 1, bonus: 0 };
    return tpl;
  });
  const [initialJson] = useState(() => JSON.stringify(draft));
  const [tab, setTab] = useState<TabId>('id');
  const [picker, setPicker] = useState<PickerCatalog | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (pathArr: Array<string | number>, v: unknown) => setDraft((d) => setIn(d, pathArr, v));
  const d = safeDerive(draft);
  const hasMonitors = !!draft.monitors;

  const requestClose = () => {
    if (JSON.stringify(draft) !== initialJson && !window.confirm(t('Discard the changes to this template?'))) return;
    onClose();
  };
  const save = async () => {
    if (!String(draft.name || '').trim()) return toast(t('Give the template a name'), 'warn');
    setSaving(true);
    try {
      // Explicit nulls so that removed optional blocks are removed server-side too.
      await onSave({ ...draft, monitors: draft.monitors || null, matrix: draft.matrix || null } as unknown as Template);
    } catch {
      /* toast shown by send() */
    }
    setSaving(false);
  };
  const uploadPortrait = async (ev: ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const r = await upload(f);
      set(['portrait'], r.url);
    } catch (err) {
      toast((err as Error).message || t('Upload failed'), 'error');
    }
  };

  const pickerEl = picker && (
    <CatalogPicker
      name={picker}
      onClose={() => setPicker(null)}
      onPick={(it) => {
        if (picker === 'weapons') set(['weapons'], [...(draft.weapons || []), weaponFromCatalog(it)]);
        else set(['armor'], [...(draft.armor || []), armorFromCatalog(it)]);
        toast(t('{name} added', { name: itemName(it) }), 'success', 1800);
      }}
    />
  );

  let body: ReactNode;
  if (tab === 'id') {
    body = (
      <div className="bed">
        <div className="bed-grid">
          <F label={t('Name')}>
            <TextInput live value={draft.name} onChange={(v) => set(['name'], v)} />
          </F>
          <F label={t('Folder')}>
            <input className="input" list="bst-folders" value={draft.folder || ''} onChange={(e) => set(['folder'], e.target.value)} />
            <datalist id="bst-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </F>
          <F label={t('Metatype / type')}>
            <input className="input" list="bst-metatypes" value={draft.metatype || ''} onChange={(e) => set(['metatype'], e.target.value)} />
            <datalist id="bst-metatypes">
              {METATYPE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {metatypeLabel(m)}
                </option>
              ))}
            </datalist>
          </F>
          <F label={t('Concept')}>
            <TextInput live value={draft.concept} onChange={(v) => set(['concept'], v)} />
          </F>
          <F label={t('Nature')}>
            <Select value={draft.npc.kind || 'metahuman'} options={npcKindOptions()} onChange={(v) => set(['npc', 'kind'], v)} />
          </F>
          <F label={t('Default attitude')}>
            <Select value={draft.disposition || 'hostile'} options={(['hostile', 'neutral', 'ally'] as const).map((k) => ({ value: k, label: dispoLabel(k) }))} onChange={(v) => set(['disposition'], v)} />
          </F>
          <F label={t('Pro. rating (PR)')} hint={t('0 to 7')}>
            <NumberInput value={draft.npc.professionalRating || 0} min={0} max={7} onChange={(v) => set(['npc', 'professionalRating'], v)} />
          </F>
          <F label={t('Grunt')} hint={t('play them as a group')}>
            <Toggle value={!!draft.npc.grunt} onChange={(v) => set(['npc', 'grunt'], v)} label={draft.npc.grunt ? t('Yes') : t('No')} />
          </F>
        </div>
        <div className="bed-grid">
          <F label={t('Token color')}>
            <div className="row">
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(draft.color || '') ? draft.color : '#e05c5c'} onChange={(e) => set(['color'], e.target.value)} />
              <TextInput live value={draft.color} placeholder="#e05c5c" onChange={(v) => set(['color'], v)} />
            </div>
          </F>
          <F label={t('Portrait (URL)')} className="grow">
            <div className="row">
              <TextInput live value={draft.portrait} placeholder="/uploads/…" onChange={(v) => set(['portrait'], v)} />
              <label className="btn btn-sm">
                {t('Upload')}
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={uploadPortrait} />
              </label>
            </div>
          </F>
          <F label={t('Gender')}>
            <TextInput live value={draft.gender} onChange={(v) => set(['gender'], v)} />
          </F>
        </div>
        <div className="section-title">{t('Vision (map)')}</div>
        <div className="row wrap gap-l">
          <Toggle value={!!draft.vision?.lowLight} onChange={(v) => set(['vision', 'lowLight'], v)} label={t('Low-Light Vision')} />
          <Toggle value={!!draft.vision?.thermo} onChange={(v) => set(['vision', 'thermo'], v)} label={t('Thermographic')} />
          <F label={t('Darkvision (squares)')}>
            <NumberInput small value={draft.vision?.darkRange || 0} min={0} max={60} onChange={(v) => set(['vision', 'darkRange'], v)} />
          </F>
        </div>
      </div>
    );
  } else if (tab === 'attr') {
    const matrix: ActorMatrix | undefined = draft.matrix;
    body = (
      <div className="bed">
        <div className="bed-attrs">
          {EDIT_ATTRS.map((k) => (
            <div key={k} className="bed-attr" title={attrLabel(k)}>
              <span className="field-label">
                <span>{attrShort(k)}</span>
                <span className="faint">{attrLabel(k)}</span>
              </span>
              <NumberInput small value={draft.attributes[k] ?? 0} min={0} max={30} onChange={(v) => set(['attributes', k], v)} />
              <span className="field-hint row spread">
                {t('Aug.')} <NumberInput small value={draft.augmented?.[k] || 0} min={-4} max={4} onChange={(v) => set(['augmented', k], v)} />
              </span>
            </div>
          ))}
          <div className="bed-attr">
            <span className="field-label">
              <span>{attrShort('ESS')}</span>
              <span className="faint">{t('Essence')}</span>
            </span>
            <NumberInput small value={draft.attributes.ESS ?? 6} min={0} max={6} step={0.1} onChange={(v) => set(['attributes', 'ESS'], Math.round(v * 100) / 100)} />
          </div>
        </div>
        <div className="section-title">{t('Initiative & monitors')}</div>
        <div className="bed-grid">
          <F label={t('Initiative Dice')} hint={t('wired reflexes, etc.')}>
            <NumberInput value={draft.initiative.dice || 1} min={1} max={5} onChange={(v) => set(['initiative', 'dice'], v)} />
          </F>
          <F label={t('Initiative bonus')}>
            <NumberInput value={draft.initiative.bonus || 0} min={-20} max={30} onChange={(v) => set(['initiative', 'bonus'], v)} />
          </F>
          <F label={t('Combat initiative')}>
            <Select value={draft.npc.initMode || 'physical'} options={initModeOptions()} onChange={(v) => set(['npc', 'initMode'], v)} />
          </F>
          <F
            label={t('Custom monitors')}
            hint={d ? t('auto: P {p} / S {s}', { p: 8 + Math.ceil((draft.attributes.BOD || 0) / 2), s: 8 + Math.ceil((draft.attributes.WIL || 0) / 2) }) : ''}
          >
            <Toggle
              value={hasMonitors}
              onChange={(v) => set(['monitors'], v ? { physical: d?.physicalMonitor ?? 10, stun: d?.stunMonitor ?? 10 } : undefined)}
              label={hasMonitors ? t('Yes') : t('Auto')}
            />
          </F>
          {hasMonitors && (
            <>
              <F label={t('Physical')}>
                <NumberInput value={draft.monitors?.physical ?? 10} min={0} max={60} onChange={(v) => set(['monitors', 'physical'], v)} />
              </F>
              <F label={t('Stun')} hint={t('0 = none (IC, drone)')}>
                <NumberInput value={draft.monitors?.stun ?? 10} min={0} max={60} onChange={(v) => set(['monitors', 'stun'], v)} />
              </F>
            </>
          )}
        </div>
        {d && (
          <div className="small muted">
            {t('Initiative {init} · Defense {def} · Limits {limits}', { init: d.initiative.text, def: d.defense, limits: `${d.limits.physical}/${d.limits.mental}/${d.limits.social}` })}
          </div>
        )}
        <div className="section-title">{t('Matrix')}</div>
        {matrix ? (
          <div className="bed-grid">
            <F label={t('Device')}>
              <TextInput live value={matrix.device} onChange={(v) => set(['matrix', 'device'], v)} />
            </F>
            {(
              [
                ['rating', tk('Rating')],
                ['attack', tk('Attack')],
                ['sleaze', tk('Sleaze')],
                ['dataProcessing', tk('Data Processing')],
                ['firewall', tk('Firewall')],
              ] as const
            ).map(([k, label]) => (
              <F key={k} label={t(label)}>
                <NumberInput small value={matrix[k] || 0} min={0} max={20} onChange={(v) => set(['matrix', k], v)} />
              </F>
            ))}
            <F label={t('Programs (comma-separated)')} className="grow">
              <TextInput
                live
                value={(matrix.programs || []).join(', ')}
                onChange={(v) =>
                  set(
                    ['matrix', 'programs'],
                    v
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean)
                  )
                }
              />
            </F>
            <div className="field">
              <span className="field-label"> </span>
              <Button small variant="danger" onClick={() => set(['matrix'], undefined)}>
                {t('Remove')}
              </Button>
            </div>
          </div>
        ) : (
          <Button small onClick={() => set(['matrix'], { device: '', rating: 0, attack: 0, sleaze: 0, dataProcessing: 0, firewall: 0, programs: [] })}>
            {t('+ Add a Matrix profile')}
          </Button>
        )}
      </div>
    );
  } else if (tab === 'skills') {
    body = (
      <div className="bed">
        <ListEditor
          items={draft.skills}
          onChange={(v) => set(['skills'], v)}
          addLabel={t('Skill')}
          newItem={() => ({ id: 'perception', name: 'Perception', attr: 'INT', rating: 3 })}
          cols={[
            {
              key: 'id',
              label: t('Skill'),
              type: 'custom',
              render: (it, patch) => (
                <SkillSelect
                  value={it.id}
                  onChange={(id) => {
                    const def = SKILL_BY_ID[id];
                    patch(def ? { id, name: def.fr, attr: def.attr, group: def.group || undefined } : { id });
                  }}
                />
              ),
            },
            { key: 'name', label: t('Label'), type: 'text' },
            { key: 'attr', label: t('Attr.'), type: 'select', options: attrOptions(), width: '78px' },
            { key: 'rating', label: t('Rating'), type: 'num', min: 0, max: 20, width: '96px' },
            { key: 'spec', label: t('Specialization'), type: 'text' },
            { key: '_pool', label: t('Pool'), type: 'custom', width: '60px', render: (it) => <span className="mono cyan">{poolFor(draft, it.id) ?? '—'}</span> },
          ]}
          extra={<span className="bst-hint">{t('For a house skill (autosoft, IC attack…), pick « — » then fill in the label.')}</span>}
        />
        <div className="section-title">{t('Knowledge & languages')}</div>
        <ListEditor
          items={draft.knowledge}
          onChange={(v) => set(['knowledge'], v)}
          addLabel={t('Knowledge')}
          newItem={() => ({ name: '', rating: 3, type: 'street' })}
          cols={[
            { key: 'name', label: t('Name'), type: 'text' },
            {
              key: 'type',
              label: t('Type'),
              type: 'select',
              width: '130px',
              options: [
                { value: 'street', label: t('Street') },
                { value: 'academic', label: t('Academic') },
                { value: 'professional', label: t('Professional') },
                { value: 'interest', label: t('Interest') },
                { value: 'language', label: t('Language') },
              ],
            },
            { key: 'rating', label: t('Rating'), type: 'num', min: 0, max: 12, width: '96px' },
          ]}
        />
      </div>
    );
  } else if (tab === 'gear') {
    body = (
      <div className="bed">
        <div className="section-title">{t('Weapons')}</div>
        <ListEditor
          items={draft.weapons}
          onChange={(v) => set(['weapons'], v)}
          addLabel={t('Weapon')}
          newItem={() => ({ name: t('New weapon'), kind: 'ranged', skill: 'pistols', accuracy: 5, damage: '7P', ap: 0, mode: 'SA', rc: 0, ammo: '', reach: 0 })}
          extra={
            <Button small variant="ghost" onClick={() => setPicker('weapons')}>
              {t('From the catalog…')}
            </Button>
          }
          cols={[
            { key: 'name', label: t('Name'), type: 'text', width: '170px' },
            {
              key: 'kind',
              label: t('Type'),
              type: 'select',
              width: '96px',
              options: [
                { value: 'ranged', label: t('Ranged') },
                { value: 'melee', label: t('Melee') },
              ],
            },
            {
              key: 'skill',
              label: t('Skill'),
              type: 'custom',
              width: '150px',
              render: (it, patch) => <SkillSelect value={it.skill} only={COMBAT_SKILLS} onChange={(skill) => patch({ skill })} />,
            },
            { key: '_pool', label: t('abbr::Pool'), type: 'custom', render: (it) => <span className="mono cyan">{poolFor(draft, it.skill) ?? '—'}</span> },
            {
              key: 'accuracy',
              label: t('Acc.'),
              type: 'custom',
              width: '56px',
              render: (it, patch) => (
                <input className="input" value={it.accuracy ?? ''} placeholder={t('phys.')} onChange={(e) => patch({ accuracy: e.target.value === '' ? null : Number(e.target.value) || 0 })} />
              ),
            },
            { key: 'damage', label: t('DV'), type: 'text', width: '86px', placeholder: '(STR+2)P' },
            { key: 'ap', label: t('AP'), type: 'num', min: -20, max: 10, width: '92px' },
            { key: 'mode', label: t('Mode'), type: 'text', width: '86px', placeholder: 'SA/TR' },
            { key: 'rc', label: t('RC'), type: 'num', min: 0, max: 20, width: '92px' },
            { key: 'ammo', label: t('abbr::Ammo'), type: 'text', width: '70px' },
            { key: 'notes', label: t('Notes'), type: 'text', width: '140px' },
          ]}
        />
        {picker === 'weapons' && pickerEl}
        <div className="section-title">{t('Armor')}</div>
        <ListEditor
          items={draft.armor}
          onChange={(v) => set(['armor'], v)}
          addLabel={t('Armor')}
          newItem={() => ({ name: t('Armor jacket'), rating: 12, equipped: true, stack: false })}
          extra={
            <Button small variant="ghost" onClick={() => setPicker('armor')}>
              {t('From the catalog…')}
            </Button>
          }
          cols={[
            { key: 'name', label: t('Name'), type: 'text' },
            { key: 'rating', label: t('Rating'), type: 'num', min: 0, max: 50, width: '96px' },
            { key: 'stack', label: t('Stacks'), type: 'bool', width: '80px' },
            { key: 'equipped', label: t('armor::Worn'), type: 'bool', width: '70px' },
          ]}
        />
        {picker === 'armor' && pickerEl}
        {d && (
          <div className="small muted">
            {t('Total armor:')} <strong className="cyan">{d.armor}</strong> · {t('Soak {n}', { n: d.soak })}
          </div>
        )}
        <div className="section-title">{t('Augmentations')}</div>
        <ListEditor
          items={draft.augmentations}
          onChange={(v) => set(['augmentations'], v)}
          addLabel={t('Augmentation')}
          newItem={() => ({ name: '', kind: 'cyberware', grade: 'standard', essence: 0.1 })}
          cols={[
            { key: 'name', label: t('Name'), type: 'text' },
            {
              key: 'kind',
              label: t('Type'),
              type: 'select',
              width: '110px',
              options: [
                { value: 'cyberware', label: t('Cyberware') },
                { value: 'bioware', label: t('Bioware') },
              ],
            },
            { key: 'grade', label: t('Grade'), type: 'select', width: '100px', options: ['standard', 'alpha', 'beta', 'delta', 'used'] },
            { key: 'essence', label: t('Essence'), type: 'num', min: 0, max: 6, step: 0.1, width: '96px' },
            { key: 'notes', label: t('Notes'), type: 'text' },
          ]}
        />
        <div className="section-title">{t('Gear')}</div>
        <ListEditor
          items={draft.gear}
          onChange={(v) => set(['gear'], v)}
          addLabel={t('Item')}
          newItem={() => ({ name: '', qty: 1 })}
          cols={[
            { key: 'name', label: t('Name'), type: 'text' },
            { key: 'qty', label: t('Qty'), type: 'num', min: 0, max: 999, width: '96px' },
            { key: 'notes', label: t('Notes'), type: 'text' },
          ]}
        />
        <div className="section-title">{t('Vehicles & drones')}</div>
        <ListEditor
          items={draft.vehicles}
          onChange={(v) => set(['vehicles'], v)}
          addLabel={t('Vehicle')}
          newItem={() => ({ name: '', handling: '4', speed: 3, accel: 1, body: 4, armor: 4, pilot: 3, sensor: 3 })}
          cols={[
            { key: 'name', label: t('Name'), type: 'text', width: '170px' },
            { key: 'handling', label: t('Hand.'), type: 'text', width: '56px' },
            { key: 'speed', label: t('Spd.'), type: 'num', min: 0, max: 20, width: '92px' },
            { key: 'body', label: t('vehicle-abbr::Body'), type: 'num', min: 0, max: 40, width: '92px' },
            { key: 'armor', label: t('vehicle-abbr::Armor'), type: 'num', min: 0, max: 40, width: '92px' },
            { key: 'pilot', label: t('person::Pilot'), type: 'num', min: 0, max: 10, width: '92px' },
            { key: 'notes', label: t('Notes'), type: 'text' },
          ]}
        />
      </div>
    );
  } else if (tab === 'magic') {
    body = (
      <div className="bed">
        <div className="section-title">{t('Powers (adept, critter)')}</div>
        <ListEditor
          items={draft.powers}
          onChange={(v) => set(['powers'], v)}
          addLabel={t('Power')}
          newItem={() => ({ name: '', pp: 0 })}
          cols={[
            { key: 'name', label: t('Name'), type: 'text' },
            { key: 'level', label: t('Level'), type: 'num', min: 0, max: 20, width: '96px' },
            { key: 'notes', label: t('Effect / notes'), type: 'text' },
          ]}
        />
        <div className="section-title">{t('Spells')}</div>
        <ListEditor
          items={draft.spells}
          onChange={(v) => set(['spells'], v)}
          addLabel={t('Spell')}
          newItem={() => ({ name: '', category: 'Combat', type: 'M', range: 'LdV', duration: 'I', drain: 'P-3' })}
          cols={[
            { key: 'name', label: t('Name'), type: 'text', width: '160px' },
            { key: 'category', label: t('Category'), type: 'select', width: '120px', options: SPELL_CATS.map((c) => ({ value: c, label: t(c) })) },
            { key: 'type', label: t('Type'), type: 'select', width: '64px', options: ['M', 'P'] },
            { key: 'range', label: t('Range'), type: 'text', width: '70px' },
            { key: 'duration', label: t('Duration'), type: 'select', width: '64px', options: ['I', 'M', 'P'] },
            { key: 'drain', label: t('Drain'), type: 'text', width: '64px' },
            { key: 'notes', label: t('Notes'), type: 'text' },
          ]}
        />
        <div className="section-title">{t('Qualities')}</div>
        <ListEditor
          items={draft.qualities}
          onChange={(v) => set(['qualities'], v)}
          addLabel={t('Quality')}
          newItem={() => ({ name: '', karma: 0, positive: true })}
          cols={[
            { key: 'name', label: t('Name'), type: 'text' },
            { key: 'positive', label: t('Positive'), type: 'bool', width: '70px' },
            { key: 'notes', label: t('Notes'), type: 'text' },
          ]}
        />
      </div>
    );
  } else if (tab === 'notes') {
    body = (
      <div className="bed">
        <F label={t('Description (markdown — GM only)')}>
          <TextInput live multiline rows={8} value={draft.description} onChange={(v) => set(['description'], v)} />
        </F>
        <F label={t('Tactics (markdown)')}>
          <TextInput live multiline rows={6} value={draft.npc.tactics} onChange={(v) => set(['npc', 'tactics'], v)} />
        </F>
        <F label={t('Loot (markdown)')}>
          <TextInput live multiline rows={3} value={draft.npc.loot} onChange={(v) => set(['npc', 'loot'], v)} />
        </F>
      </div>
    );
  } else {
    body = <StatBlock t={draft} />;
  }

  const folder = draft.folder || DEFAULT_FOLDER;
  return (
    <Modal
      title={draft.name ? t('Template: {name}', { name: draft.name }) : t('Template: unnamed')}
      width={1080}
      onClose={requestClose}
      actions={<Badge color="dim">{folder === DEFAULT_FOLDER ? t('Miscellaneous') : tIfKnown(folder)}</Badge>}
    >
      <div className="bed">
        <Tabs tabs={TABS.map((x) => ({ ...x, label: t(x.label) }))} value={tab} onChange={setTab} />
        {body}
        <div className="bed-foot">
          <Button variant="ghost" onClick={requestClose}>
            {t('Cancel')}
          </Button>
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? t('Saving…') : t('Save the template')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
