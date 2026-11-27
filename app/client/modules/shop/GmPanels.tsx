// GM-only panels: shop settings and the fixer specials editor (« Offres de Cabana »).
import { useState } from 'react';
import { Button, Badge, Empty, Panel, Field, TextInput, NumberInput, Select, Toggle, confirmAction } from '../../lib/ui.tsx';
import { send, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, skillLabel } from '../../lib/i18n.ts';
import { SKILLS } from '/shared/sr5.ts';
import { SHOP_FILES, FILE_LABELS, GRADE_IDS, UPGRADE_FILES } from './rules.ts';
import { nuyen, gradeLabel } from './common.tsx';
import type { Actor, CatalogFile, GameView, ShopSpecial, ShopState } from '../../../shared/types.ts';
import type { LooseStats } from './types.ts';

/** Settings patch of 'shop/updateSettings' (categories are merged by the server). */
type SettingsPatch = Partial<Omit<ShopState, 'categories'>> & { categories?: Partial<Record<CatalogFile, boolean>> };
const settings = (patch: SettingsPatch) => send('shop/updateSettings', patch).catch(() => {});
/** Shop section label ('weapons' → « Armes »), translated. */
const fileLabel = (f: string) => ((FILE_LABELS as Record<string, string>)[f] ? t((FILE_LABELS as Record<string, string>)[f]) : f);
const SHOP_FILE_LIST = SHOP_FILES as CatalogFile[];

export function SettingsPanel({ game }: GameProps) {
  const s: Partial<ShopState> = game.shop || {};
  return (
    <div className="shop-settings grid-2">
      <Panel title={t('Boutique')}>
        <div className="col gap-l">
          <Toggle value={s.open} onChange={(v) => settings({ open: v })} label={s.open ? t('Ouverte — Cabana répond') : t('Fermée — Cabana injoignable')} />
          <div className="row wrap gap-l">
            <Field label={t('Marge de Cabana (%)')} hint={t('Appliquée aux prix catalogue (pas aux offres)')}>
              <NumberInput value={s.markup} min={-90} max={500} step={5} onChange={(v) => settings({ markup: v })} />
            </Field>
            <Field label={t('Taux de revente (%)')} hint={t('Part du prix payé rendue au runner')}>
              <NumberInput value={s.sellRate} min={0} max={100} step={5} onChange={(v) => settings({ sellRate: v })} />
            </Field>
            <Field label={t('Disponibilité max')} hint={t('Au-delà, achat impossible pour les joueurs')}>
              <NumberInput value={s.maxAvail} min={0} max={40} onChange={(v) => settings({ maxAvail: v })} />
            </Field>
          </div>
        </div>
      </Panel>
      <Panel title={t('Légalité & validation')}>
        <div className="col gap-l">
          <Toggle value={s.allowRestricted} onChange={(v) => settings({ allowRestricted: v })} label={t('Autoriser le matériel restreint (R)')} />
          <Toggle value={s.allowForbidden} onChange={(v) => settings({ allowForbidden: v })} label={t('Autoriser le matériel interdit (F)')} />
          <Field label={t('Validation par le MJ')}>
            <Select
              value={s.approval}
              onChange={(v) => settings({ approval: v })}
              options={[
                { value: 'never' as const, label: t('Jamais — les achats sont immédiats') },
                { value: 'restricted' as const, label: t('Objets R/F et prix négociés') },
                { value: 'always' as const, label: t('Toujours — chaque achat et revente') },
              ]}
            />
          </Field>
          <div className="row wrap gap-l">
            <Field label={t('Test de disponibilité')} hint={t('Négociation + Charisme [Social] contre la dispo (SR5 p. 418)')}>
              <Select
                value={s.availTest || 'required'}
                onChange={(v) => settings({ availTest: v })}
                options={[
                  { value: 'required' as const, label: t('Obligatoire — trouver l’objet avant de l’acheter') },
                  { value: 'helper' as const, label: t('Facultatif — proposé dans le panier') },
                  { value: 'off' as const, label: t('Désactivé') },
                ]}
              />
            </Field>
            <Field label={t('Sans test jusqu’à dispo')} hint={t('0 = tout objet avec une dispo')}>
              <NumberInput value={s.availFree || 0} min={0} max={40} onChange={(v) => settings({ availFree: v })} />
            </Field>
          </div>
        </div>
      </Panel>
      <Panel title={t('Rayons ouverts')}>
        <div className="shop-cat-toggles">
          {SHOP_FILE_LIST.map((f) => (
            <Toggle key={f} value={s.categories?.[f] !== false} onChange={(v) => settings({ categories: { [f]: v } })} label={fileLabel(f)} />
          ))}
        </div>
        <div className="faint small">{t('Les offres de Cabana restent visibles même si leur rayon est fermé.')}</div>
      </Panel>
    </div>
  );
}

