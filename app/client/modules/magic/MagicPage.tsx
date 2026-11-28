// « Magic » tab: cockpit of an awakened character for players, overview + cockpit of every awakened character for the GM.
// Design and the flows still to come (cast, sustain, summon, astral, foci): docs/design/magic.md.
import { useEffect, useState } from 'react';
import { Tabs, Empty, Button, Badge, Toggle, Modal, Select } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { useUI, openSheet } from '../../lib/ui-store.ts';
import type { GameProps } from '../../lib/net.ts';
import { t, tk, attrShort, getLang } from '../../lib/i18n.ts';
import { attr, derive } from '/shared/sr5.ts';
import {
  drainAttr, drainPool, sustainedBy, usesTradition, magicHints, reagentDrams, canPerceiveAstral, canProjectAstral, focusKind, focusForce, focusBondMultiplier, fociLimits,
  metamagicDef, initiateGrade, hasMetamagic,
  SUSTAIN_PENALTY, BINDING_DRAMS, ASTRAL_ATTRIBUTES, type MagicHint, type FocusKind,
} from '/shared/magic.ts';
import { RollDialog } from '../sheet/RollDialog.tsx';
import { RuleRef, ItemRef, BookRef } from '../books/BookRef.tsx';
import { categoryLabel, itemLabel } from '../sheet/common.tsx';
import { isGM, magicActors, drainRollLabel, TraditionPicker } from './common.tsx';
import CastModal from './CastModal.tsx';
import SummonModal from './SummonModal.tsx';
import BanishModal from './BanishModal.tsx';
import RitualPanel from './RitualPanel.tsx';
import { toast } from '../../lib/ui-store.ts';
import { confirmAction, promptText } from '../../lib/ui.tsx';
import type { RollPreset } from '../sheet/types.ts';
import type { Actor, ActorSpirit, GameView, SustainedSpell } from '../../../shared/types.ts';
import './magic.css';

function usePersistent<T>(key: string, initial: T): [T, (x: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : JSON.parse(s);
    } catch {
      return initial;
    }
  });
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(key, JSON.stringify(x));
    } catch {}
  };
  return [v, set];
}

/** Actor requested by « Magic tab » on a sheet (ui-store key magicFocus = { actorId, nonce }). */
function useMagicFocus(onFocus: (actorId: string) => void) {
  const ui = useUI();
  const f = ui.magicFocus as { actorId?: string; nonce?: number } | undefined;
  useEffect(() => {
    if (f?.actorId) onFocus(f.actorId);
  }, [f?.nonce]);
}

const MAGIC_SKILLS: Array<{ id: string; label: string; limit?: null }> = [
  { id: 'assensing', label: tk('Assensing') },
  { id: 'counterspelling', label: tk('Counterspelling') },
  { id: 'summoning', label: tk('Summoning'), limit: null },
  { id: 'binding', label: tk('Binding'), limit: null },
  { id: 'banishing', label: tk('Banishing') },
  { id: 'ritual_spellcasting', label: tk('Ritual Spellcasting'), limit: null },
  { id: 'astral_combat', label: tk('Astral Combat') },
];
const skillRating = (a: Actor, id: string): number => (a.skills || []).find((s) => s.id === id)?.rating || 0;

function HintsPanel({ hints }: { hints: MagicHint[] }) {
  if (!hints.length) return null;
  return (
    <div className="mg-panel mg-hints">
      <div className="mg-panel-title">💡 {t('Hints')}</div>
      {hints.map((h) => (
        <div className={'mg-hint tone-' + h.tone} key={h.key}>
          {t(h.key, h.params?.attr ? { ...h.params, attr: attrShort(String(h.params.attr)) } : h.params)}
        </div>
      ))}
    </div>
  );
}

function useHintsToggle(): [boolean, (v: boolean) => void] {
  const [on, setOn] = usePersistent<boolean>('sr.magic.hints', true);
  return [on, setOn];
}

/** A name stored in both languages, in the UI language. */
const biText = (n: { fr?: string; en?: string } | null | undefined): string => (getLang() === 'en' ? n?.en || n?.fr : n?.fr || n?.en) || '';

