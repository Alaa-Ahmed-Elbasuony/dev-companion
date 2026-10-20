// Pure retention planning: decides which oldest entries to evict.

export interface RetentionLimits {
  maxEntries: number;
  maxBytes: number;
}

export interface Usage {
  entryCount: number;
  totalBytes: number;
}

/** Evict down to this fraction of the limit to avoid evicting on every insert. */
export const EVICTION_TARGET = 0.9;

export function needsEviction(usage: Usage, limits: RetentionLimits): boolean {
  return usage.entryCount > limits.maxEntries || usage.totalBytes > limits.maxBytes;
}

/**
 * Given entries in oldest-first order, returns the ids to delete so that both
 * limits are satisfied (with headroom).
 */
export function planEviction(
  oldestFirst: Iterable<{ id: string; bytes: number }>,
  usage: Usage,
  limits: RetentionLimits,
): string[] {
  if (!needsEviction(usage, limits)) return [];
  const targetCount = Math.floor(limits.maxEntries * EVICTION_TARGET);
  const targetBytes = Math.floor(limits.maxBytes * EVICTION_TARGET);
  let count = usage.entryCount;
  let bytes = usage.totalBytes;
  const evict: string[] = [];
  for (const item of oldestFirst) {
    if (count <= targetCount && bytes <= targetBytes) break;
    evict.push(item.id);
    count--;
    bytes -= item.bytes;
  }
  return evict;
}
