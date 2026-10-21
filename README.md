# Dev Companion

A Chrome extension (Manifest V3) for frontend, realtime and full-stack debugging. It captures short-lived `fetch` / `XMLHttpRequest` / `sendBeacon` requests (with request and response bodies), WebSocket and EventSource traffic (with Socket.IO, SignalR and SSE decoding), console errors and page events as they happen. Optionally, it also captures server-side rendering spans from a local development server. Everything is kept in IndexedDB, so it survives navigation and reloads. Events are linked by shared identifiers where they exist, and by timing where they don't. On top of that, a dashboard lets you search, compare, investigate, export and safely replay what was captured.

Typical use: you click **Create Order**, the UI shows an error, and the `POST /api/orders` request is already gone from the DevTools Network panel. With Dev Companion recording, that request, its payload and its response stay inspectable. So does the `order.failed` WebSocket message that followed it and, with the server tracer, the failing upstream call the server made. All of them are linked.

> Captured data stays in your browser. Dev Companion makes no network requests of its own except a replay you explicitly confirm. If you configure server tracing, it also pulls spans from a collector on your own machine (`127.0.0.1` / `localhost` only).

## Features

| Area                                            | What exists today                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP capture                                    | `fetch`, `XMLHttpRequest`, `navigator.sendBeacon` in the page's main world, installed at `document_start` for origins you grant. Method, URL, headers visible to the page, request/response bodies (text/JSON/form, truncated at a limit), status, timing, redirects, initiator stack, errors / aborts / timeouts.                                                                                                                                                                    |
| Realtime capture                                | WebSocket (lifecycle, text frames, binary type and size) and EventSource. Socket.IO / Engine.IO (v2–v4), SignalR JSON Hub Protocol (over WebSockets, SSE and long polling) and SSE are decoded; heartbeats are separated from application events. Optional parsing of `fetch()` event streams. Reconnects are linked. Polling transports are derived from ordinary HTTP requests.                                                                                                     |
| Advanced capture (opt-in, per tab)              | Chrome DevTools Protocol through `chrome.debugger`. Adds what the page can't see: every SSE event type, the document's redirect chain and response headers, and WebSocket handshake details. Merged with main-world capture without duplicates. Needs the optional `debugger` permission; Chrome shows a debugging banner while it is attached.                                                                                                                                       |
| Server / SSR tracing (opt-in, development only) | [`@dev-companion/server-tracer`](packages/server-tracer/README.md) records Next.js server rendering, route handlers and outbound `fetch` / `node:http` calls as OpenTelemetry spans. It serves them from a loopback-only, token-protected collector. Browser navigations are linked to their server trace through `<meta name="traceparent">`.                                                                                                                                        |
| Persistence                                     | IndexedDB with sessions; retention by entry count, approximate size, realtime message count, span count and (optionally) age; quota handling.                                                                                                                                                                                                                                                                                                                                         |
| Dashboard                                       | Overview, Network, Realtime, Timeline, Tracing (waterfall), Console, Investigations and Settings. Filters live in the URL. Lists are virtualized (tested with 50,000 rows). Command palette (Ctrl+K), keyboard shortcuts, light/dark theme.                                                                                                                                                                                                                                           |
| Investigations                                  | Evidence-based findings for HTTP, realtime, auth, hanging requests, response mapping, suspected caching, hydration, server spans, developer-declared realtime expectations and OpenAPI contracts. Each finding is labelled _Confirmed_, _Strong hypothesis_, _Possible_ or _Insufficient evidence_. The investigation workspace collects, around one event, the related events, the earliest verified divergence, ranked causes, missing evidence, next steps and reproduction steps. |
| Compare & contracts                             | Side-by-side status, timing, header and JSON structural diff. Response-shape baselines, JSON Schema (subset) checks and OpenAPI 3.x (JSON) validation per endpoint.                                                                                                                                                                                                                                                                                                                   |
| Replay                                          | Opt-in, editable, with a confirmation screen, mutation warnings, no credential reuse, and cURL generation.                                                                                                                                                                                                                                                                                                                                                                            |
| Export / import                                 | Dev Companion JSON (round-trips, includes realtime data and spans) and HAR 1.2 export; redacted bug reports (Markdown / JSON); Playwright test drafts. JSON and HAR imports are treated as untrusted.                                                                                                                                                                                                                                                                                 |
| Privacy                                         | Least-privilege permissions, redaction before storage (headers, query, body keys, realtime frames, span attributes, JWT / Bearer tokens, card numbers), configurable rules.                                                                                                                                                                                                                                                                                                           |
| DevTools                                        | A "Dev Companion" panel showing the inspected tab's sessions.                                                                                                                                                                                                                                                                                                                                                                                                                         |

