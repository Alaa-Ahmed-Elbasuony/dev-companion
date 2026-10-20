// Loads everything the dashboard shows for one session (or all sessions) from
// IndexedDB, reloading when the worker reports changes. Large collections
// (realtime messages, bodies) are loaded by the views that need them.
import { useEffect, useState } from 'react';
import type { TraceStatus } from '../../background/server-traces';
import { TRACE_STATUS_KEY } from '../../background/server-traces';
import type {
  ContractBaseline,
  Investigation,
  NetworkEntry,
  RealtimeConnection,
  RealtimeMessage,
  RecordingState,
  ServerSpan,
  Session,
  TimelineEvent,
} from '../../shared/types';
import { getStore, getTabState } from './extension';

export interface SessionData {
  sessions: Session[];
  sessionId: string;
  session: Session | undefined;
  entries: NetworkEntry[];
  timeline: TimelineEvent[];
  contracts: ContractBaseline[];
  connections: RealtimeConnection[];
  spans: ServerSpan[];
  investigations: Investigation[];
  usage: { entryCount: number; totalBytes: number };
  messageCount: number;
  recording: RecordingState | null;
  storageStatus: { message: string; at: number } | null;
  traceStatus: Record<string, TraceStatus>;
  loading: boolean;
  /** Set when IndexedDB could not be read (e.g. storage unavailable). */
  error: string | null;
}

const EMPTY: SessionData = {
  sessions: [],
  sessionId: '',
  session: undefined,
  entries: [],
  timeline: [],
  contracts: [],
  connections: [],
  spans: [],
  investigations: [],
  usage: { entryCount: 0, totalBytes: 0 },
  messageCount: 0,
  recording: null,
  storageStatus: null,
  traceStatus: {},
  loading: true,
  error: null,
};

export function useSessionData(
  requestedSession: string,
  embeddedTabId: number | undefined,
  version: number,
  reloadKey: number,
): SessionData {
  const [data, setData] = useState<SessionData>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const store = await getStore();
        const sessions = await store.listSessions();
        let current = requestedSession;
        if (!current || (current !== 'all' && !sessions.some((s) => s.id === current))) {
          const preferred =
            embeddedTabId !== undefined ? sessions.find((s) => s.tabId === embeddedTabId) : sessions[0];
          current = preferred?.id ?? 'all';
        }
        const filter = current === 'all' ? {} : { sessionId: current };
        const [
          entries,
          timeline,
          contracts,
          connections,
          spans,
          investigations,
          usage,
          messageCount,
          status,
        ] = await Promise.all([
          store.listEntries(filter),
          store.listTimeline(filter),
          store.listContracts(),
          store.listConnections(filter),
          store.listSpans(filter),
          store.listInvestigations(current === 'all' ? undefined : current),
          store.getUsage(),
          store.countMessages(),
          chrome.storage.session
            .get(['storageStatus', TRACE_STATUS_KEY])
            .catch(() => ({}) as Record<string, unknown>),
        ]);
        const session = sessions.find((s) => s.id === current);
        const tabForState = embeddedTabId ?? (session && !session.imported ? session.tabId : undefined);
        const recording =
          tabForState !== undefined
            ? (await getTabState(tabForState).catch(() => ({ recording: null }))).recording
            : null;
        const storageStatus = (status as Record<string, unknown>).storageStatus as
          { message: string; at: number } | undefined;
        if (cancelled) return;
        setData({
          sessions,
          sessionId: current,
          session,
          entries,
          timeline,
          contracts,
          connections,
          spans,
          investigations,
          usage,
          messageCount,
          recording,
          storageStatus: storageStatus && Date.now() - storageStatus.at < 10 * 60_000 ? storageStatus : null,
          traceStatus: ((status as Record<string, unknown>)[TRACE_STATUS_KEY] ?? {}) as Record<
            string,
            TraceStatus
          >,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setData((d) => ({
            ...d,
            loading: false,
            error: `Stored data could not be read: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestedSession, embeddedTabId, version, reloadKey]);
  return data;
}

/** Realtime messages of the session (capped), loaded only when a view needs them. */
export function useSessionMessages(
  sessionId: string,
  enabled: boolean,
  version: number,
): RealtimeMessage[] | null {
  const [messages, setMessages] = useState<RealtimeMessage[] | null>(null);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;
    void getStore()
      .then((s) => s.listSessionMessages(sessionId === 'all' ? undefined : sessionId, 20_000))
      .then((list) => !cancelled && setMessages(list))
      .catch(() => !cancelled && setMessages([]));
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, version]);
  return messages;
}
