// Full SR5 character sheet (« dossier » look). Rendered in the global sheet modal and in « Ma fiche ».
// <SheetView game actorId /> — GM can toggle « Modifier » to edit everything; owners edit their allowed fields.
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, Tabs, Toggle, Badge, TextInput, NumberInput, Select, Empty, confirmAction } from '../../lib/ui.tsx';
import { send, upload, api } from '../../lib/net.ts';
import { setUI, toast } from '../../lib/ui-store.ts';
import { derive, METATYPES } from '/shared/sr5.ts';
import { derivedWithModifiers } from '/shared/modifiers.ts';
import { t, fmtNuyen, metatypeLabel } from '../../lib/i18n.ts';
import { isGM, ownsActor, isRestricted, ownerOf, actorStatus, statusColor, statusLabel, Avatar, fmtNum, cssVars } from './common.tsx';
import { RollDialog } from './RollDialog.tsx';
import { SummaryTab } from './tab-summary.tsx';
import { SkillsTab } from './tab-skills.tsx';
import { CombatTab } from './tab-combat.tsx';
import { MagicTab, MatrixTab, GearTab, ContactsTab, QualitiesTab, NotesTab, HistoryTab, NpcTab } from './tab-misc.tsx';
import { InventoryTab } from './tab-inventory.tsx';
import { slugify } from './sheet-data.ts';
import { ChummerSheetBar } from '../chummer/ChummerActions.tsx';
import { useDerivedModifiers, useEffectsLookup } from './modifiers-ui.tsx';

import type { GameView } from '../../lib/net.ts';
import type { Actor, NpcStub } from '../../../shared/types.ts';
import type { ActorPatch, RollPreset, SheetCtx } from './types.ts';
import './sheet.css';

function Portrait({ actor, canEdit }: { actor: Actor; canEdit: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast(t('Choose an image (png, jpg, webp…)'), 'warn');
    setBusy(true);
    try {
      const { url } = await upload(file);
      await send('actor/update', { actorId: actor.id, patch: { portrait: url } });
      toast(t('Portrait updated'), 'success');
    } catch (err) {
      if ((err as Error)?.message) toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return <div className={'sh-portrait' + (canEdit ? ' editable' : '')} style={cssVars({ '--pc': actor.color || '#3fd6d0' })} onClick={canEdit ? () => input.current?.click() : undefined} title={canEdit ? t('Change the portrait') : ''}>
    <Avatar actor={actor} size={96} />
    {canEdit && <span className="sh-portrait-edit">{busy ? '…' : '⇪'}</span>}
    <input ref={input} type="file" accept="image/*" hidden onChange={pick} />
  </div>;
}

function HeaderBadge({ label, value, color = 'dim', title }: { label: ReactNode; value: ReactNode; color?: string; title?: string }) {
  return <div className={'sh-hbadge sh-hbadge-' + color} title={title}>
    <span className="sh-hbadge-v">{value}</span>
    <span className="sh-hbadge-l">{label}</span>
  </div>;
}

/**
 * Color picker that commits like the native « change » event (when the picker closes), not on every move as React's onChange.
 * Uncontrolled: remounted (key) when the stored color changes.
 */
function ColorInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => commit.current(el.value);
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);
  return <input key={value} ref={ref} type="color" defaultValue={value} />;
}

