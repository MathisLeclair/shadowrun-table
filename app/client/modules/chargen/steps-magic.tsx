// Wizard step: Magie / Résonance (type, tradition, free skills, spells, adept powers, complex forms).
import { Field, Select, TextInput, NumberInput, Badge, Panel, IconButton } from '../../lib/ui.tsx';
import { SKILLS } from '/shared/sr5.ts';
import { t, tk, getLang, skillLabel, skillGroupLabel, itemName } from '../../lib/i18n.ts';
import { powerInfo, SPELL_CATEGORIES } from '/shared/advancement.ts';
import { MAGIC_TYPES, ASPECTS, TRADITIONS, COMPLEX_FORMS, magicOptions, magicOptionParts, aspectGroup, rowId, type MagicOption } from '/shared/chargen.ts';
import { Budget, StepIssues, i18n } from './common.tsx';
import Picker from './Picker.tsx';
import { complexFormRef } from '/shared/bookrefs.ts';
import type { DraftData, MagicType } from '../../../shared/types.ts';
import type { ChargenResult, DraftUpdate, LooseCatalogItem, RulesCtx, StepProps } from './types.ts';
import { ItemRef, BookRef } from '../books/BookRef.tsx';

/** Spell categories: French label from the catalog table, official English category (the key) in English. */
const spellCats = () => (Object.entries(SPELL_CATEGORIES) as Array<[string, string]>).map(([value, label]) => ({ value, label: getLang() === 'fr' ? label : value }));
/** Spell category of a catalog item (or a spellInfo() row) in the UI language. */
const spellCat = (item: LooseCatalogItem | null | undefined, fallback?: string): string =>
  getLang() === 'fr' ? (fallback ?? (item?.categoryFr || item?.category || '')) : item?.category || fallback || '';
const TYPE_TEXT: Record<MagicType, string> = {
  none: tk('No magic or resonance: all the potential goes into body, skills and gear (cyberware costs nothing extra).'),
  magician: tk('Casts spells, summons spirits, perceives the astral plane. The tradition sets Drain and spirits.'),
  mystic: tk('Both magician and adept: buys power points with karma (5 karma per point, Magic maximum).'),
  adept: tk('Channels magic through the body: power points equal to Magic, no spells.'),
  aspected: tk('Magician limited to a single group: Sorcery, Conjuring or Enchanting.'),
  technomancer: tk('Resonance: the Matrix without a device, complex forms and sprites.'),
};

/** Free skills of the magic priority row: { n, rating, cat }. */
type FreeSkillCfg = { n: number; rating: number; cat: string };

