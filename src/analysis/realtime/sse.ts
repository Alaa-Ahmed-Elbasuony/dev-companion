// Incremental text/event-stream parser (WHATWG "event stream interpretation").

export interface SseEvent {
  type: string;
  data: string;
  lastEventId?: string;
  retry?: number;
}

/** Feed chunks with push(); complete events are returned as soon as their blank line arrives. */
export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private type = '';
  private id: string | undefined;
  private retry: number | undefined;
  private sawField = false;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.nextLineEnd()) >= 0) {
      const line = this.buffer.slice(0, idx);
      const skip = this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(idx + skip);
      const event = this.line(line);
      if (event) events.push(event);
    }
    return events;
  }

  private nextLineEnd(): number {
    const n = this.buffer.indexOf('\n');
    const r = this.buffer.indexOf('\r');
    if (r >= 0 && (n < 0 || r < n)) {
      // A trailing "\r" may be the first half of "\r\n": wait for more input.
      if (r === this.buffer.length - 1) return -1;
      return r;
    }
    return n;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.sawField = true;
    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.type = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return null;
  }

  private dispatch(): SseEvent | null {
    const had = this.sawField;
    const event: SseEvent = {
      type: this.type || 'message',
      data: this.data.join('\n'),
      lastEventId: this.id,
      retry: this.retry,
    };
    this.data = [];
    this.type = '';
    this.retry = undefined;
    this.sawField = false;
    // Blocks with only id/retry update state but dispatch no event; we still report retry changes.
    if (!had) return null;
    if (!event.data && event.retry === undefined && this.id === undefined) return null;
    return event;
  }
}
