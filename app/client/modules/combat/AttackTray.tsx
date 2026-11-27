// Attack tray (global, every user): attacks waiting for me (defend / resist damage), my attacks in progress, the latest results,
// GM shortcuts (auto-resolve an NPC's defense + soak, settle by hand, cancel). Dialogs: DefenseDialog, SoakDialog.
// Server: server/modules/33-attacks.js — rules: shared/combat.js.
import { useMemo, useState, useEffect } from 'react';
import { Button, IconButton, NumberInput, Toggle, promptText } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { openSheet } from '../../lib/ui-store.ts';
import { attr, derive } from '/shared/sr5.ts';
import { derivedWithModifiers } from '/shared/modifiers.ts';
import { t, tn, getLang } from '../../lib/i18n.ts';
import { useModifiers } from '../sheet/modifiers-ui.tsx';
import { DEFENSE_OPTIONS, DEFENSE_SITUATIONS, defenseLines, isUnlocked, unlockNames, finalDamageType, TOXIN_BY_ID, AFFLICTIONS } from '/shared/combat.ts';
import { ownsActorId, turnInfo, PENDING } from './attack-common.ts';
import type { Actor, Attack, BiName, GameView, RollRecord } from '../../../shared/types.ts';
import './combat.css';
import { Overlay, DiceFaces, RollBadges } from '../sheet/common.tsx';
import { BookRef } from '../books/BookRef.tsx';

/** isUnlocked() of shared/combat.js (its JS default `names = null` narrows the inferred type). */
const isUnlockedFor = isUnlocked as (def: unknown, actor: Actor, names?: Set<string> | null) => boolean;

const RECENT_MS = 25000;
const wName = (n: BiName | string | null | undefined): string => (!n ? '' : typeof n === 'string' ? n : (getLang() === 'en' ? n.en : n.fr) || n.fr || n.en || '');
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

/** Reply of attack/defend and attack/soak. */
interface RollReply {
  roll: RollRecord;
  attack: Attack;
}
type DialogState = { kind: 'defend' | 'soak'; attackId: string };

/** One-line description of an attack: « Garde 2 → Anthony · Ares Predator · 4 succès · VD 8P PA −1 ». */
function attackSummary(a: Attack): string {
  const bits: string[] = [];
  if (a.actionName) bits.push(t(a.actionName));
  if (a.weaponName) bits.push(wName(a.weaponName));
  if (a.kind === 'toxin') {
    bits.push(t('{toxin}, power {n}', { toxin: t((a.toxinId && TOXIN_BY_ID[a.toxinId]?.name) || ''), n: a.dv }));
    return bits.join(' · ');
  }
  if (a.kind === 'blast') bits.push(t('blast at {m} m', { m: a.meters }));
  else bits.push(tn(a.hits, 'one::{n} hit', 'other::{n} hits'));
  if (a.dv !== null && a.dv !== undefined) bits.push(t('DV {dv}{type}', { dv: a.modifiedDv ?? a.dv, type: a.type }) + (a.ap ? ` · ${t('AP {ap}', { ap: signed(a.ap) })}` : ''));
  else if (a.noDamage) bits.push(t('no damage'));
  return bits.join(' · ');
}

function outcomeText(a: Attack): string {
  if (a.status === 'cancelled') return t('cancelled');
  if (a.status === 'missed') return a.defenseHits !== undefined ? t('dodged ({a} vs {d})', { a: a.hits, d: a.defenseHits }) : t('missed');
  if (a.status === 'done' && a.kind === 'toxin') {
    if (!a.left) return t('toxin fully resisted');
    const fx = (a.effects || []).map((k) => t(AFFLICTIONS[k]?.name || k));
    const dmg = a.damage ? (a.damageType === 'P' ? tn(a.damage, '{n} physical box', '{n} physical boxes') : tn(a.damage, '{n} stun box', '{n} stun boxes')) : '';
    return [dmg, ...fx].filter(Boolean).join(' · ');
  }
  if (a.status === 'done') {
    if (a.noDamage || a.dv === null) return tn(a.net || 0, 'success: {n} net hit', 'success: {n} net hits');
    if (!a.damage) return t('fully resisted');
    return a.damageType === 'S' ? tn(a.damage, '{n} stun box', '{n} stun boxes') : tn(a.damage, '{n} physical box', '{n} physical boxes');
  }
  return '';
}

