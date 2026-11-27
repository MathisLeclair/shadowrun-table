// Character creation wizard: step rail, live budgets, autosaved server-side draft, submit (player) / create (GM).
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Button, Select, Field, Panel, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast, openSheet } from '../../lib/ui-store.ts';
import { STEPS, normalizeDraft, emptyDraft } from '/shared/chargen.ts';
import { CHARGEN_STEP_REFS } from '/shared/bookrefs.ts';
import { t, tn, fmtNumber, compare, metatypeLabel } from '../../lib/i18n.ts';
import { useRulesCtx, useComputed, produce, StatusBadge, timeAgo, nuyen } from './common.tsx';
import { StepConcept, StepPriorities, StepMetatype, StepAttributes } from './steps-basics.tsx';
import { StepMagic } from './steps-magic.tsx';
import { StepSkills, StepContacts } from './steps-skills.tsx';
import { StepQualities } from './steps-traits.tsx';
import { StepGear } from './steps-gear.tsx';
import DraftSummary from './Summary.tsx';
import type { ChargenDraft, DraftData, GameView } from '../../../shared/types.ts';
import type { ChargenResult, RulesCtx, StepProps } from './types.ts';
import { BookRef } from '../books/BookRef.tsx';

const COMPONENTS: Record<string, ComponentType<StepProps>> = {
  concept: StepConcept,
  priorities: StepPriorities,
  metatype: StepMetatype,
  attributes: StepAttributes,
  magic: StepMagic,
  skills: StepSkills,
  qualities: StepQualities,
  gear: StepGear,
  contacts: StepContacts,
};
const SAVE_DELAY = 900;

/** shared/chargen.js STEPS entry. */
type StepDef = { id: string; label: string };
const STEP_LIST: StepDef[] = STEPS;

type SaveState = { state: 'idle' | 'saving' | 'dirty' | 'saved' | 'error'; at: number; error?: string };
interface AutosaveRef {
  data: DraftData;
  draftId: string | null;
  dirty: boolean;
  saving: Promise<string> | null;
  timer: ReturnType<typeof setTimeout> | null;
  first: boolean;
}

