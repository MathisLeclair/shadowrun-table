// Cast a spell (SR5 pp. 281-282): spell → Force → targets on the map → roll → Drain computed and resisted (magic/cast).
// Opened from the Magic cockpit and the sheet's spell list.
import { useMemo, useState } from 'react';
import { Modal, Button, NumberInput, Toggle, Select, Badge } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { useUI } from '../../lib/ui-store.ts';
import { t, attrShort } from '../../lib/i18n.ts';
import { attr } from '/shared/sr5.ts';
import { cellDistance } from '/shared/combat.ts';
import { hasLineOfSight } from '/shared/vision.ts';
import { drainValue, drainOffset, drainAttr, maxForce, spellReach, isAreaSpell, isSustainable, RECKLESS_DV, SUSTAIN_PENALTY } from '/shared/magic.ts';
import { itemLabel, categoryLabel } from '../sheet/common.tsx';
import { ItemRef, RuleRef } from '../books/BookRef.tsx';
import { isGM } from './common.tsx';
import type { Actor, GameMap, GameView, Spell, Token } from '../../../shared/types.ts';

/** What magic/cast returns. */
interface CastResult {
  hits: number;
  rawHits: number;
  glitch: boolean;
  critGlitch: boolean;
  force: number;
  dv: number;
  drainType: 'P' | 'S';
  drain: { hits: number; damage: number } | { pendingId: string };
  targetIds: string[];
  sustainedId?: string | null;
}

/** The map the user is looking at (GM: the one open in the map tab). */
function currentMap(game: GameView, viewMapId: string | null): GameMap | null {
  const maps = game.maps || {};
  const id = isGM(game) && viewMapId && maps[viewMapId] ? viewMapId : game.scene?.activeMapId;
  return (id && maps[id]) || null;
}

const skillRating = (a: Actor, id: string): number => (a.skills || []).find((s) => s.id === id)?.rating || 0;

