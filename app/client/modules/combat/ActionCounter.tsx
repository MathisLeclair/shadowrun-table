// Action counter of a tracker entry (SR5 p. 163): what it used this Initiative Pass, what is left, and a menu to count an
// action by hand. Attacks, reloads and Matrix actions are counted by the server (server/lib/combat-actions.ts).
import type { ChangeEvent } from 'react';
import { send } from '../../lib/net.ts';
import { promptText } from '../../lib/ui.tsx';
import { t, tk } from '../../lib/i18n.ts';
import { PHASE_ACTIONS, PHASE_ACTION_TYPES, phaseUsage, phaseLeft, PHASE_LIMITS } from '../../../shared/combat.ts';
import type { CombatEntry, PhaseActionType, SpentAction } from '../../../shared/types.ts';

/** One-letter tag of each category (« G » Gratuite in French). */
const TYPE_ABBR: Record<PhaseActionType, string> = { free: tk('abbr::F'), simple: tk('abbr::S'), complex: tk('abbr::C'), interrupt: tk('abbr::I') };
const MENU_TYPES = ['free', 'simple', 'complex'] as const;

const labelOf = (a: SpentAction): string => (typeof a.label === 'string' ? a.label : t(a.label.t, a.label.params));

/** Pips: 2 slots (Simple = 1, Complex = 2) and the Free Action. */
function Pips({ spent }: { spent: SpentAction[] }) {
  const u = phaseUsage(spent);
  const left = phaseLeft(u);
  const title = [
    t('Simple / Complex: {n} of {max} used', { n: Math.min(u.slots, PHASE_LIMITS.slots), max: PHASE_LIMITS.slots }),
    t('Free: {n} of {max} used', { n: Math.min(u.free, PHASE_LIMITS.free), max: PHASE_LIMITS.free }),
    left.simple ? (left.complex ? t('Left: 2 Simple or 1 Complex') : t('Left: 1 Simple')) : t('No Simple or Complex Action left'),
  ].join('\n');
  const slots = Array.from({ length: PHASE_LIMITS.slots }, (_, i) => i < u.slots);
  return (
    <span className="cbt-pips" title={title}>
      {slots.map((on, i) => (
        <i key={'s' + i} className={'cbt-pip' + (on ? ' on' : '') + (u.slots > PHASE_LIMITS.slots ? ' over' : '')} />
      ))}
      <i className={'cbt-pip free' + (u.free ? ' on' : '') + (u.free > PHASE_LIMITS.free ? ' over' : '')} />
    </span>
  );
}

/** Native select with groups: « + Action… », then the common actions of each category and « Other … ». */
function ActionMenu({ e }: { e: CombatEntry }) {
  const onChange = async (ev: ChangeEvent<HTMLSelectElement>) => {
    const v = ev.target.value;
    ev.target.value = '';
    if (!v) return;
    const [kind, id] = v.split(':');
    if (kind === 'id') return send('combat/spend', { entryId: e.id, actionId: id }).catch(() => {});
    const type = id as PhaseActionType;
    const label = await promptText(t('What does {name} do? ({type})', { name: e.name, type: t(PHASE_ACTION_TYPES[type]) }), '');
    if (label === null || label === undefined) return;
    send('combat/spend', { entryId: e.id, type, label: String(label).trim() }).catch(() => {});
  };
  return (
    <select className="input cbt-actmenu" value="" onChange={onChange} onClick={(ev) => ev.stopPropagation()} title={t('Count an action of this pass')}>
      <option value="">{t('+ Action…')}</option>
      {MENU_TYPES.map((type) => (
        <optgroup key={type} label={t(PHASE_ACTION_TYPES[type])}>
          {PHASE_ACTIONS.filter((a) => a.type === type)
            .map((a) => ({ id: a.id, name: t(a.name), ref: `${a.source} ${a.page}` }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((a) => (
              <option key={a.id} value={'id:' + a.id} title={a.ref}>
                {a.name}
              </option>
            ))}
          <option value={'other:' + type}>{t('Other…')}</option>
        </optgroup>
      ))}
    </select>
  );
}

interface ActionCounterProps {
  e: CombatEntry;
  /** Owner or GM: may count / take back actions. */
  canControl: boolean;
  /** Show the « + Action » menu. */
  menu?: boolean;
}
/** The counter line: pips, the actions taken (click one to take it back), the menu. */
export default function ActionCounter({ e, canControl, menu = false }: ActionCounterProps) {
  const spent = e.spent || [];
  const undo = (a: SpentAction) => send('combat/unspend', { entryId: e.id, actionId: a.id }).catch(() => {});
  return (
    <div className="cbt-acts" onClick={(ev) => ev.stopPropagation()}>
      <Pips spent={spent} />
      {spent.map((a) => {
        const title = [
          t(PHASE_ACTION_TYPES[a.type]) + (a.cost ? ` (−${a.cost})` : ''),
          a.over ? t('Over what an Action Phase allows (1 Free + 2 Simple or 1 Complex, one attack)') : '',
          canControl ? t('(click: take it back)') : '',
        ].filter(Boolean).join('\n');
        const cls = 'cbt-act t-' + a.type + (a.over ? ' over' : '');
        const body = (
          <>
            <b>{t(TYPE_ABBR[a.type])}</b>
            {labelOf(a)}
            {a.cost ? <span className="mono"> −{a.cost}</span> : null}
          </>
        );
        return canControl ? (
          <button key={a.id} type="button" className={cls} title={title} onClick={() => undo(a)}>
            {body}
          </button>
        ) : (
          <span key={a.id} className={cls} title={title}>
            {body}
          </span>
        );
      })}
      {menu && canControl && <ActionMenu e={e} />}
    </div>
  );
}
