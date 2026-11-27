// GM narrative threads: kanban board by state, quick state change (buttons or drag & drop).
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, TextInput, SearchBox, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import { campaignOf, THREAD_STATES, MdEditor, cx } from './common.tsx';
import type { CampaignThread, GameView, ThreadState } from '../../../shared/types.ts';
import type { Focus } from './types.ts';

interface ThreadCardProps {
  thread: CampaignThread;
  open: boolean;
  onToggle: () => void;
  highlight: boolean;
}
function ThreadCard({ thread, open, onToggle, highlight }: ThreadCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlight]);
  const patch = (p: Partial<CampaignThread>) => send('campaign/updateThread', { threadId: thread.id, patch: p });
  return (
    <div
      ref={ref}
      className={cx('camp-thread', `ts-${thread.state}`, open && 'open', highlight && 'flash')}
      draggable={!open}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', thread.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <div className="camp-thread-head" onClick={onToggle}>
        {open ? (
          <div className="grow" onClick={(e) => e.stopPropagation()}>
            <TextInput value={thread.label} onChange={(label) => label.trim() && patch({ label })} />
          </div>
        ) : (
          <div className="grow camp-thread-label">{thread.label}</div>
        )}
        <span className={cx('camp-chev', open && 'open')}>›</span>
      </div>
      {!open && thread.notes && (
        <div className="camp-thread-notes small muted">
          {thread.notes.replace(/[*_#>\x60]/g, '').slice(0, 160)}
          {thread.notes.length > 160 ? '…' : ''}
        </div>
      )}
      <div className="camp-thread-states" onClick={(e) => e.stopPropagation()}>
        {THREAD_STATES.map((s) => (
          <button
            key={s.id}
            className={cx('camp-ts-btn', `ts-${s.id}`, s.id === thread.state && 'active')}
            title={t('Passer en « {state} »', { state: t(s.one) })}
            onClick={() => s.id !== thread.state && patch({ state: s.id })}
          >
            {t(s.one)}
          </button>
        ))}
      </div>
      {open && (
        <div className="camp-thread-body">
          <MdEditor value={thread.notes} rows={6} initialMode={thread.notes ? 'preview' : 'edit'} onSave={(notes) => patch({ notes })} />
          <div className="row spread camp-mt">
            <div className="row gap-s">
              <IconButton icon="↑" title={t('Monter')} onClick={() => send('campaign/moveThread', { threadId: thread.id, dir: -1 })} />
              <IconButton icon="↓" title={t('Descendre')} onClick={() => send('campaign/moveThread', { threadId: thread.id, dir: 1 })} />
            </div>
            <Button
              small
              variant="danger"
              onClick={async () => {
                if (await confirmAction(t('Supprimer le fil « {label} » ?', { label: thread.label }))) send('campaign/deleteThread', { threadId: thread.id });
              }}
            >
              {t('Supprimer')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ThreadsView({ game, focus }: { game: GameView; focus: Focus | null }) {
  const c = campaignOf(game);
  const [openId, setOpenId] = useState<string | null>(null);
  const [over, setOver] = useState<ThreadState | null>(null);
  const [q, setQ] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [k, setK] = useState(0);

  useEffect(() => {
    if (!focus) return;
    setOpenId(focus.id);
    setFlash(focus.id);
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [focus?.nonce]);

  const needle = q.trim().toLowerCase();
  const match = (th: CampaignThread) => !needle || (th.label + ' ' + th.notes).toLowerCase().includes(needle);
  const add = async (state: ThreadState, label: string) => {
    const l = String(label || '').trim();
    if (!l) return;
    const id = await send<string>('campaign/addThread', { label: l, state }).catch(() => null);
    setK(k + 1);
    if (id) setFlash(id);
  };

  return (
    <div className="camp-threads">
      <div className="camp-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder={t('Chercher un fil…')} />
        <span className="muted small">{t("Glisse une carte d'une colonne à l'autre, ou utilise les boutons d'état.")}</span>
      </div>
      <div className="camp-board">
        {THREAD_STATES.map((s) => {
          const items = c.threads.filter((th) => th.state === s.id);
          return (
            <section
              key={s.id}
              className={cx('camp-col', `ts-${s.id}`, over === s.id && 'over')}
              onDragOver={(e) => {
                e.preventDefault();
                if (over !== s.id) setOver(s.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData('text/plain');
                const th = c.threads.find((x) => x.id === id);
                if (th && th.state !== s.id) send('campaign/updateThread', { threadId: id, patch: { state: s.id } });
              }}
            >
              <header className="camp-col-head">
                <span>{t(s.label)}</span>
                <span className="mono">{items.length}</span>
              </header>
              <div className="camp-col-body">
                {items.filter(match).map((th) => (
                  <ThreadCard key={th.id} thread={th} open={openId === th.id} highlight={flash === th.id} onToggle={() => setOpenId(openId === th.id ? null : th.id)} />
                ))}
                {!items.length && <div className="faint small camp-none">{t('Vide')}</div>}
              </div>
              <div className="camp-col-add">
                <TextInput key={s.id + k} value="" placeholder={t('+ Nouveau fil (Entrée)')} onChange={(v) => add(s.id, v)} />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
