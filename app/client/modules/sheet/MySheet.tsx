// « Ma fiche » (players): the character(s) assigned to this player, full sheet inline.
import { useState } from 'react';
import { Tabs, Empty } from '../../lib/ui.tsx';
import SheetView from './SheetView.tsx';
import { t } from '../../lib/i18n.ts';
import { Avatar, tRich } from './common.tsx';

import type { GameProps } from '../../lib/net.ts';
import './sheet.css';

export default function MySheet({ game }: GameProps) {
  const ids = (game.me.characterIds || []).filter((id) => game.actors?.[id]);
  const [sel, setSel] = useState<string | null>(null);
  if (!ids.length) {
    return <div className="page">
      <div className="sh-nochar">
        <div className="logo-mark" />
        <h2>{t('No character')}</h2>
        <p className="muted">
          {tRich(t('The GM hasn\'t assigned you a character yet. Ask them to assign you one from the {tab} tab — your sheet will show up here automatically.'), { tab: <b>{t('Characters')}</b> })}
        </p>
      </div>
    </div>;
  }
  const current = sel && ids.includes(sel) ? sel : ids[0];
  return <div className="page sh-mysheet">
    {ids.length > 1 &&
    <Tabs className="sh-mytabs" tabs={ids.map((id) => ({ id, label: <span className="row gap-s"><Avatar actor={game.actors[id]} size={18} />{game.actors[id].name}</span> }))} value={current} onChange={setSel} />}
    {game.actors[current] ? <SheetView key={current} game={game} actorId={current} /> : <Empty>{t('Character not found.')}</Empty>}
  </div>;
}
