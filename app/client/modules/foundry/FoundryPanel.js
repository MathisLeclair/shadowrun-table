// GM panel (Réglages): import / re-sync the Foundry VTT world — PCs, NPC templates, scenes → maps, journals, playlists.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Button, Panel, Field, Badge, Empty, Toggle, loadCss, confirmAction } from '../../lib/ui.js';
import { send, useServerEvent } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { nuyen } from '/shared/util.js';

loadCss('/modules/foundry/foundry.css');

const STATUS = {
  new: { label: 'Nouveau', color: 'cyan' },
  update: { label: 'Mise à jour', color: 'amber' },
  unchanged: { label: 'À jour', color: 'green' },
};
const KIND_FR = { music: 'Musique', ambient: 'Ambiance', sfx: 'Bruitages' };

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.new;
  return html`<${Badge} color=${s.color}>${s.label}</${Badge}>`;
}

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Default selection: everything new or changed. */
function defaultSelection(scan) {
  const pickIds = (list) => new Set(list.filter((x) => x.status !== 'unchanged').map((x) => x.fid));
  return {
    pcs: pickIds(scan.pcs),
    npcs: pickIds(scan.npcs),
    scenes: pickIds(scan.scenes),
    journals: scan.journals.docs.some((d) => d.status !== 'unchanged'),
    playlists: scan.playlists.some((p) => p.newTracks > 0 && p.tracks > 0),
  };
}

function SectionHead({ title, count, total, onAll, onNone, children }) {
  return html`<div class="foundry-section-head">
    <h4>${title} <span class="muted small">${count}/${total} sélectionné${count > 1 ? 's' : ''}</span></h4>
    <div class="row gap-s">
      ${children}
      ${onAll && html`<${Button} small variant="ghost" onClick=${onAll}>Tout</${Button}>`}
      ${onNone && html`<${Button} small variant="ghost" onClick=${onNone}>Aucun</${Button}>`}
    </div>
  </div>`;
}

function Check({ checked, onChange, label }) {
  return html`<input type="checkbox" class="foundry-check" aria-label=${label} checked=${!!checked} onChange=${(e) => onChange(e.target.checked)} />`;
}

