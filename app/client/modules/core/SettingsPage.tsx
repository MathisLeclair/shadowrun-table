// GM settings: campaign name, GM password, table language, players & character assignment, backups, Foundry,
// translation status (missing English entries).
import { Fragment, useEffect, useState, type ChangeEvent } from 'react';
import { Button, Panel, Field, TextInput, Badge, Select, Empty, confirmAction } from '../../lib/ui.tsx';
import { send, api, getToken, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, missingKeys, missingCount, clearMissing } from '../../lib/i18n.ts';
import FoundryPanel from '../foundry/FoundryPanel.tsx';
import FoundryUpload from '../admin/FoundryUpload.tsx';

const LANG_OPTIONS = [
  { value: 'fr', label: 'Français' }, // i18n-ignore
  { value: 'en', label: 'English' },
]; // endonyms: never translated

/** Copy text to the clipboard (falls back to a hidden textarea on non-secure origins, e.g. http://192.168.x.x). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

/** Live counter of the texts shown without an English translation (for translators / the GM). */
function MissingTranslations() {
  const [count, setCount] = useState<number>(missingCount());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Keys are collected while screens render: poll instead of re-rendering on every lookup.
    const id = setInterval(() => setCount(missingCount()), 2000);
    return () => clearInterval(id);
  }, []);
  const json = () => JSON.stringify(Object.fromEntries(Object.keys(missingKeys()).map((k) => [k, ''])), null, 2);
  const copy = async () => {
    if (await copyText(json())) toast(t('List copied to the clipboard (JSON to fill in)'), 'success');
    else toast(t('Could not copy: open the list and copy it by hand'), 'error');
  };
  return (
    <div className="col gap-s">
      <div className="i18n-missing">
        <span>{t('Missing translations:')}</span>
        <span className={'i18n-count' + (count ? '' : ' zero')}>{count}</span>
        <Button small disabled={!count} onClick={copy}>
          {t('Copy as JSON')}
        </Button>
        <Button small variant="ghost" disabled={!count} onClick={() => setOpen(!open)}>
          {open ? t('Hide the list') : t('Show the list')}
        </Button>
        <Button
          small
          variant="ghost"
          disabled={!count}
          onClick={() => {
            clearMissing();
            setCount(0);
            setOpen(false);
          }}
        >
          {t('Reset')}
        </Button>
      </div>
      {open && count > 0 && <div className="i18n-missing-list">{Object.keys(missingKeys()).join('\n')}</div>}
      <span className="field-hint">{t('Texts shown since this page was opened that have no English translation. Translators fill in client/i18n/en/*.json (tool: node tools/i18n-check.ts).')}</span>
    </div>
  );
}

