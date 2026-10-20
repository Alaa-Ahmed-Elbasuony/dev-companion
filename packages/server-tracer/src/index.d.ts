export interface RegisterOptions {
  /** service.name reported with every span. Defaults to npm_package_name. */
  serviceName?: string;
  /** Collector port on 127.0.0.1. Default 4319 (or DEV_COMPANION_COLLECTOR_PORT). */
  port?: number;
  /** Directory for .dev-companion/token. Default: process.cwd(). Ignored when DEV_COMPANION_TOKEN is set. */
  tokenDir?: string;
  /** Record bounded, redacted request/response bodies of server-side fetch(). Default true. */
  captureBodies?: boolean;
  /** Body limit in KB. Default 16. */
  maxBodyKB?: number;
  /** Spans kept in memory. Default 2000 (and at most 30 minutes). */
  maxSpans?: number;
  /** Keep db.statement / db.query.text attributes. Default false (they can contain customer data). */
  captureDbStatements?: boolean;
  /** Add traceparent headers to outbound requests. Default false: outbound requests are not modified. */
  propagateToOutbound?: boolean;
  /** Also instrument undici directly (for apps that call undici.request outside fetch). Default false. */
  instrumentUndici?: boolean;
  /** Extra redaction rules on top of the defaults. */
  redaction?: { headerNames?: string[]; keyRules?: string[] };
  /** Label of the integration in the extension. Default "next-adapter". */
  source?: string;
  /** Print the startup line. Default true. */
  log?: boolean;
}

export type RegisterResult =
  { enabled: true; collectorUrl: string; tokenFile: string | null } | { enabled: false; reason: string };

export function register(options?: RegisterOptions): Promise<RegisterResult>;
export function shutdown(): Promise<void>;
export function disabledReason(env?: Record<string, string | undefined>): string | null;
