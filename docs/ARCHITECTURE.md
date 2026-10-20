# Architecture

## Components

```
 Page (MAIN world)                 Page (ISOLATED world)         Service worker                 Extension pages
 ┌──────────────────────┐ Custom   ┌──────────────────┐ runtime  ┌──────────────────────┐       ┌───────────────────┐
 │ capture/main-world   │ Event    │ content/         │ message  │ background/          │  IDB  │ ui/popup          │
 │  fetch / xhr / beacon│ (JSON    │  content-script  │ ───────► │  service-worker      │ ◄───► │ ui/dashboard      │
 │  websocket / sse     │ string)  │  (bridge, batch) │          │  recording (state)   │       │ ui/devtools panel │
 │  fetch-stream (opt)  │ ───────► │                  │ ◄─────── │  ingest, rt-ingest   │       └───────────────────┘
 │  document, page evts │ ◄─────── │                  │ tabs.    │  transport-derivation│             ▲
 │  app-adapters (opt)  │ config   └──────────────────┘ send-    │  cdp (opt) ◄─ chrome.debugger      │
 │  channel (queue)     │                               Message  │  server-traces (opt) │             │
 └──────────────────────┘                                        └──────┬────────▲──────┘             │
                                                                        ▼        │ pull (loopback,    │
                                                         storage/ (IndexedDB) ───┼────────────────────┘
                                                                                 │  bearer token)
                                                     Dev server (Node) ┌─────────┴──────────────────┐
                                                                       │ packages/server-tracer     │
                                                                       │  OpenTelemetry → buffer →  │
                                                                       │  collector 127.0.0.1:4319  │
                                                                       └────────────────────────────┘
```

| Module                                   | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                | Runs in                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `src/capture/*`                          | Patch `fetch`, `XMLHttpRequest.prototype`, `navigator.sendBeacon`, `WebSocket`, `EventSource`, `console.error/warn`, `history.pushState/replaceState`. Listen for `error`, `unhandledrejection`, `popstate`, `hashchange`, `click`, `submit`. Emit document metadata once per document. Opt-in: parse `fetch()` event streams; app adapters (`window.__devCompanion`, Socket.IO / SignalR attach, notification observer). No `chrome.*` APIs. | Page main world             |
| `src/content/content-script.ts`          | Bridge: receives recorder events, batches them (50 ms), forwards them to the worker, and pushes the capture config back to the page.                                                                                                                                                                                                                                                                                                          | Isolated world              |
| `src/background/service-worker.ts`       | Message routing, sender checks, serial work queue, settings cache, badge.                                                                                                                                                                                                                                                                                                                                                                     | Service worker              |
| `src/background/recording.ts`            | Per-tab recording state (`chrome.storage.session`), pause/resume, content-script registration, injection into the open page, session start/end.                                                                                                                                                                                                                                                                                               | Service worker              |
| `src/background/ingest.ts`               | Validates page events, builds entries, redacts, persists, enforces retention and handles quota errors.                                                                                                                                                                                                                                                                                                                                        | Service worker              |
| `src/background/realtime-ingest.ts`      | Realtime connections and messages: protocol detection, decoding, redaction, reconnect linking, deduplication across capture mechanisms.                                                                                                                                                                                                                                                                                                       | Service worker              |
| `src/background/transport-derivation.ts` | Derives realtime connections and messages from HTTP requests that carry a realtime protocol (Engine.IO polling, SignalR negotiate / long polling / SSE send).                                                                                                                                                                                                                                                                                 | Service worker              |
| `src/background/cdp.ts`                  | Optional advanced capture through `chrome.debugger`: a second producer of the same drafts.                                                                                                                                                                                                                                                                                                                                                    | Service worker              |
| `src/background/server-traces.ts`        | Pulls spans from configured local collectors into the matching recording session.                                                                                                                                                                                                                                                                                                                                                             | Service worker              |
| `src/storage/*`                          | IndexedDB schema and store, retention planning, entry builder.                                                                                                                                                                                                                                                                                                                                                                                | Worker and UI (same origin) |
| `src/analysis/*`                         | Pure logic: redaction, filtering, diff, contracts, OpenAPI, realtime decoders, correlation, trace correlation, findings, investigations, unified timeline, replay safety, cURL, Playwright drafts.                                                                                                                                                                                                                                            | UI / worker / tests         |
| `src/io/*`                               | Export (JSON, HAR), validated import, bug reports.                                                                                                                                                                                                                                                                                                                                                                                            | UI                          |
| `src/ui/*`                               | React UI: popup, dashboard, DevTools panel.                                                                                                                                                                                                                                                                                                                                                                                                   | Extension pages             |
| `packages/server-tracer`                 | Development-only OpenTelemetry setup and local collector for Node servers (Next.js).                                                                                                                                                                                                                                                                                                                                                          | Dev server process          |

