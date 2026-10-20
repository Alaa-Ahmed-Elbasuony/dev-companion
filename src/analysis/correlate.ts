// Links timeline events to network requests by time proximity within a tab.
import type { NetworkEntry, TimelineEvent } from '../shared/types';
import { isFailure } from './filter';

export const ERROR_KINDS = new Set(['console-error', 'js-error', 'unhandled-rejection']);

export interface CorrelationWindows {
  /** A failed request that ended up to this long before an error is related to it. */
  errorAfterFailureMs: number;
  /** Allowance for errors logged slightly before the request outcome was recorded. */
  errorBeforeFailureMs: number;
  /** Requests started this long after a click/submit are related to it. */
  interactionMs: number;
}

export const DEFAULT_WINDOWS: CorrelationWindows = {
  errorAfterFailureMs: 5000,
  errorBeforeFailureMs: 500,
  interactionMs: 1500,
};

/** Returns related request ids for each timeline event that has any. */
export function correlate(
  entries: NetworkEntry[],
  events: TimelineEvent[],
  windows: CorrelationWindows = DEFAULT_WINDOWS,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const event of events) {
    let related: NetworkEntry[] = [];
    if (ERROR_KINDS.has(event.kind)) {
      related = entries.filter((e) => {
        if (e.tabId !== event.tabId || !isFailure(e)) return false;
        const end = e.endedAt ?? e.startedAt;
        return (
          end >= event.timestamp - windows.errorAfterFailureMs &&
          end <= event.timestamp + windows.errorBeforeFailureMs
        );
      });
    } else if (event.kind === 'click' || event.kind === 'form-submit') {
      related = entries.filter(
        (e) =>
          e.tabId === event.tabId &&
          e.startedAt >= event.timestamp &&
          e.startedAt <= event.timestamp + windows.interactionMs,
      );
    }
    if (related.length)
      result.set(
        event.id,
        related.map((e) => e.id),
      );
  }
  return result;
}