interface WizardProps {
  game: GameView;
  draft: ChargenDraft | null;
  onExit: () => void;
}
/** props: { game, draft (server record) | null, onExit() } */
export default function Wizard({ game, draft, onExit }: WizardProps) {
  const isGM = game.me.role === 'gm';
  const rc = useRulesCtx(game);
  const [data, setData] = useState<DraftData>(() => {
    if (draft) return normalizeDraft(draft.data) as DraftData;
    const d = emptyDraft() as DraftData;
    if (!isGM) d.concept.player = game.me.name;
    return d;
  });
  const [draftId, setDraftId] = useState<string | null>(draft?.id || null);
  const [stepIdx, setStepIdx] = useState(0);
  const [save, setSave] = useState<SaveState>({ state: draft ? 'saved' : 'idle', at: draft?.ts || 0 });
  const [busy, setBusy] = useState(false);
  const { result, issues } = useComputed(data, rc);

  // ---- Autosave (debounced, one request at a time, flushed on exit)
  const st = useRef<AutosaveRef>({ data, draftId, dirty: false, saving: null, timer: null, first: true });
  st.current.data = data;
  const flush = async (): Promise<string | null> => {
    const s = st.current;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (s.saving) await s.saving.catch(() => null);
    if (!s.dirty) return s.draftId;
    s.dirty = false;
    setSave({ state: 'saving', at: 0 });
    s.saving = send<{ draftId: string }>('chargen/saveDraft', { draftId: s.draftId || undefined, data: s.data }, { silent: true })
      .then((res) => {
        s.draftId = res.draftId;
        setDraftId(res.draftId);
        setSave({ state: s.dirty ? 'dirty' : 'saved', at: Date.now() });
        return res.draftId;
      })
      .catch((err: Error) => {
        s.dirty = true;
        setSave({ state: 'error', at: 0, error: err.message });
        throw err;
      })
      .finally(() => {
        s.saving = null;
      });
    return s.saving;
  };
  useEffect(() => {
    const s = st.current;
    if (s.first) {
      s.first = false;
      return;
    }
    s.dirty = true;
    setSave((x) => (x.state === 'saving' ? x : { state: 'dirty', at: 0 }));
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => flush().catch(() => null), SAVE_DELAY);
  }, [data]);
  useEffect(
    () => () => {
      const s = st.current;
      if (s.dirty) {
        if (s.timer) clearTimeout(s.timer);
        send('chargen/saveDraft', { draftId: s.draftId || undefined, data: s.data }, { silent: true }).catch(() => null);
      }
    },
    []
  );

  const server = draftId ? (game.chargen?.drafts || []).find((d) => d.id === draftId) : null;
  const closed = !isGM && game.chargen?.settings?.allowPlayers === false;
  const locked = closed || (!isGM && !!server && (server.status === 'pending' || server.status === 'approved'));
  const update = (fn: (d: DraftData) => unknown) => {
    if (locked) return;
    setData((d) => produce(d, fn));
  };

  const step = STEP_LIST[stepIdx];
  const go = (i: number) => {
    setStepIdx(Math.max(0, Math.min(STEP_LIST.length - 1, i)));
    document.querySelector('.cg-main')?.scrollTo?.(0, 0);
  };
  const jump = (id: string) => go(STEP_LIST.findIndex((s) => s.id === id));

  const exit = async () => {
    try {
      await flush();
    } catch {
      if (!(await confirmAction(t('The draft could not be saved. Leave anyway?')))) return;
    }
    onExit();
  };

  const submit = async () => {
    setBusy(true);
    try {
      const id = await flush();
      await send('chargen/submit', { draftId: id || st.current.draftId });
      toast(t('Character sent to the GM for approval'), 'success');
      onExit();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };

  const Comp = COMPONENTS[step.id];
  const r = result;
  const stepState = (id: string) => (issues[id]?.errors.length ? 'err' : issues[id]?.warnings.length ? 'warn' : 'ok');
  const name = (data.concept.alias || data.concept.name || '').trim() || t('New character');
  const ref: { source: string; page: number } | undefined = (CHARGEN_STEP_REFS as Record<string, { source: string; page: number }>)[step.id];

  return (
    <div className="cg-wizard">
      <aside className="cg-rail">
        <div className="cg-rail-head">
          <div className="cg-rail-name" title={name}>
            {name}
          </div>
          <div className="small muted">
            {metatypeLabel(data.metatype)}
            {server ? (
              <>
                {' '}
                · <StatusBadge status={server.status} />
              </>
            ) : (
              ''
            )}
          </div>
        </div>
        <nav className="cg-steps">
          {STEP_LIST.map((s, i) => (
            <button key={s.id} className={'cg-stepbtn' + (i === stepIdx ? ' active' : '') + ' ' + stepState(s.id)} onClick={() => go(i)}>
              <span className="cg-stepnum">{i + 1}</span>
              <span className="grow">{t(s.label)}</span>
              <span className="cg-stepdot" title={stepState(s.id) === 'err' ? t('Errors') : stepState(s.id) === 'warn' ? t('Remarks') : t('OK')}></span>
            </button>
          ))}
        </nav>
        <div className={'cg-save ' + save.state} title={save.error || ''}>
          {save.state === 'saving'
            ? t('Saving…')
            : save.state === 'dirty'
              ? t('Unsaved changes…')
              : save.state === 'error'
                ? t('Save failed — will retry on the next change')
                : save.state === 'saved'
                  ? t('Draft saved {when}', { when: timeAgo(save.at) })
                  : t('Not saved yet')}
        </div>
        <Button variant="ghost" onClick={exit}>
          ← {t('Back to the list')}
        </Button>
      </aside>

      <main className="cg-main">
        <header className="cg-head">
          <div className="row wrap spread">
            <h2>
              {stepIdx + 1}. {t(step.label)} {ref ? <BookRef source={ref.source} page={ref.page} /> : null}
            </h2>
            <div className="cg-head-pills">
              <span className={'cg-pill ' + pillState(r.spent.attrPoints, r.budgets.attrPoints)} title={t('Attribute points')}>
                {t('Attr {used}/{total}', { used: r.spent.attrPoints, total: r.budgets.attrPoints })}
              </span>
              <span className={'cg-pill ' + pillState(r.spent.specialPoints, r.budgets.specialPoints)} title={t('Special attribute points')}>
                {t('Spec {used}/{total}', { used: r.spent.specialPoints, total: r.budgets.specialPoints })}
              </span>
              <span className={'cg-pill ' + pillState(r.spent.skillPoints, r.budgets.skillPoints)} title={t('Skill points')}>
                {t('Skills {used}/{total}', { used: r.spent.skillPoints, total: r.budgets.skillPoints })}
              </span>
              <span className={'cg-pill ' + pillState(r.spent.groupPoints, r.budgets.groupPoints)} title={t('Skill group points')}>
                {t('Grp {used}/{total}', { used: r.spent.groupPoints, total: r.budgets.groupPoints })}
              </span>
              <span className={'cg-pill ' + (r.karma.left < 0 ? 'over' : 'left')} title={t('Karma left')}>
                {r.karma.left} K
              </span>
              <span className={'cg-pill ' + (r.nuyen.left < 0 ? 'over' : 'left')} title={t('Nuyen left')}>
                {nuyen(r.nuyen.left)}
              </span>
              <span className={'cg-pill ' + (r.essence <= 0 ? 'over' : 'ok')} title={t('Essence')}>
                {t('Ess {n}', { n: fmtNumber(r.essence) })}
              </span>
              <span className={'cg-pill ' + (r.errors.length ? 'over' : 'ok')} title={t('Validation errors')}>
                {r.errors.length ? tn(r.errors.length, '{n} error', '{n} errors') : `✓ ${t('valid')}`}
              </span>
            </div>
          </div>
        </header>
        {locked && (
          <div className="cg-note warn">
            {closed
              ? t('The GM has closed character creation: this draft is read-only for now.')
              : server?.status === 'pending'
                ? t('This character is awaiting GM approval: withdraw the request from the list to edit it.')
                : t('This character has been approved: it is read-only.')}
          </div>
        )}
        {server?.status === 'rejected' && server.gmNote && (
          <div className="cg-note err">
            <strong>{t('The GM asks for changes:')}</strong> {server.gmNote}
          </div>
        )}
        {!rc.ready && step.id !== 'concept' && step.id !== 'priorities' && <div className="cg-loading small">{t('Loading catalogs…')}</div>}

        <div className={locked ? 'cg-locked' : ''}>
          {step.id === 'summary' ? (
            <SummaryStep
              game={game}
              data={data}
              result={r}
              rc={rc}
              onJump={jump}
              isGM={isGM}
              busy={busy || locked}
              submit={submit}
              flush={flush}
              onExit={onExit}
              draftId={draftId}
              ownerId={server && server.userId !== 'gm' ? server.userId : ''}
            />
          ) : (
            <Comp data={data} update={update} result={r} issues={issues[step.id]} rc={rc} game={game} isGM={isGM} />
          )}
        </div>

        <footer className="cg-foot">
          <Button variant="ghost" disabled={stepIdx === 0} onClick={() => go(stepIdx - 1)}>
            ← {stepIdx > 0 ? t(STEP_LIST[stepIdx - 1].label) : t('Previous')}
          </Button>
          <span className="grow"></span>
          {stepIdx < STEP_LIST.length - 1 && (
            <Button variant="primary" onClick={() => go(stepIdx + 1)}>
              {t(STEP_LIST[stepIdx + 1].label)} →
            </Button>
          )}
        </footer>
      </main>
    </div>
  );
}