export function StepMagic({ data, update, result, issues, rc }: StepProps) {
  const letter = data.priorities.magic;
  const opts: MagicOption[] = letter ? magicOptions(letter) : [{ type: 'none' }];
  const m = data.magic;
  const r = result;
  const mrow = r.magic.row;
  const setType = (type: MagicType) =>
    update((d) => {
      d.magic.type = type;
      d.magic.freeSkills = [];
      d.magic.freeGroup = type === 'aspected' ? aspectGroup(d.magic.aspect) : '';
      if (type !== 'magician' && type !== 'mystic' && type !== 'aspected') d.spells = [];
      if (type !== 'adept' && type !== 'mystic') d.powers = [];
      if (type !== 'technomancer') d.complexForms = [];
      if (type !== 'mystic') d.magic.ppKarma = 0;
      if (type === 'none' || type === 'technomancer') d.attributes.MAG = d.attrKarma.MAG = 0;
      if (type !== 'technomancer') d.attributes.RES = d.attrKarma.RES = 0;
    });

  return (
    <div className="cg-step">
      {!letter && <div className="cg-note warn">{t('Assign a priority to the Magic / Resonance column first.')}</div>}
      <div className="cg-magic-types">
        {opts.map((o) => (
          <div key={o.type} className={'card clickable cg-mtype' + (m.type === o.type ? ' on' : '')} onClick={() => setType(o.type)}>
            <h4>{t(MAGIC_TYPES[o.type].label)}</h4>
            <div className="small">{o.type === 'none' ? t('No supernatural ability') : magicOptionParts(o, i18n())}</div>
            <div className="small muted">{t(TYPE_TEXT[o.type])}</div>
          </div>
        ))}
      </div>
      {m.type !== 'none' && !opts.some((o) => o.type === m.type) && (
        <div className="cg-note err">{t('{type} is not offered at priority {letter}: pick another option.', { type: { t: MAGIC_TYPES[m.type].label }, letter: letter || '?' })}</div>
      )}

      {m.type !== 'none' && (
        <div className="grid-3 cg-mt">
          {(m.type === 'magician' || m.type === 'mystic' || m.type === 'aspected') && (
            <Field label={t('Tradition')}>
              <Select value={m.tradition} onChange={(v) => update((d) => (d.magic.tradition = v))} options={[{ value: '', label: t('— Choose —') }, ...(TRADITIONS as string[]).map((x) => ({ value: x, label: t(x) }))]} />
            </Field>
          )}
          {m.type === 'aspected' && (
            <Field label={t('Aspect')}>
              <Select
                value={m.aspect}
                onChange={(v) =>
                  update((d) => {
                    d.magic.aspect = v;
                    d.magic.freeGroup = v;
                    d.groups = d.groups.filter((g) => !(ASPECTS as Record<string, string>)[g.id] || g.id === v);
                  })
                }
                options={(Object.entries(ASPECTS) as Array<[DraftData['magic']['aspect'], string]>).map(([value, label]) => ({ value, label: t(label) }))}
              />
            </Field>
          )}
          {m.type !== 'technomancer' && (
            <Field label={t('Mentor spirit (optional)')}>
              <TextInput live value={m.mentor} placeholder={t('e.g. Cat, Wise Dragon…')} onChange={(v) => update((d) => (d.magic.mentor = v))} />
            </Field>
          )}
          {m.type === 'mystic' && (
            <Field label={t('Power points bought')} hint={t('5 karma per point, Magic maximum')}>
              <NumberInput value={m.ppKarma} min={0} max={Math.max(0, r.magic.effMAG)} onChange={(v) => update((d) => (d.magic.ppKarma = v))} />
            </Field>
          )}
        </div>
      )}

      {mrow?.skills && <FreeSkills data={data} update={update} cfg={mrow.skills} />}
      {mrow?.group && (
        <div className="cg-note">
          {t('Free group at rating {r}:', { r: mrow.group.rating })} <strong>{skillGroupLabel(aspectGroup(m.aspect))}</strong> {t('(that of your aspect).')}
        </div>
      )}

      {r.magic.canCast && <Spells data={data} update={update} result={r} rc={rc} />}
      {r.magic.hasPowers && <Powers data={data} update={update} result={r} rc={rc} />}
      {r.magic.emerged && <Forms data={data} update={update} result={r} />}
      <StepIssues issues={issues} />
    </div>
  );
}

function FreeSkills({ data, update, cfg }: { data: DraftData; update: DraftUpdate; cfg: FreeSkillCfg }) {
  const allowed = SKILLS.filter((s) => (cfg.cat === 'active' ? s.cat !== 'magic' && s.cat !== 'resonance' : s.cat === cfg.cat));
  const slots = Array.from({ length: cfg.n }, (_, i) => data.magic.freeSkills[i] || '');
  const set = (i: number, v: string) =>
    update((d) => {
      const arr = Array.from({ length: cfg.n }, (_, j) => d.magic.freeSkills[j] || '');
      arr[i] = v;
      d.magic.freeSkills = arr.filter(Boolean);
    });
  return (
    <Panel title={cfg.n > 1 ? t('Free skills (rating {r})', { r: cfg.rating }) : t('Free skill (rating {r})', { r: cfg.rating })} className="cg-mt">
      <div className="row wrap">
        {slots.map((v, i) => (
          <Select
            key={i}
            className="cg-free-skill"
            value={v}
            onChange={(x) => set(i, x)}
            options={[
              { value: '', label: t('— Choose —') },
              ...allowed.map((s) => ({ value: s.id, label: slots.includes(s.id) && s.id !== v ? t('{skill} (already chosen)', { skill: skillLabel(s) }) : skillLabel(s) })),
            ]}
          />
        ))}
      </div>
      <div className="small muted" style={{ marginTop: '6px' }}>
        {t('They show up in the Skills step at that rating; you can still raise them with points.')}
      </div>
    </Panel>
  );
}

