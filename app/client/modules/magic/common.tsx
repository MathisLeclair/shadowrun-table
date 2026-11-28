// Magic tab helpers shared with the sheet: awakened actors, roll labels, tradition picker, « open the Magic tab ».
import { useCatalog, send } from '../../lib/net.ts';
import { setUI, useLang } from '../../lib/ui-store.ts';
import { Select } from '../../lib/ui.tsx';
import { t, attrShort } from '../../lib/i18n.ts';
import { isAwakened, drainAttr, traditionName, findTradition, sortTraditions, DRAIN_ATTRS, type TraditionDef } from '/shared/magic.ts';
import type { Actor, ActorTradition, AttrKey, GameView, ViewActor } from '../../../shared/types.ts';

export const isGM = (game: GameView): boolean => game.me?.role === 'gm';
export const isFullActor = (a: ViewActor | null | undefined): a is Actor => !!a && 'attributes' in a;

/** Awakened characters the user may pilot: GM = every active one (PCs first), player = their own. */
export function magicActors(game: GameView): Actor[] {
  const gm = isGM(game);
  const own = new Set(game.me?.characterIds || []);
  return Object.values(game.actors || {})
    .filter((a): a is Actor => isFullActor(a) && isAwakened(a) && (gm ? !a.retired : own.has(a.id)))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'pc' ? -1 : 1));
}

// Roll labels are stored in French in the log (formats rollLabel() of sheet/common.tsx recognises and translates).
export const drainRollLabel = (k: string): string => `Résistance au drain (VOL + ${k})`; // i18n-ignore
export const spellRollLabel = (name: string): string => `Sort — ${name}`; // i18n-ignore

/** Open the Magic tab on a character (key magicFocus = { actorId, nonce } of the UI store). */
export function openMagic(actorId: string) {
  setUI({ mainTab: 'magic', sheetActorId: null, magicFocus: { actorId, nonce: Date.now() } });
}

/** Name of a tradition in the UI language. */
export function useTraditionName(): (tr: ActorTradition | TraditionDef | null | undefined) => string {
  const lang = useLang();
  return (tr) => traditionName(tr, lang);
}

/**
 * The actor's tradition: a picker while it can be changed (GM always; the owner while none is chosen, or to choose the
 * drain attribute of a Custom tradition), else its name. Sends `magic/setTradition`.
 */
export function TraditionPicker({ game, actor, compact }: { game: GameView; actor: Actor; compact?: boolean }) {
  const list = useCatalog<TraditionDef>('traditions');
  const name = useTraditionName();
  const lang = useLang();
  const gm = isGM(game);
  const own = gm || (game.me?.characterIds || []).includes(actor.id);
  const cur = actor.magic?.tradition || null;
  const drain = drainAttr(actor);
  const canPick = own && (gm || !cur);
  const canDrain = own && !!cur && (gm || !cur.drain);
  const curDef = cur ? findTradition(list, cur.id || cur.name) : null;
  const setTradition = (ref: string) => {
    if (!ref && !gm) return;
    void send('magic/setTradition', { actorId: actor.id, tradition: ref || null }).catch(() => null);
  };
  const setDrain = (k: string) => {
    if (cur) void send('magic/setTradition', { actorId: actor.id, tradition: cur.id || cur.name, drain: k || null }).catch(() => null);
  };
  const options = [
    { value: '', label: gm && cur ? t('— None —') : t('— Choose a tradition —') },
    ...sortTraditions(list, lang).map((d) => ({ value: d.id, label: d.drain ? `${name(d)} (${attrShort('WIL')} + ${attrShort(d.drain)})` : name(d) })),
  ];
  // A hand-made / imported tradition missing from the catalog stays selectable.
  if (cur && !curDef) options.push({ value: cur.id || cur.name, label: name(cur) });
  return (
    <span className={'mg-tradition' + (compact ? ' compact' : '')}>
      {canPick ? (
        <Select value={cur ? curDef?.id || cur.id || cur.name : ''} onChange={setTradition} options={options} title={t('Tradition: sets the Drain attribute and the spirits you summon (SR5 p. 279)')} />
      ) : cur ? (
        <b title={cur.source ? `${cur.source}${cur.page ? ' ' + cur.page : ''}` : undefined}>{name(cur)}</b>
      ) : (
        <span className="muted">{t('No tradition')}</span>
      )}
      {cur && (canDrain && !curDef?.drain && (gm || !drain) ? (
        <Select
          value={drain || ''}
          onChange={setDrain}
          options={[{ value: '', label: t('Drain: choose…') }, ...DRAIN_ATTRS.map((k) => ({ value: k, label: `${attrShort('WIL')} + ${attrShort(k)}` }))]}
          title={t('Attribute added to Willpower to resist Drain')}
        />
      ) : drain ? (
        <span className="muted small">{t('Drain {wil} + {attr}', { wil: attrShort('WIL'), attr: attrShort(drain as AttrKey) })}</span>
      ) : null)}
    </span>
  );
}
