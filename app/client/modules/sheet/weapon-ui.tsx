// Weapons on the sheet: loaded rounds « 12/15 » with the reload button (weapon/reload, rounds from the inventory), the reload
// chooser, fire modes and ready / stowed weapons. Rules: ./inventory.js (shared with the server, which stays the authority).
import { useState, type MouseEvent } from 'react';
import { Button, IconButton, Toggle } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { attr } from '/shared/sr5.ts';
import { t, tk, tn, getLang } from '../../lib/i18n.ts';
import { Overlay, itemLabel, itemTitle, modeLabel } from './common.tsx';
import {
  usesAmmo, isGrenade, ammoFits, clipFits, reloadPlan, isCarried, containerOf, fireOptions, AMMO_TYPE_LABELS, MODE_SHORT_FR, readyCount, ON_BODY,
  ammoKindOf, sameAmmoKind, magazines, type AmmoInfo,
} from './inventory.ts';
import type { Actor, AmmoKind, Gear, Weapon } from '../../../shared/types.ts';
import type { SheetCtx } from './types.ts';

/** A fire option of inventory.js fireOptions(). */
export type FireOption = ReturnType<typeof fireOptions>[number];
/** Reply of 'weapon/reload'. */
interface ReloadReply {
  swap?: boolean;
  ammoLoaded: number;
  max: number;
  loaded: number;
  action: string;
  dropped?: number;
}

const ACTION_LABELS: Record<string, string> = { simple: tk('Simple Action'), complex: tk('Complex Action') };
export const actionLabel = (a: string): string => t(ACTION_LABELS[a] || a);

/** Short label of a fire option in the UI language: « TR (3) », « TA complexe (10) »… */
const FIRE_SHORT: Record<string, string> = {
  SS: tk('Single shot'), SA: tk('Semi-automatic'), SB: tk('Semi-automatic burst'), BF: tk('Burst fire'), LB: tk('Long burst'),
  FA: tk('Full auto (Simple Action)'), FAC: tk('Full auto (Complex Action)'), SUP: tk('Suppressive fire'),
};
export function fireLabel(o: FireOption): string {
  const code = getLang() === 'fr' ? (MODE_SHORT_FR as Record<string, string>)[o.mode] : o.mode;
  return t('{code} — {name} ({n})', { code, name: t(FIRE_SHORT[o.id] || o.label), n: tn(o.rounds, '{n} round', '{n} rounds') });
}

/** Name of the loaded ammunition (« Balles ADPS »). */
export function ammoKindLabel(k: AmmoKind | null | undefined): string {
  if (!k) return '';
  return (getLang() === 'fr' ? k.nameFr : k.name) || k.name || k.nameFr || '';
}

/** Inventory items that can reload this weapon now: ammo boxes (carried or in a bag) — the server picks the same way. */
export function reloadSources(actor: Actor, w: Weapon): Gear[] {
  const reach = (g: Gear) => (isCarried(actor, g.location) ? 0 : containerOf(actor, g.location)?.kind === 'bag' ? 1 : 2);
  return (actor.gear || []).filter((g) => g && Number(g.qty ?? 1) > 0 && reach(g) < 2 && ammoFits(g, w)).sort((a, b) => reach(a) - reach(b) || Number(b.qty ?? 1) - Number(a.qty ?? 1));
}
const spareClip = (actor: Actor, w: Weapon, kind: AmmoInfo['kind'] = 'clip'): Gear | undefined => (actor.gear || []).find((g) => g && Number(g.qty ?? 1) > 0 && (isCarried(actor, g.location) || containerOf(actor, g.location)?.kind === 'bag') && clipFits(g, w, kind));

/** Reload (one action): toast with the action type; errors are toasted by send(). */
async function doReload(actor: Actor, w: Weapon, sourceItemId?: string | null, free?: boolean): Promise<ReloadReply | null> {
  try {
    const r = await send<ReloadReply>('weapon/reload', { actorId: actor.id, weaponId: w.id, ...(sourceItemId ? { sourceItemId } : {}), ...(free ? { free: true } : {}) });
    toast(r.swap
      ? t('Clip changed: {loaded}/{max} — {action}', { loaded: r.ammoLoaded, max: r.max, action: actionLabel(r.action) })
      : t('+{n} → {loaded}/{max} — {action}', { n: r.loaded, loaded: r.ammoLoaded, max: r.max, action: actionLabel(r.action) }), 'success');
    if (r.dropped) toast(tn(r.dropped, '{n} round of the old type lost (no box to put it in)', '{n} rounds of the old type lost (no box to put them in)'), 'warn');
    return r;
  } catch {
    return null;
  }
}