Not implemented: decoding binary realtime protocols (SignalR MessagePack, binary Socket.IO attachments), capture inside Web Workers and iframes, source-map resolution, React-specific integrations, AI-assisted diagnosis, and throttling or failure simulation. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#known-limitations) for the full list.

## Getting started

You only need **Git**, **Node.js** and **Chrome**.

### 1. Install the tools (one time)

1. **Git:** download it from <https://git-scm.com/downloads> and install it with the default options.
2. **Node.js:** download the **LTS** version from <https://nodejs.org> and install it with the default options (npm comes with it). Version 20.19+ or 22.12+ is required.
3. **Chrome** version 120 or newer (Edge, Brave and other Chromium browsers also work).

To check, open a **new** terminal (PowerShell, Command Prompt or Terminal) and run:

```bash
git --version
node --version
```

Both commands should print a version number.

### 2. Download the project (one time)

```bash
git clone https://github.com/Alaa-Ahmed-Elbasuony/dev-companion.git
cd dev-companion
```

### 3. Build the extension

```bash
npm install
npm run build
```

This creates a `dist` folder inside the project. That folder is the extension.

### 4. Add it to Chrome (one time)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked** and select the **`dist`** folder inside `dev-companion`. Don't select the project folder itself.
4. Click the puzzle icon in the toolbar and pin **Dev Companion** so it's easy to reach.

### 5. Use it

1. Open the website you want to debug.
2. Click the Dev Companion icon, then **Start recording this site**, and allow access when Chrome asks.
3. Reload the page and use the site as usual.
4. Click **Open debugging workspace** to see the captured requests, errors and events.

### Get the latest version

Inside the `dev-companion` folder, run:

```bash
git pull
npm install
npm run build
```

Then open `chrome://extensions` and click the **reload** icon (↻) on the Dev Companion card. Reload the pages you're debugging too.

## Quick start

```bash
npm run mock-server   # http://127.0.0.1:4173/ (local test page and mock API)
```

1. Open `http://127.0.0.1:4173/`.
2. Click the Dev Companion icon, then **Start recording this site**, and allow access when Chrome asks.
3. Click **Create order (422 OUT_OF_STOCK)** on the test page.
4. Click **Open debugging workspace**, open **Network**, search for `/api/orders`, and open the request to inspect the payload and response.

