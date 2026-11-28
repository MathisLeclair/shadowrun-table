// Attack tray dialogs for vehicles (33-attacks, shared/vehicles.ts): a vehicle's defense (driver REA + INT, evasive
// driving; a drone Pilot + Maneuvering [Handling]), its damage resistance (Body + Armor, nothing under the armor, no Stun),
// and the biofeedback a jumped-in rigger resists (WIL + Firewall, SR5 p. 229, 266).
import { useState } from 'react';
import { Button, NumberInput, Toggle } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t, tn, attrShort } from '../../lib/i18n.ts';
import { attr } from '/shared/sr5.ts';
import { controlOf, controlRigRating, previewDriverPool, vehicleDefensePlan, vehicleStats } from '/shared/vehicles.ts';
import { Overlay, DiceFaces, RollBadges } from '../sheet/common.tsx';
import { BookRef } from '../books/BookRef.tsx';
import type { Actor, Attack, GameView, Vehicle } from '../../../shared/types.ts';
import type { ShownRoll } from '../sheet/types.ts';

type Reply = { roll: ShownRoll | null; attack: Attack };
const sheet = (game: GameView, id: string | null | undefined): Actor | null => {
  const a = id ? game.actors?.[id] : null;
  return a && 'attributes' in a ? a : null;
};
function vehicleOf(game: GameView, atk: Attack): { owner: Actor; v: Vehicle; driver: Actor | null } | null {
  const owner = sheet(game, atk.targetId);
  const v = owner?.vehicles?.find((x) => x.id === atk.vehicle?.vehicleId);
  if (!owner || !v) return null;
  const driver = controlOf(v) === 'auto' ? null : sheet(game, v.driverId) || owner;
  return { owner, v, driver };
}
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function Outcome({ a }: { a: Attack }) {
  if (a.status === 'missed') return <div className="atk-big">{t('dodged ({a} vs {d})', { a: a.hits, d: a.defenseHits ?? 0 })}</div>;
  if (a.status === 'soak') return <div className="atk-big hit">{t('Hit: {net} net hit(s) → DV {dv}{type}', { net: a.net ?? 0, dv: a.modifiedDv ?? a.dv ?? 0, type: a.type })}</div>;
  if (a.status === 'done') return <div className={'atk-big' + (a.damage ? ' hit' : '')}>{a.damage ? tn(a.damage, '{n} box of damage', '{n} boxes of damage') : t('fully resisted')}</div>;
  return null;
}

