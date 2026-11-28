// « Créer un ennemi » — quick tiered enemy generator (GM). Archetype × Professional Rating, live stat-block preview,
// save to the bestiary (folder « Générés ») and/or spawn on a map. Generation runs server-side (npcgen/preview).
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Modal, Button, Select, NumberInput, Toggle, TextInput, Field, Tabs, IconButton } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { useUI, toast } from '../../lib/ui-store.ts';
import { ARCHETYPES, ARCHETYPE_BY_ID, TIERS, METATYPE_CHOICES, GRUNT_RULES, randomSeed, makeName } from '/shared/npcgen.ts';
import StatBlock from '../combat/StatBlock.tsx';
import { t, tn, compare, metatypeLabel } from '../../lib/i18n.ts';
import type { GameMap, GameView, Template, Token } from '../../../shared/types.ts';
import './chargen.css';
import '../combat/combat.css';

const NO_MAP = '__none';
const metaLabel = (m: string): string => (m === 'random' ? t('Random') : metatypeLabel(m));
// Remember the last setup while the GM keeps generating.
const memo = { archetype: 'ganger', tier: 2, metatype: 'random' };

/** shared/npcgen.js ARCHETYPES entry. */
interface Archetype {
  id: string;
  label: string;
  blurb: string;
  icon: string;
  color: string;
  kind?: string;
  grunt?: boolean;
  metaFrom?: unknown;
}
/** shared/npcgen.js TIERS entry. */
interface Tier {
  pr: number;
  label: string;
  text: string;
}
/** Reply of npcgen/preview: generated templates (not saved). */
interface PreviewReply {
  main?: Template;
  lieutenant?: Template;
  unitName?: string;
}
/** Reply of npcgen/create. */
export interface CreatedReply {
  templateIds: string[];
  actorIds: string[];
  unplaced?: number;
}

