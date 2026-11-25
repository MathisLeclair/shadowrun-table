// GM settings: campaign name, GM password, players & character assignment, backups.
import { useState } from 'preact/hooks';
import { html, Button, Panel, Field, TextInput, Badge, Select, Empty, confirmAction } from '../../lib/ui.js';
import { send, api, getToken } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import FoundryPanel from '../foundry/FoundryPanel.js';

export default function SettingsPage({ game }) {
  const [pwd, setPwd] = useState('');
  const [announce, setAnnounce] = useState(game.ui?.announcement || '');
  const users = Object.values(game.users || {});
  const pcs = Object.values(game.actors).filter((a) => a.type === 'pc');
  const playerUrl = `${location.protocol}//${location.host}`;

  const doImport = async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // so picking the same (corrected) file again fires onChange
    if (!file) return;
    if (!(await confirmAction('Remplacer toute la partie par cette sauvegarde ? (une sauvegarde automatique est faite avant)'))) return;
    try {
      await api('/api/admin/import', { method: 'POST', body: JSON.parse(await file.text()) });
      toast('Sauvegarde importée', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return html`<div class="page">
    <div class="page-title"><h2>Réglages</h2></div>
    <div class="grid-2">
      <${Panel} title="Partie">
        <div class="col">
          <${Field} label="Nom de la campagne"><${TextInput} value=${game.config.campaignName} onChange=${(v) => send('config/update', { campaignName: v })} /></${Field}>
          <${Field} label="Nouveau mot de passe MJ" hint="Le mot de passe par défaut est « lazarus » — change-le.">
            <div class="row"><input class="input" type="password" value=${pwd} onInput=${(e) => setPwd(e.target.value)} />
              <${Button} onClick=${() => pwd && send('config/update', { gmPassword: pwd }).then(() => { setPwd(''); toast('Mot de passe changé', 'success'); })}>Changer</${Button}></div>
          </${Field}>
          <${Field} label="Lien pour les joueurs" hint="Sur le même réseau Wi-Fi, utilise l'adresse IP affichée dans la console du serveur.">
            <code class="mono cyan">${playerUrl}</code>
          </${Field}>
          <${Field} label="Bandeau d'annonce (visible par tous)">
            <div class="row">
              <${TextInput} value=${announce} live onChange=${setAnnounce} placeholder="ex. Pause 10 minutes" />
              <${Button} onClick=${() => send('ui/announce', { text: announce })}>Afficher</${Button}>
              <${Button} variant="ghost" onClick=${() => { setAnnounce(''); send('ui/announce', { text: null }); }}>Effacer</${Button}>
            </div>
          </${Field}>
        </div>
      </${Panel}>

      <${Panel} title="Sauvegardes">
        <div class="col">
          <p class="muted small">La partie est enregistrée automatiquement dans <code>data/state.json</code>, avec une copie de secours toutes les 15 minutes dans <code>data/backups/</code>.</p>
          <div class="row wrap">
            <${Button} onClick=${() => api('/api/admin/backup', { method: 'POST' }).then((r) => toast('Sauvegarde : ' + r.file, 'success')).catch((err) => toast(err.message || 'Sauvegarde impossible', 'error'))}>Créer une sauvegarde</${Button}>
            <a class="btn" href=${'/api/admin/export?token=' + getToken()} download="shadowrun-partie.json">Télécharger la partie</a>
            <label class="btn">Importer une partie<input type="file" accept=".json" class="hidden" onChange=${doImport} /></label>
          </div>
          <div class="row wrap">
            <${Button} variant="danger" onClick=${async () => {
              if (await confirmAction('Réinitialiser la partie depuis les données de départ ? Personnages, cartes et journal reviennent à zéro (une sauvegarde est faite avant).')) {
                try {
                  await api('/api/admin/reset', { method: 'POST' });
                  toast('Partie réinitialisée', 'success');
                } catch (err) {
                  toast(err.message || 'Réinitialisation impossible', 'error');
                }
              }
            }}>Réinitialiser depuis les données de départ</${Button}>
            <${Button} variant="ghost" onClick=${async () => (await confirmAction('Vider le journal ?')) && send('log/clear')}>Vider le journal</${Button}>
          </div>
        </div>
      </${Panel}>
    </div>

    <${FoundryPanel} game=${game} />

    <h3 class="section-title">Joueurs</h3>
    <${Panel} pad=${false}>
      ${users.length
        ? html`<table class="sr">
            <thead><tr><th>Joueur</th><th>État</th><th>Personnage(s)</th><th>Attribuer</th><th></th></tr></thead>
            <tbody>
              ${users.map(
                (u) => html`<tr>
                  <td><strong>${u.name}</strong></td>
                  <td>${(game.online || []).includes(u.id) ? html`<${Badge} color="green">en ligne</${Badge}>` : html`<${Badge}>hors ligne</${Badge}>`}</td>
                  <td>${(u.characterIds || []).map((id) => html`<${Badge} color="cyan">${game.actors[id]?.name || id}
                      <button class="icon-btn" style="width:16px;height:16px;font-size:10px" title="Retirer" onClick=${() => send('users/assign', { userId: u.id, characterId: id, assign: false })}>✕</button></${Badge}> `)}</td>
                  <td><${Select} value="" options=${[{ value: '', label: '— donner un personnage —' }, ...pcs.map((p) => ({ value: p.id, label: p.name }))]}
                      onChange=${(id) => id && send('users/assign', { userId: u.id, characterId: id, assign: true })} /></td>
                  <td class="right">
                    <${Button} small variant="ghost" onClick=${() => send('users/resetPin', { userId: u.id }).then(() => toast('PIN effacé', 'success'))}>Effacer PIN</${Button}>
                    <${Button} small variant="danger" onClick=${async () => (await confirmAction(`Supprimer le joueur ${u.name} ?`)) && send('users/remove', { userId: u.id })}>Supprimer</${Button}>
                  </td>
                </tr>`
              )}
            </tbody>
          </table>`
        : html`<${Empty}>Aucun joueur ne s'est encore connecté. Envoie-leur le lien ci-dessus.</${Empty}>`}
    </${Panel}>
  </div>`;
}
