import type {
  CaptureConfig,
  RealtimeExpectation,
  RedactionRules,
  ServerIntegration,
  Settings,
} from './types';

export const REDACTED = '[REDACTED]';

export const DEFAULT_REDACTION: RedactionRules = {
  headerNames: [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'x-xsrf-token',
    'x-amz-security-token',
  ],
  keyRules: [
    'password',
    'passwd',
    'secret',
    'token',
    'apikey',
    'accesskey',
    'privatekey',
    'sessionid',
    'authorization',
    'cookie',
    'cardnumber',
    'creditcard',
    '=pwd',
    '=cvv',
    '=cvc',
    '=cvv2',
    '=ssn',
    '=pin',
    '=otp',
  ],
  redactTokenValues: true,
  redactCardNumbers: true,
};

export const DEFAULT_SETTINGS: Settings = {
  maxEntries: 10_000,
  maxStorageMB: 500,
  maxBodyKB: 1024,
  maxTimelineEvents: 20_000,
  slowRequestMs: 2000,
  captureConsole: true,
  captureInteractions: true,
  captureStacks: true,
  redaction: DEFAULT_REDACTION,
  captureRealtime: true,
  maxFrameKB: 64,
  maxRealtimeMessages: 50_000,
  maxSpans: 20_000,
  retentionDays: 0,
  captureFetchStreams: false,
  appAdapterOrigins: [],
  notificationSelectors: [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]',
  ],
  serverIntegrations: [],
  realtimeExpectations: [],
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const stringList = (value: unknown, fallback: string[]): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, 200)
    : fallback;

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** Normalizes an origin string ("http://localhost:3000/" -> "http://localhost:3000"); null when invalid. */
export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Collector URLs must point at the local machine: traces never leave it by default. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function integrations(value: unknown): ServerIntegration[] {
  if (!Array.isArray(value)) return [];
  const out: ServerIntegration[] = [];
  for (const raw of value.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const appOrigin = typeof r.appOrigin === 'string' ? normalizeOrigin(r.appOrigin) : null;
    const collector = typeof r.collectorUrl === 'string' ? normalizeOrigin(r.collectorUrl) : null;
    if (!appOrigin || !collector || !isLoopbackUrl(collector)) continue;
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 100) : `${appOrigin}|${collector}`,
      appOrigin,
      collectorUrl: collector,
      enabled: bool(r.enabled, true),
    });
  }
  return out;
}

function expectations(value: unknown): RealtimeExpectation[] {
  if (!Array.isArray(value)) return [];
  const out: RealtimeExpectation[] = [];
  for (const raw of value.slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const eventName = typeof r.eventName === 'string' ? r.eventName.trim().slice(0, 200) : '';
    if (!eventName) continue;
    const method = typeof r.afterMethod === 'string' ? r.afterMethod.trim().toUpperCase() : '';
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 100) : eventName,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 200) : eventName,
      afterMethod: /^[A-Z]{1,16}$/.test(method) ? method : undefined,
      afterPath:
        typeof r.afterPath === 'string' && r.afterPath.trim() ? r.afterPath.trim().slice(0, 500) : undefined,
      eventName,
      withinMs: clampInt(r.withinMs, 100, 600_000, 5000),
      requiredFields: stringList(r.requiredFields, [])
        .map((f) => f.slice(0, 200))
        .slice(0, 30),
    });
  }
  return out;
}

/** Coerces stored or user-provided settings into a valid Settings object. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const red = (r.redaction && typeof r.redaction === 'object' ? r.redaction : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    maxEntries: clampInt(r.maxEntries, 50, 100_000, d.maxEntries),
    maxStorageMB: clampInt(r.maxStorageMB, 5, 2000, d.maxStorageMB),
    maxBodyKB: clampInt(r.maxBodyKB, 1, 10_240, d.maxBodyKB),
    maxTimelineEvents: clampInt(r.maxTimelineEvents, 100, 100_000, d.maxTimelineEvents),
    slowRequestMs: clampInt(r.slowRequestMs, 50, 600_000, d.slowRequestMs),
    captureConsole: typeof r.captureConsole === 'boolean' ? r.captureConsole : d.captureConsole,
    captureInteractions:
      typeof r.captureInteractions === 'boolean' ? r.captureInteractions : d.captureInteractions,
    captureStacks: typeof r.captureStacks === 'boolean' ? r.captureStacks : d.captureStacks,
    redaction: {
      headerNames: stringList(red.headerNames, d.redaction.headerNames).map((h) => h.toLowerCase()),
      keyRules: stringList(red.keyRules, d.redaction.keyRules),
      redactTokenValues:
        typeof red.redactTokenValues === 'boolean' ? red.redactTokenValues : d.redaction.redactTokenValues,
      redactCardNumbers:
        typeof red.redactCardNumbers === 'boolean' ? red.redactCardNumbers : d.redaction.redactCardNumbers,
    },
    captureRealtime: bool(r.captureRealtime, d.captureRealtime),
    maxFrameKB: clampInt(r.maxFrameKB, 1, 4096, d.maxFrameKB),
    maxRealtimeMessages: clampInt(r.maxRealtimeMessages, 100, 500_000, d.maxRealtimeMessages),
    maxSpans: clampInt(r.maxSpans, 100, 200_000, d.maxSpans),
    retentionDays: clampInt(r.retentionDays, 0, 365, d.retentionDays),
    captureFetchStreams: bool(r.captureFetchStreams, d.captureFetchStreams),
    appAdapterOrigins: stringList(r.appAdapterOrigins, d.appAdapterOrigins)
      .map(normalizeOrigin)
      .filter((o): o is string => !!o),
    notificationSelectors: stringList(r.notificationSelectors, d.notificationSelectors)
      .map((s) => s.slice(0, 200))
      .slice(0, 20),
    serverIntegrations: integrations(r.serverIntegrations),
    realtimeExpectations: expectations(r.realtimeExpectations),
  };
}

export function captureConfigFrom(settings: Settings, enabled: boolean, origin?: string): CaptureConfig {
  return {
    enabled,
    maxBodyBytes: settings.maxBodyKB * 1024,
    captureConsole: settings.captureConsole,
    captureInteractions: settings.captureInteractions,
    captureStacks: settings.captureStacks,
    bodyReadTimeoutMs: 30_000,
    captureRealtime: settings.captureRealtime,
    maxFrameBytes: settings.maxFrameKB * 1024,
    captureFetchStreams: settings.captureFetchStreams,
    appAdapters: !!origin && settings.appAdapterOrigins.includes(origin),
    notificationSelectors: settings.notificationSelectors,
  };
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = captureConfigFrom(DEFAULT_SETTINGS, true);
