import type { RecorderContext } from '../../src/capture/context';
import type { PageMessage } from '../../src/shared/messages';
import { DEFAULT_CAPTURE_CONFIG } from '../../src/shared/settings';
import type { CaptureConfig, NetworkDraft } from '../../src/shared/types';

export function makeContext(overrides: Partial<CaptureConfig> = {}) {
  const messages: PageMessage[] = [];
  let config: CaptureConfig = { ...DEFAULT_CAPTURE_CONFIG, ...overrides };
  let n = 0;
  const ctx: RecorderContext = {
    pageId: 'page-1',
    emit: (m) => messages.push(m),
    config: () => config,
    pageUrl: () => 'https://app.test/checkout',
    now: () => Date.now(),
    newId: () => `id-${++n}`,
  };
  return {
    ctx,
    messages,
    setConfig: (c: Partial<CaptureConfig>) => {
      config = { ...config, ...c };
    },
    ends: () =>
      messages
        .filter((m): m is { type: 'network-end'; draft: NetworkDraft } => m.type === 'network-end')
        .map((m) => m.draft),
    starts: () =>
      messages
        .filter((m): m is { type: 'network-start'; draft: NetworkDraft } => m.type === 'network-start')
        .map((m) => m.draft),
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
