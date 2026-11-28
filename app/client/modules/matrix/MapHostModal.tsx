// GM: create the security host of a map in one go — one slaved device per picked door / light / camera zone, already
// linked to the map (Control Device / Spoof Command then act on it). Opened from the map card (MapsPage).
// Server: matrix/hostFromMap (server/modules/45-matrix.ts).
import { useState } from 'react';
import { Button, Field, Modal, NumberInput, Select, TextInput, Toggle } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
import { HOST_PRESETS } from './types.ts';
import { linkOptions } from './GmMatrix.tsx';
import type { GameMap, GameView } from '../../../shared/types.ts';

export default function MapHostModal({ game, map, onClose }: { game: GameView; map: GameMap; onClose: () => void }) {
  const objects = linkOptions(map);
  // Objects of this map already linked to a host's device: value → host name.
  const linked = new Map<string, string>();
  for (const h of Object.values(game.matrix?.hosts || {})) {
    for (const d of (h as { devices?: Array<{ link?: { mapId: string; kind: string; targetId: string } | null }> }).devices || []) {
      if (d.link?.mapId === map.id) linked.set(`${d.link.kind}:${d.link.targetId}`, h.name);
    }
  }
  const [name, setName] = useState(map.name);
  const [rating, setRating] = useState(3);
  const [preset, setPreset] = useState('fortress');
  const [ic, setIc] = useState(true);
  const [deviceRating, setDeviceRating] = useState(3);
  // Cameras and lights pre-ticked, doors left to the GM (the app cannot tell a maglock from a wooden door).
  const [picked, setPicked] = useState<string[]>(() => objects.filter((o) => !linked.has(o.value) && !o.value.startsWith('door:')).map((o) => o.value));
  const [busy, setBusy] = useState(false);
  const toggle = (v: string, on: boolean) => setPicked((l) => (on ? [...l, v] : l.filter((x) => x !== v)));
  const create = async () => {
    setBusy(true);
    try {
      const devices = objects.filter((o) => picked.includes(o.value)).map((o) => ({ link: o.value, name: o.label.replace(/^\S+\s/, '') }));
      await send('matrix/hostFromMap', { mapId: map.id, name, rating, preset, ic, deviceRating, devices });
      toast(t('Host « {name} » created with {n} device(s): find it in the Matrix tab (hidden from players).', { name: name.trim() || map.name, n: devices.length }), 'success');
      onClose();
    } catch {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('Matrix host of « {map} »', { map: map.name })}
      width={560}
      onClose={onClose}
      actions={
        <Button variant="primary" disabled={busy} onClick={create}>
          {t('Create the host')}
        </Button>
      }
    >
      <div className="col">
        <div className="small muted">
          {t('Creates a host (hidden from players) whose slaved devices are the objects you tick: deckers find it, perceive it, then open doors or cut cameras from the Matrix.')}
        </div>
        <div className="row wrap gap-s">
          <Field label={t('Name')} className="grow">
            <TextInput live value={name} onChange={setName} />
          </Field>
          <Field label={t('Rating')}>
            <NumberInput value={rating} min={1} max={12} onChange={setRating} />
          </Field>
          <Field label={t('Profile')}>
            <Select value={preset} options={Object.entries(HOST_PRESETS).map(([v, p]) => ({ value: v, label: t(p.label) }))} onChange={setPreset} />
          </Field>
        </div>
        <div className="row wrap gap-s">
          <Field label={t('Device Rating')} hint={t('2 residential, 3 corporate security, 4 high-end (SR5 p. 234)')}>
            <NumberInput value={deviceRating} min={1} max={6} onChange={setDeviceRating} />
          </Field>
          <Toggle value={ic} onChange={setIc} label={t('Standard IC suite (Patrol active)')} />
        </div>
        <Field label={t('Slaved devices ({n})', { n: picked.length })}>
          {objects.length === 0 && <div className="muted small">{t('This map has no door, light or zone to link.')}</div>}
          <div className="mx-maphost-list">
            {objects.map((o) => {
              const host = linked.get(o.value);
              return (
                <label className={'mx-reveal-opt' + (host ? ' off' : '')} key={o.value}>
                  <input type="checkbox" disabled={!!host} checked={picked.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
                  <span className="grow">{o.label}</span>
                  {host && <span className="faint small">{t('already in « {host} »', { host })}</span>}
                </label>
              );
            })}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
