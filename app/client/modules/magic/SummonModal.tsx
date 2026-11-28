// Summon a spirit (SR5 p. 300): type of the tradition → Force → optional powers → roll vs the spirit's Force → Drain → a spirit
// actor with services (magic/summon). Opened from the Magic cockpit.
import { useState } from 'react';
import { Modal, Button, NumberInput, Toggle, Select, Badge } from '../../lib/ui.tsx';
import { send, useCatalog } from '../../lib/net.ts';
import { t, attrShort, getLang } from '../../lib/i18n.ts';
import { attr } from '/shared/sr5.ts';
import { drainAttr, maxForce, traditionSpiritTypes, optionalPowerCount, spiritStats, type SpiritDef } from '/shared/magic.ts';
import { RuleRef, BookRef } from '../books/BookRef.tsx';
import { isGM } from './common.tsx';
import type { Actor, GameView } from '../../../shared/types.ts';

interface SummonResult {
  hits: number;
  spiritHits: number;
  net: number;
  dv: number;
  drainType: 'P' | 'S';
  drain: { hits: number; damage: number } | { pendingId: string };
  spiritId: string | null;
  services: number;
}

const defName = (d: { name: string; nameFr?: string } | null | undefined): string => (d ? (getLang() === 'en' ? d.name : d.nameFr || d.name) : '');
const skillRating = (a: Actor, id: string): number => (a.skills || []).find((s) => s.id === id)?.rating || 0;

