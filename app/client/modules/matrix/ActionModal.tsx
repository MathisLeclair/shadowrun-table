// « Lancer » dialog for a Matrix action: target, marks, modifiers, Edge, and the agent (assist or act alone).
import { useState } from 'react';
import { Modal, Button, Field, NumberInput, Select, TextInput, Toggle, Badge } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t, tn, tk, getLang } from '../../lib/i18n.ts';
import { slug } from '/shared/util.ts';
import { actionPool, isIllegal, ACTION_TYPES, ACTION_CATS, MARK_PENALTY, matrixMonitor, DEVICE_LINK_KINDS, DEVICE_CMD_LABELS } from './types.ts';
import type { MatrixAction, PendingAssistLike, PersonaView, PoolCalc, PoolModLine } from './types.ts';
import { isGM, targetOptions, marksRequired, msgText, outcomeTexts, partLabel, actionName, marksText, assistText, type ActionResult, type MsgLike } from './common.tsx';
import { useModifiers, toggleText, effectText, loadRollToggles, saveRollToggles } from '../sheet/modifiers-ui.tsx';
import type { Actor, GameView, RollResult } from '../../../shared/types.ts';
import { BookRef, SkillRef } from '../books/BookRef.tsx';
import { DiceFaces } from '../sheet/common.tsx';

const FILE_OPS = [
  { value: 'read', label: tk('Read') },
  { value: 'copy', label: tk('Copy to my deck') },
  { value: 'edit', label: tk('Edit') },
  { value: 'delete', label: tk('file::Delete') },
];

/** Reply of matrix/action, matrix/agentAct, matrix/agentAssist (fields the dialog shows). */
interface MatrixActionReply extends ActionResult {
  roll?: RollResult;
  success?: boolean;
  pending?: boolean;
  osDelta?: number;
  defense?: { hits: number; label?: string; labelMsg?: MsgLike; pool?: number; dice?: number[] };
  convergence?: string[];
  convergenceMsgs?: MsgLike[];
  pendingAssist?: PendingAssistLike | null;
}

function PoolLine({ pc, title }: { pc: PoolCalc | null; title?: string }) {
  if (!pc) return null;
  return (
    <div className="mx-pool">
      <div className="mx-pool-main">
        <span className="mx-pool-n">{pc.pool}</span>
        <span className="mx-pool-u">{t('dice')}</span>
        {pc.limit !== null && pc.limit !== undefined ? <span className="mx-pool-lim">[{pc.limit}]</span> : <span className="mx-pool-lim faint">{t('no limit')}</span>}
      </div>
      <div className="mx-pool-parts">
        {title && <b>{t('{title}: ', { title })}</b>}
        {pc.parts.map((p, i) => (
          <span key={i}>
            {partLabel(p)} <b className={p.value < 0 ? 'red' : ''}>{p.value >= 0 ? '+' : '−'}{Math.abs(p.value)}</b>
            {p.mod?.book ? (
              <>
                {' '}
                <BookRef source={p.mod.book} page={p.mod.page} />
              </>
            ) : null}
          </span>
        ))}
        {pc.limitParts?.length ? <span className="faint">· {t('limit: {parts}', { parts: pc.limitParts.map((p) => `${partLabel(p)} ${p.value}`).join(' + ') })}</span> : null}
      </div>
    </div>
  );
}

