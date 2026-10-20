// IndexedDB persistence shared by the service worker and extension pages (both
// run on the extension origin). Every mutation that changes entry count or size
// updates the "usage" meta record in the same transaction.
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type {
  ContractBaseline,
  EntryBodies,
  Investigation,
  NetworkEntry,
  RealtimeConnection,
  RealtimeMessage,
  ServerSpan,
  Session,
  TimelineEvent,
} from '../shared/types';
import { TERMINAL_STATES } from '../shared/types';
import { EVICTION_TARGET, needsEviction, planEviction } from './retention';
import type { RetentionLimits, Usage } from './retention';

export const DB_NAME = 'dev-companion';
const DB_VERSION = 2;

interface UsageRecord extends Usage {
  key: 'usage';
}

interface Schema extends DBSchema {
  entries: {
    key: string;
    value: NetworkEntry;
    indexes: { 'by-session': string; 'by-started': number; 'by-state': string };
  };
  bodies: { key: string; value: EntryBodies };
  timeline: { key: string; value: TimelineEvent; indexes: { 'by-session': string; 'by-time': number } };
  sessions: { key: string; value: Session; indexes: { 'by-started': number } };
  meta: { key: string; value: UsageRecord };
  contracts: { key: string; value: ContractBaseline };
  'rt-connections': {
    key: string;
    value: RealtimeConnection;
    indexes: { 'by-session': string; 'by-created': number; 'by-tab': number };
  };
  'rt-messages': {
    key: string;
    value: RealtimeMessage;
    indexes: {
      'by-session': string;
      'by-connection': [string, number];
      'by-time': number;
      'by-dedup': string;
    };
  };
  spans: {
    key: string;
    value: ServerSpan;
    indexes: { 'by-session': string; 'by-trace': string; 'by-time': number };
  };
  investigations: { key: string; value: Investigation; indexes: { 'by-session': string } };
}

export interface MessagePage {
  messages: RealtimeMessage[];
  /** Position of the last returned message, to continue from; absent at the end. */
  next?: [number, string];
}

type SessionScopedStore = 'rt-messages' | 'rt-connections' | 'spans' | 'investigations';

/** What to do with one item of a message run (see EntryStore.addMessages). */
export interface MessagePlan {
  /** A new message; skipped if its id already exists. */
  message?: RealtimeMessage;
  /** Replacement for an existing message (another mechanism observed it too). */
  update?: RealtimeMessage;
  /** The item's connection, changed (e.g. a refined protocol). */
  connection?: RealtimeConnection;
}

export type UpsertMode = 'start' | 'end' | 'replace';

export class EntryStore {
  private constructor(private readonly db: IDBPDatabase<Schema>) {}

