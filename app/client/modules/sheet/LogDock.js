// Right dock « Journal & dés »: shared log (chat, whispers, rolls, system), chat composer with whispers and
// /r /w commands, and a dice roller (quick pools, limit, Chance, secret GM rolls, character skill rolls).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Button, NumberInput, Toggle, IconButton, confirmAction, loadCss } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { attr } from '/shared/sr5.js';
import { t, tn, tk, logText, attrShort, attrLabel, getLang } from '../../lib/i18n.js';
import { isGM, ownsActor, DiceFaces, RollBadges, fmtTime, rollLabel, rollBreakdown, skillName } from './common.js';
import { RollDialog, fireText } from './RollDialog.js';
import { BookRef } from '../books/BookRef.js';
import { AvailRollLine } from '../shop/avail.js';
import { SinCheckLine } from './sins.js';
import { Dice3dPicker } from './Dice3D.js';

loadCss('/modules/sheet/sheet.css');

const LS_KEY = 'sr.logdock';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {}
}

const KIND_LABEL = { system: tk('Système'), combat: tk('Combat'), shop: tk('Boutique'), training: tk('Progression') };
// Labels are sent to the server in French (stored in the log), shown with t().
const PAIRS = [
  ['REA', 'INT', tk('Défense')],
  ['CHA', 'WIL', tk('Sang-froid')],
  ['CHA', 'INT', tk('Jauger les intentions')],
  ['LOG', 'WIL', tk('Mémoire')],
  ['BOD', 'STR', tk('Soulever / porter')],
  ['BOD', 'WIL', tk('Résister aux toxines')],
];

/** Author shown on an entry: the GM's stored 'MJ' is translated, names stay as they are. */
const authorText = (e) =>
  e.authorI18n?.key ? t(e.authorI18n.key, e.authorI18n.params) : e.author === 'MJ' ? t('MJ') : e.author || (KIND_LABEL[e.kind] ? t(KIND_LABEL[e.kind]) : '');

function authorColor(game, e) {
  if (e.roll?.actorId && game.actors?.[e.roll.actorId]?.color) return game.actors[e.roll.actorId].color;
  if (e.userId === 'gm') return 'var(--magenta)';
  const u = game.users?.[e.userId];
  const a = u && game.actors?.[(u.characterIds || [])[0]];
  return a?.color || 'var(--cyan)';
}

function userLabel(game, id) {
  if (id === 'gm') return t('MJ');
  const u = game.users?.[id];
  if (!u) return '?';
  const a = game.actors?.[(u.characterIds || [])[0]];
  return a ? `${u.name} (${a.name})` : u.name;
}

