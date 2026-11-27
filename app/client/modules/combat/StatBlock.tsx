// SR5-style stat block for a bestiary template (or any actor-shaped object).
import type { CSSProperties, ReactNode } from 'react';
import { Badge, Stat, Markdown } from '../../lib/ui.tsx';
import { t, attrShort, skillLabel, metatypeLabel, fmtNumber, getLang } from '../../lib/i18n.ts';
import { attr, SKILL_BY_ID } from '/shared/sr5.ts';
import { safeDerive, poolFor, damageText, initials, avatarStyle, signed, npcKindLabel, dispoLabel, DISPO_BADGE, initModeLabel, type Derived } from './combat-common.tsx';
import type { ActorLike } from './types.ts';
import type { ActorMatrix, AttrKey, Spell } from '../../../shared/types.ts';
import { ItemRef, SkillRef } from '../books/BookRef.tsx';

const CORE_ATTRS: AttrKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG'];

/** Skill name: French keeps the name stored on the template; English uses the official name of known SR5 skills. */
function skillName(tpl: ActorLike, id: string, stored: string | undefined): string {
  if (getLang() !== 'fr' && SKILL_BY_ID[id]) return skillLabel(id);
  return stored || SKILL_BY_ID[id]?.fr || (tpl.skills || []).find((s) => s.id === id)?.name || id || '';
}