function Header({ s, game }: { s: SheetCtx; game: GameView }) {
  const { actor, gm, own, edit } = s;
  const owner = ownerOf(game, actor.id);
  const online = owner && (game.online || []).includes(owner.id);
  const status = actorStatus(actor);
  const meta = [metatypeLabel(actor.metatype), actor.age ? t('{age} years old', { age: actor.age }) : '', actor.gender].filter(Boolean).join(' · ');
  return <header className="sh-header" data-id={String(actor.id).slice(-6).toUpperCase()} style={cssVars({ '--pc': actor.color || '#3fd6d0' })}>
    <Portrait actor={actor} canEdit={own} />
    <div className="sh-ident">
      {edit
        ? <div className="sh-ident-edit">
          <TextInput className="sh-name-input" value={actor.name} onChange={(v) => v.trim() && s.update({ name: v })} />
          <div className="row wrap">
            <Select value={actor.metatype} options={Object.keys(METATYPES).map((m) => ({ value: m, label: metatypeLabel(m) }))} onChange={(v) => s.update({ metatype: v })} style={{ width: 'auto' }} />
            <NumberInput small value={actor.age || 0} min={0} max={300} onChange={(v) => s.update({ age: v })} />
            <TextInput value={actor.gender || ''} placeholder={t('Gender')} onChange={(v) => s.update({ gender: v })} style={{ maxWidth: '110px' }} />
            <TextInput value={actor.player || ''} placeholder={t('Player (real name)')} onChange={(v) => s.update({ player: v })} style={{ maxWidth: '160px' }} />
          </div>
        </div>
        : <><h2 className="sh-name">{actor.name}</h2><div className="sh-meta">{meta}</div></>}
      {own && !edit
        ? <TextInput className="sh-concept-input" value={actor.concept || ''} placeholder={t('Character concept')} onChange={(v) => s.update({ concept: v })} />
        : edit
          ? <TextInput className="sh-concept-input" value={actor.concept || ''} placeholder={t('Concept')} onChange={(v) => s.update({ concept: v })} />
          : actor.concept && <div className="sh-concept">{actor.concept}</div>}
      <div className="sh-meta row wrap gap-s">
        {actor.type === 'pc'
          ? <>
            <span>{t('Player:')}{' '}<b>{actor.player || owner?.name || '—'}</b></span>
            {owner && <span className={'sh-online' + (online ? ' on' : '')} title={online ? t('Connected') : t('Offline')}>{owner.name}</span>}
          </>
          : <><Badge color="red">{t('NPC')}</Badge>{actor.hidden ? <Badge>{t('hidden')}</Badge> : null}</>}
        {actor.retired && <Badge color="amber">{t('Retired')}</Badge>}
        <Badge color={statusColor(status)}>{statusLabel(status)}</Badge>
        {own && <label className="sh-color" title={t('Token color')}>
          <ColorInput value={actor.color || '#3fd6d0'} onCommit={(v) => s.update({ color: v })} />
        </label>}
      </div>
    </div>
    <div className="sh-hbadges">
      {edit
        ? <>
          <div className="field">
            <span className="field-label">{t('Street Cred')}</span>
            <NumberInput small value={actor.streetCred || 0} min={0} max={99} onChange={(v) => s.update({ streetCred: v })} />
          </div>
          <div className="field">
            <span className="field-label">{t('Notoriety')}</span>
            <NumberInput small value={actor.notoriety || 0} min={0} max={99} onChange={(v) => s.update({ notoriety: v })} />
          </div>
          <div className="field">
            <span className="field-label">{t('Public Awareness')}</span>
            <NumberInput small value={actor.publicAwareness || 0} min={0} max={99} onChange={(v) => s.update({ publicAwareness: v })} />
          </div>
        </>
        : <>
          <HeaderBadge label={t('Karma')} value={actor.karma ?? 0} color="amber" title={t('Career karma: {n}', { n: actor.karmaTotal ?? 0 })} />
          <HeaderBadge label={t('Nuyen')} value={fmtNuyen(actor.nuyen ?? 0)} color="cyan" />
          <HeaderBadge label={t('Street Cred')} value={actor.streetCred ?? 0} color="magenta" />
          {actor.notoriety ? <HeaderBadge label={t('Notoriety')} value={actor.notoriety} color="red" /> : null}{actor.publicAwareness ? <HeaderBadge label={t('Public Awareness')} value={actor.publicAwareness} /> : null}
          <HeaderBadge label={t('Essence')} value={fmtNum(Math.round(s.d.essence * 100) / 100)} />
        </>}
    </div>
  </header>;
}

