// GM Matrix screens: decker oversight (OS, damage, marks, convergence) and the hosts manager (templates, IC, files, devices).
import { useEffect, useState } from 'react';
import { Button, Badge, Field, NumberInput, Select, TextInput, Toggle, Empty, IconButton, confirmAction } from '../../lib/ui.tsx';
import { openSheet, toast } from '../../lib/ui-store.ts';
import { t, tn, compare } from '../../lib/i18n.ts';
import { uid } from '/shared/util.ts';
import { ASDF, IC_TYPES, IC_ORDER, HOST_PRESETS, OS_MAX, OS_TICK_MS, hostAttributes, matrixMonitor, icInitiative, icAttackPool, deckStats, isCyberdeck } from './types.ts';
import {
  act, personaOf, OsMeter, MatrixMonitor, marksDots, icName, markName, linkLockName, asdfShort, asdfLabel, modeLabel, msgText, outcomeTexts,
  deviceLinkState, linkStateText, isFullActor, type ActionResult, type MsgLike,
} from './common.tsx';
import { RuleRef } from './legacy.ts';
import type { Actor, DeviceLink, GameMap, GameView, Host, HostDevice, HostFile, IcType, Persona } from '../../../shared/types.ts';

/** Re-render every `ms` (countdowns). */
function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** GM view: hosts are full `Host` records. */
const gmHosts = (game: GameView): Record<string, Host> => (game.matrix?.hosts || {}) as Record<string, Host>;

