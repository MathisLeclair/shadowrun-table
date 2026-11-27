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

  if (!styles) return <div className="shop-loading">{t('Connecting to Cabana’s catalog…')}</div>;
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
      if (r?.status === 'pending') toast(t('Request sent to the GM ({karma} karma)', { karma: r.karma }), 'info');
      else toast(t('{name} learned {style}', { style: itemName(style), name: actor.name }), 'success');
      setPicked([]);
    } catch {}
    setBusy(false);
  };

  return (
    <div className={'shop-martial' + (wide ? ' wide' : '')}>
      <div className="shop-martial-list">
        <div className="row wrap">
          <SearchBox value={search} onChange={setSearch} placeholder={t('Search a style or a technique…')} />
          <span className="muted small grow right">{tn(list.length, '{n} style', '{n} styles')}</span>
        </div>
        <div className="muted small">
          {t('Martial arts cost karma: {style} karma for a style (first technique included), then {tech} karma per technique. The GM approves.', {
            style: MARTIAL_KARMA.style,
            tech: MARTIAL_KARMA.technique,
          })}
        </div>
        {!list.length && <Empty>{t('Nothing matches your search.')}</Empty>}
        <div className="shop-martial-grid">
          {list.map((s) => {
            const mine = (actor?.martialArts || []).find((m) => m.catalogId === s.id);
            return (
              <button key={s.id} className={'card clickable shop-martial-card' + (sel === s.id ? ' selected' : '')} onClick={() => choose(s.id)}>
                <div className="spread row">
                  <strong>{itemName(s)}</strong>
                  {mine ? <Badge color="green">{t('Known')}</Badge> : null}
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
          <Empty>{t('Select a style to see its techniques.')}</Empty>
        ) : (
          <Panel title={itemName(style)}>
            <div className="col">
              {style.nameFr && style.nameFr !== style.name && <div className="muted small">{style.name}</div>}
              <div className="row gap-s">
                <BookRef source={style.source} page={style.page} />
                <RuleRef rule="martialArts" />
              </div>
              {known && actor ? <div className="small green">{t('{name} knows this style ({n} technique(s)).', { name: actor.name, n: known.techniques?.length || 0 })}</div> : null}
              <div className="section-title">{t('Technical')}</div>
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
                <span>{t('Cost')}</span>
                <strong className={'mono ' + (actor && (Number(actor.karma) || 0) < karma ? 'red' : 'violet')}>{t('{n} karma', { n: karma })}</strong>
              </div>
              {actor && <div className="small muted">{t('Karma available: {n}', { n: Number(actor.karma) || 0 })}</div>}
              {pending && <div className="shop-approval small">{t('A request for this style is already waiting for the GM.')}</div>}
              <div className="row wrap">
                {!isGM && (
                  <Button variant="primary" disabled={busy || !actor || nothing || pending || (Number(actor?.karma) || 0) < karma} onClick={() => submit(false)}>
                    {t('Ask the GM')}
                  </Button>
                )}
                {isGM && (
                  <>
                    <Button variant="accent" disabled={busy || !actor || nothing || (Number(actor?.karma) || 0) < karma} onClick={() => submit(false)} title={t('Spends the character’s karma')}>
                      {t('Grant ({n} karma)', { n: karma })}
                    </Button>
                    <Button disabled={busy || !actor || nothing} onClick={() => submit(true)}>
                      {t('Grant for free')}
                    </Button>
                  </>
                )}
              </div>
              {!actor && <div className="muted small">{t('Pick a PC at the top of the page to sell or give.')}</div>}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
