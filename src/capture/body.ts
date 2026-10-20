// Serializes request/response bodies for capture without consuming data the
// page needs. Runs in the page's main world: no chrome.* APIs here.
import type { CapturedBody } from '../shared/types';
import { isJsonContentType, isTextualContentType, truncateText, utf8Length } from '../shared/util';

function textBody(text: string, contentType: string | undefined, maxBytes: number): CapturedBody {
  const size = utf8Length(text);
  const { text: kept, truncated } = truncateText(text, maxBytes);
  let kind: CapturedBody['kind'] = 'text';
  if (isJsonContentType(contentType)) kind = 'json';
  else if (contentType && /x-www-form-urlencoded/i.test(contentType)) kind = 'form';
  else if (!contentType && /^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text);
      kind = 'json';
    } catch {
      /* plain text */
    }
  }
  return { kind, text: kept, size, truncated: truncated || undefined, contentType };
}

function describeFile(value: File | Blob): string {
  const name = 'name' in value ? (value as File).name : 'blob';
  return `[file ${name}, ${value.size} bytes, ${value.type || 'unknown type'}]`;
}

/**
 * Serializes a request body passed to fetch/XHR/sendBeacon. Never reads streams
 * (that would consume the page's data). Blobs are immutable, so small textual
 * blobs are read asynchronously.
 */
export async function serializeRequestBody(
  body: unknown,
  contentType: string | undefined,
  maxBytes: number,
): Promise<CapturedBody | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return textBody(body, contentType, maxBytes);
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return textBody(body.toString(), contentType ?? 'application/x-www-form-urlencoded', maxBytes);
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const params = new URLSearchParams();
    body.forEach((value, key) => {
      params.append(key, typeof value === 'string' ? value : describeFile(value));
    });
    const result = textBody(params.toString(), 'application/x-www-form-urlencoded', maxBytes);
    return { ...result, kind: 'form', contentType: contentType ?? 'multipart/form-data' };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const type = contentType ?? body.type;
    if (isTextualContentType(type) && body.size <= maxBytes * 4) {
      return textBody(await body.text(), type, maxBytes);
    }
    return {
      kind: 'binary',
      size: body.size,
      contentType: type || undefined,
      note: 'Binary body not stored',
    };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const size = body.byteLength;
    if (isTextualContentType(contentType) && size <= maxBytes * 4) {
      const bytes =
        body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, size);
      return textBody(new TextDecoder().decode(bytes), contentType, maxBytes);
    }
    return { kind: 'binary', size, contentType, note: 'Binary body not stored' };
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return { kind: 'stream', contentType, note: 'Streaming request bodies are not captured' };
  }
  return {
    kind: 'unreadable',
    contentType,
    note: `Unsupported body type: ${Object.prototype.toString.call(body)}`,
  };
}

export interface ReadResponseOptions {
  maxBytes: number;
  timeoutMs: number;
  method: string;
}

/**
 * Reads a response body from a clone of the response, leaving the original
 * untouched. Reads at most maxBytes and cancels the clone afterwards so the
 * tee does not keep buffering for us.
 */
export async function readResponseBody(response: Response, opts: ReadResponseOptions): Promise<CapturedBody> {
  const contentType = response.headers.get('content-type') ?? undefined;
  const lengthHeader = response.headers.get('content-length');
  const declaredSize = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;

  if (response.type === 'opaque' || response.type === 'opaqueredirect') {
    return {
      kind: 'unreadable',
      contentType,
      note: 'Opaque response (mode "no-cors" or manual redirect): the browser hides the body and status from page scripts',
    };
  }
  if (
    opts.method === 'HEAD' ||
    response.status === 204 ||
    response.status === 304 ||
    response.body === null
  ) {
    return { kind: 'none', size: 0, contentType };
  }
  if (contentType && /text\/event-stream/i.test(contentType)) {
    return {
      kind: 'stream',
      contentType,
      note: 'Server-sent event stream: not read, to avoid holding an open stream',
    };
  }
  if (contentType && !isTextualContentType(contentType)) {
    return { kind: 'binary', size: declaredSize, contentType, note: 'Binary body not stored' };
  }
  if (response.bodyUsed) {
    return { kind: 'unreadable', contentType, note: 'Body was already consumed before capture' };
  }

  let clone: Response;
  try {
    clone = response.clone();
  } catch (err) {
    return { kind: 'unreadable', contentType, note: `Response could not be cloned: ${String(err)}` };
  }
  const reader = clone.body?.getReader();
  if (!reader) return { kind: 'none', size: 0, contentType };

  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  let truncated = false;
  let timedOut = false;
  let failed: string | undefined;
  const deadline = Date.now() + opts.timeoutMs;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((res) => {
          timer = setTimeout(() => res('timeout'), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (result === 'timeout') {
        timedOut = true;
        break;
      }
      if (result.done) break;
      received += result.value.byteLength;
      text += decoder.decode(result.value, { stream: true });
      if (received > opts.maxBytes) {
        truncated = true;
        break;
      }
    }
    text += decoder.decode();
  } catch (err) {
    failed = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } finally {
    if (truncated || timedOut || failed) reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }

  const result = textBody(text, contentType, opts.maxBytes);
  const notes: string[] = [];
  if (truncated || result.truncated) notes.push(`Body truncated at ${opts.maxBytes} bytes`);
  if (timedOut) notes.push(`Stopped reading after ${opts.timeoutMs} ms; body may be incomplete`);
  if (failed) notes.push(`Body read interrupted (${failed}); body may be incomplete`);
  // Heuristic: undeclared content types that decode to mostly replacement characters are binary.
  if (!contentType && result.text && (result.text.match(/�/g)?.length ?? 0) > result.text.length / 10) {
    return { kind: 'binary', size: declaredSize ?? received, note: 'Body looks binary; not stored' };
  }
  return {
    ...result,
    size: truncated || timedOut || failed ? (declaredSize ?? received) : received,
    truncated: truncated || result.truncated || timedOut || !!failed || undefined,
    note: notes.length ? notes.join('. ') : undefined,
  };
}