/** Defense, then the soak, of an attack on a vehicle. */
export function VehicleAttackDialog({ game, atk, onClose }: { game: GameView; atk: Attack; onClose: () => void }) {
  const found = vehicleOf(game, atk);
  const [modifier, setModifier] = useState(0);
  const [evasive, setEvasive] = useState(false);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Reply | null>(null);
  const a = result?.attack || atk;
  if (!found) return <Overlay title={t('Vehicle')} onClose={onClose} width={420}><div className="muted">{t('Vehicle not found')}</div></Overlay>;
  const { v, driver } = found;
  const go = async (type: 'attack/defend' | 'attack/soak') => {
    setBusy(true);
    try {
      setResult(await send<Reply>(type, { attackId: atk.id, modifier, ...(type === 'attack/defend' ? { options: evasive ? ['evasive'] : [], explode: explode && !!driver } : {}) }));
      setModifier(0);
      setExplode(false);
    } catch {
    } finally {
      setBusy(false);
    }
  };
  // Defense preview.
  const persona = driver ? game.matrix?.personas?.[driver.id] : null;
  const plan = vehicleDefensePlan(v, { rig: driver ? controlRigRating(driver) : 0, vr: false, hot: !!persona?.online && persona.mode === 'hot', dataProcessing: 0 }, driver);
  const defPool = previewDriverPool(driver, plan.roller) + plan.bonus.reduce((n, l) => n + l.value, 0) + (evasive && driver ? attr(driver, 'INT') : 0) + (atk.defenseMod || 0) + modifier;
  // Soak preview.
  const st = vehicleStats(v);
  const armor = Math.max(0, st.armor + (Number(a.ap) || 0));
  const dv = a.modifiedDv ?? a.dv ?? 0;
  const stunIgnored = a.type === 'S' && !a.electric;
  const step = a.status === 'defense' ? 'defend' : a.status === 'soak' ? 'soak' : 'done';
  return <Overlay title={step === 'soak' ? t('Vehicle damage resistance — {name}', { name: v.name }) : t('Vehicle defense — {name}', { name: v.name })} onClose={onClose} width={460}>
    <div className="col gap-s atk-dlg">
      <div className="atk-dlg-attack"><b>{atk.attackerName}</b> · {atk.weaponName ? (atk.weaponName.en || atk.weaponName.fr) : ''} <BookRef source="SR5" page={205} /></div>
      {step === 'defend' && <>
        <div className="faint small">{plan.roller.kind === 'pilot'
          ? t('The drone defends on its own: Pilot + Maneuvering, limited by Handling.')
          : atk.ram ? t('Rammed: REA + INT [Handling]; no evasive driving against a ram.') : t('The driver defends: REA + INT. Evasive driving: + INT, −10 initiative.')}</div>
        <div className="sh-rd-breakdown">
          {plan.roller.kind === 'pilot'
            ? plan.roller.lines.map((l) => <span className="sh-rd-part" key={l.label}><span>{t(l.label)}</span><b>{l.value}</b></span>)
            : driver ? <span className="sh-rd-part"><span>{attrShort('REA')} + {attrShort('INT')} ({driver.name})</span><b>{attr(driver, 'REA') + attr(driver, 'INT')}</b></span> : null}
          {plan.bonus.map((l) => <span className="sh-rd-part mod" key={l.label}><span>{t(l.label)}</span><b>{signed(l.value)}</b></span>)}
          {evasive && driver ? <span className="sh-rd-part mod"><span>{t('evasive driving')}</span><b>+{attr(driver, 'INT')}</b></span> : null}
          {atk.defenseMod ? <span className="sh-rd-part bad"><span>{t('fire mode')}</span><b>{atk.defenseMod}</b></span> : null}
          {modifier ? <span className="sh-rd-part"><span>{t('mod.')}</span><b>{signed(modifier)}</b></span> : null}
          <span className="sh-rd-total">{tn(Math.max(0, defPool), '≈ {n} die', '≈ {n} dice')}</span>
        </div>
        <div className="row wrap gap-s">
          <div className="field"><span className="field-label">{t('Edit')}</span><NumberInput value={modifier} min={-20} max={20} onChange={setModifier} small /></div>
          {driver && plan.roller.kind === 'driver' && !atk.ram && <Toggle value={evasive} onChange={setEvasive} label={t('Evasive driving (+{n}, −10 init.)', { n: attr(driver, 'INT') })} />}
          {driver && plan.roller.kind === 'driver' && (driver.edge?.current ?? 0) > 0 && <Toggle value={explode} onChange={setExplode} label={t('Push the Limit (Edge)')} />}
        </div>
        <div className="row spread">
          <Button variant="ghost" onClick={onClose}>{t('Later')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => go('attack/defend')}>🛡 {t('Defend')}</Button>
        </div>
      </>}
      {step === 'soak' && <>
        <div className="atk-big hit">{t('DV {dv}{type} to resist', { dv, type: a.type })}</div>
        {stunIgnored || dv < armor
          ? <div className="muted small">{stunIgnored ? t('Vehicles ignore Stun damage (electricity excepted).') : t('DV {dv} is under the modified armor ({armor}): no damage.', { dv, armor })}</div>
          : <div className="sh-rd-breakdown">
            <span className="sh-rd-part"><span>{t('Body')}</span><b>{st.body}</b></span>
            <span className="sh-rd-part"><span>{t('armor')}</span><b>+{armor}</b></span>
            {modifier ? <span className="sh-rd-part"><span>{t('mod.')}</span><b>{signed(modifier)}</b></span> : null}
            <span className="sh-rd-total">{tn(Math.max(0, st.body + armor + modifier), '= {n} die', '= {n} dice')}</span>
          </div>}
        <div className="row wrap gap-s"><div className="field"><span className="field-label">{t('Edit')}</span><NumberInput value={modifier} min={-20} max={20} onChange={setModifier} small /></div></div>
        <div className="row spread">
          <Button variant="ghost" onClick={onClose}>{t('Later')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => go('attack/soak')}>✚ {t('Resist')}</Button>
        </div>
      </>}
      {result?.roll && <div className="sh-rd-result">
        <div className="sh-rd-hits"><b>{result.roll.hits}</b><span>{tn(result.roll.hits ?? 0, 'one::hit', 'other::hits')}</span></div>
        <div className="grow col gap-s"><DiceFaces roll={result.roll} /><RollBadges roll={result.roll} /></div>
      </div>}
      {step === 'done' || (result && a.status !== 'soak' && a.status !== 'defense') ? <>
        <Outcome a={a} />
        <div className="row spread"><span /><Button variant="primary" onClick={onClose}>{t('Close')}</Button></div>
      </> : null}
      {result && step === 'soak' && <Outcome a={a} />}
    </div>
  </Overlay>;
}