function LogEntry({ e, game, gm }) {
  const color = authorColor(game, e);
  const r = e.roll;
  const actor = r?.actorId ? game.actors?.[r.actorId] : null;
  const canSecond = r && actor && actor.attributes && ownsActor(game, actor.id) && !r.explode && !r.secondChance && !r.sinCheck && (actor.edge?.current || 0) > 0 && Array.isArray(r.dice) && r.dice.some((d) => d < 5) && Date.now() - e.ts < 15 * 60 * 1000;
  const del = () => send('log/delete', { id: e.id }).catch(() => {});
  const recipients = e.kind === 'whisper' ? (e.to || []).filter((id) => id !== e.userId).map((id) => userLabel(game, id)) : [];
  return html`<div class=${`ld-entry ld-${e.kind}${e.gmOnly ? ' ld-gmonly' : ''}`}>
    <div class="ld-meta">
      <span class="ld-author" style=${{ color }}>${authorText(e)}</span>
      ${e.kind === 'whisper' && html`<span class="ld-to">→ ${recipients.join(', ') || t('MJ')}</span>`}
      ${e.gmOnly && html`<span class="ld-tag" title=${t('Visible du MJ seulement')}>${t('MJ')}</span>`}
      ${KIND_LABEL[e.kind] && e.author && html`<span class="ld-tag">${t(KIND_LABEL[e.kind])}</span>`}
      <span class="ld-time">${fmtTime(e.ts)}</span>
      ${gm && html`<button type="button" class="ld-del" title=${t('Supprimer cette entrée')} onClick=${del}>✕</button>`}
    </div>
    ${r
      ? html`<div class="ld-roll">
          <div class="ld-roll-head">
            <span class="ld-label">${rollLabel(r) || logText(e)}</span>
            ${typeof r.hits === 'number'
              ? html`<span class=${'ld-hits' + (r.critGlitch ? ' crit' : r.glitch ? ' glitch' : r.hits === 0 ? ' zero' : '')}>${r.hits}<small> ${tn(r.hits, 'one::succès', 'other::succès')}</small></span>`
              : r.total !== undefined
                ? html`<span class="ld-hits">${r.total}</span>`
                : null}
          </div>
          <${DiceFaces} roll=${r} small />
          <div class="ld-roll-foot">
            <span class="faint small">${r.breakdown ? rollBreakdown(r.breakdown) : r.pool ? tn(r.pool, '{n} dé', '{n} dés') : ''}</span>
            <${RollBadges} roll=${r} />
            ${r.fire ? html`<span class="badge" title=${t('Munitions utilisées par ce tir')}>${fireText(r.fire)}</span>` : null}
            ${canSecond && html`<button type="button" class="ld-second" title=${t('Relancer les dés sans succès (1 point de Chance)')}
              onClick=${() => send('dice/secondChance', { logId: e.id }).catch(() => {})}>${t('2ᵉ chance')}</button>`}
          </div>
          ${r.avail ? html`<${AvailRollLine} roll=${r} Dice=${DiceFaces} />` : null}
          ${r.sinCheck ? html`<${SinCheckLine} roll=${r} />` : null}
          ${Array.isArray(r.mods) && r.mods.some((m) => m.state === 'applied') && html`<div class="ld-roll-mods">${r.mods.filter((m) => m.state === 'applied').map((m) => html`<span class="faint small" key=${m.kind + m.id}>${m.name} ${m.value >= 0 ? '+' : '−'}${Math.abs(m.value)}${m.kind === 'limit' ? ` (${t('limite')})` : ''}${m.book ? html` <${BookRef} source=${m.book} page=${m.page} />` : null}</span>`)}</div>`}
        </div>`
      : html`<div class="ld-text">${logText(e)}</div>`}
  </div>`;
}

/** <select> with optgroups to pick a quick test for an actor. */
function QuickTestSelect({ actor, onPick }) {
  if (!actor || !actor.attributes) return null;
  const skills = [...(actor.skills || [])].filter((s) => s.rating > 0).map((s) => ({ ...s, shown: skillName(s, s.id) })).sort((a, b) => String(a.shown).localeCompare(String(b.shown), getLang()));
  const kno = (actor.knowledge || []).filter((k) => !k.native);
  const attrs = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', ...(actor.attributes.MAG != null ? ['MAG'] : []), ...(actor.attributes.RES != null ? ['RES'] : [])];
  const change = (ev) => {
    const v = ev.target.value;
    ev.target.value = '';
    if (!v) return;
    const [kind, a, b, ...rest] = v.split(':');
    if (kind === 'skill') onPick({ skillId: a });
    else if (kind === 'attr') onPick({ attr: a });
    else if (kind === 'pair') onPick({ attr: a, attr2: b, label: rest.join(':') });
  };
  return html`<select class="input ld-quicktest" onChange=${change} value="">
    <option value="">${t('Jet rapide…')}</option>
    ${skills.length > 0 && html`<optgroup label=${t('Compétences')}>${skills.map((s) => html`<option value=${'skill:' + s.id}>${s.shown} (${s.rating})</option>`)}</optgroup>`}
    ${kno.length > 0 && html`<optgroup label=${t('Connaissances')}>${kno.map((k) => html`<option value=${'skill:' + k.id}>${k.name} (${k.rating})</option>`)}</optgroup>`}
    <optgroup label=${t('Tests')}>${PAIRS.map(([a, b, l]) => html`<option value=${`pair:${a}:${b}:${l}`}>${t(l)} (${attrShort(a)} + ${attrShort(b)})</option>`)}</optgroup>
    <optgroup label=${t('Attributs')}>${attrs.map((k) => html`<option value=${'attr:' + k}>${attrLabel(k)} (${attr(actor, k)})</option>`)}</optgroup>
  </select>`;
}

