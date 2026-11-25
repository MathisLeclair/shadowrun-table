// Central list of screens. Owned by the core — feature modules implement the files imported here
// and must keep these default exports (see ARCHITECTURE.md). Do not edit from a feature module.
import MapView from './map/MapView.js';
import MapsPage from './map/MapsPage.js';
import SheetViewImpl from './sheet/SheetView.js';
import MySheet from './sheet/MySheet.js';
import CharactersPage from './sheet/CharactersPage.js';
import LogDock from './sheet/LogDock.js';
import BestiaryPage from './combat/BestiaryPage.js';
import CombatDock from './combat/CombatDock.js';
import ShopPage from './shop/ShopPage.js';
import TrainingPage from './training/TrainingPage.js';
import AudioPage from './audio/AudioPage.js';
import SoundDock from './audio/SoundDock.js';
import AudioEngine from './audio/AudioEngine.js';
import CampaignPage from './campaign/CampaignPage.js';
import DossiersPage from './campaign/DossiersPage.js';
import SettingsPage from './core/SettingsPage.js';
import { unreadHandouts } from './campaign/common.js';

const pending = (list) => (list || []).filter((r) => r.status === 'pending').length || null;

/** Main tabs (top bar). roles: who sees it. badge(game) -> number|null. */
export const mainTabs = [
  { id: 'map', label: 'Carte', icon: '⌖', roles: ['gm', 'player'], component: MapView },
  { id: 'sheet', label: 'Ma fiche', icon: '☰', roles: ['player'], component: MySheet },
  { id: 'characters', label: 'Personnages', icon: '☰', roles: ['gm'], component: CharactersPage },
  { id: 'bestiary', label: 'Bestiaire', icon: '☠', roles: ['gm'], component: BestiaryPage },
  { id: 'maps', label: 'Cartes', icon: '▦', roles: ['gm'], component: MapsPage },
  { id: 'shop', label: 'Boutique', icon: '¥', roles: ['gm', 'player'], component: ShopPage, badge: (g) => (g.me.role === 'gm' ? pending(g.shop?.orders) : null) },
  { id: 'training', label: 'Progression', icon: '▲', roles: ['gm', 'player'], component: TrainingPage, badge: (g) => (g.me.role === 'gm' ? pending(g.training?.requests) : null) },
  { id: 'audio', label: 'Ambiance', icon: '♫', roles: ['gm'], component: AudioPage },
  { id: 'campaign', label: 'Campagne', icon: '✦', roles: ['gm'], component: CampaignPage },
  { id: 'dossiers', label: 'Dossiers', icon: '✉', roles: ['player'], component: DossiersPage, badge: (g) => unreadHandouts(g) || null },
  { id: 'settings', label: 'Réglages', icon: '⚙', roles: ['gm'], component: SettingsPage },
];

/** Right dock tabs. */
export const dockTabs = [
  { id: 'log', label: 'Journal & dés', roles: ['gm', 'player'], component: LogDock },
  { id: 'combat', label: 'Initiative', roles: ['gm', 'player'], component: CombatDock, badge: (g) => (g.combat?.active ? '●' : null) },
  { id: 'sounds', label: 'Sons', roles: ['gm'], component: SoundDock },
];

/** Full character sheet, rendered inside the global modal: <SheetView game actorId />. */
export const SheetView = SheetViewImpl;

/** Mounted once for every user, outside the tabs (audio playback, overlays…). */
export const globalComponents = [AudioEngine];