function GmToolbar({ s }: { s: SheetCtx }) {
  const { actor, edit, setEdit } = s;
  const dup = async () => {
    try {
      const id = await send<string>('actor/duplicate', { actorId: actor.id });
      setUI({ sheetActorId: id });
      toast(t('Copy created'), 'success');
    } catch {}
  };
  const exp = async () => {
    try {
      const data = await api(`/api/actors/${encodeURIComponent(actor.id)}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${slugify(actor.name)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (err) {
      toast((err as Error).message || t('Export failed'), 'error');
    }
  };
  const del = async () => {
    if (!(await confirmAction(t('Permanently delete {name}? Their tokens and initiative entry will be removed too.', { name: actor.name })))) return;
    try {
      await send('actor/delete', { actorId: actor.id });
      setUI({ sheetActorId: null });
      toast(t('{name} deleted', { name: actor.name }), 'success');
    } catch {}
  };
  return <div className="sh-gmbar">
    <Toggle value={edit} onChange={setEdit} label={t('Edit')} title={t('GM edit mode')} />
    <div className="row wrap gap-s">
      <Button small variant="ghost" onClick={dup}>{t('Duplicate')}</Button>
      <Button small variant="ghost" onClick={exp}>{t('Export')}</Button>
      {actor.type === 'pc' && <Button small variant="ghost" onClick={() => s.update({ retired: !actor.retired })}>
        {actor.retired ? t('Reactivate') : t('Retire')}
      </Button>}
      <Button small variant="danger" onClick={del}>{t('Delete')}</Button>
    </div>
  </div>;
}

function RestrictedView({ actor }: { actor: NpcStub | Actor }) {
  const status = actorStatus(actor);
  return <div className="sh-restricted" style={cssVars({ '--pc': actor.color || '#e05c5c' })}>
    <Avatar actor={actor} size={96} />
    <div>
      <h2 className="sh-name">{actor.name}</h2>
      <div className="sh-meta">{actor.metatype ? metatypeLabel(actor.metatype) : t('Unknown')}</div>
      <div className="row wrap" style={{ marginTop: '8px' }}><Badge color={statusColor(status)}>{statusLabel(status)}</Badge></div>
      <p className="muted small">{t('Confidential sheet — only the GM knows their abilities.')}</p>
    </div>
  </div>;
}

export default function SheetView({ game, actorId }: { game: GameView; actorId: string }) {
  const [tab, setTab] = useState('summary');
  const [edit, setEdit] = useState(false);
  const [rollPreset, setRollPreset] = useState<RollPreset | null>(null);
  const viewActor = game?.actors?.[actorId];
  const actor = viewActor && !isRestricted(viewActor) ? (viewActor as Actor) : null;
  // Modifiers of the actor's gear, qualities, powers, implants (shared/modifiers.js): s.mods, s.dm = derive() + modifiers.
  const { mods, dm } = useDerivedModifiers(actor);
  const lookup = useEffectsLookup();
  if (!viewActor) return <Empty>{t('Character not found (deleted?).')}</Empty>;
  if (!actor) return <RestrictedView actor={viewActor} />;

  const gm = isGM(game);
  const own = ownsActor(game, actor.id);
  const s: SheetCtx = {
    game, actor, gm, own, d: derive(actor), dm: dm || derivedWithModifiers(actor, []), mods, lookup,
    edit: gm && edit, setEdit,
    roll: own ? (preset: RollPreset) => setRollPreset({ ...preset, _k: Date.now() }) : () => toast(t('You can only roll for your own character'), 'warn'),
    update: (patch: ActorPatch) => send('actor/update', { actorId: actor.id, patch }).catch(() => {}),
  };
  const showMagic = s.edit || (actor.attributes.MAG !== undefined && actor.attributes.MAG !== null) || (actor.powers || []).length || (actor.spells || []).length;
  const showMatrix = s.edit || !!actor.matrix || (actor.complexForms || []).length > 0;
  const tabs = ([
    { id: 'summary', label: t('Summary') },
    { id: 'skills', label: t('Skills') },
    { id: 'combat', label: t('Combat') },
    showMagic && { id: 'magic', label: t('Magic') },
    showMatrix && { id: 'matrix', label: t('Matrix') },
    { id: 'gear', label: t('Gear') },
    !s.edit && { id: 'inventory', label: t('Inventory') },
    { id: 'contacts', label: t('Contacts & SIN') },
    { id: 'qualities', label: t('Qualities') },
    { id: 'notes', label: t('Notes') },
    { id: 'history', label: t('History') },
    gm && actor.type === 'npc' && { id: 'npc', label: t('NPC') },
  ] as Array<{ id: string; label: string } | false>).filter((x): x is { id: string; label: string } => !!x);
  const current = tabs.find((x) => x.id === tab) ? tab : 'summary';
  const body = ({
    summary: () => <SummaryTab s={s} />,
    skills: () => <SkillsTab s={s} />,
    combat: () => <CombatTab s={s} />,
    magic: () => <MagicTab s={s} />,
    matrix: () => <MatrixTab s={s} />,
    gear: () => <GearTab s={s} />,
    inventory: () => <InventoryTab s={s} />,
    contacts: () => <ContactsTab s={s} />,
    qualities: () => <QualitiesTab s={s} />,
    notes: () => <NotesTab s={s} />,
    history: () => <HistoryTab s={s} />,
    npc: () => <NpcTab s={s} game={game} />,
  } as Record<string, () => ReactNode>)[current];

  return <div className={'sh-sheet' + (s.edit ? ' sh-editing' : '')} style={cssVars({ '--pc': actor.color || '#3fd6d0' })}>
    {gm && <GmToolbar s={s} />}
    <Header s={s} game={game} />
    {own && <ChummerSheetBar game={game} actor={actor} />}{!own && !gm && <div className="sh-readonly muted small">{t('Teammate\'s sheet — read only.')}</div>}
    <Tabs className="sh-tabs" tabs={tabs} value={current} onChange={setTab} />
    <div className="sh-body" key={current}>{body()}</div>
    {rollPreset && <RollDialog key={rollPreset._k} game={game} actor={actor} preset={rollPreset} onClose={() => setRollPreset(null)} />}
  </div>;
}
