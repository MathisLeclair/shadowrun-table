// Initiative tracker (right dock, GM + players). Server logic: server/modules/30-combat.js.
import { useState, type MouseEvent, type SyntheticEvent } from 'react';
import { Button, IconButton, Badge, Select, confirmAction, promptText } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { useUI, setUI, openSheet, toast } from '../../lib/ui-store.ts';
import { t, tn, tk } from '../../lib/i18n.ts';
import { initModeOptions, initModeLabel, dispoLabel, initials, avatarStyle, safeDerive, MonitorBar, rollTooltip, parseDamageInput } from './combat-common.tsx';
import ActionCounter from './ActionCounter.tsx';
import { phaseUsage, phaseLeft } from '../../../shared/combat.ts';
import type { ActorLike } from './types.ts';
import type { CombatEntry, CombatState, GameView, InitMode, ViewActor } from '../../../shared/types.ts';
import './combat.css';

/** Fire an action; errors are already toasted by send(). */
const act = (type: string, payload: object = {}) => send(type, payload).catch(() => null);

/** Initiative formula for an actor in a given mode (mirrors the server). */
function initFormula(actor: ViewActor | null | undefined, mode: InitMode) {
  const d = safeDerive(actor as ActorLike | undefined);
  if (!d) return null;
  if (mode === 'astral') return d.astralInitiative;
  if (mode === 'cold') return d.matrixInitiative.cold;
  if (mode === 'hot') return d.matrixInitiative.hot;
  return d.initiative;
}

function stop(ev: SyntheticEvent) {
  ev.stopPropagation();
}

/** Full sheet of an actor (players get NPC stubs without attributes). */
const fullActor = (a: ViewActor | null | undefined) => (a && 'attributes' in a ? a : null);

