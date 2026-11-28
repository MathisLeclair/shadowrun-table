// « Magic » tab: cockpit of an awakened character for players, overview + cockpit of every awakened character for the GM.
// Design and the flows still to come (cast, sustain, summon, astral, foci): docs/design/magic.md.
import { useEffect, useState } from 'react';
import { Tabs, Empty, Button, Badge } from '../../lib/ui.tsx';
import { useUI, openSheet } from '../../lib/ui-store.ts';
import type { GameProps } from '../../lib/net.ts';
import { t, tk, attrShort } from '../../lib/i18n.ts';
import { attr, derive } from '/shared/sr5.ts';
import { drainAttr, drainPool, sustainedBy, usesTradition, magicHints, SUSTAIN_PENALTY, type MagicHint } from '/shared/magic.ts';
import { RollDialog } from '../sheet/RollDialog.tsx';
import { RuleRef, ItemRef } from '../books/BookRef.tsx';
import { categoryLabel, itemLabel } from '../sheet/common.tsx';
import { isGM, magicActors, drainRollLabel, spellRollLabel, TraditionPicker } from './common.tsx';
import type { RollPreset } from '../sheet/types.ts';
import type { Actor, GameView } from '../../../shared/types.ts';
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

/** Cockpit of one awakened character. */
export function Cockpit({ game, actor }: { game: GameView; actor: Actor }) {
  const gm = isGM(game);
  const own = gm || (game.me?.characterIds || []).includes(actor.id);
  const [roll, setRoll] = useState<RollPreset | null>(null);
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
  const hints = magicHints({ actor, magic: game.magic });
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
          <div className="mg-stat" title={t('Astral initiative: Intuition × 2 + 2D6 (SR5 p. 159)')}>
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
                        <Button small variant="accent" disabled={!own || !hasSpellcasting} onClick={() => open({ skillId: 'spellcasting', label: spellRollLabel(sp.name), limit: null })} title={t('Spellcasting + Magic (limit = Force, set it yourself)')}>
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
  const tabs = [
    { id: 'overview', label: t('Overview') },
    { id: 'cockpit', label: t('Cockpit') },
  ];
  const current = tabs.some((x) => x.id === tab) ? tab : 'overview';
  return (
    <div className="page mg-page">
      <div className="page-title">
        <h2>{t('Magic')}</h2>
      </div>
      <Tabs tabs={tabs} value={current} onChange={setTab} className="mg-tabs" />
      {current === 'overview' && <Overview game={game} onCockpit={openCockpit} />}
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