function AttrTable({ tpl }: { tpl: ActorLike }) {
  const keys = [...CORE_ATTRS];
  if (tpl.attributes?.MAG) keys.push('MAG');
  if (tpl.attributes?.RES) keys.push('RES');
  keys.push('ESS');
  return (
    <div className="sb-attrs-wrap">
      <table className="sb-attrs">
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k}>{attrShort(k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {keys.map((k) => {
              const base = Number(tpl.attributes?.[k] ?? 0);
              if (k === 'ESS') return <td key={k}>{fmtNumber(base)}</td>;
              const eff = attr(tpl, k);
              return (
                <td key={k}>
                  {base}
                  {eff !== base ? (
                    <>
                      {' '}
                      <small>({eff})</small>
                    </>
                  ) : (
                    ''
                  )}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MatrixLine({ m }: { m: ActorMatrix | null | undefined }) {
  if (!m) return null;
  return (
    <div className="sb-sec">
      <h4>{t('Matrice')}</h4>
      <div className="sb-chips">
        {m.device && (
          <span className="sb-chip">
            {m.device}
            {m.rating ? (
              <>
                {' '}
                <i>{t('indice {n}', { n: m.rating })}</i>
              </>
            ) : (
              ''
            )}
          </span>
        )}
        <span className="sb-chip">
          {t('Attaque')}
          <b>{m.attack || 0}</b>
        </span>
        <span className="sb-chip">
          {t('Corruption')}
          <b>{m.sleaze || 0}</b>
        </span>
        <span className="sb-chip">
          {t('Traitement')}
          <b>{m.dataProcessing || 0}</b>
        </span>
        <span className="sb-chip">
          {t('Firewall')}
          <b>{m.firewall || 0}</b>
        </span>
      </div>
      {m.programs?.length > 0 && <div className="small muted">{t('Programmes : {list}', { list: m.programs.join(', ') })}</div>}
    </div>
  );
}

interface ChipsProps<T> {
  title: string;
  items: T[] | null | undefined;
  render: (item: T, index: number) => ReactNode;
}
function Chips<T>({ title, items, render }: ChipsProps<T>) {
  if (!items || !items.length) return null;
  return (
    <div className="sb-sec">
      <h4>{title}</h4>
      <div className="sb-chips">{items.map(render)}</div>
    </div>
  );
}

function WeaponsTable({ tpl, d }: { tpl: ActorLike; d: Derived | null }) {
  const ws = tpl.weapons || [];
  if (!ws.length) return null;
  return (
    <div className="sb-sec">
      <h4>{t('Armes')}</h4>
      <div className="sb-table-wrap">
        <table className="sr">
          <thead>
            <tr>
              <th>{t('Arme')}</th>
              <th title={t('Réserve de dés (compétence + attribut)')}>{t('Réserve')}</th>
              <th>{t('Préc.')}</th>
              <th>{t('VD')}</th>
              <th>{t('PA')}</th>
              <th>{t('Mode')}</th>
              <th>{t('RC')}</th>
              <th>{t('Mun.')}</th>
            </tr>
          </thead>
          <tbody>
            {ws.map((w, i) => {
              const pool = poolFor(tpl, w.skill);
              const skName = w.skill ? skillName(tpl, w.skill, '') : '';
              const acc = w.accuracy === null || w.accuracy === undefined || w.accuracy === '' ? (d ? `${d.limits.physical}*` : '—') : w.accuracy;
              return (
                <tr key={w.id || i}>
                  <td className="wname">
                    <strong>{w.name}</strong> <ItemRef item={w} />
                    {w.reach ? (
                      <>
                        {' '}
                        <span className="faint small">{t('allonge {n}', { n: w.reach })}</span>
                      </>
                    ) : (
                      ''
                    )}
                    {(skName || w.notes) && (
                      <span className="note">
                        {skName}
                        {skName && w.notes ? ' — ' : ''}
                        {w.notes || ''}
                      </span>
                    )}
                  </td>
                  <td className="pool">{pool ?? '—'}</td>
                  <td className="mono" title={typeof acc === 'string' && acc.endsWith('*') ? t('Limite physique') : ''}>
                    {acc}
                  </td>
                  <td className="mono">{damageText(w, tpl) || '—'}</td>
                  <td className="mono">{w.ap ? signed(w.ap) : '—'}</td>
                  <td className="mono">{w.mode || '—'}</td>
                  <td className="mono">{w.rc || '—'}</td>
                  <td className="mono">{w.ammo || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SpellsTable({ spells }: { spells: Spell[] | null | undefined }) {
  if (!spells?.length) return null;
  return (
    <div className="sb-sec">
      <h4>{t('Sorts')}</h4>
      <div className="sb-table-wrap">
        <table className="sr">
          <thead>
            <tr>
              <th>{t('Sort')}</th>
              <th>{t('Catégorie')}</th>
              <th>{t('Type')}</th>
              <th>{t('Portée')}</th>
              <th>{t('Durée')}</th>
              <th>{t('Drain')}</th>
            </tr>
          </thead>
          <tbody>
            {spells.map((s, i) => (
              <tr key={s.id || i}>
                <td className="wname">
                  <strong>{s.name}</strong> <ItemRef item={s} />
                  {s.notes && <span className="note">{s.notes}</span>}
                </td>
                <td>{s.category || ''}</td>
                <td className="mono">{s.type || ''}</td>
                <td className="mono">{s.range || ''}</td>
                <td className="mono">{s.duration || ''}</td>
                <td className="mono">{s.drain || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface StatBlockProps {
  /** The template (prop name kept for callers). */
  t: ActorLike;
  compact?: boolean;
}
/** Full stat block. props: { t: template (prop name kept for callers), compact? } */
export default function StatBlock({ t: tpl }: StatBlockProps) {
  const d = safeDerive(tpl);
  const kind = tpl.npc?.kind || 'metahuman';
  const nonPhysical = kind === 'host';
  const mode = tpl.npc?.initMode || 'physical';
  const initText = !d
    ? '—'
    : mode === 'hot'
      ? `${d.matrixInitiative.hot.base} + ${d.matrixInitiative.hot.dice}D6`
      : mode === 'cold'
        ? `${d.matrixInitiative.cold.base} + ${d.matrixInitiative.cold.dice}D6`
        : mode === 'astral'
          ? `${d.astralInitiative.base} + ${d.astralInitiative.dice}D6`
          : d.initiative.text;
  const armorItems = (tpl.armor || []).filter((a) => a.equipped !== false);
  const pr = tpl.npc?.professionalRating ?? 0;
  const darkRange = tpl.vision?.darkRange ?? 0;

  return (
    <article className="sb">
      <header className="sb-head" style={{ '--tc': tpl.color || 'var(--magenta)' } as CSSProperties}>
        <div className="sb-portrait" style={avatarStyle(tpl.portrait, tpl.color)}>
          {tpl.portrait ? '' : initials(tpl.name)}
        </div>
        <div className="grow">
          <h3>{tpl.name}</h3>
          <div className="sub">{[tpl.metatype && metatypeLabel(tpl.metatype), tpl.concept].filter(Boolean).join(' · ')}</div>
          <div className="row wrap gap-s" style={{ marginTop: '5px' }}>
            {pr > 0 && (
              <Badge color="amber" title={t('Indice de professionnalisme')}>
                {t('PR {n}', { n: pr })}
              </Badge>
            )}
            {tpl.npc?.grunt && (
              <Badge color="magenta" title={t('Sbire : à jouer en groupe')}>
                {t('Sbire')}
              </Badge>
            )}
            {kind !== 'metahuman' && <Badge color="cyan">{npcKindLabel(kind)}</Badge>}
            {tpl.disposition && tpl.disposition !== 'hostile' && <Badge color={DISPO_BADGE[tpl.disposition]}>{dispoLabel(tpl.disposition)}</Badge>}
            {tpl.vision?.lowLight && <Badge>{t('Vision nocturne')}</Badge>}
            {tpl.vision?.thermo && <Badge>{t('Thermographique')}</Badge>}
            {darkRange > 0 && <Badge>{t('Vision dans le noir {n} c.', { n: darkRange })}</Badge>}
          </div>
        </div>
      </header>
      <div className="sb-body">
        {!nonPhysical && kind !== 'ic' && <AttrTable tpl={tpl} />}
        {d && !nonPhysical && (
          <div className="sb-stats">
            <Stat label={mode === 'physical' ? t('Initiative') : t('Init. {mode}', { mode: initModeLabel(mode) })} value={initText} accent="cyan" />
            <Stat label={kind === 'ic' || kind === 'drone' ? t('Moniteur') : t('Physique')} value={d.physicalMonitor} accent="magenta" />
            {d.stunMonitor > 0 && <Stat label={t('Étourdis.')} value={d.stunMonitor} accent="amber" />}
            {kind !== 'ic' && (
              <>
                <Stat label={t('Armure')} value={d.armor} />
                <Stat label={t('Défense')} value={d.defense} title={t('Réaction + Intuition')} />
                <Stat label={t('Encaiss.')} value={d.soak} title={t('Constitution + Armure')} />
                <Stat label={t('Limites')} value={`${d.limits.physical}/${d.limits.mental}/${d.limits.social}`} title={t('Physique / Mentale / Sociale')} />
              </>
            )}
            {mode !== 'physical' && kind === 'metahuman' && <Stat label={t('Init. physique')} value={d.initiative.text} />}
          </div>
        )}

        <Chips
          title={t('Compétences')}
          items={tpl.skills}
          render={(s, i) => {
            const pool = poolFor(tpl, s.id);
            return (
              <span key={s.id || i} className="sb-chip" title={s.spec ? t('Spécialisation : {spec} (+2)', { spec: s.spec }) : ''}>
                {skillName(tpl, s.id, s.name)} {s.rating}
                {s.spec ? (
                  <>
                    {' '}
                    <i>({s.spec})</i>
                  </>
                ) : (
                  ''
                )}
                <b>{pool ?? '—'}</b>
                <SkillRef id={s.id} />
              </span>
            );
          }}
        />
        <WeaponsTable tpl={tpl} d={d} />
        <Chips
          title={t('Armure')}
          items={armorItems}
          render={(a, i) => (
            <span key={a.id || i} className="sb-chip" title={a.notes || ''}>
              {a.name}
              <b>
                {a.stack ? '+' : ''}
                {a.rating}
              </b>
              <ItemRef item={a} />
            </span>
          )}
        />
        <Chips
          title={t('Augmentations')}
          items={tpl.augmentations}
          render={(x, i) => (
            <span key={x.id || i} className="sb-chip" title={x.notes || ''}>
              {x.name}
              {x.grade && x.grade !== 'standard' ? (
                <>
                  {' '}
                  <i>{x.grade}</i>
                </>
              ) : (
                ''
              )}{' '}
              <i>{t('ess. {n}', { n: fmtNumber(x.essence ?? 0) })}</i>
              <ItemRef item={x} />
            </span>
          )}
        />
        <Chips
          title={t('Pouvoirs')}
          items={tpl.powers}
          render={(p, i) => (
            <span key={p.id || i} className="sb-chip" title={p.notes || ''}>
              {p.name}
              {p.level ? ` ${p.level}` : ''}
              {p.notes ? (
                <>
                  {' '}
                  <i>— {p.notes}</i>
                </>
              ) : (
                ''
              )}
              <ItemRef item={p} />
            </span>
          )}
        />
        <SpellsTable spells={tpl.spells} />
        <Chips
          title={t('Qualités')}
          items={tpl.qualities}
          render={(q, i) => (
            <span key={q.id || i} className="sb-chip" title={q.notes || ''} style={{ borderColor: q.positive === false ? '#6a2c2c' : '' }}>
              {q.name}
              {q.notes ? (
                <>
                  {' '}
                  <i>— {q.notes}</i>
                </>
              ) : (
                ''
              )}
              <ItemRef item={q} />
            </span>
          )}
        />
        <MatrixLine m={tpl.matrix} />
        <Chips
          title={t('Connaissances')}
          items={tpl.knowledge}
          render={(k, i) => (
            <span key={k.id || i} className="sb-chip">
              {k.name}
              {k.native ? (
                <>
                  {' '}
                  <i>{t('langue maternelle')}</i>
                </>
              ) : (
                <b>{k.rating}</b>
              )}
            </span>
          )}
        />
        <Chips
          title={t('Équipement')}
          items={tpl.gear}
          render={(g, i) => (
            <span key={g.id || i} className="sb-chip" title={g.notes || ''}>
              {g.name}
              {g.qty > 1 ? (
                <>
                  {' '}
                  <i>×{g.qty}</i>
                </>
              ) : (
                ''
              )}
              <ItemRef item={g} />
            </span>
          )}
        />
        <Chips
          title={t('Véhicules & drones')}
          items={tpl.vehicles}
          render={(v, i) => (
            <span key={v.id || i} className="sb-chip" title={v.notes || ''}>
              {v.name}{' '}
              <i>
                {t('Mani {handling} · Vit {speed} · Str {body} · Bli {armor} · Pil {pilot}', {
                  handling: v.handling ?? '—',
                  speed: v.speed ?? '—',
                  body: v.body ?? '—',
                  armor: v.armor ?? '—',
                  pilot: v.pilot ?? '—',
                })}
              </i>
              <ItemRef item={v} />
            </span>
          )}
        />

        {tpl.description && (
          <div className="sb-sec">
            <h4>{t('Description')}</h4>
            <div className="sb-text">
              <Markdown text={tpl.description} />
            </div>
          </div>
        )}
        {tpl.npc?.tactics && (
          <div className="sb-sec">
            <h4>{t('Tactique')}</h4>
            <div className="sb-text tactics">
              <Markdown text={tpl.npc.tactics} />
            </div>
          </div>
        )}
        {tpl.npc?.loot && (
          <div className="sb-sec">
            <h4>{t('Butin')}</h4>
            <div className="sb-text loot">
              <Markdown text={tpl.npc.loot} />
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
