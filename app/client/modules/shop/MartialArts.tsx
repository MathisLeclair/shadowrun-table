// « Arts martiaux » storefront section: styles (Run & Gun) and their techniques. Karma, not nuyen: learning one is a
// 'martialArt' training request (training/request, shared/advancement.ts: time, instructor and GM approval like any
// advance, RG p.128). The GM can also grant a style or technique for free at once (shop/martialArt).
import { useMemo, useState } from 'react';
import { Button, Badge, Empty, SearchBox, Panel } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, itemName, compare, fmtNuyen } from '../../lib/i18n.ts';
import { fold } from './rules.ts';
import { MARTIAL_RULES } from '/shared/advancement.ts';
import { makeQuoter, settingsOf, requestsOf, jobsOf, labelOf, errorOf, fmtDays, StatusBadge } from '../training/common.tsx';
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
  const [instructor, setInstructor] = useState(false);
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
  const settings = settingsOf(game);
  const techniques = style ? (style.stats?.techniques || []).filter((x) => fresh.includes(x.id)).map((x) => ({ id: x.id, name: x.name, ...(x.nameFr ? { nameFr: x.nameFr } : {}) })) : [];
  const draft = style
    ? { kind: 'martialArt' as const, catalogId: style.id, name: itemName(style), altName: style.name, karma: Number(style.stats?.karma) || MARTIAL_RULES.styleKarma, techniques, instructor: settings.useTime && instructor }
    : null;
  const qt = actor && draft ? makeQuoter(game, actor)(draft) : null;
  const karma = qt?.karmaCost ?? 0;
  // Training asked for / in progress for this style (one at a time per style); pending shop orders of older saves too.
  const open = style && actor ? requestsOf(game, actor.id).find((r) => r.kind === 'martialArt' && r.request?.catalogId === style.id && (r.status === 'pending' || r.status === 'approved')) : undefined;
  const job = open ? jobsOf(actor).find((j) => j.requestId === open.id) : undefined;
  const legacy = !!style && (game.shop?.orders || []).some((o) => o.status === 'pending' && o.kind === 'karma' && o.actorId === actor?.id && o.items[0]?.ref === style.id);
  const nothing = !!known && !fresh.length;
  const blocked = busy || !actor || nothing || !!open || legacy;
  const err = !nothing && !open ? errorOf(qt) : null;

  const choose = (id: string) => {
    setSel(id);
    setPicked([]);
  };
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  /** Training request (players: the GM approves unless auto-approval is on; GM: starts at once). */
  const train = async () => {
    if (!actor || !style || !draft) return;
    setBusy(true);
    try {
      const r = await send<{ status?: string }>('training/request', { actorId: actor.id, ...draft });
      if (r?.status === 'pending') toast(t('Request sent to the GM ({karma} karma)', { karma }), 'info');
      else if (r?.status === 'approved') toast(t('{name} starts training: {style}', { style: itemName(style), name: actor.name }), 'success');
      else toast(t('{name} learned {style}', { style: itemName(style), name: actor.name }), 'success');
      setPicked([]);
    } catch {}
    setBusy(false);
  };
  /** GM gift: learned at once, no karma, no training time. */
  const grantFree = async () => {
    if (!actor || !style) return;
    setBusy(true);
    try {
      await send('shop/martialArt', { actorId: actor.id, styleId: style.id, techniqueIds: fresh, free: true });
      toast(t('{name} learned {style}', { style: itemName(style), name: actor.name }), 'success');
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
          {settings.useTime
            ? t('Martial arts are learned like any advance: {style} karma and {styleTime} for a style (first technique included), then {tech} karma and {techTime} per technique. The GM approves.', {
                style: MARTIAL_RULES.styleKarma,
                tech: MARTIAL_RULES.techniqueKarma,
                styleTime: fmtDays(MARTIAL_RULES.styleDays),
                techTime: fmtDays(MARTIAL_RULES.techniqueDays),
              })
            : t('Martial arts cost karma: {style} karma for a style (first technique included), then {tech} karma per technique. The GM approves.', {
                style: MARTIAL_RULES.styleKarma,
                tech: MARTIAL_RULES.techniqueKarma,
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
              {settings.useTime && (
                <label className="row gap-s small" title={t('Run & Gun p.128: 2,500¥ for a style, 1,500¥ per further technique')}>
                  <input type="checkbox" checked={instructor} onChange={(e) => setInstructor(e.target.checked)} />
                  <span className="grow">{t('With an instructor (−{pct}% time)', { pct: settings.instructorTimeReduction })}</span>
                </label>
              )}
              <div className="spread row">
                <span>{t('Cost')}</span>
                <strong className={'mono ' + (actor && (Number(actor.karma) || 0) < karma ? 'red' : 'violet')}>
                  {t('{n} karma', { n: karma })}
                  {qt?.nuyenCost ? ` · ${fmtNuyen(qt.nuyenCost)}` : ''}
                </strong>
              </div>
              {settings.useTime && qt && !nothing && (
                <div className="spread row">
                  <span>{t('Training time')}</span>
                  <strong className="mono">{fmtDays(qt.days)}</strong>
                </div>
              )}
              {actor && <div className="small muted">{t('Karma available: {n}', { n: Number(actor.karma) || 0 })}</div>}
              {open && (
                <div className="shop-approval small row gap-s">
                  <StatusBadge status={open.status} />
                  <span className="grow">{labelOf(open)}</span>
                  {job ? <span className="mono">{t('{done}/{total} d', { done: job.daysDone || 0, total: job.daysTotal })}</span> : null}
                </div>
              )}
              {legacy && <div className="shop-approval small">{t('A request for this style is already waiting for the GM.')}</div>}
              {err && <div className="small red">{err}</div>}
              <div className="row wrap">
                {!isGM && (
                  <Button variant="primary" disabled={blocked || !!err} onClick={train}>
                    {t('Ask the GM')}
                  </Button>
                )}
                {isGM && (
                  <>
                    <Button variant="accent" disabled={blocked || !!err} onClick={train} title={t('Spends the character’s karma')}>
                      {qt?.days ? t('Start training ({n} karma)', { n: karma }) : t('Grant ({n} karma)', { n: karma })}
                    </Button>
                    <Button disabled={busy || !actor || nothing} onClick={grantFree} title={t('Learned at once, no karma and no training time')}>
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
