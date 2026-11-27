// Sheet tab « Résumé »: attributes, derived values, condition monitors, Edge.
import { useState } from 'react';
import { Button, NumberInput, Toggle, Badge } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { attr, type LimitKey } from '/shared/sr5.ts';
import { t, tk, attrLabel, attrShort } from '../../lib/i18n.ts';
import { ConditionTrack, EdgePips, actorStatus, statusColor, statusLabel, fmtNum, tRich } from './common.tsx';
import { limitValueText, limitTitle, sourcesTitle } from './modifiers-ui.tsx';
import { ruleRef } from '/shared/bookrefs.ts';
import type { ReactNode } from 'react';
import type { SheetCtx } from './types.ts';
import type { SourceLine } from './modifiers-ui.tsx';
import { BookRef, RuleRef } from '../books/BookRef.tsx';

const BASE_ATTRS: string[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];

interface RollStatProps {
  label: ReactNode;
  value: ReactNode;
  onClick?: () => void;
  title?: string;
  accent?: string | null;
  sub?: ReactNode;
  /** { source, page } of the rule. */
  book?: { source: string; page?: number | null } | null;
}
/**
 * Clickable stat box that opens a roll. `book` = rulebook reference of the rule ({ source, page }: ruleRef('limits'),
 * skillRef('hacking')…): a 📖 chip in the box's corner (outside the button: no nested buttons).
 */
export function RollStat({ label, value, onClick, title, accent, sub, book }: RollStatProps) {
  const cls = 'stat sh-stat' + (accent ? ` stat-${accent}` : '') + (onClick ? ' sh-clickable' : '') + (book ? ' sh-has-book' : '');
  const inner = <><span className="stat-value">{value}</span><span className="stat-label">{label}</span>{sub ? <span className="sh-stat-sub">{sub}</span> : null}</>;
  const box = onClick
    ? <button type="button" className={cls} title={title || t('Lancer : {label}', { label })} onClick={onClick}>{inner}</button>
    : <div className={cls} title={title}>{inner}</div>;
  return book ? <div className="sh-stat-wrap">{box}<BookRef source={book.source} page={book.page} className="sh-stat-book" /></div> : box;
}

function AttrCell({ s, k }: { s: SheetCtx; k: string }) {
  const { actor, edit, dm } = s;
  const base = Number((actor.attributes as unknown as Record<string, number | undefined>)[k] ?? 0);
  const eff: number = attr(actor, k);
  const aug = eff - base;
  if (edit) {
    return <div className="sh-attr editing">
      <span className="sh-attr-key" title={attrLabel(k)}>{attrShort(k)}</span>
      <NumberInput small value={base} min={0} max={15} onChange={(v) => s.update({ attributes: { [k]: v } })} />
      {k !== 'EDG' && k !== 'MAG' && k !== 'RES'
        ? <label className="sh-attr-aug" title={t('Bonus d’augmentation (max +4)')}>
          {t('aug.')}
          <NumberInput small value={Number((actor.augmented as Record<string, number> | undefined)?.[k] ?? 0)} min={0} max={4} onChange={(v) => s.update({ augmented: { [k]: v } })} />
        </label>
        : null}
    </div>;
  }
  const augTitle = sourcesTitle(dm?.sources?.[`attr.${k}`], t('{attr} — lancer un test d’attribut', { attr: attrLabel(k) }));
  return <button type="button" className={'sh-attr' + (aug ? ' augmented' : '')} title={augTitle || t('{attr} — lancer un test d’attribut', { attr: attrLabel(k) })} onClick={() => s.roll({ attr: k })}>
    <span className="sh-attr-key">{attrShort(k)}</span>
    <span className="sh-attr-val">{eff}</span>
    <span className="sh-attr-base">{aug ? t('base {base} +{aug}', { base, aug }) : attrLabel(k)}</span>
  </button>;
}

/** A limit with its modifiers: « 9 (11 si visible) », tooltip = sources. */
export function LimitStat({ s, name, label }: { s: SheetCtx; name: LimitKey; label: ReactNode }) {
  const { d, dm } = s;
  return <RollStat label={label} value={limitValueText(dm, name)} title={limitTitle(d, dm, name)} accent={dm.limitsAlt?.[name] !== undefined ? 'amber' : null} book={ruleRef('limits')} />;
}