export default function CastModal({ game, actor, spellId, onClose }: { game: GameView; actor: Actor; spellId?: string; onClose: () => void }) {
  const ui = useUI();
  const gm = isGM(game);
  const spells = actor.spells || [];
  const [sid, setSid] = useState(spellId || spells[0]?.id || '');
  const spell: Spell | undefined = spells.find((s) => s.id === sid);
  const mag = attr(actor, 'MAG');
  const fmax = maxForce(actor);
  const [force, setForce] = useState(Math.max(1, Math.min(mag, fmax)));
  const [reckless, setReckless] = useState(false);
  const [explode, setExplode] = useState(false);
  const [modifier, setModifier] = useState(0);
  const [manualDv, setManualDv] = useState(2);
  const [sustain, setSustain] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CastResult | null>(null);
  const map = currentMap(game, ui.viewMapId);
  const me = map?.tokens.find((tk) => tk.actorId === actor.id) || null;
  const reach = spell ? spellReach(spell.range) : 'special';
  const area = !!spell && isAreaSpell(spell.range);
  const mpc = Number(map?.metersPerCell) || 1;
  // Targets: actor ids. Default: the user's map target, or the caster for a self spell.
  const initial = useMemo(() => {
    const tok = ui.targetTokenId ? map?.tokens.find((x) => x.id === ui.targetTokenId) : null;
    return tok?.actorId ? [tok.actorId] : reach === 'self' ? [actor.id] : [];
  }, []);
  const [targetIds, setTargetIds] = useState<string[]>(initial);
  const [centerId, setCenterId] = useState<string>(initial[0] || me?.id || '');
  const tokens: Token[] = (map?.tokens || []).filter((x) => x.actorId && (gm || !x.hidden));
  const center = area ? tokens.find((x) => x.id === centerId) || me : null;
  const dist = (a: Token | null | undefined, b: Token | null | undefined) => (a && b ? cellDistance(a, b, mpc) : null);
  const sorted = [...tokens].sort((a, b) => (dist(me, a) ?? 999) - (dist(me, b) ?? 999));
  const inArea = (x: Token) => !!center && (dist(center, x) ?? 999) <= force + mpc;
  const los = (x: Token) => !me || !map || x.actorId === actor.id || hasLineOfSight(map, me, x);
  const offset = drainOffset(spell?.drain);
  const dv = spell ? (offset === null ? manualDv + (reckless ? RECKLESS_DV : 0) : drainValue(spell.drain, force, { reckless })) : null;
  const second = drainAttr(actor);
  const sustainable = !!spell && isSustainable(spell.duration);
  const spellcasting = skillRating(actor, 'spellcasting');
  const toggle = (id: string) => setTargetIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const pickCenter = (id: string) => {
    setCenterId(id);
    const c = tokens.find((x) => x.id === id);
    if (c) setTargetIds(tokens.filter((x) => (dist(c, x) ?? 999) <= force + mpc).map((x) => x.actorId as string));
  };

  const cast = async () => {
    if (!spell) return;
    setBusy(true);
    try {
      const r = await send<CastResult>('magic/cast', {
        actorId: actor.id, spellId: spell.id, force, reckless, explode, modifier, mapId: map?.id, targetIds, sustain: sustainable && sustain,
        ...(area && center ? { area: { x: center.x, y: center.y } } : {}), ...(offset === null ? { drainDv: manualDv } : {}),
      });
      setResult(r);
    } catch {
      // the error is shown as a toast by send()
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (id: string) => (game.actors?.[id] as { name?: string } | undefined)?.name || id;
  if (result) {
    const d = result.drain;
    return (
      <Modal title={t('Spell cast — {spell}', { spell: spell ? itemLabel(spell) : '' })} onClose={onClose} width={520}>
        <div className="mg-cast-result">
          <div className="mg-cast-big">
            <b>{result.hits}</b> <span>{t('hit(s) (Force {force} limit)', { force: result.force })}</span>
          </div>
          {result.rawHits > result.hits && <div className="muted small">{t('{n} hit(s) lost to the Force limit', { n: result.rawHits - result.hits })}</div>}
          {result.critGlitch ? <Badge color="red">{t('Critical glitch')}</Badge> : result.glitch ? <Badge color="amber">{t('Glitch')}</Badge> : null}
          {result.targetIds.length > 0 && <div>{t('Targets: {list}', { list: result.targetIds.map(nameOf).join(', ') })}</div>}
          <div className="mg-cast-drain">
            {t('Drain {dv}', { dv: result.dv })} <Badge color={result.drainType === 'P' ? 'red' : 'amber'}>{result.drainType === 'P' ? t('Physical') : t('Stun')}</Badge>{' '}
            {'pendingId' in d
              ? t('to resist (Magic tab)')
              : d.damage
                ? t('{hits} hit(s) on the resistance: {n} box(es) of damage', { hits: d.hits, n: d.damage })
                : t('{hits} hit(s) on the resistance: no damage', { hits: d.hits })}
          </div>
          {result.sustainedId && <div className="mg-cast-drain">{t('Sustained: −{n} dice on all your tests until you drop it (Magic tab).', { n: SUSTAIN_PENALTY })}</div>}
          <p className="faint small">{t('Apply the spell’s effect: the log keeps the hits.')}</p>
        </div>
        <div className="row spread">
          <span />
          <Button variant="primary" onClick={onClose}>{t('Close')}</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('Cast a spell — {name}', { name: actor.name })} onClose={onClose} width={640}>
      <div className="mg-cast">
        <div className="mg-cast-row">
          <label className="field-label">{t('Spell')}</label>
          <Select value={sid} onChange={setSid} options={spells.map((s) => ({ value: s.id, label: itemLabel(s) }))} />
          {spell && <ItemRef item={spell} />}
        </div>
        {spell && (
          <div className="faint small">
            {categoryLabel(spell)} · {t('Type {type}', { type: spell.type })} · {t('Range {range}', { range: spell.range })} · {t('Duration {d}', { d: spell.duration })} · {t('Drain {formula}', { formula: spell.drain })}
          </div>
        )}
        <div className="mg-cast-grid">
          <div className="field">
            <span className="field-label">
              {t('Force (1 – {max})', { max: fmax })} <RuleRef rule="spellcasting" />
            </span>
            <NumberInput value={force} min={1} max={fmax} onChange={(v) => setForce(Math.max(1, Math.min(fmax, v)))} />
            <span className="faint small">{t('The Force is the limit of the test.')}</span>
          </div>
          <div className="field">
            <span className="field-label">{t('Drain Value')}</span>
            {offset === null ? (
              <NumberInput value={manualDv} min={2} max={40} onChange={setManualDv} />
            ) : (
              <b className="mg-cast-dv">{dv ?? '—'}</b>
            )}
            <span className="faint small">
              {offset === null ? t('Formula « {f} »: enter the value from the spell.', { f: spell?.drain || '—' }) : t('Formula {f}, minimum 2', { f: spell?.drain || '' })}
            </span>
          </div>
          <div className="field">
            <span className="field-label">{t('Pool')}</span>
            <b className="mg-cast-dv">{spellcasting + mag + modifier}</b>
            <span className="faint small">{t('Spellcasting {s} + Magic {m} (+ modifiers on the roll)', { s: spellcasting, m: mag })}</span>
          </div>
          <div className="field">
            <span className="field-label">{t('Modifier')}</span>
            <NumberInput value={modifier} min={-20} max={20} onChange={setModifier} />
          </div>
        </div>
        <div className="row wrap">
          <Toggle value={reckless} onChange={setReckless} label={t('Reckless Spellcasting (Simple Action, +3 Drain)')} />
          <Toggle value={explode} onChange={setExplode} label={t('Push the Limit (Edge: no limit)')} />
          {sustainable && <Toggle value={sustain} onChange={setSustain} label={spell && /^P$/i.test(spell.duration) ? t('Sustain until permanent (Force Combat Turns, −2 dice)') : t('Sustain the spell (−2 dice on all your tests)')} />}
        </div>
        <div className="mg-cast-warn small">
          {t('Drain is resisted with {wil} + {attr}; it becomes Physical if you get more than {mag} hits.', { wil: attrShort('WIL'), attr: second ? attrShort(second) : '?', mag })}
        </div>

        <div className="mg-panel-title">{area ? t('Area: radius {r} m (Force)', { r: force }) : reach === 'self' ? t('Target: the caster') : reach === 'touch' ? t('Target: touch') : t('Targets: line of sight')}</div>
        {!map ? (
          <div className="muted small">{t('No map shown: the spell is cast without a target on the map.')}</div>
        ) : (
          <>
            {area && (
              <div className="mg-cast-row">
                <label className="field-label">{t('Centre')}</label>
                <Select value={center?.id || ''} onChange={pickCenter} options={[{ value: '', label: t('— Token —') }, ...sorted.map((x) => ({ value: x.id, label: x.name }))]} />
              </div>
            )}
            <div className="mg-cast-targets">
              {sorted.map((x) => {
                const id = x.actorId as string;
                const d = dist(me, x);
                const blocked = reach === 'los' && !area && !los(x);
                const far = reach === 'touch' && x.actorId !== actor.id && (d ?? 99) > mpc * 1.5;
                const out = area && !inArea(x);
                return (
                  <label key={x.id} className={'mg-target' + (targetIds.includes(id) ? ' on' : '') + (blocked || far || out ? ' warn' : '')}>
                    <input type="checkbox" checked={targetIds.includes(id)} onChange={() => toggle(id)} />
                    <span>{x.actorId === actor.id ? t('{name} (self)', { name: x.name }) : x.name}</span>
                    {d !== null && x.actorId !== actor.id ? <span className="faint small">{t('{d} m', { d })}</span> : null}
                    {blocked ? <span className="small amber">{t('no line of sight')}</span> : far ? <span className="small amber">{t('out of reach')}</span> : out ? <span className="small amber">{t('outside the area')}</span> : null}
                  </label>
                );
              })}
            </div>
            {!me && !gm && <div className="small amber">{t('{name} has no token on this map.', { name: actor.name })}</div>}
          </>
        )}
      </div>
      <div className="row spread mg-cast-foot">
        <span className="faint small">{t('Complex Action (Simple when reckless).')}</span>
        <div className="row">
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!spell || busy || !second || spellcasting <= 0} onClick={cast} title={!second ? t('Choose a tradition first') : undefined}>
            ✦ {t('Cast at Force {f}', { f: force })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
