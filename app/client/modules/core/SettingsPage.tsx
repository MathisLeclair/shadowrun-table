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
    if (await copyText(json())) toast(t('Liste copiée dans le presse-papiers (JSON à compléter)'), 'success');
    else toast(t('Copie impossible : ouvre la liste et copie-la à la main'), 'error');
  };
  return (
    <div className="col gap-s">
      <div className="i18n-missing">
        <span>{t('Traductions manquantes :')}</span>
        <span className={'i18n-count' + (count ? '' : ' zero')}>{count}</span>
        <Button small disabled={!count} onClick={copy}>
          {t('Copier en JSON')}
        </Button>
        <Button small variant="ghost" disabled={!count} onClick={() => setOpen(!open)}>
          {open ? t('Masquer la liste') : t('Voir la liste')}
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
          {t('Remettre à zéro')}
        </Button>
      </div>
      {open && count > 0 && <div className="i18n-missing-list">{Object.keys(missingKeys()).join('\n')}</div>}
      <span className="field-hint">{t('Textes affichés depuis l’ouverture de cette page sans traduction anglaise. Les traducteurs complètent client/i18n/en/*.json (outil : node tools/i18n-check.ts).')}</span>
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
    if (!(await confirmAction(t('Remplacer toute la partie par cette sauvegarde ? (une sauvegarde automatique est faite avant)')))) return;
    try {
      let body;
      try {
        body = JSON.parse(await file.text());
      } catch {
        return toast(t('Fichier de sauvegarde invalide'), 'error');
      }
      await api('/api/admin/import', { method: 'POST', body });
      toast(t('Sauvegarde importée'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <div className="page-title">
        <h2>{t('Réglages')}</h2>
      </div>
      <div className="grid-2">
        <Panel title={t('Partie')}>
          <div className="col">
            <Field label={t('Nom de la campagne')} hint={t('C’est aussi le nom de la table sur la page d’accueil.')}>
              <TextInput value={game.config.campaignName} onChange={(v) => v.trim() && send('config/update', { campaignName: v })} />
            </Field>
            <Field label={t('Langue de la table')} hint={t('Langue par défaut des joueurs qui n’en ont pas choisi une (sélecteur FR/EN en haut de l’écran).')}>
              <Select value={game.config.lang || 'fr'} options={LANG_OPTIONS} onChange={(v) => send('config/update', { lang: v })} />
            </Field>
            <Field label={t('Nouveau mot de passe MJ')} hint={t('Choisis un mot de passe que les joueurs ne connaissent pas (le mot de passe d’installation « lazarus » doit être changé).')}>
              <div className="row">
                <input className="input" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
                <Button
                  onClick={() =>
                    pwd &&
                    send('config/update', { gmPassword: pwd }).then(() => {
                      setPwd('');
                      toast(t('Mot de passe changé'), 'success');
                    })
                  }
                >
                  {t('Changer')}
                </Button>
              </div>
            </Field>
            <Field label={t('Lien pour les joueurs')} hint={t('Envoie ce lien aux joueurs. Sur le même réseau Wi-Fi, remplace « localhost » par l’adresse IP affichée dans la console du serveur.')}>
              <code className="mono cyan">{playerUrl}</code>
            </Field>
            <Field label={t('Bandeau d’annonce (visible par tous)')}>
              <div className="row">
                <TextInput value={announce} live onChange={setAnnounce} placeholder={t('ex. Pause 10 minutes')} />
                <Button onClick={() => send('ui/announce', { text: announce })}>{t('Afficher')}</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAnnounce('');
                    send('ui/announce', { text: null });
                  }}
                >
                  {t('Effacer')}
                </Button>
              </div>
            </Field>
          </div>
        </Panel>

        <Panel title={t('Sauvegardes')}>
          <div className="col">
            <p className="muted small">{t('La partie est enregistrée automatiquement sur le serveur, avec une copie de secours toutes les 15 minutes (dossier backups/ de la table).')}</p>
            <div className="row wrap">
              <Button
                onClick={() =>
                  api<{ file: string }>('/api/admin/backup', { method: 'POST' })
                    .then((r) => toast(t('Sauvegarde : {file}', { file: r.file }), 'success'))
                    .catch((err: Error) => toast(err.message || t('Sauvegarde impossible'), 'error'))
                }
              >
                {t('Créer une sauvegarde')}
              </Button>
              <a className="btn" href={'/api/admin/export?token=' + getToken()} download="shadowrun-partie.json">
                {t('Télécharger la partie')}
              </a>
              <label className="btn">
                {t('Importer une partie')}
                <input type="file" accept=".json" className="hidden" onChange={doImport} />
              </label>
            </div>
            <div className="row wrap">
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirmAction(t('Réinitialiser la partie depuis les données de départ ? Personnages, cartes et journal reviennent à zéro (une sauvegarde est faite avant).'))) {
                    try {
                      await api('/api/admin/reset', { method: 'POST' });
                      toast(t('Partie réinitialisée'), 'success');
                    } catch (err) {
                      toast((err as Error).message || t('Réinitialisation impossible'), 'error');
                    }
                  }
                }}
              >
                {t('Réinitialiser depuis les données de départ')}
              </Button>
              <Button variant="ghost" onClick={async () => (await confirmAction(t('Vider le journal ?'))) && send('log/clear')}>
                {t('Vider le journal')}
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <FoundryUpload onChanged={() => setFoundryRev((n) => n + 1)} />
      <FoundryPanel key={foundryRev} game={game} />

      <h3 className="section-title">{t('Joueurs')}</h3>
      <Panel pad={false}>
        {users.length ? (
          <table className="sr">
            <thead>
              <tr>
                <th>{t('Joueur')}</th>
                <th>{t('État')}</th>
                <th>{t('Personnage(s)')}</th>
                <th>{t('Attribuer')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                  </td>
                  <td>{(game.online || []).includes(u.id) ? <Badge color="green">{t('en ligne')}</Badge> : <Badge>{t('hors ligne')}</Badge>}</td>
                  <td>
                    {(u.characterIds || []).map((id) => (
                      <Fragment key={id}>
                        <Badge color="cyan">
                          {game.actors[id]?.name || id}
                          <button
                            className="icon-btn"
                            style={{ width: 16, height: 16, fontSize: 10 }}
                            title={t('Retirer')}
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
                      options={[{ value: '', label: t('— donner un personnage —') }, ...pcs.map((p) => ({ value: p.id, label: p.name }))]}
                      onChange={(id) => id && send('users/assign', { userId: u.id, characterId: id, assign: true })}
                    />
                  </td>
                  <td className="right">
                    <Button small variant="ghost" onClick={() => send('users/resetPin', { userId: u.id }).then(() => toast(t('PIN effacé'), 'success'))}>
                      {t('Effacer PIN')}
                    </Button>
                    <Button small variant="danger" onClick={async () => (await confirmAction(t('Supprimer le joueur {name} ?', { name: u.name }))) && send('users/remove', { userId: u.id })}>
                      {t('Supprimer')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{t('Aucun joueur ne s’est encore connecté. Envoie-leur le lien ci-dessus.')}</Empty>
        )}
      </Panel>

      <h3 className="section-title">{t('Traductions')}</h3>
      <Panel>
        <MissingTranslations />
      </Panel>
    </div>
  );
}
