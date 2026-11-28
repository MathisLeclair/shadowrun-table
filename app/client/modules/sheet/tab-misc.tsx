// Sheet tabs: Magie, Matrice, Équipement, Contacts & SIN, Qualités, Notes, Historique, PNJ.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, NumberInput, TextInput, Toggle, Markdown, Select } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { attr, SKILL_BY_ID } from '/shared/sr5.ts';
import { t, tk, tIfKnown, attrShort, fmtNuyen, itemName } from '../../lib/i18n.ts';
import { fmtDate, fmtNum, signed, itemLabel, itemTitle, categoryLabel } from './common.tsx';
import { containerOf } from './inventory.ts';
import { RollStat, LimitStat } from './tab-summary.tsx';
import { ItemEffects, sourcesTitle } from './modifiers-ui.tsx';
import { collectModifiers, gearHasEffects } from '/shared/modifiers.ts';
import { ListEditor, CatalogPicker } from './editors.tsx';
import { SubChips, armorCapacityText, vehicleSlotsText, lifestyleBaseLabel, lifestyleBreakdown } from './sublists.tsx';
import { armorMods } from './sheet-data.ts';
import { openMatrix, ProgramRef } from '../matrix/common.tsx';
import { ruleRef, skillRef } from '/shared/bookrefs.ts';
import { SinCards } from './sins.tsx';
import { ContactCards } from './contacts.tsx';
import { HomeButton, CityPlaceButton } from './home.tsx';
import type { Actor, ActorMatrix, ComplexForm, GameView, Quality } from '../../../shared/types.ts';
import type { AnyItem, SheetCtx, SheetModifier } from './types.ts';
import { ItemRef, RuleRef } from '../books/BookRef.tsx';


// These roll labels are stored in French in the log (formats rollLabel() recognizes); rollLabel() (common.tsx) translates
// them for each viewer.
const drainRollLabel = (k: string): string => `Résistance au drain (VOL + ${k})`; // i18n-ignore
const spellRollLabel = (name: string): string => `Sort — ${name}`; // i18n-ignore
const hasSkill = (actor: Actor, id: string): boolean => (actor.skills || []).some((s) => s.id === id && s.rating > 0);
// Augmentation grade ids shown as stored in French ('alpha', 'used'…), translated in English.
const GRADE_LABELS: Record<string, string> = { alpha: tk('grade::alphaware'), beta: tk('grade::betaware'), delta: tk('grade::deltaware'), used: tk('grade::used'), gamma: tk('grade::gammaware'), omega: tk('grade::omegaware') };
const gradeLabel = (g: string): string => (GRADE_LABELS[g] ? t(GRADE_LABELS[g]) : g);

