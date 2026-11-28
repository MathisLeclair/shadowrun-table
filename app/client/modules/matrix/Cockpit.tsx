// Decker cockpit: connection mode, ASDF configuration, programs, agent, Overwatch, marks, current host, actions.
import { useEffect, useState } from 'react';
import { Button, Badge, Select, TextInput, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { goTab, toast } from '../../lib/ui-store.ts';
import { t, getLang } from '../../lib/i18n.ts';
import { attr } from '/shared/sr5.ts';
import {
  ASDF, MODES, ACTIONS, ACTION_CATS, ACTION_TYPES, IC_TYPES, PROGRAM_BY_ID,
  deckStats, actionPool, matrixInitiative, agentInitiative, programSlots, availablePrograms, detectAgents, isIllegal,
  isCyberdeck, matrixMonitor, programId, DEVICE_LINK_KINDS, DEVICE_CMD_LABELS, nextStepHints, deviceWorks, ACTION_BY_ID, convergenceAt,
  type PersonaView, type StepHint,
} from './types.ts';
import type { AsdfKey } from '../../../shared/types.ts';
import {
  isGM, act, personaOf, OsMeter, MatrixMonitor, MatrixLog, marksDots, actionName, icName, markName, linkLockName, programLabel,
  asdfShort, asdfLabel, modeLabel, marksText, assistText, agentLabel, deviceLinkState, linkStateText, isFullActor, hostOf, hostsOf, hostMap,
} from './common.tsx';
import ActionModal, { type ActionPreset } from './ActionModal.tsx';
import { ProgramRef } from './common.tsx';
import type { Actor, GameView, MatrixMarkOnMe, MatrixMode } from '../../../shared/types.ts';
import { BookRef, RuleRef } from '../books/BookRef.tsx';

const CAT_ORDER = ['attack', 'sleaze', 'info', 'control', 'util'];

/** Opens the « Lancer » dialog of an action. */
type OpenAction = (actionId: string, preset?: ActionPreset) => void;

/** Keep the combat tracker's initiative type in sync with the connection mode (silently; combat module action). */
function syncCombatMode(game: GameView, actorId: string, mode: string) {
  const c = game.combat;
  if (!c?.active) return;
  const e = (c.entries || []).find((x) => x.actorId === actorId);
  if (e && e.mode !== mode) send('combat/setMode', { entryId: e.id, mode }, { silent: true }).catch(() => {});
}

interface PanelProps {
  actor: Actor;
  persona: PersonaView;
}

function ModeSwitch({ game, actor, persona, onJackOut }: PanelProps & { game: GameView; onJackOut: () => void }) {
  const cur = persona.online ? persona.mode : 'off';
  const choose = async (mode: MatrixMode | 'off') => {
    if (mode === 'off') {
      if (!persona.online) return;
      if (persona.linkLocked) return onJackOut();
      await act('matrix/disconnect', { actorId: actor.id });
      syncCombatMode(game, actor.id, 'physical');
      return;
    }
    const r = await act('matrix/connect', { actorId: actor.id, mode });
    if (r) syncCombatMode(game, actor.id, mode);
  };
  const opts: Array<{ id: MatrixMode | 'off'; label: string }> = [{ id: 'off', label: t('Offline') }, ...MODES.map((m) => ({ id: m, label: modeLabel(m) }))];
  return (
    <div className="mx-modes" role="radiogroup" aria-label={t('Connection mode')}>
      {opts.map((o) => {
        const ini = o.id === 'off' ? null : matrixInitiative(actor, persona, o.id);
        return (
          <button
            type="button"
            key={o.id}
            role="radio"
            aria-checked={cur === o.id}
            className={'mx-mode mx-mode-' + o.id + (cur === o.id ? ' on' : '')}
            disabled={persona.bricked && o.id !== 'off'}
            onClick={() => choose(o.id)}
            title={o.id === 'hot' ? t('+2 dice on Matrix actions, Physical biofeedback') : o.id === 'cold' ? t('Stun biofeedback') : o.id === 'ar' ? t('Physical initiative, no biofeedback') : ''}
          >
            <span>{o.label}</span>
            {ini && <small className="mono">{ini.text}</small>}
          </button>
        );
      })}
    </div>
  );
}

function AsdfPanel({ actor, persona, canEdit }: PanelProps & { canEdit: boolean }) {
  const ds = deckStats(actor, persona);
  const deck = ds.isDeck;
  const [sel, setSel] = useState<AsdfKey | null>(null);
  const swap = (a: string | null, b: string) => {
    setSel(null);
    if (!a || !b || a === b) return;
    act('matrix/setASDF', { actorId: actor.id, swap: [a, b] });
  };
  const keys: AsdfKey[] = deck ? ASDF : ['dataProcessing', 'firewall'];
  return (
    <div className="mx-panel">
      <div className="mx-panel-title">
        {t('Configuration')} <span className="faint">{deck ? t('drag one box onto another to swap') : t('commlink: no swapping')}</span>
      </div>
      <div className={'mx-asdf' + (deck ? '' : ' two')}>
        {keys.map((k) => {
          const tip = `${t('{attr}: {n}', { attr: asdfLabel(k), n: ds.slotted[k] })}${ds.bonus[k] ? ` ${t('+{n} (programs)', { n: ds.bonus[k] })}` : ''}${ds.penalty[k] ? ` ${t('−{n} (IC)', { n: ds.penalty[k] })}` : ''}`;
          return (
            <button
              type="button"
              key={k}
              className={'mx-asdf-cell' + (sel === k ? ' sel' : '') + (ds.bonus[k] ? ' boosted' : '') + (ds.penalty[k] ? ' hurt' : '')}
              draggable={deck && canEdit}
              title={tip}
              disabled={!canEdit && deck}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', k);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (deck) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                swap(e.dataTransfer.getData('text/plain'), k);
              }}
              onClick={() => {
                if (!deck || !canEdit) return;
                if (!sel) setSel(k);
                else swap(sel, k);
              }}
            >
              <span className="mx-asdf-k">{asdfShort(k)}</span>
              <b className="mono">{ds.eff[k]}</b>
              <span className="mx-asdf-l">{asdfLabel(k)}</span>
              {ds.bonus[k] || ds.penalty[k] ? (
                <span className="mx-asdf-mod">
                  {ds.bonus[k] ? `+${ds.bonus[k]}` : ''}
                  {ds.penalty[k] ? ` −${ds.penalty[k]}` : ''}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {sel && <div className="small cyan">{t('Pick the attribute to swap with {attr}…', { attr: asdfLabel(sel) })}</div>}
    </div>
  );
}

function ProgramsPanel({ actor, persona, canEdit }: PanelProps & { canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const slots = programSlots({ ...persona, programSlots: persona.programSlots || 4 });
  const loaded = persona.loadedPrograms || [];
  const avail = availablePrograms(actor).filter((p) => p.id !== 'agent' && !loaded.some((n) => n.toLowerCase() === p.name.toLowerCase()));
  const chip = (name: string, loadedChip: boolean) => {
    const def = PROGRAM_BY_ID[programId(name) || ''];
    return (
      <span className={'mx-prog' + (loadedChip ? ' on' : '')} key={name} title={def ? t(def.effect) : t('Unknown program: effect up to the GM')}>
        <span>{programLabel(name)}</span>
        <ProgramRef name={name} />
        {def?.auto && loadedChip ? (
          <i className="mx-prog-auto" title={t('Effect applied automatically')}>
            ✓
          </i>
        ) : null}
        {canEdit &&
          (loadedChip ? (
            <button type="button" title={t('Unload')} onClick={() => act('matrix/unloadProgram', { actorId: actor.id, name })}>
              ✕
            </button>
          ) : (
            <button type="button" title={t('Load')} disabled={slots.free <= 0 && programId(name) !== 'virtualMachine'} onClick={() => act('matrix/loadProgram', { actorId: actor.id, name })}>
              +
            </button>
          ))}
      </span>
    );
  };
  return (
    <div className="mx-panel">
      <div className="mx-panel-title">
        {t('Programs')}{' '}
        <span className={'mono ' + (slots.free < 0 ? 'red' : 'cyan')}>
          {slots.used}/{slots.total}
        </span>{' '}
        <RuleRef rule="programs" />
      </div>
      <div className="mx-slots">
        {Array.from({ length: slots.total }, (_, i) => (
          <i key={i} className={i < slots.used ? 'on' : ''}></i>
        ))}
      </div>
      <div className="mx-progs">
        {loaded.map((n) => chip(n, true))}
        {persona.agent?.loaded && (
          <span className="mx-prog on agent" title={t('The agent takes up a slot')}>
            ◈ {persona.agent.name}
          </span>
        )}
        {!loaded.length && !persona.agent?.loaded && <span className="muted small">{t('No program loaded.')}</span>}
      </div>
      {loaded.length > 0 && (
        <ul className="mx-prog-effects">
          {loaded.map((n) => {
            const def = PROGRAM_BY_ID[programId(n) || ''];
            return (
              <li key={n}>
                <b>{programLabel(n)}</b> — {def ? t(def.effect) : t('effect up to the GM')}
                {def && !def.auto ? (
                  <>
                    {' '}
                    <span className="faint">{t('(GM’s call)')}</span>
                  </>
                ) : (
                  ''
                )}
              </li>
            );
          })}
        </ul>
      )}
      {avail.length > 0 && (
        <button type="button" className="mx-link" onClick={() => setOpen(!open)}>
          {open ? t('Hide available programs ({n})', { n: avail.length }) : t('Show available programs ({n})', { n: avail.length })}
        </button>
      )}
      {open && <div className="mx-progs avail">{avail.map((p) => chip(p.name, false))}</div>}
    </div>
  );
}

function AgentPanel({ game, actor, persona, canEdit }: PanelProps & { game: GameView; canEdit: boolean }) {
  const gm = isGM(game);
  const ag = persona.agent;
  const owned = detectAgents(actor);
  const maxOwned = owned.reduce((m, x) => Math.max(m, x.rating), 0);
  const maxRating = gm ? 6 : maxOwned;
  const configure = (patch: { rating?: number; name?: string }) => act('matrix/configureAgent', { actorId: actor.id, rating: ag?.rating || maxRating || 1, name: ag?.name || '', ...patch });
  if (!ag) {
    return (
      <div className="mx-panel mx-agent">
        <div className="mx-panel-title">{t('Agent')}</div>
        <p className="small muted">{t('An agent is an autonomous program (rating 1 to 6): it can assist you (teamwork) or act on its own while you do something else.')}</p>
        {maxOwned ? (
          <Button small variant="primary" disabled={!canEdit} onClick={() => configure({ rating: maxOwned })}>
            {t('Set up my agent (rating {n})', { n: maxOwned })}
          </Button>
        ) : (
          <div className="row wrap">
            {!gm && (
              <Button small onClick={() => goTab('shop')}>
                {t('Buy an agent (Shop › Software)')}
              </Button>
            )}
            {gm && (
              <Button small variant="primary" onClick={() => configure({ rating: 3 })}>
                {t('Give an agent (rating {n})', { n: 3 })}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }
  const ini = agentInitiative(actor, persona);
  const mon = matrixMonitor(ag.rating);
  const ratingOpts = Array.from({ length: Math.max(1, maxRating || ag.rating) }, (_, i) => ({ value: String(i + 1), label: t('Rating {n}', { n: i + 1 }) }));
  return (
    <div className={'mx-panel mx-agent' + (ag.loaded ? ' live' : '')}>
      <div className="mx-panel-title">
        {t('Agent')} <span className={ag.loaded ? 'green' : 'faint'}>{ag.loaded ? t('loaded') : t('idle')}</span>
      </div>
      <div className="mx-agent-card">
        <span className="mx-agent-avatar">◈</span>
        <div className="grow">
          {canEdit ? <TextInput value={ag.name} onChange={(v) => configure({ name: v })} placeholder={t('Agent name')} /> : <b>{ag.name}</b>}
          <div className="small muted">{t('Rating {r} · {dice} dice per action · Init. {init}', { r: ag.rating, dice: ag.rating * 2, init: ini.text })}</div>
        </div>
        {canEdit && <Select value={String(ag.rating)} options={ratingOpts} onChange={(v) => configure({ rating: Number(v) })} />}
      </div>
      <MatrixMonitor
        label={t('Agent damage')}
        value={ag.damage || 0}
        max={mon}
        onSet={gm ? (n) => act('matrix/setPersona', { actorId: actor.id, patch: { agent: { damage: n } } }) : null}
      />
      {persona.pendingAssist && (
        <div className="mx-pending">
          {t('Assist ready: {bonus} for the next “{action}” action (same skill).', {
            bonus: assistText(persona.pendingAssist),
            action: actionName(ACTIONS.find((a) => a.id === persona.pendingAssist!.actionId)),
          })}
        </div>
      )}
      <div className="row wrap">
        {canEdit && (
          <Button small variant={ag.loaded ? 'ghost' : 'primary'} onClick={() => act('matrix/agentLoad', { actorId: actor.id, loaded: !ag.loaded })}>
            {ag.loaded ? t('Unload') : t('Load (1 slot)')}
          </Button>
        )}
        {owned.length > 0 && <span className="faint small">{t('Owned: {list}', { list: owned.map(agentLabel).join(' · ') })}</span>}
      </div>
      <p className="small faint">{t('From “Roll” on an action: “Have my agent assist” or “Let my agent act”.')}</p>
    </div>
  );
}

function StatusPanel({ game, actor, persona }: PanelProps & { game: GameView }) {
  const gm = isGM(game);
  const ds = deckStats(actor, persona);
  const pen = Object.entries(persona.penalties || {}).filter(([, v]) => (v || 0) > 0);
  return (
    <div className="mx-panel mx-status">
      <OsMeter value={persona.overwatch} hidden={persona.overwatchHidden} knownAt={persona.osKnownAt} max={convergenceAt(actor)} />
      <MatrixMonitor value={persona.matrixDamage} deviceRating={ds.deviceRating} onSet={gm ? (n) => act('matrix/setPersona', { actorId: actor.id, patch: { matrixDamage: n } }) : null} />
      <div className="mx-chips">
        {persona.bricked && <Badge color="red">{t('Deck bricked')}</Badge>}
        {ds.rawNoise > 0 && (
          <Badge color="amber" title={t('Noise (−dice on Matrix actions)')}>
            {t('Noise {n}', { n: ds.rawNoise })}
            {ds.noise !== ds.rawNoise ? ` → ${ds.noise}` : ''}
          </Badge>
        )}
        {persona.linkLocked && (
          <Badge color="red" title={t('Cannot jack out normally')}>
            {t('Link-lock: {name}', { name: linkLockName(persona.linkLocked) })}
          </Badge>
        )}
        {persona.fullDefense && (
          <span className="mx-chip-btn">
            <Badge color="cyan">{t('Full defense (+WIL {n})', { n: attr(actor, 'WIL') })}</Badge>
            <button type="button" title={t('End full defense')} onClick={() => act('matrix/setFullDefense', { actorId: actor.id, on: false })}>
              ✕
            </button>
          </span>
        )}
        {persona.traced && (
          <Badge color="magenta" title={t('Physical location known to the opposition')}>
            {t('Traced')}
          </Badge>
        )}
        {pen.map(([k, v]) => (
          <Badge color="red" key={k}>
            {asdfLabel(k)} −{v}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function MarksPanel({ persona, onErase }: { persona: PersonaView; onErase: ((m: MatrixMarkOnMe) => void) | null }) {
  const marks = (persona.marks || []).filter((m) => m.count > 0);
  const onMe = (persona.marksOnMe || []).filter((m) => m.count > 0);
  return (
    <div className="mx-panel">
      <div className="mx-panel-title">{t('Marks')}</div>
      {marks.length === 0 && <div className="muted small">{t('No marks placed.')}</div>}
      {marks.map((m) => (
        <div className="mx-mark" key={m.targetId}>
          <span className="grow">{markName(m)}</span>
          {marksDots(m.count)}
        </div>
      ))}
      {onMe.length > 0 && <div className="mx-panel-sub">{t('Marks on me')}</div>}
      {onMe.map((m) => (
        <div className="mx-mark hostile" key={m.sourceId}>
          <span className="grow">{markName(m)}</span>
          {marksDots(m.count)}
          {onErase && (
            <button type="button" className="mx-link" onClick={() => onErase(m)}>
              {t('mark::Erase')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function HostPanel({ game, actor, persona, open }: PanelProps & { game: GameView; open: OpenAction }) {
  const hosts = hostsOf(game);
  const gm = isGM(game);
  const cur = hostOf(game, persona.hostId);
  const marksOn = (h: { id: string }) => (persona.marks || []).find((m) => m.targetId === `host:${h.id}`)?.count || 0;
  if (!cur) {
    const list = hosts.filter((h) => gm || h.visible || marksOn(h));
    return (
      <div className="mx-panel mx-host">
        <div className="mx-panel-title">{t('Public grid')}</div>
        {list.length === 0 && <div className="muted small">{t('No host spotted yet.')}</div>}
        {list.map((h) => (
          <div className="mx-hostrow" key={h.id}>
            <div className="grow">
              <b>{h.name}</b>
              {h.rating ? (
                <>
                  {' '}
                  <span className="faint small">{t('rating {n}', { n: h.rating })}</span>
                </>
              ) : (
                ''
              )}
              {h.alert === 'active' && (
                <>
                  {' '}
                  <Badge color="red">{t('Alert')}</Badge>
                </>
              )}
            </div>
            {marksDots(marksOn(h))}
            <Button small disabled={!persona.online} onClick={() => open('hackOnTheFly', { targetId: `host:${h.id}` })}>
              {t('verb::Mark')}
            </Button>
            <Button
              small
              variant="primary"
              disabled={!persona.online || !marksOn(h)}
              title={marksOn(h) ? '' : t('You need 1 mark on the host')}
              onClick={() => act('matrix/action', { actorId: actor.id, actionId: 'enterHost', targetId: `host:${h.id}` })}
            >
              {t('Enter')}
            </Button>
          </div>
        ))}
      </div>
    );
  }
  const perceived = gm || cur.perceived;
  const ic = (cur.ic || []).filter((x) => (gm ? x.active : true));
  return (
    <div className={'mx-panel mx-host inside' + (cur.alert === 'active' ? ' alert' : '')}>
      <div className="mx-panel-title">
        {t('Host')} {cur.alert === 'active' ? <Badge color="red">{t('ALERT')}</Badge> : <Badge color="green">{t('calm')}</Badge>}
      </div>
      <div className="mx-host-name">{cur.name}</div>
      {cur.description && <div className="small muted">{cur.description}</div>}
      {perceived ? (
        <div className="mx-host-attrs">
          <span>
            {t('Rating')} <b>{cur.rating}</b>
          </span>
          {ASDF.map((k) => (
            <span key={k}>
              {asdfShort(k)} <b>{cur[k]}</b>
            </span>
          ))}
        </div>
      ) : (
        <div className="small faint">{t('Rating and contents unknown: make a Matrix Perception test.')}</div>
      )}
      {cur.spotted && <div className="small red">{t('Patrol IC has spotted you.')}</div>}
      <div className="mx-panel-sub">
        {t('Active IC')} <RuleRef rule="ic" />
      </div>
      {ic.length === 0 && <div className="muted small">{t('No active IC.')}</div>}
      {ic.map((x) => (
        <div className="mx-icrow" key={x.id}>
          <span className="grow" title={IC_TYPES[x.type]?.desc ? t(IC_TYPES[x.type].desc) : ''}>
            {icName(x.type)}
            {x.rating ? (
              <>
                {' '}
                <span className="faint small">{t('rating {n}', { n: x.rating })}</span>
              </>
            ) : (
              ''
            )}
          </span>
          {x.rating ? (
            <span className="mono small">
              {x.damage || 0}/{matrixMonitor(x.rating)}
            </span>
          ) : null}
          <Button small variant="danger" disabled={!persona.online} onClick={() => open('dataSpike', { targetId: `ic:${cur.id}:${x.id}` })}>
            {t('Spike')}
          </Button>
        </div>
      ))}
      {perceived && <div className="mx-panel-sub">{t('Files')}</div>}
      {perceived && (cur.files || []).length === 0 && <div className="muted small">{t('No files.')}</div>}
      {perceived &&
        (cur.files || []).map((f) => (
          <div className="mx-filerow" key={f.id}>
            <span className="grow">
              {f.protected ? '🔒 ' : ''}
              {f.name}
              {f.bomb ? (
                <>
                  {' '}
                  <Badge color="red">{t('bomb {n}', { n: f.bomb })}</Badge>
                </>
              ) : (
                ''
              )}
              {f.value != null ? (
                <>
                  {' '}
                  <span className="faint small">{f.value}¥</span>
                </>
              ) : (
                ''
              )}
            </span>
            {f.protected && (
              <Button small onClick={() => open('crackFile', { targetId: `file:${cur.id}:${f.id}` })}>
                {t('Crack')}
              </Button>
            )}
            {f.bomb > 0 && !f.mine && (
              <Button small onClick={() => open('disarmDataBomb', { targetId: `file:${cur.id}:${f.id}` })}>
                {t('Disarm')}
              </Button>
            )}
            <Button small variant="primary" disabled={f.protected} onClick={() => open('editFile', { targetId: `file:${cur.id}:${f.id}`, fileOp: 'copy' })}>
              {t('Edit')}
            </Button>
          </div>
        ))}
      {perceived && (cur.devices || []).length > 0 && <div className="mx-panel-sub">{t('Slaved devices')}</div>}
      {perceived &&
        (cur.devices || []).map((d) => {
          const kind = d.link?.kind && DEVICE_LINK_KINDS[d.link.kind] ? d.link.kind : null;
          const state = kind ? deviceLinkState(game, d) : null;
          // Quick map commands: only the ones that change something (no « Ouvrir » on an open door).
          const useless = (c: string) =>
            kind === 'door' ? (c === 'open' && state === 'open') || (c === 'close' && state !== 'open') || (c === 'lock' && state === 'locked') || (c === 'unlock' && state !== 'locked') : c === state;
          const cmds = kind ? DEVICE_LINK_KINDS[kind].cmds.filter((c) => !useless(c)) : [];
          return (
            <div className="mx-filerow mx-devrow" key={d.id}>
              <span className="grow">
                {d.name} <span className="faint small">{t('rating {n}', { n: d.rating })}</span>
                {d.offline ? (
                  <>
                    {' '}
                    <Badge>{t('offline')}</Badge>
                  </>
                ) : (
                  ''
                )}
                {d.bricked ? (
                  <>
                    {' '}
                    <Badge color="red">{t('bricked')}</Badge>
                  </>
                ) : (
                  ''
                )}
                {d.formatted ? (
                  <>
                    {' '}
                    <Badge color="red">{t('formatted')}</Badge>
                  </>
                ) : (
                  ''
                )}
                {kind && (
                  <>
                    {' '}
                    <span className="mx-link-chip" title={t('Linked to the map: {what}', { what: t(DEVICE_LINK_KINDS[kind].label) })}>
                      {linkStateText(kind, state)}
                    </span>
                  </>
                )}
              </span>
              {deviceWorks(d) &&
                kind &&
                cmds.map((c) => (
                  <Button small key={c} disabled={!persona.online} onClick={() => open('controlDevice', { targetId: `device:${cur.id}:${d.id}`, deviceCmd: c })}>
                    {t(DEVICE_CMD_LABELS[kind][c])}
                  </Button>
                ))}
              <Button small variant="primary" onClick={() => open('controlDevice', { targetId: `device:${cur.id}:${d.id}` })}>
                {t('Control')}
              </Button>
            </div>
          );
        })}
      <div className="row wrap mx-host-foot">
        <Button small onClick={() => open('matrixPerception', { targetId: `host:${cur.id}` })}>
          {t('Perception')}
        </Button>
        <Button small variant="ghost" onClick={() => act('matrix/action', { actorId: actor.id, actionId: 'exitHost' })}>
          {t('Exit Host')}
        </Button>
      </div>
    </div>
  );
}

function PaydataPanel({ game, actor, persona, canEdit }: PanelProps & { game: GameView; canEdit: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const files = persona.files || [];
  if (!files.length) return null;
  const gm = isGM(game);
  const share = async (f: (typeof files)[number]) => {
    const q = gm
      ? t('Show “{file}” to every player (new document in their Files)?', { file: f.name })
      : t('Share “{file}” with the team (new party note, Matrix folder)?', { file: f.name });
    if (await confirmAction(q)) {
      const r = await act('matrix/shareFile', { actorId: actor.id, fileId: f.id });
      if (r) toast(gm ? t('Document revealed to the players.') : t('Party note created.'), 'success');
    }
  };
  return (
    <div className="mx-panel">
      <div className="mx-panel-title">{t('Paydata ({n})', { n: files.length })}</div>
      {files.map((f) => (
        <div className="mx-paydata" key={f.id}>
          <div className="row">
            <button type="button" className="mx-paydata-head grow" onClick={() => setOpenId(openId === f.id ? null : f.id)}>
              <span className="grow">{f.name}</span>
              <span className="faint small">
                {f.hostName}
                {f.readOnly ? ` · ${t('read')}` : ''}
                {f.value != null ? ` · ${f.value}¥` : ''}
              </span>
            </button>
            {f.shared && (
              <Badge color="green" title={t('Already shared with the team')}>
                {t('shared')}
              </Badge>
            )}
            {canEdit && (
              <Button small variant="ghost" title={gm ? t('Reveal to the players (Files)') : t('Create a party note with this file')} onClick={() => share(f)}>
                {t('Share')}
              </Button>
            )}
          </div>
          {openId === f.id && <div className="mx-paydata-body">{f.content || <span className="muted">{t('Contents to be described by the GM.')}</span>}</div>}
        </div>
      ))}
    </div>
  );
}

/** « Conseils » panel: what to do next, each with a button opening the right action. Toggled per viewer (kept in this browser). */
function HintsPanel({ game, actor, persona, open }: PanelProps & { game: GameView; open: OpenAction }) {
  const hints = nextStepHints({ actor, persona, hosts: hostMap(game) }).slice(0, 4);
  if (!hints.length) return null;
  const run = (h: StepHint) => {
    const a = h.actionId ? ACTION_BY_ID[h.actionId] : undefined;
    if (!a) return;
    if (a.noTest) act('matrix/action', { actorId: actor.id, actionId: a.id, targetId: h.targetId });
    else open(a.id, { targetId: h.targetId, ...(h.preset || {}) });
  };
  return (
    <div className="mx-panel mx-hints">
      <div className="mx-panel-title">💡 {t('Hints')}</div>
      {hints.map((h, i) => (
        <div className={'mx-hint tone-' + h.tone} key={i}>
          <span className="grow">{t(h.key, h.params)}</span>
          {h.actionId && ACTION_BY_ID[h.actionId] && (
            <Button small variant={i === 0 ? 'primary' : 'ghost'} onClick={() => run(h)}>
              {actionName(ACTION_BY_ID[h.actionId])}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function useHintsToggle(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem('sr.matrix.hints') !== '0';
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem('sr.matrix.hints', v ? '1' : '0');
    } catch {}
  };
  return [on, set];
}

function ActionsPanel({ actor, persona, open }: PanelProps & { open: OpenAction }) {
  const [filter, setFilter] = useState('all');
  const list = ACTIONS.filter((a) => (filter === 'illegal' ? isIllegal(a) : filter === 'legal' ? !isIllegal(a) : true));
  const filters = [
    { id: 'all', label: t('fem::All') },
    { id: 'illegal', label: t('fem.pl::Illegal') },
    { id: 'legal', label: t('fem.pl::Legal') },
  ];
  return (
    <div className="mx-panel mx-actions">
      <div className="mx-panel-title spread">
        <span>
          {t('Matrix actions')} <RuleRef rule="matrixActions" />
        </span>
        <span className="mx-seg small">
          {filters.map((f) => (
            <button type="button" key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </span>
      </div>
      {CAT_ORDER.map((cat) => {
        const items = list.filter((a) => a.cat === cat);
        if (!items.length) return null;
        const illegal = cat === 'attack' || cat === 'sleaze';
        return (
          <div className="mx-actgroup" key={cat}>
            <div className={'mx-actgroup-title ' + (illegal ? 'illegal' : 'legal')}>
              {illegal ? t('Illegal') : t('Legal')} · {t(ACTION_CATS[cat])}
            </div>
            {items.map((a) => {
              const pc = actionPool(actor, persona, a, {});
              return (
                <div className="mx-actrow" key={a.id}>
                  <div className="grow mx-act-name" title={t(a.desc)}>
                    <b>{actionName(a)}</b>
                    {getLang() === 'fr' ? (
                      <>
                        {' '}
                        <span className="faint small">{a.en}</span>
                      </>
                    ) : null}
                    {a.page ? (
                      <>
                        {' '}
                        <BookRef source="SR5" page={a.page} />
                      </>
                    ) : null}
                    <div className="small muted">
                      {ACTION_TYPES[a.type] ? t(ACTION_TYPES[a.type]) : a.type}
                      {a.marks ? ` · ${marksText(a.marks)}` : ''}
                      {a.skill ? ` · ${a.limit ? `[${asdfLabel(a.limit)}]` : ''}` : ''}
                    </div>
                  </div>
                  <span className="mx-act-pool mono">
                    {a.noTest ? (
                      '—'
                    ) : pc.impossible ? (
                      <span className="red small">{t('untrained')}</span>
                    ) : (
                      <>
                        {pc.pool}
                        <small>{pc.limit !== null ? ` [${pc.limit}]` : ''}</small>
                      </>
                    )}
                  </span>
                  <Button small variant={illegal ? 'accent' : 'primary'} disabled={(!persona.online && a.id !== 'rebootSelf') || pc.impossible} onClick={() => open(a.id)}>
                    {t('Roll')}
                  </Button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export default function Cockpit({ game, actorId }: { game: GameView; actorId: string }) {
  const viewActor = game.actors?.[actorId];
  const actor = isFullActor(viewActor) ? viewActor : undefined;
  const [modal, setModal] = useState<{ actionId: string; preset: ActionPreset; k: number } | null>(null); // { actionId, preset }
  const [hintsOn, setHintsOn] = useHintsToggle();
  const gm = isGM(game);
  const canEdit = !!actor && (gm || (game.me.characterIds || []).includes(actor.id));
  const isVirtual = !!actor?.matrix && !game.matrix?.personas?.[actorId];
  // First visit: let the server create the persona (deck program slots, agent detection).
  useEffect(() => {
    if (isVirtual && canEdit) send('matrix/ensure', { actorId }, { silent: true }).catch(() => {});
  }, [actorId, isVirtual]);
  if (!actor || !actor.matrix) return null;
  const persona = personaOf(game, actor);
  const ds = deckStats(actor, persona);
  const open: OpenAction = (actionId, preset = {}) => setModal({ actionId, preset, k: Date.now() });
  const reboot = async () => {
    const question =
      persona.online && persona.mode !== 'ar'
        ? t('Reboot {name}’s deck? The Overwatch Score goes back to 0 and every mark is erased, but you suffer dumpshock.', { name: actor.name })
        : t('Reboot {name}’s deck? The Overwatch Score goes back to 0 and every mark is erased, but you are disconnected.', { name: actor.name });
    if (await confirmAction(question)) {
      act('matrix/action', { actorId: actor.id, actionId: 'rebootSelf' });
    }
  };
  const action = modal && ACTIONS.find((a) => a.id === modal.actionId);
  const host = hostOf(game, persona.hostId);
  return (
    <div className={'mx-cockpit' + (persona.online ? ' online mode-' + persona.mode : ' offline') + ((persona.overwatch || 0) >= 30 ? ' danger' : '')}>
      <header className="mx-deckbar">
        <div className="mx-deck-id">
          <div className="mx-deck-name">{actor.matrix.device || t('Device')}</div>
          <div className="small muted">
            {actor.name} · {isCyberdeck(actor) ? t('cyberdeck') : t('commlink')} · {t('rating {n}', { n: ds.deviceRating })}
            {host ? ` · ${t('in {host}', { host: host.name })}` : ''}
          </div>
        </div>
        <ModeSwitch game={game} actor={actor} persona={persona} onJackOut={() => open('jackOut')} />
        <div className="mx-deck-btns">
          {!gm && (
            <Button small variant={hintsOn ? 'accent' : 'ghost'} onClick={() => setHintsOn(!hintsOn)} title={t('Show or hide the hints (what to do next)')}>
              💡 {hintsOn ? t('Hints: on') : t('Hints: off')}
            </Button>
          )}
          <Button small variant="ghost" disabled={!canEdit || persona.bricked} onClick={reboot} title={t('Resets the Overwatch Score to 0')}>
            {t('Reboot deck')}
          </Button>
        </div>
      </header>
      {hintsOn && canEdit && !gm && <HintsPanel game={game} actor={actor} persona={persona} open={open} />}
      <div className="mx-grid">
        <div className="mx-col">
          <AsdfPanel actor={actor} persona={persona} canEdit={canEdit} />
          <ProgramsPanel actor={actor} persona={persona} canEdit={canEdit} />
          <AgentPanel game={game} actor={actor} persona={persona} canEdit={canEdit} />
        </div>
        <div className="mx-col">
          <StatusPanel game={game} actor={actor} persona={persona} />
          <MarksPanel persona={persona} onErase={persona.online ? (m) => open('eraseMark', { targetId: `mark:${m.sourceId}` }) : null} />
          <PaydataPanel game={game} actor={actor} persona={persona} canEdit={canEdit} />
        </div>
        <div className="mx-col">
          <HostPanel game={game} actor={actor} persona={persona} open={open} />
          <MatrixLog game={game} actorId={actor.id} limit={10} />
        </div>
      </div>
      <ActionsPanel actor={actor} persona={persona} open={open} />
      {action && modal && <ActionModal key={modal.k} game={game} actor={actor} persona={persona} action={action} preset={modal.preset} onClose={() => setModal(null)} />}
    </div>
  );
}
