// GM « Ritual » tab (SR5 pp. 295-296): leader, ritual, Force, participants (teamwork), extra reagents, lodge check; seal the
// ritual (magic/ritual) or make it fail (magic/ritualFail).
import { useState } from 'react';
import { Button, NumberInput, Select, Toggle, Empty, Badge } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import { attr } from '/shared/sr5.ts';
import { maxForce, isRitual, reagentDrams } from '/shared/magic.ts';
import { BookRef } from '../books/BookRef.tsx';
import { itemLabel } from '../sheet/common.tsx';
import { magicActors } from './common.tsx';
import type { GameView } from '../../../shared/types.ts';

interface RitualResult {
  hits: number;
  opposition: number;
  net: number;
  dv: number;
  drainType: 'P' | 'S';
  teamwork: { dice: number; limit: number };
  drams: number;
}

const skill = (a: { skills?: Array<{ id: string; rating: number }> }, id: string): number => (a.skills || []).find((s) => s.id === id)?.rating || 0;

export default function RitualPanel({ game }: { game: GameView }) {
  const casters = magicActors(game).filter((a) => skill(a, 'ritual_spellcasting') > 0);
  const [leaderId, setLeaderId] = useState('');
  const leader = casters.find((a) => a.id === leaderId) || casters[0] || null;
  const spells = [...(leader?.spells || [])].sort((a, b) => Number(isRitual(b)) - Number(isRitual(a)));
  const [ritualId, setRitualId] = useState('');
  const ritual = spells.find((s) => s.id === ritualId) || spells[0] || null;
  const fmax = leader ? maxForce(leader) : 1;
  const [force, setForce] = useState(3);
  const [parts, setParts] = useState<string[]>([]);
  const [extra, setExtra] = useState(0);
  const [lodge, setLodge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RitualResult | null>(null);
  if (!casters.length) return <Empty>{t('No character knows Ritual Spellcasting.')}</Empty>;
  const others = magicActors(game).filter((a) => a.id !== leader?.id && skill(a, 'ritual_spellcasting') > 0);
  const f = Math.max(1, Math.min(fmax, force));
  const drams = f * (1 + extra);
  const have = leader ? reagentDrams(leader) : 0;
  const payload = { leaderId: leader?.id, ritualId: ritual?.id, force: f, participantIds: parts.filter((id) => others.some((o) => o.id === id)) };
  const seal = async (fail: boolean) => {
    setBusy(true);
    const r = await send<RitualResult>(fail ? 'magic/ritualFail' : 'magic/ritual', fail ? payload : { ...payload, extraOfferings: extra, free: have < drams }).catch(() => null);
    setBusy(false);
    if (r && !fail) setResult(r);
  };
  return (
    <div className="mg-panel mg-ritual">
      <div className="mg-panel-title">
        {t('Ritual spellcasting')} <BookRef source="SR5" page={295} />
      </div>
      <div className="mg-cast-grid">
        <div className="field">
          <span className="field-label">{t('Leader')}</span>
          <Select value={leader?.id || ''} onChange={(v) => { setLeaderId(v); setRitualId(''); setResult(null); }} options={casters.map((a) => ({ value: a.id, label: a.name }))} />
        </div>
        <div className="field">
          <span className="field-label">{t('Ritual')}</span>
          <Select value={ritual?.id || ''} onChange={setRitualId} options={spells.map((s) => ({ value: s.id, label: isRitual(s) ? itemLabel(s) : t('{spell} (spell)', { spell: itemLabel(s) }) }))} />
        </div>
        <div className="field">
          <span className="field-label">{t('Force (1 – {max})', { max: fmax })}</span>
          <NumberInput value={f} min={1} max={fmax} onChange={setForce} />
        </div>
        <div className="field">
          <span className="field-label">{t('Extra offerings')}</span>
          <NumberInput value={extra} min={0} max={10} onChange={setExtra} />
          <span className="faint small">{t('Each extra Force drams: −1 Drain (min 2)')}</span>
        </div>
      </div>
      <div className="field-label">{t('Participants (teamwork; −2 dice for another tradition)')}</div>
      <div className="row wrap">
        {others.map((a) => (
          <label key={a.id} className={'mg-target' + (parts.includes(a.id) ? ' on' : '')}>
            <input type="checkbox" checked={parts.includes(a.id)} onChange={() => setParts((l) => (l.includes(a.id) ? l.filter((x) => x !== a.id) : [...l, a.id]))} />
            <span>{a.name}</span>
            <span className="faint small">{t('Ritual {n} + Magic {m}', { n: skill(a, 'ritual_spellcasting'), m: attr(a, 'MAG') })}</span>
          </label>
        ))}
        {!others.length && <span className="muted small">{t('Nobody else knows Ritual Spellcasting.')}</span>}
      </div>
      <div className="mg-cast-warn small">
        {t('Offering: {n} drams of reagents ({have} carried by the leader). Opposition: Force × 2 = {opp} dice. Drain for each participant: 2 × its hits (min 2), Physical if the leader’s hits exceed their Magic.', { n: drams, have, opp: f * 2 })}
        {have < drams && <> <Badge color="amber">{t('not enough reagents: sealed for free (GM)')}</Badge></>}
      </div>
      <Toggle value={lodge} onChange={setLodge} label={t('The lodge’s Force is at least the ritual’s (step 4)')} />
      <div className="row">
        <Button variant="primary" disabled={!leader || !ritual || !lodge || busy} onClick={() => void seal(false)}>✦ {t('Seal the ritual')}</Button>
        <Button disabled={!leader || !ritual || busy} onClick={() => void seal(true)} title={t('A participant left, the lodge broke, the leader fell (SR5 p. 296)')}>{t('The ritual fails')}</Button>
      </div>
      {result && (
        <div className="mg-cast-result">
          <div className="mg-cast-big">
            <b>{result.net}</b> <span>{t('net hit(s): {h} against {o}', { h: result.hits, o: result.opposition })}</span>
          </div>
          <div className="small">{t('Teamwork: +{d} dice, +{l} limit', { d: result.teamwork.dice, l: result.teamwork.limit })}</div>
          <div className="mg-cast-drain">
            {t('Drain {dv}', { dv: result.dv })} <Badge color={result.drainType === 'P' ? 'red' : 'amber'}>{result.drainType === 'P' ? t('Physical') : t('Stun')}</Badge> {t('for each participant (see the log)')}
          </div>
        </div>
      )}
    </div>
  );
}
