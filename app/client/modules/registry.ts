// Central list of screens. Owned by the core — feature modules implement the files imported here
// and must keep these default exports (see ARCHITECTURE.md). Do not edit from a feature module.
import MapView from './map/MapView.tsx';
import MapsPage from './map/MapsPage.tsx';
import SheetViewImpl from './sheet/SheetView.tsx';
import MySheet from './sheet/MySheet.tsx';
import CharactersPage from './sheet/CharactersPage.tsx';
import LogDock from './sheet/LogDock.tsx';
import BestiaryPage from './combat/BestiaryPage.tsx';
import CombatDock from './combat/CombatDock.tsx';
import ShopPage from './shop/ShopPage.tsx';
import TrainingPage from './training/TrainingPage.tsx';
import AudioPage from './audio/AudioPage.tsx';
import SoundDock from './audio/SoundDock.tsx';
import AudioEngine from './audio/AudioEngine.tsx';
import CampaignPage from './campaign/CampaignPage.tsx';
import DossiersPage from './campaign/DossiersPage.tsx';
import SettingsPage from './core/SettingsPage.tsx';
import MatrixPage from './matrix/MatrixPage.tsx';
import CityPage from './city/CityPage.tsx';
import ChargenPage from './chargen/ChargenPage.tsx';
import NotesPage from './notes/NotesPage.tsx';
import BooksPage from './books/BooksPage.tsx';
import BookViewer from './books/BookViewer.tsx';
import AssistantDock from './assistant/AssistantDock.tsx';
import AttackTray from './combat/AttackTray.tsx';
import Dice3D from './sheet/Dice3D.tsx';
import { unreadHandouts } from './campaign/common.tsx';
import { tk } from '../lib/i18n.ts';
import type { ComponentType } from 'react';
import type { GameProps } from '../lib/net.ts';
import type { GameView } from '../../shared/types.ts';

/** Entry of the main or dock tab lists. */
export interface TabEntry {
  id: string;
  label: string;
  icon?: string;
  roles: string[];
  component: ComponentType<GameProps>;
  badge?: (game: GameView) => string | number | null;
  /** Shown only when this returns true (default: always). */
  visible?: (game: GameView) => boolean;
}

const pending = (list: Array<{ status: string }> | null | undefined) => (list || []).filter((r) => r.status === 'pending').length || null;

/** Main tabs (top bar). roles: who sees it. badge(game) -> number|null. label: English UI key marked with tk(), rendered with t(label). */
export const mainTabs: TabEntry[] = [
  { id: 'map', label: tk('Map'), icon: '⌖', roles: ['gm', 'player'], component: MapView },
  { id: 'sheet', label: tk('My sheet'), icon: '☰', roles: ['player'], component: MySheet },
  { id: 'characters', label: tk('Characters'), icon: '☰', roles: ['gm'], component: CharactersPage },
  { id: 'bestiary', label: tk('Bestiary'), icon: '☠', roles: ['gm'], component: BestiaryPage },
  { id: 'maps', label: tk('Maps'), icon: '▦', roles: ['gm'], component: MapsPage },
  { id: 'city', label: tk('Seattle'), icon: '⌂', roles: ['gm', 'player'], component: CityPage, visible: (g) => g.me.role === 'gm' || !!g.city?.map },
  { id: 'matrix', label: tk('Matrix'), icon: '⌬', roles: ['gm', 'player'], component: MatrixPage },
  { id: 'chargen', label: tk('Creation'), icon: '✚', roles: ['gm', 'player'], component: ChargenPage, badge: (g) => (g.me.role === 'gm' ? pending(g.chargen?.drafts) : null) },
  { id: 'shop', label: tk('Shop'), icon: '¥', roles: ['gm', 'player'], component: ShopPage, badge: (g) => (g.me.role === 'gm' ? pending(g.shop?.orders) : null) },
  { id: 'training', label: tk('Advancement'), icon: '▲', roles: ['gm', 'player'], component: TrainingPage, badge: (g) => (g.me.role === 'gm' ? pending(g.training?.requests) : null) },
  { id: 'notes', label: tk('Notes'), icon: '✎', roles: ['gm', 'player'], component: NotesPage },
  { id: 'books', label: tk('Rules'), icon: '§', roles: ['gm', 'player'], component: BooksPage },
  { id: 'audio', label: tk('Ambience'), icon: '♫', roles: ['gm'], component: AudioPage },
  { id: 'campaign', label: tk('Campaign'), icon: '✦', roles: ['gm'], component: CampaignPage },
  { id: 'dossiers', label: tk('handouts::Files'), icon: '✉', roles: ['player'], component: DossiersPage, badge: (g) => unreadHandouts(g) || null },
  { id: 'settings', label: tk('Settings'), icon: '⚙', roles: ['gm'], component: SettingsPage },
];

/** Right dock tabs. */
export const dockTabs: TabEntry[] = [
  { id: 'log', label: tk('Log & dice'), roles: ['gm', 'player'], component: LogDock },
  { id: 'combat', label: tk('Initiative'), roles: ['gm', 'player'], component: CombatDock, badge: (g) => (g.combat?.active ? '●' : null) },
  { id: 'sounds', label: tk('Sounds'), roles: ['gm'], component: SoundDock },
  { id: 'assistant', label: tk('Assistant'), roles: ['gm'], component: AssistantDock },
];

/** Full character sheet, rendered inside the global modal: <SheetView game actorId />. */
export const SheetView: ComponentType<GameProps & { actorId: string }> = SheetViewImpl;

/** Mounted once for every user, outside the tabs (audio playback, overlays…). */
export const globalComponents: ComponentType<GameProps>[] = [AudioEngine, BookViewer, AttackTray, Dice3D]; // BookViewer: rulebook drawer (openBook() from anywhere); AttackTray: defend / soak prompts; Dice3D: 3D dice overlay

/** Mounted in pop-out windows (?pane=<tab>): the same minus the audio player (the main window plays the ambience). */
export const popoutGlobalComponents: ComponentType<GameProps>[] = globalComponents.filter((C) => C !== AudioEngine);
