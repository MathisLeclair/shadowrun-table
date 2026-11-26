// « Arts martiaux » storefront section: styles (Run & Gun) and their techniques. Karma, not nuyen:
// players send a request the GM approves (karma spent then); the GM grants directly (with or without karma).
import { useMemo, useState } from 'preact/hooks';
import { html, Button, Badge, Empty, SearchBox, Panel } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tn, itemName, compare } from '../../lib/i18n.js';
import { MARTIAL_KARMA, fold, martialKarma } from './rules.js';
import { BookRef, RuleRef } from '../books/BookRef.js';

export default function MartialArts({ game, actor, styles, wide }) {
  const isGM = game.me.role === 'gm';
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => {
    const words = fold(search).split(/\s+/).filter(Boolean);
    return (styles || [])
      .filter((s) => !words.length || words.every((w) => fold(`${s.name} ${s.nameFr || ''} ${(s.stats?.techniques || []).map((x) => `${x.name} ${x.nameFr || ''}`).join(' ')}`).includes(w)))
      .sort((a, b) => compare(itemName(a), itemName(b)));
  }, [styles, search]);

  if (!styles) return html`<div class="shop-loading">${t('Connexion au catalogue de Cabana…')}</div>`;
  const style = sel ? styles.find((s) => s.id === sel) : null;
  const known = style && (actor?.martialArts || []).find((m) => m.catalogId === style.id);
  const knownTech = new Set((known?.techniques || []).map((x) => x.catalogId));
  const fresh = picked.filter((id) => !knownTech.has(id));
  const karma = style ? martialKarma(style, known || null, fresh.length) : 0;
  const pending = style && (game.shop?.orders || []).some((o) => o.status === 'pending' && o.kind === 'karma' && o.actorId === actor?.id && o.items[0]?.ref === style.id);
  const nothing = !!known && !fresh.length;

  const choose = (id) => {
    setSel(id);
    setPicked([]);
  };
  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const submit = async (free) => {
    if (!actor || !style) return;
    setBusy(true);
    try {
      const r = await send('shop/martialArt', { actorId: actor.id, styleId: style.id, techniqueIds: fresh, ...(isGM ? { free: !!free } : {}) });
      if (r?.status === 'pending') toast(t('Demande envoyée au MJ ({karma} karma)', { karma: r.karma }), 'info');
      else toast(t('{style} appris par {name}', { style: itemName(style), name: actor.name }), 'success');
      setPicked([]);
    } catch {}
    setBusy(false);
  };

  return html`<div class=${'shop-martial' + (wide ? ' wide' : '')}>
    <div class="shop-martial-list">
      <div class="row wrap">
        <${SearchBox} value=${search} onChange=${setSearch} placeholder=${t('Rechercher un style ou une technique…')} />
        <span class="muted small grow right">${tn(list.length, '{n} style', '{n} styles')}</span>
      </div>
      <div class="muted small">${t('Les arts martiaux s’achètent en karma : style {style} karma (première technique comprise), puis {tech} karma par technique. Le MJ valide.', { style: MARTIAL_KARMA.style, tech: MARTIAL_KARMA.technique })}</div>
      ${!list.length && html`<${Empty}>${t('Rien ne correspond à ta recherche.')}</${Empty}>`}
      <div class="shop-martial-grid">
        ${list.map((s) => {
          const mine = (actor?.martialArts || []).find((m) => m.catalogId === s.id);
          return html`<button class=${'card clickable shop-martial-card' + (sel === s.id ? ' selected' : '')} onClick=${() => choose(s.id)}>
            <div class="spread row"><strong>${itemName(s)}</strong>${mine ? html`<${Badge} color="green">${t('Connu')}</${Badge}>` : null}</div>
            <div class="faint small">${tn((s.stats?.techniques || []).length, '{n} technique', '{n} techniques')} · ${s.source} p.${s.page}</div>
          </button>`;
        })}
      </div>
    </div>
    <div class="shop-martial-detail">
      ${!style
        ? html`<${Empty}>${t('Sélectionne un style pour voir ses techniques.')}</${Empty}>`
        : html`<${Panel} title=${itemName(style)}>
            <div class="col">
              ${style.nameFr && style.nameFr !== style.name && html`<div class="muted small">${style.name}</div>`}
              <div class="row gap-s"><${BookRef} source=${style.source} page=${style.page} /><${RuleRef} rule="martialArts" /></div>
              ${known ? html`<div class="small green">${t('{name} connaît ce style ({n} technique(s)).', { name: actor.name, n: known.techniques?.length || 0 })}</div>` : null}
              <div class="section-title">${t('Techniques')}</div>
              <div class="shop-martial-techs">
                ${(style.stats?.techniques || []).map((x) => {
                  const has = knownTech.has(x.id);
                  return html`<label class=${'row gap-s small' + (has ? ' muted' : '')}>
                    <input type="checkbox" disabled=${has || !x.id} checked=${has || picked.includes(x.id)} onChange=${() => toggle(x.id)} />
                    <span class="grow">${itemName(x)}</span>
                    ${x.source ? html`<${BookRef} source=${x.source} page=${x.page} />` : null}
                  </label>`;
                })}
              </div>
              <div class="spread row">
                <span>${t('Coût')}</span>
                <strong class=${'mono ' + (actor && (Number(actor.karma) || 0) < karma ? 'red' : 'violet')}>${t('{n} karma', { n: karma })}</strong>
              </div>
              ${actor && html`<div class="small muted">${t('Karma disponible : {n}', { n: Number(actor.karma) || 0 })}</div>`}
              ${pending && html`<div class="shop-approval small">${t('Une demande pour ce style attend déjà le MJ.')}</div>`}
              <div class="row wrap">
                ${!isGM &&
                html`<${Button} variant="primary" disabled=${busy || !actor || nothing || pending || (Number(actor?.karma) || 0) < karma} onClick=${() => submit(false)}>${t('Demander au MJ')}</${Button}>`}
                ${isGM &&
                html`
                  <${Button} variant="accent" disabled=${busy || !actor || nothing || (Number(actor?.karma) || 0) < karma} onClick=${() => submit(false)} title=${t('Dépense le karma du PJ')}>${t('Accorder ({n} karma)', { n: karma })}</${Button}>
                  <${Button} disabled=${busy || !actor || nothing} onClick=${() => submit(true)}>${t('Accorder gratuitement')}</${Button}>
                `}
              </div>
              ${!actor && html`<div class="muted small">${t('Choisis un PJ en haut de la page pour vendre ou donner.')}</div>`}
            </div>
          </${Panel}>`}
    </div>
  </div>`;
}
