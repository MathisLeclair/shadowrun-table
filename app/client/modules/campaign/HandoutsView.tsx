// GM handouts: editor (title, markdown, image), reveal to all / specific players, hide, player preview.
import { useEffect, useRef, useState } from 'react';
import { Button, Badge, TextInput, Modal, Empty, SearchBox, confirmAction } from '../../lib/ui.tsx';
import { send, upload } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, compare } from '../../lib/i18n.ts';
import { campaignOf, MdEditor, HandoutCard, cx, fmtDate, usePersistent, revealHandout } from './common.tsx';
import type { GameView, Handout, ViewUser } from '../../../shared/types.ts';
import type { Focus } from './types.ts';

interface PlayerRow extends ViewUser {
  chars: string[];
  online: boolean;
}

function players(game: GameView): PlayerRow[] {
  return Object.values(game.users || {})
    .filter((u) => u && u.id !== 'gm')
    .map((u) => ({
      ...u,
      chars: (u.characterIds || []).map((id) => game.actors?.[id]?.name).filter((n): n is string => !!n),
      online: (game.online || []).includes(u.id),
    }))
    .sort((a, b) => compare(a.name, b.name));
}

function visibility(h: Handout, list: PlayerRow[]) {
  if (h.revealedTo === 'all') return { label: t('All players'), color: 'green' };
  const ids = h.revealedTo || [];
  if (!ids.length) return { label: t('Secret'), color: 'dim' };
  const names = ids.map((id) => list.find((u) => u.id === id)?.name || '?');
  return { label: names.length > 2 ? tn(names.length, '{n} player', '{n} players') : names.join(', '), color: 'cyan' };
}

function ImageField({ handout }: { handout: Handout }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (image: string) => send('campaign/updateHandout', { handoutId: handout.id, patch: { image } });
  const pick = async (file: File | null | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast(t('Choose an image (png, jpg, webp, gif, svg)'), 'warn');
    setBusy(true);
    try {
      const res = await upload(file);
      await set(res.url);
      toast(t('Image added'), 'success');
    } catch (err) {
      toast(t('Upload failed: {error}', { error: (err as Error).message }), 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="camp-sec">
      <div className="camp-sec-head">
        <h4>{t('Image')}</h4>
      </div>
      <div
        className="camp-img-field"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files?.[0]);
        }}
      >
        {handout.image ? <img src={handout.image} alt="" className="camp-img-thumb" /> : <div className="camp-img-empty faint small">{t('Drop an image here or use the button.')}</div>}
        <div className="col gap-s">
          <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          <Button small disabled={busy} onClick={() => input.current?.click()}>
            {busy ? t('Uploading…') : handout.image ? t('Replace') : t('Upload an image')}
          </Button>
          {handout.image && (
            <Button small variant="ghost" onClick={() => set('')}>
              {t("Remove the image")}
            </Button>
          )}
        </div>
      </div>
      <TextInput className="camp-mt" value={handout.image} placeholder={t('…or paste a URL (/uploads/…, https://…)')} onChange={(v) => set(v.trim())} />
    </div>
  );
}