interface EnemyGeneratorProps {
  game: GameView;
  onClose: () => void;
  onCreated?: (res: CreatedReply) => void;
}
/** props: { game, onClose(), onCreated?({ templateIds, actorIds }) } */
export default function EnemyGenerator({ game, onClose, onCreated }: EnemyGeneratorProps) {
  const ui = useUI();
  const archetypes = ARCHETYPES as Archetype[];
  const tiers = TIERS as Tier[];
  const [archetype, setArchetype] = useState(memo.archetype);
  const a: Archetype = ARCHETYPE_BY_ID[archetype] || archetypes[0];
  const [tier, setTier] = useState(memo.tier);
  const [metatype, setMetatype] = useState(memo.metatype);
  const [seed, setSeed] = useState(() => randomSeed());
  const [grunt, setGrunt] = useState(!!a.grunt);
  const [lieutenant, setLieutenant] = useState(false);
  const [count, setCount] = useState(a.grunt ? 4 : 1);
  const [name, setName] = useState('');
  const [ltName, setLtName] = useState('');
  const [preview, setPreview] = useState<PreviewReply | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'main' | 'lieutenant'>('main');
  const [busy, setBusy] = useState(false);
  const maps = useMemo(() => Object.values(game.maps || {}).sort((x, y) => compare(x.name, y.name)), [game.maps]);
  const defaultMap: string = (ui.viewMapId && game.maps?.[ui.viewMapId] && ui.viewMapId) || game.scene?.activeMapId || maps[0]?.id || NO_MAP;
  const [mapChoice, setMapChoice] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [addToCombat, setAddToCombat] = useState(true);
  const [keep, setKeep] = useState(false);
  Object.assign(memo, { archetype, tier, metatype });

  const critter = a.kind === 'critter';
  const metaLocked = critter && !a.metaFrom;
  const withLt = grunt && lieutenant;

  const pickArchetype = (id: string) => {
    const x: Archetype = ARCHETYPE_BY_ID[id];
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
      send<PreviewReply>('npcgen/preview', { archetype, tier, metatype: metaLocked ? 'random' : metatype, seed, grunt, lieutenant: withLt }, { silent: true })
        .then((res) => n === req.current && setPreview(res))
        .catch((err: Error) => n === req.current && toast(err.message || t('Preview unavailable'), 'error'))
        .finally(() => n === req.current && setLoading(false));
    }, 120);
    return () => clearTimeout(timer);
  }, [archetype, tier, metatype, seed, grunt, withLt]);

  const autoName = preview ? (count > 1 || grunt ? preview.unitName : preview.main?.name) || '' : '';
  const finalName = name.trim() || autoName;
  const finalLt = ltName.trim() || preview?.lieutenant?.name || '';
  const shown = tab === 'lieutenant' && preview?.lieutenant ? { ...preview.lieutenant, name: finalLt } : preview?.main ? { ...preview.main, name: finalName } : null;

  const mapId = mapChoice && (mapChoice === NO_MAP || game.maps?.[mapChoice]) ? mapChoice : defaultMap;
  const map: GameMap | null | undefined = mapId !== NO_MAP ? game.maps?.[mapId] : null;
  const anchor: Token | undefined = map ? ((ui.selectedTokenIds || []) as string[]).map((id) => (map.tokens || []).find((tk) => tk.id === id)).find(Boolean) : undefined;
  const combatOn = !!game.combat?.active;

  const payload = () => ({
    archetype,
    tier,
    metatype: metaLocked ? 'random' : metatype,
    seed,
    grunt,
    lieutenant: withLt,
    name: finalName,
    lieutenantName: withLt ? finalLt : undefined,
  });
  const saveOnly = async () => {
    setBusy(true);
    try {
      const res = await send<CreatedReply>('npcgen/create', { ...payload(), saveToBestiary: true });
      toast(res.templateIds.length > 1 ? t('{n} templates added to the bestiary (Generated)', { n: res.templateIds.length }) : t('Template added to the bestiary (Generated)'), 'success');
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
      const sp: Record<string, unknown> = { mapId: map ? map.id : null, count, hidden, addToCombat: combatOn && addToCombat };
      if (anchor) {
        sp.x = anchor.x;
        sp.y = anchor.y;
      }
      const res = await send<CreatedReply>('npcgen/create', { ...payload(), saveToBestiary: keep, spawn: sp });
      const n = res.actorIds.length;
      toast(
        map
          ? hidden
            ? t('{n} NPC(s) on “{map}” (hidden)', { n, map: map.name })
            : t('{n} NPC(s) on “{map}”', { n, map: map.name })
          : tn(n, '{n} NPC created (no token)', '{n} NPCs created (no token)'),
        'success'
      );
      if (res.unplaced) toast(t('{n} NPC(s) with no free cell on the map (actors created without a token)', { n: res.unplaced }), 'warn');
      onCreated?.(res);
      onClose();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };

  const groups = [
    { id: 'meta', label: t('Metahumans'), list: archetypes.filter((x) => x.kind !== 'critter') },
    { id: 'critter', label: t('Critters'), list: archetypes.filter((x) => x.kind === 'critter') },
  ];
  const tierInfo = tiers[tier];

  return (
    <Modal title={t('Create an enemy')} width={1180} onClose={onClose}>
      <div className="cg-eg">
        <div className="cg-eg-left">
          {groups.map((g) => (
            <Fragment key={g.id}>
              <div className="section-title">{g.label}</div>
              <div className="cg-eg-archetypes">
                {g.list.map((x) => (
                  <button key={x.id} className={'cg-eg-arch' + (x.id === archetype ? ' on' : '')} style={{ '--ac': x.color } as CSSProperties} onClick={() => pickArchetype(x.id)} title={t(x.blurb)}>
                    <span className="cg-eg-arch-icon">{x.icon}</span>
                    <span className="cg-eg-arch-label">{t(x.label)}</span>
                  </button>
                ))}
              </div>
            </Fragment>
          ))}
          <div className="small muted cg-eg-blurb">{t(a.blurb)}</div>

          <div className="section-title">{t('Professional Rating')}</div>
          <div className="cg-eg-tier">
            <input type="range" min="0" max="6" step="1" value={tier} onChange={(e) => setTier(Number(e.target.value))} />
            <div className="cg-eg-ticks">
              {tiers.map((x) => (
                <button key={x.pr} className={'cg-eg-tick' + (x.pr === tier ? ' on' : '')} onClick={() => setTier(x.pr)} title={t(x.label)}>
                  {x.pr}
                </button>
              ))}
            </div>
            <div className="cg-eg-tier-text">
              <strong>{t('PR {pr} — {label}', { pr: tier, label: { t: tierInfo.label } })}</strong>
              <div className="small muted">{t(tierInfo.text)}</div>
            </div>
          </div>

          <div className="section-title">{t('Options')}</div>
          <div className="cg-eg-opts">
            <Field label={t('Metatype')}>
              <Select
                value={metaLocked ? 'random' : metatype}
                disabled={metaLocked}
                onChange={setMetatype}
                options={(METATYPE_CHOICES as string[]).map((m) => ({ value: m, label: metaLocked ? '—' : metaLabel(m) }))}
              />
            </Field>
            <Field label={t('Count')}>
              <NumberInput value={count} min={1} max={20} onChange={setCount} />
            </Field>
            <Field label={t('Grunt group')}>
              <Toggle
                value={grunt}
                onChange={(v) => {
                  setGrunt(v);
                  if (!v) setLieutenant(false);
                }}
                label={grunt ? t('Yes') : t('No')}
                title={t('Single condition monitor, no Edge (SR5 grunt rules)')}
              />
            </Field>
            {grunt && (
              <Field label={t('Lieutenant')}>
                <Toggle
                  value={lieutenant}
                  onChange={setLieutenant}
                  label={lieutenant ? t('+1 (PR {pr})', { pr: Math.min(7, tier + 1) }) : t('No')}
                  title={t('A PR +1 leader with Edge, on top of the chosen count')}
                />
              </Field>
            )}
          </div>
          <div className="cg-eg-names">
            <Field label={count > 1 || grunt ? t('Group name (numbered when spawned)') : t('Name')}>
              <div className="row gap-s">
                <TextInput live value={name || autoName} onChange={setName} />
                <IconButton icon="↻" title={t('Another name')} onClick={() => setName(makeName(archetype, randomSeed(), { t }))} />
                {name && <IconButton icon="↺" title={t('Automatic name')} onClick={() => setName('')} />}
              </div>
            </Field>
            {withLt && (
              <Field label={t('Lieutenant’s name')}>
                <div className="row gap-s">
                  <TextInput live value={ltName || preview?.lieutenant?.name || ''} onChange={setLtName} />
                  <IconButton icon="↻" title={t('Another name')} onClick={() => setLtName(makeName(archetype, randomSeed(), { lieutenant: true, t }))} />
                </div>
              </Field>
            )}
          </div>
          {grunt && <div className="small faint cg-eg-rules">{t(GRUNT_RULES)}</div>}
        </div>

        <div className="cg-eg-right">
          <div className="row wrap gap-s cg-eg-prev-bar">
            {withLt ? (
              <Tabs
                tabs={[
                  { id: 'main', label: count > 1 ? t('Grunts ×{n}', { n: count }) : t('Grunt') },
                  { id: 'lieutenant', label: t('Lieutenant') },
                ]}
                value={tab}
                onChange={setTab}
              />
            ) : (
              <strong className="cg-eg-prev-title">{t('Preview')}</strong>
            )}
            <span className="grow"></span>
            {loading && <span className="small faint">{t('Generating…')}</span>}
            <Button small onClick={() => setSeed(randomSeed())} title={t('New roll (same archetype and PR)')}>
              🎲 {t('roll::Reroll')}
            </Button>
          </div>
          <div className={'cg-eg-preview' + (loading ? ' loading' : '')}>{shown ? <StatBlock t={shown} /> : <div className="cg-loading">{t('Generating…')}</div>}</div>
        </div>
      </div>

      <footer className="cg-eg-foot">
        <div className="row wrap cg-eg-spawn">
          <Field label={t('Map')}>
            <select className="input" value={mapId} onChange={(e) => setMapChoice(e.target.value)}>
              {maps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.id === game.scene?.activeMapId ? ` ${t('(active)')}` : ''}
                </option>
              ))}
              <option value={NO_MAP}>{t('— None (sheets only) —')}</option>
            </select>
          </Field>
          <Field label={t('Visibility')}>
            <Toggle value={hidden} onChange={setHidden} label={hidden ? t('Hidden') : t('Visible')} />
          </Field>
          {combatOn && (
            <Field label={t('Combat')}>
              <Toggle value={addToCombat} onChange={setAddToCombat} label={t('Add')} />
            </Field>
          )}
          <Field label={t('Bestiary')}>
            <Toggle value={keep} onChange={setKeep} label={t('Keep the template')} title={t('Also saves the template in the “Generated” folder')} />
          </Field>
          <span className="grow"></span>
          <Button disabled={busy || !preview} onClick={saveOnly}>
            {t('Add to bestiary')}
          </Button>
          <Button variant="primary" disabled={busy || !preview} onClick={spawn}>
            ☠ {map ? t('Spawn on the map ({n})', { n: count + (withLt ? 1 : 0) }) : t('Spawn ({n})', { n: count + (withLt ? 1 : 0) })}
          </Button>
        </div>
        <div className="small faint">
          {map
            ? anchor
              ? t('Next to the selected token ({name}).', { name: anchor.name })
              : t('In the middle of the map (select a token on the map to place them next to it).')
            : t('The NPCs will be created without a token.')}
        </div>
      </footer>
    </Modal>
  );
}
