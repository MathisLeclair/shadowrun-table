// GM quests: grouped by act, expandable quest editor with phases, linked NPCs/maps, rewards, notes.
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, TextInput, SearchBox, Empty, Badge, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { openSheet } from '../../lib/ui-store.ts';
import { t, tk } from '../../lib/i18n.js';
import {
  campaignOf, QUEST_STATUS, MdEditor, npcInfo, mapInfo, templateOptions, mapOptions, groupedOptions,
  spawnNpc, showMapToPlayers, openMap, useDocs, DocSelect, DocButton, cx, usePersistent, parseDocRef,
} from './common.tsx';
import type { CampaignAct, GameView, Quest, QuestPhase, QuestStatus } from '../../../shared/types.ts';
import type { CampaignNav, DocsState, Focus } from './types.ts';

const FILTERS = [
  { id: 'all', label: tk('quêtes::Toutes') },
  { id: 'active', label: tk('quêtes::En cours') },
  { id: 'upcoming', label: tk('quêtes::À venir') },
  { id: 'done', label: tk('quêtes::Terminées') },
  { id: 'skipped', label: tk('quêtes::Ignorées') },
];

function StatusSelect({ quest }: { quest: Quest }) {
  return (
    <select
      className={cx('input camp-status-select', `st-${quest.status}`)}
      value={quest.status}
      title={t('Statut')}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => send('campaign/setQuestStatus', { questId: quest.id, status: e.target.value as QuestStatus })}
    >
      {QUEST_STATUS.map((s) => (
        <option key={s.id} value={s.id}>
          {t(s.label)}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
interface PhaseProps {
  quest: Quest;
  phase: QuestPhase;
  index: number;
  count: number;
  editing: boolean;
}
function Phase({ quest, phase, index, count, editing }: PhaseProps) {
  const [open, setOpen] = useState(false);
  const q = { questId: quest.id, phaseId: phase.id };
  return (
    <li className={cx('camp-phase', phase.done && 'done', open && 'open')}>
      <div className="camp-phase-row">
        <input
          type="checkbox"
          className="camp-cb"
          checked={phase.done}
          title={phase.done ? t('Marquer comme non faite') : t('Marquer comme faite')}
          onChange={(e) => send('campaign/togglePhase', { ...q, done: e.target.checked })}
        />
        {editing ? (
          <TextInput className="camp-phase-title-input" value={phase.title} onChange={(title) => send('campaign/updatePhase', { ...q, patch: { title } })} />
        ) : (
          <button className="camp-phase-title" onClick={() => setOpen(!open)}>
            <span className="mono faint">{index + 1}.</span> {phase.title}
            {phase.text && <span className={cx('camp-chev', open && 'open')}>›</span>}
          </button>
        )}
        {editing && (
          <div className="row gap-s">
            <IconButton icon="↑" title={t('Monter')} disabled={index === 0} onClick={() => send('campaign/movePhase', { ...q, dir: -1 })} />
            <IconButton icon="↓" title={t('Descendre')} disabled={index === count - 1} onClick={() => send('campaign/movePhase', { ...q, dir: 1 })} />
            <IconButton icon="✎" title={t('Détails')} onClick={() => setOpen(!open)} />
            <IconButton
              icon="✕"
              title={t('Supprimer la phase')}
              onClick={async () => {
                if (await confirmAction(t('Supprimer la phase « {title} » ?', { title: phase.title }))) send('campaign/deletePhase', q);
              }}
            />
          </div>
        )}
      </div>
      {open && (
        <div className="camp-phase-text">
          <MdEditor
            value={phase.text}
            rows={6}
            initialMode={phase.text ? 'preview' : 'edit'}
            emptyText={t('Pas de détail pour cette phase.')}
            onSave={(text) => send('campaign/updatePhase', { ...q, patch: { text } })}
          />
        </div>
      )}
    </li>
  );
}

function Phases({ quest }: { quest: Quest }) {
  const [editing, setEditing] = useState(false);
  const [k, setK] = useState(0);
  const add = async (title: string) => {
    const clean = String(title || '').trim();
    if (!clean) return;
    await send('campaign/addPhase', { questId: quest.id, title: clean }).catch(() => {});
    setK(k + 1); // reset the input
  };
  const done = quest.phases.filter((p) => p.done).length;
  return (
    <section className="camp-sec">
      <div className="camp-sec-head">
        <h4>
          {t('Phases')}{' '}
          <span className="muted small">
            {done}/{quest.phases.length}
          </span>
        </h4>
        <Button small variant={editing ? 'primary' : 'ghost'} onClick={() => setEditing(!editing)}>
          {editing ? t('Terminer') : '✎ ' + t('Modifier')}
        </Button>
      </div>
      {quest.phases.length ? (
        <ol className="camp-phases">
          {quest.phases.map((p, i) => (
            <Phase key={p.id} quest={quest} phase={p} index={i} count={quest.phases.length} editing={editing} />
          ))}
        </ol>
      ) : (
        <div className="muted small">{t('Aucune phase.')}</div>
      )}
      {editing && (
        <div className="camp-add-row">
          <TextInput key={k} value="" placeholder={t('Nouvelle phase… (Entrée pour ajouter)')} onChange={add} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Linked NPCs / maps
// ---------------------------------------------------------------------------
function LinkedNpcs({ game, quest }: { game: GameView; quest: Quest }) {
  const [pick, setPick] = useState('');
  const opts = templateOptions(game).filter((o) => !quest.npcs.includes(o.id));
  const setNpcs = (npcs: string[]) => send('campaign/updateQuest', { questId: quest.id, patch: { npcs } });
  return (
    <section className="camp-sec">
      <div className="camp-sec-head">
        <h4>{t('PNJ liés')}</h4>
      </div>
      {quest.npcs.length ? (
        <ul className="camp-links">
          {quest.npcs.map((id) => {
            const n = npcInfo(game, id);
            return (
              <li key={id} className={cx('camp-linkrow', n.kind === 'missing' && 'missing')}>
                <span className="camp-ico">☠</span>
                <div className="grow">
                  <div className="camp-linkname">{n.name}</div>
                  <div className="faint small">{n.kind === 'missing' ? t('Fiche introuvable ({id})', { id }) : n.folder}</div>
                </div>
                {n.kind === 'template' && (
                  <>
                    <Button small variant="primary" title={t('Placer sur la carte affichée')} onClick={() => spawnNpc(game, id)}>
                      {t('Placer sur la carte')}
                    </Button>
                    <IconButton icon="◌" title={t('Placer caché (invisible pour les joueurs)')} onClick={() => spawnNpc(game, id, { hidden: true })} />
                  </>
                )}
                {n.kind === 'actor' && (
                  <Button small onClick={() => openSheet(id)}>
                    {t('Fiche')}
                  </Button>
                )}
                <IconButton icon="✕" title={t('Retirer de la quête')} onClick={() => setNpcs(quest.npcs.filter((x) => x !== id))} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="muted small">{t('Aucun PNJ lié.')}</div>
      )}
      <div className="camp-add-row">
        <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{opts.length ? t('— Ajouter un PNJ du bestiaire —') : t('Bestiaire vide ou déjà tout lié')}</option>
          {groupedOptions(opts)}
        </select>
        <Button
          small
          disabled={!pick}
          onClick={() => {
            setNpcs([...quest.npcs, pick]);
            setPick('');
          }}
        >
          {t('Ajouter')}
        </Button>
      </div>
    </section>
  );
}

function LinkedMaps({ game, quest }: { game: GameView; quest: Quest }) {
  const [pick, setPick] = useState('');
  const opts = mapOptions(game).filter((o) => !quest.maps.includes(o.id));
  const active = game.scene?.activeMapId;
  const setMaps = (maps: string[]) => send('campaign/updateQuest', { questId: quest.id, patch: { maps } });
  return (
    <section className="camp-sec">
      <div className="camp-sec-head">
        <h4>{t('Cartes liées')}</h4>
      </div>
      {quest.maps.length ? (
        <ul className="camp-links">
          {quest.maps.map((id) => {
            const m = mapInfo(game, id);
            return (
              <li key={id} className={cx('camp-linkrow', !m.exists && 'missing', active === id && 'live')}>
                <span className="camp-ico">▦</span>
                <div className="grow">
                  <div className="camp-linkname">
                    {m.name} {active === id && <Badge color="green">{t('carte::Affichée')}</Badge>}
                  </div>
                  <div className="faint small">{m.exists ? m.folder : t('Carte introuvable ({id})', { id })}</div>
                </div>
                {m.exists && (
                  <>
                    {active !== id && (
                      <Button small variant="primary" onClick={() => showMapToPlayers(game, id)}>
                        {t('Afficher aux joueurs')}
                      </Button>
                    )}
                    <Button small variant="ghost" onClick={() => openMap(id)}>
                      {t('Ouvrir')}
                    </Button>
                  </>
                )}
                <IconButton icon="✕" title={t('Retirer de la quête')} onClick={() => setMaps(quest.maps.filter((x) => x !== id))} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="muted small">{t('Aucune carte liée.')}</div>
      )}
      <div className="camp-add-row">
        <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{opts.length ? t('— Ajouter une carte —') : t('Aucune autre carte disponible')}</option>
          {groupedOptions(opts)}
        </select>
        <Button
          small
          disabled={!pick}
          onClick={() => {
            setMaps([...quest.maps, pick]);
            setPick('');
          }}
        >
          {t('Ajouter')}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quest card
// ---------------------------------------------------------------------------
interface QuestCardProps {
  game: GameView;
  quest: Quest;
  acts: CampaignAct[];
  open: boolean;
  onToggle: () => void;
  nav: CampaignNav;
  docs: DocsState;
  first: boolean;
  last: boolean;
  highlight: boolean;
}
function QuestCard({ game, quest, acts, open, onToggle, nav, docs, first, last, highlight }: QuestCardProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlight && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [highlight]);
  const patch = (p: Partial<Quest>) => send('campaign/updateQuest', { questId: quest.id, patch: p });
  const done = quest.phases.filter((p) => p.done).length;
  const nextPhase = quest.phases.find((p) => !p.done);
  const anchor = parseDocRef(quest.doc)?.anchor || '';

  return (
    <article ref={ref} className={cx('camp-quest', `st-${quest.status}`, open && 'open', highlight && 'flash')}>
      <header className="camp-quest-head" onClick={onToggle}>
        <span className={cx('camp-chev', open && 'open')}>›</span>
        <div className="grow camp-quest-headtext">
          <div className="camp-quest-title">{quest.title}</div>
          {!open && nextPhase && quest.status === 'active' && <div className="small muted camp-ellipsis">{t('Prochaine : {phase}', { phase: nextPhase.title })}</div>}
        </div>
        <span className="mono small muted" title={t('Phases faites')}>
          {done}/{quest.phases.length}
        </span>
        {quest.npcs.length > 0 && (
          <span className="small faint" title={t('PNJ liés')}>
            ☠ {quest.npcs.length}
          </span>
        )}
        {quest.maps.length > 0 && (
          <span className="small faint" title={t('Cartes liées')}>
            ▦ {quest.maps.length}
          </span>
        )}
        <StatusSelect quest={quest} />
      </header>
      {open && (
        <div className="camp-quest-body">
          <div className="camp-quest-meta">
            <label className="field grow">
              <span className="field-label">{t('Titre')}</span>
              <TextInput value={quest.title} onChange={(title) => title.trim() && patch({ title })} />
            </label>
            <label className="field">
              <span className="field-label">{t('Acte')}</span>
              <select className="input" value={quest.actId} onChange={(e) => patch({ actId: e.target.value })}>
                {!acts.some((a) => a.id === quest.actId) && <option value={quest.actId}>{t('— Sans acte —')}</option>}
                {acts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t('Document')}</span>
              <div className="row gap-s">
                <DocSelect
                  value={quest.doc}
                  docs={docs.list}
                  onChange={(name) => patch({ doc: name && anchor && parseDocRef(quest.doc)?.name === name ? `${name}#${anchor}` : name })}
                />
                {quest.doc && <IconButton icon="❐" title={t('Ouvrir {doc}', { doc: quest.doc })} onClick={() => nav.openDoc(quest.doc)} />}
              </div>
            </label>
          </div>
          {quest.doc && (
            <div className="camp-mb">
              <DocButton docRef={quest.doc} nav={nav} label={t('Ouvrir le document lié')} />
            </div>
          )}

          <MdEditor label={t('Résumé')} value={quest.summary} rows={5} onSave={(summary) => patch({ summary })} />
          <Phases quest={quest} />
          <div className="grid-2">
            <LinkedNpcs game={game} quest={quest} />
            <LinkedMaps game={game} quest={quest} />
          </div>
          <div className="grid-2">
            <MdEditor label={t('Récompenses')} value={quest.rewards} rows={5} onSave={(rewards) => patch({ rewards })} />
            <MdEditor label={t('Notes MJ')} value={quest.gmNotes} rows={5} onSave={(gmNotes) => patch({ gmNotes })} />
          </div>
          <footer className="camp-quest-foot">
            <div className="row gap-s">
              <Button small variant="ghost" disabled={first} title={t("Monter dans l'acte")} onClick={() => send('campaign/moveQuest', { questId: quest.id, dir: -1 })}>
                ↑ {t('Monter')}
              </Button>
              <Button small variant="ghost" disabled={last} title={t("Descendre dans l'acte")} onClick={() => send('campaign/moveQuest', { questId: quest.id, dir: 1 })}>
                ↓ {t('Descendre')}
              </Button>
            </div>
            <Button
              small
              variant="danger"
              onClick={async () => {
                if (await confirmAction(t('Supprimer définitivement la quête « {title} » ?', { title: quest.title }))) send('campaign/deleteQuest', { questId: quest.id });
              }}
            >
              {t('Supprimer la quête')}
            </Button>
          </footer>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Act group
// ---------------------------------------------------------------------------
function ActHeader({ act, quests, onAdd }: { act: CampaignAct; quests: Quest[]; onAdd: () => void }) {
  const [edit, setEdit] = useState(false);
  const [showSummary, setShowSummary] = usePersistent(`sr.campaign.actOpen.${act.id}`, false);
  const done = quests.filter((q) => q.status === 'done' || q.status === 'skipped').length;
  return (
    <div className="camp-act">
      <div className="camp-act-head">
        {edit ? (
          <TextInput className="camp-act-input" value={act.title} onChange={(title) => title.trim() && send('campaign/updateAct', { actId: act.id, patch: { title } })} />
        ) : (
          <button className="camp-act-name" onClick={() => setShowSummary(!showSummary)}>
            <span className={cx('camp-chev', showSummary && 'open')}>›</span> {act.title}
          </button>
        )}
        <span className="muted small">{t('{done}/{total} bouclées', { done, total: quests.length })}</span>
        <span className="grow"></span>
        <Button
          small
          variant="ghost"
          onClick={() => {
            setEdit(!edit);
            if (!edit) setShowSummary(true);
          }}
        >
          {edit ? t('Terminer') : '✎ ' + t('Acte')}
        </Button>
        {edit && !quests.length && (
          <Button
            small
            variant="danger"
            onClick={async () => {
              if (await confirmAction(t("Supprimer l'acte « {title} » ?", { title: act.title }))) send('campaign/deleteAct', { actId: act.id });
            }}
          >
            {t('Supprimer')}
          </Button>
        )}
        <Button small onClick={onAdd}>
          + {t('Quête')}
        </Button>
      </div>
      {(showSummary || edit) && (
        <div className="camp-act-sum">
          <MdEditor
            key={edit ? 'e' : 'v'}
            value={act.summary}
            rows={5}
            initialMode={edit ? 'edit' : 'preview'}
            onSave={(summary) => send('campaign/updateAct', { actId: act.id, patch: { summary } })}
          />
        </div>
      )}
    </div>
  );
}

export default function QuestsView({ game, nav, focus }: { game: GameView; nav: CampaignNav; focus: Focus | null }) {
  const c = campaignOf(game);
  const docs = useDocs();
  const [filter, setFilter] = usePersistent('sr.campaign.questFilter', 'all');
  const [q, setQ] = useState('');
  const [openIds, setOpenIds] = usePersistent<string[]>('sr.campaign.openQuests', []);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (!focus) return;
    setOpenIds((ids) => (ids.includes(focus.id) ? ids : [...ids, focus.id]));
    setFlash(focus.id);
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [focus?.nonce]);

  const toggle = (id: string) => setOpenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const needle = q.trim().toLowerCase();
  const visible = (quest: Quest) =>
    (filter === 'all' || quest.status === filter) &&
    (!needle || [quest.title, quest.summary, quest.gmNotes, ...quest.phases.map((p) => p.title)].join(' ').toLowerCase().includes(needle));

  const addQuest = async (actId: string) => {
    const id = await send<string>('campaign/addQuest', { actId, title: t('Nouvelle quête') }).catch(() => null);
    if (id) {
      setOpenIds((ids) => [...ids, id]);
      setFlash(id);
    }
  };
  const addAct = async () => {
    const n = c.acts.length + 1;
    await send('campaign/addAct', { title: t('Acte {n}', { n }) }).catch(() => {});
  };

  const groups = c.acts.map((act) => ({ act, quests: c.quests.filter((x) => x.actId === act.id) }));
  const orphans = c.quests.filter((x) => !c.acts.some((a) => a.id === x.actId));

  const renderList = (quests: Quest[]) => {
    const shown = quests.filter(visible);
    if (!shown.length) return <div className="muted small camp-none">{quests.length ? t('Aucune quête ne correspond au filtre.') : t('Pas encore de quête dans cet acte.')}</div>;
    return shown.map((quest) => {
      const i = quests.indexOf(quest);
      return (
        <QuestCard
          key={quest.id}
          game={game}
          quest={quest}
          acts={c.acts}
          nav={nav}
          docs={docs}
          open={openIds.includes(quest.id)}
          onToggle={() => toggle(quest.id)}
          first={i === 0}
          last={i === quests.length - 1}
          highlight={flash === quest.id}
        />
      );
    });
  };

  return (
    <div className="camp-quests">
      <div className="camp-toolbar">
        <div className="camp-seg">
          {FILTERS.map((f) => {
            const count = f.id === 'all' ? c.quests.length : c.quests.filter((x) => x.status === f.id).length;
            return (
              <button key={f.id} className={cx(filter === f.id && 'active')} onClick={() => setFilter(f.id)}>
                {t(f.label)} <span className="faint">{count}</span>
              </button>
            );
          })}
        </div>
        <SearchBox value={q} onChange={setQ} placeholder={t('Chercher une quête…')} />
        <span className="grow"></span>
        {openIds.length > 0 && (
          <Button small variant="ghost" onClick={() => setOpenIds([])}>
            {t('Tout replier')}
          </Button>
        )}
        <Button small onClick={addAct}>
          + {t('Acte')}
        </Button>
      </div>
      {!c.acts.length && !c.quests.length && <Empty>{t("Aucune quête. Crée d'abord un acte.")}</Empty>}
      {groups.map(({ act, quests }) => (
        <section className="camp-act-group" key={act.id}>
          <ActHeader act={act} quests={quests} onAdd={() => addQuest(act.id)} />
          <div className="camp-quest-list">{renderList(quests)}</div>
        </section>
      ))}
      {orphans.length > 0 && (
        <section className="camp-act-group">
          <div className="camp-act">
            <div className="camp-act-head">
              <span className="camp-act-name">{t('Sans acte')}</span>
            </div>
          </div>
          <div className="camp-quest-list">{renderList(orphans)}</div>
        </section>
      )}
    </div>
  );
}