function pillState(used: number, total: number) {
  return used > total ? 'over' : used === total ? 'ok' : 'left';
}

interface SummaryStepProps {
  game: GameView;
  data: DraftData;
  result: ChargenResult;
  rc: RulesCtx;
  onJump: (id: string) => void;
  isGM: boolean;
  busy: boolean;
  submit: () => void;
  flush: () => Promise<string | null>;
  onExit: () => void;
  draftId: string | null;
  ownerId: string;
}
function SummaryStep({ game, data, result, rc, onJump, isGM, busy, submit, flush, onExit, draftId, ownerId }: SummaryStepProps) {
  return (
    <div className="cg-step">
      {isGM ? (
        <GmCreateBox game={game} result={result} flush={flush} onExit={onExit} draftId={draftId} data={data} ownerId={ownerId} />
      ) : (
        <div className="cg-submit">
          <div className="grow">
            <strong>{t('Ready?')}</strong>
            <div className="small muted">
              {result.ok ? t('The GM will review your character. You can still edit it if they ask for changes.') : t('Fix the reported errors before sending your character.')}
            </div>
          </div>
          <Button variant="accent" disabled={busy || !result.ok || !rc.ready} onClick={submit}>
            {t('Send to the GM')} ✉
          </Button>
        </div>
      )}
      {!rc.ready ? <div className="cg-loading">{t('Loading catalogs…')}</div> : <DraftSummary data={data} result={result} rc={rc} onJump={onJump} />}
    </div>
  );
}

