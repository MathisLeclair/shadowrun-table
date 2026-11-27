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
import ChargenPage from './chargen/ChargenPage.tsx';
import NotesPage from './notes/NotesPage.tsx';
import BooksPage from './books/BooksPage.tsx';
import BookViewer from './books/BookViewer.tsx';
import AssistantDock from './assistant/AssistantDock.tsx';
import AttackTray from './combat/AttackTray.tsx';
import Dice3D from './sheet/Dice3D.tsx';
import { unreadHandouts } from './campaign/common.tsx';
import { tk } from '../lib/i18n.ts';

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
