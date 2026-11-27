// Wizard step: Équipement & cyberware (shop catalog, resources budget, availability ≤ 12, Essence, lifestyle).
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Select, NumberInput, Panel, IconButton, Toggle, SearchBox, Empty, Field, Stat, Badge } from '../../lib/ui.tsx';
import { STORE_SECTIONS, quote, allowedGrades, GRADES, clampRating, fold, targetList, upgradeAvail, MOUNT_LABELS, armorCapacity, type Quote } from '../shop/rules.ts';
import { statRows } from '../shop/ItemDetail.tsx';
import { CREATION_GRADES, CREATION_UPGRADES, LIMITS, rowId, type GearLine } from '/shared/chargen.ts';
import { t, itemName, compare, fmtNumber } from '../../lib/i18n.ts';
import { Budget, StepIssues, nuyen } from './common.tsx';
import type { ArmorStats, DraftData } from '../../../shared/types.ts';
import type { LooseCatalogItem, ShopEntry, StepProps } from './types.ts';
import { AvailBadge } from '../shop/common.tsx';
import { ItemRef } from '../books/BookRef.tsx';

/** shop/rules.js STORE_SECTIONS entry. */
type StoreSection = { id: string; label: string; icon: string; match: (file: string, item: LooseCatalogItem) => boolean };
type GearLineInput = Omit<DraftData['gear'][number], 'id'>;

/** Lookup tables of shop/rules.js and shared/chargen.js, indexed by any id. */
const GRADE_DEFS = GRADES as Record<string, { label: string }>;
const MOUNTS = MOUNT_LABELS as Record<string, string>;
const UPGRADES = CREATION_UPGRADES as Record<string, { file: string; list: string; sub: string }>;

// Creation sections: the shop's, with weapon accessories and armor mods (installed on a weapon / armor of the draft).
const GEAR_SECTIONS: StoreSection[] = (STORE_SECTIONS as StoreSection[]).filter((s) => !['lifestyles', 'vehiclemods', 'martialarts'].includes(s.id));
const PAGE = 40;
const memo = { section: 'weapons', category: '', q: '', availOk: true };

