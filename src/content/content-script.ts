// Isolated-world bridge: relays recorder events from the page to the service
// worker and forwards recording configuration back to the page.
import { BRIDGE_TO_PAGE_EVENT, PAGE_TO_BRIDGE_EVENT } from '../shared/messages';
import type { Broadcast, PageConfigResponse, PageMessage, WorkerRequest } from '../shared/messages';
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

  const sendToWorker = (message: WorkerRequest) => {
    if (!alive) return Promise.resolve(undefined);
    try {
      return chrome.runtime.sendMessage(message).catch((err: unknown) => {
        // "Extension context invalidated" after reload/update: stop relaying.
        if (String(err).includes('context invalidated')) alive = false;
        return undefined;
      });
    } catch {
      alive = false;
      return Promise.resolve(undefined);
    }
  };

  const pushConfigToPage = () => {
    if (!config) return;
    document.dispatchEvent(
      new CustomEvent(BRIDGE_TO_PAGE_EVENT, { detail: JSON.stringify({ type: 'config', config }) }),
    );
  };

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

  chrome.runtime.onMessage.addListener((message: Broadcast) => {
    if (message?.type === 'recording-state') {
      config = message.config;
      pushConfigToPage();
    }
  });

  async function requestConfig() {
    const response = (await sendToWorker({ type: 'page-config-request' })) as PageConfigResponse | undefined;
    if (!response) return;
    config = response.config;
    pushConfigToPage();
  }

  globalThis.__devCompanionBridge = { refresh: requestConfig };
  void requestConfig();
}

startBridge();
