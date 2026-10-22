import type {
  CaptureConfig,
  NetworkDraft,
  RealtimeConnectionDraft,
  RealtimeMessageDraft,
  RecordingState,
  Session,
  TimelineDraft,
} from './types';

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

/** Messages handled by the service worker. */
export type WorkerRequest =
  | { type: 'capture-batch'; events: PageMessage[] }
  | { type: 'page-config-request' }
  | { type: 'start-recording'; tabId: number; url: string }
  | { type: 'stop-recording'; tabId: number }
  | { type: 'end-session'; sessionId: string }
  | { type: 'pause-recording'; tabId: number }
  | { type: 'resume-recording'; tabId: number }
  | { type: 'get-tab-state'; tabId: number }
  | { type: 'add-marker'; tabId: number; label: string }
  | { type: 'set-pending-start'; tabId: number; url: string }
  | { type: 'set-advanced-capture'; tabId: number; enabled: boolean }
  | { type: 'sync-server-traces'; sessionId?: string };

export type StartResult =
  | { ok: true; session: Session; injected: boolean }
  | { ok: false; reason: 'restricted-url' | 'permission-required' | 'error'; message: string };

export type AdvancedCaptureResult =
  | { ok: true; attached: boolean }
  | { ok: false; reason: 'not-recording' | 'permission-required' | 'attach-failed'; message: string };

export interface TabStateResponse {
  recording: RecordingState | null;
}

export interface PageConfigResponse {
  recording: boolean;
  config: CaptureConfig;
}

/** Broadcasts to extension pages and tabs. */
export type Broadcast =
  | { type: 'data-changed' }
  | { type: 'recording-changed' }
  | { type: 'recording-state'; recording: boolean; config: CaptureConfig };
