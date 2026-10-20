// Runs the Error Detective and the full-stack investigator rules for the
// current session. Bodies are loaded only for entries the rules can use
// (failures, mutations, endpoints with a contract), never for every request.
import { useEffect, useState } from 'react';
import { detectIssues } from '../../analysis/error-detector';
import type { Finding } from '../../analysis/error-detector';
import { isFailure } from '../../analysis/filter';
import { computeLinks } from '../../analysis/investigation';
import type { InvestigationData } from '../../analysis/investigation';
import { investigatorFindings, withEvidenceLevels } from '../../analysis/investigator-rules';
import { findOperation, openApiFromObject } from '../../analysis/openapi';
import type { OpenApiDoc } from '../../analysis/openapi';
import type { Link } from '../../analysis/trace-correlate';
import type { EntryBodies, NetworkEntry, RealtimeMessage, Settings } from '../../shared/types';
import { MUTATING_METHODS, endpointKey } from '../../shared/util';
import { getStore } from './extension';
import type { SessionData } from './session-data';

export interface Analysis {
  findings: Finding[];
  bodies: Map<string, EntryBodies>;
  links: Link[];
  data: InvestigationData;
  openApi: OpenApiDoc[];
  ready: boolean;
}

const SEVERITY = { error: 0, warning: 1, info: 2 } as const;

export function integrationFlags(data: SessionData, settings: Settings) {
  const origin = data.session?.origin ?? data.recording?.origin;
  return {
    serverTracingConfigured: settings.serverIntegrations.some(
      (i) => i.enabled && (!origin || i.appOrigin === origin),
    ),
    adaptersEnabled: !!origin && settings.appAdapterOrigins.includes(origin),
    advancedCapture: !!data.recording?.advanced || data.connections.some((c) => c.sources.includes('cdp')),
  };
}

function bodyCandidates(entries: NetworkEntry[], contractKeys: Set<string>, docs: OpenApiDoc[]): string[] {
  return entries
    .filter(
      (e) =>
        isFailure(e) ||
        MUTATING_METHODS.has(e.method) ||
        contractKeys.has(endpointKey(e.method, e.url)) ||
        docs.some((d) => findOperation(d, e.method, e.url)),
    )
    .slice(-2000)
    .map((e) => e.id);
}

export function useAnalysis(
  data: SessionData,
  settings: Settings | null,
  messages: RealtimeMessage[] | null,
  enabled: boolean,
): Analysis | null {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  useEffect(() => {
    if (!enabled || !settings || data.loading || messages === null) return;
    let cancelled = false;
    void (async () => {
      const store = await getStore();
      const docs = data.contracts
        .filter((c) => c.kind === 'openapi')
        .map((c) => openApiFromObject(c.schema))
        .filter((d): d is OpenApiDoc => !!d);
      const contractKeys = new Set(
        data.contracts.filter((c) => c.kind !== 'openapi').map((c) => c.endpointKey),
      );
      const bodies = await store.getBodiesFor(bodyCandidates(data.entries, contractKeys, docs));
      const previous = data.session
        ? data.sessions.find(
            (s) =>
              s.id !== data.session!.id &&
              s.origin === data.session!.origin &&
              s.startedAt < data.session!.startedAt,
          )
        : undefined;
      let baselineEntries: NetworkEntry[] | undefined;
      let baselineBodies: Map<string, EntryBodies> | undefined;
      if (previous) {
        baselineEntries = await store.listEntries({ sessionId: previous.id });
        baselineBodies = await store.getBodiesFor(
          baselineEntries.filter((e) => isFailure(e) || MUTATING_METHODS.has(e.method)).map((e) => e.id),
        );
      }
      const flags = integrationFlags(data, settings);
      const input = {
        entries: data.entries,
        timeline: data.timeline,
        bodies,
        contracts: data.contracts.filter((c) => c.kind !== 'openapi'),
        slowRequestMs: settings.slowRequestMs,
        baselineEntries,
        baselineBodies,
        connections: data.connections,
        messages,
        spans: data.spans,
        expectations: settings.realtimeExpectations,
        openApi: docs,
        now: Date.now(),
        ...flags,
      };
      const findings = [...detectIssues(input), ...investigatorFindings(input)]
        .map(withEvidenceLevels)
        .sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
      const investigationData: InvestigationData = {
        entries: data.entries,
        timeline: data.timeline,
        connections: data.connections,
        messages,
        spans: data.spans,
        findings,
        bodies,
        expectations: settings.realtimeExpectations,
        ...flags,
      };
      const links = computeLinks(investigationData);
      if (!cancelled)
        setAnalysis({ findings, bodies, links, data: investigationData, openApi: docs, ready: true });
    })().catch(() => {
      if (!cancelled) setAnalysis(null);
    });
    return () => {
      cancelled = true;
    };
  }, [data, settings, messages, enabled]);
  return analysis;
}
