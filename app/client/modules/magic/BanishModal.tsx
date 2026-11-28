// Banish a spirit (SR5 p. 301): one's own or an enemy's. Banishing + Magic [Astral] vs the spirit's Force (+ its summoner's
// Magic if bound); each net hit removes a service (magic/banish). Opened from the Magic cockpit.
import { useState } from 'react';
import { Modal, Button, NumberInput, Toggle, Select, Badge } from '../../lib/ui.tsx';
import { send, useCatalog } from '../../lib/net.ts';
import { t } from '../../lib/i18n.ts';
import { attr } from '/shared/sr5.ts';
import { drainAttr, type SpiritDef } from '/shared/magic.ts';
import { BookRef } from '../books/BookRef.tsx';
import type { Actor, GameView } from '../../../shared/types.ts';

interface BanishResult {
  hits: number;
  spiritHits: number;
  net: number;
  dv: number;
  drainType: 'P' | 'S';
  drain: { hits: number; damage: number } | { pendingId: string };
  gone: boolean;
  services: number;
}

export default function BanishModal({ game, actor, onClose }: { game: GameView; actor: Actor; onClose: () => void }) {
  const defs = useCatalog<SpiritDef>('spirits');
  const types = new Set(defs.map((d) => d.name));
  // Spirits in view: full sheets with actor.spirit, or NPC stubs whose metatype is a spirit type.
  const candidates = Object.values(game.actors || {}).filter((a) => ('spirit' in a && !!(a as Actor).spirit) || (a.type === 'npc' && types.has(String(a.metatype))));
  const [id, setId] = useState('');
  const target = candidates.find((a) => a.id === id) || candidates[0] || null;
  const [modifier, setModifier] = useState(0);
  const [explode, setExplode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BanishResult | null>(null);
  const banishing = (actor.skills || []).find((s) => s.id === 'banishing')?.rating || 0;
  const mag = attr(actor, 'MAG');
  const go = async () => {
    if (!target) return;
    setBusy(true);
    try {
      setResult(await send<BanishResult>('magic/banish', { actorId: actor.id, spiritId: target.id, modifier, explode }));
    } catch {
    } finally {
      setBusy(false);
    }
  };
  if (result) {
    const d = result.drain;
    return (
      <Modal title={t('Banishing — {name}', { name: target?.name || '' })} onClose={onClose} width={500}>
        <div className="mg-cast-result">
          <div className="mg-cast-big">
            <b>{result.hits}</b> <span>{t('hit(s) against {n} for the spirit', { n: result.spiritHits })}</span>
          </div>
          <div className="mg-cast-drain">
            {result.gone ? t('The spirit is banished.') : result.net > 0 ? t('−{n} service(s): {left} left.', { n: result.net, left: result.services }) : t('The spirit resists.')}
          </div>
          <div className="mg-cast-drain">
            {t('Drain {dv}', { dv: result.dv })} <Badge color={result.drainType === 'P' ? 'red' : 'amber'}>{result.drainType === 'P' ? t('Physical') : t('Stun')}</Badge>{' '}
            {'pendingId' in d ? t('to resist (Magic tab)') : d.damage ? t('{hits} hit(s) on the resistance: {n} box(es) of damage', { hits: d.hits, n: d.damage }) : t('{hits} hit(s) on the resistance: no damage', { hits: d.hits })}
          </div>
        </div>
        <div className="row spread">
          <span />
          <Button variant="primary" onClick={onClose}>{t('Close')}</Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={t('Banish a spirit — {name}', { name: actor.name })} onClose={onClose} width={520}>
      <div className="mg-cast">
        {candidates.length ? (
          <div className="mg-cast-row">
            <label className="field-label">{t('Spirit')}</label>
            <Select value={target?.id || ''} onChange={setId} options={candidates.map((a) => ({ value: a.id, label: a.name }))} />
            <BookRef source="SR5" page={301} />
          </div>
        ) : (
          <div className="muted small">{t('No spirit in sight.')}</div>
        )}
        <div className="mg-cast-grid">
          <div className="field">
            <span className="field-label">{t('Pool')}</span>
            <b className="mg-cast-dv">{banishing + mag + modifier}</b>
            <span className="faint small">{t('Banishing {s} + Magic {m} [Astral limit]', { s: banishing, m: mag })}</span>
          </div>
          <div className="field">
            <span className="field-label">{t('Modifier')}</span>
            <NumberInput value={modifier} min={-20} max={20} onChange={setModifier} />
          </div>
        </div>
        <Toggle value={explode} onChange={setExplode} label={t('Push the Limit (Edge: no limit)')} />
        <div className="mg-cast-warn small">{t('The spirit rolls its Force (+ its summoner’s Magic if bound). Each net hit removes a service; Drain = 2 × the spirit’s hits (min 2).')}</div>
      </div>
      <div className="row spread mg-cast-foot">
        <span className="faint small">{t('Complex Action.')}</span>
        <div className="row">
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!target || busy || banishing <= 0 || !drainAttr(actor)} onClick={go}>
            ✦ {t('Banish')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