interface SubProps {
  data: DraftData;
  update: DraftUpdate;
  result: ChargenResult;
  rc: RulesCtx;
}

/** compute() spell row. */
interface SpellState {
  catalogId: string;
  name: string;
  item: LooseCatalogItem | null;
  category: string;
  type: string;
  range: string;
  duration: string;
  drain: string;
}

function Spells({ data, update, result, rc }: SubProps) {
  const r = result;
  const selected = new Set(data.spells.map((s) => s.catalogId));
  const max = r.magic.effMAG * 2;
  const free = r.budgets.freeSpells;
  return (
    <Panel
      title={t('Spells')}
      className="cg-mt"
      actions={
        <Badge color={r.spent.spells > max ? 'red' : 'cyan'}>
          {t('{n} / {free} free', { n: r.spent.spells, free })}
          {r.spent.spells > free ? ` · +${(r.spent.spells - free) * 5} K` : ''}
        </Badge>
      }
    >
      <div className="small muted">
        {free ? t('{n} free spells, then 5 karma per spell.', { n: free }) : t('5 karma per spell.')} {t('Maximum Magic × 2 = {max}.', { max })}
      </div>
      {data.spells.length > 0 && (
        <div className="cg-chips">
          {(r.spells as SpellState[]).map((s) => (
            <span key={s.catalogId} className="cg-chip">
              {s.item ? itemName(s.item) : s.name} <ItemRef item={s.item} />{' '}
              <i>
                {spellCat(s.item, s.category)} · {s.type} · {s.range} · {s.duration} · {t('Drain {dv}', { dv: s.drain })}
              </i>
              <IconButton icon="✕" title={t('Remove')} onClick={() => update((d) => (d.spells = d.spells.filter((x) => x.catalogId !== s.catalogId)))} />
            </span>
          ))}
        </div>
      )}
      <Picker
        items={rc.spells}
        name={itemName}
        placeholder={t('Search a spell…')}
        meta={(it) => `${spellCat(it)} · ${it.stats?.type || ''} · ${it.stats?.range || ''} · ${it.stats?.duration || ''} · ${t('Drain {dv}', { dv: it.stats?.dv || '?' })}`}
        categories={spellCats()}
        category={(it) => it.category}
        selected={selected}
        disabled={() => (data.spells.length >= max ? t('Maximum {max} spells', { max }) : null)}
        onAdd={(it) => update((d) => d.spells.push({ id: rowId('s'), catalogId: it.id, name: it.nameFr || it.name }))}
      />
    </Panel>
  );
}

/** compute() power row. */
interface PowerState {
  catalogId: string;
  name: string;
  item: LooseCatalogItem | null;
  pp: number;
}

