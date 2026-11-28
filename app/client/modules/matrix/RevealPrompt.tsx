// GM prompt (global): a decker's Matrix Perception / Matrix Search got hits — the GM picks what they learn, one item per
// hit, from what the app can reveal (host stats, IC, files, devices, PAN devices, hidden hosts), plus a free answer.
// Server: matrix/reveal, matrix/dropReveal (server/modules/45-matrix.ts).
import { useState } from 'react';
import { Button, TextInput } from '../../lib/ui.tsx';
import type { GameProps } from '../../lib/net.ts';
import { t, tn, getLang } from '../../lib/i18n.ts';
import { act, msgText, type MsgLike } from './common.tsx';
import { Overlay } from '../sheet/common.tsx';
import type { BiName, GameView, MatrixReveal, RevealOption } from '../../../shared/types.ts';
import './matrix.css';

type Label = RevealOption['label'] | null | undefined;
const isBi = (m: unknown): m is BiName => !!m && typeof m === 'object' && !('t' in m) && ('fr' in m || 'en' in m);
/** Text of an option label / group / detail (message, plain text or bilingual item name). */
export function labelText(m: Label): string {
  if (isBi(m)) return (getLang() === 'en' ? m.en || m.fr : m.fr || m.en) || '';
  return msgText(m as MsgLike);
}

/** A duration in minutes (« 45 s », « 15 min », « 6 h »). */
export function fmtMinutes(minutes: number): string {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  if (minutes < 1) return t('{n} s', { n: Math.max(1, Math.round(minutes * 60)) });
  if (minutes < 60) return t('{n} min', { n: r1(minutes) });
  return t('{n} h', { n: r1(minutes / 60) });
}

function RevealDialog({ game, rv, count, onLater }: { game: GameView; rv: MatrixReveal; count: number; onLater: () => void }) {
  const opts = rv.options || [];
  // Perception: one thing per net hit. Search: the threshold was reached, the GM answers freely (SR5 p. 241).
  const search = rv.actionId === 'matrixSearch';
  const max = search ? Infinity : rv.hits;
  const [picked, setPicked] = useState<string[]>(() => (search ? [] : opts.slice(0, rv.hits).map((o) => o.id)));
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const who = game.actors?.[rv.actorId]?.name || '?';
  const full = picked.length >= max;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const reveal = async () => {
    setBusy(true);
    await act('matrix/reveal', { revealId: rv.id, optionIds: picked, answer });
    setBusy(false);
  };
  const drop = async () => {
    setBusy(true);
    await act('matrix/dropReveal', { revealId: rv.id });
    setBusy(false);
  };
  const groups: Array<{ key: string; label: string; items: RevealOption[] }> = [];
  for (const o of opts) {
    const label = labelText(o.group);
    let g = groups.find((x) => x.key === label);
    if (!g) groups.push((g = { key: label, label, items: [] }));
    g.items.push(o);
  }
  const action = rv.actionId === 'matrixSearch' ? t('Matrix Search') : t('Matrix Perception');
  const target = labelText(rv.target);
  return (
    <Overlay
      title={`${action} — ${who}`}
      onClose={onLater}
      width={520}
      actions={count > 1 ? <span className="faint small">{t('{n} waiting', { n: count })}</span> : null}
    >
      <div className="mx-reveal">
        {search ? (
          <div>
            {rv.topic ? t('{who} searches for “{topic}”: ', { who, topic: rv.topic }) : t('{who} runs a Matrix Search: ', { who })}
            <b>{t('found (threshold {th})', { th: rv.threshold ?? 1 })}</b>
            {rv.minutes != null ? ` — ${t('it took {time}', { time: fmtMinutes(rv.minutes) })}` : ''}
            <div className="small faint">{t('Answer what they find; you may also reveal a host or a file.')}</div>
          </div>
        ) : (
          <div>
            {target ? t('{who} looks at {target}: ', { who, target }) : ''}
            <b>{tn(rv.hits, '{n} hit', '{n} hits', { n: rv.hits })}</b>
            {' — '}
            {t('pick one thing per hit.')}
          </div>
        )}
        {groups.length === 0 && <div className="muted small">{t('Nothing the app can reveal here: answer in your own words.')}</div>}
        {groups.map((g) => (
          <div className="mx-reveal-group" key={g.key}>
            {g.label && <div className="mx-panel-sub">{g.label}</div>}
            {g.items.map((o) => {
              const on = picked.includes(o.id);
              return (
                <label className={'mx-reveal-opt' + (!on && full ? ' off' : '')} key={o.id}>
                  <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(o.id)} />
                  <span className="grow">{labelText(o.label)}</span>
                  {o.detail && <span className="faint small">{labelText(o.detail)}</span>}
                </label>
              );
            })}
          </div>
        ))}
        {!search && <div className="small faint">{t('{n} / {max} chosen', { n: picked.length, max: rv.hits })}</div>}
        <TextInput multiline live rows={2} value={answer} onChange={setAnswer} placeholder={t('Answer in your own words (sent to the player)…')} />
        <div className="row gap-s">
          <Button variant="primary" disabled={busy} onClick={reveal}>
            {t('Reveal')}
          </Button>
          <Button disabled={busy} onClick={onLater}>
            {t('Later')}
          </Button>
          <span className="grow" />
          <Button variant="danger" disabled={busy} onClick={drop} title={t('The decker learns nothing from these hits')}>
            {t('Discard')}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

/** Global component: shows the GM the oldest Matrix Perception / Search waiting for an answer. */
export default function RevealPrompt({ game }: GameProps) {
  const [later, setLater] = useState<string[]>([]);
  if (game.me?.role !== 'gm') return null;
  const all = Object.values(game.matrix?.reveals || {}).sort((a, b) => a.at - b.at);
  const waiting = all.filter((r) => !later.includes(r.id));
  const rv = waiting[0];
  if (!rv) return null;
  return <RevealDialog key={rv.id} game={game} rv={rv} count={waiting.length} onLater={() => setLater((l) => [...l, rv.id])} />;
}