export default function SummonModal({ game, actor, onClose }: { game: GameView; actor: Actor; onClose: () => void }) {
  const gm = isGM(game);
  const all = useCatalog<SpiritDef>('spirits');
  // The tradition's spirits first; the GM also gets every other type (sorted by name).
  const own = actor.magic?.tradition?.spirits ? traditionSpiritTypes(actor.magic.tradition, all) : [];
  const others = all.filter((d) => !own.includes(d)).sort((a, b) => defName(a).localeCompare(defName(b)));
  const types = gm || !own.length ? [...own, ...others] : own;
  const [typeId, setTypeId] = useState('');
  const def = types.find((d) => d.id === typeId) || types[0] || null;
  const mag = attr(actor, 'MAG');
  const fmax = maxForce(actor);
  const [force, setForce] = useState(Math.max(1, Math.min(mag, fmax)));
  const [opts, setOpts] = useState<string[]>([]);
  const [explode, setExplode] = useState(false);
  const [modifier, setModifier] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SummonResult | null>(null);
  const n = optionalPowerCount(force);
  const summoning = skillRating(actor, 'summoning');
  const second = drainAttr(actor);
  const existing = Object.values(game.actors || {}).some((a) => 'spirit' in a && a.spirit && a.spirit.summonerId === actor.id && !a.spirit.bound);
  const st = def ? spiritStats(def, force) : null;
  const toggleOpt = (name: string) => setOpts((l) => (l.includes(name) ? l.filter((x) => x !== name) : l.length < n ? [...l, name] : l));
  const go = async () => {
    if (!def) return;
    setBusy(true);
    try {
      setResult(await send<SummonResult>('magic/summon', { actorId: actor.id, type: def.id, force, optionalPowers: opts.slice(0, n), explode, modifier, replace: existing }));
    } catch {
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    const d = result.drain;
    return (
      <Modal title={t('Summoning — {spirit}', { spirit: defName(def) })} onClose={onClose} width={520}>
        <div className="mg-cast-result">
          <div className="mg-cast-big">
            <b>{result.hits}</b> <span>{t('hit(s) against {n} for the spirit', { n: result.spiritHits })}</span>
          </div>
          <div className={'mg-cast-drain' + (result.net > 0 ? '' : ' amber')}>
            {result.net > 0 ? t('The spirit answers: it owes {n} service(s).', { n: result.services }) : t('The spirit does not come.')}
          </div>
          <div className="mg-cast-drain">
            {t('Drain {dv}', { dv: result.dv })} <Badge color={result.drainType === 'P' ? 'red' : 'amber'}>{result.drainType === 'P' ? t('Physical') : t('Stun')}</Badge>{' '}
            {'pendingId' in d
              ? t('to resist (Magic tab)')
              : d.damage
                ? t('{hits} hit(s) on the resistance: {n} box(es) of damage', { hits: d.hits, n: d.damage })
                : t('{hits} hit(s) on the resistance: no damage', { hits: d.hits })}
          </div>
        </div>
        <div className="row spread">
          <span />
          <Button variant="primary" onClick={onClose}>{t('Close')}</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t('Summon a spirit — {name}', { name: actor.name })} onClose={onClose} width={620}>
      <div className="mg-cast">
        <div className="mg-cast-row">
          <label className="field-label">{t('Spirit')}</label>
          <Select value={def?.id || ''} onChange={(v) => { setTypeId(v); setOpts([]); }} options={types.map((d) => ({ value: d.id, label: defName(d) }))} />
          {def?.source && def.page ? <BookRef source={def.source} page={def.page} /> : null}
          <RuleRef rule="summoning" />
        </div>
        {!types.length && <div className="small amber">{t('Your tradition lists no spirit: ask the GM.')}</div>}
        <div className="mg-cast-grid">
          <div className="field">
            <span className="field-label">{t('Force (1 – {max})', { max: fmax })}</span>
            <NumberInput value={force} min={1} max={fmax} onChange={(v) => { setForce(Math.max(1, Math.min(fmax, v))); setOpts((l) => l.slice(0, optionalPowerCount(v))); }} />
            <span className="faint small">{t('The Force is the limit of the test and the spirit’s dice.')}</span>
          </div>
          <div className="field">
            <span className="field-label">{t('Pool')}</span>
            <b className="mg-cast-dv">{summoning + mag + modifier}</b>
            <span className="faint small">{t('Summoning {s} + Magic {m}', { s: summoning, m: mag })}</span>
          </div>
          <div className="field">
            <span className="field-label">{t('Modifier')}</span>
            <NumberInput value={modifier} min={-20} max={20} onChange={setModifier} />
          </div>
        </div>
        {st && (
          <div className="faint small mg-spirit-preview">
            {t('BOD {b} · AGI {a} · REA {r} · STR {s} · WIL {w} · LOG {l} · INT {i} · CHA {c} · Init. {init} + {dice}D6', {
              b: st.attributes.BOD, a: st.attributes.AGI, r: st.attributes.REA, s: st.attributes.STR, w: st.attributes.WIL, l: st.attributes.LOG, i: st.attributes.INT, c: st.attributes.CHA,
              init: st.initiativeBase, dice: st.initiative.dice + 1,
            })}
          </div>
        )}
        {def && n > 0 && def.optionalPowers.length > 0 && (
          <div>
            <div className="field-label">{t('Optional powers ({k} / {n})', { k: opts.length, n })}</div>
            <div className="row wrap">
              {def.optionalPowers.map((o) => (
                <button type="button" key={o.name} className={'chip' + (opts.includes(o.name) ? ' on' : '')} onClick={() => toggleOpt(o.name)}>
                  {getLang() === 'en' ? o.name : o.nameFr || o.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="row wrap">
          <Toggle value={explode} onChange={setExplode} label={t('Push the Limit (Edge: no limit)')} />
        </div>
        <div className="mg-cast-warn small">
          {t('Drain = 2 × the spirit’s hits (min 2), resisted with {wil} + {attr}; Physical if the Force is above your Magic ({mag}).', { wil: attrShort('WIL'), attr: second ? attrShort(second) : '?', mag })}
        </div>
        {existing && <div className="small amber">{t('Your unbound spirit will leave: one unbound spirit at a time (SR5 p. 300).')}</div>}
      </div>
      <div className="row spread mg-cast-foot">
        <span className="faint small">{t('Complex Action.')}</span>
        <div className="row">
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!def || busy || !second || summoning <= 0} onClick={go}>
            ✦ {t('Summon at Force {f}', { f: force })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