/** Reply of 'weapon/switchMagazine'. */
interface SwitchReply {
  activeSlot: number;
  slots: number;
  ammoLoaded: number;
  max: number;
}

/** Switch to the next magazine (Additional Clip/Magazine: Beretta Northstar…), a Free Action. */
async function doSwitch(actor: Actor, w: Weapon): Promise<void> {
  try {
    const r = await send<SwitchReply>('weapon/switchMagazine', { actorId: actor.id, weaponId: w.id });
    toast(t('Magazine {slot}/{n}: {loaded}/{max} — {action}', { slot: r.activeSlot + 1, n: r.slots, loaded: r.ammoLoaded, max: r.max, action: t('Free Action') }), 'success');
  } catch {}
}

/** One line per magazine: « Magazine 1: 4/6 Regular Ammo (in use) ». */
function magazineLines(w: Weapon): string[] {
  const mags = magazines(w) || [];
  const active = Number(w.activeSlot) || 0;
  return mags.map((m, i) => t(i === active ? 'Magazine {slot}: {loaded}/{max} {ammo} (in use)' : 'Magazine {slot}: {loaded}/{max} {ammo}', { slot: i + 1, loaded: m.loaded, max: w.ammoMax ?? 0, ammo: ammoKindLabel(m.ammoKind) }));
}

/** Reload chooser: compatible ammunition in the inventory (with where it is), spare clip / speed loader, action type; GM « free » reload. */
export function ReloadDialog({ actor, w, gm, onClose }: { actor: Actor; w: Weapon; gm: boolean; onClose: () => void }) {
  const sources = reloadSources(actor, w);
  const clip = spareClip(actor, w, 'clip');
  const loader = w.ammoType === 'cy' ? spareClip(actor, w, 'loader') : null;
  const plan = reloadPlan(w, { agi: attr(actor, 'AGI'), clip: !!clip, loader: !!loader });
  const where = (g: Gear) => (g.location && g.location !== ON_BODY ? containerOf(actor, g.location)?.name || '' : t('carried'));
  const go = async (id: string | null, free?: boolean) => {
    if (await doReload(actor, w, id, free)) onClose();
  };
  const mags = magazines(w);
  const per = Number.isFinite(plan.perAction) ? tn(plan.perAction, '{n} round per action', '{n} rounds per action') : t('full reload');
  return <Overlay title={t('Reload — {weapon}', { weapon: itemLabel(w) })} onClose={onClose} width={460}>
    <div className="col gap-s">
      <div className="row wrap gap-s">
        <span className="badge badge-cyan mono">{w.ammoLoaded ?? 0}/{w.ammoMax}</span>
        {w.ammoType && (AMMO_TYPE_LABELS as Record<string, string>)[w.ammoType] ? <span className="badge">{t((AMMO_TYPE_LABELS as Record<string, string>)[w.ammoType])}</span> : null}{w.ammoKind ? <span className="muted small">{t('Loaded: {ammo}', { ammo: ammoKindLabel(w.ammoKind) })}</span> : null}
      </div>
      {mags ? <div className="muted small">{t('Reloads the magazine in use ({slot}/{n}); switch magazines first to reload the other one.', { slot: (Number(w.activeSlot) || 0) + 1, n: mags.length })}</div> : null}
      <div className="muted small">
        {plan.swap
        ? t('Clip change ({clip}): {action}.', { clip: itemLabel(clip || loader), action: actionLabel(plan.action) })
        : t('Loose rounds: {action}, {per}.', { action: actionLabel(plan.action), per })}
      </div>
      {sources.length
        ? <div className="sh-list">
          {sources.map((g) => <div className="sh-list-row" key={g.id}>
            <div className="grow">
              <b title={itemTitle(g)}>{itemLabel(g)}</b>
              {' '}
              <span className="faint small">{where(g)}</span>
              {Number(w.ammoLoaded) > 0 && w.ammoKind && !sameAmmoKind(ammoKindOf(g), w.ammoKind)
                ? <div className="amber small">
                  {tn(Number(w.ammoLoaded), 'Other ammunition: the loaded round is taken out.', 'Other ammunition: the {n} loaded rounds are taken out.')}
                </div> : null}
            </div>
            <span className="mono">×{g.qty ?? 1}</span>
            <Button small variant="primary" onClick={() => go(g.id)}>{t('Reload')}</Button>
          </div>)}
        </div>
        : <div className="amber small">{t('No compatible ammunition carried or in a bag.')}</div>}
      {gm && <div className="row">
        <Button small variant="ghost" onClick={() => go(null, true)} title={t('Fills the weapon without touching the inventory')}>
          {t('Reload without ammunition (GM)')}
        </Button>
      </div>}
    </div>
  </Overlay>;
}

