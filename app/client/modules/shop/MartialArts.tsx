// « Arts martiaux » storefront section: styles (Run & Gun) and their techniques. Karma, not nuyen:
// players send a request the GM approves (karma spent then); the GM grants directly (with or without karma).
import { useMemo, useState } from 'react';
import { Button, Badge, Empty, SearchBox, Panel } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, itemName, compare } from '../../lib/i18n.ts';
import { MARTIAL_KARMA, fold, martialKarma } from './rules.ts';
import type { Actor, CatalogEntry, GameView } from '../../../shared/types.ts';
import { BookRef, RuleRef } from '../books/BookRef.tsx';

type MartialStyle = CatalogEntry<'martialarts'>;

interface MartialArtsProps {
  game: GameView;
  actor: Actor | null;
  /** null while the catalog loads. */
  styles: MartialStyle[] | null;
  wide: boolean;
}

export default function MartialArts({ game, actor, styles, wide }: MartialArtsProps) {
  const isGM = game.me.role === 'gm';
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => {
    const words = fold(search).split(/\s+/).filter(Boolean);
    return (styles || [])
      .filter((s) => !words.length || words.every((w: string) => fold(`${s.name} ${s.nameFr || ''} ${(s.stats?.techniques || []).map((x) => `${x.name} ${x.nameFr || ''}`).join(' ')}`).includes(w)))
      .sort((a, b) => compare(itemName(a), itemName(b)));
  }, [styles, search]);

  if (!styles) return <div className="shop-loading">{t('Connexion au catalogue de Cabana…')}</div>;
  const style = sel ? styles.find((s) => s.id === sel) : null;
  const known = style ? (actor?.martialArts || []).find((m) => m.catalogId === style.id) : undefined;
  const knownTech = new Set((known?.techniques || []).map((x) => x.catalogId));
  const fresh = picked.filter((id) => !knownTech.has(id));
  const karma: number = style ? martialKarma(style, known || null, fresh.length) : 0;
  const pending = !!style && (game.shop?.orders || []).some((o) => o.status === 'pending' && o.kind === 'karma' && o.actorId === actor?.id && o.items[0]?.ref === style.id);
  const nothing = !!known && !fresh.length;

  const choose = (id: string) => {
    setSel(id);
    setPicked([]);
  };
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const submit = async (free: boolean) => {
    if (!actor || !style) return;
    setBusy(true);
    try {
      const r = await send<{ status?: string; karma?: number }>('shop/martialArt', { actorId: actor.id, styleId: style.id, techniqueIds: fresh, ...(isGM ? { free: !!free } : {}) });
      if (r?.status === 'pending') toast(t('Demande envoyée au MJ ({karma} karma)', { karma: r.karma }), 'info');
      else toast(t('{style} appris par {name}', { style: itemName(style), name: actor.name }), 'success');
      setPicked([]);
    } catch {}
    setBusy(false);
  };

  return (
    <div className={'shop-martial' + (wide ? ' wide' : '')}>
      <div className="shop-martial-list">
        <div className="row wrap">
          <SearchBox value={search} onChange={setSearch} placeholder={t('Rechercher un style ou une technique…')} />
          <span className="muted small grow right">{tn(list.length, '{n} style', '{n} styles')}</span>
        </div>
        <div className="muted small">
          {t('Les arts martiaux s’achètent en karma : style {style} karma (première technique comprise), puis {tech} karma par technique. Le MJ valide.', {
            style: MARTIAL_KARMA.style,
            tech: MARTIAL_KARMA.technique,
          })}
        </div>
        {!list.length && <Empty>{t('Rien ne correspond à ta recherche.')}</Empty>}
        <div className="shop-martial-grid">
          {list.map((s) => {
            const mine = (actor?.martialArts || []).find((m) => m.catalogId === s.id);
            return (
              <button key={s.id} className={'card clickable shop-martial-card' + (sel === s.id ? ' selected' : '')} onClick={() => choose(s.id)}>
                <div className="spread row">
                  <strong>{itemName(s)}</strong>
                  {mine ? <Badge color="green">{t('Connu')}</Badge> : null}
                </div>
                <div className="faint small">
                  {tn((s.stats?.techniques || []).length, '{n} technique', '{n} techniques')} · {s.source} p.{s.page}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="shop-martial-detail">
        {!style ? (
          <Empty>{t('Sélectionne un style pour voir ses techniques.')}</Empty>
        ) : (
          <Panel title={itemName(style)}>
            <div className="col">
              {style.nameFr && style.nameFr !== style.name && <div className="muted small">{style.name}</div>}
              <div className="row gap-s">
                <BookRef source={style.source} page={style.page} />
                <RuleRef rule="martialArts" />
              </div>
              {known && actor ? <div className="small green">{t('{name} connaît ce style ({n} technique(s)).', { name: actor.name, n: known.techniques?.length || 0 })}</div> : null}
              <div className="section-title">{t('Techniques')}</div>
              <div className="shop-martial-techs">
                {(style.stats?.techniques || []).map((x, i) => {
                  const has = knownTech.has(x.id);
                  return (
                    <label key={x.id || i} className={'row gap-s small' + (has ? ' muted' : '')}>
                      <input type="checkbox" disabled={has || !x.id} checked={has || picked.includes(x.id)} onChange={() => toggle(x.id)} />
                      <span className="grow">{itemName(x)}</span>
                      {x.source ? <BookRef source={x.source} page={x.page} /> : null}
                    </label>
                  );
                })}
              </div>
              <div className="spread row">
                <span>{t('Coût')}</span>
                <strong className={'mono ' + (actor && (Number(actor.karma) || 0) < karma ? 'red' : 'violet')}>{t('{n} karma', { n: karma })}</strong>
              </div>
              {actor && <div className="small muted">{t('Karma disponible : {n}', { n: Number(actor.karma) || 0 })}</div>}
              {pending && <div className="shop-approval small">{t('Une demande pour ce style attend déjà le MJ.')}</div>}
              <div className="row wrap">
                {!isGM && (
                  <Button variant="primary" disabled={busy || !actor || nothing || pending || (Number(actor?.karma) || 0) < karma} onClick={() => submit(false)}>
                    {t('Demander au MJ')}
                  </Button>
                )}
                {isGM && (
                  <>
                    <Button variant="accent" disabled={busy || !actor || nothing || (Number(actor?.karma) || 0) < karma} onClick={() => submit(false)} title={t('Dépense le karma du PJ')}>
                      {t('Accorder ({n} karma)', { n: karma })}
                    </Button>
                    <Button disabled={busy || !actor || nothing} onClick={() => submit(true)}>
                      {t('Accorder gratuitement')}
                    </Button>
                  </>
                )}
              </div>
              {!actor && <div className="muted small">{t('Choisis un PJ en haut de la page pour vendre ou donner.')}</div>}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