export default function FoundryPanel({ game }) {
  const [worldPath, setWorldPath] = useState(game.foundry?.worldPath || '');
  const [worlds, setWorlds] = useState([]);
  const [busy, setBusy] = useState('');
  const [scan, setScan] = useState(null);
  const [sel, setSel] = useState(null);
  const [pcMode, setPcMode] = useState('merge');
  const [assignPlayers, setAssignPlayers] = useState(false);
  const [result, setResult] = useState(null);
  const [audio, setAudio] = useState(null);
  const last = game.foundry?.lastImport || null;

  useEffect(() => {
    send('foundry/worlds', {}, { silent: true })
      .then((r) => {
        setWorlds(r.worlds || []);
        if (!worldPath) setWorldPath(r.detected || '');
      })
      .catch(() => {});
  }, []);

  useServerEvent('foundry/audio', (p) => {
    setAudio(p);
    if (p && !p.running && !p.error && p.total) toast('Fichiers audio Foundry copiés', 'success');
  }, []);

  const doScan = async () => {
    setBusy('scan');
    setResult(null);
    try {
      const r = await send('foundry/scan', { worldPath });
      setScan(r);
      setSel(defaultSelection(r));
      if (r.world?.path) setWorldPath(r.world.path);
      if (r.audioJob) setAudio({ ...r.audioJob, running: true });
    } catch {
      /* toast shown by send() */
    } finally {
      setBusy('');
    }
  };

  const counts = useMemo(() => {
    if (!scan || !sel) return null;
    return { pcs: sel.pcs.size, npcs: sel.npcs.size, scenes: sel.scenes.size, journals: sel.journals ? scan.journals.docs.length : 0, playlists: sel.playlists ? scan.playlists.reduce((s, p) => s + p.tracks, 0) : 0 };
  }, [scan, sel]);
  const nothing = counts && !counts.pcs && !counts.npcs && !counts.scenes && !counts.journals && !counts.playlists;

  const toggleIn = (key, id, on) =>
    setSel((s) => {
      const next = new Set(s[key]);
      if (on) next.add(id);
      else next.delete(id);
      return { ...s, [key]: next };
    });
  const setAll = (key, list) => setSel((s) => ({ ...s, [key]: new Set(list.map((x) => x.fid)) }));
  const setNone = (key) => setSel((s) => ({ ...s, [key]: new Set() }));

  const doImport = async () => {
    const parts = [];
    if (counts.pcs) parts.push(`${counts.pcs} personnage(s) joueur(s) en mode ${pcMode === 'merge' ? 'fusion' : 'remplacement'}`);
    if (counts.npcs) parts.push(`${counts.npcs} PNJ`);
    if (counts.scenes) parts.push(`${counts.scenes} carte(s)`);
    if (counts.journals) parts.push(`${counts.journals} journaux`);
    if (counts.playlists) parts.push(`${counts.playlists} pistes audio`);
    if (!(await confirmAction(`Importer depuis Foundry : ${parts.join(', ')} ?\n\nUne sauvegarde de la partie est conseillée avant (bouton « Créer une sauvegarde »).`))) return;
    setBusy('import');
    try {
      const r = await send('foundry/import', {
        worldPath,
        pcMode,
        assignPlayers,
        select: { pcs: [...sel.pcs], npcs: [...sel.npcs], scenes: [...sel.scenes], journals: sel.journals, playlists: sel.playlists },
      });
      setResult(r);
      toast(r.text || 'Import terminé', 'success');
      if (r.audio?.queued) setAudio({ total: r.audio.files, done: 0, bytes: r.audio.bytes, running: true });
      // Refresh statuses (fast: the world is cached server-side).
      const again = await send('foundry/scan', { worldPath }, { silent: true }).catch(() => null);
      if (again) {
        setScan(again);
        setSel(defaultSelection(again));
      }
    } catch {
      /* toast shown */
    } finally {
      setBusy('');
    }
  };

  return html`<${Panel} title="Foundry VTT — synchronisation" class="foundry-panel"
    actions=${last && html`<span class="small muted">Dernier import : ${fmtDate(last.ts)} (${last.worldTitle || last.worldId})</span>`}>
    <div class="col">
      <p class="muted small foundry-intro">
        Importe le monde Foundry du MJ : fiches des PJ, PNJ (vers le bestiaire), scènes (cartes avec leurs murs, portes et lumières), journaux (documents de campagne) et playlists.
        <strong> Foundry reste la source de vérité pour les fiches : relance l'import avant chaque séance si tes joueurs ont modifié leur fiche dans Foundry.</strong>
        Foundry peut rester ouvert : la base est lue depuis une copie.
      </p>
      <${Field} label="Dossier du monde Foundry" hint="Détecté automatiquement depuis la configuration de Foundry (options.json → dataPath).">
        <div class="row">
          <input class="input grow mono" list="foundry-worlds" value=${worldPath} onInput=${(e) => setWorldPath(e.target.value)} placeholder="C:/Users/…/Foundry/Data/worlds/mon-monde" />
          <datalist id="foundry-worlds">${worlds.filter((w) => w.system === 'shadowrun5e').map((w) => html`<option value=${w.path}>${w.title}</option>`)}</datalist>
          <${Button} variant="primary" disabled=${!!busy || !worldPath} onClick=${doScan}>${busy === 'scan' ? 'Analyse…' : scan ? 'Analyser à nouveau' : 'Analyser'}</${Button}>
        </div>
      </${Field}>

      ${audio && html`<div class="foundry-audio">
        ${audio.error
          ? html`<${Badge} color="red">Audio : ${audio.error}</${Badge}>`
          : audio.running
            ? html`<span class="small">Copie des fichiers audio… ${audio.done || 0}/${audio.total || '?'}</span>
                <div class="foundry-progress"><div style=${{ width: `${audio.total ? Math.round(((audio.done || 0) / audio.total) * 100) : 0}%` }}></div></div>`
            : html`<span class="small foundry-ok">Audio prêt (${audio.total} fichier${audio.total > 1 ? 's' : ''}).</span>`}
      </div>`}

      ${scan && sel && html`<${ScanView} scan=${scan} sel=${sel} setSel=${setSel} toggleIn=${toggleIn} setAll=${setAll} setNone=${setNone}
          pcMode=${pcMode} setPcMode=${setPcMode} assignPlayers=${assignPlayers} setAssignPlayers=${setAssignPlayers} />`}

      ${scan && html`<div class="row wrap foundry-actions">
        <${Button} variant="accent" disabled=${!!busy || nothing} onClick=${doImport}>${busy === 'import' ? 'Import en cours…' : 'Importer la sélection'}</${Button}>
        ${counts && html`<span class="small muted">${[counts.pcs && `${counts.pcs} PJ`, counts.npcs && `${counts.npcs} PNJ`, counts.scenes && `${counts.scenes} cartes`, counts.journals && `${counts.journals} journaux`, counts.playlists && `${counts.playlists} pistes`].filter(Boolean).join(' · ') || 'Rien de sélectionné'}</span>`}
      </div>`}

      ${result && html`<${ResultView} result=${result} />`}
    </div>
  </${Panel}>`;
}