/** Biofeedback of a jumped-in rigger: WIL + Firewall, no armor (hot sim Physical, cold sim Stun). */
export function FeedbackDialog({ game, atk, onClose }: { game: GameView; atk: Attack; onClose: () => void }) {
  const actor = sheet(game, atk.targetId);
  const [modifier, setModifier] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Reply | null>(null);
  if (!actor) return <Overlay title={t('Biofeedback')} onClose={onClose} width={420}><div className="muted">{t('Target sheet unavailable.')}</div></Overlay>;
  const fw = Number(actor.matrix?.firewall) || 0;
  const total = Math.max(0, attr(actor, 'WIL') + fw + modifier);
  const a = result?.attack || atk;
  return <Overlay title={t('Biofeedback — {name}', { name: actor.name })} onClose={onClose} width={440}>
    <div className="col gap-s atk-dlg">
      <div className="atk-dlg-attack">{atk.weaponName ? (atk.weaponName.en || atk.weaponName.fr) : ''} <BookRef source="SR5" page={266} /></div>
      <div className="atk-big hit">{t('DV {dv}{type} to resist', { dv: atk.modifiedDv ?? atk.dv ?? 0, type: atk.type })}</div>
      {!result && <>
        <div className="sh-rd-breakdown">
          <span className="sh-rd-part"><span>{attrShort('WIL')}</span><b>{attr(actor, 'WIL')}</b></span>
          {fw ? <span className="sh-rd-part"><span>{t('Firewall')}</span><b>+{fw}</b></span> : null}
          {modifier ? <span className="sh-rd-part"><span>{t('mod.')}</span><b>{signed(modifier)}</b></span> : null}
          <span className="sh-rd-total">{tn(total, '= {n} die', '= {n} dice')}</span>
        </div>
        <div className="row wrap gap-s"><div className="field"><span className="field-label">{t('Edit')}</span><NumberInput value={modifier} min={-20} max={20} onChange={setModifier} small /></div></div>
        <div className="row spread">
          <Button variant="ghost" onClick={onClose}>{t('Later')}</Button>
          <Button variant="primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try { setResult(await send<Reply>('attack/soak', { attackId: atk.id, modifier })); } catch {} finally { setBusy(false); }
          }}>✚ {t('Resist')}</Button>
        </div>
      </>}
      {result && <>
        {result.roll && <div className="sh-rd-result"><div className="sh-rd-hits"><b>{result.roll.hits}</b></div><div className="grow"><DiceFaces roll={result.roll} /></div></div>}
        <div className={'atk-big' + (a.damage ? ' hit' : '')}>{a.damage ? (a.damageType === 'S' ? tn(a.damage, '{n} stun box', '{n} stun boxes') : tn(a.damage, '{n} physical box', '{n} physical boxes')) : t('fully resisted')}</div>
        <div className="row spread"><span /><Button variant="primary" onClick={onClose}>{t('Close')}</Button></div>
      </>}
    </div>
  </Overlay>;
}
