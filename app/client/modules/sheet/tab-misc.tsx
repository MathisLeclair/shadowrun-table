// Sheet tabs: Magie, Matrice, Équipement, Contacts & SIN, Qualités, Notes, Historique, PNJ.
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, NumberInput, TextInput, Toggle, Markdown, Select } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { attr, SKILL_BY_ID } from '/shared/sr5.js';
import { t, tk, tIfKnown, attrShort, fmtNuyen, itemName } from '../../lib/i18n.js';
import { fmtDate, fmtNum, signed, itemLabel, itemTitle, categoryLabel } from './common.tsx';
import { containerOf } from './inventory.js';
import { RollStat, LimitStat } from './tab-summary.tsx';
import { ItemEffects, sourcesTitle } from './modifiers-ui.tsx';
import { collectModifiers, gearHasEffects } from '/shared/modifiers.js';
import { ListEditor, CatalogPicker } from './editors.tsx';
import { SubChips, armorCapacityText, vehicleSlotsText, lifestyleBaseLabel, lifestyleBreakdown } from './sublists.tsx';
import { armorMods } from './sheet-data.js';
import { openMatrix, ProgramRef } from '../matrix/common.js';
import { ItemRef, RuleRef } from './ext.ts';
import { ruleRef, skillRef } from '/shared/bookrefs.js';
import { SinCards } from './sins.tsx';
import { ContactCards } from './contacts.tsx';
import { HomeButton } from './home.tsx';
import type { Actor, ActorMatrix, ComplexForm, GameView, Quality } from '../../../shared/types.ts';
import type { AnyItem, SheetCtx, SheetModifier } from './types.ts';

/** Complex forms may carry a target (Chummer import): missing from shared/types.ts ComplexForm. */
type SheetComplexForm = ComplexForm & { target?: string };
const collectMods = collectModifiers as unknown as (actor: Partial<Actor>, lookup: SheetCtx['lookup']) => SheetModifier[];