/** Sustained spells (SR5 p. 282): caster, Force, hits, targets, turns left for a Permanent one, « Drop ». */
function SustainedList({ game, list, canDrop, showCaster, helpers, quicken }: { game: GameView; list: SustainedSpell[]; canDrop: (s: SustainedSpell) => boolean; showCaster?: boolean; helpers?: SpiritActor[]; quicken?: boolean }) {
  const name = (id: string) => (game.actors?.[id] as { name?: string } | undefined)?.name || '?';
  return (
    <table className="sr mg-sustained">
      <tbody>
        {list.map((s) => (
          <tr key={s.id}>
            <td>
              <b>{biText(s.name)}</b>
              {showCaster ? <span className="muted small"> — {name(s.casterId)}</span> : null}
            </td>
            <td className="num-cell">{t('F{force} · {hits} hit(s)', { force: s.force, hits: s.hits })}</td>
            <td className="small">{s.targetIds.length ? t('on {list}', { list: s.targetIds.map(name).join(', ') }) : <span className="muted">{t('no target')}</span>}</td>
            <td className="small muted">
              {typeof s.turnsLeft === 'number' ? t('permanent in {n} Combat Turn(s)', { n: s.turnsLeft }) : ''}
              {s.by?.kind === 'spirit' ? ' ' + t('sustained by {spirit} ({n} turn(s))', { spirit: name(s.by.actorId), n: s.by.turnsLeft }) : ''}
              {s.by?.kind === 'focus' ? ' ' + t('sustained by a focus') : ''}
              {s.by?.kind === 'quickened' ? ' ' + t('quickened ({n} karma)', { n: s.by.karma }) : ''}
            </td>
            <td>
              {canDrop(s) && s.by?.kind !== 'quickened' && quicken && (
                <Button small variant="ghost" onClick={async () => {
                  const v = await promptText(t('Karma to spend on quickening {spell} (1 – {n}):', { spell: biText(s.name), n: s.force }), '1');
                  if (v !== null) void send('magic/quicken', { sustainedId: s.id, karma: Number(v) }).catch(() => null);
                }} title={t('The spell becomes permanent, without the −2 (SR5 p. 326)')}>{t('Quicken')}</Button>
              )}
              {!s.by && canDrop(s) && (helpers || []).map((sp) => (
                <Button small variant="ghost" key={sp.id} onClick={() => void send('magic/spiritSustain', { sustainedId: s.id, spiritId: sp.id }).catch(() => null)} title={t('The spirit sustains it for its Force in Combat Turns, instead of you (one service, SR5 p. 302)')}>
                  {t('Give to {name}', { name: sp.name })}
                </Button>
              ))}
              {canDrop(s) && (
                <Button small onClick={() => void send('magic/drop', { id: s.id }).catch(() => null)} title={t('Stop sustaining this spell')}>
                  {t('Drop')}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type SpiritActor = Actor & { spirit: ActorSpirit };
/** Spirits summoned by an actor (full sheets of the view). */
const spiritsOf = (game: GameView, summonerId: string): SpiritActor[] =>
  Object.values(game.actors || {}).filter((a): a is SpiritActor => 'attributes' in a && !!(a as Actor).spirit && (a as Actor).spirit!.summonerId === summonerId);

/** Spirit cards (SR5 pp. 300-302): services, materialization, joining a fight, attacks, release. */
function SpiritsPanel({ game, actor, own, onSummon, onBanish }: { game: GameView; actor: Actor; own: boolean; onSummon: (() => void) | null; onBanish: (() => void) | null }) {
  const list = spiritsOf(game, actor.id);
  const [rolling, setRolling] = useState<{ spiritId: string; preset: RollPreset } | null>(null);
  const [astralFor, setAstralFor] = useState<SpiritActor | null>(null);
  const fight = !!game.combat?.active;
  const gm = isGM(game);
  if (!list.length && !onSummon && !onBanish) return null;
  const act = (type: string, payload: object) => void send(type, payload).catch(() => null);
  // Natural attacks (shared/magic.ts spiritWeapons) through the attack pipeline: Elemental Attack first, the dialog switches weapons.
  const attack = (sp: SpiritActor) => {
    const ws = (sp.weapons || []).filter((w) => w.natural);
    const w = ws.find((x) => x.natural?.power === 'elementalAttack') || ws[0];
    if (!w) return openSheet(sp.id);
    setRolling({ spiritId: sp.id, preset: { skillId: w.skill, weaponId: w.id, label: `Attack — ${w.nameFr || w.name}`, _k: Date.now() } }); // i18n-ignore: stored label, shown with rollLabel()
  };
  const rollingSpirit = rolling ? list.find((x) => x.id === rolling.spiritId) || null : null;
  const bind = async (sp: SpiritActor) => {
    const need = sp.spirit.force * BINDING_DRAMS;
    const have = reagentDrams(actor);
    const free = have < need && gm;
    if (have < need && !gm) return toast(t('Binding needs {n} drams of reagents ({have} carried)', { n: need, have }), 'warn');
    if (!(await confirmAction(free ? t('Bind {name}? No reagents: the GM binds it anyway.', { name: sp.name }) : t('Bind {name}? It uses {n} drams of reagents and takes {h} hour(s).', { name: sp.name, n: need, h: sp.spirit.force })))) return;
    const r = await send<{ bound: boolean; services: number }>('magic/bind', { spiritId: sp.id, free }).catch(() => null);
    if (r) toast(r.bound ? t('{name} is bound: {n} service(s).', { name: sp.name, n: r.services }) : t('The binding fails.'), r.bound ? 'success' : 'warn');
  };
  return (
    <div className="mg-panel mg-spirits">
      <div className="mg-panel-title">
        {t('Spirits')} <RuleRef rule="summoning" />
        {onSummon && (
          <Button small variant="accent" onClick={onSummon}>
            ✦ {t('Summon')}
          </Button>
        )}
        {onBanish && (
          <Button small onClick={onBanish} title={t('Banish a spirit, yours or an enemy’s (SR5 p. 301)')}>
            {t('Banish')}
          </Button>
        )}
      </div>
      {!list.length && <div className="muted small">{t('No spirit at your service.')}</div>}
      {list.map((sp) => {
        const s = sp.spirit;
        const inFight = (game.combat?.entries || []).some((e) => e.actorId === sp.id && !e.out);
        const resting = s.bound && s.present === false;
        const hurt = (sp.condition?.physical || 0) + (sp.condition?.stun || 0);
        return (
          <div className="mg-spirit" key={sp.id}>
            <div className="row spread">
              <span>
                <b>{sp.name}</b> <Badge color="magenta">{t('Force {n}', { n: s.force })}</Badge>{' '}
                {s.bound ? <Badge color="cyan">{t('bound')}</Badge> : <Badge>{t('unbound')}</Badge>}{' '}
                {resting ? <Badge>{t('at rest')}</Badge> : <Badge color={s.materialized ? 'amber' : 'dim'}>{s.materialized ? t('materialized') : t('astral')}</Badge>}
                {hurt ? <span className="small amber"> {t('{n} box(es) of damage', { n: hurt })}</span> : null}
              </span>
              <span className="mg-spirit-services" title={t('Services owed (SR5 p. 302)')}>
                {t('{n} service(s)', { n: s.services })}
              </span>
            </div>
            {own && (
              <div className="row wrap mg-spirit-btns">
                <Button small onClick={() => act('magic/spiritServices', { spiritId: sp.id, delta: -1 })} title={t('A task, a power used for you, a physical task… (SR5 p. 302)')}>
                  {t('Use a service')}
                </Button>
                {gm && <Button small variant="ghost" onClick={() => act('magic/spiritServices', { spiritId: sp.id, delta: 1 })}>{t('+1 service')}</Button>}
                {!s.bound && <Button small onClick={() => void bind(sp)} title={t('Binding + Magic [Force] vs Force × 2; Force × 25 drams of reagents (SR5 p. 300)')}>{t('Bind')}</Button>}
                {s.bound && (
                  <Button small onClick={() => act('magic/callSpirit', { spiritId: sp.id, present: resting })}>
                    {resting ? t('Call') : t('Send to rest')}
                  </Button>
                )}
                {!resting && (
                  <Button small onClick={() => act('magic/materialize', { spiritId: sp.id, materialized: !s.materialized, mapId: game.scene?.activeMapId })}>
                    {s.materialized ? t('Dematerialize') : t('Materialize')}
                  </Button>
                )}
                {fight && !inFight && !resting && (
                  <Button small variant="accent" onClick={() => act('magic/spiritCombat', { spiritId: sp.id })} title={t('The whole fight is one service (SR5 p. 302)')}>
                    ⚔ {t('Join the fight')}
                  </Button>
                )}
                {!resting && (s.materialized
                  ? <Button small variant="accent" onClick={() => attack(sp)} title={t('Its natural attacks: unarmed, Elemental Attack, Engulf… against a token (SR5 p. 396)')}>⚔ {t('Attack')}</Button>
                  : <Button small onClick={() => setAstralFor(sp)} title={t('On the astral plane: Astral Combat + Willpower [Astral], DV = Force (SR5 p. 315)')}>⚔ {t('Astral attack')}</Button>)}
                <Button small variant="ghost" onClick={() => openSheet(sp.id)}>{t('Sheet')}</Button>
                <Button small variant="ghost" onClick={async () => { if (await confirmAction(t('Release {name}? It returns to its metaplane.', { name: sp.name }))) act('magic/release', { spiritId: sp.id }); }}>
                  {t('Release')}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {rolling && rollingSpirit && <RollDialog game={game} actor={rollingSpirit} preset={rolling.preset} onClose={() => setRolling(null)} />}
      {astralFor && <AstralAttackModal game={game} actor={astralFor} onClose={() => setAstralFor(null)} />}
    </div>
  );
}

/** Unarmed astral attack (SR5 p. 315): a target of the shown map, Stun or Physical (magic/astralAttack). */
function AstralAttackModal({ game, actor, onClose }: { game: GameView; actor: Actor; onClose: () => void }) {
  const map = game.scene?.activeMapId ? game.maps?.[game.scene.activeMapId] : null;
  const targets = (map?.tokens || []).filter((x) => x.actorId && x.actorId !== actor.id);
  const [target, setTarget] = useState(targets[0]?.actorId || '');
  const [damage, setDamage] = useState<'P' | 'S'>('S');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await send<{ hits: number; dv: number }>('magic/astralAttack', { actorId: actor.id, targetId: target, mapId: map?.id, damage }).catch(() => null);
    setBusy(false);
    if (r) {
      toast(t('Astral attack: {hits} hit(s), DV {dv} — the target defends in the attack tray.', { hits: r.hits, dv: r.dv }), 'success');
      onClose();
    }
  };
  return (
    <Modal title={t('Astral attack — {name}', { name: actor.name })} onClose={onClose} width={460}>
      <div className="mg-cast">
        <div className="faint small">{t('Astral Combat + Willpower [Astral] against Intuition + Logic; DV = astral Strength + net hits (SR5 p. 315).')}</div>
        <div className="mg-cast-row">
          <label className="field-label">{t('Target')}</label>
          <Select value={target} onChange={setTarget} options={targets.map((x) => ({ value: x.actorId as string, label: x.astral ? t('{name} (astral)', { name: x.name }) : x.name }))} />
        </div>
        <div className="mg-cast-row">
          <label className="field-label">{t('Damage')}</label>
          <Select value={damage} onChange={(v) => setDamage(v === 'P' ? 'P' : 'S')} options={[{ value: 'S', label: t('Stun') }, { value: 'P', label: t('Physical') }]} />
        </div>
      </div>
      <div className="row spread mg-cast-foot">
        <span />
        <div className="row">
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!target || busy} onClick={go}>⚔ {t('Attack')}</Button>
        </div>
      </div>
    </Modal>
  );
}

const FOCUS_LABELS: Record<FocusKind, string> = {
  spellcasting: tk('Spellcasting focus'), counterspelling: tk('Counterspelling focus'), ritual: tk('Ritual spellcasting focus'), sustaining: tk('Sustaining focus'),
  summoning: tk('Summoning focus'), banishing: tk('Banishing focus'), binding: tk('Binding focus'), power: tk('Power focus'), weapon: tk('Weapon focus'), qi: tk('Qi focus'),
  alchemical: tk('Alchemical focus'), disenchanting: tk('Disenchanting focus'), centering: tk('Centering focus'), masking: tk('Masking focus'),
  flexibleSignature: tk('Flexible signature focus'), spellShaping: tk('Spell shaping focus'),
};

/** Foci (SR5 pp. 318-320): bonded or not, active switch, bonding request (karma), weapon focus link, limits and addiction. */
function FociPanel({ game, actor, own }: { game: GameView; actor: Actor; own: boolean }) {
  const foci = (actor.gear || []).filter((g) => focusKind(g));
  if (!foci.length) return null;
  const lim = fociLimits(actor);
  const busy = new Set(Object.values(game.magic?.sustained || {}).map((s) => (s.by?.kind === 'focus' ? s.by.gearId : '')).filter(Boolean));
  const melee = (actor.weapons || []).filter((w) => w.kind === 'melee');
  const bond = async (gearId: string) => {
    const r = await send<{ status?: string } | null>('training/request', { actorId: actor.id, kind: 'focus', target: gearId }).catch(() => null);
    if (r) toast(r.status === 'pending' ? t('Bonding request sent to the GM.') : t('Focus bonded.'), 'success');
  };
  return (
    <div className="mg-panel mg-foci">
      <div className="mg-panel-title">
        {t('Foci')} <BookRef source="SR5" page={318} />
        <span className={'small' + (lim.bonded > lim.maxBonded || lim.force > lim.maxForce ? ' amber' : ' muted')}>
          {t('bonded {n} / {max} · Force {f} / {maxF}', { n: lim.bonded, max: lim.maxBonded, f: lim.force, maxF: lim.maxForce })}
        </span>
      </div>
      {lim.addiction && <div className="small amber">{t('Active foci Force {a} above your Magic ({m}): risk of focus addiction (SR5 p. 319).', { a: lim.activeForce, m: lim.mag })}</div>}
      {foci.map((g) => {
        const k = focusKind(g) as FocusKind;
        const bonded = g.bonded !== false;
        return (
          <div className="mg-focus row spread" key={g.id}>
            <span>
              <b>{itemLabel(g)}</b> <Badge color="magenta">{t('Force {n}', { n: focusForce(g) })}</Badge> <span className="faint small">{t(FOCUS_LABELS[k])}</span>{' '}
              {bonded ? <Badge color="cyan">{t('bonded')}</Badge> : <Badge>{t('not bonded')}</Badge>}
              {busy.has(g.id) ? <> <Badge color="amber">{t('sustaining a spell')}</Badge></> : null}
            </span>
            <span className="row">
              {k === 'weapon' && own && (
                <Select value={g.choice || ''} onChange={(v) => void send('magic/focusWeapon', { actorId: actor.id, gearId: g.id, weaponId: v || null }).catch(() => null)}
                  options={[{ value: '', label: t('— weapon —') }, ...melee.map((w) => ({ value: w.id, label: itemLabel(w) }))]} title={t('The melee weapon this focus is')} />
              )}
              {!bonded && own && (
                <Button small variant="accent" onClick={() => void bond(g.id)} title={t('Force × {k} karma (SR5 p. 318)', { k: focusBondMultiplier(k) })}>
                  {t('Bond ({n} karma)', { n: focusForce(g) * focusBondMultiplier(k) })}
                </Button>
              )}
              {bonded && own && <Toggle value={!!g.active} onChange={(v) => void send('actor/updateItem', { actorId: actor.id, list: 'gear', itemId: g.id, patch: { active: v } }).catch(() => null)} label={t('active')} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Metamagics (SR5 pp. 325-326): the actor's, with what the app applies. */
function MetamagicPanel({ actor }: { actor: Actor }) {
  const list = actor.magic?.metamagics || [];
  if (!list.length) return null;
  const status: Record<string, string> = { auto: tk('applied'), some: tk('partly applied'), gm: tk('GM') };
  return (
    <div className="mg-panel mg-metamagic">
      <div className="mg-panel-title">
        {t('Metamagics')} <Badge color="magenta">{t('grade {n}', { n: initiateGrade(actor) })}</Badge> <RuleRef rule="initiation" />
      </div>
      {list.map((n, i) => {
        const d = metamagicDef(n);
        return (
          <div className="mg-mm" key={`${n}-${i}`}>
            <b>{d ? t(d.name) : n}</b> {d ? <Badge color={d.auto === 'gm' ? 'dim' : 'cyan'}>{t(status[d.auto])}</Badge> : <Badge>{t('GM')}</Badge>}{' '}
            {d ? <BookRef source="SR5" page={d.page} /> : null}
            {d ? <div className="faint small">{t(d.rule)}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Astral perception / projection (SR5 pp. 312-314): switches, the astral form's attributes, astral attack. */
function AstralPanel({ game, actor, own }: { game: GameView; actor: Actor; own: boolean }) {
  const gm = isGM(game);
  const mode = game.magic?.astral?.[actor.id]?.mode || null;
  const canPerceive = gm || canPerceiveAstral(actor);
  const canProject = gm || canProjectAstral(actor);
  const [attacking, setAttacking] = useState(false);
  if (!canPerceive) return null;
  const set = (m: string | null) => void send('magic/astral', { actorId: actor.id, mode: m, mapId: game.scene?.activeMapId }).catch(() => null);
  return (
    <div className={'mg-panel mg-astral' + (mode ? ' on' : '')}>
      <div className="mg-panel-title">
        {t('Astral plane')} <BookRef source="SR5" page={312} />
      </div>
      {own && (
        <div className="row wrap">
          {mode !== 'perceiving' && <Button small onClick={() => set('perceiving')} title={t('Simple Action: see auras and astral forms, become dual-natured (SR5 p. 312)')}>{t('Perceive')}</Button>}
          {canProject && mode !== 'projecting' && <Button small onClick={() => set('projecting')} title={t('Leave your body: your astral form moves on the map, your body stays empty (SR5 p. 313)')}>{t('Project')}</Button>}
          {mode && <Button small variant="accent" onClick={() => set(null)}>{t('Back to the physical plane')}</Button>}
          {mode && <Button small onClick={() => setAttacking(true)}>⚔ {t('Astral attack')}</Button>}
        </div>
      )}
      {mode === 'projecting' && (
        <div className="small">
          {t('Astral form: {list}', { list: Object.entries(ASTRAL_ATTRIBUTES).map(([p, m]) => `${attrShort(p)} → ${attrShort(m)} ${attr(actor, m)}`).join(' · ') })}
          <div className="amber">{t('Your body is empty and helpless while you project.')}</div>
        </div>
      )}
      {mode === 'perceiving' && <div className="small muted">{t('Dual-natured: you see astral forms and can be attacked on both planes.')}</div>}
      {attacking && <AstralAttackModal game={game} actor={actor} onClose={() => setAttacking(false)} />}
    </div>
  );
}

/** Cockpit of one awakened character. */
export function Cockpit({ game, actor }: { game: GameView; actor: Actor }) {
  const gm = isGM(game);
  const own = gm || (game.me?.characterIds || []).includes(actor.id);
  const [roll, setRoll] = useState<RollPreset | null>(null);
  const [casting, setCasting] = useState<string | null>(null);
  const [summoning, setSummoning] = useState(false);
  const [banishing, setBanishing] = useState(false);
  const [hintsOn, setHintsOn] = useHintsToggle();
  const open = (preset: RollPreset) => setRoll({ ...preset, _k: Date.now() });
  const mag = attr(actor, 'MAG');
  const d = derive(actor);
  const drain = drainAttr(actor);
  const pool = drainPool(actor);
  const sustained = sustainedBy(game.magic, actor.id);
  const astral = game.magic?.astral?.[actor.id]?.mode || null;
  const caster = usesTradition(actor);
  const spells = actor.spells || [];
  const hasSpellcasting = skillRating(actor, 'spellcasting') > 0;
  const skills = MAGIC_SKILLS.filter((s) => skillRating(actor, s.id) > 0);
  const powers = actor.powers || [];
  const pp = powers.reduce((s, p) => s + (Number(p.pp) || 0), 0);
  const hints = magicHints({ actor, magic: game.magic, spirits: spiritsOf(game, actor.id) });
  const pending = Object.values(game.magic?.pendingDrain || {}).filter((pd) => pd.actorId === actor.id);
  const mySustained = Object.values(game.magic?.sustained || {}).filter((s) => s.casterId === actor.id);
  const onMe = Object.values(game.magic?.sustained || {}).filter((s) => s.casterId !== actor.id && s.targetIds.includes(actor.id));
  return (
    <div className={'mg-cockpit' + (astral ? ' astral' : '')}>
      <div className="mg-bar">
        <div className="mg-id">
          <div className="mg-name">{actor.name}</div>
          <div className="small">{caster ? <TraditionPicker game={game} actor={actor} /> : <span className="muted">{t('Adept: no tradition, no Drain from spells')}</span>}</div>
        </div>
        <div className="mg-stats">
          <div className="mg-stat accent">
            <span className="mg-stat-l">{t('Magic')}</span>
            <b>{mag}</b>
          </div>
          {caster && (
            <button
              type="button"
              className="mg-stat clickable"
              disabled={!own || !pool}
              onClick={() => drain && open({ attr: 'WIL', attr2: drain, label: drainRollLabel(drain), limit: null, applyWounds: false, test: 'drainResist' })}
              title={pool ? t('Resist Drain: Willpower + {attr} (SR5 p. 282)', { attr: attrShort(drain) }) : t('Choose a tradition first')}
            >
              <span className="mg-stat-l">{t('Drain')}</span>
              <b>{pool ? pool.base : '—'}</b>
              <small>{pool ? `${attrShort('WIL')} + ${attrShort(drain)}` : t('no tradition')}</small>
            </button>
          )}
          <div className={'mg-stat' + (sustained ? ' warn' : '')} title={t('Each spell you sustain: −2 dice on every test (SR5 p. 282)')}>
            <span className="mg-stat-l">{t('Sustained')}</span>
            <b>{sustained}</b>
            <small>{sustained ? t('−{n} dice', { n: sustained * SUSTAIN_PENALTY }) : t('no penalty')}</small>
          </div>
          <div className="mg-stat" title={t('Astral initiative: Intuition × 2 + 3D6 (SR5 p. 314)')}>
            <span className="mg-stat-l">{t('Astral')}</span>
            <b>{astral === 'projecting' ? t('Projecting') : astral === 'perceiving' ? t('Perceiving') : t('Physical')}</b>
            <small>{t('init. {base} + {dice}D6', { base: d.astralInitiative.base, dice: d.astralInitiative.dice })}</small>
          </div>
        </div>
        <div className="mg-bar-btns">
          <Button small onClick={() => openSheet(actor.id)}>{t('Sheet')}</Button>
          {own && !gm && (
            <Button small variant={hintsOn ? 'accent' : 'ghost'} onClick={() => setHintsOn(!hintsOn)} title={t('Show or hide the hints (what to do next)')}>
              💡 {hintsOn ? t('Hints: on') : t('Hints: off')}
            </Button>
          )}
        </div>
      </div>
      {hintsOn && own && !gm && <HintsPanel hints={hints} />}
      {pending.length > 0 && (
        <div className="mg-panel mg-pending">
          <div className="mg-panel-title">{t('Drain to resist')}</div>
          {pending.map((pd) => (
            <div className="row" key={pd.id}>
              <span>
                {t('Drain {dv}', { dv: pd.dv })} <Badge color={pd.type === 'P' ? 'red' : 'amber'}>{pd.type === 'P' ? t('Physical') : t('Stun')}</Badge> <span className="muted small">{biText(pd.source)}</span>
              </span>
              <Button small variant="primary" disabled={!own} onClick={() => void send('magic/resistDrain', { id: pd.id }).catch(() => null)}>
                {t('Resist Drain')}
              </Button>
            </div>
          ))}
        </div>
      )}
      {(mySustained.length > 0 || onMe.length > 0) && (
        <div className="mg-panel mg-sustained-panel">
          {mySustained.length > 0 && (
            <>
              <div className="mg-panel-title">
                {t('Sustained spells: −{n} dice on all tests', { n: mySustained.length * SUSTAIN_PENALTY })} <RuleRef rule="spellcasting" />
              </div>
              <SustainedList game={game} list={mySustained} canDrop={() => own} quicken={gm || hasMetamagic(actor, 'quickening')} helpers={spiritsOf(game, actor.id).filter((sp) => sp.spirit.bound && sp.spirit.present !== false && sp.spirit.services > 0)} />
            </>
          )}
          {onMe.length > 0 && (
            <>
              <div className="mg-panel-title">{t('Spells on {name}', { name: actor.name })}</div>
              <SustainedList game={game} list={onMe} canDrop={() => gm} showCaster />
            </>
          )}
        </div>
      )}
      <AstralPanel game={game} actor={actor} own={own} />
      <FociPanel game={game} actor={actor} own={own} />
      <MetamagicPanel actor={actor} />
      <SpiritsPanel game={game} actor={actor} own={own} onSummon={own && skillRating(actor, 'summoning') > 0 ? () => setSummoning(true) : null} onBanish={own && skillRating(actor, 'banishing') > 0 ? () => setBanishing(true) : null} />
      <div className="mg-grid">
        {(spells.length > 0 || hasSpellcasting) && (
          <div className="mg-panel mg-spells">
            <div className="mg-panel-title">
              {t('Spells')} <RuleRef rule="spellcasting" />
            </div>
            {spells.length ? (
              <table className="sr">
                <thead>
                  <tr>
                    <th>{t('Spell')}</th>
                    <th>{t('Type')}</th>
                    <th>{t('Range')}</th>
                    <th>{t('Duration')}</th>
                    <th>{t('Drain')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {spells.map((sp) => (
                    <tr key={sp.id}>
                      <td>
                        <b>{itemLabel(sp)}</b> <ItemRef item={sp} />
                        <div className="faint small">{categoryLabel(sp)}</div>
                      </td>
                      <td>{sp.type}</td>
                      <td className="small">{sp.range}</td>
                      <td>{sp.duration}</td>
                      <td className="mono">{sp.drain}</td>
                      <td>
                        <Button small variant="accent" disabled={!own || !hasSpellcasting} onClick={() => setCasting(sp.id)} title={t('Choose the Force and the targets, roll, then resist the Drain')}>
                          {t('spell::Cast')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="muted small">{t('No spells.')}</div>
            )}
          </div>
        )}
        {skills.length > 0 && (
          <div className="mg-panel">
            <div className="mg-panel-title">{t('Magical skills')}</div>
            <div className="mg-skills">
              {skills.map((s) => (
                <button type="button" key={s.id} className="mg-skill" disabled={!own} onClick={() => open({ skillId: s.id, ...(s.limit === null ? { limit: null } : {}) })} title={t('Roll {skill} + Magic', { skill: t(s.label) })}>
                  <span>{t(s.label)}</span>
                  <b>{skillRating(actor, s.id) + mag}</b>
                </button>
              ))}
            </div>
          </div>
        )}
        {powers.length > 0 && (
          <div className="mg-panel">
            <div className="mg-panel-title">
              {t('Adept Powers')} <Badge color={pp > mag ? 'magenta' : 'cyan'}>{t('{pp} / {mag} PP', { pp, mag })}</Badge> <RuleRef rule="adeptPowers" />
            </div>
            <ul className="mg-powers">
              {powers.map((p) => (
                <li key={p.id}>
                  {itemLabel(p)}
                  {p.level ? ` ${p.level}` : ''} <ItemRef item={p} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {roll && <RollDialog game={game} actor={actor} preset={roll} onClose={() => setRoll(null)} />}
      {casting && <CastModal game={game} actor={actor} spellId={casting} onClose={() => setCasting(null)} />}
      {summoning && <SummonModal game={game} actor={actor} onClose={() => setSummoning(false)} />}
      {banishing && <BanishModal game={game} actor={actor} onClose={() => setBanishing(false)} />}
    </div>
  );
}

function PlayerMagic({ game }: GameProps) {
  const actors = magicActors(game);
  const [sel, setSel] = useState<string | null>(null);
  useMagicFocus(setSel);
  if (!actors.length) {
    return (
      <div className="page">
        <Empty>{t('None of your characters is awakened (no Magic rating).')}</Empty>
      </div>
    );
  }
  const cur = actors.find((a) => a.id === sel) || actors[0];
  return (
    <div className="page mg-page">
      <div className="page-title">
        <h2>{t('Magic')}</h2>
        {actors.length > 1 && <Tabs tabs={actors.map((a) => ({ id: a.id, label: a.name }))} value={cur.id} onChange={setSel} />}
      </div>
      <Cockpit game={game} actor={cur} />
    </div>
  );
}

/** GM: every awakened character at a glance. */
function Overview({ game, onCockpit }: { game: GameView; onCockpit: (id: string) => void }) {
  const actors = magicActors(game);
  if (!actors.length) return <Empty>{t('No awakened character (Magic rating above 0).')}</Empty>;
  return (
    <div className="mg-panel">
      <table className="sr mg-overview">
        <thead>
          <tr>
            <th>{t('Character')}</th>
            <th>{t('Magic')}</th>
            <th>{t('Tradition')}</th>
            <th>{t('Drain')}</th>
            <th>{t('Sustained')}</th>
            <th>{t('Astral')}</th>
            <th>{t('Spirits')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {actors.map((a) => {
            const pool = drainPool(a);
            const n = sustainedBy(game.magic, a.id);
            const astral = game.magic?.astral?.[a.id]?.mode;
            return (
              <tr key={a.id}>
                <td>
                  <b>{a.name}</b> {a.type === 'npc' ? <Badge>{t('NPC')}</Badge> : null}
                </td>
                <td className="num-cell">{attr(a, 'MAG')}</td>
                <td>{usesTradition(a) ? <TraditionPicker game={game} actor={a} compact /> : <span className="muted small">{t('Adept')}</span>}</td>
                <td className="num-cell">{pool ? `${pool.base} (${attrShort('WIL')} + ${attrShort(pool.attrs[1])})` : '—'}</td>
                <td className="num-cell">{n ? t('{n} (−{p} dice)', { n, p: n * SUSTAIN_PENALTY }) : '0'}</td>
                <td>{astral === 'projecting' ? t('Projecting') : astral === 'perceiving' ? t('Perceiving') : <span className="muted">{t('Physical')}</span>}</td>
                <td className="small">{spiritsOf(game, a.id).map((sp) => t('{name} ({n} serv.)', { name: sp.name, n: sp.spirit.services })).join(', ') || '—'}</td>
                <td>
                  <Button small onClick={() => onCockpit(a.id)}>{t('Cockpit')}</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="faint small">
        {t('Drain is resisted with Willpower + the tradition’s attribute (SR5 p. 282).')} <RuleRef rule="drain" />
      </p>
    </div>
  );
}

function GmMagicPage({ game }: GameProps) {
  const [tab, setTab] = usePersistent('sr.magic.tab', 'overview');
  const [cockpitId, setCockpitId] = usePersistent<string | null>('sr.magic.cockpit', null);
  const actors = magicActors(game);
  const openCockpit = (id: string) => {
    setCockpitId(id);
    setTab('cockpit');
  };
  useMagicFocus(openCockpit);
  const cur = actors.find((a) => a.id === cockpitId) || actors[0] || null;
  const active = Object.values(game.magic?.sustained || {});
  const tabs = [
    { id: 'overview', label: t('Overview') },
    { id: 'spells', label: t('Active spells'), badge: active.length || null },
    { id: 'ritual', label: t('Ritual') },
    { id: 'cockpit', label: t('Cockpit') },
  ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'overview';
  return (
    <div className="page mg-page">
      <div className="page-title">
        <h2>{t('Magic')}</h2>
        <div className="row wrap">
          <Toggle
            value={game.magic?.settings?.autoDrain !== false}
            onChange={(v) => void send('magic/settings', { autoDrain: v }).catch(() => null)}
            label={t('Resist Drain automatically')}
            title={t('On: Drain is rolled right after the cast. Off: the caster clicks « Resist Drain » (SR5 p. 282)')}
          />
          <Button small onClick={async () => { if (await confirmAction(t('Sunrise or sunset: every unbound spirit leaves. Continue?'))) void send('magic/sunrise', {}).catch(() => null); }} title={t('Unbound spirits leave at sunrise and sunset (SR5 p. 300)')}>
            ☀ {t('Sunrise / sunset')}
          </Button>
        </div>
      </div>
      <Tabs tabs={tabs} value={current} onChange={setTab} className="mg-tabs" />
      {current === 'overview' && <Overview game={game} onCockpit={openCockpit} />}
      {current === 'ritual' && <RitualPanel game={game} />}
      {current === 'spells' &&
        (active.length ? (
          <div className="mg-panel">
            <SustainedList game={game} list={active} canDrop={() => true} showCaster />
          </div>
        ) : (
          <Empty>{t('No spell is being sustained.')}</Empty>
        ))}
      {current === 'cockpit' &&
        (cur ? (
          <div>
            <div className="row wrap mg-gm-row">
              <span className="faint small">{t('Character:')}</span>
              {actors.map((a) => (
                <button type="button" key={a.id} className={'mg-pill' + (a.id === cur.id ? ' on' : '')} onClick={() => setCockpitId(a.id)}>
                  {a.name}
                </button>
              ))}
            </div>
            <Cockpit game={game} actor={cur} />
          </div>
        ) : (
          <Empty>{t('No awakened character (Magic rating above 0).')}</Empty>
        ))}
    </div>
  );
}

export default function MagicPage({ game }: GameProps) {
  if (!game.magic) {
    return (
      <div className="page">
        <Empty>{t('The magic module is not loaded on the server.')}</Empty>
      </div>
    );
  }
  return isGM(game) ? <GmMagicPage game={game} /> : <PlayerMagic game={game} />;
}