/** « 12/15 » + reload button for weapons with a magazine, « ×2 » for grenades, the ammo text otherwise. */
export function AmmoCell({ s, w }: { s: SheetCtx; w: Weapon }) {
  const [open, setOpen] = useState(false);
  if (isGrenade(w)) return <span className={'mono' + (Number(w.qty ?? 1) <= 0 ? ' red' : '')} title={t('Units (throwing uses one)')}>×{w.qty ?? 1}</span>;
  if (!usesAmmo(w)) return <span className="muted">{w.ammo || '—'}</span>;
  const left = Number(w.ammoLoaded ?? w.ammoMax) || 0;
  const cap = Number(w.ammoMax) || 0;
  const reload = (e: MouseEvent) => {
    e.stopPropagation();
    const src = reloadSources(s.actor, w);
    // One click reloads only when nothing can be lost: the single source holds the loaded ammunition, or the weapon is empty.
    // Another ammunition while rounds are loaded (they would be swapped out): the chooser asks first.
    const swaps = src.length === 1 && left > 0 && w.ammoKind && !sameAmmoKind(ammoKindOf(src[0]), w.ammoKind);
    if (src.length === 1 && !s.gm && !swaps) doReload(s.actor, w, src[0].id);
    else setOpen(true);
  };
  const mags = magazines(w);
  const title = [t('Clip: {ammo}', { ammo: w.ammo }), ...(mags ? magazineLines(w) : [w.ammoKind ? t('Loaded: {ammo}', { ammo: ammoKindLabel(w.ammoKind) }) : ''])].filter(Boolean).join('\n');
  const swap = (e: MouseEvent) => {
    e.stopPropagation();
    doSwitch(s.actor, w);
  };
  return <span className="sh-ammo">
    <span className={'mono' + (left === 0 ? ' red' : left <= cap / 4 ? ' amber' : '')} title={title}>{left}/{cap}</span>
    {mags ? <span className="badge mono" title={title}>{t('M{slot}/{n}', { slot: (Number(w.activeSlot) || 0) + 1, n: mags.length })}</span> : null}
    {s.own && mags ? <IconButton icon="⇄" title={t('Switch magazine (Free Action)')} onClick={swap} /> : null}
    {s.own && <IconButton icon="↻" title={t('Reload')} disabled={left >= cap && !s.gm} onClick={reload} />}{open && <ReloadDialog actor={s.actor} w={w} gm={s.gm} onClose={() => setOpen(false)} />}
  </span>;
}

/** Ready / stowed switch (owner) or badge. Readying a weapon stored in a bag takes it out (server). */
export function ReadyToggle({ s, w }: { s: SheetCtx; w: Weapon }) {
  const ready = w.equipped !== false;
  if (!s.own) return <span className={'badge ' + (ready ? 'badge-cyan' : '')}>{ready ? t('ready') : t('stowed')}</span>;
  const set = async (v: boolean) => {
    try {
      await send('actor/updateItem', { actorId: s.actor.id, list: 'weapons', itemId: w.id, patch: { equipped: v } });
      if (v) {
        const c = readyCount({ ...s.actor, weapons: s.actor.weapons.map((x) => (x.id === w.id ? { ...x, equipped: true } : x)) });
        if (c.over) toast(t('Many ready weapons ({ranged} ranged, {melee} melee): usually 2 + 2 at most.', c), 'warn');
      }
    } catch {}
  };
  return <Toggle value={ready} onChange={set} title={ready ? t('Ready — click to stow it') : t('Stowed — click to ready it')} />;
}

/** Fire options of a weapon as Select options (value = option id). */
export const fireSelectOptions = (w: Weapon): Array<{ value: string; label: string }> => fireOptions(w).map((o) => ({ value: o.id, label: fireLabel(o) }));
export { modeLabel };