function DiceRoller({ game, gm, actorId, setActorId, actorOptions }) {
  const prefs = loadPrefs();
  const [pool, setPool] = useState(prefs.pool || 6);
  const [limit, setLimit] = useState(0);
  const [edge, setEdge] = useState(false);
  const [secret, setSecret] = useState(false);
  const [dialog, setDialog] = useState(null);
  const actor = actorId ? game.actors?.[actorId] : null;
  const canEdge = !!actor && !!actor.attributes && (actor.edge?.current || 0) > 0;
  const roll = async (n) => {
    const p = Math.max(1, Math.min(60, Number(n) || 1));
    savePrefs({ ...loadPrefs(), pool: p });
    try {
      await send('dice/roll', {
        pool: p, label: `${p} dé${p > 1 ? 's' : ''}`, actorId: actor ? actor.id : undefined, // i18n-ignore: stored French label, shown with rollLabel()
        limit: limit > 0 ? limit : null, explode: edge && canEdge, secret: gm && secret,
      });
      if (edge) setEdge(false);
    } catch {}
  };
  return html`<div class="ld-roller">
    <div class="ld-grid">
      ${Array.from({ length: 20 }, (_, i) => html`<button type="button" class=${'ld-q' + (i + 1 === pool ? ' on' : '')} title=${tn(i + 1, 'Lancer {n} dé', 'Lancer {n} dés')} onClick=${() => { setPool(i + 1); roll(i + 1); }}>${i + 1}</button>`)}
    </div>
    <div class="row wrap ld-roller-row">
      <${NumberInput} small value=${pool} min=${1} max=${60} onChange=${setPool} />
      <${Button} small variant="primary" onClick=${() => roll(pool)}>${t('Lancer {n}', { n: pool })}</${Button}>
      <span class="ld-limit" title=${t('Limite (0 = aucune)')}>${t('lim.')} <${NumberInput} small value=${limit} min=${0} max=${30} onChange=${setLimit} /></span>
    </div>
    <div class="row wrap ld-roller-row">
      ${actorOptions.length > 0 && html`<select class="input ld-actor" value=${actorId || ''} onChange=${(e) => setActorId(e.target.value)}>
        ${gm && html`<option value="">${t('— MJ —')}</option>`}
        ${actorOptions.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
      </select>`}
      ${actor && html`<${QuickTestSelect} actor=${actor} onPick=${(preset) => setDialog({ ...preset, _k: Date.now() })} />`}
    </div>
    <div class="row wrap ld-roller-row">
      ${actor && actor.attributes && html`<${Toggle} value=${edge && canEdge} onChange=${(v) => (canEdge ? setEdge(v) : toast(t('{name} n’a plus de Chance', { name: actor.name }), 'warn'))} label=${t('Chance ({n})', { n: actor.edge?.current ?? 0 })} title=${t('Repousser les limites : +Chance en dés, règle des 6, sans limite')} />`}
      ${gm && html`<${Toggle} value=${secret} onChange=${setSecret} label=${t('Secret')} title=${t('Jet visible du MJ seulement')} />`}
    </div>
    ${dialog && actor && html`<${RollDialog} key=${dialog._k} game=${game} actor=${actor} preset=${dialog} onClose=${() => setDialog(null)} />`}
  </div>`;
}

const helpText = () => t('Commandes : /r 12 (lancer 12 dés) · /r 12 l4 (limite 4) · /r 12 ! (Chance) · /w nom message (chuchoter) · /aide');

export default function LogDock({ game }) {
  const gm = isGM(game);
  const log = game.log || [];
  const prefs = useMemo(loadPrefs, []);
  const listRef = useRef(null);
  const atBottom = useRef(true);
  const [unread, setUnread] = useState(0);
  const [filter, setFilter] = useState(prefs.filter || 'all');
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [as, setAs] = useState('');
  const [showRoller, setShowRoller] = useState(prefs.roller !== false);
  const myActors = (game.me.characterIds || []).map((id) => game.actors?.[id]).filter((a) => a && a.attributes);
  const actorOptions = gm
    ? Object.values(game.actors || {}).filter((a) => !a.retired).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, getLang(), { numeric: true }) : a.type === 'pc' ? -1 : 1))
    : myActors;
  const [rollActorId, setRollActorId] = useState(gm ? '' : myActors[0]?.id || '');
  const effectiveRollActor = actorOptions.some((a) => a.id === rollActorId) ? rollActorId : gm ? '' : myActors[0]?.id || '';

  const entries = log.filter((e) => (filter === 'rolls' ? e.kind === 'roll' : filter === 'chat' ? e.kind === 'chat' || e.kind === 'whisper' : true));
  const lastId = entries.length ? entries[entries.length - 1].id : '';

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filter]);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      setUnread(0);
    } else setUnread((u) => u + 1);
  }, [lastId]);
  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (atBottom.current && unread) setUnread(0);
  };
  const toBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnread(0);
  };

  const users = Object.values(game.users || {}).filter((u) => u.id !== game.me.id);
  const whisperOptions = [{ value: '', label: t('Tout le monde') }, ...(gm ? [] : [{ value: 'gm', label: t('MJ (chuchoter)') }]), ...users.map((u) => ({ value: u.id, label: `→ ${userLabel(game, u.id)}` }))];
  const speakerOptions = gm
    ? [{ value: '', label: t('MJ') }, ...Object.values(game.actors || {}).filter((a) => !a.retired).map((a) => ({ value: a.id, label: a.name }))]
    : myActors.length > 1
      ? myActors.map((a) => ({ value: a.id, label: a.name }))
      : [];

  const findTarget = (name) => {
    const n = name.toLowerCase();
    if (['mj', 'gm', 'meneur'].includes(n)) return 'gm';
    const u = users.find((x) => x.name.toLowerCase() === n) || users.find((x) => x.name.toLowerCase().startsWith(n));
    if (u) return u.id;
    const byChar = users.find((x) => (x.characterIds || []).some((id) => game.actors?.[id]?.name?.toLowerCase().startsWith(n)));
    return byChar ? byChar.id : null;
  };

  const submit = async () => {
    const msg = text.trim();
    if (!msg) return;
    try {
      if (/^\/(aide|help|\?)$/i.test(msg)) {
        toast(helpText(), 'info', 8000);
      } else if (/^\/r(oll)?\b/i.test(msg)) {
        const tokens = msg.replace(/^\/r(oll)?/i, '').trim().split(/\s+/).filter(Boolean);
        let pool = null;
        let limit = null;
        let explode = false;
        const label = [];
        for (const tok of tokens) {
          if (pool === null && /^\d+$/.test(tok)) pool = Number(tok);
          else if (/^(l|lim|limite)?\[?(\d+)\]?$/i.test(tok) && /^(l|lim|limite|\[)/i.test(tok)) limit = Number(tok.match(/\d+/)[0]);
          else if (tok === '!' || /^(chance|edge)$/i.test(tok)) explode = true;
          else label.push(tok);
        }
        if (!pool) return toast(t('Indique un nombre de dés : /r 12'), 'warn');
        const actorId = effectiveRollActor || undefined;
        if (explode && !actorId) return toast(t('Choisis un personnage pour utiliser la Chance'), 'warn');
        await send('dice/roll', { pool, limit, explode, actorId, label: label.join(' ') || `${pool} dé${pool > 1 ? 's' : ''}` }); // stored French label, shown with rollLabel()
      } else if (/^\/(w|whisper|chuchote)\s+/i.test(msg)) {
        const m = msg.match(/^\/\w+\s+(\S+)\s+([\s\S]+)$/);
        if (!m) return toast(t('Format : /w nom message'), 'warn');
        const target = findTarget(m[1]);
        if (!target) return toast(t('Personne ne s’appelle « {name} »', { name: m[1] }), 'warn');
        await send('chat/send', { text: m[2], to: [target], as: as || undefined });
      } else if (msg.startsWith('/')) {
        return toast(t('Commande inconnue. {help}', { help: helpText() }), 'warn', 6000);
      } else {
        await send('chat/send', { text: msg, to: to ? [to] : undefined, as: as || undefined });
      }
      setText('');
      toBottom();
    } catch {
      /* toast shown by send() */
    }
  };

  const setF = (f) => {
    setFilter(f);
    savePrefs({ ...loadPrefs(), filter: f });
  };
  const toggleRoller = () => {
    setShowRoller(!showRoller);
    savePrefs({ ...loadPrefs(), roller: !showRoller });
  };
  const clearAll = async () => {
    if (await confirmAction(t('Vider tout le journal pour tout le monde ?'))) send('log/clear').catch(() => {});
  };

  return html`<div class="ld">
    <div class="ld-bar">
      ${[['all', tk('Tout')], ['rolls', tk('Jets')], ['chat', tk('Messages')]].map(([id, l]) => html`<button type="button" class=${'ld-filter' + (filter === id ? ' on' : '')} onClick=${() => setF(id)}>${t(l)}</button>`)}
      <span class="grow"></span>
      <${Dice3dPicker} />
      ${gm && html`<${IconButton} icon="⌫" title=${t('Vider le journal')} onClick=${clearAll} />`}
    </div>
    <div class="ld-listwrap">
      <div class="ld-list" ref=${listRef} onScroll=${onScroll}>
        ${entries.length ? entries.map((e) => html`<${LogEntry} key=${e.id} e=${e} game=${game} gm=${gm} />`) : html`<div class="empty">${t('Le journal est vide. Lance les dés ou écris un message.')}</div>`}
      </div>
      ${unread > 0 && html`<button type="button" class="ld-unread" onClick=${toBottom}>${tn(unread, '{n} nouveau ↓', '{n} nouveaux ↓')}</button>`}
    </div>

    <div class="ld-composer">
      <button type="button" class="ld-roller-toggle" onClick=${toggleRoller}>${showRoller ? '▾' : '▸'} ${t('Lanceur de dés')}</button>
      ${showRoller && html`<${DiceRoller} game=${game} gm=${gm} actorId=${effectiveRollActor} setActorId=${setRollActorId} actorOptions=${actorOptions} />`}
      <div class="row ld-chat-opts">
        <select class="input" value=${to} onChange=${(e) => setTo(e.target.value)} title=${t('Destinataire')}>
          ${whisperOptions.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
        </select>
        ${speakerOptions.length > 0 && html`<select class="input" value=${as} onChange=${(e) => setAs(e.target.value)} title=${t('Parler en tant que')}>
          ${speakerOptions.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
        </select>`}
      </div>
      <form class="row ld-input" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
        <input class=${'input' + (to ? ' whisper' : '')} value=${text} maxLength=${2000} placeholder=${to ? t('Message privé…') : t('Message, /r 12, /w nom…')}
          onInput=${(e) => setText(e.target.value)} />
        <${Button} variant="primary" type="submit" disabled=${!text.trim()}>➤</${Button}>
      </form>
    </div>
  </div>`;
}