export function StepGear({ data, update, result, issues, rc }: StepProps) {
  const r = result;
  const shop = rc.shop;
  const [section, setSection] = useState(memo.section);
  const [category, setCategory] = useState(memo.category);
  const [q, setQ] = useState(memo.q);
  const [availOk, setAvailOk] = useState(memo.availOk);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string | null>(null);
  Object.assign(memo, { section, category, q, availOk });

  const sec = GEAR_SECTIONS.find((s) => s.id === section) || GEAR_SECTIONS[0];
  const inSection = useMemo(() => (shop ? shop.entries.filter((e) => sec.match(e.file, e.item)) : []), [shop, section]);
  const categories = useMemo(() => [...new Set(inSection.map((e) => e.category))].sort(compare), [inSection]);
  const list = useMemo(() => {
    const words = fold(q.trim()).split(/\s+/).filter(Boolean);
    return inSection
      .filter((e) => (!category || e.category === category) && words.every((w: string) => e.search.includes(w)))
      .map((e) => {
        let qt: Quote | null = null;
        try {
          qt = quote(e.item, {});
        } catch {}
        return { e, qt };
      })
      .filter((x): x is { e: ShopEntry; qt: Quote } => !!x.qt && (!availOk || x.qt.availValue <= LIMITS.maxAvail))
      .sort((a, b) => compare(a.e.name, b.e.name));
  }, [inSection, category, q, availOk]);
  const shown = list.slice(0, PAGE * page);
  const lifestyles = useMemo(
    () => (shop ? shop.entries.filter((e) => e.file === 'lifestyles').sort((a, b) => (a.item.cost || 0) - (b.item.cost || 0)) : []),
    [shop]
  );

  if (!shop)
    return (
      <div className="cg-step">
        <div className="cg-loading">{t('Loading the catalog…')}</div>
      </div>
    );

  const setLine = (id: string, k: 'qty', v: number) =>
    update((d) => {
      const x = d.gear.find((y) => y.id === id);
      if (x) x[k] = v;
    });
  const gearLines = r.gearLines;
  const selEntry = sel ? shop.byId.get(sel) : undefined;

  return (
    <div className="cg-step">
      <div className="row wrap cg-budget-row">
        <Budget label={t('Nuyen')} used={r.nuyen.spent} total={r.nuyen.total} format={nuyen} title={t('Resources + converted karma')} />
        <div className={'cg-budget ' + (r.essence <= 0 ? 'over' : r.essence < 6 ? 'left' : 'ok')}>
          <span className="cg-budget-label">{t('Essence')}</span>
          <span className="cg-budget-value">{fmtNumber(r.essence)}</span>
        </div>
        <div className="cg-budget left" title={t('What is left after creation (5,000¥ maximum)')}>
          <span className="cg-budget-label">{t('pl::Kept')}</span>
          <span className="cg-budget-value">{nuyen(r.nuyen.kept)}</span>
        </div>
      </div>
      <div className="cg-gear">
        <div className="cg-gear-browser">
          <div className="row wrap gap-s">
            <Select
              className="cg-gear-section"
              value={section}
              onChange={(v) => {
                setSection(v);
                setCategory('');
                setPage(1);
                setSel(null);
              }}
              options={GEAR_SECTIONS.map((s) => ({ value: s.id, label: `${s.icon} ${t(s.label)}` }))}
            />
            <Select
              className="cg-gear-cat"
              value={category}
              onChange={(v) => {
                setCategory(v);
                setPage(1);
              }}
              options={[{ value: '', label: t('All categories') }, ...categories]}
            />
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t('Search…')}
            />
            <Toggle value={availOk} onChange={setAvailOk} label={t('Avail ≤ 12')} title={t('Hide what is not available at creation')} />
          </div>
          <div className="cg-gear-list">
            <table className="sr">
              <thead>
                <tr>
                  <th>{t('Item')}</th>
                  <th>{t('Category')}</th>
                  <th>{t('Avail.')}</th>
                  <th className="right">{t('Price')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ e, qt }) => (
                  <tr key={e.ref} className={'cg-gear-row' + (sel === e.ref ? ' sel' : '')} onClick={() => setSel(e.ref)}>
                    <td>
                      <strong>{e.name}</strong> <ItemRef item={e.item} />
                      {e.item.rating ? (
                        <>
                          {' '}
                          <span className="faint small">{t('rtg {min}–{max}', { min: e.item.rating.min, max: e.item.rating.max })}</span>
                        </>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="small muted">{e.category}</td>
                    <td>
                      <AvailBadge avail={qt.avail} value={qt.availValue} legality={qt.legality} max={LIMITS.maxAvail} />
                    </td>
                    <td className="num-cell">{e.item.costRange ? t('variable') : nuyen(qt.unitCost)}</td>
                  </tr>
                ))}
                {!list.length && (
                  <tr>
                    <td colSpan={4}>
                      <Empty>{t('Nothing matches.')}</Empty>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {shown.length < list.length && (
              <div className="center cg-pad">
                <Button small variant="ghost" onClick={() => setPage(page + 1)}>
                  {t('Show more ({n})', { n: list.length - shown.length })}
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="cg-gear-side">
          {sel && selEntry && (
            <GearDetail key={sel} entry={selEntry} essence={r.essence} lines={gearLines} onClose={() => setSel(null)} onAdd={(line) => update((d) => d.gear.push({ id: rowId('g'), ...line }))} />
          )}
          <Panel title={t('Purchases ({n})', { n: data.gear.length })} pad={false}>
            <table className="sr cg-cart">
              <tbody>
                {gearLines.map((l) => {
                  const row = l.row;
                  return (
                    <tr key={row.id}>
                      <td>
                        <strong>{l.item ? itemName(l.item) : l.name}</strong> <ItemRef item={l.item} />
                        <div className="small muted">
                          {[
                            l.quote?.rating ? t('rtg {n}', { n: l.quote.rating }) : '',
                            l.quote?.grade && l.quote.grade !== 'standard' && GRADE_DEFS[l.quote.grade] ? t(GRADE_DEFS[l.quote.grade].label) : '',
                            l.essence ? t('ess. {n}', { n: fmtNumber(l.essence) }) : '',
                            l.quote ? l.quote.avail : '',
                            l.target ? t('on {target}', { target: l.target.name }) : '',
                            l.mount && MOUNTS[l.mount] ? t(MOUNTS[l.mount]) : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>
                      <td>{l.file === 'cyberware' || l.file === 'bioware' || l.upgrade ? '' : <NumberInput small value={row.qty} min={1} max={99} onChange={(v) => setLine(row.id, 'qty', v)} />}</td>
                      <td className="num-cell">{l.total !== undefined ? nuyen(l.total) : '—'}</td>
                      <td>
                        <IconButton icon="✕" title={t('Remove')} onClick={() => update((d) => (d.gear = d.gear.filter((x) => x.id !== row.id)))} />
                      </td>
                    </tr>
                  );
                })}
                {!gearLines.length && (
                  <tr>
                    <td colSpan={4} className="muted center">
                      {t('Click an item on the left to add it.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
          <Panel title={t('Lifestyle & finances')} className="cg-mt">
            <div className="col">
              <Field
                label={t('Lifestyle')}
                hint={
                  r.lifestyle
                    ? data.metatype === 'Nain'
                      ? t('{nuyen} / month (dwarf +20%)', { nuyen: nuyen(r.lifestyle.monthly) })
                      : data.metatype === 'Troll'
                        ? t('{nuyen} / month (troll +100%)', { nuyen: nuyen(r.lifestyle.monthly) })
                        : t('{nuyen} / month', { nuyen: nuyen(r.lifestyle.monthly) })
                    : t('At least one month paid at creation')
                }
              >
                <Select
                  value={data.lifestyle?.catalogId || ''}
                  onChange={(v) => update((d) => (d.lifestyle = v ? { catalogId: v, months: d.lifestyle?.months || 1 } : null))}
                  options={[{ value: '', label: t('— Choose —') }, ...lifestyles.map((e) => ({ value: e.ref, label: t('{name} — {nuyen}/month', { name: e.name, nuyen: nuyen(e.item.cost as number) }) }))]}
                />
              </Field>
              {data.lifestyle && (
                <div className="row wrap">
                  <Field label={t('Months paid')}>
                    <NumberInput
                      value={data.lifestyle.months}
                      min={1}
                      max={12}
                      onChange={(v) =>
                        update((d) => {
                          if (d.lifestyle) d.lifestyle.months = v;
                        })
                      }
                    />
                  </Field>
                  <Field
                    label={t('Starting nuyen')}
                    hint={r.lifestyle?.dice ? t('{dice}D6 × {mult}¥, rolled by the GM on approval', { dice: r.lifestyle.dice, mult: r.lifestyle.multiplier }) : t('No roll for this lifestyle')}
                  >
                    <Toggle value={data.rollStartingNuyen} onChange={(v) => update((d) => (d.rollStartingNuyen = v))} label={t('Roll')} />
                  </Field>
                </div>
              )}
              <Field label={t('Karma converted to nuyen')} hint={t('2,000¥ per karma, {max} maximum', { max: LIMITS.karmaToNuyenMax })}>
                <NumberInput value={data.karmaToNuyen} min={0} max={LIMITS.karmaToNuyenMax} onChange={(v) => update((d) => (d.karmaToNuyen = v))} />
              </Field>
              <div className="cg-money small">
                <div className="spread row">
                  <span>{t('Resources')}</span>
                  <span className="mono">{nuyen(r.nuyen.resources)}</span>
                </div>
                {r.nuyen.fromKarma > 0 && (
                  <div className="spread row">
                    <span>{t('Converted karma')}</span>
                    <span className="mono">+{nuyen(r.nuyen.fromKarma)}</span>
                  </div>
                )}
                <div className="spread row">
                  <span>{t('Gear')}</span>
                  <span className="mono">−{nuyen(r.nuyen.gear)}</span>
                </div>
                <div className="spread row">
                  <span>{t('Lifestyle')}</span>
                  <span className="mono">−{nuyen(r.nuyen.lifestyle)}</span>
                </div>
                <div className={'spread row cg-money-total ' + (r.nuyen.left < 0 ? 'red' : '')}>
                  <span>{t('Left')}</span>
                  <span className="mono">{nuyen(r.nuyen.left)}</span>
                </div>
              </div>
            </div>
          </Panel>
        </div>
      </div>
      <StepIssues issues={issues} />
    </div>
  );
}

interface GearDetailProps {
  entry: ShopEntry;
  essence: number;
  lines?: GearLine[];
  onAdd: (line: GearLineInput) => void;
  onClose: () => void;
}
function GearDetail({ entry, essence, lines = [], onAdd, onClose }: GearDetailProps) {
  const item = entry.item;
  const ware = entry.file === 'cyberware' || entry.file === 'bioware';
  // Weapon accessory / armor mod: installed on a weapon / armor already in the cart (price and fit depend on it).
  const up = UPGRADES[entry.file] || null;
  const targets = up ? lines.filter((l) => !l.upgrade && l.file === up.file && l.item && l.quote && targetList(l.file, l.item) === up.list) : [];
  const [targetRow, setTargetRow] = useState(targets[0]?.row.id || '');
  const [mount, setMount] = useState('');
  const tl = targets.find((l) => l.row.id === targetRow) || null;
  const grades: string[] = ware ? allowedGrades(item).filter((g) => (CREATION_GRADES as string[]).includes(g)) : [];
  const [rating, setRating] = useState<number | null>(item.rating ? item.rating.min : null);
  const [grade, setGrade] = useState<string | null>(ware ? (grades.includes('standard') ? 'standard' : grades[0] || 'standard') : null);
  const [qty, setQty] = useState(1);
  let qt: Quote | null = null;
  try {
    if (!up) qt = quote(item, { rating, grade: grade || undefined });
    else if (tl && tl.item && tl.quote) {
      // The target of an armor mod is an armor row.
      const tst: Partial<ArmorStats> = (tl.item.stats as ArmorStats | undefined) || {};
      const vars = up.file === 'weapons' ? { WeaponCost: tl.quote.unitCost || 0 } : { ArmorCost: tl.quote.unitCost || 0, Capacity: armorCapacity({ capacity: tst.capacity, rating: Number(tst.armor) || 0 }, tl.item) };
      qt = upgradeAvail(quote(item, { rating, vars }), item, tl.quote);
    }
  } catch {}
  const rows: Array<[string, ReactNode]> = statRows(entry.file, item, item.stats, qt);
  const mounts: string[] = up?.file === 'weapons' && Array.isArray(item.stats?.mount) ? item.stats.mount : [];
  const over = !!qt && qt.availValue > LIMITS.maxAvail;
  const essAfter = ware && qt ? Math.round((essence - (qt.essence || 0) * qty) * 1000) / 1000 : null;
  return (
    <Panel title={entry.name} actions={<IconButton icon="✕" title={t('Close')} onClick={onClose} />} className="cg-mb">
      <div className="col">
        <div className="small muted">
          {entry.category} · {item.source} p.{item.page}
        </div>
        {rows.length > 0 && (
          <div className="cg-stats">
            {rows.map(([label, v]) => (
              <Stat key={label} label={label} value={v} />
            ))}
          </div>
        )}
        <div className="row wrap">
          {item.rating && (
            <Field label={t('Rating')}>
              <NumberInput value={rating} min={item.rating.min} max={item.rating.max} onChange={(v) => setRating(clampRating(item, v))} />
            </Field>
          )}
          {ware && (
            <Field label={t('Grade')}>
              <Select value={grade} onChange={setGrade} options={grades.map((g) => ({ value: g, label: t(GRADE_DEFS[g].label) }))} />
            </Field>
          )}
          {!ware && !up && (
            <Field label={t('Quantity')}>
              <NumberInput value={qty} min={1} max={99} onChange={setQty} />
            </Field>
          )}
          {up && (
            <Field label={up.file === 'weapons' ? t('On weapon') : t('On armor')}>
              <Select
                value={targetRow}
                onChange={setTargetRow}
                options={
                  targets.length
                    ? targets.map((l) => ({ value: l.row.id, label: itemName(l.item) }))
                    : [{ value: '', label: up.file === 'weapons' ? t('— Add a weapon first —') : t('— Add an armor first —') }]
                }
              />
            </Field>
          )}
          {mounts.length > 1 && (
            <Field label={t('Mount')}>
              <Select value={mount} onChange={setMount} options={[{ value: '', label: t('Automatic') }, ...mounts.map((m) => ({ value: m, label: MOUNTS[m] ? t(MOUNTS[m]) : m }))]} />
            </Field>
          )}
        </div>
        {qt && (
          <div className="spread row">
            <span>
              <AvailBadge avail={qt.avail} value={qt.availValue} legality={qt.legality} max={LIMITS.maxAvail} />
              {ware && (
                <>
                  {' '}
                  <Badge color={essAfter !== null && essAfter <= 0 ? 'red' : 'amber'}>{t('Essence −{cost} → {after}', { cost: fmtNumber(qt.essence), after: fmtNumber(essAfter) })}</Badge>
                </>
              )}
            </span>
            <strong className="mono amber">{item.costRange ? t('Variable price') : nuyen(qt.unitCost * qty)}</strong>
          </div>
        )}
        {over && qt && <div className="cg-note err">{t('Availability {avail}: above {max}, not allowed at creation.', { avail: qt.avail, max: LIMITS.maxAvail })}</div>}
        <Button
          variant="primary"
          disabled={!qt || over || (!!up && !tl)}
          onClick={() =>
            onAdd({
              ref: item.id,
              file: entry.file as GearLineInput['file'],
              name: item.nameFr || item.name,
              qty: ware || up ? 1 : qty,
              rating: item.rating ? rating : null,
              grade: ware ? (grade as GearLineInput['grade']) : null,
              ...(up ? { target: targetRow, ...(mount ? { mount } : {}) } : {}),
            })
          }
        >
          + {t('Add')}
        </Button>
      </div>
    </Panel>
  );
}