function ScanView({ scan, sel, setSel, toggleIn, setAll, setNone, pcMode, setPcMode, assignPlayers, setAssignPlayers }) {
  const w = scan.world || {};
  return html`<div class="col foundry-scan">
    <div class="row wrap small muted">
      <${Badge} color="cyan">${w.title || w.id}</${Badge}>
      <span>Système ${w.system} ${w.systemVersion || ''} · Foundry ${w.coreVersion || ''}</span>
      ${scan.missingAssets?.length ? html`<span title=${scan.missingAssets.join('\n')}>· ${scan.missingAssets.length} fichier(s) introuvable(s) dans Foundry</span>` : null}
    </div>

    <section class="foundry-section">
      <${SectionHead} title="Personnages joueurs" count=${sel.pcs.size} total=${scan.pcs.length} onAll=${() => setAll('pcs', scan.pcs)} onNone=${() => setNone('pcs')} />
      <div class="foundry-modes">
        <label class=${pcMode === 'merge' ? 'on' : ''}><input type="radio" name="foundry-pcmode" checked=${pcMode === 'merge'} onChange=${() => setPcMode('merge')} />
          <span><strong>Fusionner</strong> — ne reprend que ce qui a changé dans Foundry depuis le dernier import ; les achats et entraînements faits dans l'app sont conservés.</span></label>
        <label class=${pcMode === 'replace' ? 'on' : ''}><input type="radio" name="foundry-pcmode" checked=${pcMode === 'replace'} onChange=${() => setPcMode('replace')} />
          <span><strong>Remplacer</strong> — la fiche Foundry fait foi (attributs, compétences, équipement, karma, nuyens). L'historique, les notes et l'attribution aux joueurs sont gardés.</span></label>
      </div>
      <div class="foundry-pcs">
        ${scan.pcs.map((p) => html`<div class=${`card foundry-pc ${sel.pcs.has(p.fid) ? 'selected' : ''}`}>
          <div class="row">
            <${Check} checked=${sel.pcs.has(p.fid)} onChange=${(on) => toggleIn('pcs', p.fid, on)} label=${p.name} />
            ${p.portrait ? html`<img class="foundry-avatar" src=${p.portrait} alt="" />` : html`<div class="foundry-avatar empty-avatar">${p.name[0]}</div>`}
            <div class="grow">
              <div class="row wrap gap-s"><strong>${p.name}</strong><${StatusBadge} status=${p.status} />${p.retired && html`<${Badge}>retraité</${Badge}>`}</div>
              <div class="small muted">${p.player ? `Joueur Foundry : ${p.player}` : 'Aucun joueur propriétaire'} · ${p.karma} karma · ${nuyen(p.nuyen)}${p.vehicles.length ? ` · ${p.vehicles.join(', ')}` : ''}</div>
            </div>
          </div>
          ${p.diff.length ? html`<ul class="foundry-diff">${p.diff.map((d) => html`<li>${d}</li>`)}</ul>` : p.status === 'unchanged' && html`<div class="small muted foundry-diff">Aucun changement depuis le dernier import.</div>`}
        </div>`)}
      </div>
      <${Toggle} value=${assignPlayers} onChange=${setAssignPlayers} label="Attribuer chaque PJ au joueur Foundry du même nom (s'il n'est pas déjà attribué)" />
    </section>

    <section class="foundry-section">
      <${SectionHead} title="PNJ → bestiaire" count=${sel.npcs.size} total=${scan.npcs.length} onAll=${() => setAll('npcs', scan.npcs)} onNone=${() => setNone('npcs')} />
      <p class="small muted">Les PNJ déjà présents dans le bestiaire (même nom) gardent leur description, leurs tactiques et leur dossier ; leurs statistiques sont reprises de Foundry.</p>
      <div class="scroll foundry-table-wrap">
        <table class="sr foundry-table">
          <thead><tr><th></th><th>Foundry</th><th>Bestiaire</th><th>Dossier</th><th>État</th></tr></thead>
          <tbody>
            ${scan.npcs.map((n) => html`<tr class=${sel.npcs.has(n.fid) ? 'selected' : ''}>
              <td><${Check} checked=${sel.npcs.has(n.fid)} onChange=${(on) => toggleIn('npcs', n.fid, on)} label=${n.name} /></td>
              <td>${n.name}<div class="small faint">${n.foundryFolder}</div></td>
              <td>${n.templateName || html`<span class="muted">${n.templateId}</span>`}${!n.hasStats && html` <${Badge} title="Fiche vide dans Foundry : les statistiques de l'app sont conservées">sans stats</${Badge}>`}</td>
              <td class="small">${n.folder}</td>
              <td><${StatusBadge} status=${n.status} /></td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    </section>

    <section class="foundry-section">
      <${SectionHead} title="Scènes → cartes" count=${sel.scenes.size} total=${scan.scenes.length} onAll=${() => setAll('scenes', scan.scenes)} onNone=${() => setNone('scenes')} />
      <p class="small muted">Chaque scène devient une carte « image » : le décor Foundry sert de sol, les murs, portes et lumières sont convertis. Les jetons ne sont pas copiés (ils sont listés dans la description de la carte).</p>
      <div class="foundry-scenes">
        ${scan.scenes.map((s) => html`<label class=${`card foundry-scene ${sel.scenes.has(s.fid) ? 'selected' : ''}`}>
          <div class="foundry-thumb">${s.thumb ? html`<img src=${s.thumb} alt="" loading="lazy" />` : html`<span class="faint small">pas d'aperçu</span>`}</div>
          <div class="row gap-s">
            <${Check} checked=${sel.scenes.has(s.fid)} onChange=${(on) => toggleIn('scenes', s.fid, on)} label=${s.name} />
            <strong class="grow foundry-ellipsis" title=${s.name}>${s.name}</strong>
            <${StatusBadge} status=${s.status} />
          </div>
          <div class="small muted">${s.size} cases · ${s.walls} murs${s.doors ? ` · ${s.doors} portes` : ''} · ${s.lights} lumières</div>
          <div class="small faint foundry-ellipsis">${s.folder}${s.linkedTo ? ' · liée aux quêtes' : ''}</div>
        </label>`)}
      </div>
      ${scan.skippedScenes?.length ? html`<div class="small muted">Ignorées : ${scan.skippedScenes.map((s) => `${s.name} (${s.reason})`).join(', ')}</div>` : null}
    </section>

    <div class="grid-2">
      <section class="foundry-section">
        <${SectionHead} title="Journaux" count=${sel.journals ? scan.journals.docs.length : 0} total=${scan.journals.docs.length}>
          <${Toggle} value=${sel.journals} onChange=${(v) => setSel((s) => ({ ...s, journals: v }))} label="Importer" />
        </${SectionHead}>
        <p class="small muted">Convertis en documents Markdown dans <code>Shadowrun/foundry/</code> (onglet Campagne → Documents).${scan.journals.pdfs ? ` ${scan.journals.pdfs} livre(s) de règles PDF sont seulement listés dans l'index.` : ''}</p>
        <ul class="foundry-list">
          ${scan.journals.docs.map((d) => html`<li><span class="grow foundry-ellipsis" title=${d.file}>${d.folder ? html`<span class="faint">${d.folder} › </span>` : null}${d.title}</span><${StatusBadge} status=${d.status} /></li>`)}
        </ul>
      </section>
      <section class="foundry-section">
        <${SectionHead} title="Playlists → audio" count=${sel.playlists ? 1 : 0} total=${1}>
          <${Toggle} value=${sel.playlists} onChange=${(v) => setSel((s) => ({ ...s, playlists: v }))} label="Importer" />
        </${SectionHead}>
        <p class="small muted">Les fichiers sont copiés dans l'app (${scan.audio?.size || '0'} au total) en arrière-plan ; les pistes apparaissent dans l'onglet Audio.</p>
        <ul class="foundry-list">
          ${scan.playlists.map((p) => html`<li>
            <span class="grow">${p.name} <span class="faint small">· ${KIND_FR[p.kind] || p.kind}</span></span>
            <span class="small muted">${p.tracks ? `${p.tracks} piste${p.tracks > 1 ? 's' : ''} · ${p.size}` : 'fichiers introuvables'}</span>
            ${p.tracks ? html`<${Badge} color=${p.newTracks ? 'cyan' : 'green'}>${p.newTracks ? `${p.newTracks} nouvelle${p.newTracks > 1 ? 's' : ''}` : 'À jour'}</${Badge}>` : null}
          </li>`)}
        </ul>
      </section>
    </div>
  </div>`;
}

function ResultView({ result }) {
  const line = (label, list) => (list?.length ? html`<li><strong>${label}</strong> : ${list.filter((x) => x.status === 'new').length} nouveau(x), ${list.filter((x) => x.status !== 'new').length} mis à jour</li>` : null);
  return html`<div class="card foundry-result">
    <h4>Import terminé</h4>
    <ul class="small">
      ${line('Personnages joueurs', result.pcs)}
      ${line('PNJ', result.npcs)}
      ${line('Cartes', result.maps)}
      ${result.journals?.length ? html`<li><strong>Journaux</strong> : ${result.journals.length} document(s) dans <code>${result.docsDir}</code></li>` : null}
      ${result.tracks ? html`<li><strong>Audio</strong> : ${result.tracks} piste(s)${result.audio?.queued ? ` — copie de ${result.audio.size} en cours` : ''}</li>` : null}
      ${result.questLinks ? html`<li><strong>Quêtes</strong> : ${result.questLinks} lien(s) de carte ajouté(s)</li>` : null}
      ${result.users?.length ? html`<li><strong>Joueurs</strong> : ${result.users.join(', ')}</li>` : null}
      <li class="muted">Fichiers images : ${result.assets.copied} copié(s), ${result.assets.skipped} déjà à jour (${result.assets.size})</li>
      ${result.missing?.length ? html`<li class="muted" title=${result.missing.join('\n')}>${result.missing.length} fichier(s) référencé(s) introuvable(s) dans Foundry</li>` : null}
    </ul>
  </div>`;
}