// Roll labels are stored in French in the log; rollLabel() (common.js) translates them for each viewer.
const drainRollLabel = (k: string): string => `Résistance au drain (VOL + ${k})`; // i18n-ignore
const spellRollLabel = (name: string): string => `Sort — ${name}`; // i18n-ignore
const hasSkill = (actor: Actor, id: string): boolean => (actor.skills || []).some((s) => s.id === id && s.rating > 0);
// Augmentation grade ids shown as stored in French ('alpha', 'used'…), translated in English.
const GRADE_LABELS: Record<string, string> = { alpha: tk('grade::alpha'), beta: tk('grade::beta'), delta: tk('grade::delta'), used: tk('grade::used'), gamma: tk('grade::gamma'), omega: tk('grade::omega') };
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
      <RollStat label={t('Magie')} value={mag} accent="magenta" />
      <RollStat label={t('Init. astrale')} value={`${d.astralInitiative.base} + 2D6`} book={ruleRef('initiative')} />
      {d.limits.astral ? <LimitStat s={s} name="astral" label={t('Limite astrale')} /> : null}{powers.length > 0 && <RollStat label={t('Points de pouvoir')} value={`${fmtNum(pp)} / ${mag}`} accent={pp > mag ? 'magenta' : 'cyan'} title={t('PP dépensés / Magie')} book={ruleRef('powerPoints')} />}{hasSkill(actor, 'assensing') && <RollStat label={t('Observation astrale')} value={attrShort('INT')} book={skillRef('assensing')} onClick={() => s.roll({ skillId: 'assensing' })} />}{hasSkill(actor, 'spellcasting') && <RollStat label={t('Lancer un sort')} value={attrShort('MAG')} book={ruleRef('spellcasting')} onClick={() => s.roll({ skillId: 'spellcasting', label: tk('Lancement de sort'), limit: null })} />}{hasSkill(actor, 'counterspelling') && <RollStat label={t('Contresort')} value={attrShort('MAG')} book={skillRef('counterspelling')} onClick={() => s.roll({ skillId: 'counterspelling' })} />}{hasSkill(actor, 'summoning') && <RollStat label={t('Invocation')} value={attrShort('MAG')} book={skillRef('summoning')} onClick={() => s.roll({ skillId: 'summoning', limit: null })} />}
    </div>
    {(spells.length > 0 || hasSkill(actor, 'spellcasting') || hasSkill(actor, 'summoning')) && <div className="row wrap">
      <span className="muted small">{t('Résister au drain :')}</span>
      <RuleRef rule="drain" />
      {['LOG', 'CHA', 'INT'].map((k) => <Button small key={k} onClick={() => s.roll({ attr: 'WIL', attr2: k, label: drainRollLabel(k), limit: null, applyWounds: false, test: 'drainResist' })}>
        {attrShort('WIL')} + {attrShort(k)}
      </Button>)}
    </div>}
    <h4 className="section-title">{t('Pouvoirs d’adepte')}{' '}<RuleRef rule="adeptPowers" /></h4>
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
              {p.choice ? <div className="faint small">{t('Choix : {choice}', { choice: p.choice })}</div> : null}
              <ItemEffects mods={s.mods} list="powers" itemId={p.id} />
              {p.notes && <div className="muted small">{p.notes}</div>}
            </div>
          )}
        </div>
        : <div className="muted small">{t('Aucun pouvoir.')}</div>}
    <h4 className="section-title">{t('Sorts')}</h4>
    {edit
      ? <ListEditor actor={actor} list="spells" />
      : spells.length
        ? <div className="sh-table-wrap">
          <table className="sr">
            <thead>
              <tr>
                <th>{t('Sort')}</th>
                <th>{t('Catégorie')}</th>
                <th>{t('Type')}</th>
                <th>{t('Portée')}</th>
                <th>{t('Durée')}</th>
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
                  <Button small variant="accent" onClick={() => s.roll({ skillId: 'spellcasting', label: spellRollLabel(sp.name), limit: null })} title={t('Lancement de sorts + Magie (limite = Puissance, à régler)')}>
                    {t('sort::Lancer')}
                  </Button>
                </td>
              </tr>
            )}
            </tbody>
          </table>
        </div>
        : <div className="muted small">{t('Aucun sort.')}</div>}
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
        {t('Aucun appareil matriciel.')}
        {edit && <div style={{ marginTop: '10px' }}>
        <Button variant="primary" onClick={() => s.update({ matrix: { device: 'Commlink', rating: 3, attack: 0, sleaze: 0, dataProcessing: 3, firewall: 3, programs: [] } })}>
          {t('Ajouter un commlink / deck')}
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
    { label: tk('Piratage'), skillId: 'hacking', limit: m.sleaze, matrixLimit: 'sleaze', sub: tk('Hacking + LOG [Corruption]') },
    { label: tk('Force brute'), skillId: 'cybercombat', limit: m.attack, matrixLimit: 'attack', sub: tk('Cybercombat + LOG [Attaque]') },
    { label: tk('Informatique'), skillId: 'computer', limit: m.dataProcessing, matrixLimit: 'dataProcessing', sub: tk('Informatique + LOG [Traitement]') },
    { label: tk('Guerre électronique'), skillId: 'electronic_warfare', limit: m.dataProcessing, matrixLimit: 'dataProcessing', sub: tk('GE + LOG [Traitement]') },
    { label: tk('Software'), skillId: 'software', limit: m.dataProcessing, matrixLimit: 'dataProcessing', sub: tk('Software + LOG [Traitement]') },
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
          <span className="field-label">{t('Appareil')}</span>
          <TextInput value={m.device || ''} onChange={(v) => setM({ device: v })} />
        </label>
        {num('rating', t('Indice'))}{num('attack', t('Attaque'))}{num('sleaze', t('Corruption'))}{num('dataProcessing', t('Traitement'))}{num('firewall', t('Firewall'))}
        <Button small variant="danger" onClick={() => s.update({ matrix: null })}>{t('Retirer l’appareil')}</Button>
      </div>
      : <div className="sh-deck">
        <div className="sh-deck-name">
          {m.device || t('Appareil')}{' '}
          <span className="badge badge-cyan">{t('Indice {n}', { n: m.rating || 0 })}</span>
          <Button small variant="primary" onClick={() => openMatrix(actor.id)} title={t('Cockpit matriciel : connexion, programmes, agent, actions')}>
            {t('Ouvrir la Matrice')}
          </Button>
        </div>
        <div className="sh-asdf">
          {[[tk('Attaque'), m.attack], [tk('Corruption'), m.sleaze], [tk('Traitement'), m.dataProcessing], [tk('Firewall'), m.firewall]].map(([l, v]) => <div className="sh-asdf-cell" key={l}><b>{v || 0}</b><span>{t(l)}</span></div>)}
        </div>
      </div>}
    <div className="sh-derived">
      <RollStat label={t('Init. RA')} value={d.initiative.text} book={ruleRef('matrixInitiative')} />
      <RollStat label={t('Init. RV froide')} value={`${dm.matrixInitiative.cold.base} + ${dm.matrixInitiative.cold.dice}D6`} book={ruleRef('matrixInitiative')} title={sourcesTitle(dm.sources.matrixInitiative)} />
      <RollStat label={t('Init. RV chaude')} value={`${dm.matrixInitiative.hot.base} + ${dm.matrixInitiative.hot.dice}D6`} accent="magenta" book={ruleRef('matrixInitiative')} title={sourcesTitle(dm.sources.matrixInitiative)} />
      {actions.map((a) => <RollStat key={a.skillId} label={t(a.label)} value={a.limit ?? '—'} sub={t(a.sub)} book={skillRef(a.skillId)} onClick={() => s.roll({ skillId: a.skillId, label: a.label, ...(a.limit ? { matrixLimit: a.matrixLimit } : {}) })} />)}
      <RollStat label={t('Défense matricielle')} value={attr(actor, 'INT') + (m.firewall || 0)} sub={t('{attr} + Firewall', { attr: attrShort('INT') })} onClick={() => s.roll({ attr: 'INT', label: tk('Défense matricielle'), limit: null, bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} />
      <RollStat label={t('Résister (dommages)')} value={(m.rating || 0) + (m.firewall || 0)} sub={t('Indice + Firewall')} book={ruleRef('matrixDamage')} onClick={() => s.roll({ pool: (m.rating || 0) + (m.firewall || 0), label: tk('Résistance aux dommages matriciels'), limit: null, applyWounds: false })} />
      {(m.attack || m.sleaze) ? <RollStat label={t('Biofeedback')} value={attr(actor, 'WIL') + (m.firewall || 0)} sub={t('{attr} + Firewall', { attr: attrShort('WIL') })} book={ruleRef('biofeedback')} onClick={() => s.roll({ attr: 'WIL', label: tk('Résistance au biofeedback'), limit: null, applyWounds: false, test: 'biofeedback', bonus: [{ label: 'Firewall', value: m.firewall || 0 }] })} /> : null}
    </div>
    <h4 className="section-title">{t('Programmes ({n})', { n: programs.length })}</h4>
    <div className="sh-chips">
      {programs.map((p) => <span className="sh-chip" key={p}>
        {p}
        <ProgramRef name={p} />
        {edit ? <button type="button" className="sh-chip-x" title={t('Retirer')} onClick={() => setM({ programs: programs.filter((x) => x !== p) })}>
          ✕
        </button> : null}
      </span>)}
      {!programs.length && <span className="muted small">{t('Aucun programme.')}</span>}
    </div>
    {edit && <div className="row wrap" style={{ marginTop: '8px' }}>
      <TextInput live value={newProg} placeholder={t('Nom du programme')} onChange={setNewProg} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && addProg(e.currentTarget.value)} style={{ maxWidth: '220px' }} />
      <Button small onClick={() => addProg(newProg)}>{t('Ajouter')}</Button>
      <Button small variant="primary" onClick={() => setPicker(true)}>{t('Depuis le catalogue')}</Button>
    </div>}
    {picker && <CatalogPicker actor={actor} list="gear" catalogs={['programs']} onClose={() => setPicker(false)} onPick={(conv, e) => addProg(itemName(e))} />}
    <ComplexForms actor={actor} />
  </div>;
}