// ---------------------------------------------------------------------------
// Deckers
// ---------------------------------------------------------------------------
function DeckerCard({ game, actor, onCockpit }: { game: GameView; actor: Actor; onCockpit: (id: string) => void }) {
  const p = personaOf(game, actor);
  const ds = deckStats(actor, p);
  const host = p.hostId ? gmHosts(game)[p.hostId] : null;
  const set = (patch: Partial<Persona>) => act('matrix/setPersona', { actorId: actor.id, patch });
  const now = useNow();
  const timerOn = !!game.matrix?.settings?.osTimer;
  const nextTick = timerOn && p.online && (p.overwatch || 0) > 0 && p.osClock ? Math.max(0, Math.ceil((p.osClock + OS_TICK_MS - now) / 60000)) : null;
  const converge = async () => {
    const q =
      p.online && host
        ? t('Déclencher la convergence sur {name} ? Dans l’hôte : il pose 3 marques, passe en alerte et lance une IC ; sortir de l’hôte déclenchera la convergence du GOD.', { name: actor.name })
        : t('Déclencher la convergence sur {name} ? 12 VD matriciels (résistés), deck redémarré de force, marques perdues, position révélée.', { name: actor.name });
    if (await confirmAction(q)) act('matrix/converge', { actorId: actor.id });
  };
  const tick = async () => {
    const r = await act<{ added: number; overwatch: number }>('matrix/osTick', { actorId: actor.id });
    if (r) toast(t('SO de {name} +{n} (2D6) → {os}', { name: actor.name, n: r.added, os: r.overwatch }), 'info');
  };
  const dump = async () => {
    if (await confirmAction(t('Éjecter {name} de la Matrice (choc d’éjection en RV) ?', { name: actor.name }))) act('matrix/disconnect', { actorId: actor.id, dump: true });
  };
  const reset = async () => {
    if (await confirmAction(t('Réinitialiser complètement le persona de {name} (SO, marques, programmes chargés, agent) ?', { name: actor.name }))) act('matrix/resetPersona', { actorId: actor.id });
  };
  return (
    <div className={'mx-gm-decker' + (p.online ? ' online' : '') + ((p.overwatch || 0) >= 30 ? ' danger' : '')}>
      <div className="mx-gm-decker-head">
        <div className="grow">
          <button type="button" className="mx-link big" onClick={() => openSheet(actor.id)}>
            {actor.name}
          </button>
          <div className="small muted">
            {actor.matrix?.device || t('Appareil')} · {t('indice {n}', { n: ds.deviceRating })} · {isCyberdeck(actor) ? t('cyberdeck') : t('commlink')}
          </div>
        </div>
        {p.online ? <Badge color="cyan">{modeLabel(p.mode)}</Badge> : <Badge>{t('hors ligne')}</Badge>}
        {host && <Badge color="amber">{host.name}</Badge>}
        {p.bricked && <Badge color="red">{t('briqué')}</Badge>}
      </div>
      <OsMeter value={p.overwatch} compact />
      <div className="row wrap mx-gm-row">
        <Field label={t('Score d’Overwatch')}>
          <NumberInput small value={p.overwatch || 0} min={0} max={OS_MAX} onChange={(v) => act('matrix/setOverwatch', { actorId: actor.id, value: v })} />
        </Field>
        <Field label={t('Bruit')}>
          <NumberInput small value={p.noise || 0} min={0} max={20} onChange={(v) => set({ noise: v })} />
        </Field>
        <Field label={t('Emplacements')}>
          <NumberInput small value={p.programSlots || 4} min={1} max={20} onChange={(v) => set({ programSlots: v })} />
        </Field>
        <Button small title={t('15 minutes passent : +2D6 au SO, lancés en secret (SR5 p. 232)')} onClick={tick}>
          {t('+15 min (2D6)')}
        </Button>
        <Button small variant="danger" onClick={converge}>
          {t('Convergence')}
        </Button>
      </div>
      {nextTick !== null && <div className="small faint">{t('Minuterie : prochain +2D6 dans {n} min (à la prochaine action matricielle).', { n: nextTick })}</div>}
      {p.hostConverged && <div className="small red">{t('Convergence dans l’hôte : sortir déclenchera celle du GOD.')}</div>}
      <MatrixMonitor value={p.matrixDamage} deviceRating={ds.deviceRating} onSet={(n) => set({ matrixDamage: n })} />
      <div className="mx-chips">
        {p.linkLocked && (
          <span className="mx-chip-btn">
            <Badge color="red">{t('Verrou : {name}', { name: linkLockName(p.linkLocked) })}</Badge>
            <button type="button" title={t('Lever le verrou')} onClick={() => set({ linkLocked: null })}>
              ✕
            </button>
          </span>
        )}
        {p.fullDefense && (
          <span className="mx-chip-btn">
            <Badge color="cyan">{t('Défense totale')}</Badge>
            <button type="button" onClick={() => set({ fullDefense: false })}>
              ✕
            </button>
          </span>
        )}
        {p.traced && (
          <span className="mx-chip-btn">
            <Badge color="magenta">{t('Localisé(e)')}</Badge>
            <button type="button" onClick={() => set({ traced: false })}>
              ✕
            </button>
          </span>
        )}
        {Object.entries(p.penalties || {})
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <span className="mx-chip-btn" key={k}>
              <Badge color="red">
                {asdfLabel(k)} −{v}
              </Badge>
              <button type="button" onClick={() => set({ penalties: { ...p.penalties, [k]: 0 } })}>
                ✕
              </button>
            </span>
          ))}
        {p.agent && (
          <Badge color={p.agent.loaded ? 'green' : 'dim'}>
            ◈ {p.agent.name} ({p.agent.rating}){p.agent.damage ? ` ${p.agent.damage}/${matrixMonitor(p.agent.rating)}` : ''}
          </Badge>
        )}
      </div>
      {(p.marks || []).length > 0 && (
        <div className="mx-gm-marks">
          <span className="faint small">{t('Marques :')}</span>
          {p.marks.map((m) => (
            <span className="mx-gm-mark" key={m.targetId}>
              {markName(m)} {marksDots(m.count)}
              <button type="button" title={t('Retirer')} onClick={() => act('matrix/setMarks', { actorId: actor.id, targetId: m.targetId, count: 0 })}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {(p.marksOnMe || []).length > 0 && (
        <div className="mx-gm-marks">
          <span className="faint small">{t('Sur lui/elle :')}</span>
          {p.marksOnMe.map((m) => (
            <span className="mx-gm-mark hostile" key={m.sourceId}>
              {markName(m)} {marksDots(m.count)}
              <button type="button" title={t('Retirer')} onClick={() => act('matrix/setMarkOnMe', { actorId: actor.id, sourceId: m.sourceId, count: 0 })}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row wrap mx-gm-row">
        <Button small variant="primary" onClick={() => onCockpit(actor.id)}>
          {t('Cockpit')}
        </Button>
        {p.online && (
          <Button small onClick={dump}>
            {t('Éjecter')}
          </Button>
        )}
        {p.bricked && (
          <Button small onClick={() => set({ matrixDamage: 0, bricked: false })}>
            {t('Réparer le deck')}
          </Button>
        )}
        <Button small variant="ghost" onClick={reset}>
          {t('Réinitialiser')}
        </Button>
      </div>
    </div>
  );
}

export function DeckersView({ game, onCockpit }: { game: GameView; onCockpit: (id: string) => void }) {
  const actors = Object.values(game.actors || {}).filter((a): a is Actor => isFullActor(a) && !!a.matrix && !a.retired && (isCyberdeck(a) || !!game.matrix?.personas?.[a.id]));
  actors.sort((a, b) => (a.type === b.type ? compare(a.name, b.name) : a.type === 'pc' ? -1 : 1));
  if (!actors.length) return <Empty>{t('Aucun decker : un personnage avec un cyberdeck (Attaque/Corruption) apparaît ici, ou dès qu’un commlink se connecte.')}</Empty>;
  return (
    <div className="mx-gm-grid">
      {actors.map((a) => (
        <DeckerCard key={a.id} game={game} actor={a} onCockpit={onCockpit} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------
function NewHost({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [rating, setRating] = useState(4);
  const [preset, setPreset] = useState('shell');
  const [ic, setIc] = useState(true);
  const attrs = hostAttributes(rating, preset);
  const create = async () => {
    const r = await act<{ id: string }>('matrix/hostCreate', { name: name.trim() || t('Hôte {n}', { n: rating }), rating, preset, ic });
    if (r) {
      setName('');
      onCreated(r.id);
    }
  };
  return (
    <div className="mx-gm-new">
      <div className="mx-panel-title">{t('Nouvel hôte')}</div>
      <Field label={t('Nom')}>
        <TextInput live value={name} onChange={setName} placeholder={t('ex. Bureau de Renraku Tacoma')} />
      </Field>
      <div className="row wrap">
        <Field label={t('Indice')}>
          <NumberInput small value={rating} min={1} max={12} onChange={setRating} />
        </Field>
        <Field label={t('Profil')} className="grow">
          <Select value={preset} options={Object.entries(HOST_PRESETS).map(([v, p]) => ({ value: v, label: t(p.label) }))} onChange={setPreset} />
        </Field>
      </div>
      <div className="mx-host-attrs">
        {ASDF.map((k) => (
          <span key={k}>
            {asdfShort(k)} <b>{attrs[k]}</b>
          </span>
        ))}
      </div>
      <Toggle value={ic} onChange={setIc} label={t('Suite d’IC standard (Patrouille active)')} />
      <Button variant="primary" onClick={create}>
        {t('Créer l’hôte')}
      </Button>
    </div>
  );
}

function IcSection({ game, host }: { game: GameView; host: Host }) {
  const [type, setType] = useState<IcType>('killer');
  const inside = Object.values(game.matrix?.personas || {}).filter((p) => p.online && p.hostId === host.id);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const ini = icInitiative(host);
  return (
    <div className="mx-gm-section">
      <div className="mx-panel-title spread">
        <span>
          {t('IC')} <RuleRef rule="ic" />
        </span>
        <span className="faint small">{t('attaque {n} dés · init. {init}', { n: icAttackPool(host), init: ini.text })}</span>
      </div>
      {host.ic.length === 0 && <div className="muted small">{t('Aucune IC.')}</div>}
      {host.ic.map((ic) => {
        const def = IC_TYPES[ic.type] || {};
        const tgt = targets[ic.id] || inside[0]?.actorId || '';
        return (
          <div className={'mx-gm-ic' + (ic.active ? ' on' : '') + (ic.crashed ? ' crashed' : '')} key={ic.id}>
            <div className="grow">
              <b title={def.desc ? t(def.desc) : ''}>{icName(ic.type)}</b>{' '}
              <span className="faint small">
                {def.desc ? t(def.desc) : ''}
                {def.needsMarks ? ` ${tn(def.needsMarks, 'one::({n} marque(s) requise(s))', '({n} marque(s) requise(s))')}` : ''}
              </span>
            </div>
            <Field label={t('Indice')}>
              <NumberInput small value={ic.rating} min={1} max={12} onChange={(v) => act('matrix/icUpdate', { hostId: host.id, icId: ic.id, patch: { rating: v } })} />
            </Field>
            <Field label={t('Dommages /{n}', { n: matrixMonitor(ic.rating) })}>
              <NumberInput small value={ic.damage || 0} min={0} max={matrixMonitor(ic.rating)} onChange={(v) => act('matrix/icUpdate', { hostId: host.id, icId: ic.id, patch: { damage: v } })} />
            </Field>
            {ic.active ? (
              <div className="row gap-s">
                {inside.length > 0 ? (
                  <>
                    <select className="input mx-gm-tgt" value={tgt} onChange={(e) => setTargets({ ...targets, [ic.id]: e.target.value })}>
                      {inside.map((p) => (
                        <option key={p.actorId} value={p.actorId}>
                          {game.actors?.[p.actorId]?.name || p.actorId}
                        </option>
                      ))}
                    </select>
                    <Button small variant="danger" onClick={() => act('matrix/icAct', { hostId: host.id, icId: ic.id, actorId: tgt })}>
                      {t('Attaquer')}
                    </Button>
                  </>
                ) : (
                  <span className="faint small">{t('personne dans l’hôte')}</span>
                )}
                <Button small variant="ghost" onClick={() => act('matrix/icUpdate', { hostId: host.id, icId: ic.id, patch: { active: false } })}>
                  {t('Retirer')}
                </Button>
              </div>
            ) : (
              <Button small variant="accent" onClick={() => act('matrix/icLaunch', { hostId: host.id, icId: ic.id })}>
                {ic.crashed ? t('Relancer') : t('ic::Lancer')}
              </Button>
            )}
            <IconButton icon="✕" title={t('Supprimer cette IC')} onClick={() => act('matrix/icRemove', { hostId: host.id, icId: ic.id })} />
          </div>
        );
      })}
      <div className="row wrap">
        <Select value={type} options={IC_ORDER.map((x) => ({ value: x, label: icName(x) }))} onChange={setType} />
        <Button small variant="accent" onClick={() => act('matrix/icLaunch', { hostId: host.id, type })}>
          {t('Ajouter et lancer')}
        </Button>
      </div>
    </div>
  );
}

function FilesSection({ host }: { host: Host }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const save = (files: Array<Partial<HostFile>>) => act('matrix/hostUpdate', { hostId: host.id, patch: { files } });
  const upd = (id: string, patch: Partial<HostFile>) => save(host.files.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  return (
    <div className="mx-gm-section">
      <div className="mx-panel-title">{t('Fichiers')}</div>
      {host.files.length === 0 && <div className="muted small">{t('Aucun fichier.')}</div>}
      {host.files.map((f) => (
        <div className="mx-gm-file" key={f.id}>
          <div className="row wrap">
            <TextInput value={f.name} onChange={(v) => upd(f.id, { name: v })} className="grow" />
            <Toggle value={f.protected} onChange={(v) => upd(f.id, { protected: v, protection: v && !f.protection ? host.rating : f.protection })} label={t('Protégé')} />
            {f.protected && (
              <Field label={t('Protection')}>
                <NumberInput small value={f.protection || host.rating} min={1} max={12} onChange={(v) => upd(f.id, { protection: v })} />
              </Field>
            )}
            <Field label={t('Bombe')}>
              <NumberInput small value={f.bomb || 0} min={0} max={12} onChange={(v) => upd(f.id, { bomb: v, bombBy: v ? f.bombBy : null })} />
            </Field>
            <Field label={t('Valeur ¥')}>
              <NumberInput small value={f.value || 0} min={0} max={1000000} step={100} onChange={(v) => upd(f.id, { value: v })} />
            </Field>
            <Button small variant="ghost" onClick={() => setOpenId(openId === f.id ? null : f.id)}>
              {openId === f.id ? t('Fermer') : t('Contenu')}
            </Button>
            <IconButton icon="✕" title={t('Supprimer')} onClick={() => save(host.files.filter((x) => x.id !== f.id))} />
          </div>
          {f.edited && <span className="small amber">{t('modifié par un hacker')}</span>}
          {openId === f.id && (
            <TextInput multiline rows={3} value={f.content || ''} placeholder={t('Ce que le decker découvre en lisant ou copiant le fichier')} onChange={(v) => upd(f.id, { content: v })} />
          )}
        </div>
      ))}
      <Button small onClick={() => save([...host.files, { id: uid('file'), name: t('Nouveau fichier'), protected: false, bomb: 0, value: null, content: '' }])}>
        {t('Ajouter un fichier')}
      </Button>
    </div>
  );
}

/** Map objects a device can drive: tile doors, segment-wall doors, lights, regions (camera zones). value = 'kind:id'. */
function linkOptions(map: GameMap | null | undefined) {
  if (!map) return [];
  const opts: Array<{ value: string; label: string }> = [];
  for (const d of map.doors || []) opts.push({ value: `door:${d.id}`, label: `🚪 ${d.name || t('Porte ({x}, {y})', { x: d.x, y: d.y })}` });
  for (const w of map.walls || [])
    if (w.door) opts.push({ value: `door:${w.id}`, label: `🚪 ${w.door.name || t('Porte ({x}, {y})', { x: Math.round((w.x1 + w.x2) / 2), y: Math.round((w.y1 + w.y2) / 2) })}` });
  for (const l of map.lights || []) opts.push({ value: `light:${l.id}`, label: `💡 ${l.name || t('Lumière ({x}, {y})', { x: l.x, y: l.y })}` });
  for (const r of map.regions || []) opts.push({ value: `camera:${r.id}`, label: `📷 ${t('Caméras : {zone}', { zone: r.name })}` });
  return opts;
}

function DeviceLinkRow({ game, device, onChange }: { game: GameView; device: HostDevice; onChange: (link: DeviceLink | null) => void }) {
  const l = device.link;
  const maps = Object.values(game.maps || {}).sort((a, b) => compare(a.folder || '', b.folder || '') || compare(a.name, b.name));
  const [mapId, setMapId] = useState(l?.mapId || '');
  const map = mapId ? game.maps?.[mapId] : null;
  const opts = linkOptions(map);
  const state = l ? deviceLinkState(game, device) : null;
  return (
    <div className="row wrap mx-gm-link">
      <span className="faint small">{t('Sur la carte :')}</span>
      <Select
        value={mapId}
        options={[{ value: '', label: t('— non relié —') }, ...maps.map((m) => ({ value: m.id, label: m.folder ? `${m.folder} · ${m.name}` : m.name }))]}
        onChange={(v) => {
          setMapId(v);
          if (!v) onChange(null);
        }}
      />
      {map && (
        <Select
          value={l && l.mapId === mapId ? `${l.kind}:${l.targetId}` : ''}
          options={[{ value: '', label: opts.length ? t('— choisir —') : t('rien à relier sur cette carte') }, ...opts]}
          onChange={(v) => {
            if (!v) return onChange(null);
            const i = v.indexOf(':');
            onChange({ mapId, kind: v.slice(0, i) as DeviceLink['kind'], targetId: v.slice(i + 1) });
          }}
        />
      )}
      {l && state && <span className="mx-link-chip">{linkStateText(l.kind, state)}</span>}
      {l && !state && <span className="small red">{t('objet introuvable sur la carte')}</span>}
    </div>
  );
}

function DevicesSection({ game, host }: { game: GameView; host: Host }) {
  const save = (devices: Array<Partial<HostDevice>>) => act('matrix/hostUpdate', { hostId: host.id, patch: { devices } });
  const upd = (id: string, patch: Partial<HostDevice>) => save(host.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  return (
    <div className="mx-gm-section">
      <div className="mx-panel-title">{t('Appareils esclaves')}</div>
      <div className="small faint">{t('Relie un appareil à une porte, une lumière ou une zone de la carte : quand le decker le contrôle, la carte change toute seule.')}</div>
      {host.devices.length === 0 && <div className="muted small">{t('Aucun appareil.')}</div>}
      {host.devices.map((d) => (
        <div className="mx-gm-file" key={d.id}>
          <div className="row wrap">
            <TextInput value={d.name} onChange={(v) => upd(d.id, { name: v })} className="grow" />
            <Field label={t('Indice')}>
              <NumberInput small value={d.rating} min={1} max={12} onChange={(v) => upd(d.id, { rating: v })} />
            </Field>
            <Toggle value={d.offline} onChange={(v) => upd(d.id, { offline: v })} label={t('Hors ligne')} />
            {d.formatted && <Badge color="red">{t('formaté')}</Badge>}
            {d.bricked && <Badge color="red">{t('briqué')}</Badge>}
            {d.formatted || d.bricked || d.damage ? (
              <Button small variant="ghost" onClick={() => upd(d.id, { formatted: false, bricked: false, damage: 0 })}>
                {t('Réparer')}
              </Button>
            ) : null}
            <IconButton icon="✕" title={t('Supprimer')} onClick={() => save(host.devices.filter((x) => x.id !== d.id))} />
          </div>
          <DeviceLinkRow game={game} device={d} onChange={(link) => upd(d.id, { link, on: true })} />
        </div>
      ))}
      <Button small onClick={() => save([...host.devices, { id: uid('dev'), name: t('Nouvel appareil'), rating: host.rating }])}>
        {t('Ajouter un appareil')}
      </Button>
    </div>
  );
}

/** Reply of matrix/hostTurn. */
interface HostTurnReply extends ActionResult {
  results?: Array<{ icId: string; actorId: string; skippedMsg?: MsgLike; result?: ActionResult }>;
}

/** GM one-click host management: the host's turn, its next IC, its spider, and a cheat sheet. */
function HostTurnBar({ game, host }: { game: GameView; host: Host }) {
  const [last, setLast] = useState<HostTurnReply | null>(null);
  const inside = Object.values(game.matrix?.personas || {}).filter((p) => p.online && p.hostId === host.id);
  const inFight = !!game.combat?.active && (game.combat.entries || []).some((e) => e.kind === 'ic' && e.hostId === host.id && !e.out);
  const spiderId = host.alert === 'active' ? host.spiderAlert || host.spider : host.spider || host.spiderAlert;
  const turn = async () => {
    const r = await act<HostTurnReply>('matrix/hostTurn', { hostId: host.id });
    if (r) setLast(r);
  };
  const next = () => act('matrix/launchNextIc', { hostId: host.id });
  const spider = async () => {
    const r = await act('matrix/spawnSpider', { hostId: host.id });
    if (r) toast(game.combat?.active ? t('Araignée ajoutée au combat.') : t('Araignée créée (lance un combat pour son initiative).'), 'success');
  };
  const lines = last
    ? [
        ...outcomeTexts(last),
        ...(last.results || []).map((x) =>
          x.skippedMsg ? msgText(x.skippedMsg) : `${icName(host.ic.find((i) => i.id === x.icId)?.type)} → ${game.actors?.[x.actorId]?.name || ''} : ${outcomeTexts(x.result).join(' ')}`
        ),
      ]
    : [];
  return (
    <div className="mx-gm-section mx-gm-turn">
      <div className="row wrap">
        <Button variant="accent" disabled={!inside.length} title={t('Une IC de plus si l’hôte est en alerte, puis chaque IC active agit sur une cible choisie automatiquement')} onClick={turn}>
          ⚡ {t('Tour de l’hôte')}
        </Button>
        <Button small onClick={next} title={t('Lance la prochaine IC de la liste (pas encore active)')}>
          {t('IC suivante')}
        </Button>
        {spiderId && (
          <Button small onClick={spider} title={t('Ajoute l’araignée de l’hôte au combat (sans pion)')}>
            🕷 {t('Araignée au combat')}
          </Button>
        )}
        <span className="faint small grow">{inside.length ? t('Intrus : {names}', { names: inside.map((p) => game.actors?.[p.actorId]?.name).join(', ') }) : t('Personne dans l’hôte.')}</span>
      </div>
      {inFight && <div className="small cyan">{t('Combat en cours : chaque IC a sa ligne dans l’initiative, avec un bouton « Agir » à son tour.')}</div>}
      {lines.length > 0 && (
        <ul className="mx-gm-turnlog">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      <details className="mx-gm-help">
        <summary>{t('Aide-mémoire du MJ')}</summary>
        <ul className="small">
          <li>{t('Hôte calme : seule la Patrouille tourne. « Tour de l’hôte » lui fait chercher les intrus.')}</li>
          <li>{t('Une action illégale ratée ou une attaque met l’hôte en alerte (automatique).')}</li>
          <li>{t('En alerte, l’hôte lance une IC de plus par tour de combat (automatique en combat, sinon « Tour de l’hôte »).')}</li>
          <li>{t('Chaque IC vise l’intrus le mieux repéré. Crash, Traqueuse et Brouillage exigent 1, 2 ou 3 marques de l’hôte : la Sonde les pose.')}</li>
          <li>{t('SO : chaque action illégale ajoute les succès du défenseur, plus 2D6 toutes les 15 minutes (« +15 min » ou minuterie). À 40 : convergence.')}</li>
          <li>{t('L’araignée est un PNJ decker : ajoute-la au combat, elle agit à son initiative depuis le cockpit (onglet Cockpit).')}</li>
        </ul>
      </details>
    </div>
  );
}

function HostEditor({ game, host, onDeleted }: { game: GameView; host: Host; onDeleted: () => void }) {
  const upd = (patch: Partial<Host>) => act('matrix/hostUpdate', { hostId: host.id, patch });
  const [preset, setPreset] = useState('shell');
  const spiders = Object.entries(game.bestiary || {})
    .map(([id, tpl]) => ({ value: id, label: tpl.name }))
    .sort((a, b) => compare(a.label, b.label));
  const spiderOpts = [{ value: '', label: t('— aucune —') }, ...spiders];
  const deckers = Object.values(game.actors || {}).filter((a): a is Actor => isFullActor(a) && !!a.matrix && isCyberdeck(a) && !a.retired);
  const inside = Object.values(game.matrix?.personas || {}).filter((p) => p.online && p.hostId === host.id);
  const del = async () => {
    if (await confirmAction(t('Supprimer l’hôte « {name} » ? Les marques posées dessus disparaissent.', { name: host.name }))) {
      await act('matrix/hostDelete', { hostId: host.id });
      onDeleted();
    }
  };
  const spiderOnDuty = host.alert === 'active' ? host.spiderAlert || host.spider : host.spider;
  return (
    <div className={'mx-gm-host' + (host.alert === 'active' ? ' alert' : '')}>
      <HostTurnBar game={game} host={host} />
      <div className="row wrap">
        <Field label={t('Nom')} className="grow">
          <TextInput value={host.name} onChange={(v) => upd({ name: v })} />
        </Field>
        <Field label={t('Dossier')}>
          <TextInput value={host.folder || ''} onChange={(v) => upd({ folder: v })} />
        </Field>
      </div>
      <div className="row wrap">
        <Toggle value={host.alert === 'active'} onChange={(v) => upd({ alert: v ? 'active' : 'none' })} label={t('Alerte')} />
        <Toggle value={host.visible} onChange={(v) => upd({ visible: v })} label={t('Visible des joueurs (repéré sur la grille)')} />
      </div>
      <div className="row wrap mx-gm-row">
        <Field label={t('Indice')}>
          <NumberInput small value={host.rating} min={1} max={12} onChange={(v) => upd({ rating: v })} />
        </Field>
        {ASDF.map((k) => (
          <Field label={asdfLabel(k)} key={k}>
            <NumberInput small value={host[k]} min={0} max={20} onChange={(v) => upd({ [k]: v })} />
          </Field>
        ))}
      </div>
      <div className="row wrap">
        <Select value={preset} options={Object.entries(HOST_PRESETS).map(([v, p]) => ({ value: v, label: t(p.label) }))} onChange={setPreset} />
        <Button small variant="ghost" onClick={() => upd(hostAttributes(host.rating, preset))}>
          {t('Recalculer les attributs (indice {n})', { n: host.rating })}
        </Button>
      </div>
      <div className="grid-2">
        <Field label={t('Araignée de garde')}>
          <Select value={host.spider || ''} options={spiderOpts} onChange={(v) => upd({ spider: v || null })} />
        </Field>
        <Field label={t('Araignée en alerte')}>
          <Select value={host.spiderAlert || ''} options={spiderOpts} onChange={(v) => upd({ spiderAlert: v || null })} />
        </Field>
      </div>
      {spiderOnDuty && <div className="small amber">{t('Araignée en poste : {name} (à placer depuis le Bestiaire)', { name: game.bestiary?.[spiderOnDuty]?.name || '?' })}</div>}
      <Field label={t('Description (visible des deckers)')}>
        <TextInput multiline rows={2} value={host.description || ''} onChange={(v) => upd({ description: v })} />
      </Field>
      <Field label={t('Notes du MJ')}>
        <TextInput multiline rows={4} value={host.notes || ''} onChange={(v) => upd({ notes: v })} />
      </Field>

      <div className="mx-gm-section">
        <div className="mx-panel-title">{t('Deckers')}</div>
        {inside.length ? (
          <div className="small">{t('Dans l’hôte : {names}', { names: inside.map((p) => game.actors?.[p.actorId]?.name).join(', ') })}</div>
        ) : (
          <div className="muted small">{t('Personne dans l’hôte.')}</div>
        )}
        <div className="row wrap">
          {deckers.map((a) => {
            const seen = (host.perceivedBy || []).includes(a.id);
            return (
              <Toggle
                key={a.id}
                value={seen}
                onChange={(v) => upd({ perceivedBy: v ? [...(host.perceivedBy || []), a.id] : (host.perceivedBy || []).filter((x) => x !== a.id) })}
                label={t('{name} connaît l’hôte', { name: a.name })}
                title={t('Révèle indice, IC, fichiers et appareils à ce decker (comme une Perception matricielle)')}
              />
            );
          })}
        </div>
      </div>
      <IcSection game={game} host={host} />
      <FilesSection host={host} />
      <DevicesSection game={game} host={host} />
      <div className="row spread mx-gm-row">
        <span></span>
        <Button small variant="danger" onClick={del}>
          {t('Supprimer l’hôte')}
        </Button>
      </div>
    </div>
  );
}

export function HostsView({ game, selected, onSelect }: { game: GameView; selected: string | null; onSelect: (id: string | null) => void }) {
  const hosts = Object.values(gmHosts(game)).sort((a, b) => compare(a.folder || '', b.folder || '') || compare(a.name, b.name));
  const cur = hosts.find((h) => h.id === selected) || null;
  const personas = Object.values(game.matrix?.personas || {});
  return (
    <div className="mx-gm-hosts">
      <aside className="mx-gm-hostlist">
        {hosts.map((h) => {
          const n = personas.filter((p) => p.online && p.hostId === h.id).length;
          return (
            <button type="button" key={h.id} className={'mx-gm-hostbtn' + (h.id === selected ? ' on' : '') + (h.alert === 'active' ? ' alert' : '')} onClick={() => onSelect(h.id)}>
              <span className="grow">
                <b>{h.name}</b>
                <small className="faint">
                  {h.folder ? `${h.folder} · ` : ''}
                  {t('indice {n}', { n: h.rating })} · {h.attack}/{h.sleaze}/{h.dataProcessing}/{h.firewall}
                </small>
              </span>
              {h.alert === 'active' && <Badge color="red">{t('alerte')}</Badge>}
              {!h.visible && (
                <span className="faint small" title={t('Invisible des joueurs')}>
                  ◌
                </span>
              )}
              {n > 0 && <Badge color="cyan">{n}</Badge>}
            </button>
          );
        })}
        <NewHost onCreated={onSelect} />
      </aside>
      <section className="mx-gm-hostmain">
        {cur ? <HostEditor key={cur.id} game={game} host={cur} onDeleted={() => onSelect(null)} /> : <Empty>{t('Choisis un hôte à gauche, ou crée-en un depuis un profil standard.')}</Empty>}
      </section>
    </div>
  );
}
