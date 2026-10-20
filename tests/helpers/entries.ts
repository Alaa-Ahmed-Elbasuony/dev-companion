import type { EntryBodies, NetworkDraft, NetworkEntry, TimelineEvent } from '../../src/shared/types';

let counter = 0;

export function draft(overrides: Partial<NetworkDraft> = {}): NetworkDraft {
  counter++;
  return {
    id: `d-${counter}`,
    pageId: 'page-1',
    pageUrl: 'https://app.test/checkout',
    source: 'fetch',
    method: 'GET',
    url: 'https://app.test/api/items',
    state: 'complete',
    status: 200,
    requestHeaders: [],
    responseHeaders: [],
    startedAt: 1_000_000 + counter,
    endedAt: 1_000_100 + counter,
    warnings: [],
    ...overrides,
  };
}

export function entry(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  counter++;
  const startedAt = overrides.startedAt ?? 1_000_000 + counter * 10;
  return {
    id: `e-${counter}`,
    sessionId: 's-1',
    tabId: 1,
    pageId: 'page-1',
    pageUrl: 'https://app.test/checkout',
    origin: 'https://app.test',
    source: 'fetch',
    method: 'GET',
    url: 'https://app.test/api/items',
    state: 'complete',
    status: 200,
    requestHeaders: [],
    responseHeaders: [],
    startedAt,
    endedAt: startedAt + 100,
    duration: 100,
    warnings: [],
    redactions: 0,
    bytes: 500,
    ...overrides,
  };
}

export function jsonBodies(id: string, response: unknown, request?: unknown): EntryBodies {
  return {
    id,
    response: { kind: 'json', text: JSON.stringify(response), contentType: 'application/json' },
    request:
      request === undefined
        ? undefined
        : { kind: 'json', text: JSON.stringify(request), contentType: 'application/json' },
  };
}

export function timelineEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  counter++;
  return {
    id: `t-${counter}`,
    sessionId: 's-1',
    tabId: 1,
    origin: 'https://app.test',
    pageId: 'page-1',
    pageUrl: 'https://app.test/checkout',
    kind: 'console-error',
    timestamp: 1_000_000,
    message: 'error',
    ...overrides,
  };
}