  static async open(name = DB_NAME): Promise<EntryStore> {
    const db = await openDB<Schema>(name, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const entries = db.createObjectStore('entries', { keyPath: 'id' });
          entries.createIndex('by-session', 'sessionId');
          entries.createIndex('by-started', 'startedAt');
          entries.createIndex('by-state', 'state');
          db.createObjectStore('bodies', { keyPath: 'id' });
          const timeline = db.createObjectStore('timeline', { keyPath: 'id' });
          timeline.createIndex('by-session', 'sessionId');
          timeline.createIndex('by-time', 'timestamp');
          const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
          sessions.createIndex('by-started', 'startedAt');
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('contracts', { keyPath: 'endpointKey' });
        }
        if (oldVersion < 2) {
          // v2: realtime connections and messages, server spans, saved investigations.
          const conns = db.createObjectStore('rt-connections', { keyPath: 'id' });
          conns.createIndex('by-session', 'sessionId');
          conns.createIndex('by-created', 'createdAt');
          conns.createIndex('by-tab', 'tabId');
          const msgs = db.createObjectStore('rt-messages', { keyPath: 'id' });
          msgs.createIndex('by-session', 'sessionId');
          msgs.createIndex('by-connection', ['connectionId', 'timestamp']);
          msgs.createIndex('by-time', 'timestamp');
          msgs.createIndex('by-dedup', 'dedupKey');
          const spans = db.createObjectStore('spans', { keyPath: 'id' });
          spans.createIndex('by-session', 'sessionId');
          spans.createIndex('by-trace', 'traceId');
          spans.createIndex('by-time', 'startTime');
          const inv = db.createObjectStore('investigations', { keyPath: 'id' });
          inv.createIndex('by-session', 'sessionId');
        }
      },
    });
    // After an extension update, let the newer version upgrade instead of blocking it.
    db.addEventListener('versionchange', () => db.close());
    return new EntryStore(db);
  }

  close() {
    this.db.close();
  }

  // ---- entries ---------------------------------------------------------------

  /**
   * Inserts or updates an entry.
   * - "start" never overwrites an existing entry.
   * - "end" never downgrades a terminal entry back to pending and never
   *   overwrites an entry owned by another session (forged/duplicate ids).
   * Returns true when something was written.
   */
  async upsertEntry(
    entry: NetworkEntry,
    bodies: EntryBodies | undefined,
    mode: UpsertMode,
  ): Promise<boolean> {
    const tx = this.db.transaction(['entries', 'bodies', 'meta'], 'readwrite');
    const entries = tx.objectStore('entries');
    const existing = await entries.get(entry.id);
    if (existing) {
      const skip =
        mode === 'start' ||
        (mode === 'end' && existing.sessionId !== entry.sessionId) ||
        (entry.state === 'pending' && TERMINAL_STATES.includes(existing.state));
      if (skip) {
        await tx.done;
        return false;
      }
    }
    await entries.put(entry);
    if (bodies) await tx.objectStore('bodies').put(bodies);
    else if (existing) await tx.objectStore('bodies').delete(entry.id);
    await this.adjustUsage(tx.objectStore('meta'), existing ? 0 : 1, entry.bytes - (existing?.bytes ?? 0));
    await tx.done;
    return true;
  }

  async getEntry(id: string) {
    return this.db.get('entries', id);
  }

  async getBodies(id: string) {
    return this.db.get('bodies', id);
  }

  /** Loads bodies for many entries in one transaction. */
  async getBodiesFor(ids: Iterable<string>): Promise<Map<string, EntryBodies>> {
    const tx = this.db.transaction('bodies');
    const list = await Promise.all([...ids].map((id) => tx.store.get(id)));
    await tx.done;
    return new Map(list.filter((b): b is EntryBodies => !!b).map((b) => [b.id, b]));
  }

  /** Entries ordered by start time (oldest first). */
  async listEntries(filter: { sessionId?: string } = {}): Promise<NetworkEntry[]> {
    if (filter.sessionId) {
      const list = await this.db.getAllFromIndex('entries', 'by-session', filter.sessionId);
      return list.sort((a, b) => a.startedAt - b.startedAt);
    }
    return this.db.getAllFromIndex('entries', 'by-started');
  }

  async deleteEntries(ids: Iterable<string>): Promise<number> {
    const tx = this.db.transaction(['entries', 'bodies', 'meta'], 'readwrite');
    let count = 0;
    let bytes = 0;
    for (const id of ids) {
      const existing = await tx.objectStore('entries').get(id);
      if (!existing) continue;
      await tx.objectStore('entries').delete(id);
      await tx.objectStore('bodies').delete(id);
      count++;
      bytes += existing.bytes;
    }
    await this.adjustUsage(tx.objectStore('meta'), -count, -bytes);
    await tx.done;
    return count;
  }

  /** Marks pending entries of a tab that belong to another document as incomplete. */
  async markIncomplete(tabId: number, currentPageId: string | null, reason: string): Promise<number> {
    const tx = this.db.transaction('entries', 'readwrite');
    const pending = await tx.store.index('by-state').getAll('pending');
    let changed = 0;
    for (const entry of pending) {
      if (entry.tabId !== tabId || entry.pageId === currentPageId) continue;
      await tx.store.put({ ...entry, state: 'incomplete', warnings: [...entry.warnings, reason] });
      changed++;
    }
    await tx.done;
    return changed;
  }

  /** Marks all pending entries of a session as incomplete (e.g. recording stopped). */
  async markSessionIncomplete(sessionId: string, reason: string): Promise<number> {
    const tx = this.db.transaction('entries', 'readwrite');
    const pending = await tx.store.index('by-state').getAll('pending');
    let changed = 0;
    for (const entry of pending) {
      if (entry.sessionId !== sessionId) continue;
      await tx.store.put({ ...entry, state: 'incomplete', warnings: [...entry.warnings, reason] });
      changed++;
    }
    await tx.done;
    return changed;
  }

  // ---- usage & retention -----------------------------------------------------

  private async adjustUsage(
    meta: { get(key: string): Promise<UsageRecord | undefined>; put(v: UsageRecord): Promise<unknown> },
    deltaCount: number,
    deltaBytes: number,
  ) {
    if (!deltaCount && !deltaBytes) return;
    const usage = (await meta.get('usage')) ?? { key: 'usage', entryCount: 0, totalBytes: 0 };
    await meta.put({
      key: 'usage',
      entryCount: Math.max(0, usage.entryCount + deltaCount),
      totalBytes: Math.max(0, usage.totalBytes + deltaBytes),
    });
  }

  async getUsage(): Promise<Usage> {
    const usage = await this.db.get('meta', 'usage');
    return { entryCount: usage?.entryCount ?? 0, totalBytes: usage?.totalBytes ?? 0 };
  }

  /** Recomputes usage from scratch (repairs drift). */
  async recomputeUsage(): Promise<Usage> {
    const tx = this.db.transaction(['entries', 'meta'], 'readwrite');
    let entryCount = 0;
    let totalBytes = 0;
    let cursor = await tx.objectStore('entries').openCursor();
    while (cursor) {
      entryCount++;
      totalBytes += cursor.value.bytes;
      cursor = await cursor.continue();
    }
    await tx.objectStore('meta').put({ key: 'usage', entryCount, totalBytes });
    await tx.done;
    return { entryCount, totalBytes };
  }

  /** Deletes the oldest entries until both limits are met. Returns evicted ids. */
  async enforceRetention(limits: RetentionLimits): Promise<string[]> {
    const usage = await this.getUsage();
    if (!needsEviction(usage, limits)) return [];
    // Read oldest entries until we have enough candidates.
    const excess = Math.max(
      usage.entryCount - Math.floor(limits.maxEntries * EVICTION_TARGET),
      Math.ceil(usage.entryCount * 0.05),
      1,
    );
    const candidates: { id: string; bytes: number }[] = [];
    let needBytes = usage.totalBytes - Math.floor(limits.maxBytes * EVICTION_TARGET);
    let cursor = await this.db.transaction('entries').store.index('by-started').openCursor();
    while (cursor && (candidates.length < excess || needBytes > 0)) {
      candidates.push({ id: cursor.value.id, bytes: cursor.value.bytes });
      needBytes -= cursor.value.bytes;
      cursor = await cursor.continue();
    }
    const evict = planEviction(candidates, usage, limits);
    if (evict.length) await this.deleteEntries(evict);
    return evict;
  }

  /** Emergency eviction for quota errors: drops the oldest fraction of entries. */
  async evictOldestFraction(fraction: number): Promise<number> {
    const usage = await this.getUsage();
    const n = Math.max(1, Math.ceil(usage.entryCount * fraction));
    const ids: string[] = [];
    let cursor = await this.db.transaction('entries').store.index('by-started').openCursor();
    while (cursor && ids.length < n) {
      ids.push(cursor.value.id);
      cursor = await cursor.continue();
    }
    return this.deleteEntries(ids);
  }

  /** Applies a transformation to every stored entry and its bodies (used to re-apply redaction). */
  async rewriteEntries(
    fn: (
      entry: NetworkEntry,
      bodies: EntryBodies | undefined,
    ) => { entry: NetworkEntry; bodies: EntryBodies | undefined } | null,
  ): Promise<number> {
    const ids = await this.db.getAllKeys('entries');
    let changed = 0;
    for (const id of ids) {
      const tx = this.db.transaction(['entries', 'bodies', 'meta'], 'readwrite');
      const entry = await tx.objectStore('entries').get(id);
      if (!entry) {
        await tx.done;
        continue;
      }
      const bodies = await tx.objectStore('bodies').get(id);
      const result = fn(entry, bodies);
      if (result) {
        await tx.objectStore('entries').put(result.entry);
        if (result.bodies) await tx.objectStore('bodies').put(result.bodies);
        await this.adjustUsage(tx.objectStore('meta'), 0, result.entry.bytes - entry.bytes);
        changed++;
      }
      await tx.done;
    }
    return changed;
  }

  /** Returns ids (from the given set) whose request or response body contains the query. */
  async searchBodies(ids: Set<string>, query: string): Promise<Set<string>> {
    const q = query.toLowerCase();
    const matches = new Set<string>();
    let cursor = await this.db.transaction('bodies').store.openCursor();
    while (cursor) {
      const b = cursor.value;
      if (
        ids.has(b.id) &&
        ((b.request?.text && b.request.text.toLowerCase().includes(q)) ||
          (b.response?.text && b.response.text.toLowerCase().includes(q)))
      ) {
        matches.add(b.id);
      }
      cursor = await cursor.continue();
    }
    return matches;
  }

  // ---- timeline ----------------------------------------------------------------

  async putTimeline(event: TimelineEvent) {
    await this.db.put('timeline', event);
  }

  async listTimeline(filter: { sessionId?: string } = {}): Promise<TimelineEvent[]> {
    const list = filter.sessionId
      ? await this.db.getAllFromIndex('timeline', 'by-session', filter.sessionId)
      : await this.db.getAllFromIndex('timeline', 'by-time');
    return list.sort((a, b) => a.timestamp - b.timestamp);
  }

  async enforceTimelineRetention(maxEvents: number): Promise<number> {
    const count = await this.db.count('timeline');
    if (count <= maxEvents) return 0;
    const target = count - Math.floor(maxEvents * EVICTION_TARGET);
    const tx = this.db.transaction('timeline', 'readwrite');
    let cursor = await tx.store.index('by-time').openCursor();
    let deleted = 0;
    while (cursor && deleted < target) {
      await cursor.delete();
      deleted++;
      cursor = await cursor.continue();
    }
    await tx.done;
    return deleted;
  }

  async deleteTimelineEvents(ids: Iterable<string>) {
    const tx = this.db.transaction('timeline', 'readwrite');
    for (const id of ids) await tx.store.delete(id);
    await tx.done;
  }

  // ---- sessions ----------------------------------------------------------------

  async putSession(session: Session) {
    await this.db.put('sessions', session);
  }

  async getSession(id: string) {
    return this.db.get('sessions', id);
  }

  async listSessions(): Promise<Session[]> {
    return (await this.db.getAllFromIndex('sessions', 'by-started')).reverse();
  }

  /** Deletes a session's entries, bodies and timeline events (the session record is kept unless removeSession). */
  async clearSession(sessionId: string, removeSession = false): Promise<void> {
    const entryIds = await this.db.getAllKeysFromIndex('entries', 'by-session', sessionId);
    await this.deleteEntries(entryIds);
    const timelineIds = await this.db.getAllKeysFromIndex('timeline', 'by-session', sessionId);
    await this.deleteTimelineEvents(timelineIds);
    await this.deleteBySession('rt-messages', sessionId);
    await this.deleteBySession('rt-connections', sessionId);
    await this.deleteBySession('spans', sessionId);
    if (removeSession) {
      await this.deleteBySession('investigations', sessionId);
      await this.db.delete('sessions', sessionId);
    }
  }

  private async deleteBySession(store: SessionScopedStore, sessionId: string) {
    const tx = this.db.transaction(store, 'readwrite');
    let cursor = await tx.store.index('by-session').openKeyCursor(sessionId);
    while (cursor) {
      await tx.store.delete(cursor.primaryKey);
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  async clearAll(keepSessionIds: string[] = []): Promise<void> {
    const tx = this.db.transaction(
      [
        'entries',
        'bodies',
        'timeline',
        'sessions',
        'meta',
        'rt-connections',
        'rt-messages',
        'spans',
        'investigations',
      ],
      'readwrite',
    );
    await Promise.all([
      tx.objectStore('entries').clear(),
      tx.objectStore('bodies').clear(),
      tx.objectStore('timeline').clear(),
      tx.objectStore('rt-connections').clear(),
      tx.objectStore('rt-messages').clear(),
      tx.objectStore('spans').clear(),
      tx.objectStore('investigations').clear(),
      tx.objectStore('meta').put({ key: 'usage', entryCount: 0, totalBytes: 0 }),
    ]);
    const sessions = tx.objectStore('sessions');
    let cursor = await sessions.openCursor();
    while (cursor) {
      if (!keepSessionIds.includes(cursor.value.id)) await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  // ---- realtime ----------------------------------------------------------------

  async getConnection(id: string) {
    return this.db.get('rt-connections', id);
  }

  async putConnection(connection: RealtimeConnection) {
    await this.db.put('rt-connections', connection);
  }

  /** Read-modify-write of one connection; `fn` returns the new record or null to skip. */
  async updateConnection(
    id: string,
    fn: (current: RealtimeConnection | undefined) => RealtimeConnection | null,
  ): Promise<RealtimeConnection | undefined> {
    const tx = this.db.transaction('rt-connections', 'readwrite');
    const current = await tx.store.get(id);
    const next = fn(current);
    if (next) await tx.store.put(next);
    await tx.done;
    return next ?? current;
  }

  async listConnections(filter: { sessionId?: string; tabId?: number } = {}): Promise<RealtimeConnection[]> {
    const list = filter.sessionId
      ? await this.db.getAllFromIndex('rt-connections', 'by-session', filter.sessionId)
      : filter.tabId !== undefined
        ? await this.db.getAllFromIndex('rt-connections', 'by-tab', filter.tabId)
        : await this.db.getAll('rt-connections');
    return list.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Stores a message and updates its connection's counters in one transaction.
   * Never overwrites an existing message id; returns false when skipped.
   */
  async addMessage(message: RealtimeMessage): Promise<boolean> {
    return (await this.addMessages([message], (m) => ({ message: m })))[0] ?? false;
  }

  /**
   * Stores a run of realtime messages in one transaction (one transaction per
   * frame capped capture at a few hundred frames per second). For each item,
   * `plan` receives the item's connection, including changes made earlier in
   * the run, and returns the message to store or null to skip it. Connection
   * counters are updated for stored messages. Never overwrites an existing
   * message id unless the plan marks it as an update of that message.
   */
  async addMessages<T>(
    items: T[],
    plan: (
      item: T,
      lookup: {
        connection: (id: string) => Promise<RealtimeConnection | undefined>;
        sameKey: (key: string) => Promise<RealtimeMessage[]>;
      },
    ) => Promise<MessagePlan | null> | MessagePlan | null,
  ): Promise<boolean[]> {
    if (!items.length) return [];
    const tx = this.db.transaction(['rt-messages', 'rt-connections'], 'readwrite');
    const msgs = tx.objectStore('rt-messages');
    const conns = tx.objectStore('rt-connections');
    const cache = new Map<string, RealtimeConnection | undefined>();
    const changed = new Set<string>();
    const lookup = {
      connection: async (id: string) => {
        if (!cache.has(id)) cache.set(id, await conns.get(id));
        return cache.get(id);
      },
      sameKey: (key: string) => msgs.index('by-dedup').getAll(key),
    };
    const results: boolean[] = [];
    try {
      for (const item of items) {
        const p = await plan(item, lookup);
        if (!p) {
          results.push(false);
          continue;
        }
        if (p.connection) {
          cache.set(p.connection.id, p.connection);
          changed.add(p.connection.id);
        }
        if (p.update) {
          await msgs.put(p.update);
          results.push(true);
          continue;
        }
        const message = p.message;
        if (!message || (await msgs.get(message.id))) {
          results.push(false);
          continue;
        }
        await msgs.put(message);
        const conn = await lookup.connection(message.connectionId);
        if (conn && conn.sessionId === message.sessionId && message.opcode !== 'lifecycle') {
          const size = message.size ?? 0;
          const incoming = message.direction === 'in';
          cache.set(conn.id, {
            ...conn,
            inCount: conn.inCount + (incoming ? 1 : 0),
            outCount: conn.outCount + (message.direction === 'out' ? 1 : 0),
            bytesIn: conn.bytesIn + (incoming ? size : 0),
            bytesOut: conn.bytesOut + (message.direction === 'out' ? size : 0),
            lastMessageAt: Math.max(conn.lastMessageAt ?? 0, message.timestamp),
          });
          changed.add(conn.id);
        }
        results.push(true);
      }
      for (const id of changed) {
        const conn = cache.get(id);
        if (conn) await conns.put(conn);
      }
    } catch (err) {
      // Nothing of a failed run is kept.
      tx.abort();
      await tx.done.catch(() => undefined);
      throw err;
    }
    await tx.done;
    return results;
  }

  async getMessage(id: string) {
    return this.db.get('rt-messages', id);
  }

  /** Messages of one connection in time order, one page at a time. */
  async listMessages(
    connectionId: string,
    options: { after?: [number, string]; limit?: number } = {},
  ): Promise<MessagePage> {
    const limit = options.limit ?? 500;
    const after = options.after;
    const range = IDBKeyRange.bound([connectionId, after?.[0] ?? -Infinity], [connectionId, Infinity]);
    const tx = this.db.transaction('rt-messages');
    let cursor = await tx.store.index('by-connection').openCursor(range);
    // Index entries with equal timestamps are ordered by primary key (id).
    while (cursor && after && cursor.value.timestamp === after[0] && cursor.value.id <= after[1]) {
      cursor = await cursor.continue();
    }
    const messages: RealtimeMessage[] = [];
    while (cursor && messages.length < limit) {
      messages.push(cursor.value);
      cursor = await cursor.continue();
    }
    const more = !!cursor;
    await tx.done;
    const last = messages[messages.length - 1];
    return { messages, next: more && last ? [last.timestamp, last.id] : undefined };
  }

  /** Messages of a session (or the newest across all sessions), in time order, capped. */
  async listSessionMessages(sessionId: string | undefined, limit = 20_000): Promise<RealtimeMessage[]> {
    const tx = this.db.transaction('rt-messages');
    const out: RealtimeMessage[] = [];
    let cursor = sessionId
      ? await tx.store.index('by-session').openCursor(sessionId)
      : await tx.store.index('by-time').openCursor(null, 'prev');
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    return out.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
  }

  /** Scans messages of a connection or session; stops after `limit` matches. */
  async searchMessages(
    scope: { connectionId?: string; sessionId?: string },
    predicate: (m: RealtimeMessage) => boolean,
    limit = 1000,
  ): Promise<RealtimeMessage[]> {
    const tx = this.db.transaction('rt-messages');
    let cursor = scope.connectionId
      ? await tx.store
          .index('by-connection')
          .openCursor(IDBKeyRange.bound([scope.connectionId, -Infinity], [scope.connectionId, Infinity]))
      : scope.sessionId
        ? await tx.store.index('by-session').openCursor(scope.sessionId)
        : await tx.store.index('by-time').openCursor();
    const out: RealtimeMessage[] = [];
    while (cursor && out.length < limit) {
      if (predicate(cursor.value)) out.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    return out;
  }

  async countMessages(): Promise<number> {
    return this.db.count('rt-messages');
  }

  /** Closes connections of a tab that belong to other documents (the page navigated). */
  async closeConnectionsOfOtherPages(
    tabId: number,
    currentPageId: string,
    reason: string,
    at: number,
  ): Promise<number> {
    const tx = this.db.transaction('rt-connections', 'readwrite');
    const list = await tx.store.index('by-tab').getAll(tabId);
    let changed = 0;
    for (const c of list) {
      if (c.pageId === currentPageId || c.state === 'closed' || c.state === 'failed') continue;
      // CDP-only observations have no page id; CDP reports their closure itself.
      if (!c.pageId) continue;
      await tx.store.put({
        ...c,
        state: 'closed',
        closedAt: c.closedAt ?? at,
        warnings: [...c.warnings, reason],
      });
      changed++;
    }
    await tx.done;
    return changed;
  }

  /** Flags still-open connections of a session as no longer observed (recording stopped). */
  async markConnectionsUnobserved(sessionId: string, reason: string): Promise<void> {
    const tx = this.db.transaction('rt-connections', 'readwrite');
    const list = await tx.store.index('by-session').getAll(sessionId);
    for (const c of list) {
      if (c.state === 'closed' || c.state === 'failed' || c.warnings.includes(reason)) continue;
      await tx.store.put({ ...c, warnings: [...c.warnings, reason] });
    }
    await tx.done;
  }

  async enforceRealtimeRetention(maxMessages: number): Promise<number> {
    return this.trimOldest('rt-messages', maxMessages);
  }

  private async trimOldest(store: 'rt-messages' | 'spans', max: number): Promise<number> {
    const count = await this.db.count(store);
    if (count <= max) return 0;
    const target = count - Math.floor(max * EVICTION_TARGET);
    const tx = this.db.transaction(store, 'readwrite');
    let cursor = await tx.store.index('by-time').openCursor();
    let deleted = 0;
    while (cursor && deleted < target) {
      await cursor.delete();
      deleted++;
      cursor = await cursor.continue();
    }
    await tx.done;
    return deleted;
  }

  // ---- spans -------------------------------------------------------------------

  /** Inserts spans. An existing span is replaced only by a copy from the same session that has not regressed. */
  async putSpans(spans: ServerSpan[]): Promise<number> {
    if (!spans.length) return 0;
    const tx = this.db.transaction('spans', 'readwrite');
    let written = 0;
    for (const span of spans) {
      const existing = await tx.store.get(span.id);
      if (existing && (existing.sessionId !== span.sessionId || (existing.endTime && !span.endTime)))
        continue;
      await tx.store.put(span);
      written++;
    }
    await tx.done;
    return written;
  }

  async listSpans(filter: { sessionId?: string; traceId?: string } = {}): Promise<ServerSpan[]> {
    const list = filter.traceId
      ? await this.db.getAllFromIndex('spans', 'by-trace', filter.traceId)
      : filter.sessionId
        ? await this.db.getAllFromIndex('spans', 'by-session', filter.sessionId)
        : await this.db.getAll('spans');
    return list.sort((a, b) => a.startTime - b.startTime);
  }

  async enforceSpanRetention(maxSpans: number): Promise<number> {
    return this.trimOldest('spans', maxSpans);
  }

  // ---- investigations ----------------------------------------------------------

  async putInvestigation(investigation: Investigation) {
    await this.db.put('investigations', investigation);
  }

  async listInvestigations(sessionId?: string): Promise<Investigation[]> {
    const list = sessionId
      ? await this.db.getAllFromIndex('investigations', 'by-session', sessionId)
      : await this.db.getAll('investigations');
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteInvestigation(id: string) {
    await this.db.delete('investigations', id);
  }

  // ---- age-based retention -----------------------------------------------------

  /** Deletes requests, timeline events, realtime messages, closed connections and spans older than `cutoff`. */
  async deleteOlderThan(cutoff: number): Promise<number> {
    const range = IDBKeyRange.upperBound(cutoff, true);
    const oldEntries: string[] = [];
    let ec = await this.db.transaction('entries').store.index('by-started').openKeyCursor(range);
    while (ec) {
      oldEntries.push(ec.primaryKey);
      ec = await ec.continue();
    }
    let deleted = oldEntries.length ? await this.deleteEntries(oldEntries) : 0;
    for (const store of ['timeline', 'rt-messages', 'spans'] as const) {
      const tx = this.db.transaction(store, 'readwrite');
      let cursor = await tx.store.index('by-time').openCursor(range);
      while (cursor) {
        await cursor.delete();
        deleted++;
        cursor = await cursor.continue();
      }
      await tx.done;
    }
    const tx = this.db.transaction('rt-connections', 'readwrite');
    let cc = await tx.store.index('by-created').openCursor(range);
    while (cc) {
      if (cc.value.state === 'closed' || cc.value.state === 'failed') {
        await cc.delete();
        deleted++;
      }
      cc = await cc.continue();
    }
    await tx.done;
    return deleted;
  }

  // ---- contracts ---------------------------------------------------------------

  async putContract(contract: ContractBaseline) {
    await this.db.put('contracts', contract);
  }

  async listContracts(): Promise<ContractBaseline[]> {
    return this.db.getAll('contracts');
  }

  async deleteContract(endpointKey: string) {
    await this.db.delete('contracts', endpointKey);
  }
}

export function isQuotaError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'name' in err &&
    ((err as { name: string }).name === 'QuotaExceededError' ||
      (err as { name: string }).name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}
