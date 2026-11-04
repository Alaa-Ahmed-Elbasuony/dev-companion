// Isolated-world bridge: relays recorder events from the page to the service
// worker and forwards recording configuration back to the page.
import { BRIDGE_TO_PAGE_EVENT, PAGE_TO_BRIDGE_EVENT } from '../shared/messages';
import type {
  Broadcast,
  PageConfigResponse,
  PageMessage,
  SimulationProbeResponse,
  WorkerRequest,
} from '../shared/messages';
import { SIMULATION_LEASE_RENEW_MS, sanitizeSimulationAck } from '../shared/simulation';
import type { SimulationAck } from '../shared/simulation';
import type { CaptureConfig } from '../shared/types';

const FLUSH_MS = 50;
const MAX_BATCH = 50;
const MAX_PAYLOAD_CHARS = 25 * 1024 * 1024;
const FRAME_RATE = 500;
const FRAME_BURST = 2000;

declare global {
  // Isolated-world global: survives re-injection into the same document.
  var __devCompanionBridge: { refresh: () => Promise<void> } | undefined;
}

function startBridge() {
  if (globalThis.__devCompanionBridge) {
    void globalThis.__devCompanionBridge.refresh();
    return;
  }

  let config: CaptureConfig | null = null;
  const batch: PageMessage[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  // What the page's recorder last reported applying (null: not simulating).
  let applied: SimulationAck = null;

  const sendToWorker = (message: WorkerRequest) => {
    if (!alive) return Promise.resolve(undefined);
    try {
      return chrome.runtime.sendMessage(message).catch((err: unknown) => {
        // "Extension context invalidated" after reload/update: stop relaying.
        if (String(err).includes('context invalidated')) disconnect();
        return undefined;
      });
    } catch {
      disconnect();
      return Promise.resolve(undefined);
    }
  };

  const pushConfigToPage = () => {
    if (!config) return;
    document.dispatchEvent(
      new CustomEvent(BRIDGE_TO_PAGE_EVENT, { detail: JSON.stringify({ type: 'config', config }) }),
    );
    // While the page holds simulation rules, keep renewing their lease. If renewal
    // stops (worker unreachable), the page stops simulating when the lease runs out.
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer =
      config.simulation && alive
        ? setTimeout(() => void requestConfig(), SIMULATION_LEASE_RENEW_MS)
        : undefined;
  };

  // The extension was reloaded or updated: nothing can renew the rules any more, so
  // the page must stop simulating now rather than when its lease expires.
  function disconnect() {
    if (!alive) return;
    alive = false;
    if (leaseTimer) clearTimeout(leaseTimer);
    leaseTimer = undefined;
    if (config?.simulation) {
      config = { ...config, simulation: undefined };
      pushConfigToPage();
    }
  }

  // Token bucket for realtime frames: sustained FRAME_RATE per second, bursts up to FRAME_BURST.
  let tokens = FRAME_BURST;
  let refilledAt = Date.now();
  let dropped = 0;
  const takeFrameToken = () => {
    const now = Date.now();
    tokens = Math.min(FRAME_BURST, tokens + ((now - refilledAt) / 1000) * FRAME_RATE);
    refilledAt = now;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };

  const flush = () => {
    timer = undefined;
    if (dropped) {
      batch.push({ type: 'capture-dropped', count: dropped, at: Date.now() });
      dropped = 0;
    }
    while (batch.length) {
      const events = batch.splice(0, MAX_BATCH);
      void sendToWorker({ type: 'capture-batch', events });
    }
  };

  document.addEventListener(PAGE_TO_BRIDGE_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'string' || detail.length > MAX_PAYLOAD_CHARS) return;
    let message: { type?: unknown };
    try {
      message = JSON.parse(detail) as { type?: unknown };
    } catch {
      return;
    }
    if (message.type === 'ping') {
      pushConfigToPage();
      return;
    }
    if (message.type === 'simulation-applied') {
      const ack = sanitizeSimulationAck((message as { ack?: unknown }).ack);
      if (ack === undefined) return;
      const changed = (ack?.revision ?? null) !== (applied?.revision ?? null);
      applied = ack;
      // Lease renewals repeat the same revision: only a change reaches the worker.
      if (changed) void sendToWorker({ type: 'simulation-applied', revision: ack?.revision ?? null });
      return;
    }
    if (!config?.enabled) return;
    // Realtime frames can arrive far faster than requests. Beyond the budget they are
    // dropped (never connections, requests or timeline events) and the loss is reported.
    if (message.type === 'rt-message' && !takeFrameToken()) {
      dropped++;
      timer ??= setTimeout(flush, FLUSH_MS);
      return;
    }
    batch.push(message as PageMessage);
    if (batch.length >= MAX_BATCH) flush();
    else timer ??= setTimeout(flush, FLUSH_MS);
  });

  // Deliver buffered events before the document goes away.
  window.addEventListener('pagehide', () => {
    if (timer) clearTimeout(timer);
    flush();
  });

  chrome.runtime.onMessage.addListener((message: Broadcast, _sender, sendResponse) => {
    if (message?.type === 'recording-state') {
      config = message.config;
      pushConfigToPage();
    } else if (message?.type === 'simulation-probe') {
      // Answered by this document only: an earlier document of the tab cannot confirm.
      const response: SimulationProbeResponse = { ack: applied };
      sendResponse(response);
    }
  });

  async function requestConfig() {
    const response = (await sendToWorker({ type: 'page-config-request' })) as PageConfigResponse | undefined;
    if (!response) {
      // Renewal failed (worker unreachable): try again. The page stops simulating
      // when its lease runs out, whether or not a later attempt succeeds.
      if (alive && config?.simulation) {
        if (leaseTimer) clearTimeout(leaseTimer);
        leaseTimer = setTimeout(() => void requestConfig(), SIMULATION_LEASE_RENEW_MS);
      }
      return;
    }
    config = response.config;
    pushConfigToPage();
  }

  globalThis.__devCompanionBridge = { refresh: requestConfig };
  void requestConfig();
}

startBridge();