Capture, storage, analysis and UI are kept separate. The analysis modules are pure functions with no browser-API dependencies, so they are unit-tested directly.

## Recording lifecycle

1. **Start** (popup or DevTools panel, from a click):
   - The UI calls `chrome.permissions.request({ origins: ['<scheme>://<host>/*'] })` synchronously, because Chrome requires a user gesture. It also sends `set-pending-start`, so the worker can finish the start through `permissions.onAdded` if the popup closes while the prompt is open.
   - The worker validates the URL (http/https only; not browser or store pages) and confirms the permission.
   - It creates a `Session` and stores `{ tabId → sessionId, origin }` in `chrome.storage.session`.
   - It registers two content scripts for the origin pattern with `chrome.scripting.registerContentScripts`: `main-world.js` (`world: 'MAIN'`) and `content-script.js` (isolated), both at `runAt: 'document_start'` with `persistAcrossSessions: false`. Every later document load of that origin is instrumented before page scripts run.
   - It also injects both scripts into the already-open document with `chrome.scripting.executeScript` (`injectImmediately`), so capture begins without a reload. Requests and sockets that document already created are not recoverable.
   - It sets a `REC` badge on the tab and adds a `recording` timeline event.
2. **Capture.** Recorder → bridge → worker → IndexedDB (see message flow).
3. **Pause / resume.** While paused, the worker drops events from the tab and pulls no server spans for it, but keeps the session and the content-script registration.
4. **Stop** (or tab closed): the state is removed, the session gets `endedAt`, pending entries of the session are marked `incomplete`, connections still open get a warning that they were no longer observed (the page's own connection is not closed), advanced capture is detached, and the registration is updated or removed. The page is sent `enabled: false`, and the worker drops any further events from that tab.

The worker is the authoritative gate. Even if a recorder keeps running in a page, events are stored only when the sender tab is recording, the sender is the top frame, and the sender's origin (reported by Chrome, not by the page) matches the session origin.

## Message flow

| From → to          | Transport                                                                                     | Messages                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorder → bridge  | `document.dispatchEvent(new CustomEvent('__devcompanion:capture', { detail: JSON string }))`  | `ping`, `hello`, `network-start`, `network-end`, `timeline`, `rt-connection`, `rt-message`, `capture-dropped`                                                                |
| Bridge → recorder  | `CustomEvent('__devcompanion:control')`                                                       | `config` (enabled, body and frame limits, toggles, adapter opt-in)                                                                                                           |
| Bridge → worker    | `chrome.runtime.sendMessage`                                                                  | `page-config-request`, `capture-batch`                                                                                                                                       |
| Worker → bridge    | `chrome.tabs.sendMessage`                                                                     | `recording-state`                                                                                                                                                            |
| UI → worker        | `chrome.runtime.sendMessage` (sender must be an extension page)                               | `start-recording`, `stop-recording`, `pause-recording`, `resume-recording`, `get-tab-state`, `add-marker`, `set-pending-start`, `set-advanced-capture`, `sync-server-traces` |
| Worker/UI → UI     | `chrome.runtime.sendMessage` broadcast                                                        | `data-changed`, `recording-changed`                                                                                                                                          |
| Chrome → worker    | `chrome.debugger.onEvent` / `onDetach`                                                        | `Network.*` events of the attached tab (advanced capture only)                                                                                                               |
| Worker → collector | `fetch('http://127.0.0.1:<port>/v1/spans?after=<cursor>', { Authorization: Bearer <token> })` | span pages, collector instance id, dropped count                                                                                                                             |

`CustomEvent.detail` carries strings because object details do not cross JavaScript worlds.

**Handshake and early events.** The main-world channel queues events (up to 1000) until the bridge sends a config. The recorder pings when it installs, and the bridge sends the config once the worker answers `page-config-request`. Whichever script loads first, events from page initialization are delivered once the bridge is ready, or discarded if the tab is not recording. Events beyond the queue limit are discarded silently.

**Frame rate limit.** The bridge passes realtime frames through a token bucket (500 per second sustained, bursts of 2000). Frames beyond it are dropped (never connections, requests or timeline events), and the bridge sends a `capture-dropped` count, which the worker stores as a `capture` timeline event. The Overview lists these under "Capture notes". The worker stores each run of consecutive frames in a batch in one IndexedDB transaction.

**Ordering.** Each request produces `network-start` (persisted as `pending`) and `network-end`. The start is stored early, so a request interrupted by navigation is still visible. The worker processes batches through a serial promise queue, and `upsertEntry` never downgrades a terminal entry to `pending`.

**Navigation.** Each document gets a random `pageId`. When a new document says `hello`, pending entries of that tab from other documents become `incomplete` with the warning "Page navigated or reloaded before this request completed", and their open realtime connections are closed. The bridge flushes its batch on `pagehide`.

## Capture strategies

### Main-world instrumentation (default)

- `fetch`: the wrapper calls the original with the same receiver and arguments and returns the **original promise**, so the page gets the identical `Response` object and the same rejection. The response body is read from `response.clone()`, streamed up to the body limit, and then the clone is cancelled so the tee stops buffering for it. `Request` bodies are cloned synchronously before calling `fetch`.
- XHR: the `open`, `setRequestHeader` and `send` prototype methods are wrapped. The outcome comes from passive `abort` / `timeout` / `error` / `loadend` listeners. `responseText` is read only for `''` / `text` response types; `json` responses are re-serialized; `arraybuffer` / `blob` record the size only.
- `sendBeacon`: the request body and whether the browser queued it. There is no response.
- `WebSocket`: the constructor is replaced by a `Proxy` whose construct trap calls `Reflect.construct`, so `instanceof`, statics, the prototype and subclassing are unchanged. Incoming frames and lifecycle events are observed with passive listeners. `send()` and `close()` are wrapped on the prototype; the original runs first and its errors are rethrown as-is. Binary payloads are never read; only their type and size are recorded. Frames above the frame limit (default 64 KB) are truncated.
- `EventSource`: same `Proxy` approach and passive listeners. Unnamed (`message`) events are always observed. Named events are dispatched only to listeners of that type, so main-world capture sees exactly the types the page subscribes to. Reconnection state comes from `readyState` at `error`.
- `fetch()` event streams (opt-in): `text/event-stream` responses are parsed from a clone up to the body limit; the page reads its own branch unchanged.
- Document metadata: once per document, Navigation Timing (type, redirect count, sizes, server wait), `Server-Timing`, `<meta name="traceparent">` and framework markers.
- App adapters (opt-in per origin): `window.__devCompanion.signal(...)` for stages the extension can't observe, `attachSocketIO(socket)` / `attachSignalR(connection)` through the libraries' public APIs, and a `MutationObserver` on notification regions. Events from them are labelled "reported by the page".
- Duplicate instrumentation guard: a non-enumerable `Symbol.for('dev-companion.recorder-installed')` on `window`. The bridge uses an isolated-world global.

### Advanced capture: Chrome DevTools Protocol (opt-in, implemented)

Turned on per recording tab from the popup or the dashboard header, after the user grants the optional `debugger` permission. The worker attaches with `chrome.debugger.attach`, enables `Network` (without post data) and translates `Network.webSocket*`, `Network.eventSourceMessageReceived`, `Network.requestWillBeSent`, `Network.responseReceived` and `Network.loadingFailed` into the same drafts the recorder produces. The `Ingestor` merges duplicate observations of the same frame or request, using `dedupKey` and source lists. It adds:

- every SSE event type, including types the page never subscribes to;
- the document's redirect chain, status and response headers (including headers the page cannot read);
- WebSocket handshake status and headers.

Costs: Chrome shows "Dev Companion started debugging this browser" while attached. Attaching fails if another debugger is attached (some Chrome versions treat open DevTools as one). Dismissing the banner or closing DevTools can detach it; the worker records the detach reason and main-world capture continues. Sockets created before the debugger attached are not reported by CDP. On worker restart, the attachment flag is reconciled with `chrome.debugger.getTargets()`.

### Server tracing (opt-in, development only)

`packages/server-tracer` runs inside the developer's Node server (Next.js `instrumentation.js`). It sets up an OpenTelemetry `NodeTracerProvider` with HTTP (and optionally undici) instrumentation and wraps server-side `fetch` to record bounded, redacted bodies. Spans are redacted in the server process, kept in a bounded in-memory buffer (default 2000 spans / 30 minutes), and served by a collector on `127.0.0.1` that requires a bearer token and rejects any `Origin` other than an extension. It refuses to start when `NODE_ENV=production`, during `next build`, in the Edge runtime, or unless `DEV_COMPANION_TRACING=1`. By default, outbound requests are not modified (no `traceparent` propagation).

The worker pulls spans shortly after page activity on a mapped app origin (navigation, completed requests) and when a dashboard page asks. A cursor per collector lives in `chrome.storage.session`. A changed collector `instance` id (server restart) resets the cursor, and the collector's `dropped` count is surfaced. Spans are stored in the session of the most recently started, unpaused recording whose origin matches the integration's app origin. Spans that started more than 2 s before that recording began are ignored. When several tabs record the same origin, each document is still linked to its own trace by trace id (see Analysis), which the SSR suite checks with concurrent navigations in two tabs.

### `chrome.webRequest` (not used)

It sees all traffic, including traffic the page cannot observe, but it **never exposes response bodies** and needs broad host permissions. It could be added later as a metadata-only source for "browser traffic".

### DevTools Network API (not used)

`chrome.devtools.network` only works while DevTools is open for that tab, which defeats the "capture what happened when DevTools was closed" goal.

## What each capture method sees

| Signal                                                                  | Main world                                                                      | Advanced capture (CDP)                                               | Derived from HTTP             | Server tracer      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------- | ------------------ |
| `fetch` / XHR / beacon requests, page-readable headers and bodies       | Yes                                                                             | Request metadata and document response only (bodies are not fetched) | —                             | —                  |
| Document navigation: status, redirect chain, response headers           | Navigation Timing: status (`responseStatus`), redirect count, sizes; no headers | Yes                                                                  | —                             | Server render span |
| WebSocket frames (text)                                                 | Yes, for sockets created after install                                          | Yes, for sockets created after attach                                | —                             | —                  |
| WebSocket handshake headers / status                                    | No                                                                              | Yes                                                                  | —                             | —                  |
| EventSource events                                                      | Types the page subscribes to                                                    | All types                                                            | —                             | —                  |
| `fetch()` event streams                                                 | Opt-in                                                                          | No                                                                   | —                             | —                  |
| Engine.IO / Socket.IO long polling                                      | As HTTP requests                                                                | As HTTP requests                                                     | Connection + decoded messages | —                  |
| SignalR negotiate / long polling / SSE send                             | As HTTP requests                                                                | As HTTP requests                                                     | Connection + decoded messages | —                  |
| Console errors, uncaught errors, route changes, clicks, submits         | Yes                                                                             | No                                                                   | —                             | —                  |
| Server rendering, route handlers, outbound server `fetch` / `node:http` | No                                                                              | No                                                                   | —                             | Yes (dev only)     |
| Web Workers, Service Workers, iframes                                   | No                                                                              | No                                                                   | —                             | —                  |

## Storage

IndexedDB database `dev-companion` (extension origin, schema version 2), shared by the worker and extension pages:

| Store            | Key           | Indexes                                                                            | Content                                                                                   |
| ---------------- | ------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `entries`        | `id`          | `by-session`, `by-started`, `by-state`                                             | Request summaries (headers, status, timing, warnings)                                     |
| `bodies`         | `id`          | —                                                                                  | Request/response bodies (loaded on demand)                                                |
| `timeline`       | `id`          | `by-session`, `by-time`                                                            | Console, error, route, interaction, navigation, notification, marker and recording events |
| `sessions`       | `id`          | `by-started`                                                                       | Recording sessions (including imported)                                                   |
| `meta`           | `key`         | —                                                                                  | `usage` = { entryCount, totalBytes }, updated in the same transaction as every write      |
| `contracts`      | `endpointKey` | —                                                                                  | Baseline shapes, JSON Schemas, OpenAPI documents                                          |
| `rt-connections` | `id`          | `by-session`, `by-created`, `by-tab`                                               | Realtime connections: transport, protocol, state, close code, reconnect attempt, counters |
| `rt-messages`    | `id`          | `by-session`, `by-connection` (`[connectionId, timestamp]`), `by-time`, `by-dedup` | Realtime frames/events with decoded protocol payloads                                     |
| `spans`          | `id`          | `by-session`, `by-trace`, `by-time`                                                | Server spans                                                                              |
| `investigations` | `id`          | `by-session`                                                                       | Saved investigations                                                                      |

- **Retention:** after each batch, if the entry count or approximate byte total exceeds its limit, the oldest entries (by start time) are deleted down to 90% of the limit. The timeline, realtime messages (default 50,000) and spans (default 20,000) are capped separately. An optional age limit (`retentionDays`) deletes older records.
- **Quota:** on `QuotaExceededError`, the oldest 25% of entries are evicted and the write is retried. If it fails again, the entry is stored without bodies, with a warning. Storage problems are shown in the dashboard header via `chrome.storage.session`.
- **Durability:** nothing durable lives in service-worker memory. Recording state, advanced-capture flags and collector cursors live in `chrome.storage.session` and are cleared on browser restart, as are the dynamic content-script registrations. The browser E2E suites restart the worker mid-capture to check this.

## Analysis and correlation

- **Time correlation** (`correlate.ts`): an error-type timeline event is related to failed requests in the same tab that ended within 5 s before it (or 0.5 s after it). A click or submit is related to requests started within 1.5 s after it. This is time-based, not causal.
- **Trace correlation** (`trace-correlate.ts`): a link is **explicit** only when both sides carry the same identifier: a W3C trace id (`traceparent` meta tag or header, span ids) or a request/correlation id found in headers, frames or span attributes. Otherwise a time-and-path match is **probable**. Several equally good candidates are **ambiguous** and not linked. The UI always shows which kind of link it is.
- **Span naming:** the HTTP instrumentation names spans by method only (`GET`). The tracer renames incoming spans to method + path (`GET /orders`) and outgoing ones to method + redacted URL (`GET http://127.0.0.1:3101/inventory`), and labels each span's phase (Next.js render phase, `node:http`, undici or server `fetch`).
- **Findings** (`error-detector.ts`, `investigator-rules.ts`): rule-based. Each finding separates the observation (title and evidence level: Confirmed / Strong hypothesis / Possible / Insufficient evidence) from ranked hypotheses, next steps and limitations. Repeated-request detection groups by tab + method + URL + captured request body, and checks for polling, retries and overlap before suggesting a double submit.
- **Investigations** (`investigation.ts`): built around one anchor event. They collect related events with their link strength, the earliest verified point of divergence, ranked causes, missing evidence (for example "server tracing not configured"), next steps, reproduction steps and regression-test suggestions. Nothing is invented; every statement comes from stored records.
- **Contracts** (`contracts.ts`, `openapi.ts`): an inferred shape from one response (medium confidence), a user-provided JSON Schema subset, or an OpenAPI 3.x JSON document (local `$ref`s only). Ajv is not used because it relies on `new Function`, which the MV3 extension CSP forbids.
- **Performance:** analysis runs on the dashboard's main thread. `tests/analysis/perf-scale.test.ts` holds findings, links, the unified timeline and an investigation over 2,000 requests and 20,000 messages to budgets of 800 / 500 / 300 / 150 ms (observed ~120 / 65 / 40 / 15 ms).

## Known limitations

- Main-world capture sees only the top frame's main thread: not iframes, Web Workers, Shared Workers or Service Workers (including sockets and fetches made there). CDP capture does not cover them either: it attaches to the tab's page target only.
- Requests and sockets created before the recorder was installed (or before advanced capture attached) are not captured. Reload after starting.
- Page scripts that captured a reference to `fetch` / XHR / `WebSocket` **before** `document_start` injection (effectively only other extensions) bypass the recorder.
- Request headers are those set by the page. Browser-added headers (cookies, `User-Agent`, `Origin`, `Sec-*`) are invisible without advanced capture. Cross-origin responses expose only CORS-safelisted and `Access-Control-Expose-Headers` headers.
- Opaque (`no-cors`) responses have no readable status or body. Network-failure causes such as CORS, DNS or TLS are hidden from page scripts by design.
- Bodies: binary content types are not read. Textual bodies are truncated at the limit (default 1 MB). Body reading gives up after 30 s and keeps what it read. Streaming request bodies are not captured.
- Binary realtime protocols are recognized but not decoded: SignalR MessagePack and binary Socket.IO attachments are stored as type and size only.
- OpenAPI documents must be JSON; YAML and remote `$ref`s are not supported.
- Server tracing switches itself off in production builds, so statically generated and ISR pages (rendered by `next build` / `next start`) aren't traced. Next.js middleware has not been tested. Only the Node.js runtime is supported (not Edge).
- Timing uses `Date.now()` in the page and in the server process. Spans that start up to 2 s before recording began are accepted to absorb small clock differences; collectors must be on the same machine anyway.
- Wrapping `console.error` / `console.warn` (and `fetch` / XHR) adds a recorder frame to the call stack. `main-world.js.map` marks every recorder source in `ignoreList` / `x_google_ignoreList`, so Chrome DevTools skips those frames. Tools that ignore ignore-lists can still show `main-world.js`. The console wrapper is installed only at `document_start` (never into an already-loaded page) and removed when recording stops or console capture is turned off.

## Extension points

Each of these would be a new module that consumes existing data. The recorder would not need to change.

| Not implemented                 | Where it would plug in                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| React-specific debugging        | A separate main-world recorder (like `page-events-recorder`) emitting new `TimelineKind`s                                     |
| MessagePack decoding            | A decoder next to `analysis/realtime/signalr.ts`, called from `decode.ts`                                                     |
| Worker / iframe capture         | CDP auto-attach to child targets in `background/cdp.ts` (needs `Target.setAutoAttach`)                                        |
| Storage diffs                   | A new recorder for `localStorage` / `sessionStorage` snapshots on markers                                                     |
| Throttling / failure simulation | A main-world fetch/XHR hook stage, opt-in and restricted to dev origins                                                       |
| AI-assisted diagnosis           | Consume findings plus explicitly selected, redacted records through an export-like pipeline. Never automatic                  |
| Source-map resolution           | Post-process `initiatorStack` in the UI                                                                                       |
| Other server frameworks         | `packages/server-tracer` is framework-agnostic OpenTelemetry; only the ignored-path list and span naming are Next.js-specific |
