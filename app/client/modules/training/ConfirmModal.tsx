// Summary card shown before sending a training request: target rating, karma before/after, time,
// instructor option, warnings, and how the request will be validated.
import { useState } from 'react';
import { Modal, Button, Field, NumberInput, TextInput, Toggle, Badge } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, fmtNuyen } from '../../lib/i18n.ts';
import { magicProfile, powerPoints, withInstructor } from '/shared/advancement.ts';
import { settingsOf, makeQuoter, quoteContext, kindLabel, ruleText, fmtDays, labelOf, errorOf, warningsOf } from './common.tsx';
import type { Actor, GameView } from '../../../shared/types.ts';
import type { TrainingDraft } from './types.ts';

const MULTI = ['attribute', 'skill', 'skillGroup', 'knowledge', 'powerPoint'];
const MAX_TO: Record<string, number> = { attribute: 12, skill: 13, skillGroup: 12, knowledge: 12, powerPoint: 12, power: 12 };

interface ConfirmModalProps {
  game: GameView;
  actor: Actor;
  draft: TrainingDraft;
  isGM: boolean;
  onClose: () => void;
}

export default function ConfirmModal({ game, actor, draft, isGM, onClose }: ConfirmModalProps) {
  const [req, setReq] = useState<TrainingDraft>(() => ({ ...draft }));
  const [precision, setPrecision] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TrainingDraft>) => setReq((r) => ({ ...r, ...patch }));

  const settings = settingsOf(game);
  const quoter = makeQuoter(game, actor);
  const effective = req.kind === 'power' && precision.trim() ? { ...req, name: `${req.name} (${precision.trim()})` } : req;
  const qt = quoter(effective);
  const ctx = quoteContext(game, actor);
  const prof = magicProfile(actor);
  const multi = MULTI.includes(req.kind) || (req.kind === 'power' && req.levels);
  const canInstructor = settings.useTime && qt.daysBase > 0;
  const soloDays = qt.daysBase;
  const insPreview = canInstructor ? withInstructor(qt.daysBase, req.kind, settings) : null;
  const manual = req.kind === 'other' || (['quality', 'spell', 'power'].includes(req.kind) && !req.catalogId);
  const karmaAvail = (Number(actor.karma) || 0) - ctx.reservedKarma;
  const nuyenAvail = (Number(actor.nuyen) || 0) - ctx.reservedNuyen;
  const pp = req.kind === 'power' ? powerPoints(actor) : null;

  let approvalText;
  if (isGM) approvalText = qt.days > 0 ? t('Approved directly (GM): training starts now.') : t('Approved directly (GM): immediate effect.');
  else if (settings.approval === 'always' || manual)
    approvalText = manual
      ? t('Manual entry: the GM must approve your request. Karma is only spent on approval.')
      : t('the GM must approve your request. Karma is only spent on approval.');
  else approvalText = qt.days > 0 ? t('Automatic approval: training starts as soon as you send it.') : t('Automatic approval: immediate effect.');

  const submit = async () => {
    if (qt.error || busy) return;
    setBusy(true);
    try {
      const res = await send<{ status?: string }>('training/request', { ...effective, actorId: actor.id });
      const msg = res?.status === 'pending' ? t('Request sent to the GM') : res?.status === 'done' ? t('Advancement gained!') : t('Training started');
      toast(msg, 'success');
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const toValue = req.to ?? qt.to;
  return (
    <Modal title={req.kind ? kindLabel(req.kind) : t('Advancement')} width={560} onClose={onClose}>
      <div className="training-confirm col gap-l">
        <div>
          <div className="training-confirm-label">{labelOf(qt)}</div>
          <div className="small muted">
            {actor.name} · {ruleText(req.kind)}
          </div>
        </div>

        <div className="training-confirm-fields">
          {multi && (
            <Field label={req.kind === 'power' ? t('Target level') : t('Target rating')} hint={t('Current: {n}', { n: qt.from })}>
              <NumberInput value={toValue} min={qt.from + 1} max={MAX_TO[req.kind] || 12} onChange={(n) => set({ to: n })} />
            </Field>
          )}
          {(req.kind === 'skill' || req.kind === 'knowledge') && (
            <Field label={t('Specialization (optional)')} hint={t('+7 karma · +1 month')}>
              <TextInput live value={req.spec || ''} placeholder={t('e.g. Ares Predator')} onChange={(v) => set({ spec: v })} />
            </Field>
          )}
          {req.kind === 'specialization' && (
            <Field label={t('Specialization')}>
              <TextInput live value={req.spec || ''} placeholder={t('e.g. Katana, Corps, Drones…')} onChange={(v) => set({ spec: v })} autoFocus />
            </Field>
          )}
          {req.kind === 'power' && !req.catalogId && (
            <Field label={t('Cost (PP per level)')}>
              <NumberInput value={req.pp || 0} min={0} max={10} step={0.25} onChange={(n) => set({ pp: n })} />
            </Field>
          )}
          {req.kind === 'power' && !draft.existing && (
            <Field label={t('Detail (optional)')} hint={t('e.g. Improved Ability (Pistols)')}>
              <TextInput live value={precision} placeholder={t('Skill, sense…')} onChange={setPrecision} />
            </Field>
          )}
          {req.kind === 'initiation' && (
            <div className="col">
              <span className="field-label">{t('Options (−10% each)')}</span>
              <Toggle label={t('Group initiation')} value={req.options?.group} onChange={(v) => set({ options: { ...req.options, group: v } })} />
              <Toggle label={t('Ordeal')} value={req.options?.ordeal} onChange={(v) => set({ options: { ...req.options, ordeal: v } })} />
              <Toggle label={t('Schooling')} value={req.options?.schooling} onChange={(v) => set({ options: { ...req.options, schooling: v } })} />
              <Field label={prof.MAG > 0 ? t('Metamagic learned (optional)') : t('Echo learned (optional)')}>
                <TextInput
                  live
                  value={req.options?.metamagic || ''}
                  placeholder={prof.MAG > 0 ? t('e.g. Centering, Masking…') : t('e.g. Neuro Filter…')}
                  onChange={(v) => set({ options: { ...req.options, metamagic: v } })}
                />
              </Field>
              {prof.hasPowers && <Toggle label={t('Gain a Power Point')} value={req.options?.powerPoint} onChange={(v) => set({ options: { ...req.options, powerPoint: v } })} />}
            </div>
          )}
        </div>

        {canInstructor && insPreview && (
          <div className="training-instructor">
            <Toggle label={t('With an instructor')} value={!!req.instructor} onChange={(v) => set({ instructor: v })} title={ruleText('instructor')} />
            <div className="small muted">
              {t('Alone: {solo} · With an instructor: {days} for {cost}', { solo: fmtDays(soloDays), days: fmtDays(insPreview.days), cost: fmtNuyen(insPreview.nuyen) })}
              <span className="faint"> {t('({rate}/week, −{pct}%)', { rate: fmtNuyen(insPreview.rate), pct: settings.instructorTimeReduction })}</span>
            </div>
          </div>
        )}

        <div className="training-summary">
          <div className="training-sum-row">
            <span>{t('Karma')}</span>
            <span className="mono">
              {karmaAvail} → <strong className={karmaAvail - qt.karmaCost < 0 ? 'red' : 'cyan'}>{karmaAvail - qt.karmaCost}</strong> <span className="muted">(−{qt.karmaCost})</span>
            </span>
          </div>
          <div className="training-sum-row">
            <span>{t('Duration')}</span>
            <span>
              {fmtDays(qt.days)}
              {qt.instructor && soloDays !== qt.days ? (
                <>
                  {' '}
                  <s className="faint">{fmtDays(soloDays)}</s>
                </>
              ) : (
                ''
              )}
              {!settings.useTime ? (
                <>
                  {' '}
                  <span className="faint small">{t('(training time disabled)')}</span>
                </>
              ) : (
                ''
              )}
            </span>
          </div>
          {qt.nuyenCost > 0 && (
            <div className="training-sum-row">
              <span>{t('Instructor')}</span>
              <span className="mono">
                {fmtNuyen(nuyenAvail)} → <strong className="magenta">{fmtNuyen(nuyenAvail - qt.nuyenCost)}</strong>
              </span>
            </div>
          )}
          {pp && (
            <div className="training-sum-row">
              <span>{t('Power Points')}</span>
              <span className="mono">
                {t('{n} free', { n: pp.free })} → <strong className="cyan">{Math.round((pp.free - (qt.ppCost || 0)) * 100) / 100}</strong>
              </span>
            </div>
          )}
        </div>

        {warningsOf(qt).map((w) => (
          <div key={w} className="training-warn small">
            ⚠ {w}
          </div>
        ))}
        {qt.error && <div className="error small">{errorOf(qt)}</div>}

        {isGM && <Toggle label={t('Granted by the GM (no karma or nuyen)')} value={!!req.free} onChange={(v) => set({ free: v })} />}
        <Field label={isGM ? t('Note (history)') : t('Note for the GM (optional)')}>
          <TextInput live value={req.note || ''} placeholder={isGM ? '' : t('e.g. Lessons with Perrine, the local gym…')} onChange={(v) => set({ note: v })} />
        </Field>

        <div className="row spread wrap">
          <span className="small muted grow">
            {manual && !isGM ? (
              <>
                <Badge color="magenta">{t('manual')}</Badge>{' '}
              </>
            ) : (
              ''
            )}
            {approvalText}
          </span>
          <span className="row">
            <Button variant="ghost" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" disabled={!!qt.error || busy} onClick={submit}>
              {isGM ? t('Apply') : settings.approval === 'always' || manual ? t('Send the request') : t('Approve')}
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}