export default function SettingsPage({ game }: GameProps) {
  const [pwd, setPwd] = useState('');
  const [announce, setAnnounce] = useState(game.ui?.announcement || '');
  const [foundryRev, setFoundryRev] = useState(0); // remounts the Foundry panel after an upload (new world path)
  const users = Object.values(game.users || {});
  const pcs = Object.values(game.actors).filter((a) => a.type === 'pc');
  const slug = game.config.table?.slug;
  const playerUrl = slug ? `${location.origin}/t/${slug}/` : location.origin;

  const doImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same (corrected) file again fires onChange
    if (!file) return;
    if (!(await confirmAction(t('Replace the whole game with this save? (an automatic backup is made first)')))) return;
    try {
      let body;
      try {
        body = JSON.parse(await file.text());
      } catch {
        return toast(t('Invalid save file'), 'error');
      }
      await api('/api/admin/import', { method: 'POST', body });
      toast(t('Save imported'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-title">
        <h2>{t('Settings')}</h2>
      </div>
      <div className="grid-2">
        <Panel title={t('Game')}>
          <div className="col">
            <Field label={t('Campaign name')} hint={t('It is also the table\'s name on the home page.')}>
              <TextInput value={game.config.campaignName} onChange={(v) => v.trim() && send('config/update', { campaignName: v })} />
            </Field>
            <Field label={t('Table language')} hint={t('Default language for players who have not picked one (FR/EN switch at the top of the screen).')}>
              <Select value={game.config.lang || 'fr'} options={LANG_OPTIONS} onChange={(v) => send('config/update', { lang: v })} />
            </Field>
            <Field label={t('New GM password')} hint={t('Pick a password the players don\'t know (the installation password “lazarus” must be changed).')}>
              <div className="row">
                <input className="input" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
                <Button
                  onClick={() =>
                    pwd &&
                    send('config/update', { gmPassword: pwd }).then(() => {
                      setPwd('');
                      toast(t('Password changed'), 'success');
                    })
                  }
                >
                  {t('Change')}
                </Button>
              </div>
            </Field>
            <Field label={t('Link for the players')} hint={t('Send this link to the players. On the same Wi-Fi network, replace “localhost” with the IP address shown in the server console.')}>
              <code className="mono cyan">{playerUrl}</code>
            </Field>
            <Field label={t('Announcement banner (visible to everyone)')}>
              <div className="row">
                <TextInput value={announce} live onChange={setAnnounce} placeholder={t('e.g. 10-minute break')} />
                <Button onClick={() => send('ui/announce', { text: announce })}>{t('Show')}</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAnnounce('');
                    send('ui/announce', { text: null });
                  }}
                >
                  {t('Clear')}
                </Button>
              </div>
            </Field>
          </div>
        </Panel>

        <Panel title={t('Backups')}>
          <div className="col">
            <p className="muted small">{t('The game is saved automatically on the server, with a backup copy every 15 minutes (the table\'s backups/ folder).')}</p>
            <div className="row wrap">
              <Button
                onClick={() =>
                  api<{ file: string }>('/api/admin/backup', { method: 'POST' })
                    .then((r) => toast(t('Backup: {file}', { file: r.file }), 'success'))
                    .catch((err: Error) => toast(err.message || t('Backup failed'), 'error'))
                }
              >
                {t('Create a backup')}
              </Button>
              <a className="btn" href={'/api/admin/export?token=' + getToken()} download="shadowrun-partie.json">
                {t('Download the game')}
              </a>
              <label className="btn">
                {t('Import a game')}
                <input type="file" accept=".json" className="hidden" onChange={doImport} />
              </label>
            </div>
            <div className="row wrap">
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirmAction(t('Reset the game from the starting data? Characters, maps and log go back to zero (a backup is made first).'))) {
                    try {
                      await api('/api/admin/reset', { method: 'POST' });
                      toast(t('Game reset'), 'success');
                    } catch (err) {
                      toast((err as Error).message || t('Reset failed'), 'error');
                    }
                  }
                }}
              >
                {t('Reset from the starting data')}
              </Button>
              <Button variant="ghost" onClick={async () => (await confirmAction(t('Clear the log?'))) && send('log/clear')}>
                {t('Clear the log')}
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <FoundryUpload onChanged={() => setFoundryRev((n) => n + 1)} />
      <FoundryPanel key={foundryRev} game={game} />

      <h3 className="section-title">{t('Players')}</h3>
      <Panel pad={false}>
        {users.length ? (
          <table className="sr">
            <thead>
              <tr>
                <th>{t('Player')}</th>
                <th>{t('Status')}</th>
                <th>{t('Character(s)')}</th>
                <th>{t('Assign')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                  </td>
                  <td>{(game.online || []).includes(u.id) ? <Badge color="green">{t('online')}</Badge> : <Badge>{t('offline')}</Badge>}</td>
                  <td>
                    {(u.characterIds || []).map((id) => (
                      <Fragment key={id}>
                        <Badge color="cyan">
                          {game.actors[id]?.name || id}
                          <button
                            className="icon-btn"
                            style={{ width: 16, height: 16, fontSize: 10 }}
                            title={t('Remove')}
                            onClick={() => send('users/assign', { userId: u.id, characterId: id, assign: false })}
                          >
                            ✕
                          </button>
                        </Badge>{' '}
                      </Fragment>
                    ))}
                  </td>
                  <td>
                    <Select
                      value=""
                      options={[{ value: '', label: t('— give a character —') }, ...pcs.map((p) => ({ value: p.id, label: p.name }))]}
                      onChange={(id) => id && send('users/assign', { userId: u.id, characterId: id, assign: true })}
                    />
                  </td>
                  <td className="right">
                    <Button small variant="ghost" onClick={() => send('users/resetPin', { userId: u.id }).then(() => toast(t('PIN cleared'), 'success'))}>
                      {t('Clear PIN')}
                    </Button>
                    <Button small variant="danger" onClick={async () => (await confirmAction(t('Delete player {name}?', { name: u.name }))) && send('users/remove', { userId: u.id })}>
                      {t('Delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('No player has connected yet. Send them the link above.')}</Empty>
        )}
      </Panel>

      <h3 className="section-title">{t('Translations')}</h3>
      <Panel>
        <MissingTranslations />
      </Panel>
    </div>
  );
}