const fileOptions = () => SHOP_FILE_LIST.filter((f) => f !== 'lifestyles' && !(UPGRADE_FILES as Record<string, unknown>)[f]).map((f) => ({ value: f, label: fileLabel(f) }));
const skillOptions = () => SKILLS.filter((s: { cat: string }) => s.cat === 'combat').map((s: { id: string }) => ({ value: s.id, label: skillLabel(s) }));

/** Patch of 'shop/updateSpecial' (essence is sent as typed, the server parses it). */
type SpecialPatch = Partial<Omit<ShopSpecial, 'essence' | 'stats'>> & { essence?: number | string | null; stats?: LooseStats };

function SpecialEditor({ sp, game }: { sp: ShopSpecial; game: GameView }) {
  const upd = (patch: SpecialPatch) => send('shop/updateSpecial', { id: sp.id, patch }).catch(() => {});
  const pcs = Object.values(game.actors || {}).filter((a): a is Actor => a.type === 'pc' && !(a as Actor).retired);
  const ware = sp.file === 'cyberware' || sp.file === 'bioware';
  const st: LooseStats = sp.stats || {};
  const updStats = (patch: LooseStats) => upd({ stats: { ...st, ...patch } });
  const reserved = sp.forActorIds || [];
  const unlimited = sp.stock === null || sp.stock === undefined;
  return (
    <div className="shop-special-edit">
      <div className="grid-2">
        <Field label={t('Nom')}>
          <TextInput value={sp.name} onChange={(v) => upd({ name: v })} />
        </Field>
        <Field label={t('Catégorie affichée')}>
          <TextInput value={sp.category} onChange={(v) => upd({ category: v })} />
        </Field>
      </div>
      <div className="row wrap gap-l">
        <Field label={t('Rayon (livré dans)')}>
          <Select value={sp.file || 'gear'} onChange={(v) => upd({ file: v })} options={fileOptions()} />
        </Field>
        <Field label={t('Prix (¥)')}>
          <NumberInput value={sp.cost} min={0} step={50} onChange={(v) => upd({ cost: v })} />
        </Field>
        <Field label={t('Prix barré (¥)')} hint={t('0 = aucun')}>
          <NumberInput value={sp.originalCost || 0} min={0} step={50} onChange={(v) => upd({ originalCost: v || null })} />
        </Field>
        <Field label={t('Dispo')} hint={t('ex. 8R')}>
          <TextInput className="shop-short" value={sp.avail} onChange={(v) => upd({ avail: v })} />
        </Field>
        <Field label={t('Stock')}>
          <div className="row">
            <Toggle value={unlimited} onChange={(v) => upd({ stock: v ? null : 1 })} label={t('illimité')} />
            {!unlimited && <NumberInput small value={sp.stock} min={0} max={999} onChange={(v) => upd({ stock: v })} />}
          </div>
        </Field>
        <Field label={t('Indice')}>
          <NumberInput value={sp.rating || 0} min={0} max={20} onChange={(v) => upd({ rating: v || null })} />
        </Field>
        {ware && (
          <Field label={t('Grade')}>
            <Select value={sp.grade || 'standard'} onChange={(v) => upd({ grade: v })} options={(GRADE_IDS as NonNullable<ShopSpecial['grade']>[]).map((g) => ({ value: g, label: gradeLabel(g) }))} />
          </Field>
        )}
        {ware && (
          <Field label={t('Essence')} hint={t('vide = catalogue')}>
            <TextInput className="shop-short" value={String(sp.essence ?? '')} onChange={(v) => upd({ essence: v === '' ? null : v.replace(',', '.') })} />
          </Field>
        )}
      </div>
      {!sp.catalogRef && sp.file === 'weapons' && (
        <div className="row wrap gap-l shop-stats-edit">
          <Field label={t('Type')}>
            <Select
              value={st.type || 'ranged'}
              onChange={(v) => updStats({ type: v })}
              options={[
                { value: 'melee', label: t('Mêlée') },
                { value: 'ranged', label: t('Distance') },
              ]}
            />
          </Field>
          <Field label={t('Compétence')}>
            <Select value={st.skill || 'pistols'} onChange={(v) => updStats({ skill: v })} options={skillOptions()} />
          </Field>
          <Field label={t('Dégâts')}>
            <TextInput className="shop-short" value={st.damage || ''} onChange={(v) => updStats({ damage: v })} />
          </Field>
          <Field label={t('PA')}>
            <NumberInput small value={Number(st.ap) || 0} min={-20} max={10} onChange={(v) => updStats({ ap: v })} />
          </Field>
          <Field label={t('Précision')}>
            <NumberInput small value={Number(st.accuracy) || 0} min={0} max={12} onChange={(v) => updStats({ accuracy: v })} />
          </Field>
          <Field label={t('Mode')}>
            <TextInput className="shop-short" value={st.mode || ''} onChange={(v) => updStats({ mode: v })} />
          </Field>
          <Field label={t('RC')}>
            <NumberInput small value={Number(st.rc) || 0} min={0} max={12} onChange={(v) => updStats({ rc: v })} />
          </Field>
          <Field label={t('Munitions')}>
            <TextInput className="shop-short" value={st.ammo || ''} onChange={(v) => updStats({ ammo: v })} />
          </Field>
          <Field label={t('Allonge')}>
            <NumberInput small value={Number(st.reach) || 0} min={0} max={4} onChange={(v) => updStats({ reach: v })} />
          </Field>
        </div>
      )}
      {!sp.catalogRef && sp.file === 'armor' && (
        <div className="row wrap gap-l shop-stats-edit">
          <Field label={t('Armure')}>
            <NumberInput small value={Number(st.armor) || 0} min={0} max={30} onChange={(v) => updStats({ armor: v })} />
          </Field>
          <Toggle value={!!st.stack} onChange={(v) => updStats({ stack: v })} label={t('Cumulable (casque, bouclier…)')} />
        </div>
      )}
      <div className="grid-2">
        <Field label={t('Texte de Cabana (vu par les joueurs)')}>
          <TextInput multiline rows={3} value={sp.notes || ''} onChange={(v) => upd({ notes: v })} />
        </Field>
        <Field label={t('Notes MJ (secrètes)')}>
          <TextInput multiline rows={3} value={sp.gmNotes || ''} onChange={(v) => upd({ gmNotes: v })} />
        </Field>
      </div>
      <div className="row wrap gap-l">
        <Toggle value={!!sp.hidden} onChange={(v) => upd({ hidden: v })} label={t('Brouillon (caché aux joueurs)')} />
        <div className="row wrap gap-s">
          <span className="field-label">{t('Réservée à')}</span>
          {pcs.map((a) => (
            <button
              key={a.id}
              className={'shop-chip' + (reserved.includes(a.id) ? ' on' : '')}
              onClick={() => upd({ forActorIds: reserved.includes(a.id) ? reserved.filter((x) => x !== a.id) : [...reserved, a.id] })}
            >
              {a.name}
            </button>
          ))}
          {!reserved.length && <span className="faint small">{t('tout le monde')}</span>}
        </div>
      </div>
    </div>
  );
}

