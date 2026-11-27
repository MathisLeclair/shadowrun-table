// Matrix module — client-side types, plus a typed view of the shared rules (shared/matrix.js is still plain JS,
// so its inferred types are loose: string-indexed lookups, union-of-literals arrays). TRANSITIONAL: drop the casts
// below once shared/matrix.js is converted to TypeScript.
import * as M from '/shared/matrix.js';
import type { Actor, AsdfKey, DeviceLinkKind, Host, I18nParams, IcType, MatrixMode, Persona, PlayerHostView } from '../../../shared/types.ts';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
/** A persona as the client handles it: stored, or the blank one built before the first connection. */
export type PersonaView = Omit<Persona, 'programSlots' | 'slotsOverride' | 'deviceName' | 'linkLocked' | 'fullDefense' | 'bricked' | 'traced' | 'pendingAssist' | 'osClock' | 'hostConverged' | 'osKnown'> & {
  programSlots: number | null;
  slotsOverride?: boolean;
  deviceName?: string;
  linkLocked?: Persona['linkLocked'];
  fullDefense?: boolean;
  bricked?: boolean;
  traced?: boolean;
  pendingAssist?: Persona['pendingAssist'];
  osClock?: Persona['osClock'];
  hostConverged?: Persona['hostConverged'];
  osKnown?: Persona['osKnown'];
  /** Time of the last Overwatch check (player view, hidden OS). Missing from shared/types.ts Persona. */
  osKnownAt?: number | null;
  /** Client-side blank persona (not stored yet). */
  virtual?: boolean;
};

export interface HostIcView {
  id: string;
  type: IcType;
  rating?: number;
  damage?: number;
  active?: boolean;
  detected?: boolean;
  crashed?: boolean;
}
export interface HostFileView {
  id: string;
  name: string;
  protected: boolean;
  bomb: number;
  mine?: boolean;
  value?: number | null;
}
export interface HostDeviceView {
  id: string;
  name: string;
  rating: number;
  offline: boolean;
  formatted: boolean;
  bricked: boolean;
  damage: number;
  /** GM: { mapId, kind, targetId }; players: { kind, state }. */
  link?: { kind: DeviceLinkKind; mapId?: string; targetId?: string; state?: string } | null;
}
/** A host as either view gives it (GM `Host`, player `PlayerHostView`): the fields the shared screens read. */
export interface HostView {
  id: string;
  name: string;
  alert: 'none' | 'active';
  visible: boolean;
  inside?: boolean;
  perceived?: boolean;
  description?: string;
  spotted?: boolean | string[];
  rating?: number;
  attack?: number;
  sleaze?: number;
  dataProcessing?: number;
  firewall?: number;
  folder?: string;
  /** Players only get ic / files / devices once inside or after a Matrix Perception. */
  ic?: HostIcView[];
  files?: HostFileView[];
  devices?: HostDeviceView[];
}
export type AnyHost = Host | PlayerHostView;
/** Agent assist bonus (persona.pendingAssist or the assist passed to actionPool). */
export interface PendingAssistLike {
  dice: number;
  limitBonus: number;
}

// ---------------------------------------------------------------------------
// Rules (shared/matrix.js) — typed re-exports
// ---------------------------------------------------------------------------
export interface MatrixAction {
  id: string;
  fr: string;
  en: string;
  cat: string;
  type: string;
  skill?: string;
  attr?: string;
  limit?: AsdfKey;
  defense?: unknown;
  marks?: number;
  placesMarks?: boolean;
  marksOnOwner?: boolean;
  noTest?: boolean;
  targets?: string[];
  page?: number;
  desc: string;
}

export interface ProgramDef {
  id: string;
  en: string;
  fr: string;
  kind: string;
  auto?: boolean;
  slots?: number;
  effect: string;
}

/** One dice pool / limit part: French label plus what the UI needs to translate it. */
export interface PoolPart {
  label: string;
  value: number;
  key?: string;
  params?: I18nParams;
  skillId?: string;
  attr?: string;
  mod?: { id?: string; book?: string; page?: number };
}
/** A modifier line from poolModifiers() (see sheet/modifiers-ui.js). */
export interface PoolModLine {
  value: number | null;
  state?: string;
  toggles?: string[];
  // Modifier object of shared/modifiers.js (untyped yet).
  mod: { baked?: boolean; info?: boolean; [k: string]: unknown };
}
export interface PoolCalc {
  pool: number;
  parts: PoolPart[];
  limit: number | null;
  limitParts: PoolPart[];
  impossible: boolean;
  noTest?: boolean;
  reason?: string;
  reasonKey?: string;
  reasonParams?: I18nParams;
  modLines?: PoolModLine[];
}
export interface ActionPoolOpts {
  agent?: boolean;
  useSpec?: boolean;
  marks?: number;
  modifier?: number;
  assist?: { dice: number; limitBonus: number } | null;
  edge?: boolean;
  mods?: unknown;
  conditions?: string[];
}