function ResultView({ res, who }: { res: MatrixActionReply | null; who: string }) {
  if (!res) return null;
  const r = res.roll;
  return (
    <div className={'mx-result' + (res.success === true ? ' ok' : res.success === false ? ' ko' : '')}>
      <div className="mx-result-head">
        <span className="mx-result-who">{who}</span>
        {r && (
          <span className="mx-result-hits">
            {r.hits}
            <small> {t('hits')}</small>
          </span>
        )}
        {res.defense && (
          <span className="mx-result-vs">
            {t('vs')} <b>{res.defense.hits}</b> ({res.defense.labelMsg ? msgText(res.defense.labelMsg) : res.defense.label}
            {res.defense.pool !== undefined ? `, ${t('{n} dice', { n: res.defense.pool })}` : ''})
          </span>
        )}
        {res.success === true && <Badge color="green">{t('Success')}</Badge>}
        {res.success === false && <Badge color="red">{t('Failure')}</Badge>}
        {res.pending && <Badge color="amber">{t('GM rolls defense')}</Badge>}
        {res.osDelta ? <Badge color="magenta">{t('OS +{n}', { n: res.osDelta })}</Badge> : null}
      </div>
      {r && <DiceFaces roll={r} />}
      {res.defense?.dice && (
        <div className="mx-result-def">
          <span className="faint small">{t('Defense')}</span>
          <DiceFaces roll={{ dice: res.defense.dice }} small />
        </div>
      )}
      <ul className="mx-result-out">
        {outcomeTexts(res).map((o, i) => (
          <li key={i}>{o}</li>
        ))}
      </ul>
      {res.convergence && (
        <div className="mx-os-alarm">{t('CONVERGENCE — {text}', { text: (Array.isArray(res.convergenceMsgs) ? res.convergenceMsgs.map(msgText) : res.convergence).slice(1).join(' ') })}</div>
      )}
    </div>
  );
}

/** Preset of the dialog when opened from a host row or a hint. */
export interface ActionPreset {
  targetId?: string;
  fileOp?: string;
  deviceCmd?: string;
}

interface ActionModalProps {
  game: GameView;
  actor: Actor;
  persona: PersonaView;
  action: MatrixAction;
  preset?: ActionPreset;
  onClose: () => void;
}