export function SpecialsPanel({ game }: GameProps) {
  const specials = game.shop?.specials || [];
  const [open, setOpen] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await send<{ id?: string }>('shop/addSpecial', { special: { name: t('Nouvelle offre'), category: t('Divers'), file: 'gear', cost: 0, avail: '0', stock: 1, hidden: true } });
      setOpen(r?.id || null);
    } catch {}
  };
  const remove = async (sp: ShopSpecial) => {
    if (!(await confirmAction(t('Supprimer l’offre « {name} » ?', { name: sp.name })))) return;
    try {
      await send('shop/removeSpecial', { id: sp.id });
      toast(t('Offre supprimée'), 'info');
    } catch {}
  };
  const actors = game.actors || {};
  return (
    <div className="shop-specials-admin">
      <div className="row spread wrap">
        <div className="muted small">
          {t('Les offres sont des affaires préparées par Cabana : prix fixes, stock limité, hors limite de disponibilité. Pour partir d’un article du catalogue, utilise « + Offre Cabana » dans sa fiche.')}
        </div>
        <Button variant="primary" onClick={create}>
          {t('+ Nouvelle offre')}
        </Button>
      </div>
      {!specials.length && <Empty>{t('Aucune offre.')}</Empty>}
      {specials.map((sp) => (
        <div className={'card shop-special-admin' + (sp.hidden ? ' draft' : '')} key={sp.id}>
          <div className="row spread wrap">
            <div className="row wrap gap-s">
              <strong className="cyan">{sp.name}</strong>
              <Badge>{fileLabel(sp.file)}</Badge>
              {sp.hidden && <Badge color="amber">{t('Brouillon')}</Badge>}
              {(sp.forActorIds || []).length > 0 && <Badge color="magenta">{t('Pour {names}', { names: (sp.forActorIds || []).map((id) => actors[id]?.name || '?').join(', ') })}</Badge>}
              {sp.stock === 0 && <Badge color="red">{t('Épuisé')}</Badge>}
            </div>
            <div className="row gap-s">
              <span className="mono">{nuyen(sp.cost)}</span>
              <span className="muted small">{sp.stock === null || sp.stock === undefined ? '∞' : t('stock {n}', { n: sp.stock })}</span>
              <Button small variant={open === sp.id ? 'primary' : 'ghost'} onClick={() => setOpen(open === sp.id ? null : sp.id)}>
                {open === sp.id ? t('Fermer') : t('Modifier')}
              </Button>
              <Button small variant="danger" onClick={() => remove(sp)}>
                {t('Supprimer')}
              </Button>
            </div>
          </div>
          {open === sp.id && <SpecialEditor sp={sp} game={game} />}
        </div>
      ))}
    </div>
  );
}
