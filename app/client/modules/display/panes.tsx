// Read-only panes of a table display (besides the map): initiative order, public rolls, a handout. Everything comes
// from the display's own view, which the server built like a player's (no hidden entries, whispers or secret rolls).
import { Markdown } from '../../lib/ui.tsx';
import { t, tn, logText } from '../../lib/i18n.ts';
import { DiceFaces, RollBadges, rollLabel } from '../sheet/common.tsx';
import type { CombatEntry, GameView, LogEntry, PlayerHandout } from '../../../shared/types.ts';
import type { ShownRoll } from '../sheet/types.ts';

const entryName = (e: CombatEntry): string => (e.nameI18n?.t ? t(e.nameI18n.t, e.nameI18n.params) : e.name || '');
const entryColor = (game: GameView, e: CombatEntry): string => (e.actorId && game.actors?.[e.actorId]?.color) || (e.kind === 'pc' ? 'var(--cyan)' : 'var(--red)');

function liveEntries(game: GameView): CombatEntry[] {
  return (game.combat?.entries || []).filter((e) => !e.out);
}

/** Initiative order, one big row per participant. */
export function InitiativePane({ game }: { game: GameView }) {
  const c = game.combat;
  if (!c?.active) return <div className="dsp-empty">{t('No combat in progress')}</div>;
  const entries = liveEntries(game);
  return (
    <div className="dsp-pane dsp-init">
      <div className="dsp-pane-title">
        {t('Turn {n}', { n: c.round })} · {t('Pass {n}', { n: c.pass })}
      </div>
      <ol className="dsp-init-list">
        {entries.map((e) => (
          <li key={e.id} className={'dsp-init-row' + (e.id === c.currentId ? ' current' : '') + (e.acted ? ' acted' : '') + (e.down ? ' down' : '')}>
            <span className="dsp-init-dot" style={{ background: entryColor(game, e) }}></span>
            <span className="dsp-init-name">{entryName(e)}</span>
            <span className="dsp-init-score">{e.toRoll ? '…' : e.score}</span>
          </li>
        ))}
      </ol>
      {!entries.length && <div className="dsp-empty small">{t('No visible participant yet.')}</div>}
    </div>
  );
}

/** Initiative strip under the panes while a combat runs. */
export function InitiativeStrip({ game }: { game: GameView }) {
  const c = game.combat;
  if (!c?.active) return null;
  const entries = liveEntries(game);
  if (!entries.length) return null;
  return (
    <div className="dsp-strip">
      <span className="dsp-strip-round">{t('Turn {n}', { n: c.round })} · {t('Pass {n}', { n: c.pass })}</span>
      {entries.map((e) => (
        <span key={e.id} className={'dsp-strip-chip' + (e.id === c.currentId ? ' current' : '') + (e.acted ? ' acted' : '')} style={{ borderColor: entryColor(game, e) }}>
          {entryName(e)}
          <b>{e.toRoll ? '…' : e.score}</b>
        </span>
      ))}
    </div>
  );
}

/** Last public rolls (newest first). */
export function RollsPane({ game }: { game: GameView }) {
  const rolls = (game.log || []).filter((e: LogEntry) => e.roll && !e.to && !e.gmOnly).slice(-8).reverse();
  if (!rolls.length) return <div className="dsp-empty">{t('No rolls yet')}</div>;
  return (
    <div className="dsp-pane dsp-rolls">
      {rolls.map((e) => {
        const r = e.roll as ShownRoll;
        const color = (r.actorId && game.actors?.[r.actorId]?.color) || 'var(--cyan)';
        return (
          <div key={e.id} className="dsp-roll">
            <div className="dsp-roll-head">
              <span className="dsp-roll-who" style={{ color }}>
                {e.author === 'MJ' ? t('GM') : e.author}
              </span>
              <span className="dsp-roll-label">{rollLabel(r) || logText(e)}</span>
              {typeof r.hits === 'number' ? (
                <span className={'dsp-roll-hits' + (r.critGlitch ? ' crit' : r.glitch ? ' glitch' : '')}>
                  {r.hits} <small>{tn(r.hits, 'one::hit', 'other::hits')}</small>
                </span>
              ) : r.total !== undefined ? (
                <span className="dsp-roll-hits">{r.total}</span>
              ) : null}
            </div>
            <DiceFaces roll={r} />
            <RollBadges roll={r} />
          </div>
        );
      })}
    </div>
  );
}

/** Handout the GM shows (else the newest one revealed to every player). */
export function shownHandout(game: GameView): PlayerHandout | null {
  const list = ((game.campaign?.handouts || []) as PlayerHandout[]).filter((h) => h.toAll);
  const id = game.display?.handoutId;
  if (id) return list.find((h) => h.id === id) || null;
  return list.reduce<PlayerHandout | null>((best, h) => (!best || (h.revealedAt || 0) > (best.revealedAt || 0) ? h : best), null);
}

export function HandoutView({ handout }: { handout: PlayerHandout | null }) {
  if (!handout) return <div className="dsp-empty">{t('No handout shown')}</div>;
  return (
    <div className="dsp-pane dsp-handout">
      <h1 className="dsp-handout-title">{handout.title}</h1>
      {handout.image && <img className="dsp-handout-img" src={handout.image} alt={handout.title} />}
      {handout.body && <Markdown className="dsp-handout-body" text={handout.body} />}
    </div>
  );
}