export default function ActionModal({ game, actor, persona, action, preset = {}, onClose }: ActionModalProps) {
  const gm = isGM(game);
  const groups = targetOptions(game, actor, persona, action);
  const flat = groups.flatMap((g) => g.items);
  const needsTarget = !(action.targets || []).includes('none');
  const [targetId, setTargetId] = useState(preset.targetId && flat.some((o) => o.id === preset.targetId) ? preset.targetId : needsTarget ? flat[0]?.id || '' : '');
  const [targetName, setTargetName] = useState('');
  const [defensePool, setDefensePool] = useState(0);
  const [marks, setMarks] = useState(1);
  const [controlMarks, setControlMarks] = useState(1);
  const [fileOp, setFileOp] = useState(preset.fileOp || 'copy');
  const [command, setCommand] = useState('');
  const [deviceCmd, setDeviceCmd] = useState(preset.deviceCmd || '');
  const [program, setProgram] = useState('');
  const [threshold, setThreshold] = useState(0);
  const [modifier, setModifier] = useState(0);
  const [useSpec, setUseSpec] = useState(false);
  const [edge, setEdge] = useState(false);
  const [useAssist, setUseAssist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ who: string; res: MatrixActionReply } | null>(null); // { who, res }
  const [assistRes, setAssistRes] = useState<MatrixActionReply | null>(null);
  // Modifiers of the decker's gear / qualities / implants (Codeslinger, skill bonuses…) and the situational switches (shared with the roll dialog).
  const mods = useModifiers(actor);
  const [conds, setConds] = useState<string[]>(() => loadRollToggles(actor.id));
  const setCond = (k: string, on: boolean) => {
    const next = on ? [...new Set([...conds, k])] : conds.filter((x) => x !== k);
    setConds(next);
    saveRollToggles(actor.id, next);
  };

  const ag = persona.agent;
  const pending = persona.pendingAssist && persona.pendingAssist.skill === action.skill ? persona.pendingAssist : null;
  const assist = useAssist && pending ? { dice: pending.dice, limitBonus: pending.limitBonus } : null;
  const sk = (actor.skills || []).find((s) => s.id === action.skill);
  const edgeLeft = actor.edge?.current ?? 0;
  const pc = action.noTest ? null : actionPool(actor, persona, action, { useSpec, marks, modifier, assist, edge, mods, conditions: conds });
  const switches: Record<string, PoolModLine[]> = {};
  for (const l of pc?.modLines || []) if (!l.mod.baked && !l.mod.info && l.value !== null) for (const k of l.toggles || []) (switches[k] ||= []).push(l);
  const agentPc = action.noTest || !ag ? null : actionPool(actor, persona, action, { agent: true, marks, modifier });
  const target = flat.find((o) => o.id === targetId);
  // Device linked to the map (door, light, camera zone): the command also acts on the map.
  const linkKind = ['controlDevice', 'spoofCommand'].includes(action.id) && target?.linkKind && DEVICE_LINK_KINDS[target.linkKind] ? target.linkKind : null;
  const need = marksRequired(action, { controlMarks });
  let have = target?.marks || 0;
  if (targetId === 'manual') have = (persona.marks || []).find((m) => m.targetId === `manual:${slug(targetName.trim() || 'cible inconnue') || 'cible'}`)?.count || 0;
  const marksOk = have >= need;
  const canAgent = ag && !action.noTest && action.id !== 'jackOut';
  const missingTarget = needsTarget && !(targetId === 'manual' || flat.some((o) => o.id === targetId));
  const linkLockedJackOut = action.id === 'jackOut' && !persona.linkLocked;
  const offline = !persona.online && action.id !== 'rebootSelf';

  const payload = () => ({
    actorId: actor.id,
    actionId: action.id,
    targetId: targetId || undefined,
    targetName: targetId === 'manual' ? targetName : undefined,
    defensePool: targetId === 'manual' && gm ? defensePool : undefined,
    marks,
    controlMarks,
    fileOp,
    command: command || undefined,
    program: program || undefined,
    deviceCmd: linkKind && deviceCmd ? deviceCmd : undefined,
    threshold: threshold || undefined,
    modifier,
  });

  const run = async () => {
    setBusy(true);
    try {
      const res = await send<MatrixActionReply>('matrix/action', { ...payload(), useSpec, edge, assistFromAgent: !!assist, conditions: conds });
      setResult({ who: actor.name, res });
      setUseAssist(false);
      setEdge(false);
    } catch {}
    setBusy(false);
  };
  const askAssist = async () => {
    setBusy(true);
    try {
      const res = await send<MatrixActionReply>('matrix/agentAssist', { actorId: actor.id, actionId: action.id });
      setAssistRes(res);
      setUseAssist(!!res.pendingAssist && res.pendingAssist.dice + res.pendingAssist.limitBonus > 0);
    } catch {}
    setBusy(false);
  };
  const agentDo = async () => {
    setBusy(true);
    try {
      const res = await send<MatrixActionReply>('matrix/agentAct', payload());
      setResult({ who: ag!.name, res });
    } catch {}
    setBusy(false);
  };

  const legal = !isIllegal(action);
  return (
    <Modal title={actionName(action)} onClose={onClose} width={680}>
      <div className="mx-modal">
        <div className="row wrap gap-s mx-modal-tags">
          {getLang() === 'fr' ? <span className="faint">{action.en}</span> : null}
          <Badge color={legal ? 'green' : 'magenta'}>{legal ? t('fem::Legal') : t('fem::Illegal')}</Badge>
          <Badge>{t(ACTION_CATS[action.cat])}</Badge>
          <Badge>{ACTION_TYPES[action.type] ? t(ACTION_TYPES[action.type]) : action.type}</Badge>
          {need ? <Badge color={marksOk ? 'cyan' : 'red'}>{tn(need, '{n} mark required', '{n} marks required')}</Badge> : null}
          {action.page ? <BookRef source="SR5" page={action.page} /> : null}
          {action.skill ? <SkillRef id={action.skill} /> : null}
        </div>
        <p className="mx-desc">{t(action.desc)}</p>
        {!legal && <p className="small magenta">{t('Illegal action: the defender’s hits are added to your Overwatch Score.')}</p>}

        {result ? (
          <>
            <ResultView res={result.res} who={result.who} />
            <div className="row spread mx-modal-actions">
              <Button
                variant="ghost"
                onClick={() => {
                  setResult(null);
                  setAssistRes(null);
                }}
              >
                {t('Try again')}
              </Button>
              <Button variant="primary" onClick={onClose}>
                {t('Close')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {needsTarget || (action.targets || []).length > 1 ? (
              <div className="grid-2 mx-modal-grid">
                <Field label={t('Target')}>
                  {flat.length ? (
                    <select className="input" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                      {!needsTarget && <option value="">{t('— No target —')}</option>}
                      {groups.map((g) => (
                        <optgroup key={g.group} label={g.group}>
                          {g.items.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                              {o.marks ? ` · ${marksText(o.marks)}` : ''}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  ) : (
                    <div className="muted small">{t('No target available yet.')}</div>
                  )}
                </Field>
                {targetId === 'manual' && (
                  <Field label={t('Target name')}>
                    <TextInput live value={targetName} placeholder={t('e.g. the guard’s commlink')} onChange={setTargetName} />
                  </Field>
                )}
                {targetId === 'manual' && gm && (
                  <Field label={t('Defense (dice, GM)')} hint={t('0 = the target does not resist')}>
                    <NumberInput value={defensePool} min={0} max={40} onChange={setDefensePool} />
                  </Field>
                )}
              </div>
            ) : null}
            {need > 0 && !marksOk && <p className="small red">{tn(need, 'You need {n} mark on this target (you have {have}).', 'You need {n} marks on this target (you have {have}).', { have })}</p>}

            <div className="row wrap mx-modal-opts">
              {action.placesMarks && (
                <Field label={t('Marks to place')}>
                  <div className="mx-seg">
                    {[1, 2, 3].map((n) => (
                      <button type="button" key={n} className={marks === n ? 'on' : ''} onClick={() => setMarks(n)}>
                        {n}
                        {MARK_PENALTY[n] ? <small> ({MARK_PENALTY[n]})</small> : ''}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              {action.id === 'controlDevice' && (
                <Field label={t('Marks required by the command')}>
                  <div className="mx-seg">
                    {[1, 2, 3].map((n) => (
                      <button type="button" key={n} className={controlMarks === n ? 'on' : ''} onClick={() => setControlMarks(n)}>
                        {n}
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              {action.id === 'editFile' && (
                <Field label={t('Operation')}>
                  <Select value={fileOp} options={FILE_OPS.map((o) => ({ ...o, label: t(o.label) }))} onChange={setFileOp} />
                </Field>
              )}
              {['controlDevice', 'spoofCommand'].includes(action.id) || (action.id === 'editFile' && fileOp === 'edit') ? (
                <Field label={action.id === 'editFile' ? t('noun::Change') : t('Command')} className="grow">
                  <TextInput live value={command} placeholder={action.id === 'editFile' ? t('e.g. add a name') : t('e.g. open the door')} onChange={setCommand} />
                </Field>
              ) : null}
              {linkKind && (
                <Field label={t('On the map')} hint={t('Applied automatically if the action succeeds')}>
                  <Select
                    value={deviceCmd}
                    options={[
                      { value: '', label: t('— nothing —') },
                      ...DEVICE_LINK_KINDS[linkKind].cmds.map((c) => ({ value: c, label: `${DEVICE_LINK_KINDS[linkKind].icon} ${t(DEVICE_CMD_LABELS[linkKind][c])}` })),
                    ]}
                    onChange={setDeviceCmd}
                  />
                </Field>
              )}
              {action.id === 'crashProgram' && (
                <Field label={t('Target program (optional)')}>
                  <TextInput live value={program} onChange={setProgram} />
                </Field>
              )}
              {(action.id === 'matrixSearch' || (!action.defense && !action.noTest && action.id !== 'jamSignals')) && (
                <Field label={t('Threshold (optional)')}>
                  <NumberInput value={threshold} min={0} max={20} onChange={setThreshold} />
                </Field>
              )}
              {!action.noTest && (
                <Field label={t('Edit')}>
                  <NumberInput value={modifier} min={-20} max={20} onChange={setModifier} />
                </Field>
              )}
            </div>
            {!action.noTest && (
              <div className="row wrap mx-modal-opts">
                {sk?.spec && <Toggle value={useSpec} onChange={setUseSpec} label={t('Specialization “{spec}” (+2)', { spec: sk.spec })} />}
                <Toggle
                  value={edge}
                  onChange={(v) => setEdge(v && edgeLeft > 0)}
                  label={t('Edge: Push the Limit ({n})', { n: edgeLeft })}
                  title={t('+Edge dice, Rule of Six, no limit — costs 1 point')}
                />
                {Object.entries(switches).map(([k, ls]) => (
                  <Toggle
                    key={k}
                    value={conds.includes(k)}
                    onChange={(v) => setCond(k, v)}
                    label={t('{switch} ({effects})', { switch: toggleText(k), effects: [...new Set(ls.map((l) => effectText(l.mod)))].join(', ') })}
                  />
                ))}
              </div>
            )}
            {pc && <PoolLine pc={pc} />}
            {pc?.impossible && <p className="small red">{pc.reasonKey ? t(pc.reasonKey, pc.reasonParams) : pc.reason}</p>}

            {canAgent && (
              <div className="mx-agent-box">
                <div className="mx-agent-head">
                  <span className="mx-agent-icon">◈</span>
                  <div className="grow">
                    <b>{ag.name}</b>{' '}
                    <span className="faint small">
                      {t('rating {n} agent', { n: ag.rating })} · {ag.loaded ? t('loaded') : t('not loaded')}
                      {ag.damage ? ` · ${ag.damage}/${matrixMonitor(ag.rating)}` : ''}
                    </span>
                  </div>
                </div>
                {ag.loaded ? (
                  <div className="mx-agent-choices">
                    <div className="mx-agent-choice">
                      <Button variant="accent" disabled={busy || !persona.online} onClick={askAssist}>
                        {t('Have my agent assist')}
                      </Button>
                      <span className="small muted">
                        {t('Teamwork: it rolls {pool} dice{limit}; each hit gives you +1 die (max {max}), and +1 to your limit if it scores at least one.', {
                          pool: agentPc ? agentPc.pool : '—',
                          limit: agentPc?.limit != null ? ` [${agentPc.limit}]` : '',
                          max: sk?.rating || 0,
                        })}
                      </span>
                    </div>
                    {(assistRes || pending) && (
                      <div className="mx-assist">
                        {assistRes && assistRes.roll && <DiceFaces roll={assistRes.roll} small />}
                        {assistRes ? <div className="small">{outcomeTexts(assistRes).join(' ')}</div> : <div className="small">{t('Assist pending: {bonus}.', { bonus: assistText(pending) })}</div>}
                        {pending && <Toggle value={useAssist} onChange={setUseAssist} label={t('Use the assist ({bonus})', { bonus: assistText(pending) })} />}
                      </div>
                    )}
                    <div className="mx-agent-choice">
                      <Button disabled={busy || !persona.online || missingTarget || !marksOk || (targetId === 'manual' && !targetName.trim())} onClick={agentDo}>
                        {t('Let my agent act')}
                      </Button>
                      <span className="small muted">
                        {t('It takes the action for you with {pool} dice{limit} (Rating × 2, deck limits). Its OS adds to yours.', {
                          pool: agentPc ? agentPc.pool : '—',
                          limit: agentPc?.limit != null ? ` [${agentPc.limit}]` : '',
                        })}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="small muted">{t('Load your agent (Agent panel of the cockpit) so it can assist you or act for you.')}</div>
                )}
              </div>
            )}

            <div className="row spread mx-modal-actions">
              <span className="small faint">{offline ? t('Connect to the Matrix first.') : linkLockedJackOut ? t('No link-lock: you jack out immediately.') : ''}</span>
              <div className="row">
                <Button variant="ghost" onClick={onClose}>
                  {t('Cancel')}
                </Button>
                <Button variant="primary" disabled={busy || offline || missingTarget || !marksOk || pc?.impossible || (targetId === 'manual' && !targetName.trim())} onClick={run}>
                  {action.noTest ? t('Execute') : t('Roll')}
                  {pc && !pc.impossible ? ` ${t('({n} dice)', { n: pc.pool })}` : ''}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
