// « Créer un ennemi » — quick tiered enemy generator (GM). Archetype × Professional Rating, live stat-block preview,
// save to the bestiary (folder « Générés ») and/or spawn on a map. Generation runs server-side (npcgen/preview).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Modal, Button, Select, NumberInput, Toggle, TextInput, Field, Tabs, IconButton, loadCss } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { useUI, toast } from '../../lib/ui-store.js';
import { ARCHETYPES, ARCHETYPE_BY_ID, TIERS, METATYPE_CHOICES, GRUNT_RULES, randomSeed, makeName } from '/shared/npcgen.js';
import StatBlock from '../combat/StatBlock.js';
import { t, tn, compare, metatypeLabel } from '../../lib/i18n.js';

loadCss('/modules/chargen/chargen.css');
loadCss('/modules/combat/combat.css');

const NO_MAP = '__none';
const metaLabel = (m) => (m === 'random' ? t('Aléatoire') : metatypeLabel(m));
// Remember the last setup while the GM keeps generating.
const memo = { archetype: 'ganger', tier: 2, metatype: 'random' };

/** props: { game, onClose(), onCreated?({ templateIds, actorIds }) } */
export default function EnemyGenerator({ game, onClose, onCreated }) {
  const ui = useUI();
  const [archetype, setArchetype] = useState(memo.archetype);
  const a = ARCHETYPE_BY_ID[archetype] || ARCHETYPES[0];
  const [tier, setTier] = useState(memo.tier);
  const [metatype, setMetatype] = useState(memo.metatype);
  const [seed, setSeed] = useState(() => randomSeed());
  const [grunt, setGrunt] = useState(!!a.grunt);
  const [lieutenant, setLieutenant] = useState(false);
  const [count, setCount] = useState(a.grunt ? 4 : 1);
  const [name, setName] = useState('');
  const [ltName, setLtName] = useState('');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('main');
  const [busy, setBusy] = useState(false);
  const maps = useMemo(() => Object.values(game.maps || {}).sort((x, y) => compare(x.name, y.name)), [game.maps]);
  const defaultMap = (ui.viewMapId && game.maps?.[ui.viewMapId] && ui.viewMapId) || game.scene?.activeMapId || maps[0]?.id || NO_MAP;
  const [mapChoice, setMapChoice] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [addToCombat, setAddToCombat] = useState(true);
  const [keep, setKeep] = useState(false);
  Object.assign(memo, { archetype, tier, metatype });

  const critter = a.kind === 'critter';
  const metaLocked = critter && !a.metaFrom;
  const withLt = grunt && lieutenant;

  const pickArchetype = (id) => {
    const x = ARCHETYPE_BY_ID[id];
    setArchetype(id);
    setGrunt(!!x.grunt);
    setCount(x.grunt ? 4 : 1);
    setLieutenant(false);
    setName('');
    setLtName('');
    setTab('main');
    setSeed(randomSeed());
  };

  // Live preview (stale answers dropped).
  const req = useRef(0);
  useEffect(() => {
    const n = ++req.current;
    setLoading(true);
    const timer = setTimeout(() => {
      send('npcgen/preview', { archetype, tier, metatype: metaLocked ? 'random' : metatype, seed, grunt, lieutenant: withLt }, { silent: true })
        .then((res) => n === req.current && setPreview(res))
        .catch((err) => n === req.current && toast(err.message || t('Aperçu impossible'), 'error'))
        .finally(() => n === req.current && setLoading(false));
    }, 120);
    return () => clearTimeout(timer);
  }, [archetype, tier, metatype, seed, grunt, withLt]);

  const autoName = preview ? (count > 1 || grunt ? preview.unitName : preview.main?.name) || '' : '';
  const finalName = name.trim() || autoName;
  const finalLt = ltName.trim() || preview?.lieutenant?.name || '';
  const shown = tab === 'lieutenant' && preview?.lieutenant ? { ...preview.lieutenant, name: finalLt } : preview?.main ? { ...preview.main, name: finalName } : null;

  const mapId = mapChoice && (mapChoice === NO_MAP || game.maps?.[mapChoice]) ? mapChoice : defaultMap;
  const map = mapId !== NO_MAP ? game.maps?.[mapId] : null;
  const anchor = map && (ui.selectedTokenIds || []).map((id) => (map.tokens || []).find((tk) => tk.id === id)).find(Boolean);
  const combatOn = !!game.combat?.active;

  const payload = () => ({
    archetype, tier, metatype: metaLocked ? 'random' : metatype, seed, grunt, lieutenant: withLt,
    name: finalName, lieutenantName: withLt ? finalLt : undefined,
  });
  const saveOnly = async () => {
    setBusy(true);
    try {
      const res = await send('npcgen/create', { ...payload(), saveToBestiary: true });
      toast(res.templateIds.length > 1 ? t('{n} modèles ajoutés au bestiaire (Générés)', { n: res.templateIds.length }) : t('Modèle ajouté au bestiaire (Générés)'), 'success');
      onCreated?.(res);
      setSeed(randomSeed());
      setName('');
      setLtName('');
    } catch {
      /* toasted */
    }
    setBusy(false);
  };
  const spawn = async () => {
    setBusy(true);
    try {
      const sp = { mapId: map ? map.id : null, count, hidden, addToCombat: combatOn && addToCombat };
      if (anchor) {
        sp.x = anchor.x;
        sp.y = anchor.y;
      }
      const res = await send('npcgen/create', { ...payload(), saveToBestiary: keep, spawn: sp });
      const n = res.actorIds.length;
      toast(map
        ? hidden ? t('{n} PNJ sur « {map} » (cachés)', { n, map: map.name }) : t('{n} PNJ sur « {map} »', { n, map: map.name })
        : tn(n, '{n} PNJ créé (sans token)', '{n} PNJ créés (sans token)'), 'success');
      if (res.unplaced) toast(t('{n} PNJ sans place libre sur la carte (acteurs créés sans token)', { n: res.unplaced }), 'warn');
      onCreated?.(res);
      onClose();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };

  const groups = [
    { label: t('Métahumains'), list: ARCHETYPES.filter((x) => x.kind !== 'critter') },
    { label: t('Créatures'), list: ARCHETYPES.filter((x) => x.kind === 'critter') },
  ];
  const tierInfo = TIERS[tier];

  return html`<${Modal} title=${t('Créer un ennemi')} width=${1180} onClose=${onClose}>
    <div class="cg-eg">
      <div class="cg-eg-left">
        ${groups.map((g) => html`<div class="section-title">${g.label}</div>
          <div class="cg-eg-archetypes">
            ${g.list.map((x) => html`<button key=${x.id} class=${'cg-eg-arch' + (x.id === archetype ? ' on' : '')} style=${{ '--ac': x.color }} onClick=${() => pickArchetype(x.id)} title=${t(x.blurb)}>
              <span class="cg-eg-arch-icon">${x.icon}</span><span class="cg-eg-arch-label">${t(x.label)}</span>
            </button>`)}
          </div>`)}
        <div class="small muted cg-eg-blurb">${t(a.blurb)}</div>

        <div class="section-title">${t('Indice de professionnalisme')}</div>
        <div class="cg-eg-tier">
          <input type="range" min="0" max="6" step="1" value=${tier} onInput=${(e) => setTier(Number(e.target.value))} />
          <div class="cg-eg-ticks">${TIERS.map((x) => html`<button class=${'cg-eg-tick' + (x.pr === tier ? ' on' : '')} onClick=${() => setTier(x.pr)} title=${t(x.label)}>${x.pr}</button>`)}</div>
          <div class="cg-eg-tier-text"><strong>${t('PR {pr} — {label}', { pr: tier, label: { t: tierInfo.label } })}</strong><div class="small muted">${t(tierInfo.text)}</div></div>
        </div>

        <div class="section-title">${t('Options')}</div>
        <div class="cg-eg-opts">
          <${Field} label=${t('Métatype')}><${Select} value=${metaLocked ? 'random' : metatype} disabled=${metaLocked} onChange=${setMetatype} options=${METATYPE_CHOICES.map((m) => ({ value: m, label: metaLocked ? '—' : metaLabel(m) }))} /></${Field}>
          <${Field} label=${t('Nombre')}><${NumberInput} value=${count} min=${1} max=${20} onChange=${setCount} /></${Field}>
          <${Field} label=${t('Groupe de sbires')}><${Toggle} value=${grunt} onChange=${(v) => (setGrunt(v), v || setLieutenant(false))} label=${grunt ? t('Oui') : t('Non')} title=${t('Moniteur unique, pas de Chance (règles SR5 des sbires)')} /></${Field}>
          ${grunt && html`<${Field} label=${t('Lieutenant')}><${Toggle} value=${lieutenant} onChange=${setLieutenant} label=${lieutenant ? t('+1 (PR {pr})', { pr: Math.min(7, tier + 1) }) : t('Non')} title=${t('Un chef PR +1 avec sa Chance, en plus du nombre choisi')} /></${Field}>`}
        </div>
        <div class="cg-eg-names">
          <${Field} label=${count > 1 || grunt ? t('Nom du groupe (numéroté à l’apparition)') : t('Nom')}>
            <div class="row gap-s">
              <${TextInput} live value=${name || autoName} onChange=${setName} />
              <${IconButton} icon="↻" title=${t('Autre nom')} onClick=${() => setName(makeName(archetype, randomSeed()))} />
              ${name && html`<${IconButton} icon="↺" title=${t('Nom automatique')} onClick=${() => setName('')} />`}
            </div>
          </${Field}>
          ${withLt && html`<${Field} label=${t('Nom du lieutenant')}>
            <div class="row gap-s">
              <${TextInput} live value=${ltName || preview?.lieutenant?.name || ''} onChange=${setLtName} />
              <${IconButton} icon="↻" title=${t('Autre nom')} onClick=${() => setLtName(makeName(archetype, randomSeed(), { lieutenant: true }))} />
            </div>
          </${Field}>`}
        </div>
        ${grunt && html`<div class="small faint cg-eg-rules">${t(GRUNT_RULES)}</div>`}
      </div>

      <div class="cg-eg-right">
        <div class="row wrap gap-s cg-eg-prev-bar">
          ${withLt ? html`<${Tabs} tabs=${[{ id: 'main', label: count > 1 ? t('Sbires ×{n}', { n: count }) : t('Sbire') }, { id: 'lieutenant', label: t('Lieutenant') }]} value=${tab} onChange=${setTab} />` : html`<strong class="cg-eg-prev-title">${t('Aperçu')}</strong>`}
          <span class="grow"></span>
          ${loading && html`<span class="small faint">${t('Génération…')}</span>`}
          <${Button} small onClick=${() => setSeed(randomSeed())} title=${t('Nouveau tirage (même archétype et même PR)')}>🎲 ${t('tirage::Relancer')}</${Button}>
        </div>
        <div class=${'cg-eg-preview' + (loading ? ' loading' : '')}>
          ${shown ? html`<${StatBlock} t=${shown} />` : html`<div class="cg-loading">${t('Génération…')}</div>`}
        </div>
      </div>
    </div>

    <footer class="cg-eg-foot">
      <div class="row wrap cg-eg-spawn">
        <${Field} label=${t('Carte')}>
          <select class="input" value=${mapId} onChange=${(e) => setMapChoice(e.target.value)}>
            ${maps.map((m) => html`<option value=${m.id} selected=${m.id === mapId}>${m.name}${m.id === game.scene?.activeMapId ? ` ${t('(active)')}` : ''}</option>`)}
            <option value=${NO_MAP} selected=${mapId === NO_MAP}>${t('— Aucune (fiches seulement) —')}</option>
          </select>
        </${Field}>
        <${Field} label=${t('Visibilité')}><${Toggle} value=${hidden} onChange=${setHidden} label=${hidden ? t('Caché') : t('Visible')} /></${Field}>
        ${combatOn && html`<${Field} label=${t('Combat')}><${Toggle} value=${addToCombat} onChange=${setAddToCombat} label=${t('Ajouter')} /></${Field}>`}
        <${Field} label=${t('Bestiaire')}><${Toggle} value=${keep} onChange=${setKeep} label=${t('Garder le modèle')} title=${t('Enregistre aussi le modèle dans le dossier « Générés »')} /></${Field}>
        <span class="grow"></span>
        <${Button} disabled=${busy || !preview} onClick=${saveOnly}>${t('Ajouter au bestiaire')}</${Button}>
        <${Button} variant="primary" disabled=${busy || !preview} onClick=${spawn}>☠ ${map ? t('Faire apparaître sur la carte ({n})', { n: count + (withLt ? 1 : 0) }) : t('Faire apparaître ({n})', { n: count + (withLt ? 1 : 0) })}</${Button}>
      </div>
      <div class="small faint">${map ? (anchor ? t('Près du token sélectionné ({name}).', { name: anchor.name }) : t('Au centre de la carte (sélectionne un token sur la carte pour les placer à côté).')) : t('Les PNJ seront créés sans token.')}</div>
    </footer>
  </${Modal}>`;
}
