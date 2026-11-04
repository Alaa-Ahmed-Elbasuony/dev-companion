import type { PageMessage } from '../shared/messages';
import type { SimulationAck } from '../shared/simulation';
import type { CaptureConfig, HeaderPair } from '../shared/types';
import { clip } from '../shared/util';

/** Everything a recorder needs from its environment; injectable for tests. */
export interface RecorderContext {
  pageId: string;
  emit: (message: PageMessage) => void;
  config: () => CaptureConfig;
  /** Subscribes to configuration updates from the bridge. */
  onConfig?: (listener: (config: CaptureConfig) => void) => void;
  pageUrl: () => string;
  /** What relative request URLs resolve against (document.baseURI); pageUrl when absent. */
  baseUrl?: () => string;
  now: () => number;
  newId: () => string;
  /**
   * Loaded by the armed recorder build: simulation may be active for this origin,
   * so requests issued before the first configuration should wait for the rules.
   */
  simulationArmed?: boolean;
  /** Resolves when the bridge has delivered the first configuration. */
  whenConfigured?: () => Promise<void>;
  /** Random source for probabilistic simulation rules (Math.random by default). */
  random?: () => number;
  /** Reports the simulation the page applies after each configuration (to the bridge). */
  acknowledgeSimulation?: (ack: SimulationAck) => void;
}

/**
 * Strictly increasing timestamps (sub-millisecond steps when Date.now() repeats), so
 * frames recorded within the same millisecond keep their observed order.
 */
export function monotonicClock(now: () => number): () => number {
  let last = 0;
  return () => {
    const t = now();
    last = t > last ? t : last + 0.001;
    return last;
  };
}

/** A request URL as the browser resolves it: against the document base URL (`<base href>`). */
export function resolveRequestUrl(ctx: RecorderContext, raw: string): string {
  try {
    return new URL(raw, (ctx.baseUrl ?? ctx.pageUrl)()).href;
  } catch {
    return raw;
  }
}

export function headersToPairs(headers: Headers | undefined | null): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  headers?.forEach((value, name) => pairs.push({ name, value }));
  return pairs;
}

export function parseRawHeaders(raw: string): HeaderPair[] {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx <= 0) return null;
      return { name: line.slice(0, idx).trim().toLowerCase(), value: line.slice(idx + 1).trim() };
    })
    .filter((h): h is HeaderPair => h !== null);
}

/** Captures the call-site stack, dropping recorder frames. */
export function captureStack(ctx: RecorderContext, skipFrames: number): string | undefined {
  if (!ctx.config().captureStacks) return undefined;
  const stack = new Error().stack;
  if (!stack) return undefined;
  const lines = stack.split('\n');
  // Line 0 is "Error"; the next `skipFrames` lines are recorder internals.
  return clip(lines.slice(1 + skipFrames).join('\n'), 4000) || undefined;
}

export function describeError(err: unknown): { name: string; message: string } {
  if (err && typeof err === 'object' && 'name' in err) {
    const e = err as { name?: unknown; message?: unknown };
    return { name: String(e.name), message: String(e.message ?? '') };
  }
  return { name: 'Error', message: String(err) };
}
