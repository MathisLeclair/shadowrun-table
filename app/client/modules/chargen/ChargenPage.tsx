// Main tab « Création »: SR5 Priority character creator (players: drafts + wizard; GM: approval queue + wizard).
import { useMemo, useState } from 'react';
import { Button, Empty, confirmAction } from '../../lib/ui.tsx';
import { send, useServerEvent, type GameProps } from '../../lib/net.ts';
import { toast, openSheet, goTab } from '../../lib/ui-store.ts';
import { draftHeadline, normalizeDraft } from '/shared/chargen.ts';
import { t, tn } from '../../lib/i18n.ts';
import { useRulesCtx, useComputed, StatusBadge, timeAgo, headlineText } from './common.tsx';
import Wizard from './Wizard.tsx';
import GmQueue from './GmQueue.tsx';
import DraftSummary from './Summary.tsx';
import type { ChargenDraft, DraftData, GameView } from '../../../shared/types.ts';
import './chargen.css';
import '../combat/combat.css'; // stat block styles (summary preview)

export default function ChargenPage({ game }: GameProps) {
  const [open, setOpen] = useState<{ draft: ChargenDraft | null; key: string } | null>(null); // { draft|null, key }
  const isGM = game.me.role === 'gm';
  useServerEvent(
    'chargen:resolved',
    (e: { status: string; note?: string }) => {
      if (isGM) return;
      if (e.status === 'approved') toast(t('Ton personnage a été validé par le MJ !'), 'success', 6000);
      else toast(e.note ? t('Le MJ demande des changements : {note}', { note: e.note }) : t('Le MJ demande des changements'), 'warn', 8000);
    },
    [isGM]
  );
  const openWizard = (draft: ChargenDraft | null) => setOpen({ draft, key: draft?.id || `new-${Date.now()}` });

  if (open) {
    return (
      <div className="page cg-page cg-page-wizard">
        <Wizard key={open.key} game={game} draft={open.draft} onExit={() => setOpen(null)} />
      </div>
    );
  }
  return (
    <div className="page cg-page">
      <div className="page-title">
        <h2>{t('Création de personnage')}</h2>
        <span className="small muted">{t('Système de priorités SR5')}</span>
      </div>
      {isGM ? <GmQueue game={game} onOpenWizard={openWizard} /> : <PlayerHome game={game} onOpen={openWizard} />}
    </div>
  );
}