/** Full sheet of an actor (players get NPC stubs without attributes). */
const sheetOf = (game: GameView, id: string | null | undefined): Actor | null => {
  const a = id ? game.actors?.[id] : null;
  return a && 'attributes' in a && a.attributes ? a : null;
};

export default function AttackTray({ game }: GameProps) {
  const [dialog, setDialog] = useState<DialogState | null>(null); // { kind: 'defend'|'soak', attackId }
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [userCollapsed, setCollapsed] = useState<boolean | null>(null); // null = automatic: folded while nothing waits for me
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const gm = game.me?.role === 'gm';
  const mine = new Set<string | null>(game.me?.characterIds || []);
  const list = game.attacks?.list || [];
  const now = Date.now();
  const rows = useMemo(
    () =>
      list.filter((a) => {
        if (hidden.has(a.id)) return false;
        const involved = gm || mine.has(a.targetId) || mine.has(a.attackerId);
        if (!involved) return false;
        if (PENDING.has(a.status)) return true;
        return !!a.resolvedTs && now - a.resolvedTs < RECENT_MS;
      }),
    [list, hidden, gm, game.me, now]
  );
  const open = dialog ? list.find((a) => a.id === dialog.attackId) : null;
  if (!rows.length && !open) return null;
  const hide = (id: string) => setHidden(new Set([...hidden, id]));
  const toAct = rows.filter((a) => PENDING.has(a.status) && ownsActorId(game, a.targetId));
  const pendingCount = toAct.length;
  const collapsed = userCollapsed ?? !pendingCount;

  return (
    <div className="atk-tray">
      <div className="atk-tray-head">
        <span>
          ⚔ {t('Attacks')}
          {pendingCount ? (
            <>
              {' '}
              <span className="badge badge-red">{pendingCount}</span>
            </>
          ) : null}
        </span>
        <span className="row gap-s">
          {gm && (
            <Button small variant="ghost" onClick={() => send('attack/clear', {}).catch(() => {})} title={t('Clear resolved attacks and blasts from the map')}>
              {t('Clean up')}
            </Button>
          )}
          <IconButton icon={collapsed ? '▴' : '▾'} title={collapsed ? t('Expand') : t('Collapse')} onClick={() => setCollapsed(!collapsed)} />
        </span>
      </div>
      {!collapsed && (
        <div className="atk-tray-list">
          {rows.map((a) => {
            const canAct = PENDING.has(a.status) && ownsActorId(game, a.targetId);
            const isMineAtk = mine.has(a.attackerId) || gm;
            const target = a.targetName;
            return (
              <div className={'atk-card ' + a.status + (canAct ? ' act' : '')} key={a.id}>
                <div className="atk-card-title">
                  <b>{a.attackerName}</b> <span className="faint">→</span>{' '}
                  <b className="link" onClick={() => sheetOf(game, a.targetId) && openSheet(a.targetId)}>
                    {target}
                  </b>
                  {!PENDING.has(a.status) && <IconButton icon="✕" className="atk-x" title={t('Hide')} onClick={() => hide(a.id)} />}
                </div>
                <div className="small muted">{attackSummary(a)}</div>
                {PENDING.has(a.status) ? (
                  <div className="row wrap gap-s atk-card-actions">
                    {canAct && a.status === 'defense' && (
                      <Button small variant="primary" onClick={() => setDialog({ kind: 'defend', attackId: a.id })}>
                        🛡 {t('Defend')}
                      </Button>
                    )}
                    {canAct && a.status === 'soak' && (
                      <Button small variant="primary" onClick={() => setDialog({ kind: 'soak', attackId: a.id })}>
                        ✚ {a.kind === 'toxin' ? t('Resist the gas') : t('Resist damage')}
                      </Button>
                    )}
                    {!canAct && <span className="faint small">{a.status === 'defense' ? t('waiting for the defense…') : t('waiting for the damage resistance…')}</span>}
                    {gm && (
                      <Button small variant="ghost" onClick={() => send('attack/auto', { attackId: a.id }).catch(() => {})} title={t('Roll defense then damage resistance with no option')}>
                        ⚡ {t('Auto')}
                      </Button>
                    )}
                    {gm && (
                      <Button
                        small
                        variant="ghost"
                        onClick={async () => {
                          const v = await promptText(t('Damage to apply (e.g. 6P, 4S, 0 = miss)'), a.modifiedDv ? `${a.modifiedDv}${a.type}` : '');
                          if (v === null || v === undefined) return;
                          const m = String(v).trim().match(/^(\d+)\s*([PSps])?$/);
                          if (!m) return;
                          const n = Number(m[1]);
                          send('attack/resolve', n ? { attackId: a.id, outcome: 'damage', amount: n, type: (m[2] || a.type || 'P').toUpperCase() } : { attackId: a.id, outcome: 'missed' }).catch(() => {});
                        }}
                        title={t('Resolve by hand')}
                      >
                        ✎
                      </Button>
                    )}
                    {isMineAtk && (
                      <Button small variant="ghost" onClick={() => send('attack/cancel', { attackId: a.id }).catch(() => {})} title={t('Cancel this attack')}>
                        {t('Cancel')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className={'atk-outcome ' + (a.status === 'done' && a.damage ? 'hit' : '')}>{outcomeText(a)}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {open && dialog && dialog.kind === 'defend' && open.status === 'defense' && <DefenseDialog game={game} atk={open} onClose={() => setDialog(null)} />}
      {open && dialog && (dialog.kind === 'soak' || (dialog.kind === 'defend' && open.status !== 'defense')) && (
        <ResultOrSoak game={game} atk={open} dialog={dialog} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

interface DialogProps {
  game: GameView;
  atk: Attack;
  onClose: () => void;
}

/** After a defense: the result, then the soak dialog when the attack hit. */
function ResultOrSoak({ game, atk, onClose }: DialogProps & { dialog: DialogState }) {
  if (atk.status === 'soak') return <SoakDialog game={game} atk={atk} onClose={onClose} />;
  return (
    <Overlay title={t('Result — {target}', { target: atk.targetName })} onClose={onClose} width={420}>
      <div className="col gap-s">
        <div className={`atk-big ${atk.status === 'done' && atk.damage ? 'hit' : ''}`}>{outcomeText(atk)}</div>
        <div className="muted small">{attackSummary(atk)}</div>
        <div className="row spread">
          <span></span>
          <Button variant="primary" onClick={onClose}>
            {t('Close')}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

/** Edge toggle shared by the dialogs. */
function EdgeToggle({ actor, value, onChange, edgeMax }: { actor: Actor; value: boolean; onChange: (v: boolean) => void; edgeMax: number }) {
  if ((actor.edge?.current ?? 0) <= 0) return null;
  return <Toggle value={value} onChange={onChange} label={t('Push the Limit (+{n}) — Edge {left}', { n: edgeMax, left: actor.edge.current })} />;
}

/** Defense test: REA + INT, active defense (one), turn-long defenses, situation, previous defenses this turn, Edge. */
export function DefenseDialog({ game, atk, onClose }: DialogProps) {
  const actor = sheetOf(game, atk.targetId);
  const gm = game.me?.role === 'gm';
  const turn = turnInfo(game, atk.targetId);
  const [options, setOptions] = useState<Set<string>>(() => new Set());
  const [situations, setSituations] = useState<Set<string>>(() => new Set());
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RollReply | null>(null);
  if (!actor) {
    return (
      <Overlay title={t('Defense')} onClose={onClose} width={420}>
        <div className="muted">{t('Target sheet unavailable.')}</div>
      </Overlay>
    );
  }
  const names = unlockNames(actor);
  const melee = atk.kind === 'melee';
  const plan = defenseLines(actor, atk, { options: [...options], situations: [...situations], prior: turn.defended, turnBoosts: turn.boosts });
  let wound = 0;
  try {
    wound = derive(actor).woundModifier || 0;
  } catch {}
  const edgeMax: number = attr(actor, 'EDG');
  const base: number = attr(actor, 'REA') + attr(actor, 'INT');
  const total = Math.max(0, base + plan.lines.reduce((s: number, l: { value: number }) => s + l.value, 0) + modifier + wound + (explode ? edgeMax : 0));
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else {
      // one active defense at a time
      const o = DEFENSE_OPTIONS.find((x: { id: string }) => x.id === id);
      if (o && !o.turn) for (const x of DEFENSE_OPTIONS) if (!x.turn) next.delete(x.id);
      next.add(id);
    }
    setter(next);
  };
  const go = async () => {
    setBusy(true);
    try {
      const r = await send<RollReply>('attack/defend', { attackId: atk.id, options: [...options], situations: [...situations], modifier, explode });
      setResult(r);
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const visibleOptions = DEFENSE_OPTIONS.filter((o: { melee?: boolean }) => (!o.melee || melee) && (isUnlockedFor(o, actor, names) || gm));
  return (
    <Overlay title={t('Defense — {name}', { name: actor.name })} onClose={onClose} width={500}>
      <div className="col gap-s atk-dlg">
        <div className="atk-dlg-attack">
          <b>{atk.attackerName}</b> · {attackSummary(atk)}
        </div>
        {!result && (
          <>
            <div className="field-label">{t('Active defense (interrupt)')}</div>
            <div className="col gap-s">
              {visibleOptions.map((o: (typeof DEFENSE_OPTIONS)[number]) => {
                const paid = o.turn && turn.boosts.includes(o.id);
                const locked = !isUnlockedFor(o, actor, names);
                return (
                  <label className={'atk-opt' + (locked ? ' locked' : '')} key={o.id}>
                    <input type="checkbox" checked={options.has(o.id) || !!paid} disabled={!!paid || locked} onChange={() => toggle(options, setOptions, o.id)} />
                    <span className="grow">
                      {t(o.name)} <BookRef source={o.source} page={o.page} />
                    </span>
                    <span className="faint small">
                      {paid ? t('active this turn') : t('−{n} init.', { n: o.ini })}
                      {o.turn ? ` · ${t('whole turn')}` : ''}
                      {locked ? ` · ${t('not unlocked')}` : ''}
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="field-label">{t('Situation')}</div>
            <div className="row wrap gap-s">
              {DEFENSE_SITUATIONS.filter((s: { ranged?: boolean }) => !(s.ranged && melee)).map((s: (typeof DEFENSE_SITUATIONS)[number]) => (
                <button key={s.id} className={'chip' + (situations.has(s.id) ? ' on' : '')} onClick={() => toggle(situations, setSituations, s.id)}>
                  {t(s.name)} {signed(s.value)}
                </button>
              ))}
            </div>
            <div className="sh-rd-breakdown">
              <span className="sh-rd-part">
                <span>{t('REA + INT')}</span>
                <b>{base}</b>
              </span>
              {plan.lines.map((l: { key: string; label: string; value: number }) => (
                <span className={'sh-rd-part' + (l.value < 0 ? ' bad' : '')} key={l.key}>
                  <span>{t(l.label)}</span>
                  <b>{signed(l.value)}</b>
                </span>
              ))}
              {wound ? (
                <span className="sh-rd-part bad">
                  <span>{t('wounds')}</span>
                  <b>{wound}</b>
                </span>
              ) : null}
              {modifier ? (
                <span className="sh-rd-part">
                  <span>{t('mod.')}</span>
                  <b>{signed(modifier)}</b>
                </span>
              ) : null}
              {explode ? (
                <span className="sh-rd-part edge">
                  <span>{t('Edge')}</span>
                  <b>+{edgeMax}</b>
                </span>
              ) : null}
              <span className="sh-rd-total">{tn(total, '= {n} die', '= {n} dice')}</span>
            </div>
            <div className="faint small">
              {t('Gear and quality modifiers are added by the server.')}
              {plan.ini ? ' ' + t('Cost: {n} initiative.', { n: plan.ini }) : ''}
            </div>
            <div className="row wrap gap-s">
              <div className="field">
                <span className="field-label">{t('Edit')}</span>
                <NumberInput value={modifier} min={-20} max={20} onChange={setModifier} small />
              </div>
              <EdgeToggle actor={actor} value={explode} onChange={setExplode} edgeMax={edgeMax} />
            </div>
            <div className="row spread">
              <Button variant="ghost" onClick={onClose}>
                {t('Later')}
              </Button>
              <Button variant="primary" disabled={busy} onClick={go}>
                🛡 {tn(total, 'Defend ({n} die)', 'Defend ({n} dice)')}
              </Button>
            </div>
          </>
        )}
        {result && (
          <>
            <div className="sh-rd-result">
              <div className="sh-rd-hits">
                <b>{result.roll.hits}</b>
                <span>{tn(result.roll.hits, 'one::hit', 'other::hits')}</span>
              </div>
              <div className="grow col gap-s">
                <DiceFaces roll={result.roll} />
                <RollBadges roll={result.roll} />
              </div>
            </div>
            <div className={`atk-big ${result.attack.status === 'soak' ? 'hit' : ''}`}>
              {result.attack.status === 'soak'
                ? t('Hit: {net} net hit(s) → DV {dv}{type}', { net: result.attack.net, dv: result.attack.modifiedDv, type: result.attack.type })
                : outcomeText(result.attack)}
            </div>
            <div className="row spread">
              <span></span>
              {result.attack.status === 'soak' ? (
                <span className="faint small">{t('Damage resistance next…')}</span>
              ) : (
                <Button variant="primary" onClick={onClose}>
                  {t('Close')}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}

/** Dice result block + outcome + close button, shared by the soak dialogs. */
function SoakResult({ result, a, hit, onClose }: { result: RollReply; a: Attack; hit: boolean; onClose: () => void }) {
  return (
    <>
      <div className="sh-rd-result">
        <div className="sh-rd-hits">
          <b>{result.roll.hits}</b>
          <span>{tn(result.roll.hits, 'one::hit', 'other::hits')}</span>
        </div>
        <div className="grow col gap-s">
          <DiceFaces roll={result.roll} />
          <RollBadges roll={result.roll} />
        </div>
      </div>
      <div className={'atk-big' + (hit ? ' hit' : '')}>{outcomeText(a)}</div>
      <div className="row spread">
        <span></span>
        <Button variant="primary" onClick={onClose}>
          {t('Close')}
        </Button>
      </div>
    </>
  );
}

/** Damage resistance: BOD + armor modified by AP, Edge; the damage is applied by the server. */
/** Toxin Resistance Test (BOD + WIL) against a gas grenade: Power − hits = damage and effects (shared/combat.js toxinOutcome). */
function ToxinDialog({ actor, atk, onClose }: { actor: Actor; atk: Attack; onClose: () => void }) {
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RollReply | null>(null);
  const toxin = atk.toxinId ? TOXIN_BY_ID[atk.toxinId] : undefined;
  const edgeMax: number = attr(actor, 'EDG');
  const total = Math.max(0, attr(actor, 'BOD') + attr(actor, 'WIL') + modifier + (explode ? edgeMax : 0));
  const go = async () => {
    setBusy(true);
    try {
      setResult(await send<RollReply>('attack/soak', { attackId: atk.id, modifier, explode }));
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const a = result?.attack || atk;
  const fxText: Record<string, string> = {
    disorientation: t('disorientation (−2 dice)'),
    nausea: t('nausea (wound modifiers ×2, incapacitated if remaining Power > WIL)'),
    stun: t('lower::Stun damage'),
    physical: t('lower::Physical damage'),
  };
  const fx = ((toxin?.effects || []) as string[]).map((k) => fxText[k]);
  return (
    <Overlay title={t('Toxin resistance — {name}', { name: actor.name })} onClose={onClose} width={460}>
      <div className="col gap-s atk-dlg">
        <div className="atk-dlg-attack">
          <b>{atk.attackerName}</b> · {attackSummary(atk)} <BookRef source="SR5" page={toxin?.page || 409} />
        </div>
        <div className="atk-big hit">{t('Power {n}', { n: atk.dv })}</div>
        <div className="small muted">{t('Each hit reduces the Power; what remains: {fx}.', { fx: fx.join(', ') })}</div>
        {!result && (
          <>
            <div className="sh-rd-breakdown">
              <span className="sh-rd-part">
                <span>{t('BOD')}</span>
                <b>{attr(actor, 'BOD')}</b>
              </span>
              <span className="sh-rd-part">
                <span>{t('WIL')}</span>
                <b>+{attr(actor, 'WIL')}</b>
              </span>
              {modifier ? (
                <span className="sh-rd-part">
                  <span>{t('mod.')}</span>
                  <b>{signed(modifier)}</b>
                </span>
              ) : null}
              {explode ? (
                <span className="sh-rd-part edge">
                  <span>{t('Edge')}</span>
                  <b>+{edgeMax}</b>
                </span>
              ) : null}
              <span className="sh-rd-total">{tn(total, '= {n} die', '= {n} dice')}</span>
            </div>
            <div className="row wrap gap-s">
              <div className="field">
                <span className="field-label">{t('Edit')}</span>
                <NumberInput value={modifier} min={-20} max={20} onChange={setModifier} small />
              </div>
              <EdgeToggle actor={actor} value={explode} onChange={setExplode} edgeMax={edgeMax} />
            </div>
            <div className="row spread">
              <Button variant="ghost" onClick={onClose}>
                {t('Later')}
              </Button>
              <Button variant="primary" disabled={busy} onClick={go}>
                ✚ {tn(total, 'Resist ({n} die)', 'Resist ({n} dice)')}
              </Button>
            </div>
          </>
        )}
        {result && <SoakResult result={result} a={a} hit={!!a.left} onClose={onClose} />}
      </div>
    </Overlay>
  );
}

export function SoakDialog({ game, atk, onClose }: DialogProps) {
  const actor = sheetOf(game, atk.targetId);
  const mods = useModifiers(actor, {});
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RollReply | null>(null);
  if (!actor)
    return (
      <Overlay title={t('Soak')} onClose={onClose} width={420}>
        <div className="muted">{t('Target sheet unavailable.')}</div>
      </Overlay>
    );
  if (atk.kind === 'toxin') return <ToxinDialog actor={actor} atk={atk} onClose={onClose} />;
  let armor = 0;
  try {
    armor = derivedWithModifiers(actor, mods).armor || 0;
  } catch {}
  const ap = Number(atk.ap) || 0;
  const modArmor = Math.max(0, armor + ap);
  const dv = atk.modifiedDv ?? atk.dv ?? 0;
  const edgeMax: number = attr(actor, 'EDG');
  const total = Math.max(0, attr(actor, 'BOD') + modArmor + modifier + (explode ? edgeMax : 0));
  const type = finalDamageType(atk.type, dv, modArmor);
  const go = async () => {
    setBusy(true);
    try {
      setResult(await send<RollReply>('attack/soak', { attackId: atk.id, modifier, explode }));
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const a = result?.attack || atk;
  return (
    <Overlay title={t('Damage resistance — {name}', { name: actor.name })} onClose={onClose} width={460}>
      <div className="col gap-s atk-dlg">
        <div className="atk-dlg-attack">
          <b>{atk.attackerName}</b> · {attackSummary(atk)}
        </div>
        <div className="atk-big hit">
          {t('DV {dv}{type} to resist', { dv, type: atk.type })}
          {type !== atk.type ? (
            <>
              {' '}
              <span className="small muted">({t('stun: DV < modified armor')})</span>
            </>
          ) : null}
        </div>
        {!result && (
          <>
            <div className="sh-rd-breakdown">
              <span className="sh-rd-part">
                <span>{t('BOD')}</span>
                <b>{attr(actor, 'BOD')}</b>
              </span>
              <span className="sh-rd-part">
                <span>{t('armor')}</span>
                <b>+{armor}</b>
              </span>
              {ap ? (
                <span className={'sh-rd-part' + (ap < 0 ? ' bad' : '')}>
                  <span>{t('AP')}</span>
                  <b>{signed(Math.max(ap, -armor))}</b>
                </span>
              ) : null}
              {modifier ? (
                <span className="sh-rd-part">
                  <span>{t('mod.')}</span>
                  <b>{signed(modifier)}</b>
                </span>
              ) : null}
              {explode ? (
                <span className="sh-rd-part edge">
                  <span>{t('Edge')}</span>
                  <b>+{edgeMax}</b>
                </span>
              ) : null}
              <span className="sh-rd-total">{tn(total, '= {n} die', '= {n} dice')}</span>
            </div>
            <div className="row wrap gap-s">
              <div className="field">
                <span className="field-label">{t('Edit')}</span>
                <NumberInput value={modifier} min={-20} max={20} onChange={setModifier} small />
              </div>
              <EdgeToggle actor={actor} value={explode} onChange={setExplode} edgeMax={edgeMax} />
            </div>
            <div className="row spread">
              <Button variant="ghost" onClick={onClose}>
                {t('Later')}
              </Button>
              <Button variant="primary" disabled={busy} onClick={go}>
                ✚ {tn(total, 'Soak ({n} die)', 'Soak ({n} dice)')}
              </Button>
            </div>
          </>
        )}
        {result && <SoakResult result={result} a={a} hit={!!a.damage} onClose={onClose} />}
      </div>
    </Overlay>
  );
}