function Powers({ data, update, result, rc }: SubProps) {
  const r = result;
  const selected = new Set(data.powers.map((p) => p.catalogId));
  return (
    <Panel title={t('Adept Powers')} className="cg-mt" actions={<Budget label={t('Power Points')} used={r.spent.powerPoints} total={r.budgets.powerPoints} />}>
      {r.powers.length > 0 && (
        <table className="sr cg-mb">
          <tbody>
            {(r.powers as PowerState[]).map((p) => {
              const info = powerInfo(p.item);
              const row = data.powers.find((x) => x.catalogId === p.catalogId);
              return (
                <tr key={p.catalogId}>
                  <td>
                    <strong>{p.item ? itemName(p.item) : p.name}</strong> <ItemRef item={p.item} />
                    {info.extraPP ? (
                      <>
                        {' '}
                        <span className="faint small">{t('(+{pp} PP at level 1)', { pp: info.extraPP })}</span>
                      </>
                    ) : (
                      ''
                    )}
                  </td>
                  <td>
                    {info.levels ? (
                      <span className="row gap-s">
                        <span className="small muted">{t('Level')}</span>
                        <NumberInput
                          small
                          value={row?.level || 1}
                          min={1}
                          max={Math.min(info.maxLevel || 12, Math.max(1, r.magic.effMAG))}
                          onChange={(v) =>
                            update((d) => {
                              const x = d.powers.find((y) => y.catalogId === p.catalogId);
                              if (x) x.level = v;
                            })
                          }
                        />
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                  <td>
                    <TextInput
                      live
                      value={row?.choice || ''}
                      placeholder={t('Detail (skill, attribute…)')}
                      onChange={(v) =>
                        update((d) => {
                          const x = d.powers.find((y) => y.catalogId === p.catalogId);
                          if (x) x.choice = v;
                        })
                      }
                    />
                  </td>
                  <td className="num-cell">{p.pp} PP</td>
                  <td>
                    <IconButton icon="✕" title={t('Remove')} onClick={() => update((d) => (d.powers = d.powers.filter((x) => x.catalogId !== p.catalogId)))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Picker
        items={rc.powers}
        name={itemName}
        placeholder={t('Search a power…')}
        meta={(it) => {
          const i = powerInfo(it);
          return `${i.levels ? t('{pp} PP per level', { pp: i.pp }) : t('{pp} PP', { pp: i.pp })}${i.maxLevel ? ` ${t('(max {n})', { n: i.maxLevel })}` : ''}`;
        }}
        selected={selected}
        onAdd={(it) => update((d) => d.powers.push({ id: rowId('p'), catalogId: it.id, name: it.nameFr || it.name, level: 1, choice: '' }))}
      />
    </Panel>
  );
}

/** shared/chargen.js COMPLEX_FORMS entry. */
interface ComplexFormDef {
  id: string;
  name: string;
  en: string;
  target: string;
  duration: string;
  fading: string;
}

function Forms({ data, update, result }: Omit<SubProps, 'rc'>) {
  const r = result;
  const chosen = new Set(data.complexForms.map((f) => f.formId));
  const toggle = (id: string) =>
    update((d) => {
      if (chosen.has(id)) d.complexForms = d.complexForms.filter((f) => f.formId !== id);
      else d.complexForms.push({ id: rowId('f'), formId: id });
    });
  return (
    <Panel
      title={t('Complex Forms')}
      className="cg-mt"
      actions={
        <Badge color="cyan">
          {t('fem::{n} / {free} free', { n: r.spent.forms, free: r.budgets.freeForms })}
          {r.spent.forms > r.budgets.freeForms ? ` · +${(r.spent.forms - r.budgets.freeForms) * 4} K` : ''}
        </Badge>
      }
    >
      <div className="small muted cg-mb">{t('{n} free, then 4 karma each. Logic maximum ({max}).', { n: r.budgets.freeForms, max: (r.final as Record<string, number>).LOG })}</div>
      <div className="cg-forms">
        {(COMPLEX_FORMS as ComplexFormDef[]).map((f) => (
          <label key={f.id} className={'cg-form' + (chosen.has(f.id) ? ' on' : '')}>
            <input type="checkbox" checked={chosen.has(f.id)} onChange={() => toggle(f.id)} />
            <span className="grow">
              <strong>{getLang() === 'fr' ? f.name : f.en}</strong> <FormRef f={f} />
              <span className="small muted">
                {' '}
                · {t(f.target)} · {t('duration {d}', { d: f.duration })} · {t('fading {f}', { f: f.fading })}
              </span>
            </span>
          </label>
        ))}
      </div>
    </Panel>
  );
}

/** 📖 SR5 page of a core complex form (shared/bookrefs.js COMPLEX_FORM_PAGES). */
function FormRef({ f }: { f: ComplexFormDef }) {
  const r = complexFormRef(f);
  return r ? <BookRef source={r.source} page={r.page} /> : null;
}
