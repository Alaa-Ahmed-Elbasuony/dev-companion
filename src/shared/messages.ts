import type {
  CaptureConfig,
  NetworkDraft,
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
  RecordingState,
  Session,
  TimelineDraft,
} from './types';
import type { PageSimulationStatus, SimulationAck, SimulationRule, SimulationRuleField } from './simulation';

/** DOM event names used between the main-world recorder and the isolated bridge. */
export const PAGE_TO_BRIDGE_EVENT = '__devcompanion:capture';
export const BRIDGE_TO_PAGE_EVENT = '__devcompanion:control';

/** Messages emitted by the main-world recorder (serialized as JSON strings). */
export type PageMessage =
  | { type: 'hello'; pageId: string; url: string; at: number }
  | { type: 'network-start'; draft: NetworkDraft }
  | { type: 'network-end'; draft: NetworkDraft }
  | { type: 'timeline'; event: TimelineDraft }
  /** Connection created or its state changed (the full current draft each time). */
  | { type: 'rt-connection'; connection: RealtimeConnectionDraft }
  | { type: 'rt-message'; message: RealtimeMessageDraft }
  /** Added by the bridge when it had to drop events (rate limit). */
  | { type: 'capture-dropped'; count: number; at: number };

/** Messages from the bridge to the main-world recorder. */
export type ControlMessage = { type: 'config'; config: CaptureConfig };

/** Sent by the main-world recorder to the bridge only (never forwarded as capture). */
export type PageControlMessage =
  | { type: 'ping' }
  /** The simulation the page applies after its latest configuration (see SimulationAck). */
  | { type: 'simulation-applied'; ack: SimulationAck };

/** Messages handled by the service worker. */
export type WorkerRequest =
  | { type: 'capture-batch'; events: PageMessage[] }
  | { type: 'page-config-request' }
  /** From the bridge: the page applies a different simulation than before. */
  | { type: 'simulation-applied'; revision: string | null }
  | { type: 'start-recording'; tabId: number; url: string }
  | { type: 'stop-recording'; tabId: number }
  | { type: 'end-session'; sessionId: string }
  | { type: 'pause-recording'; tabId: number }
  | { type: 'resume-recording'; tabId: number }
  | { type: 'get-tab-state'; tabId: number }
  | { type: 'add-marker'; tabId: number; label: string }
  | { type: 'set-pending-start'; tabId: number; url: string }
  | { type: 'set-advanced-capture'; tabId: number; enabled: boolean }
  | { type: 'sync-server-traces'; sessionId?: string }
  /** Master switch for mock / latency / failure simulation (session-scoped). */
  | { type: 'set-simulation-armed'; armed: boolean }
  /** With a tabId, also reports what that tab currently receives. */
  | { type: 'get-simulation-state'; tabId?: number }
  | { type: 'update-simulation-rules'; change: SimulationRuleChange };

/**
 * One edit to the stored rules. The worker applies it to the rules stored at that
 * moment; `expectedUpdatedAt` / `expectedIds` reject an edit made from a stale copy.
 */
export type SimulationRuleChange =
  | { op: 'create'; rule: unknown }
  | { op: 'update'; rule: unknown; expectedUpdatedAt: number }
  | { op: 'set-enabled'; id: string; enabled: boolean; expectedUpdatedAt: number }
  | { op: 'delete'; id: string; expectedUpdatedAt: number }
  /** `ids` is the new priority order of all rules. */
  | { op: 'reorder'; ids: string[]; expectedIds: string[] };

export type StartResult =
  | { ok: true; session: Session; injected: boolean }
  | { ok: false; reason: 'restricted-url' | 'permission-required' | 'error'; message: string };

export type AdvancedCaptureResult =
  | { ok: true; attached: boolean }
  | { ok: false; reason: 'not-recording' | 'permission-required' | 'attach-failed'; message: string };

export interface TabStateResponse {
  recording: RecordingState | null;
}

export interface SimulationStateResponse {
  armed: boolean;
  enabledRules: number;
  origins: string[];
  /** All rules, in priority order (the first enabled match wins). */
  rules: SimulationRule[];
  /** The tab asked about, when a tabId was given. */
  page?: PageSimulationStatus;
}

export type SimulationChangeFailure = {
  ok: false;
  reason: 'invalid' | 'conflict' | 'not-found' | 'limit';
  message: string;
  problems?: Partial<Record<SimulationRuleField, string>>;
};

/** Always carries the state after the attempt, so the UI never keeps a stale copy. */
export type SimulationUpdateResponse = ({ ok: true; id?: string } | SimulationChangeFailure) & {
  state: SimulationStateResponse;
};

export interface PageConfigResponse {
  recording: boolean;
  config: CaptureConfig;
}

/** Broadcasts to extension pages and tabs. */
export type Broadcast =
  | { type: 'data-changed' }
  | { type: 'recording-changed' }
  | { type: 'recording-state'; recording: boolean; config: CaptureConfig }
  /** Worker → bridge of the tab's top frame: which simulation does the page apply now? */
  | { type: 'simulation-probe' }
  /** Worker → extension pages: a tab's page applies a different simulation. */
  | { type: 'simulation-page-changed'; tabId: number };

/** The bridge's answer to `simulation-probe`. */
export interface SimulationProbeResponse {
  ack: SimulationAck;
}
