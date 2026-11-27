// Client-only UI state shared across modules (no server round-trip).
import { useEffect, useState } from 'react';
import { getLang, onLangChange } from './i18n.js';

export type ToastKind = 'info' | 'success' | 'error' | 'warn';
export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
}
/** Client-only UI state. Modules add their own keys (mapsEditId, focusTokenId, handoutsReadAt…). */
export interface UIState {
  mainTab: string | null;
  dockTab: string;
  dockOpen: boolean;
  sheetActorId: string | null;
  viewMapId: string | null;
  selectedTokenIds: string[];
  targetTokenId: string | null;
  aimPoint: { mapId: string; x: number; y: number } | null;
  toasts: Toast[];
  [key: string]: any;
}

const ui: UIState = {
  mainTab: null, // id of the main tab shown
  dockTab: 'log', // id of the right dock tab
  dockOpen: true,
  sheetActorId: null, // actor sheet open in the modal (null = closed)
  viewMapId: null, // GM: map currently displayed (defaults to scene.activeMapId)
  selectedTokenIds: [], // map selection
  targetTokenId: null, // the user's attack target (map token, attacks module)
  aimPoint: null, // { mapId, x, y } aimed point for grenades / launchers
  toasts: [],
};
const listeners = new Set<(s: UIState) => void>();

export function getUI(): UIState {
  return ui;
}

export function setUI(patch: Partial<UIState> | ((ui: UIState) => Partial<UIState>)) {
  Object.assign(ui, typeof patch === 'function' ? patch(ui) : patch);
  for (const l of listeners) l({ ...ui });
}

/** Hook: re-renders when the UI store changes. */
export function useUI(): UIState {
  const [s, set] = useState<UIState>({ ...ui });
  useEffect(() => {
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return s;
}

/**
 * Hook: current UI language ('fr'|'en'); re-renders the component when it changes. The app root uses it, so
 * modules normally don't need it (the whole tree re-renders on a language switch).
 */
export function useLang(): string {
  const [l, set] = useState<string>(getLang());
  useEffect(() => {
    if (getLang() !== l) set(getLang());
    return onLangChange(set);
  }, []);
  return l;
}

/** Open any actor's sheet in the global modal. */
export function openSheet(actorId: string | null) {
  setUI({ sheetActorId: actorId });
}

export function goTab(id: string) {
  setUI({ mainTab: id });
}

let toastId = 0;
/** Show a small notification. kind: 'info' | 'success' | 'error' | 'warn' */
export function toast(text: string, kind: ToastKind = 'info', ms = 3500) {
  const id = ++toastId;
  setUI({ toasts: [...ui.toasts, { id, text, kind }] });
  setTimeout(() => setUI({ toasts: ui.toasts.filter((t) => t.id !== id) }), ms);
}
