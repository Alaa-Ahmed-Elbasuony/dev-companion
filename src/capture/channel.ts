// Main-world side of the page <-> bridge channel. Messages are JSON strings in
// CustomEvent.detail (object details do not cross JavaScript worlds).
import { BRIDGE_TO_PAGE_EVENT, PAGE_TO_BRIDGE_EVENT } from '../shared/messages';
import type { ControlMessage, PageControlMessage, PageMessage } from '../shared/messages';
import type { SimulationAck } from '../shared/simulation';
import type { CaptureConfig } from '../shared/types';

const MAX_QUEUE = 1000;

export interface PageChannel {
  emit: (message: PageMessage) => void;
  config: () => CaptureConfig;
  /** True once the bridge has sent a configuration. */
  isConnected: () => boolean;
  /** Called with every configuration received from the bridge. */
  onConfig: (listener: (config: CaptureConfig) => void) => void;
  /** Resolves when the first configuration arrives. */
  whenConfigured: () => Promise<void>;
  /** Tells the bridge which simulation the page applies (sent at once, never queued). */
  acknowledgeSimulation: (ack: SimulationAck) => void;
}

export function createPageChannel(target: EventTarget, initialConfig: CaptureConfig): PageChannel {
  let config = initialConfig;
  let connected = false;
  // Events are queued until the bridge confirms the recording state, so requests
  // issued during page initialization (before the bridge is ready) are not lost.
  let queue: string[] = [];
  const listeners: ((config: CaptureConfig) => void)[] = [];
  let markConfigured: () => void = () => undefined;
  const configured = new Promise<void>((resolve) => {
    markConfigured = resolve;
  });

  const send = (payload: string) => {
    target.dispatchEvent(new CustomEvent(PAGE_TO_BRIDGE_EVENT, { detail: payload }));
  };

  target.addEventListener(BRIDGE_TO_PAGE_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string') return;
    let msg: ControlMessage;
    try {
      msg = JSON.parse(detail) as ControlMessage;
    } catch {
      return;
    }
    if (msg?.type !== 'config' || typeof msg.config !== 'object' || msg.config === null) return;
    // Simulation rules are replaced, never merged: JSON drops `simulation: undefined`,
    // so a config without rules must switch simulation off.
    config = { ...config, ...msg.config, simulation: msg.config.simulation };
    connected = true;
    markConfigured();
    const pending = queue;
    queue = [];
    if (config.enabled) pending.forEach(send);
    for (const listener of listeners) {
      try {
        listener(config);
      } catch {
        /* ignore */
      }
    }
  });

  const control = (message: PageControlMessage) => send(JSON.stringify(message));

  // Handshake: if the bridge loaded first it answers this ping with the config;
  // if it loads later it sends the config on its own.
  control({ type: 'ping' });

  return {
    emit(message) {
      let payload: string;
      try {
        payload = JSON.stringify(message);
      } catch {
        return;
      }
      if (connected) {
        if (config.enabled) send(payload);
        return;
      }
      if (queue.length < MAX_QUEUE) queue.push(payload);
    },
    config: () => config,
    isConnected: () => connected,
    onConfig: (listener) => listeners.push(listener),
    whenConfigured: () => configured,
    acknowledgeSimulation: (ack) => control({ type: 'simulation-applied', ack }),
  };
}