export interface DeckStats {
  deviceRating: number;
  isDeck: boolean;
  base: Record<AsdfKey, number>;
  slotted: Record<AsdfKey, number>;
  bonus: Record<AsdfKey, number>;
  penalty: Record<AsdfKey, number>;
  eff: Record<AsdfKey, number>;
  programs: Set<string>;
  rawNoise: number;
  noise: number;
  monitor: number;
}
export interface Initiative {
  base: number;
  dice: number;
  text: string;
}
export interface OwnedAgent {
  rating: number;
  source: 'programs' | 'gear';
  label: string;
  name?: string;
  gearRating?: number | null;
}
export interface StepHint {
  key: string;
  tone: 'info' | 'warn' | 'danger';
  params?: I18nParams;
  actionId?: string;
  targetId?: string;
  preset?: Record<string, string>;
}
export interface IcDef {
  fr: string;
  en: string;
  desc: string;
  needsMarks?: number;
}

export const OS_MAX: number = M.OS_MAX;
export const OS_TICK_MS: number = M.OS_TICK_MS;
export const MAX_MARKS: number = M.MAX_MARKS;
export const ASDF = M.ASDF as AsdfKey[];
export const ASDF_LABELS = M.ASDF_LABELS as Record<string, string>;
export const ASDF_SHORT = M.ASDF_SHORT as Record<string, string>;
export const ASDF_SHORT_EN = M.ASDF_SHORT_EN as Record<string, string>;
export const MODES = M.MODES as MatrixMode[];
export const MODE_LABELS = M.MODE_LABELS as Record<string, string>;
export const MARK_PENALTY = M.MARK_PENALTY as Record<number, number>;
export const ACTIONS = M.ACTIONS as MatrixAction[];
export const ACTION_BY_ID = M.ACTION_BY_ID as Record<string, MatrixAction>;
export const ACTION_CATS = M.ACTION_CATS as Record<string, string>;
export const ACTION_TYPES = M.ACTION_TYPES as Record<string, string>;
export const PROGRAM_BY_ID = M.PROGRAM_BY_ID as Record<string, ProgramDef>;
export const IC_TYPES = M.IC_TYPES as Record<string, IcDef>;
export const IC_ORDER = M.IC_ORDER as IcType[];
export const HOST_PRESETS = M.HOST_PRESETS as Record<string, { label: string }>;
export const DEVICE_LINK_KINDS = M.DEVICE_LINK_KINDS as Record<string, { label: string; icon: string; cmds: string[] }>;
export const DEVICE_CMD_LABELS = M.DEVICE_CMD_LABELS as Record<string, Record<string, string>>;

export const isIllegal = M.isIllegal as (action: MatrixAction | null | undefined) => boolean;
export const isCyberdeck = M.isCyberdeck as (actor: Actor | null | undefined) => boolean;
export const matrixMonitor = M.matrixMonitor as (deviceRating: number | null | undefined) => number;
export const identityAsdf = M.identityAsdf as () => Record<AsdfKey, AsdfKey>;
export const programId = M.programId as (name: string | null | undefined) => string | null;
export const osLevel = M.osLevel as (os: number | null | undefined) => { id: string; label: string; color: string };
export const deckStats = M.deckStats as (actor: Actor, persona: PersonaView) => DeckStats;
export const programSum = M.programSum as (persona: PersonaView, prop: string) => number;
export const programSlots = M.programSlots as (persona: Pick<PersonaView, 'loadedPrograms' | 'agent' | 'programSlots'>) => { base: number; total: number; used: number; free: number };
export const availablePrograms = M.availablePrograms as (actor: Actor) => Array<{ name: string; id: string | null }>;
export const detectAgents = M.detectAgents as (actor: Actor) => OwnedAgent[];
export const matrixInitiative = M.matrixInitiative as (actor: Actor, persona: PersonaView, mode?: MatrixMode) => Initiative;
export const agentInitiative = M.agentInitiative as (actor: Actor, persona: PersonaView) => Initiative;
export const actionPool = M.actionPool as (actor: Actor, persona: PersonaView, action: MatrixAction, opts?: ActionPoolOpts) => PoolCalc;
export const hostAttributes = M.hostAttributes as (rating: number, preset?: string) => Record<AsdfKey, number>;
export const icAttackPool = M.icAttackPool as (host: Host) => number;
export const icInitiative = M.icInitiative as (host: Host) => Initiative;
export const deviceWorks = M.deviceWorks as (d: HostDeviceView | null | undefined) => boolean;
export const nextStepHints = M.nextStepHints as (args: { actor: Actor; persona: PersonaView; hosts: Record<string, AnyHost> }) => StepHint[];