// ---------------------------------------------------------------------------
// No combat running
// ---------------------------------------------------------------------------
function Idle({ game, isGM, selected }: { game: GameView; isGM: boolean; selected: string[] }) {
  if (!isGM) {
    return (
      <div className="cbt">
        <div className="cbt-start">
          <h3>{t('Initiative')}</h3>
          <div className="muted">{t('No combat in progress. Enjoy the calm, chummer.')}</div>
          <div className="cbt-legend">{t('When the GM starts a combat, your initiative and your turn will show up here.')}</div>
        </div>
      </div>
    );
  }
  const mapId = game.scene?.activeMapId;
  const map = mapId ? game.maps?.[mapId] : null;
  const tokens = (map?.tokens || []).filter((tok) => tok.actorId && game.actors[tok.actorId]);
  const visible = tokens.filter((tok) => !tok.hidden);
  const hiddenCount = tokens.length - visible.length;
  const startWithSelection = async () => {
    const res = await act('combat/start', { includeMapTokens: false });
    if (res) await act('combat/add', { tokenIds: selected });
  };
  return (
    <div className="cbt">
      <div className="cbt-start">
        <h3>{t('New combat')}</h3>
        <div className="small muted">
          {map ? (
            <>
              {t('Active map:')} <strong className="cyan">{map.name}</strong> — {tn(visible.length, '{n} token with a sheet', '{n} tokens with a sheet')}
              {hiddenCount ? (
                <>
                  , <span className="faint">{tn(hiddenCount, '{n} hidden (add them later)', 'pl::{n} hidden (add them later)')}</span>
                </>
              ) : (
                ''
              )}
              .
            </>
          ) : (
            t('No active map: the combat will start empty.')
          )}
        </div>
        <Button variant="primary" className="cbt-next" disabled={!visible.length} onClick={() => act('combat/start', {})}>
          ⚔ {t('Start the combat ({n})', { n: visible.length })}
        </Button>
        <div className="cbt-tools">
          {selected.length > 0 && (
            <Button small onClick={startWithSelection}>
              {t('With the selection ({n})', { n: selected.length })}
            </Button>
          )}
          <Button small variant="ghost" onClick={() => act('combat/start', { includeMapTokens: false })}>
            {t('Empty combat')}
          </Button>
        </div>
        <div className="cbt-legend">{t('NPCs roll their initiative automatically; runners roll their own.')}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Banners (players and GM for their own characters)
// ---------------------------------------------------------------------------
/** Matrix entries (IC of a host, a decker's agent) have no sheet: kept in sync by the matrix module. */
const isMatrixEntry = (e: CombatEntry | null | undefined) => e?.kind === 'ic' || e?.kind === 'agent';
/** Every Simple / Complex Action of the pass is used (time to end the turn). */
const phaseDone = (e: CombatEntry | null | undefined) => !!e && phaseLeft(phaseUsage(e.spent)).simple === 0;
/** Display name: Matrix entries carry a translatable name. */
const entryName = (e: CombatEntry | null | undefined): string => (e?.nameI18n?.t ? t(e.nameI18n.t, e.nameI18n.params) : e?.name || '');

function YourTurn({ e }: { e: CombatEntry }) {
  return (
    <div className="cbt-banner cbt-yourturn">
      <div className="cbt-banner-title">{t('It’s your turn!')}</div>
      <div className="small">
        {entryName(e)} · {t('initiative')} <strong className="mono">{e.score}</strong>
      </div>
      {e.kind === 'agent' && <div className="small muted">{t('Your agent acts: pick its action in the cockpit (“Let my agent act”).')}</div>}
      {phaseDone(e) && <div className="small cbt-done">{t('All your actions of this pass are used: end your turn.')}</div>}
      <div className="row wrap">
        <Button variant="accent" className={phaseDone(e) ? 'cbt-ready' : undefined} onClick={() => act('combat/next', { entryId: e.id })}>
          {t('End my turn')} ✓
        </Button>
        <Button small variant="ghost" title={t('Delay your action: you can act later in the pass')} onClick={() => act('combat/delay', { entryId: e.id })}>
          {t('Delay')}
        </Button>
      </div>
    </div>
  );
}

function RollBanner({ e, actor }: { e: CombatEntry; actor: ViewActor | undefined }) {
  const mode = e.mode || 'physical';
  const f = initFormula(actor, mode);
  const edge = fullActor(actor)?.edge?.current ?? 0;
  return (
    <div className="cbt-banner cbt-toroll">
      <div className="cbt-banner-title">{t('Roll your initiative')}</div>
      <div className="small">
        {e.name}
        {f ? (
          <>
            {' '}
            · <span className="mono">
              {f.base} + {f.dice}D6
            </span>
          </>
        ) : (
          ''
        )}
      </div>
      <div className="row wrap">
        <Button variant="primary" onClick={() => act('combat/roll', { entryId: e.id })}>
          🎲 {t('Roll')}
          {f ? ` (${f.base} + ${f.dice}D6)` : ''}
        </Button>
        <Button small disabled={edge < 1} title={t('Blitz: spend 1 Edge point to roll 5D6 this turn')} onClick={() => act('combat/roll', { entryId: e.id, blitz: true })}>
          {t('Blitz (1 Edge)')}
        </Button>
        <Select className="grow" value={mode} options={initModeOptions()} title={t('Initiative type')} onChange={(m) => act('combat/setMode', { entryId: e.id, mode: m })} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One participant
// ---------------------------------------------------------------------------
interface EntryRowProps {
  e: CombatEntry;
  game: GameView;
  c: CombatState;
  isGM: boolean;
  own: boolean;
  open: boolean;
  onToggle: () => void;
}
function EntryRow({ e, game, c, isGM, own, open, onToggle }: EntryRowProps) {
  const [editing, setEditing] = useState(false);
  const viewActor = e.actorId ? game.actors?.[e.actorId] : undefined;
  const actor = fullActor(viewActor);
  const matrixE = isMatrixEntry(e);
  const name = entryName(e);
  const showMonitor = isGM || own;
  const d = showMonitor ? safeDerive(actor) : null;
  const isCurrent = c.currentId === e.id;
  const spent = !e.toRoll && e.score <= 0;
  const canControl = isGM || own;
  const edge = actor?.edge?.current ?? 0;
  const cls = ['cbt-entry', 'd-' + (e.disposition || 'hostile'), isCurrent && 'current', e.acted && 'acted', spent && 'spent', e.out && 'out', e.down && 'down', e.hidden && 'hiddenE', own && 'mineE']
    .filter(Boolean)
    .join(' ');

  const focus = () => {
    // On phones the dock covers the map: close it so the focused token is visible.
    if (e.tokenId) setUI({ focusTokenId: e.tokenId, mainTab: 'map', ...(window.innerWidth <= 900 ? { dockOpen: false } : {}) });
    else if (matrixE) setUI({ mainTab: 'matrix' });
    else if (isGM && viewActor) openSheet(e.actorId);
  };
  const icAct = () => act('matrix/icTurn', { hostId: e.hostId, icId: e.icId, entryId: e.id });
  const commitScore = (v: string) => {
    setEditing(false);
    const n = Number(v);
    if (String(v).trim() === '' || !Number.isFinite(n) || n === e.score) return;
    act('combat/setScore', { entryId: e.id, score: Math.round(n) });
  };
  const damage = async () => {
    const txt = await promptText(t('Damage for {name} (e.g. 5P, 3S; negative to heal: -2P)', { name: e.name }), '');
    if (txt === null || txt === undefined || !String(txt).trim()) return;
    const p = parseDamageInput(txt);
    if (!p) return toast(t('Expected format: 5P, 3S or -2P'), 'warn');
    if (p.amount > 0) act('actor/damage', { actorId: e.actorId, amount: p.amount, type: p.type });
    else act('actor/heal', { actorId: e.actorId, amount: -p.amount, type: p.type });
  };
  const remove = async () => {
    if (await confirmAction(t('Remove {name} from the combat?', { name }))) act('combat/remove', { entryId: e.id });
  };

  let score;
  if (editing && isGM) {
    score = (
      <input
        className="input cbt-score-input"
        type="number"
        defaultValue={e.toRoll ? '' : e.score}
        autoFocus
        onClick={stop}
        onBlur={(ev) => commitScore(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
          if (ev.key === 'Escape') setEditing(false);
        }}
      />
    );
  } else {
    const scls = 'cbt-score' + (isGM ? ' editable' : '') + (e.toRoll ? ' toroll' : '') + (spent ? ' low' : '');
    score = (
      <button
        className={scls}
        title={rollTooltip(e, c.pass) + (isGM ? '\n' + t('(click: edit the score)') : '')}
        onClick={(ev) => {
          stop(ev);
          if (isGM) setEditing(true);
        }}
      >
        {e.toRoll ? '…' : e.score}
      </button>
    );
  }

  return (
    <div className={cls + (matrixE ? ' cbt-matrix' : '')} onClick={focus} title={e.tokenId ? t('Center the map on this token') : matrixE ? t('Open the Matrix') : ''}>
      <div className="cbt-main">
        <div className="cbt-avatar" style={matrixE ? undefined : avatarStyle(viewActor?.portrait, viewActor?.color)}>
          {matrixE ? (e.kind === 'ic' ? '⛨' : '◈') : viewActor?.portrait ? '' : initials(e.name)}
        </div>
        <div className="cbt-name">
          <strong>{name}</strong>
          <div className="cbt-tags">
            {e.kind === 'ic' && (
              <Badge color="magenta" title={t('A host’s IC (initiative: rating × 2 + 4D6)')}>
                {t('IC')}
              </Badge>
            )}
            {e.kind === 'agent' && (
              <Badge color="cyan" title={t('The decker’s agent (initiative: Data Processing + rating + 4D6)')}>
                {t('Agent')}
              </Badge>
            )}
            {isCurrent && <Badge color="cyan">{t('turn::Acting')}</Badge>}
            {e.toRoll && <Badge color="amber">{t('To roll')}</Badge>}
            {e.delayed && (
              <Badge color="amber" title={t('Delayed action')}>
                {t('combat::Holding')}
              </Badge>
            )}
            {e.acted && !isCurrent && <Badge>{t('Acted')}</Badge>}
            {e.seized && (
              <Badge color="magenta" title={t('Seized the initiative this turn')}>
                {t('Seized')}
              </Badge>
            )}
            {spent && !e.out && <Badge title={t('Score ≤ 0: no more actions this turn')}>{t('Out of pass')}</Badge>}
            {e.down && <Badge color="red">{t('KO')}</Badge>}
            {e.out && <Badge>{t('Out')}</Badge>}
            {e.hidden && <Badge title={t('Invisible to players')}>{t('Hidden')}</Badge>}
            {e.mode && e.mode !== 'physical' && <Badge color="cyan">{initModeLabel(e.mode)}</Badge>}
            {isGM && e.disposition && e.disposition !== 'pc' && e.disposition !== 'hostile' && (
              <Badge color={e.disposition === 'ally' ? 'green' : 'amber'}>{dispoLabel(e.disposition)}</Badge>
            )}
          </div>
        </div>
        {score}
        {canControl && (
          <IconButton
            className="cbt-more"
            icon={open ? '▴' : '⋯'}
            title={t('Actions')}
            onClick={(ev: MouseEvent) => {
              stop(ev);
              onToggle();
            }}
          />
        )}
      </div>

      {!e.toRoll && !e.out && (isCurrent || e.delayed || open || (e.spent?.length ?? 0) > 0) && (
        <ActionCounter e={e} canControl={canControl} menu={isCurrent || e.delayed || open} />
      )}

      {isGM && isCurrent && e.kind === 'ic' && !e.out && (
        <div className="row" onClick={stop}>
          <Button small variant="danger" title={t('The IC attacks the best-known intruder, then the turn passes')} onClick={icAct}>
            ⚡ {t('Act and pass')}
          </Button>
        </div>
      )}
      {e.delayed && canControl && (
        <div className="row" onClick={stop}>
          <Button small variant="primary" onClick={() => act('combat/act', { entryId: e.id })}>
            {t('Act now')}
          </Button>
        </div>
      )}

      {d && actor && (
        <div className="cbt-mon" onClick={stop}>
          <MonitorBar label={t('monitor::P')} kind="p" value={actor.condition?.physical} max={d.physicalMonitor} />
          <MonitorBar label={t('monitor::S')} kind="s" value={actor.condition?.stun} max={d.stunMonitor} />
          {isGM && (
            <div className="cbt-dmg">
              <Button small title={t('1 box of Physical damage')} onClick={() => act('actor/damage', { actorId: e.actorId, amount: 1, type: 'P' })}>
                {t('+1P')}
              </Button>
              <Button small title={t('1 box of Stun damage')} onClick={() => act('actor/damage', { actorId: e.actorId, amount: 1, type: 'S' })}>
                {t('+1S')}
              </Button>
              <Button small title={t('Custom damage or healing')} onClick={damage}>
                ± …
              </Button>
              <Button small variant="ghost" title={t('Open the sheet')} onClick={() => openSheet(e.actorId)}>
                {t('Sheet')}
              </Button>
            </div>
          )}
        </div>
      )}

      {open && canControl && (
        <div className="cbt-actions" onClick={stop}>
          {e.toRoll && (own || isGM) && (
            <Button small variant="primary" onClick={() => act('combat/roll', { entryId: e.id })}>
              {t('Roll')}
            </Button>
          )}
          {!e.toRoll && isGM && (
            <Button small title={t('Reroll the initiative')} onClick={() => act('combat/roll', { entryId: e.id })}>
              {t('Relaunch')}
            </Button>
          )}
          {!e.toRoll && !matrixE && (
            <>
              <Button small title={t('Dodge, parry, block, intercept (−5)')} onClick={() => act('combat/adjust', { entryId: e.id, delta: -5, label: tk('Dodge / parry') })}>
                {t('−5 Dodge')}
              </Button>
              <Button small title={t('Full defense (−10)')} onClick={() => act('combat/adjust', { entryId: e.id, delta: -10, label: tk('Full defense') })}>
                {t('−10 Full defense')}
              </Button>
            </>
          )}
          {!e.seized && !matrixE && (
            <Button small disabled={edge < 1} title={t('Seize the initiative: 1 Edge point, acts first this turn')} onClick={() => act('combat/seize', { entryId: e.id })}>
              {t('Seize the Initiative')}
            </Button>
          )}
          {isCurrent && (
            <Button small onClick={() => act('combat/delay', { entryId: e.id })}>
              {t('Delay')}
            </Button>
          )}
          {!matrixE && (
            <Select value={e.mode || 'physical'} options={initModeOptions()} title={t('Initiative type (next roll)')} onChange={(m) => act('combat/setMode', { entryId: e.id, mode: m })} />
          )}
          {isGM && (
            <>
              {e.hidden && (
                <Button small variant="accent" onClick={() => act('combat/reveal', { entryId: e.id })}>
                  {t('Reveal')}
                </Button>
              )}
              <Button small variant="ghost" onClick={() => act('combat/setOut', { entryId: e.id, out: !e.out })}>
                {e.out ? t('Bring back') : t('Out of combat')}
              </Button>
              <Button small variant="danger" onClick={remove}>
                {t('Remove')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------
export default function CombatDock({ game }: GameProps) {
  const ui = useUI();
  const [openId, setOpenId] = useState<string | null>(null);
  const isGM = game.me.role === 'gm';
  const c: CombatState = game.combat || ({ active: false, entries: [] } as unknown as CombatState);
  const selectedAll: string[] = ui.selectedTokenIds || [];
  if (!c.active) return <Idle game={game} isGM={isGM} selected={selectedAll} />;

  const mine = new Set<string | null | undefined>(game.me.characterIds || []);
  const entries = c.entries || [];
  const current = entries.find((e) => e.id === c.currentId) || null;
  const myCurrent = current && (mine.has(current.actorId) || mine.has(current.ownerId)) ? current : null;
  const myToRoll = entries.filter((e) => mine.has(e.actorId) && e.toRoll && !e.out);
  const pending = entries.filter((e) => e.toRoll && !e.out && !e.down);
  const npcPending = pending.filter((e) => e.kind !== 'pc');
  const selected = selectedAll.filter((id) => !entries.some((e) => e.tokenId === id));

  const next = async () => {
    if (!current && pending.length) {
      const ok = await confirmAction(t('{n} participant(s) haven’t rolled their initiative ({names}). Start anyway?', { n: pending.length, names: pending.map((e) => e.name).join(', ') }));
      if (!ok) return;
    }
    act('combat/next', { entryId: c.currentId || undefined });
  };
  const newTurn = async () => {
    if (await confirmAction(t('Move to the next combat turn? Everyone rerolls their initiative.'))) act('combat/newTurn');
  };
  const end = async () => {
    if (await confirmAction(t('End the combat?'))) act('combat/end');
  };

  let waiting: string | null = null;
  if (!current) {
    if (pending.length) waiting = t('Waiting for initiative rolls: {names}.', { names: pending.map((e) => e.name).join(', ') });
    else if (entries.length) waiting = isGM ? t('Everyone has rolled: click « Start ».') : t('The GM has the hand…');
  }

  return (
    <div className="cbt">
      <div className="cbt-head">
        <div className="cbt-round">
          <strong>{t('Turn {n}', { n: c.round })}</strong>
          <span>{t('Pass {n}', { n: c.pass })}</span>
        </div>
        {isGM && (
          <div className="cbt-tools">
            <IconButton icon="↶" title={t('Undo the last turn change')} onClick={() => act('combat/prev')} />
            <IconButton icon="✕" title={t('End the combat')} onClick={end} />
          </div>
        )}
      </div>

      {isGM && (
        <div className="col gap-s">
          <Button variant="primary" className={'cbt-next' + (phaseDone(current) ? ' cbt-ready' : '')} disabled={!entries.length} onClick={next} title={phaseDone(current) ? t('{name} has used every action of this pass', { name: entryName(current) }) : undefined}>
            {current ? t('Next turn') : t('Start')} ▶
          </Button>
          <div className="cbt-tools">
            {npcPending.length > 0 && (
              <Button small onClick={() => act('combat/rollAll', { npcOnly: true })}>
                🎲 {t('Roll the NPCs ({n})', { n: npcPending.length })}
              </Button>
            )}
            {pending.length > npcPending.length && (
              <Button small title={t('The GM rolls for the players who haven’t rolled yet')} onClick={() => act('combat/rollAll', {})}>
                🎲 {t('Roll all')}
              </Button>
            )}
            <Button small onClick={newTurn} title={t('New combat turn: everyone rerolls')}>
              {t('New turn')}
            </Button>
            {selected.length > 0 && (
              <Button small variant="accent" onClick={() => act('combat/add', { tokenIds: selected })}>
                {t('+ Selection ({n})', { n: selected.length })}
              </Button>
            )}
          </div>
        </div>
      )}

      {myCurrent && <YourTurn e={myCurrent} />}
      {myToRoll.map((e) => (
        <RollBanner key={'roll-' + e.id} e={e} actor={e.actorId ? game.actors?.[e.actorId] : undefined} />
      ))}
      {waiting && <div className="cbt-wait">{waiting}</div>}

      <div className="cbt-list">
        {entries.map((e) => (
          <EntryRow
            key={e.id}
            e={e}
            game={game}
            c={c}
            isGM={isGM}
            own={mine.has(e.actorId) || mine.has(e.ownerId)}
            open={openId === e.id}
            onToggle={() => setOpenId(openId === e.id ? null : e.id)}
          />
        ))}
      </div>
      {!entries.length && (
        <div className="cbt-empty">
          {isGM
            ? t('No participants: select tokens on the map then « + Selection », or spawn NPCs from the bestiary.')
            : t('No visible participant yet.')}
        </div>
      )}
      <div className="cbt-legend">{t('Click a participant: center the map · hover the score: roll details')}</div>
    </div>
  );
}