The full workflow is in [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Scripts

| Command                           | Purpose                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run build`                   | Production build to `dist/`                                                                            |
| `npm run build:watch`             | Rebuild on change (reload the extension in Chrome afterwards)                                          |
| `npm run typecheck`               | `tsc` in strict mode                                                                                   |
| `npm run lint`                    | ESLint (typescript-eslint, React hooks rules)                                                          |
| `npm run format` / `format:check` | Prettier                                                                                               |
| `npm test`                        | Unit, integration and UI component tests (Vitest; fake IndexedDB; jsdom for UI)                        |
| `npm run test:e2e`                | Builds `dist-e2e/` and runs all four Puppeteer suites in Chrome: core, realtime, advanced capture, SSR |
| `npm run test:e2e:realtime`       | Realtime suite only                                                                                    |
| `npm run test:e2e:ssr`            | SSR / server-tracing suite only (needs `npm install` in `examples/next-ssr`)                           |
| `npm run mock-server`             | Local test page and mock API                                                                           |
| `npm run check`                   | typecheck + lint + test + build                                                                        |

## Project layout

```
src/
  manifest.json          MV3 manifest (copied to dist/)
  capture/               main-world recorders (fetch, XHR, beacon, WebSocket, EventSource, fetch streams,
                         document metadata, console/page events, opt-in app adapters) + channel
  content/               isolated-world bridge (page <-> service worker)
  background/            service worker, recording lifecycle, ingest, realtime ingest, transport derivation,
                         advanced capture (CDP), server-trace pulling, URL policy
  storage/               IndexedDB store, retention, entry builder
  analysis/              redaction, filtering, diff, contracts, OpenAPI, realtime decoders, correlation,
                         trace correlation, findings, investigations, unified timeline, replay safety,
                         cURL, Playwright drafts
  io/                    JSON/HAR export and import, bug reports
  shared/                types, messages, settings, sanitization, utilities
  ui/                    React UI: popup, dashboard, DevTools panel
packages/server-tracer/  development-only server tracer (OpenTelemetry + local collector)
examples/next-ssr/       Next.js 16 app used to exercise server tracing
scripts/                 build script and icon generator
test-page/               local test page, mock API and realtime test server
tests/                   unit/integration (Vitest), ui/ (component tests, jsdom), e2e/ (Puppeteer)
docs/                    architecture, user guide, security, testing, UX audit
```

## Troubleshooting

| Symptom                                        | Check                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Load unpacked" reports a manifest error       | Select `dist/`, not the repo root. Run `npm run build` first.                                                                                                                                                                                                           |
| No requests appear                             | Recording must be on for this tab, and the page origin must match the recorded origin. Requests made before you started are not captured: reload the page. Only `fetch`, XHR, `sendBeacon`, WebSocket and EventSource used by the top frame's main thread are captured. |
| Requests during page load are missing          | Reload after starting recording. The recorder is registered at `document_start` for the origin.                                                                                                                                                                         |
| Response body is missing                       | Binary, `text/event-stream`, opaque (`no-cors`) or already-consumed bodies are not stored. Large bodies are truncated (Settings → maximum body size).                                                                                                                   |
| History disappeared                            | Check the retention limits in Settings and any storage warning in the explorer header.                                                                                                                                                                                  |
| Extension reloaded and capture stopped         | Reload the debugged page. Old content scripts lose their connection when the extension reloads.                                                                                                                                                                         |
| A WebSocket opened before recording is missing | Main-world capture only sees sockets created after the recorder is installed. Reload the page after starting.                                                                                                                                                           |
| No server spans                                | The dev server must run with `DEV_COMPANION_TRACING=1` and not in production. The integration (app origin, collector URL, token) must be set in Settings → Integrations. The Overview's "Server / SSR tracing" card shows the collector status.                         |
| Advanced capture won't attach                  | Another debugger is attached to the tab (DevTools in some Chrome versions, or another extension). Close it and retry. Dismissing Chrome's banner detaches advanced capture.                                                                                             |
| Errors in the extension                        | Open `chrome://extensions`, then **Service worker → Inspect** (or **Errors**) on the Dev Companion card.                                                                                                                                                                |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, message flow, capture strategies, correlation and limitations
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): recording, inspecting, filtering, exporting, troubleshooting
- [docs/SECURITY.md](docs/SECURITY.md): permissions, sensitive data, redaction, storage and replay safeguards
- [docs/TESTING.md](docs/TESTING.md): automated tests, what was run, and the manual verification procedure
- [docs/UX_AUDIT.md](docs/UX_AUDIT.md): dashboard UX audit, fixes and open issues
- [packages/server-tracer/README.md](packages/server-tracer/README.md): server tracer setup and API
- [examples/next-ssr/README.md](examples/next-ssr/README.md): the Next.js example app

## Copyright

Copyright (c) 2026 Alaa El-Basuony. All rights reserved. See [LICENSE](LICENSE).