function PlayerHome({ game, onOpen }: { game: GameView; onOpen: (draft: ChargenDraft | null) => void }) {
  const settings: Partial<GameView['chargen']['settings']> = game.chargen?.settings || {};
  const drafts = useMemo(() => [...(game.chargen?.drafts || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)), [game.chargen?.drafts]);
  const [viewId, setViewId] = useState<string | null>(null);
  const viewing = drafts.find((d) => d.id === viewId);
  const closed = settings.allowPlayers === false;

  if (viewing) return <DraftView game={game} d={viewing} onBack={() => setViewId(null)} onEdit={() => onOpen(viewing)} />;

  const open = (d: ChargenDraft) => (d.status === 'draft' || d.status === 'rejected' ? onOpen(d) : setViewId(d.id));
  const remove = async (d: ChargenDraft) => {
    if (!(await confirmAction(t('Supprimer « {name} » ?', { name: headlineText(draftHeadline(d.data)).name })))) return;
    send('chargen/delete', { draftId: d.id }).catch(() => null);
  };
  return (
    <div className="col gap-l">
      {closed && <div className="cg-note warn">{t('Le MJ a fermé la création de personnage pour l’instant : tu peux consulter tes brouillons mais pas les modifier.')}</div>}
      <div className="cg-hero">
        <div className="grow">
          <h3>{t('Un nouveau runner pour les Ombres de Seattle')}</h3>
          <p className="muted">
            {t(
              'L’assistant suit le livre de base : tu répartis les priorités A à E, puis les attributs, la magie, les compétences, les qualités, l’équipement et les contacts. Tout est vérifié en direct et enregistré automatiquement ; une fois prêt, tu l’envoies au MJ qui le valide.'
            )}
          </p>
        </div>
        <Button variant="accent" disabled={closed} onClick={() => onOpen(null)}>
          ✚ {t('Nouveau personnage')}
        </Button>
      </div>
      {drafts.length ? (
        <div className="cg-drafts">
          {drafts.map((d) => {
            const h = draftHeadline(d.data);
            const ht = headlineText(h);
            return (
              <div key={d.id} className="card clickable cg-draft" onClick={() => open(d)}>
                <div className="spread row">
                  <h4>{ht.name}</h4>
                  <StatusBadge status={d.status} />
                </div>
                <div className="small muted">{ht.text || t('Concept à définir')}</div>
                <div className="row wrap gap-s small faint cg-draft-meta">
                  <span className="mono" title={t('Métatype / Attributs / Magie / Compétences / Ressources')}>
                    {h.letters}
                  </span>
                  <span>· {t('modifié {when}', { when: timeAgo(d.ts) })}</span>
                  {d.check && d.status !== 'approved' && (
                    <span className={d.check.errors ? 'red' : 'green'}>· {d.check.errors ? tn(d.check.errors, '{n} erreur', '{n} erreurs') : t('valide')}</span>
                  )}
                </div>
                {d.status === 'rejected' && d.gmNote && <div className="cg-quote small">« {d.gmNote} »</div>}
                <div className="row gap-s cg-draft-actions" onClick={(e) => e.stopPropagation()}>
                  {d.status === 'approved' && d.actorId && game.actors?.[d.actorId] && (
                    <Button small variant="primary" onClick={() => openSheet(d.actorId as string)}>
                      {t('Ouvrir la fiche')}
                    </Button>
                  )}
                  {d.status === 'pending' && (
                    <Button
                      small
                      onClick={() =>
                        send('chargen/withdraw', { draftId: d.id })
                          .then(() => toast(t('Demande retirée : tu peux de nouveau modifier ce personnage'), 'info'))
                          .catch(() => null)
                      }
                    >
                      {t('Retirer la demande')}
                    </Button>
                  )}
                  {d.status !== 'pending' && (
                    <Button small variant="ghost" onClick={() => remove(d)}>
                      {t('Supprimer')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>{t('Aucun brouillon pour l’instant.')}</Empty>
      )}
    </div>
  );
}

function DraftView({ game, d, onBack, onEdit }: { game: GameView; d: ChargenDraft; onBack: () => void; onEdit: () => void }) {
  const rc = useRulesCtx(game);
  const data = useMemo(() => normalizeDraft(d.data) as DraftData, [d.data]);
  const { result } = useComputed(data, rc);
  const h = headlineText(draftHeadline(d.data));
  return (
    <div className="col">
      <div className="row wrap">
        <Button variant="ghost" onClick={onBack}>
          ← {t('Mes personnages')}
        </Button>
        <h3 className="grow">{h.name}</h3>
        <StatusBadge status={d.status} />
        {d.status === 'pending' && (
          <Button
            onClick={() =>
              send('chargen/withdraw', { draftId: d.id })
                .then(onEdit)
                .catch(() => null)
            }
          >
            {t('Retirer et modifier')}
          </Button>
        )}
        {d.status === 'approved' && d.actorId && game.actors?.[d.actorId] && (
          <Button
            variant="primary"
            onClick={() => {
              openSheet(d.actorId as string);
              goTab('sheet');
            }}
          >
            {t('Voir ma fiche')}
          </Button>
        )}
      </div>
      {d.status === 'pending' && <div className="cg-note">{t('Envoyé au MJ {when}. Tu seras prévenu dès qu’il l’aura relu.', { when: timeAgo(d.submittedTs) })}</div>}
      {!rc.ready ? <div className="cg-loading">{t('Chargement des catalogues…')}</div> : <DraftSummary data={data} result={result} rc={rc} />}
    </div>
  );
}