function QuickDamage({ s }: { s: SheetCtx }) {
  const [amount, setAmount] = useState(1);
  const id = s.actor.id;
  const dmg = (type: string) => send('actor/damage', { actorId: id, amount, type }).catch(() => {});
  return <div className="sh-quickdmg row wrap">
    <NumberInput small value={amount} min={1} max={30} onChange={setAmount} />
    <Button small variant="danger" onClick={() => dmg('P')} title={t('Ajoute des dommages physiques')}>{t('Physiques')}</Button>
    <Button small onClick={() => dmg('S')} title={t('Ajoute des dommages étourdissants (le surplus passe en physique)')}>{t('Étourdissants')}</Button>
    <Button small variant="ghost" onClick={() => send('actor/heal', { actorId: id, amount, type: 'S' }).catch(() => {})} title={t('Soigne des cases étourdissantes')}>
      {t('Soigner É')}
    </Button>
    <Button small variant="ghost" onClick={() => send('actor/heal', { actorId: id, amount, type: 'P' }).catch(() => {})} title={t('Soigne des cases physiques (surplus d’abord)')}>
      {t('Soigner P')}
    </Button>
  </div>;
}

export function SummaryTab({ s }: { s: SheetCtx }) {
  const { actor, d, dm, edit, own } = s;
  const attrs = [...BASE_ATTRS];
  if (actor.attributes.MAG !== undefined && actor.attributes.MAG !== null) attrs.push('MAG');
  if (actor.attributes.RES !== undefined && actor.attributes.RES !== null) attrs.push('RES');
  const c = actor.condition || {};
  const status = actorStatus(actor);
  const setCond = (k: string) => (v: number) => s.update({ condition: { [k]: v } });
  const vision = actor.vision || {};
  return <div className="sh-summary">
    <section>
      <div className="sh-sec-head">
        <h4 className="section-title">{t('Attributs')}</h4>
        {edit && <div className="row wrap">
          {!attrs.includes('MAG') && <Button small onClick={() => s.update({ attributes: { MAG: 1 } })}>{t('+ Magie')}</Button>}{attrs.includes('MAG') && <Button small variant="ghost" onClick={() => s.update({ attributes: { MAG: null } })}>{t('− Magie')}</Button>}{!attrs.includes('RES') && <Button small onClick={() => s.update({ attributes: { RES: 1 } })}>{t('+ Résonance')}</Button>}{attrs.includes('RES') && <Button small variant="ghost" onClick={() => s.update({ attributes: { RES: null } })}>{t('− Résonance')}</Button>}
        </div>}
      </div>
      <div className="sh-attrs">
        {attrs.map((k) => <AttrCell s={s} k={k} key={k} />)}
        <div className={'sh-attr sh-ess' + (edit ? ' editing' : '')} title={t('Essence')}>
          <span className="sh-attr-key">{attrShort('ESS')}</span>
          {edit
            ? <NumberInput small value={actor.attributes.ESS} min={0} max={6} step={0.05} onChange={(v) => s.update({ attributes: { ESS: v } })} />
            : <><span className="sh-attr-val">{fmtNum(Math.round(d.essence * 100) / 100)}</span><span className="sh-attr-base">{t('Essence')}</span></>}
        </div>
      </div>
    </section>
    <section>
      <h4 className="section-title">{t('Valeurs dérivées')}{' '}<RuleRef rule="derived" /></h4>
      <div className="sh-derived">
        <RollStat label={t('Initiative')} value={d.initiative.text} accent="cyan" book={ruleRef('initiative')} title={sourcesTitle(dm.sources.initiative, d.woundModifier ? t('Blessures {n} au score', { n: d.woundModifier }) : `${attrLabel('REA')} + ${attrLabel('INT')}`) || (d.woundModifier ? t('Blessures {n} au score', { n: d.woundModifier }) : `${attrLabel('REA')} + ${attrLabel('INT')}`)} />
        {attrs.includes('MAG') && <RollStat label={t('Init. astrale')} value={`${d.astralInitiative.base} + 2D6`} book={ruleRef('initiative')} />}{actor.matrix && <RollStat label={t('Init. RV chaude')} book={ruleRef('matrixInitiative')} value={`${dm.matrixInitiative.hot.base} + ${dm.matrixInitiative.hot.dice}D6`} title={t('RA : {ar} · RV froide : {cold} + {dice}D6', { ar: d.initiative.text, cold: dm.matrixInitiative.cold.base, dice: dm.matrixInitiative.cold.dice }) + (dm.sources.matrixInitiative ? '\n' + sourcesTitle(dm.sources.matrixInitiative) : '')} />}
        <LimitStat s={s} name="physical" label={t('Limite physique')} />
        <LimitStat s={s} name="mental" label={t('Limite mentale')} />
        <LimitStat s={s} name="social" label={t('Limite sociale')} />
        {d.limits.astral ? <LimitStat s={s} name="astral" label={t('Limite astrale')} /> : null}
        <RollStat label={t('Défense')} value={dm.defense} sub={`${attrShort('REA')} + ${attrShort('INT')}`} book={ruleRef('defense')} title={sourcesTitle(dm.sources.defense)} onClick={() => s.roll({ attr: 'REA', attr2: 'INT', label: tk('Défense'), test: 'defense' })} />
        <RollStat label={t('Encaissement')} value={dm.soak} sub={t('{attr} + armure', { attr: attrShort('BOD') })} book={ruleRef('soak')} title={sourcesTitle([...(dm.sources.armor || []), ...(dm.sources.soak || [])])} onClick={() => s.roll({ attr: 'BOD', label: tk('Encaissement'), applyWounds: false, limit: null, test: 'soak' })} />
        <RollStat label={t('Armure')} value={dm.armor} book={ruleRef('armor')} title={sourcesTitle(dm.sources.armor, t('Armures portées : {n}', { n: d.armor }))} />
        <RollStat label={t('Sang-froid')} value={dm.composure} book={ruleRef('attributeTests')} sub={`${attrShort('CHA')} + ${attrShort('WIL')}`} title={sourcesTitle(dm.sources.composure)} onClick={() => s.roll({ attr: 'CHA', attr2: 'WIL', label: tk('Sang-froid'), test: 'composure' })} />
        <RollStat label={t('Jauger intentions')} value={dm.judgeIntentions} book={ruleRef('attributeTests')} sub={`${attrShort('CHA')} + ${attrShort('INT')}`} title={sourcesTitle(dm.sources.judgeIntentions)} onClick={() => s.roll({ attr: 'CHA', attr2: 'INT', label: tk('Jauger les intentions'), test: 'judgeIntentions' })} />
        <RollStat label={t('Mémoire')} value={dm.memory} book={ruleRef('attributeTests')} sub={`${attrShort('LOG')} + ${attrShort('WIL')}`} title={sourcesTitle(dm.sources.memory)} onClick={() => s.roll({ attr: 'LOG', attr2: 'WIL', label: tk('Mémoire'), test: 'memory' })} />
        <RollStat label={t('Soulever / porter')} value={dm.liftCarry} book={ruleRef('attributeTests')} sub={`${attrShort('BOD')} + ${attrShort('STR')}`} title={sourcesTitle(dm.sources.liftCarry)} onClick={() => s.roll({ attr: 'BOD', attr2: 'STR', label: tk('Soulever / porter'), test: 'liftCarry' })} />
        <RollStat label={t('Déplacement')} value={`${d.movement.walk}/${d.movement.run} m`} title={t('Marche / course par tour')} book={ruleRef('movement')} />
      </div>
      {(vision.lowLight || vision.thermo || vision.darkRange) && <div className="row wrap sh-vision">
        {vision.lowLight && <Badge color="cyan">{t('Vision nocturne')}</Badge>}{vision.thermo && <Badge color="magenta">{t('Vision thermographique')}</Badge>}{vision.darkRange ? <Badge>{t('Vision dans le noir : {n} cases', { n: vision.darkRange })}</Badge> : null}
      </div>}
      {edit && <div className="sh-edit-row row wrap">
        <div className="field">
          <span className="field-label">{t('Dés d’initiative')}</span>
          <NumberInput small value={actor.initiative?.dice ?? 1} min={1} max={5} onChange={(v) => s.update({ initiative: { dice: v } })} />
        </div>
        <div className="field">
          <span className="field-label">{t('Bonus d’initiative')}</span>
          <NumberInput small value={actor.initiative?.bonus ?? 0} min={-10} max={20} onChange={(v) => s.update({ initiative: { bonus: v } })} />
        </div>
        <div className="field">
          <span className="field-label">{t('Moniteur physique (forcé)')}</span>
          <NumberInput small value={actor.monitors?.physical ?? 0} min={0} max={40} onChange={(v) => s.update({ monitors: { physical: v || null } })} />
        </div>
        <div className="field">
          <span className="field-label">{t('Moniteur étourdi (forcé)')}</span>
          <NumberInput small value={actor.monitors?.stun ?? 0} min={0} max={40} onChange={(v) => s.update({ monitors: { stun: v || null } })} />
        </div>
        <Toggle value={!!vision.lowLight} onChange={(v) => s.update({ vision: { lowLight: v } })} label={t('Vision nocturne')} />
        <Toggle value={!!vision.thermo} onChange={(v) => s.update({ vision: { thermo: v } })} label={t('Thermographique')} />
        <div className="field">
          <span className="field-label">{t('Vision noir (cases)')}</span>
          <NumberInput small value={vision.darkRange ?? 0} min={0} max={50} onChange={(v) => s.update({ vision: { darkRange: v } })} />
        </div>
      </div>}
    </section>
    <section>
      <div className="sh-sec-head">
        <h4 className="section-title">{t('Moniteurs de condition')}{' '}<RuleRef rule="conditionMonitor" /></h4>
        <div className="row wrap">
          <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>
          {dm.woundModifier ? <Badge color="red" title={t('Malus de blessures à tous les tests et à l’initiative') + (dm.sources.woundModifier ? '\n' + sourcesTitle(dm.sources.woundModifier) : '')}>
            {t('Blessures {n}', { n: dm.woundModifier })}
          </Badge> : null}
        </div>
      </div>
      <div className="sh-tracks">
        <ConditionTrack label={t('Physique')} kind="physical" max={dm.physicalMonitor} value={c.physical || 0} readOnly={!own} onSet={setCond('physical')} />
        <ConditionTrack label={t('Étourdissant')} kind="stun" max={dm.stunMonitor} value={c.stun || 0} readOnly={!own} onSet={setCond('stun')} />
        <ConditionTrack label={t('Surplus')} kind="overflow" max={dm.overflowMax} value={Math.min(c.overflow || 0, dm.overflowMax)} wounds={false} readOnly={!own} onSet={setCond('overflow')} />
      </div>
      {['physicalMonitor', 'stunMonitor', 'overflowMax'].some((k) => dm.sources[k]) && <div className="faint small" title={sourcesTitle(['physicalMonitor', 'stunMonitor', 'overflowMax'].flatMap((k) => dm.sources[k] || []))}>
        {t('Moniteurs modifiés par l’équipement / les qualités (survol pour le détail).')}
      </div>}
      {(c.overflow || 0) > dm.overflowMax && <div className="error small">{t('Le surplus dépasse la Constitution : {name} est mort·e.', { name: actor.name })}</div>}{own && <QuickDamage s={s} />}
    </section>
    <section>
      <div className="sh-sec-head">
        <h4 className="section-title">{t('Chance')}{' '}<RuleRef rule="edge" /></h4>
        <div className="row wrap">
          <EdgePips actor={actor} canUse={own} size="lg" />
          <span className="mono">{actor.edge?.current ?? 0}/{attr(actor, 'EDG')}</span>
          {own && <>
            <Button small variant="accent" disabled={!(actor.edge?.current > 0)} onClick={() => send('edge/spend', { actorId: actor.id }).catch(() => {})}>
              {t('Dépenser 1')}
            </Button>
            <Button small variant="ghost" onClick={() => send('edge/refresh', { actorId: actor.id }).catch(() => {})}>{t('Recharger')}</Button>
          </>}
        </div>
      </div>
      <div className="muted small">
        {tRich(t('Avant un jet : {push} (+Chance en dés, règle des 6, sans limite). Après : {second} (relance des échecs) depuis le résultat du jet.'), { push: <b>{t('Repousser les limites')}</b>, second: <b>{t('Seconde chance')}</b> })}
      </div>
    </section>
  </div>;
}
