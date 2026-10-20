// Opt-in parsing of fetch() responses of type text/event-stream (used by many
// SSE client libraries instead of EventSource). Reads a clone of the response
// incrementally; the page reads its own branch unchanged. Reading stops (and
// the clone is cancelled) at the byte limit, so a long-lived stream is never
// buffered without bound.
import { SseParser } from '../analysis/realtime/sse';
import type { RealtimeConnectionDraft } from '../shared/types';
import { truncateText, utf8Length } from '../shared/util';
import type { RecorderContext } from './context';
import { monotonicClock } from './context';

export function isEventStream(contentType: string | null | undefined): boolean {
  return !!contentType && /text\/event-stream/i.test(contentType);
}

export function parseFetchEventStream(response: Response, url: string, ctx: RecorderContext): void {
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return;
  }
  const body = clone.body;
  if (!body) return;
  const stamp = monotonicClock(ctx.now);
  const cfg = ctx.config();
  const limit = cfg.maxBodyBytes;
  const draft: RealtimeConnectionDraft = {
    id: ctx.newId(),
    pageId: ctx.pageId,
    pageUrl: ctx.pageUrl(),
    transport: 'fetch-stream',
    url,
    state: 'open',
    createdAt: ctx.now(),
    openedAt: ctx.now(),
    warnings: ['fetch() event stream parsed from a response clone (opt-in setting)'],
    source: 'main-world',
  };
  const announce = () =>
    ctx.emit({ type: 'rt-connection', connection: { ...draft, warnings: [...draft.warnings] } });
  announce();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let read = 0;
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        if (!ctx.config().enabled) continue;
        const size = utf8Length(event.data);
        const { text, truncated } = truncateText(event.data, cfg.maxFrameBytes ?? 64 * 1024);
        ctx.emit({
          type: 'rt-message',
          message: {
            id: ctx.newId(),
            connectionId: draft.id,
            direction: 'in',
            timestamp: stamp(),
            opcode: 'text',
            size,
            text,
            truncated: truncated || undefined,
            sse: { type: event.type, lastEventId: event.lastEventId, retry: event.retry },
            source: 'main-world',
          },
        });
      }
      if (read >= limit) {
        draft.warnings.push(
          `Stopped parsing after ${read} bytes (body size limit); the page still receives the stream`,
        );
        await reader.cancel().catch(() => undefined);
        announce();
        return;
      }
    }
    draft.state = 'closed';
    draft.closedAt = ctx.now();
    announce();
  };
  pump().catch((err: unknown) => {
    draft.state = 'closed';
    draft.closedAt = ctx.now();
    draft.errorMessage = `Stream ended with an error: ${String(err)}`;
    announce();
  });
}