function RevealPanel({ game, handout }: { game: GameView; handout: Handout }) {
  const list = players(game);
  const all = handout.revealedTo === 'all';
  const ids = all ? list.map((u) => u.id) : (handout.revealedTo as string[]) || [];
  const togglePlayer = (u: PlayerRow, on: boolean) => (on ? revealHandout(handout.id, [u.id]) : send('campaign/hideHandout', { handoutId: handout.id, userId: u.id }));
  const vis = visibility(handout, list);
  return (
    <div className="camp-sec camp-reveal">
      <div className="camp-sec-head">
        <h4>{t('Visibility')}</h4>
        <Badge color={vis.color}>{vis.label}</Badge>
      </div>
      <div className="row wrap gap-s">
        <Button small variant="accent" disabled={all} onClick={() => revealHandout(handout.id, 'all')}>
          ✉ {t('Reveal to all')}
        </Button>
        <Button
          small
          variant="ghost"
          disabled={!all && !ids.length}
          onClick={async () => {
            if (await confirmAction(t('Hide “{title}” from all players?', { title: handout.title }))) send('campaign/hideHandout', { handoutId: handout.id });
          }}
        >
          {t('Hide from all')}
        </Button>
      </div>
      {list.length ? (
        <ul className="camp-players">
          {list.map((u) => (
            <li key={u.id}>
              <label className="camp-check">
                <input type="checkbox" checked={ids.includes(u.id)} onChange={(e) => togglePlayer(u, e.target.checked)} />
                <span className={cx('camp-dot', u.online && 'on')} title={u.online ? t('Online') : t('Offline')}></span>
                <span>
                  <strong>{u.name}</strong>
                  {u.chars.length ? <span className="muted small"> · {u.chars.join(', ')}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted small camp-mt">{t("No player has joined yet. “Reveal to all” will also include those who join later.")}</div>
      )}
      {handout.revealedAt && <div className="faint small camp-mt">{t('Last revealed: {date}', { date: fmtDate(handout.revealedAt) })}</div>}
    </div>
  );
}

function Editor({ game, handout, onPreview }: { game: GameView; handout: Handout; onPreview: () => void }) {
  const patch = (p: Partial<Handout>) => send('campaign/updateHandout', { handoutId: handout.id, patch: p });
  return (
    <div className="camp-ho-editor">
      <div className="row gap-s camp-ho-titlebar">
        <label className="field grow">
          <span className="field-label">{t('Title')}</span>
          <TextInput value={handout.title} onChange={(title) => title.trim() && patch({ title })} />
        </label>
        <Button small onClick={onPreview}>
          ◉ {t('Player preview')}
        </Button>
      </div>
      <RevealPanel game={game} handout={handout} />
      <MdEditor
        label={t('Content (seen by players)')}
        value={handout.body}
        rows={14}
        initialMode={handout.body ? 'preview' : 'edit'}
        placeholder={t('Handout text, in markdown (tables, quotes, bold…)')}
        onSave={(body) => patch({ body })}
      />
      <ImageField handout={handout} />
      <MdEditor
        label={t('GM note (never shown)')}
        value={handout.gmNotes}
        rows={3}
        initialMode={handout.gmNotes ? 'preview' : 'edit'}
        placeholder={t('When to reveal it, to whom…')}
        onSave={(gmNotes) => patch({ gmNotes })}
      />
      <div className="row spread camp-mt">
        <span className="faint small">{handout.ts && handout.ts < Date.now() + 864e5 ? t('Created {date}', { date: fmtDate(handout.ts) }) : t('Prepared handout')}</span>
        <Button
          small
          variant="danger"
          onClick={async () => {
            if (await confirmAction(t('Permanently delete “{title}”? Players will no longer see it.', { title: handout.title }))) send('campaign/deleteHandout', { handoutId: handout.id });
          }}
        >
          {t('Delete')}
        </Button>
      </div>
    </div>
  );
}

export default function HandoutsView({ game, focus }: { game: GameView; focus: Focus | null }) {
  const c = campaignOf(game);
  const list = players(game);
  const [sel, setSel] = usePersistent<string | null>('sr.campaign.handout', null);
  const [preview, setPreview] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (focus) setSel(focus.id);
  }, [focus?.nonce]);

  const selected = c.handouts.find((h) => h.id === sel) || null;
  const needle = q.trim().toLowerCase();
  const shown = c.handouts.filter((h) => !needle || (h.title + ' ' + h.body).toLowerCase().includes(needle));
  const add = async () => {
    const id = await send<string>('campaign/addHandout', { title: t('New handout') }).catch(() => null);
    if (id) setSel(id);
  };

  return (
    <div className={cx('camp-handouts', selected && 'has-sel')}>
      <aside className="camp-ho-list">
        <div className="row gap-s">
          <SearchBox value={q} onChange={setQ} placeholder={t('Filter…')} />
          <Button small variant="primary" onClick={add}>
            + {t('New')}
          </Button>
        </div>
        {shown.length ? (
          <ul>
            {shown.map((h) => {
              const v = visibility(h, list);
              return (
                <li key={h.id}>
                  <button className={cx('camp-ho-item', h.id === sel && 'active')} onClick={() => setSel(h.id)}>
                    <span className="camp-ho-item-title">
                      {h.image ? '▣ ' : ''}
                      {h.title}
                    </span>
                    <Badge color={v.color}>{v.label}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{c.handouts.length ? t('No results.') : t('No handouts. Create the first one!')}</Empty>
        )}
      </aside>
      <section className="camp-ho-main">
        {selected ? (
          <>
            <button className="btn btn-sm btn-ghost camp-ho-back" onClick={() => setSel(null)}>
              ‹ {t('Back to the list')}
            </button>
            <Editor key={selected.id} game={game} handout={selected} onPreview={() => setPreview(true)} />
          </>
        ) : (
          <Empty>{t('Pick a handout on the left, or create a new one.')}</Empty>
        )}
      </section>
      {preview && selected && (
        <Modal title={t('Preview — player view')} width={760} onClose={() => setPreview(false)}>
          <div className="dos-page dos-preview">
            <HandoutCard handout={{ ...selected, revealedAt: selected.revealedAt || Date.now() }} unread={true} />
          </div>
        </Modal>
      )}
    </div>
  );
}
