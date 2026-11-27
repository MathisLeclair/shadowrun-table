// Matrix module — client-side types, and the shared rules (shared/matrix.ts) re-exported for the Matrix screens.
import * as M from '/shared/matrix.ts';
import type { ActionPool, ActionPoolOptions, DetectedAgent, IcTypeDef, InitiativeScore, MatrixActionDef, MatrixHint } from '/shared/matrix.ts';
import type { DeviceLinkKind, Host, IcType, Persona, PlayerHostView } from '../../../shared/types.ts';

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
// Rules (shared/matrix.ts)
// ---------------------------------------------------------------------------
export type { DeckStats, PoolPart, ProgramDef } from '/shared/matrix.ts';
export type MatrixAction = MatrixActionDef;
export type PoolCalc = ActionPool;
/** A modifier line of an action pool (shared/modifiers.ts poolModifiers()). */
export type PoolModLine = NonNullable<ActionPool['modLines']>[number];
export type ActionPoolOpts = ActionPoolOptions;
export type Initiative = InitiativeScore;
export type OwnedAgent = DetectedAgent;
export type StepHint = MatrixHint;
export type IcDef = IcTypeDef;

export {
  OS_MAX, OS_TICK_MS, MAX_MARKS, ASDF, MODES, MARK_PENALTY, ACTIONS, ACTION_BY_ID, PROGRAM_BY_ID, IC_ORDER, HOST_PRESETS, isIllegal, isCyberdeck,
  matrixMonitor, identityAsdf, programId, osLevel, deckStats, programSum, programSlots, availablePrograms, detectAgents, matrixInitiative,
  agentInitiative, actionPool, hostAttributes, icAttackPool, icInitiative, deviceWorks, nextStepHints,
} from '/shared/matrix.ts';

// Label tables looked up with ids read from the state / the UI (plain strings): widened to string keys.
export const ASDF_LABELS: Record<string, string> = M.ASDF_LABELS;
export const ASDF_SHORT: Record<string, string> = M.ASDF_SHORT;
export const ASDF_SHORT_EN: Record<string, string> = M.ASDF_SHORT_EN;
export const MODE_LABELS: Record<string, string> = M.MODE_LABELS;
export const ACTION_CATS: Record<string, string> = M.ACTION_CATS;
export const ACTION_TYPES: Record<string, string> = M.ACTION_TYPES;
export const IC_TYPES: Record<string, IcTypeDef> = M.IC_TYPES;
export const DEVICE_LINK_KINDS: Record<string, { label: string; icon: string; cmds: string[] }> = M.DEVICE_LINK_KINDS;
export const DEVICE_CMD_LABELS: Record<string, Record<string, string>> = M.DEVICE_CMD_LABELS;
