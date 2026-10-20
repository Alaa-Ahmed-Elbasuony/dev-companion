import type { NetworkDraft } from '../shared/types';
import { serializeRequestBody } from './body';
import type { RecorderContext } from './context';
import { captureStack } from './context';

interface BeaconHost {
  sendBeacon?: (url: string | URL, data?: BodyInit | null) => boolean;
}

/** Records navigator.sendBeacon calls. Beacons have no observable response. */
export function installBeaconRecorder(nav: BeaconHost, ctx: RecorderContext): () => void {
  const original = nav.sendBeacon;
  if (typeof original !== 'function') return () => undefined;
  const wrapped = function sendBeacon(this: unknown, ...args: [string | URL, (BodyInit | null)?]): boolean {
    const result = Reflect.apply(original, this, args) as boolean;
    try {
      if (ctx.config().enabled) record(args[0], args[1], result);
    } catch {
      /* ignore */
    }
    return result;
  };

  function record(url: string | URL, data: BodyInit | null | undefined, queued: boolean) {
    const now = ctx.now();
    let absolute = String(url);
    try {
      absolute = new URL(absolute, ctx.pageUrl()).href;
    } catch {
      /* keep */
    }
    const draft: NetworkDraft = {
      id: ctx.newId(),
      pageId: ctx.pageId,
      pageUrl: ctx.pageUrl(),
      source: 'beacon',
      method: 'POST',
      url: absolute,
      state: queued ? 'complete' : 'error',
      requestHeaders: [],
      responseHeaders: [],
      startedAt: now,
      endedAt: now,
      initiatorStack: captureStack(ctx, 3),
      errorMessage: queued ? undefined : 'Browser refused to queue the beacon',
      warnings: ['Beacon responses are not observable by the page; only queuing is recorded'],
    };
    void serializeRequestBody(data, undefined, ctx.config().maxBodyBytes)
      .catch(() => undefined)
      .then((body) => {
        draft.requestBody = body;
        ctx.emit({ type: 'network-end', draft });
      });
  }

  nav.sendBeacon = wrapped;
  return () => {
    if (nav.sendBeacon === wrapped) nav.sendBeacon = original;
  };
}
