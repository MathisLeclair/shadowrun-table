// Player dossiers: the party, received handouts (unread tracking), and « L'histoire jusqu'ici ».
import { useEffect, useState, type CSSProperties } from 'react';
import { Button, Markdown, Empty, Badge } from '../../lib/ui.tsx';
import { useServerEvent, type GameProps } from '../../lib/net.ts';
import { toast, openSheet, setUI } from '../../lib/ui-store.ts';
import { t, tn, metatypeLabel } from '../../lib/i18n.js';
import { HandoutCard, cx, usePersistent, handoutReadKey } from './common.tsx';
import type { Actor, PlayerHandout } from '../../../shared/types.ts';

function useReadSet(userId: string) {
  const [ids, setIdsRaw] = usePersistent<string[]>(handoutReadKey(userId), []);
  const list = Array.isArray(ids) ? ids : [];
  // Nudge the shell so the « Dossiers » tab badge (read from localStorage) updates at once.
  const setIds = (v: string[]) => {
    setIdsRaw(v);
    setUI({ handoutsReadAt: Date.now() });
  };
  return {
    has: (id: string) => list.includes(id),
    mark: (id: string) => {
      if (!list.includes(id)) setIds([...list, id].slice(-500));
    },
    markAll: (all: string[]) => setIds([...new Set([...list, ...all])].slice(-500)),
  };
}

function initials(name: string | null | undefined): string {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function Party({ game }: GameProps) {
  // PCs are full sheets in a player's view (only NPCs come as stubs).
  const pcs = Object.values(game.actors || {}).filter((a): a is Actor => !!a && a.type === 'pc' && !(a as Actor).retired);
  if (!pcs.length) return null;
  const users = Object.values(game.users || {});
  const mine = game.me.characterIds || [];
  return (
    <section className="dos-section">
      <h3 className="dos-h">{t("L'équipe")}</h3>
      <div className="dos-party">
        {pcs.map((a) => {
          const owner = users.find((u) => (u.characterIds || []).includes(a.id));
          const online = owner && (game.online || []).includes(owner.id);
          const isMine = mine.includes(a.id);
          const sub = [a.metatype && metatypeLabel(a.metatype), a.concept].filter(Boolean).join(' · ');
          return (
            <button
              key={a.id}
              className={cx('dos-pc', isMine && 'mine')}
              disabled={!isMine}
              title={isMine ? t('Ouvrir ma fiche') : a.name}
              onClick={() => isMine && openSheet(a.id)}
              style={{ '--pc-color': a.color || 'var(--cyan)' } as CSSProperties}
            >
              <span className="dos-portrait">{a.portrait ? <img src={a.portrait} alt="" loading="lazy" /> : <span>{initials(a.name)}</span>}</span>
              <span className="dos-pc-text">
                <strong>{a.name}</strong>
                {sub && <span className="small muted">{sub}</span>}
                <span className="small faint">
                  {owner ? (
                    <>
                      <span className={cx('camp-dot', online && 'on')}></span> {isMine ? t('{name} (toi)', { name: owner.name }) : owner.name}
                    </>
                  ) : (
                    a.player || t('Libre')
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default function DossiersPage({ game }: GameProps) {
  const handouts = [...((game.campaign?.handouts || []) as PlayerHandout[])].sort((a, b) => (b.revealedAt || b.ts || 0) - (a.revealedAt || a.ts || 0));
  const recap = game.campaign?.playerRecap || '';
  const read = useReadSet(game.me.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const unread = handouts.filter((h) => !read.has(h.id));
  // Documents unread when the page opened keep their highlight until the player leaves the page.
  const [fresh, setFresh] = useState<string[]>(() => unread.map((h) => h.id));
  const isNew = (h: PlayerHandout) => !read.has(h.id) || fresh.includes(h.id);

  useServerEvent('campaign/handout', (d: { title?: string } | null) => d?.title && toast(t('Nouveau document : {title}', { title: d.title }), 'info', 5000), []);

  // Open the newest unread document automatically the first time the page is shown.
  useEffect(() => {
    if (openId === null && unread.length) {
      setOpenId(unread[0].id);
      read.mark(unread[0].id);
    }
  }, []);

  const toggle = (h: PlayerHandout) => {
    read.mark(h.id);
    setOpenId(openId === h.id ? '' : h.id);
  };

  return (
    <div className="page dos-page">
      <div className="page-title">
        <h2>{t('Dossiers')}</h2>
        {unread.length > 0 && <Badge color="magenta">{tn(unread.length, '{n} non lu', '{n} non lus')}</Badge>}
      </div>
      <Party game={game} />
      <div className="dos-layout">
        <section className="dos-section dos-docs">
          <div className="row spread">
            <h3 className="dos-h">
              {t('Documents reçus')} <span className="faint small">{handouts.length || ''}</span>
            </h3>
            {handouts.some(isNew) && (
              <Button
                small
                variant="ghost"
                onClick={() => {
                  read.markAll(handouts.map((h) => h.id));
                  setFresh([]);
                }}
              >
                {t('Tout marquer comme lu')}
              </Button>
            )}
          </div>
          {handouts.length ? (
            <div className="dos-list">
              {handouts.map((h) => (
                <HandoutCard key={h.id} handout={h} unread={isNew(h)} open={openId === h.id} stamp={h.toAll ? t('Équipe') : t('Personnel')} onToggle={() => toggle(h)} />
              ))}
            </div>
          ) : (
            <div className="dos-empty">
              {t("Aucun document pour l'instant.")}
              <br />
              <span className="faint small">{t('Ce que le MJ te transmettra (preuves, messages, fiches de contact…) apparaîtra ici.')}</span>
            </div>
          )}
        </section>
        <section className="dos-section dos-story">
          <h3 className="dos-h">{t("L'histoire jusqu'ici")}</h3>
          {recap.trim() ? (
            <div className="dos-journal">
              <Markdown text={recap} />
            </div>
          ) : (
            <Empty>{t("Le MJ n'a pas encore écrit de récapitulatif.")}</Empty>
          )}
        </section>
      </div>
    </div>
  );
}
