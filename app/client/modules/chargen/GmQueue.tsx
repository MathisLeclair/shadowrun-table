// GM side of character creation: approval queue with full review, every draft, settings.
import { useMemo, useState } from 'react';
import { Button, Panel, Empty, Badge, Tabs, TextInput, Toggle, NumberInput, Field, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast, openSheet } from '../../lib/ui-store.ts';
import { draftHeadline, normalizeDraft } from '/shared/chargen.ts';
import { t, tn } from '../../lib/i18n.ts';
import { useRulesCtx, useComputed, StatusBadge, timeAgo, headlineText, ownerName } from './common.tsx';
import DraftSummary from './Summary.tsx';
import type { ChargenDraft, ChargenSettings, DraftData, GameView } from '../../../shared/types.ts';
import type { RulesCtx } from './types.ts';

function DraftCard({ d, active, onClick, game }: { d: ChargenDraft; active: boolean; onClick: () => void; game: GameView }) {
  const h = draftHeadline(d.data);
  const ht = headlineText(h);
  const owner = ownerName(game, d);
  return (
    <div className={'cg-dcard card clickable' + (active ? ' active' : '')} onClick={onClick}>
      <div className="cg-dcard-portrait" style={d.data?.concept?.portrait ? { backgroundImage: `url("${String(d.data.concept.portrait).replace(/"/g, '%22')}")` } : {}}>
        {d.data?.concept?.portrait ? '' : ht.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="grow">
        <div className="spread row">
          <strong>{ht.name}</strong>
          <span className="mono small faint" title={t('Metatype / Attributes / Magic / Skills / Resources')}>
            {h.letters}
          </span>
        </div>
        <div className="small muted">{ht.text || '—'}</div>
        <div className="row wrap gap-s cg-dcard-meta">
          <StatusBadge status={d.status} />
          <span className="small faint">
            {owner} · {timeAgo(d.submittedTs && d.status === 'pending' ? d.submittedTs : d.ts)}
          </span>
          {(d.check?.errors ?? 0) > 0 && <Badge color="red">{tn(d.check?.errors ?? 0, '{n} error', '{n} errors')}</Badge>}
        </div>
      </div>
    </div>
  );
}

function Review({ game, d, rc, onDone, onEdit }: { game: GameView; d: ChargenDraft; rc: RulesCtx; onDone: () => void; onEdit: () => void }) {
  const data = useMemo(() => normalizeDraft(d.data) as DraftData, [d.data]);
  const { result } = useComputed(data, rc);
  const [note, setNote] = useState(d.gmNote || '');
  const [busy, setBusy] = useState(false);
  const owner = d.userId === 'gm' ? null : game.users?.[d.userId];
  const resolve = async (approve: boolean) => {
    if (
      approve &&
      !result.ok &&
      !(await confirmAction(tn(result.errors.length, 'one::{n} creation error. Approve this character anyway?', '{n} creation errors. Approve this character anyway?')))
    )
      return;
    if (!approve && !note.trim() && !(await confirmAction(t('Send it back without explaining what to change?')))) return;
    setBusy(true);
    try {
      const res = await send<{ actorId?: string }>('chargen/resolve', { draftId: d.id, approve, note, force: approve && !result.ok });
      toast(approve ? t('Character approved and assigned') : t('Character sent back to the player'), approve ? 'success' : 'info');
      if (approve && res.actorId) openSheet(res.actorId);
      onDone();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };
  return (
    <div className="col">
      {d.status === 'pending' && (
        <Panel title={t('Decision — {name}', { name: owner ? owner.name : t('GM') })}>
          <div className="col">
            <Field label={t('Note to the player (optional when approving)')}>
              <TextInput live multiline rows={2} value={note} placeholder={t('e.g. Replace Allergy (common) with a rarer allergy.')} onChange={setNote} />
            </Field>
            <div className="row wrap">
              <Button variant="primary" disabled={busy} onClick={() => resolve(true)}>
                {result.ok ? `✓ ${t('Approve and create the sheet')}` : `✓ ${t('Approve despite errors')}`}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => resolve(false)}>
                ↺ {t('Ask for changes')}
              </Button>
              <span className="grow"></span>
              <Button variant="ghost" onClick={onEdit}>
                {t('Open in the wizard')}
              </Button>
            </div>
            <div className="small muted">
              {owner
                ? t('Approval creates the sheet (starting nuyen rolled if requested) and gives it to {name}.', { name: owner.name })
                : t('Approval creates the sheet (starting nuyen rolled if requested) and gives it to nobody.')}
            </div>
          </div>
        </Panel>
      )}
      {d.status === 'approved' && d.actorId && (
        <div className="cg-note ok">
          {t('Approved {when}.', { when: timeAgo(d.resolvedTs) })}{' '}
          {game.actors?.[d.actorId] ? (
            <button className="cg-link" onClick={() => openSheet(d.actorId as string)}>
              {t('Open the sheet')} →
            </button>
          ) : (
            t('The sheet has since been deleted.')
          )}
        </div>
      )}
      {d.status === 'rejected' && (
        <div className="cg-note err">{d.gmNote ? t('Sent back {when}: “{note}”', { when: timeAgo(d.resolvedTs), note: d.gmNote }) : t('Sent back {when}', { when: timeAgo(d.resolvedTs) })}</div>
      )}
      {!rc.ready ? <div className="cg-loading">{t('Loading catalogs…')}</div> : <DraftSummary data={data} result={result} rc={rc} />}
    </div>
  );
}

type QueueTab = 'queue' | 'all' | 'settings';

/** props: { game, onOpenWizard(draft|null) } */
export default function GmQueue({ game, onOpenWizard }: { game: GameView; onOpenWizard: (draft: ChargenDraft | null) => void }) {
  const rc = useRulesCtx(game);
  const drafts = game.chargen?.drafts || [];
  const settings: Partial<ChargenSettings> = game.chargen?.settings || {};
  const pending = drafts.filter((d) => d.status === 'pending').sort((a, b) => (a.submittedTs || 0) - (b.submittedTs || 0));
  const others = drafts.filter((d) => d.status !== 'pending').sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const [tab, setTab] = useState<QueueTab>(pending.length ? 'queue' : 'all');
  const [selId, setSelId] = useState<string | null>(null);
  const list = tab === 'queue' ? pending : others;
  const sel = list.find((d) => d.id === selId) || (tab === 'queue' ? pending[0] : null);

  const remove = async (d: ChargenDraft) => {
    const name = headlineText(draftHeadline(d.data)).name;
    const question =
      d.status === 'approved' ? t('Delete the draft “{name}”?\n(The sheet already created is not affected.)', { name }) : t('Delete the draft “{name}”?', { name });
    if (!(await confirmAction(question))) return;
    send('chargen/delete', { draftId: d.id })
      .then(() => setSelId(null))
      .catch(() => null);
  };

  return (
    <div className="cg-gm">
      <div className="row wrap spread cg-gm-bar">
        <Tabs<QueueTab>
          tabs={[
            { id: 'queue', label: t('To review'), badge: pending.length || null },
            { id: 'all', label: t('Drafts & history ({n})', { n: others.length }) },
            { id: 'settings', label: t('Settings') },
          ]}
          value={tab}
          onChange={(x) => {
            setTab(x);
            setSelId(null);
          }}
        />
        <Button variant="primary" onClick={() => onOpenWizard(null)}>
          ✚ {t('Create a character (GM)')}
        </Button>
      </div>

      {tab === 'settings' ? (
        <Panel title={t('Character creation')}>
          <div className="col">
            <Toggle
              value={settings.allowPlayers !== false}
              onChange={(v) => send('chargen/settings', { allowPlayers: v }).catch(() => null)}
              label={t('Players can create and submit characters')}
            />
            <Field label={t('Extra starting karma')} hint={t('Added to the 25 creation karma (more or less heroic campaign)')}>
              <NumberInput value={settings.startingKarmaBonus || 0} min={-25} max={100} onChange={(v) => send('chargen/settings', { startingKarmaBonus: v }).catch(() => null)} />
            </Field>
            <div className="small muted">
              {t('Method: priorities (SR5 core rulebook p.62). Availability 12 maximum, standard / alpha / used grades, at most 7 karma and 5,000¥ kept.')}
            </div>
          </div>
        </Panel>
      ) : (
        <div className={'cg-gm-layout' + (sel ? ' has-sel' : '')}>
          <div className="cg-gm-list">
            {list.map((d) => (
              <DraftCard key={d.id} d={d} game={game} active={sel?.id === d.id} onClick={() => setSelId(d.id)} />
            ))}
            {!list.length && <Empty>{tab === 'queue' ? t('No character awaiting approval.') : t('No drafts.')}</Empty>}
          </div>
          <div className="cg-gm-detail">
            {sel ? (
              <>
                <div className="row wrap cg-mb">
                  <Button small variant="ghost" className="cg-back" onClick={() => setSelId(null)}>
                    ← {t('List')}
                  </Button>
                  <span className="grow"></span>
                  {sel.status !== 'approved' && (
                    <Button small onClick={() => onOpenWizard(sel)}>
                      {t('Open in the wizard')}
                    </Button>
                  )}
                  <Button small variant="danger" onClick={() => remove(sel)}>
                    {t('Delete')}
                  </Button>
                </div>
                <Review key={sel.id} game={game} d={sel} rc={rc} onDone={() => setSelId(null)} onEdit={() => onOpenWizard(sel)} />
              </>
            ) : (
              <Empty>{tab === 'queue' ? t('Characters submitted by players show up here.') : t('Pick a draft to review it.')}</Empty>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
