# @dev-companion/server-tracer

Development-only server tracing for [Dev Companion](../../README.md). It records what your Node server does while rendering a page or handling a request (server rendering, route handlers, outbound `fetch` and `node:http` calls) and makes it available to the extension. The extension shows those spans in its Tracing view next to the browser requests they belong to.

Nothing is sent anywhere. Spans stay in the server process, in a bounded in-memory buffer, and are served by a local collector on `127.0.0.1` that only the extension can read.

> Use it in development only. It refuses to start when `NODE_ENV=production`, during `next build`, in the Edge runtime, or unless `DEV_COMPANION_TRACING=1` is set.

## Requirements

- Node.js 20 or newer.
- A server that runs in the Node.js runtime. It is tested with Next.js 16 (App Router and Pages Router, `next dev`). The OpenTelemetry instrumentation is not Next.js-specific, but other frameworks have not been tested.

## Install

The package is not published to npm. Install it from this repository:

```bash
npm install --save-dev file:../path/to/dev-tool-extension/packages/server-tracer
```

## Set up with Next.js

1. Add `instrumentation.js` (or `.ts`) at the project root:

   ```js
   export async function register() {
     if (process.env.NEXT_RUNTIME !== 'nodejs') return;
     const { register: registerTracing } = await import('@dev-companion/server-tracer');
     await registerTracing({ serviceName: 'my-app' });
   }
   ```

2. To link a page load to its server render, let Next.js render the trace id into the HTML:

   ```js
   // next.config.mjs
   export default {
     experimental: { clientTraceMetadata: ['traceparent'] },
   };
   ```

   The browser then sees `<meta name="traceparent">`, and the extension links the navigation to the server trace by trace id ("explicit" link). Without it, links are made by time and path and are labelled "by time only".

3. Start the dev server with tracing on:

   ```bash
   DEV_COMPANION_TRACING=1 npm run dev          # PowerShell: $env:DEV_COMPANION_TRACING=1; npm run dev
   ```

   It prints:

   ```
   [dev-companion] server tracing on. Collector http://127.0.0.1:4319 (loopback only). Token: /your/app/.dev-companion/token
   ```

4. In the extension: **Settings → Integrations → Server tracing → Add server integration**. Enter the app origin (for example `http://localhost:3000`), the collector URL (`http://127.0.0.1:4319`) and the token from the file printed above. Click **Test connection**.

5. Start recording the app's tab as usual. Spans are pulled shortly after each navigation or request, and the Overview's "Server / SSR tracing" card shows the collector status.

To uninstall, delete `instrumentation.js` (or the call in it) and remove the dependency.

## Options

`register(options)` returns `{ enabled: true, collectorUrl, tokenFile }` or `{ enabled: false, reason }`. It is safe to call more than once per process (Next.js reloads modules in development). Only the first call takes effect.

| Option                | Default                                    | Meaning                                                                                       |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `serviceName`         | `npm_package_name`                         | `service.name` on every span                                                                  |
| `port`                | `4319` (or `DEV_COMPANION_COLLECTOR_PORT`) | Collector port on `127.0.0.1`                                                                 |
| `tokenDir`            | `process.cwd()`                            | Where `.dev-companion/token` is kept; ignored when `DEV_COMPANION_TOKEN` is set               |
| `captureBodies`       | `true`                                     | Record bounded, redacted request/response bodies of server-side `fetch()`                     |
| `maxBodyKB`           | `16`                                       | Body limit per direction                                                                      |
| `maxSpans`            | `2000`                                     | Spans kept in memory (also at most 30 minutes old)                                            |
| `captureDbStatements` | `false`                                    | Keep `db.statement` / `db.query.text` attributes (they can contain customer data)             |
| `propagateToOutbound` | `false`                                    | Add `traceparent` headers to outbound requests. By default outbound requests are not modified |
| `instrumentUndici`    | `false`                                    | Also instrument undici directly (for code that calls `undici.request` outside `fetch`)        |
| `redaction`           | —                                          | Extra `{ headerNames, keyRules }` on top of the defaults                                      |
| `source`              | `"next-adapter"`                           | Label of the integration shown in the extension                                               |
| `log`                 | `true`                                     | Print the startup line (and the reason when tracing is disabled although requested)           |

Environment variables: `DEV_COMPANION_TRACING=1` (required), `DEV_COMPANION_TOKEN` (fixed token instead of the token file), `DEV_COMPANION_COLLECTOR_PORT`.

`shutdown()` stops the collector and the tracer provider. `disabledReason(env)` tells you why tracing would not start.

## What is recorded

- Incoming requests (page renders, route handlers, API routes), named by method and path (`GET /orders`). Next.js asset, HMR and image requests and the collector itself are ignored.
- Next.js render phases (Next.js creates these spans itself) and server `fetch()` calls, including whether a fetch was served from the Next.js data cache.
- Outbound `node:http` / `https` calls, named by method and URL.
- Status, timing, errors, and the request ids `x-request-id` / `x-correlation-id` / `traceparent` from incoming request headers, plus `x-request-id` on outbound calls, so the extension can link spans to browser requests by shared id.
- Bodies of server `fetch()` calls, when they are textual, up to `maxBodyKB`, read from a clone. The caller gets the original `Response`.

## Security

- **Loopback only.** The collector listens on `127.0.0.1` and rejects requests whose `Host` header is not a loopback name (DNS-rebinding protection).
- **Token required.** Every request needs `Authorization: Bearer <token>`, compared in constant time. The token file is created with mode 0600 inside `.dev-companion/`, together with a `.gitignore` containing `*`. Add `.dev-companion/` to your own ignore files as well.
- **Browsers can't read it.** Requests with an `Origin` other than `chrome-extension://…` are rejected, even with a valid token.
- **Redaction before buffering.** Sensitive headers (`authorization`, `cookie`, `x-api-key`, …), URL query parameters, attributes and bodies are redacted with the same default rules as the extension. The extension redacts again when it stores spans.
- **No changes to your traffic.** Outbound requests are left untouched unless you set `propagateToOutbound`.
- **Bounded memory.** At most `maxSpans` spans and 30 minutes are kept; the collector reports how many were dropped. The collector doesn't keep the process alive.

## Collector API

Used by the extension; documented here for debugging. Both endpoints require the bearer token.

| Request                                       | Response                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/health`                              | `{ ok, service, instance, startedAt, buffered, dropped }`                                                                                                    |
| `GET /v1/spans?after=<cursor>&limit=<n≤1000>` | `{ instance, startedAt, service, dropped, spans: [...], cursor, more }`. Pass `cursor` as `after` next time. A changed `instance` means the server restarted |

## Limitations

- Development only: statically generated and ISR pages are produced by `next build` / `next start`, where tracing is off, so they aren't traced.
- Next.js middleware has not been tested. The Edge runtime is not supported.
- If the collector port is taken, the tracer logs a warning and stays disabled. This path is not covered by automated tests.
- Spans are held in memory. A server restart loses spans that the extension hasn't pulled yet; the extension notices the new collector instance and continues.

## Tests

- Unit tests: `tests/server/server-tracer.test.ts` in the repository root (`npm test`).
- End to end with a real Next.js 16 app and Chrome: `npm run test:e2e:ssr` (see [examples/next-ssr](../../examples/next-ssr/README.md)).

## Copyright

Copyright (c) 2026 Alaa El-Basuony. All rights reserved. See [LICENSE](../../LICENSE).