/** Complex forms of a technomancer (Chummer import, creator, training): name, target, duration, Fading, 📖 page. */
function ComplexForms({ actor }: { actor: Actor }) {
  const forms = (actor.complexForms || []) as SheetComplexForm[];
  if (!forms.length) return null;
  return <>
    <h4 className="section-title">{t('Formes complexes')}{' '}<RuleRef rule="complexForms" /></h4>
    <div className="sh-table-wrap">
      <table className="sr">
        <thead><tr><th>{t('Forme complexe')}</th><th>{t('Cible')}</th><th>{t('Durée')}</th><th>{t('Fading')}</th></tr></thead>
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
  return c ? <>{' '}<span className="badge" title={t('Rangé : ne compte pas tant qu’il n’est pas sur soi')}>{c.name}</span></> : null;
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
      <h4 className="section-title">{t('Armures')}</h4>
      <ListEditor actor={actor} list="armor" />
      <h4 className="section-title">{t('Augmentations')}</h4>
      <ListEditor actor={actor} list="augmentations" />
      <h4 className="section-title">{t('Équipement')}</h4>
      <ListEditor actor={actor} list="gear" />
      <h4 className="section-title">{t('Véhicules & drones')}</h4>
      <ListEditor actor={actor} list="vehicles" />
    </div>;
  }
  return <div className="sh-gear">
    <div className="sh-sec-head">
      <h4 className="section-title">{t('Armures')}</h4>
      <span className="badge badge-cyan" title={sourcesTitle(dm.sources.armor, t('Armures portées : {n}', { n: d.armor }))}>
        {t('Armure totale {n}', { n: dm.armor })}
      </span>
    </div>
    {armor.length
      ? <div className="sh-list">
        {armor.map((a) => {
          const am = armorMods(a);
          const cap = armorCapacityText(a);
          return <div className={'sh-list-row' + (a.equipped ? ' on' : '')} key={a.id}>
            {own
              ? <Toggle value={a.equipped} onChange={(v) => upItem('armor', a.id, { equipped: v })} title={t('Équiper / retirer')} />
              : <span className={'badge ' + (a.equipped ? 'badge-cyan' : '')}>{a.equipped ? t('portée') : t('rangée')}</span>}
            <div className="grow">
              <b title={itemTitle(a)}>{itemLabel(a)}</b>
              {' '}
              <ItemRef item={a} />
              <PlaceBadge actor={actor} it={a} />
              {cap ? <>{' '}<span className={'badge' + (am.used > am.total ? ' badge-red' : '')}>{cap}</span></> : null}{(a.mods || []).length > 0 && <div><SubChips sub="mods" items={a.mods} /></div>}{a.equipped ? <ItemEffects mods={s.mods} list="armor" itemId={a.id} /> : <ItemEffects mods={collectMods({ armor: [{ ...a, equipped: true }] }, s.lookup)} list="armor" itemId={a.id} />}{a.notes ? <div className="faint small">{a.notes}</div> : null}
            </div>
            <span className="mono sh-big" title={am.bonus ? t('{base} + {bonus} (modifications) = {total}, compté dans l’armure totale', { base: a.rating, bonus: am.bonus, total: (Number(a.rating) || 0) + am.bonus }) : ''}>
              {a.stack ? '+' : ''}{a.rating}{am.bonus ? <small className="cyan"> +{am.bonus}</small> : null}
            </span>
          </div>;
        })}
      </div>
      : <div className="muted small">{t('Aucune armure.')}</div>}
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
              {a.rating ? ` (${t('indice {n}', { n: a.rating })})` : ''}{' '}
              <ItemRef item={a} />
              {a.grade && a.grade !== 'standard' ? <>{' '}<span className="badge">{gradeLabel(a.grade)}</span></> : null}{a.choice ? <>{' '}<span className="faint small">{t('Choix : {choice}', { choice: a.choice })}</span></> : null}
              <ItemEffects mods={s.mods} list="augmentations" itemId={a.id} />
              {a.notes ? <div className="faint small">{a.notes}</div> : null}
            </div>
            <span className="mono">{t('{v} ESS', { v: fmtNum(Math.round((Number(a.essence) || 0) * 1000) / 1000) })}</span>
          </div>
        )}
      </div>
      : <div className="muted small">{t('Aucune augmentation.')}</div>}
    <h4 className="section-title">{t('Équipement')}</h4>
    {gear.length
      ? <div className="sh-list">
        {gear.map(
          (g) => <div className={'sh-list-row' + (g.active ? ' on' : '')} key={g.id}>
            {gearHasEffects(g, s.lookup) ? (own ? <Toggle value={!!g.active} onChange={(v) => upItem('gear', g.id, { active: v })} title={t('Porté / activé : ses effets comptent dans les jets')} /> : <span className={'badge ' + (g.active ? 'badge-cyan' : '')}>{g.active ? t('actif') : t('inactif')}</span>) : null}
            <div className="grow">
              <b title={itemTitle(g)}>{itemLabel(g)}</b>
              {g.rating ? ` (${t('indice {n}', { n: g.rating })})` : ''}{' '}
              <ItemRef item={g} />
              {' '}
              <span className="faint small">{categoryLabel(g)}</span>
              <PlaceBadge actor={actor} it={g} />
              {gearHasEffects(g, s.lookup) ? <ItemEffects mods={g.active ? s.mods : collectMods({ gear: [{ ...g, active: true }] }, s.lookup)} list="gear" itemId={g.id} /> : null}
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
      : <div className="muted small">{t('Aucun équipement.')}</div>}
    {vehicles.length > 0 && <>
      <h4 className="section-title">{t('Véhicules & drones')}</h4>
      <div className="sh-cards">
        {vehicles.map(
        (v) => <div className="sh-card" key={v.id}>
          <span><b title={itemTitle(v)}>{itemLabel(v)}</b>{' '}<ItemRef item={v} /></span>
          <div className="sh-vstats">
            {[[tk('Maniab.'), v.handling], [tk('Vitesse'), v.speed], [tk('Accél.'), v.accel], [tk('Struct.'), v.body], [tk('Blind.'), v.armor], [tk('Autopilote'), v.pilot], [tk('Senseurs'), v.sensor], [tk('Places'), v.seats]].map(([l, x]) => <span key={l}><span className="faint">{t(l)}</span>{' '}<b>{x ?? '—'}</b></span>)}
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
  if (!list.length) return <div className="muted small">{t('Aucun mode de vie.')}</div>;
  return <div className="sh-cards">
    {list.map((l) => <div className={'sh-card sh-lifestyle' + (l.primary ? ' primary' : '')} key={l.id}>
      <div className="row spread wrap sh-lifestyle-head">
        <span className="sh-lifestyle-name"><b>{l.name || lifestyleBaseLabel(l.base)}</b>{' '}<ItemRef item={l} /></span>
        <span className="row gap-s">
          {l.primary ? <span className="badge badge-amber">{t('principal')}</span> : null}
          <span className="badge badge-cyan">{lifestyleBaseLabel(l.base)}</span>
        </span>
      </div>
      <div className="row wrap gap-s">
        <span className="mono">{t('{cost}/mois', { cost: fmtNuyen(l.monthlyCost || 0) })}</span>
        {(l.qualities || []).length > 0 && <span className="faint small" title={t('Coût de base, options en % du coût de base, options à prix fixe')}>({lifestyleBreakdown(l)})</span>}{showPaid ? <span className="muted small">· {t('{n} mois payé(s)', { n: l.monthsPaid || 0 })}</span> : null}
      </div>
      {l.points && <div className="faint small">
      {t('Confort {c} · Sécurité {s} · Quartier {n}', { c: l.points.comforts ?? '—', s: l.points.security ?? '—', n: l.points.neighborhood ?? '—' })}
    </div>}
      <SubChips sub="qualities" items={l.qualities} />
      {l.notes && <div className="faint small">{l.notes}</div>}{showPaid && game ? <div><HomeButton game={game} actor={actor} lifestyle={l} canMove={showPaid} /></div> : null}
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
      <h4 className="section-title">{t('SIN & licences')}</h4>
      <ListEditor actor={actor} list="sins" />
      <h4 className="section-title">{t('Modes de vie')}</h4>
      <ListEditor actor={actor} list="lifestyles" />
    </div>;
  }
  return <div>
    <h4 className="section-title">{t('Contacts')}{' '}<RuleRef rule="contacts" /></h4>
    <ContactCards game={s.game} actor={actor} gm={gm} own={own} />
    <h4 className="section-title">{t('SIN & licences')}{' '}<RuleRef rule="fakeSin" /></h4>
    <SinCards actor={actor} gm={gm} own={own} />
    {(actor.lifestyles || []).length > 0 && <>
      <h4 className="section-title">{t('Modes de vie')}{' '}<RuleRef rule="lifestyles" /></h4>
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
              {q.choice ? <>{' '}<span className="faint small">{t('Choix : {choice}', { choice: q.choice })}</span></> : null}
              <ItemEffects mods={mods} list="qualities" itemId={q.id} />
              {q.notes ? <div className="faint small">{q.notes}</div> : null}
            </div>
            <span className={'mono ' + color}>{signed(q.karma || 0)}</span>
          </div>
        )}
      </div>
      : <div className="muted small">{t('Aucune.')}</div>}
  </section>;
  return <div className="grid-2">{col(t('Qualités positives'), pos, 'green')}{col(t('Qualités négatives'), neg, 'red')}</div>;
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
      {canEdit && <Button small variant="ghost" onClick={() => setEditing(!editing)}>{editing ? t('Aperçu') : t('Modifier')}</Button>}
    </div>
    {editing
      ? <>
        <TextInput multiline rows={10} value={value || ''} placeholder={placeholder} onChange={onSave} />
        <div className="faint small">{t('Markdown : **gras**, *italique*, listes « - », titres « ## ». Enregistré en quittant le champ.')}</div>
      </>
      : value
        ? <Markdown text={value} />
        : <div className="muted small">{canEdit ? t('Vide — clique « Modifier ».') : t('Rien pour l’instant.')}</div>}
  </section>;
}

export function NotesTab({ s }: { s: SheetCtx }) {
  const { actor, own, gm } = s;
  return <div className="col gap-l">
    {(own || actor.notes !== undefined) && <MdField title={gm ? t('Notes (joueur + MJ)') : t('Mes notes')} value={actor.notes} canEdit={own} onSave={(v) => s.update({ notes: v })} placeholder={t('Pistes, noms, dettes, plans…')} />}
    <MdField title={t('Biographie')} value={actor.bio} canEdit={own} onSave={(v) => s.update({ bio: v })} placeholder={t('Passé, apparence, motivations…')} />
    {gm && <MdField title={t('Notes du MJ (secrètes)')} accent="magenta" value={actor.gmNotes} canEdit={true} onSave={(v) => s.update({ gmNotes: v })} placeholder={t('Secrets, accroches, faiblesses à exploiter…')} />}
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
      <span className="field-label">{t('Nuyens')}</span>
      <NumberInput small value={ny} min={-10000000} max={10000000} step={100} onChange={setNy} />
    </div>
    <label className="field grow">
      <span className="field-label">{t('Raison')}</span>
      <TextInput live value={reason} placeholder={t('Récompense de run, dette, achat hors boutique…')} onChange={setReason} />
    </label>
    <Button variant="primary" disabled={!karma && !ny} onClick={go}>{t('Appliquer')}</Button>
  </div>;
}

export function HistoryTab({ s }: { s: SheetCtx }) {
  const { actor, gm, edit } = s;
  const h = [...(actor.history || [])].reverse();
  const totK = (actor.history || []).reduce((sum, e) => sum + (e.karma || 0), 0);
  const totN = (actor.history || []).reduce((sum, e) => sum + (e.nuyen || 0), 0);
  return <div>
    <div className="sh-derived">
      <RollStat label={t('Karma disponible')} value={actor.karma} accent="amber" />
      <RollStat label={t('Karma de carrière')} value={actor.karmaTotal} />
      <RollStat label={t('Nuyens')} value={fmtNuyen(actor.nuyen)} accent="cyan" />
      {edit && <>
        <div className="field">
          <span className="field-label">{t('Karma (direct)')}</span>
          <NumberInput small value={actor.karma} min={-999} max={99999} onChange={(v) => s.update({ karma: v })} />
        </div>
        <div className="field">
          <span className="field-label">{t('Carrière')}</span>
          <NumberInput small value={actor.karmaTotal} min={0} max={99999} onChange={(v) => s.update({ karmaTotal: v })} />
        </div>
        <div className="field">
          <span className="field-label">{t('Nuyens (direct)')}</span>
          <NumberInput small value={actor.nuyen} min={0} max={1e9} step={100} onChange={(v) => s.update({ nuyen: v })} />
        </div>
      </>}
    </div>
    {gm && <><h4 className="section-title">{t('Ajustement (consigné dans l’historique)')}</h4><AdjustForm actor={actor} /></>}
    <h4 className="section-title">{t('Registre')}</h4>
    {h.length
      ? <div className="sh-table-wrap">
        <table className="sr">
          <thead>
            <tr><th>{t('Date')}</th><th>{t('Opération')}</th><th className="right">{t('Karma')}</th><th className="right">{t('Nuyens')}</th></tr>
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
              <td className="muted small">{t('Total des mouvements')}</td>
              <td className="num-cell">{signed(totK)}</td>
              <td className="num-cell">{fmtNuyen(totN)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      : <div className="muted small">{t('Aucune opération.')}</div>}
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
        <span className="field-label">{t('Indice de professionnalisme')}</span>
        <NumberInput small value={npc.professionalRating || 0} min={0} max={7} onChange={(v) => setN({ professionalRating: v })} />
      </div>
      <Toggle value={!!npc.grunt} onChange={(v) => setN({ grunt: v })} label={t('Sbire (moniteur de groupe)')} />
      <Toggle value={!!actor.hidden} onChange={(v) => s.update({ hidden: v })} label={t('Caché aux joueurs')} />
      <label className="field">
        <span className="field-label">{t('Type')}</span>
        <Select value={actor.type} options={[{ value: 'npc', label: t('PNJ') }, { value: 'pc', label: t('PJ') }]} onChange={(v) => s.update({ type: v })} />
      </label>
      {tpl ? <span className="badge badge-amber">{t('Modèle : {name}', { name: tpl.name })}</span> : actor.templateId ? <span className="badge">{t('Modèle {id}', { id: actor.templateId })}</span> : null}
    </div>
    <MdField title={t('Tactiques')} accent="magenta" value={npc.tactics} canEdit={true} onSave={(v) => setN({ tactics: v })} placeholder={t('Comportement en combat, réactions, moral…')} />
    <MdField title={t('Butin')} value={npc.loot} canEdit={true} onSave={(v) => setN({ loot: v })} placeholder={t('Ce que les runners trouvent sur le corps…')} />
  </div>;
}