interface GmCreateBoxProps {
  game: GameView;
  result: ChargenResult;
  flush: () => Promise<string | null>;
  onExit: () => void;
  draftId: string | null;
  data: DraftData;
  ownerId: string;
}
function GmCreateBox({ game, result, flush, onExit, draftId, data, ownerId }: GmCreateBoxProps) {
  const [type, setType] = useState<'pc' | 'npc'>('pc');
  const [assignTo, setAssignTo] = useState(ownerId || '');
  const [busy, setBusy] = useState(false);
  const players = Object.values(game.users || {}).sort((a, b) => compare(a.name, b.name));
  const create = async () => {
    if (
      !result.ok &&
      !(await confirmAction(
        tn(result.errors.length, 'one::This character has {n} creation error. Create it anyway?', 'This character has {n} creation errors. Create it anyway?')
      ))
    )
      return;
    setBusy(true);
    try {
      let id = draftId;
      try {
        id = await flush();
      } catch {}
      const res = await send<{ actorId: string }>('chargen/create', {
        draftId: id || undefined,
        data: id ? undefined : data,
        type,
        assignTo: type === 'pc' && assignTo ? assignTo : undefined,
        force: !result.ok,
      });
      toast(type === 'pc' ? t('Player character created') : t('NPC created'), 'success');
      openSheet(res.actorId);
      onExit();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };
  return (
    <Panel title={t('Create directly (GM)')} className="cg-mb">
      <div className="row wrap cg-gm-create">
        <Field label={t('Type')}>
          <Select
            value={type}
            onChange={setType}
            options={[
              { value: 'pc', label: t('Player character') },
              { value: 'npc', label: t('NPC') },
            ]}
          />
        </Field>
        {type === 'pc' && (
          <Field label={t('Assign to')}>
            <Select value={assignTo} onChange={setAssignTo} options={[{ value: '', label: t('— Nobody for now —') }, ...players.map((u) => ({ value: u.id, label: u.name }))]} />
          </Field>
        )}
        <span className="grow"></span>
        <Button variant="primary" disabled={busy} onClick={create}>
          {result.ok ? t('Create the character') : t('Create despite errors')}
        </Button>
      </div>
      <div className="small muted">
        {type === 'pc'
          ? t('No approval step: the sheet is created right away and assigned to the chosen player. Starting nuyen is rolled if the option is checked.')
          : t('No approval step: the sheet is created right away. Starting nuyen is rolled if the option is checked.')}
      </div>
    </Panel>
  );
}
