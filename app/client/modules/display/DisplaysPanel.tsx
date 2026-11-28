// GM settings → « Table displays »: read-only links for a shared screen or projector (docs/modules/display.md).
// The display has no input: its panes, vision, rotation, blank screen, handout and sound are set here, pushed live.
import { Button, Panel, Field, TextInput, Badge, Select, Toggle, Empty, confirmAction, copyText } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tk } from '../../lib/i18n.ts';
import { DISPLAY_PANES, DISPLAY_ROTATIONS, MAX_DISPLAYS } from '/shared/display.ts';
import type { Campaign, DisplayLayout, DisplayLink, DisplayPane, GameView } from '../../../shared/types.ts';
import './display.css';

const PANE_LABEL: Record<DisplayPane, string> = { map: tk('Map'), initiative: tk('Initiative'), handout: tk('Handout'), rolls: tk('Public rolls') };

/** Address of a display link (the token is its secret: anyone holding it sees what a player without characters sees). */
export function displayUrl(slug: string | undefined, token: string): string {
  return `${location.origin}/t/${slug || ''}/?display=${encodeURIComponent(token)}`;
}

const update = (id: string, patch: Partial<DisplayLink>) => send('display/update', { displayId: id, patch }).catch(() => {});

function DisplayCard({ game, d, online }: { game: GameView; d: DisplayLink; online: boolean }) {
  const url = displayUrl(game.config.table?.slug, d.token);
  const pcs = Object.values(game.actors).filter((a) => a.type === 'pc' && !('retired' in a && a.retired));
  const handouts = ((game.campaign as Campaign)?.handouts || []).filter((h) => h.revealedTo === 'all');
  const L = d.layout;
  const setLayout = (patch: Partial<DisplayLayout>) => update(d.id, { layout: { ...L, ...patch } });
  const paneOptions = DISPLAY_PANES.map((p) => ({ value: p, label: t(PANE_LABEL[p]) }));
  const copy = async () => {
    if (await copyText(url)) toast(t('Link copied'), 'success');
    else toast(t('Could not copy: select the link and copy it by hand'), 'error');
  };
  const renew = async () => {
    if (await confirmAction(t('Make a new link for {name}? The old link stops working at once.', { name: d.name }))) send('display/renew', { displayId: d.id }).catch(() => {});
  };
  const remove = async () => {
    if (await confirmAction(t('Delete the display link {name}? Its screen is disconnected.', { name: d.name }))) send('display/remove', { displayId: d.id }).catch(() => {});
  };
  return (
    <Panel
      title={
        <span className="row">
          {d.name} {online ? <Badge color="green">{t('connected')}</Badge> : <Badge>{t('offline')}</Badge>}
        </span>
      }
    >
      <div className="col">
        <Field label={t('Link to open on the shared screen')} hint={t('No password on the shared screen: anyone with this link sees the table as a player without a character. Make a new link to revoke it.')}>
          <div className="row wrap">
            <code className="mono cyan dsp-gm-url">{url}</code>
            <Button small onClick={copy}>
              {t('Copy')}
            </Button>
            <a className="btn btn-sm" href={url} target="_blank" rel="noopener">
              {t('Open')}
            </a>
          </div>
        </Field>
        <div className="grid-2">
          <Field label={t('Name')}>
            <TextInput value={d.name} onChange={(v) => v.trim() && update(d.id, { name: v })} />
          </Field>
          <Field label={t('Vision')} hint={t('Fog of war of the map on this screen.')}>
            <Select
              value={d.vision}
              options={[{ value: 'party', label: t('The whole party') }, ...pcs.map((a) => ({ value: a.id, label: t('{name}’s point of view', { name: a.name }) }))]}
              onChange={(v) => update(d.id, { vision: v })}
            />
          </Field>
          <Field label={t('Main pane')}>
            <Select value={L.main} options={paneOptions} onChange={(v) => setLayout({ main: v, split: L.split === v ? null : L.split })} />
          </Field>
          <Field label={t('Second pane')}>
            <div className="row">
              <Select
                value={L.split || ''}
                options={[{ value: '', label: t('— none —') }, ...paneOptions.filter((o) => o.value !== L.main)]}
                onChange={(v) => setLayout({ split: (v || null) as DisplayPane | null })}
              />
              {L.split && (
                <Select
                  value={L.splitDir}
                  options={[
                    { value: 'row', label: t('side by side') },
                    { value: 'col', label: t('stacked') },
                  ]}
                  onChange={(v) => setLayout({ splitDir: v })}
                />
              )}
            </div>
          </Field>
          {L.split && (
            <Field label={t('Size of the main pane')}>
              <Select
                value={String(Math.round(L.splitRatio * 100))}
                options={[50, 60, 70, 80].map((n) => ({ value: String(n), label: `${n} %` }))}
                onChange={(v) => setLayout({ splitRatio: Number(v) / 100 })}
              />
            </Field>
          )}
          <Field label={t('Map rotation')} hint={t('For a screen laid flat in the table.')}>
            <Select value={String(d.rotation)} options={DISPLAY_ROTATIONS.map((r) => ({ value: String(r), label: `${r}°` }))} onChange={(v) => update(d.id, { rotation: Number(v) as DisplayLink['rotation'] })} />
          </Field>
          <Field label={t('Handout on screen')} hint={t('Only handouts revealed to every player.')}>
            <Select
              value={d.handoutId || ''}
              options={[{ value: '', label: t('— none —') }, ...handouts.map((h) => ({ value: h.id, label: h.title }))]}
              onChange={(v) => update(d.id, { handoutId: v || null })}
            />
          </Field>
        </div>
        <div className="row wrap">
          <Toggle label={t('Blank screen')} title={t('Black screen, e.g. while you prepare a reveal')} value={d.blank} onChange={(v) => update(d.id, { blank: v })} />
          <Toggle label={t('Initiative strip')} title={t('Initiative order along the bottom while a combat runs')} value={d.initiative} onChange={(v) => update(d.id, { initiative: v })} />
          <Toggle label={t('Sound')} title={t('This screen plays the ambience and sound effects')} value={d.audio} onChange={(v) => update(d.id, { audio: v })} />
        </div>
        <div className="row wrap">
          <Button small variant="ghost" onClick={renew}>
            {t('New link')}
          </Button>
          <Button small variant="danger" onClick={remove}>
            {t('Delete')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export default function DisplaysPanel({ game }: GameProps) {
  const list = Object.values(game.displays || {}).sort((a, b) => a.createdAt - b.createdAt);
  const online = new Set(game.displaysOnline || []);
  return (
    <>
      <div className="row spread">
        <h3 className="section-title">{t('Table displays')}</h3>
        <Button small variant="primary" disabled={list.length >= MAX_DISPLAYS} onClick={() => send('display/create', {}).catch(() => {})}>
          {t('+ Display link')}
        </Button>
      </div>
      {list.length ? (
        <div className="col">
          {list.map((d) => (
            <DisplayCard key={d.id} game={game} d={d} online={online.has(d.id)} />
          ))}
        </div>
      ) : (
        <Panel>
          <Empty>{t('In-person game? Open a display link on a TV, a screen in the table or a projector: it shows the map as the party sees it, read-only, while players keep their phones.')}</Empty>
        </Panel>
      )}
    </>
  );
}
