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
import MatrixPage from './matrix/MatrixPage.js';
import ChargenPage from './chargen/ChargenPage.js';
import NotesPage from './notes/NotesPage.js';
import BooksPage from './books/BooksPage.js';
import BookViewer from './books/BookViewer.js';
import AssistantDock from './assistant/AssistantDock.js';
import AttackTray from './combat/AttackTray.js';
import Dice3D from './sheet/Dice3D.js';
import { unreadHandouts } from './campaign/common.js';
import { tk } from '../lib/i18n.js';

const pending = (list) => (list || []).filter((r) => r.status === 'pending').length || null;

/** Main tabs (top bar). roles: who sees it. badge(game) -> number|null. label: French key marked with tk(), rendered with t(label). */
export const mainTabs = [
  { id: 'map', label: tk('Carte'), icon: '⌖', roles: ['gm', 'player'], component: MapView },
  { id: 'sheet', label: tk('Ma fiche'), icon: '☰', roles: ['player'], component: MySheet },
  { id: 'characters', label: tk('Personnages'), icon: '☰', roles: ['gm'], component: CharactersPage },
  { id: 'bestiary', label: tk('Bestiaire'), icon: '☠', roles: ['gm'], component: BestiaryPage },
  { id: 'maps', label: tk('Cartes'), icon: '▦', roles: ['gm'], component: MapsPage },
  { id: 'matrix', label: tk('Matrice'), icon: '⌬', roles: ['gm', 'player'], component: MatrixPage },
  { id: 'chargen', label: tk('Création'), icon: '✚', roles: ['gm', 'player'], component: ChargenPage, badge: (g) => (g.me.role === 'gm' ? pending(g.chargen?.drafts) : null) },
  { id: 'shop', label: tk('Boutique'), icon: '¥', roles: ['gm', 'player'], component: ShopPage, badge: (g) => (g.me.role === 'gm' ? pending(g.shop?.orders) : null) },
  { id: 'training', label: tk('Progression'), icon: '▲', roles: ['gm', 'player'], component: TrainingPage, badge: (g) => (g.me.role === 'gm' ? pending(g.training?.requests) : null) },
  { id: 'notes', label: tk('Notes'), icon: '✎', roles: ['gm', 'player'], component: NotesPage },
  { id: 'books', label: tk('Règles'), icon: '§', roles: ['gm', 'player'], component: BooksPage },
  { id: 'audio', label: tk('Ambiance'), icon: '♫', roles: ['gm'], component: AudioPage },
  { id: 'campaign', label: tk('Campagne'), icon: '✦', roles: ['gm'], component: CampaignPage },
  { id: 'dossiers', label: tk('Dossiers'), icon: '✉', roles: ['player'], component: DossiersPage, badge: (g) => unreadHandouts(g) || null },
  { id: 'settings', label: tk('Réglages'), icon: '⚙', roles: ['gm'], component: SettingsPage },
];

/** Right dock tabs. */
export const dockTabs = [
  { id: 'log', label: tk('Journal & dés'), roles: ['gm', 'player'], component: LogDock },
  { id: 'combat', label: tk('Initiative'), roles: ['gm', 'player'], component: CombatDock, badge: (g) => (g.combat?.active ? '●' : null) },
  { id: 'sounds', label: tk('Sons'), roles: ['gm'], component: SoundDock },
  { id: 'assistant', label: tk('Assistant'), roles: ['gm'], component: AssistantDock },
];

/** Full character sheet, rendered inside the global modal: <SheetView game actorId />. */
export const SheetView = SheetViewImpl;

/** Mounted once for every user, outside the tabs (audio playback, overlays…). */
export const globalComponents = [AudioEngine, BookViewer, AttackTray, Dice3D]; // BookViewer: rulebook drawer (openBook() from anywhere); AttackTray: defend / soak prompts; Dice3D: 3D dice overlay