// ---------------------------------------------------------------------------
// Magie
// ---------------------------------------------------------------------------
export function MagicTab({ s }: { s: SheetCtx }) {
  const { actor, d, edit } = s;
  const mag: number = attr(actor, 'MAG');
  const powers = actor.powers || [];
  const spells = actor.spells || [];
  const pp = powers.reduce((sum, p) => sum + (Number(p.pp) || 0), 0);
  return <div className="sh-magic">
    <div className="sh-derived">
      <RollStat label={t('Magic')} value={mag} accent="magenta" />
      <RollStat label={t('Astral Init.')} value={`${d.astralInitiative.base} + 2D6`} book={ruleRef('initiative')} />
      {d.limits.astral ? <LimitStat s={s} name="astral" label={t('Astral Limit')} /> : null}{powers.length > 0 && <RollStat label={t('Power Points')} value={`${fmtNum(pp)} / ${mag}`} accent={pp > mag ? 'magenta' : 'cyan'} title={t('PP spent / Magic')} book={ruleRef('powerPoints')} />}{hasSkill(actor, 'assensing') && <RollStat label={t('Assensing')} value={attrShort('INT')} book={skillRef('assensing')} onClick={() => s.roll({ skillId: 'assensing' })} />}{hasSkill(actor, 'spellcasting') && <RollStat label={t('Cast a spell')} value={attrShort('MAG')} book={ruleRef('spellcasting')} onClick={() => s.roll({ skillId: 'spellcasting', label: tk('Spellcasting'), limit: null })} />}{hasSkill(actor, 'counterspelling') && <RollStat label={t('Counterspelling')} value={attrShort('MAG')} book={skillRef('counterspelling')} onClick={() => s.roll({ skillId: 'counterspelling' })} />}{hasSkill(actor, 'summoning') && <RollStat label={t('Summoning')} value={attrShort('MAG')} book={skillRef('summoning')} onClick={() => s.roll({ skillId: 'summoning', limit: null })} />}
    </div>
    {(spells.length > 0 || hasSkill(actor, 'spellcasting') || hasSkill(actor, 'summoning')) && <div className="row wrap">
      <span className="muted small">{t('Resist Drain:')}</span>
      <RuleRef rule="drain" />
      {['LOG', 'CHA', 'INT'].map((k) => <Button small key={k} onClick={() => s.roll({ attr: 'WIL', attr2: k, label: drainRollLabel(k), limit: null, applyWounds: false, test: 'drainResist' })}>
        {attrShort('WIL')} + {attrShort(k)}
      </Button>)}
    </div>}
    <h4 className="section-title">{t('Adept Powers')}{' '}<RuleRef rule="adeptPowers" /></h4>
    {edit
      ? <ListEditor actor={actor} list="powers" />
      : powers.length
        ? <div className="sh-cards">
          {powers.map(
            (p) => <div className="sh-card" key={p.id}>
              <div className="row spread">
                <span><b>{p.name}{p.level ? ` ${p.level}` : ''}</b>{' '}<ItemRef item={p} /></span>
                <span className="badge badge-magenta">{t('{v} PP', { v: fmtNum(p.pp) })}</span>
              </div>
              {p.choice ? <div className="faint small">{t('Choice: {choice}', { choice: p.choice })}</div> : null}
              <ItemEffects mods={s.mods} list="powers" itemId={p.id} />
              {p.notes && <div className="muted small">{p.notes}</div>}
            </div>
          )}
        </div>
        : <div className="muted small">{t('No powers.')}</div>}
    <h4 className="section-title">{t('Spells')}</h4>
    {edit
      ? <ListEditor actor={actor} list="spells" />
      : spells.length
        ? <div className="sh-table-wrap">
          <table className="sr">
            <thead>
              <tr>
                <th>{t('Spell')}</th>
                <th>{t('Category')}</th>
                <th>{t('Type')}</th>
                <th>{t('Range')}</th>
                <th>{t('Duration')}</th>
                <th>{t('Drain')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {spells.map(
              (sp) => <tr key={sp.id}>
                <td><b>{sp.name}</b>{' '}<ItemRef item={sp} />{sp.notes ? <div className="faint small">{sp.notes}</div> : null}</td>
                <td className="small">{sp.category}</td>
                <td>{sp.type}</td>
                <td className="small">{sp.range}</td>
                <td>{sp.duration}</td>
                <td className="mono">{sp.drain}</td>
                <td>
                  <Button small variant="accent" onClick={() => s.roll({ skillId: 'spellcasting', label: spellRollLabel(sp.name), limit: null })} title={t('Spellcasting + Magic (limit = Force, set it yourself)')}>
                    {t('spell::Cast')}
                  </Button>
                </td>
              </tr>
            )}
            </tbody>
          </table>
        </div>
        : <div className="muted small">{t('No spells.')}</div>}
  </div>;
}

// ---------------------------------------------------------------------------
// Matrice
// ---------------------------------------------------------------------------
export function MatrixTab({ s }: { s: SheetCtx }) {
  const { actor, d, dm, edit } = s;
  const m = actor.matrix || null;
  const [picker, setPicker] = useState(false);
  const [newProg, setNewProg] = useState('');
  if (!m) {
    return <>
      <div className="empty">
        {t('No Matrix device.')}
        {edit && <div style={{ marginTop: '10px' }}>
        <Button variant="primary" onClick={() => s.update({ matrix: { device: 'Commlink', rating: 3, attack: 0, sleaze: 0, dataProcessing: 3, firewall: 3, programs: [] } })}>
          {t('Add a commlink / deck')}
        </Button>
      </div>}
      </div>
      <ComplexForms actor={actor} />
    </>;
  }
  const programs = m.programs || [];
  const setM = (patch: Partial<ActorMatrix>) => s.update({ matrix: patch });
  const addProg = (name: string) => {
    const n = String(name || '').trim();
    if (!n || programs.includes(n)) return;
    setM({ programs: [...programs, n] });
    setNewProg('');
  };
  // `label` is the French roll label stored in the log (each viewer translates it).
  const actions = [
    { label: tk('Cracking'), skillId: 'hacking', limit: m.sleaze, matrixLimit: 'sleaze', sub: tk('Hacking + LOG [Sleaze]') },
    { label: tk('Brute Force'), skillId: 'cybercombat', limit: m.attack, matrixLimit: 'attack', sub: tk('Cybercombat + LOG [Attack]') },
    { label: tk('Computer'), skillId: 'computer', limit: m.dataProcessing, matrixLimit: 'dataProcessing', sub: tk('Computer + LOG [Data Processing]') },
    { label: tk('Electronic Warfare'), skillId: 'electronic_warfare', limit: m.dataProcessing, matrixLimit: 'dataProcessing', sub: tk('EW + LOG [Data Processing]') },
    { label: tk('Software'), skillId: 'software', limit: m.dataProcessing, matrixLimit: 'dataProcessing', sub: tk('Software + LOG [Data Processing]') },
  ].filter((a) => SKILL_BY_ID[a.skillId] && (hasSkill(actor, a.skillId) || SKILL_BY_ID[a.skillId].def));
  const mv = m as unknown as Record<string, number | undefined>;
  const num = (k: keyof ActorMatrix, label: string) => <div className="field">
    <span className="field-label">{label}</span>
    <NumberInput small value={mv[k] || 0} min={0} max={15} onChange={(v) => setM({ [k]: v })} />
  </div>;
  return <div className="sh-matrix">
    {edit
      ? <div className="row wrap sh-edit-row">
        <label className="field grow">
          <span className="field-label">{t('Device')}</span>
          <TextInput value={m.device || ''} onChange={(v) => setM({ device: v })} />
        </label>
        {num('rating', t('Rating'))}{num('attack', t('Attack'))}{num('sleaze', t('Sleaze'))}{num('dataProcessing', t('Data Processing'))}{num('firewall', t('Firewall'))}
        <Button small variant="danger" onClick={() => s.update({ matrix: null })}>{t('Remove the device')}</Button>
      </div>
      : <div className="sh-deck">
        <div className="sh-deck-name">
          {m.device || t('Device')}{' '}
          <span className="badge badge-cyan">{t('Rating {n}', { n: m.rating || 0 })}</span>
          <Button small variant="primary" onClick={() => openMatrix(actor.id)} title={t('Matrix cockpit: connection, programs, agent, actions')}>
            {t('Open the Matrix')}
          </Button>
        </div>
        <div className="sh-asdf">
          {([[tk('Attack'), m.attack], [tk('Sleaze'), m.sleaze], [tk('Data Processing'), m.dataProcessing], [tk('Firewall'), m.firewall]] as const).map(([l, v]) => <div className="sh-asdf-cell" key={l}><b>{v || 0}</b><span>{t(l)}</span></div>)}
        </div>
      </div>}
    <div className="sh-derived">
      <RollStat label={t('AR Init.')} value={d.initiative.text} book={ruleRef('matrixInitiative')} />
      <RollStat label={t('Cold-sim VR Init.')} value={`${dm.matrixInitiative.cold.base} + ${dm.matrixInitiative.cold.dice}D6`} book={ruleRef('matrixInitiative')} title={sourcesTitle(dm.sources.matrixInitiative)} />
      <RollStat label={t('Hot-sim VR Init.')} value={`${dm.matrixInitiative.hot.base} + ${dm.matrixInitiative.hot.dice}D6`} accent="magenta" book={ruleRef('matrixInitiative')} title={sourcesTitle(dm.sources.matrixInitiative)} />
      {actions.map((a) => <RollStat key={a.skillId} label={t(a.label)} value={a.limit ?? '—'} sub={t(a.sub)} book={skillRef(a.skillId)} onClick={() => s.roll({ skillId: a.skillId, label: a.label, ...(a.limit ? { matrixLimit: a.matrixLimit } : {}) })} />)}
      <RollStat label={t('Matrix Defense')} value={attr(actor, 'INT') + (m.firewall || 0)} sub={t('{attr} + Firewall', { attr: attrShort('INT') })} onClick={() => s.roll({ attr: 'INT', label: tk('Matrix Defense'), limit: null, bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} />
      <RollStat label={t('Resist (damage)')} value={(m.rating || 0) + (m.firewall || 0)} sub={t('Rating + Firewall')} book={ruleRef('matrixDamage')} onClick={() => s.roll({ pool: (m.rating || 0) + (m.firewall || 0), label: tk('Matrix Damage Resistance'), limit: null, applyWounds: false })} />
      {(m.attack || m.sleaze) ? <RollStat label={t('Biofeedback')} value={attr(actor, 'WIL') + (m.firewall || 0)} sub={t('{attr} + Firewall', { attr: attrShort('WIL') })} book={ruleRef('biofeedback')} onClick={() => s.roll({ attr: 'WIL', label: tk('Biofeedback Resistance'), limit: null, applyWounds: false, test: 'biofeedback', bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} /> : null}
    </div>
    <h4 className="section-title">{t('Programs ({n})', { n: programs.length })}</h4>
    <div className="sh-chips">
      {programs.map((p) => <span className="sh-chip" key={p}>
        {p}
        <ProgramRef name={p} />
        {edit ? <button type="button" className="sh-chip-x" title={t('Remove')} onClick={() => setM({ programs: programs.filter((x) => x !== p) })}>
          ✕
        </button> : null}
      </span>)}
      {!programs.length && <span className="muted small">{t('No programs.')}</span>}
    </div>
    {edit && <div className="row wrap" style={{ marginTop: '8px' }}>
      <TextInput live value={newProg} placeholder={t('Program name')} onChange={setNewProg} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && addProg(e.currentTarget.value)} style={{ maxWidth: '220px' }} />
      <Button small onClick={() => addProg(newProg)}>{t('Add')}</Button>
      <Button small variant="primary" onClick={() => setPicker(true)}>{t('From the catalog')}</Button>
    </div>}
    {picker && <CatalogPicker actor={actor} list="gear" catalogs={['programs']} onClose={() => setPicker(false)} onPick={(conv, e) => addProg(itemName(e))} />}
    <ComplexForms actor={actor} />
  </div>;
}

/** Complex forms of a technomancer (Chummer import, creator, training): name, target, duration, Fading, 📖 page. */
function ComplexForms({ actor }: { actor: Actor }) {
  const forms = actor.complexForms || [];
  if (!forms.length) return null;
  return <>
    <h4 className="section-title">{t('Complex Forms')}{' '}<RuleRef rule="complexForms" /></h4>
    <div className="sh-table-wrap">
      <table className="sr">
        <thead><tr><th>{t('Complex Form')}</th><th>{t('Target')}</th><th>{t('Duration')}</th><th>{t('Fading')}</th></tr></thead>
        <tbody>
          {forms.map((f) => <tr key={f.id}>
        <td><b>{f.name}</b>{' '}<ItemRef item={f} />{f.notes ? <div className="faint small">{f.notes}</div> : null}</td>
        <td className="small">{f.target ? tIfKnown(f.target) : '—'}</td>
        <td>{f.duration || '—'}</td>
        <td className="mono">{f.fading || '—'}</td>
      </tr>)}
        </tbody>
      </table>
    </div>
  </>;
}

// ---------------------------------------------------------------------------
// Équipement
// ---------------------------------------------------------------------------
/** Where an item is when it is not « Sur soi » (bag, vehicle, safehouse — tab « Inventaire »). */
function PlaceBadge({ actor, it }: { actor: Actor; it: AnyItem }) {
  const c = containerOf(actor, it.location);
  return c ? <>{' '}<span className="badge" title={t('Stored: does not count until it is carried')}>{c.name}</span></> : null;
}

export function GearTab({ s }: { s: SheetCtx }) {
  const { actor, d, dm, edit, own } = s;
  const upItem = (list: string, id: string, patch: AnyItem) => send('actor/updateItem', { actorId: actor.id, list, itemId: id, patch }).catch(() => {});
  const armor = actor.armor || [];
  const augs = actor.augmentations || [];
  const gear = actor.gear || [];
  const vehicles = actor.vehicles || [];
  const essUsed = augs.reduce((sum, a) => sum + (Number(a.essence) || 0), 0);
  if (edit) {
    return <div className="sh-gear">
      <h4 className="section-title">{t('pl::Armor')}</h4>
      <ListEditor actor={actor} list="armor" />
      <h4 className="section-title">{t('Augmentations')}</h4>
      <ListEditor actor={actor} list="augmentations" />
      <h4 className="section-title">{t('Gear')}</h4>
      <ListEditor actor={actor} list="gear" />
      <h4 className="section-title">{t('Vehicles & drones')}</h4>
      <ListEditor actor={actor} list="vehicles" />
    </div>;
  }
  return <div className="sh-gear">
    <div className="sh-sec-head">
      <h4 className="section-title">{t('pl::Armor')}</h4>
      <span className="badge badge-cyan" title={sourcesTitle(dm.sources.armor, t('Worn armor: {n}', { n: d.armor }))}>
        {t('Total armor {n}', { n: dm.armor })}
      </span>
    </div>
    {armor.length
      ? <div className="sh-list">
        {armor.map((a) => {
          const am = armorMods(a);
          const cap = armorCapacityText(a);
          return <div className={'sh-list-row' + (a.equipped ? ' on' : '')} key={a.id}>
            {own
              ? <Toggle value={a.equipped} onChange={(v) => upItem('armor', a.id, { equipped: v })} title={t('Equip / unequip')} />
              : <span className={'badge ' + (a.equipped ? 'badge-cyan' : '')}>{a.equipped ? t('worn') : t('stowed')}</span>}
            <div className="grow">
              <b title={itemTitle(a)}>{itemLabel(a)}</b>
              {' '}
              <ItemRef item={a} />
              <PlaceBadge actor={actor} it={a} />
              {cap ? <>{' '}<span className={'badge' + (am.used > am.total ? ' badge-red' : '')}>{cap}</span></> : null}{(a.mods || []).length > 0 && <div><SubChips sub="mods" items={a.mods} /></div>}{a.equipped ? <ItemEffects mods={s.mods} list="armor" itemId={a.id} /> : <ItemEffects mods={collectModifiers({ armor: [{ ...a, equipped: true }] }, s.lookup)} list="armor" itemId={a.id} />}{a.notes ? <div className="faint small">{a.notes}</div> : null}
            </div>
            <span className="mono sh-big" title={am.bonus ? t('{base} + {bonus} (modifications) = {total}, counted in the total armor', { base: a.rating, bonus: am.bonus, total: (Number(a.rating) || 0) + am.bonus }) : ''}>
              {a.stack ? '+' : ''}{a.rating}{am.bonus ? <small className="cyan"> +{am.bonus}</small> : null}
            </span>
          </div>;
        })}
      </div>
      : <div className="muted small">{t('No armor.')}</div>}
    <div className="sh-sec-head">
      <h4 className="section-title">{t('Augmentations')}</h4>
      <span className="badge">
        {t('Essence {ess} (−{used})', { ess: fmtNum(Math.round(d.essence * 100) / 100), used: fmtNum(Math.round(essUsed * 100) / 100) })}
      </span>
    </div>
    {augs.length
      ? <div className="sh-list">
        {augs.map(
          (a) => <div className="sh-list-row" key={a.id}>
            <span className={'badge ' + (a.kind === 'bioware' ? 'badge-green' : 'badge-cyan')}>{a.kind === 'bioware' ? 'Bio' : 'Cyber'}</span>
            <div className="grow">
              <b title={itemTitle(a)}>{itemLabel(a)}</b>
              {a.rating ? ` (${t('rating {n}', { n: a.rating })})` : ''}{' '}
              <ItemRef item={a} />
              {a.grade && a.grade !== 'standard' ? <>{' '}<span className="badge">{gradeLabel(a.grade)}</span></> : null}{a.choice ? <>{' '}<span className="faint small">{t('Choice: {choice}', { choice: a.choice })}</span></> : null}
              <ItemEffects mods={s.mods} list="augmentations" itemId={a.id} />
              {a.notes ? <div className="faint small">{a.notes}</div> : null}
            </div>
            <span className="mono">{t('{v} ESS', { v: fmtNum(Math.round((Number(a.essence) || 0) * 1000) / 1000) })}</span>
          </div>
        )}
      </div>
      : <div className="muted small">{t('No augmentations.')}</div>}
    <h4 className="section-title">{t('Gear')}</h4>
    {gear.length
      ? <div className="sh-list">
        {gear.map(
          (g) => <div className={'sh-list-row' + (g.active ? ' on' : '')} key={g.id}>
            {gearHasEffects(g, s.lookup) ? (own ? <Toggle value={!!g.active} onChange={(v) => upItem('gear', g.id, { active: v })} title={t('Worn / switched on: its effects count in rolls')} /> : <span className={'badge ' + (g.active ? 'badge-cyan' : '')}>{g.active ? t('active') : t('inactive')}</span>) : null}
            <div className="grow">
              <b title={itemTitle(g)}>{itemLabel(g)}</b>
              {g.rating ? ` (${t('rating {n}', { n: g.rating })})` : ''}{' '}
              <ItemRef item={g} />
              {' '}
              <span className="faint small">{categoryLabel(g)}</span>
              <PlaceBadge actor={actor} it={g} />
              {gearHasEffects(g, s.lookup) ? <ItemEffects mods={g.active ? s.mods : collectModifiers({ gear: [{ ...g, active: true }] }, s.lookup)} list="gear" itemId={g.id} /> : null}
              {own
                ? <TextInput className="sh-inline-note" value={g.notes || ''} placeholder={t('Notes…')} onChange={(v) => upItem('gear', g.id, { notes: v })} />
                : g.notes
                  ? <div className="faint small">{g.notes}</div>
                  : null}
            </div>
            {own ? <NumberInput small value={g.qty ?? 1} min={0} max={s.gm ? 9999 : Math.max(0, Number(g.qty ?? 1) || 0)} onChange={(v) => upItem('gear', g.id, { qty: v })} /> : <span className="mono">×{g.qty ?? 1}</span>}
          </div>
        )}
      </div>
      : <div className="muted small">{t('No gear.')}</div>}
    {vehicles.length > 0 && <>
      <h4 className="section-title">{t('Vehicles & drones')}</h4>
      <div className="sh-cards">
        {vehicles.map(
        (v) => <div className="sh-card" key={v.id}>
          <span><b title={itemTitle(v)}>{itemLabel(v)}</b>{' '}<ItemRef item={v} /></span>
          <div className="sh-vstats">
            {([[tk('Handl.'), v.handling], [tk('Speed'), v.speed], [tk('Accel.'), v.accel], [tk('vehicle-abbr::Body'), v.body], [tk('vehicle-abbr::Armor'), v.armor], [tk('Pilot'), v.pilot], [tk('Sensor'), v.sensor], [tk('Seats'), v.seats]] as const).map(([l, x]) => <span key={l}><span className="faint">{t(l)}</span>{' '}<b>{x ?? '—'}</b></span>)}
          </div>
          {(v.mods || []).length > 0 && <><div className="faint small">{vehicleSlotsText(v)}</div><SubChips sub="mods" items={v.mods} /></>}{v.notes && <div className="faint small">{v.notes}</div>}
        </div>
      )}
      </div>
    </>}
  </div>;
}

/** Lifestyles (« Modes de vie »): base, monthly cost with its breakdown, options (garage, DocWagon contract, security…). */
function LifestylesView({ game, actor, showPaid }: { game: GameView; actor: Actor; showPaid: boolean }) {
  const list = actor.lifestyles || [];
  if (!list.length) return <div className="muted small">{t('No lifestyle.')}</div>;
  return <div className="sh-cards">
    {list.map((l) => <div className={'sh-card sh-lifestyle' + (l.primary ? ' primary' : '')} key={l.id}>
      <div className="row spread wrap sh-lifestyle-head">
        <span className="sh-lifestyle-name"><b>{l.name || lifestyleBaseLabel(l.base)}</b>{' '}<ItemRef item={l} /></span>
        <span className="row gap-s">
          {l.primary ? <span className="badge badge-amber">{t('primary')}</span> : null}
          <span className="badge badge-cyan">{lifestyleBaseLabel(l.base)}</span>
        </span>
      </div>
      <div className="row wrap gap-s">
        <span className="mono">{t('{cost}/month', { cost: fmtNuyen(l.monthlyCost || 0) })}</span>
        {(l.qualities || []).length > 0 && <span className="faint small" title={t('Base cost, options as % of the base cost, flat-price options')}>({lifestyleBreakdown(l)})</span>}{showPaid ? <span className="muted small">· {t('{n} month(s) paid', { n: l.monthsPaid || 0 })}</span> : null}
      </div>
      {l.points && <div className="faint small">
      {t('Comforts {c} · Security {s} · Neighborhood {n}', { c: l.points.comforts ?? '—', s: l.points.security ?? '—', n: l.points.neighborhood ?? '—' })}
    </div>}
      <SubChips sub="qualities" items={l.qualities} />
      {l.notes && <div className="faint small">{l.notes}</div>}{showPaid && game ? <div className="row wrap gap-s"><HomeButton game={game} actor={actor} lifestyle={l} canMove={showPaid} /><CityPlaceButton game={game} actor={actor} lifestyle={l} /></div> : null}
    </div>)}
  </div>;
}

// ---------------------------------------------------------------------------
// Contacts & SIN
// ---------------------------------------------------------------------------
export function ContactsTab({ s }: { s: SheetCtx }) {
  const { actor, edit, own, gm } = s;
  if (edit) {
    return <div>
      <h4 className="section-title">{t('Contacts')}</h4>
      <ListEditor actor={actor} list="contacts" />
      <h4 className="section-title">{t('SINs & licenses')}</h4>
      <ListEditor actor={actor} list="sins" />
      <h4 className="section-title">{t('Lifestyles')}</h4>
      <ListEditor actor={actor} list="lifestyles" />
    </div>;
  }
  return <div>
    <h4 className="section-title">{t('Contacts')}{' '}<RuleRef rule="contacts" /></h4>
    <ContactCards game={s.game} actor={actor} gm={gm} own={own} />
    <h4 className="section-title">{t('SINs & licenses')}{' '}<RuleRef rule="fakeSin" /></h4>
    <SinCards actor={actor} gm={gm} own={own} />
    {(actor.lifestyles || []).length > 0 && <>
      <h4 className="section-title">{t('Lifestyles')}{' '}<RuleRef rule="lifestyles" /></h4>
      <LifestylesView game={s.game} actor={actor} showPaid={gm || own} />
    </>}
  </div>;
}

// ---------------------------------------------------------------------------
// Qualités
// ---------------------------------------------------------------------------
export function QualitiesTab({ s }: { s: SheetCtx }) {
  const { actor, edit, mods } = s;
  const qs = actor.qualities || [];
  if (edit) return <ListEditor actor={actor} list="qualities" />;
  const pos = qs.filter((q) => q.positive !== false && (q.karma || 0) >= 0);
  const neg = qs.filter((q) => !pos.includes(q));
  const col = (title: string, list: Quality[], color: string) => <section>
    <div className="sh-sec-head">
      <h4 className="section-title">{title}</h4>
      <span className={'badge badge-' + color}>{t('{v} karma', { v: signed(list.reduce((sum, q) => sum + (q.karma || 0), 0)) })}</span>
    </div>
    {list.length
      ? <div className="sh-list">
        {list.map(
          (q) => <div className="sh-list-row" key={q.id}>
            <div className="grow">
              <b>{q.name}</b>
              {' '}
              <ItemRef item={q} />
              {q.choice ? <>{' '}<span className="faint small">{t('Choice: {choice}', { choice: q.choice })}</span></> : null}
              <ItemEffects mods={mods} list="qualities" itemId={q.id} />
              {q.notes ? <div className="faint small">{q.notes}</div> : null}
            </div>
            <span className={'mono ' + color}>{signed(q.karma || 0)}</span>
          </div>
        )}
      </div>
      : <div className="muted small">{t('None.')}</div>}
  </section>;
  return <div className="grid-2">{col(t('Positive Qualities'), pos, 'green')}{col(t('Negative Qualities'), neg, 'red')}</div>;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
interface MdFieldProps {
  title: ReactNode;
  value: string | null | undefined;
  canEdit: boolean;
  onSave: (v: string) => void;
  placeholder?: string;
  accent?: string;
}
function MdField({ title, value, canEdit, onSave, placeholder, accent }: MdFieldProps) {
  const [editing, setEditing] = useState(false);
  return <section className={'sh-md' + (accent ? ' sh-md-' + accent : '')}>
    <div className="sh-sec-head">
      <h4 className="section-title">{title}</h4>
      {canEdit && <Button small variant="ghost" onClick={() => setEditing(!editing)}>{editing ? t('Preview') : t('Edit')}</Button>}
    </div>
    {editing
      ? <>
        <TextInput multiline rows={10} value={value || ''} placeholder={placeholder} onChange={onSave} />
        <div className="faint small">{t('Markdown: **bold**, *italic*, “- ” lists, “## ” headings. Saved when you leave the field.')}</div>
      </>
      : value
        ? <Markdown text={value} />
        : <div className="muted small">{canEdit ? t('Empty — click “Edit”.') : t('Nothing yet.')}</div>}
  </section>;
}

export function NotesTab({ s }: { s: SheetCtx }) {
  const { actor, own, gm } = s;
  return <div className="col gap-l">
    {(own || actor.notes !== undefined) && <MdField title={gm ? t('Notes (player + GM)') : t('My notes')} value={actor.notes} canEdit={own} onSave={(v) => s.update({ notes: v })} placeholder={t('Leads, names, debts, plans…')} />}
    <MdField title={t('Biography')} value={actor.bio} canEdit={own} onSave={(v) => s.update({ bio: v })} placeholder={t('Background, appearance, motivations…')} />
    {gm && <MdField title={t('GM notes (secret)')} accent="magenta" value={actor.gmNotes} canEdit={true} onSave={(v) => s.update({ gmNotes: v })} placeholder={t('Secrets, hooks, weaknesses to exploit…')} />}
  </div>;
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------
function AdjustForm({ actor }: { actor: Actor }) {
  const [karma, setKarma] = useState(0);
  const [ny, setNy] = useState(0);
  const [reason, setReason] = useState('');
  const go = () =>
    send('actor/adjust', { actorId: actor.id, karma, nuyen: ny, reason })
      .then(() => {
        setKarma(0);
        setNy(0);
        setReason('');
      })
      .catch(() => {});
  return <div className="sh-adjust row wrap">
    <div className="field">
      <span className="field-label">{t('Karma')}</span>
      <NumberInput small value={karma} min={-500} max={500} onChange={setKarma} />
    </div>
    <div className="field">
      <span className="field-label">{t('Nuyen')}</span>
      <NumberInput small value={ny} min={-10000000} max={10000000} step={100} onChange={setNy} />
    </div>
    <label className="field grow">
      <span className="field-label">{t('Reason')}</span>
      <TextInput live value={reason} placeholder={t('Run reward, debt, purchase outside the shop…')} onChange={setReason} />
    </label>
    <Button variant="primary" disabled={!karma && !ny} onClick={go}>{t('Apply')}</Button>
  </div>;
}

export function HistoryTab({ s }: { s: SheetCtx }) {
  const { actor, gm, edit } = s;
  const h = [...(actor.history || [])].reverse();
  const totK = (actor.history || []).reduce((sum, e) => sum + (e.karma || 0), 0);
  const totN = (actor.history || []).reduce((sum, e) => sum + (e.nuyen || 0), 0);
  return <div>
    <div className="sh-derived">
      <RollStat label={t('Available karma')} value={actor.karma} accent="amber" />
      <RollStat label={t('Career Karma')} value={actor.karmaTotal} />
      <RollStat label={t('Nuyen')} value={fmtNuyen(actor.nuyen)} accent="cyan" />
      {edit && <>
        <div className="field">
          <span className="field-label">{t('Karma (direct)')}</span>
          <NumberInput small value={actor.karma} min={-999} max={99999} onChange={(v) => s.update({ karma: v })} />
        </div>
        <div className="field">
          <span className="field-label">{t('Career')}</span>
          <NumberInput small value={actor.karmaTotal} min={0} max={99999} onChange={(v) => s.update({ karmaTotal: v })} />
        </div>
        <div className="field">
          <span className="field-label">{t('Nuyen (direct)')}</span>
          <NumberInput small value={actor.nuyen} min={0} max={1e9} step={100} onChange={(v) => s.update({ nuyen: v })} />
        </div>
      </>}
    </div>
    {gm && <><h4 className="section-title">{t('Adjustment (recorded in the history)')}</h4><AdjustForm actor={actor} /></>}
    <h4 className="section-title">{t('Ledger')}</h4>
    {h.length
      ? <div className="sh-table-wrap">
        <table className="sr">
          <thead>
            <tr><th>{t('Date')}</th><th>{t('Operation')}</th><th className="right">{t('Karma')}</th><th className="right">{t('Nuyen')}</th></tr>
          </thead>
          <tbody>
            {h.map(
            (e, i) => <tr key={i}>
              <td className="small muted">{fmtDate(e.ts)}</td>
              <td>{e.i18n?.key ? t(e.i18n.key, e.i18n.params) : tIfKnown(e.text)}</td>
              <td className={'num-cell ' + ((e.karma || 0) > 0 ? 'green' : (e.karma || 0) < 0 ? 'red' : 'faint')}>
                {e.karma ? signed(e.karma) : '—'}
              </td>
              <td className={'num-cell ' + ((e.nuyen || 0) > 0 ? 'green' : (e.nuyen || 0) < 0 ? 'red' : 'faint')}>
                {e.nuyen ? (e.nuyen > 0 ? '+' : '−') + fmtNuyen(Math.abs(e.nuyen)) : '—'}
              </td>
            </tr>
          )}
          </tbody>
          <tfoot>
            <tr>
              <td />
              <td className="muted small">{t('Total of changes')}</td>
              <td className="num-cell">{signed(totK)}</td>
              <td className="num-cell">{fmtNuyen(totN)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      : <div className="muted small">{t('No entries.')}</div>}
  </div>;
}

// ---------------------------------------------------------------------------
// PNJ (GM)
// ---------------------------------------------------------------------------
export function NpcTab({ s, game }: { s: SheetCtx; game: GameView }) {
  const { actor } = s;
  const npc: NonNullable<Actor['npc']> = actor.npc || {};
  const tpl = actor.templateId && game.bestiary?.[actor.templateId];
  const setN = (patch: NonNullable<Actor['npc']>) => s.update({ npc: patch });
  return <div className="col gap-l">
    <div className="row wrap sh-edit-row">
      <div className="field">
        <span className="field-label">{t('Professional Rating')}</span>
        <NumberInput small value={npc.professionalRating || 0} min={0} max={7} onChange={(v) => setN({ professionalRating: v })} />
      </div>
      <Toggle value={!!npc.grunt} onChange={(v) => setN({ grunt: v })} label={t('Grunt (group monitor)')} />
      <Toggle value={!!actor.hidden} onChange={(v) => s.update({ hidden: v })} label={t('Hidden from players')} />
      <label className="field">
        <span className="field-label">{t('Type')}</span>
        <Select value={actor.type} options={[{ value: 'npc', label: t('NPC') }, { value: 'pc', label: t('PC') }]} onChange={(v) => s.update({ type: v })} />
      </label>
      {tpl ? <span className="badge badge-amber">{t('Template: {name}', { name: tpl.name })}</span> : actor.templateId ? <span className="badge">{t('Template {id}', { id: actor.templateId })}</span> : null}
    </div>
    <MdField title={t('pl::Tactics')} accent="magenta" value={npc.tactics} canEdit={true} onSave={(v) => setN({ tactics: v })} placeholder={t('Combat behavior, reactions, morale…')} />
    <MdField title={t('Loot')} value={npc.loot} canEdit={true} onSave={(v) => setN({ loot: v })} placeholder={t('What the runners find on the body…')} />
  </div>;
}
