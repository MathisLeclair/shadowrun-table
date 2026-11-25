// Client-only UI state shared across modules (no server round-trip).
import { useEffect, useState } from 'preact/hooks';

const ui = {
  mainTab: null, // id of the main tab shown
  dockTab: 'log', // id of the right dock tab
  dockOpen: true,
  sheetActorId: null, // actor sheet open in the modal (null = closed)
  viewMapId: null, // GM: map currently displayed (defaults to scene.activeMapId)
  selectedTokenIds: [], // map selection
  toasts: [],
};
const listeners = new Set();

export function getUI() {
  return ui;
}

export function setUI(patch) {
  Object.assign(ui, typeof patch === 'function' ? patch(ui) : patch);
  for (const l of listeners) l({ ...ui });
}

/** Hook: re-renders when the UI store changes. */
export function useUI() {
  const [s, set] = useState({ ...ui });
  useEffect(() => {
    listeners.add(set);
    return () => listeners.delete(set);
  }, []);
  return s;
}

/** Open any actor's sheet in the global modal. */
export function openSheet(actorId) {
  setUI({ sheetActorId: actorId });
}

export function goTab(id) {
  setUI({ mainTab: id });
}

let toastId = 0;
/** Show a small notification. kind: 'info' | 'success' | 'error' | 'warn' */
export function toast(text, kind = 'info', ms = 3500) {
  const id = ++toastId;
  setUI({ toasts: [...ui.toasts, { id, text, kind }] });
  setTimeout(() => setUI({ toasts: ui.toasts.filter((t) => t.id !== id) }), ms);
}
