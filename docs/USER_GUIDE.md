# Dev Companion — User Guide

## 1. What it does

Dev Companion records the API requests a web page makes (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`) and its realtime traffic (WebSocket, Socket.IO, SignalR, server-sent events) while you reproduce a bug. It keeps the requests, their payloads, their readable responses and the realtime messages after they finish, after page navigation and after reloads. It also records console errors and other page events, so you can see what happened around a failed request. Optionally, it shows what your development server did while rendering the page (section 12).

It is designed for React and TypeScript apps, but it works with any site that uses `fetch` or XHR.

## 2. Installation

1. In the project directory, run `npm install`, then `npm run build`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the generated **`dist/`** folder (it contains `manifest.json`).
4. Optionally, pin Dev Companion to the toolbar.

After code changes, run `npm run build` again, then click the reload icon on the Dev Companion card. Also reload the pages you are debugging.

## 3. Start a debugging session

1. Open the site you want to debug (http or https).
2. Click the Dev Companion toolbar icon.
3. The popup shows the **current tab's origin**. Click **Start recording this site**.
4. The first time, Chrome asks to grant Dev Companion access to that site. Access is requested for that host only.
5. The toolbar badge shows **REC** while the tab is recording.
6. To capture requests made **while the page loads**, click **reload the page** in the popup (or reload the tab). From then on, the recorder is installed before the page's own scripts run on every load of that site in this tab.
7. Reproduce the bug.

Requests made before you started recording cannot be recovered.

A recording belongs to one **tab** and one **origin**. Other tabs on the same site are not recorded unless you start recording there too. If the tab navigates to a different origin, events from it are ignored.

You can also start or stop recording from the **Dev Companion** panel in DevTools ("Record this tab"), or stop it from the explorer header.

## 4. Inspect an API request

Click **Open debugging workspace** in the popup (it opens the current session), or use the **Dev Companion** DevTools panel.

The dashboard has eight views, also reachable with Alt+1 … Alt+8:

| View           | Shows                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | Recording state, counts of requests, failures, slow and pending requests, console errors, storage; realtime connection health; server tracing status ("Not configured" rather than zero when it isn't set up); capture notes such as rate-limit drops; findings worth investigating |
| Network        | The request list and details (this section)                                                                                                                                                                                                                                         |
| Realtime       | Connections and their messages (section 12)                                                                                                                                                                                                                                         |
| Timeline       | Everything in one chronological list: requests, realtime events, console, navigation, interactions, notifications, server spans                                                                                                                                                     |
| Tracing        | Server traces as a waterfall, with their links to browser events (section 13)                                                                                                                                                                                                       |
| Console        | Console errors and warnings, uncaught errors and unhandled rejections                                                                                                                                                                                                               |
| Investigations | Findings and the investigation workspace (section 8)                                                                                                                                                                                                                                |
| Settings       | Theme, retention, capture options, integrations, realtime expectations, API contracts, redaction, stored data                                                                                                                                                                       |

The view and its filters are kept in the URL, so a reload or a shared link reopens the same view.

The **Network** view lists captured requests, newest first: method, status, URL, type (`fetch`, `xhr`, `beacon`, `replay`, `import`), duration and start time. A ⚠ icon means the capture has warnings, such as truncation or an incomplete request.

Click a request to open its details:

- **Overview:** URL, final URL after redirects, method, status or failure state, error message, start time, time to response headers, duration, request and response sizes, content type, page URL, origin and tab, plus capture warnings. When a baseline exists for the endpoint, this tab also shows the contract check result.
- **Headers:** request headers set by the page, and response headers readable by the page.
- **Query:** parsed query parameters.
- **Payload / Response:** the body, pretty-printed and syntax-highlighted when it is JSON, with Raw and Pretty toggles. Notes explain when a body is truncated, binary, streaming or unreadable.
- **Initiator:** the JavaScript stack at the moment the request was made. These are bundled locations; source maps are not applied.
- **Related:** timeline events correlated by time, such as a console error shortly after this request failed.

Actions: **Copy URL**, **Copy cURL** (disabled, with the reason shown, when the body was truncated or not captured), **Replay…**, **Compare as A / B**, **Save as baseline**, **Delete**. Use the copy button inside the Payload or Response tab to copy a body.

Request states:

| State        | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `200`…`599`  | An HTTP response was received (4xx and 5xx included)                             |
| `pending`    | Started; no outcome observed yet                                                 |
| `error`      | Failed without an HTTP response (network error, CORS, DNS, blocked, offline)     |
| `aborted`    | Cancelled by the page (`AbortController`, `xhr.abort()`)                         |
| `timeout`    | Client-side timeout (`AbortSignal.timeout`, `xhr.timeout`)                       |
| `incomplete` | The page navigated or reloaded, or recording stopped, before an outcome was seen |

## 5. Example: a failed Create Order action

You click **Create Order**, the UI shows an error, and the request has vanished from the Network panel.

1. Start recording before clicking **Create Order** (optionally add a marker such as "clicking Create Order").
2. Trigger the action once.
3. Open the explorer, type `POST /api/orders` in the search box, or click the **POST** chip and choose **4xx client error** in the status filter.
4. Open the request. **Payload** shows, for example, `{"productId":"123","quantity":5}`. **Response** shows `HTTP 422` with `{"message":"Insufficient stock","code":"OUT_OF_STOCK"}`.
5. Check **Related** and the **Timeline** for console errors right after the request.
6. Open **Investigations → Findings**. It lists the 422 with the server's message as evidence, possible explanations (validation or business rule), next steps, and its limitations.
7. If you need to share the evidence, export the request (see section 9).

You can reproduce exactly this with the bundled test page (`npm run mock-server`, then the **Create order (422 OUT_OF_STOCK)** button). In this example the response shows the server rejected the order for stock reasons, so it is not necessarily a frontend bug.

### Reproduce and inspect a short-lived POST (test page)

1. `npm run build`, load `dist/` in `chrome://extensions`, then `npm run mock-server`.
2. Open `http://127.0.0.1:4173/`, click the toolbar icon, **Start recording this site**, and allow access.
3. Close the popup. DevTools does not need to be open.
4. Click **Create order (201)** (or **Create order (422 OUT_OF_STOCK)**). The request completes in well under a second.
5. Open the popup → **Open debugging workspace**. Search `POST /api/orders` and open the newest row.
6. **Payload** shows `{"productId":"123","quantity":1}`. **Response** shows `201` with `{"id":"o-1001","productId":"123","quantity":1,"status":"created"}` (the id increases with each order). **Overview** shows the duration and the page URL.
7. Click **Navigate to page 2** on the test page, then reload it. Refresh the explorer: the entry, its payload and its response are still there. They are stored in IndexedDB, so they also survive the service worker going idle and restarting.

## 6. Search and filters

- **Search:** whitespace-separated terms must all match the method, URL, status or error text (for example `POST /api/orders` or `422`). With **bodies** checked, the full query is also matched against captured request and response bodies (for example `OUT_OF_STOCK`).
- **Method chips:** GET, POST, PUT, PATCH, DELETE.
- **Status:** 2xx, 3xx, 4xx, 5xx, failed (error / aborted / timeout / incomplete), pending.
- **Type:** fetch, xhr, beacon, replay, import.
- **≥ ms:** minimum duration, to find slow requests.
- **Presets:** Failed, Slow (≥ the threshold in Settings), Mutations (POST/PUT/PATCH/DELETE), Pending.
- **Time range:** all time, or the last minute / 5 / 15 / 60 minutes of the session.
- **Sort:** newest, oldest, slowest, status (errors first), method.
- **Session** (header): one recording session, or all sessions.

Active filters appear as chips under the filter bar with a count ("12 of 340 requests"). Remove one with its ×, or click **Clear all filters**. When nothing matches, the list says so and offers to clear the filters. That is a different message from "nothing captured yet".

If a request is missing, confirm recording was on before the action and that the request uses `fetch`, XHR or `sendBeacon` (see Known limitations).

### Keyboard

| Keys          | Action                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| `/`           | Focus search                                                             |
| Ctrl+K (⌘K)   | Command palette: type to filter, ↑/↓ to move, Enter to run, Esc to close |
| `j` / `k`     | Next / previous row                                                      |
| Enter         | Open the selected row                                                    |
| Esc           | Close details, dialogs and the palette                                   |
| Alt+1 … Alt+8 | Switch view                                                              |
| `i`           | Investigate the selected event                                           |
| `?`           | Show shortcuts                                                           |

Single-key shortcuts are ignored while you type in a field. Dialogs keep focus inside them until closed, and focus returns to the button that opened them.

## 7. Compare two requests

1. Open the first request and click **Compare as A**.
2. Open the second one (from another attempt or session) and click **Compare as B**.
3. Open **Investigations → Compare**. It shows method, URL, status and duration (with the delta), a structural JSON diff of response and request bodies (added, removed, type-changed and value-changed paths), and request and response header differences. Volatile headers such as `date` and `etag` are hidden unless you include them.

If `price` is a number in A and a string in B, you'll see `$.price  type-changed  number → string`. That points to an inconsistency, but check the intended contract before deciding which response is wrong.

### API contract baselines

- **Save as baseline** (request details) stores the shape of a successful JSON response as the baseline for its endpoint. The endpoint key is method + host + path, with id-like segments shown as `:id`.
- In **Investigations → Compare → API contract baselines**, you can instead paste a **JSON Schema**. The supported keywords are listed on screen; others are ignored.
- Later 2xx JSON responses for that endpoint are checked. Results appear in request details and Investigations → Findings. An inferred baseline is one example and reports medium confidence. A schema reports high confidence.

## 8. Investigate errors

The **Investigations** view analyzes the selected session. Every finding has an evidence level:

| Level                 | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| Confirmed             | Directly observed in the recorded data                                 |
| Strong hypothesis     | Supported by specific evidence, not directly proven                    |
| Possible              | Consistent with the evidence; other explanations are equally plausible |
| Insufficient evidence | The recorded data cannot tell                                          |

Besides the HTTP findings below, it covers realtime problems (abnormal closes, reconnect loops, duplicate subscriptions, messages that never arrive after a request), authentication, requests that never finish, response mapping errors, suspected caching, hydration, failing server spans, your own realtime expectations (Settings → Realtime expectations) and OpenAPI contracts (Settings → API contracts).

HTTP findings:

| Finding                        | Based on                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| HTTP 4xx/5xx                   | Status code, server error message from the body                                                 |
| Network failure / timeout      | Error name and message, request vs page origin (CORS), HTTPS→HTTP (mixed content)               |
| Slow request                   | Duration ≥ threshold (Settings), time to headers vs body download, `Server-Timing`, concurrency |
| Repeated requests              | Same method, URL and body close together, distinguishing polling, retries and parallel calls    |
| Contract mismatch              | Saved baseline or JSON Schema                                                                   |
| Changed since previous session | Latest request per endpoint vs the previous session of the same origin                          |
| Console error near failure     | Error event within 5 s after a failed request in the same tab                                   |

Each finding lists what was observed, the evidence (with links to the requests), plausible explanations, next steps, a confidence level and its limitations. Treat these as starting points rather than verdicts. For example, 401 commonly means missing or expired authentication, 403 missing permission, 404 a wrong path or id, 422 validation failure, and 500 a server-side error. A failure with no HTTP status can come from CORS, DNS, being offline, a blocker or cancellation, and the browser hides which one from page scripts. Check the browser console for the reason.

**Investigate an event.** Click **Investigate** on a request, a realtime message or a span, or press `i`. The workspace shows what happened, the related events and how strongly each is linked (shared id, same trace, same connection, by time only), the earliest verified point where things diverged, ranked possible causes, the evidence that is missing (for example "server tracing not configured"), next steps and reproduction steps. For a realtime message, a notification checklist shows which stages were observed and which can't be observed without the page adapter. Nothing in it is invented: a stage that wasn't recorded is marked "Unknown" or "Not instrumented". From the workspace you can save the investigation, create a redacted bug report (Markdown or JSON), or copy a Playwright test draft. Interactions that caused mutating requests are commented out in the draft.

The **Timeline** view merges requests with console errors and warnings, uncaught errors, unhandled rejections, route changes, page loads, clicks, form submissions and markers. Use the chips to filter, and click a request or a related-request link to open it.

## 9. Export and import

**Export…** (Requests toolbar) exports the checked requests or, if none are checked, the currently shown (filtered) ones:

- **Dev Companion JSON:** requests, bodies, sessions and, optionally, timeline events. You can import it again.
- **HAR 1.2:** for other HAR tools. Cookies are not included. Extra Dev Companion fields are under `_devCompanion`.

Redaction rules are applied to every export. Bodies can still contain personal data, so review the file before sharing and use an approved channel.

**Import…** accepts Dev Companion JSON and HAR files up to 50 MB. Imported records are validated, size-limited, given new ids, redacted, and placed in a new session labeled "Imported: <file name>". Any "pending" state is converted to "incomplete".

## 10. Replay a request

1. Open a request and click **Replay…**.
2. Edit the method, URL, headers and body. Captured credentials are already redacted. Headers containing a `[REDACTED]` placeholder are dropped. A placeholder left in the URL or body (for example `"password":"[REDACTED]"`) would be sent literally, so the review screen warns about it; replace it with a real value. **Copy cURL** is available here too.
3. Optionally, tick **Send browser cookies for the target origin** (off by default).
4. Click **Review…**. The confirmation screen shows the **target origin**, a red warning for state-changing requests (POST/PUT/PATCH/DELETE, or paths mentioning orders, payments, deletion and so on), the headers that will and won't be sent, and the differences from the original request.
5. Mutations, cookie use and origin changes require ticking an acknowledgement.
6. Click **Send request**. Chrome may ask for access to the target origin.
7. The result is saved as a `replay` entry in the same session. Click **Compare with original** to diff it.

The replay is sent from the extension, not the page, so the `Origin` header, cookies, CORS and authentication can differ from the original. Prefer local or staging environments. Nothing is ever replayed automatically.

## 11. Realtime traffic

WebSocket and EventSource traffic is recorded while recording is on (Settings → Capture → "Record WebSocket and EventSource traffic"). The **Realtime** view lists connections with their transport, protocol, state, close code and reconnect attempt (`#2`, `#3`, …). Select one to see its messages:

- **Decoding:** Socket.IO / Engine.IO events and acknowledgements, SignalR invocations, completions and server calls, and SSE events are decoded and shown with their arguments. Heartbeats (pings, keep-alives) are separated from application messages; **app messages only** hides them.
- **Polling transports:** Socket.IO long polling and SignalR long polling / SSE send requests stay in the Network list, and also appear here as a connection with decoded messages ("derived").
- **Links:** a message that carries the same request id as an HTTP request is linked to it ("shared id"). Reconnects are linked to the previous connection, and a Socket.IO WebSocket to its polling handshake ("upgraded from polling").
- **Limits:** frames over the frame limit (default 64 KB) are truncated. Binary frames are shown by type and size only. If a page sends more than about 500 frames per second for a sustained period, the excess is dropped and the Overview lists a capture note with the count. The page still receives every frame.
- **Parse fetch() event streams** (Settings → Capture) also decodes SSE delivered through `fetch()` instead of `EventSource`.

### Advanced capture

The **Advanced off / on** button in the dashboard header (or the **Advanced** checkbox in the popup) attaches Chrome's debugger to the recording tab. The first time, Chrome asks for the "debugger" permission. While it is on, Chrome shows "Dev Companion started debugging this browser". Advanced capture adds:

- every SSE event type, including types the page doesn't listen for;
- the document's response status, redirect chain and headers;
- WebSocket handshake status and headers.

Frames seen both ways are stored once ("Observed by: main-world, cdp"). Attaching fails if another debugger is attached to the tab. Dismissing the banner turns it off; the Overview notes this, and normal capture continues. It is turned off when recording stops.

### Page adapter (opt-in)

Some stages can't be observed from outside the app, such as "the handler for this message ran" or "a toast was shown". For origins you list in Settings → Integrations → Page API and notification observer:

- the page gets `window.__devCompanion.signal(stage, details)`, which your app can call to report such stages (shown as "reported by the page");
- `window.__devCompanion.attachSocketIO(socket)` / `attachSignalR(connection)` add listeners through the libraries' public APIs;
- text that appears in notification regions (`[role=alert]`, `[role=status]`, `aria-live`, configurable) is recorded.

Nothing of this runs on other origins. Changes apply from the next page load.

## 12. Server-side rendering and API traces

If your app is a Node server (tested with Next.js 16), the development-only [server tracer](../packages/server-tracer/README.md) records what the server did for each request: render phases, route handlers, and outbound `fetch` / `node:http` calls with their status, timing and (redacted) bodies. Setup takes a few minutes and is described in the tracer's README. The [example app](../examples/next-ssr/README.md) shows it end to end.

Once configured (Settings → Integrations → Server tracing), the **Tracing** view lists traces. Select one to see its waterfall: nested spans, durations, failed calls highlighted in red (the trace list shows how many failed), and the browser events linked to it. A page load is linked to its server render by trace id when Next.js renders `<meta name="traceparent">`. Without it, links are made by time and path and labelled "by time only". **Sync now** pulls immediately; otherwise spans are pulled shortly after each navigation or request.

Server tracing only works with `next dev` (it is off in production builds), so statically generated and ISR pages are not traced.

## 13. Recording controls and storage

- **Pause / Resume:** keeps the session but stores nothing while paused.
- **Stop:** the popup, dashboard header or DevTools panel. New events stop being stored immediately. Stopping does **not** delete anything.
- **Delete selected:** tick requests in the list, then click **Delete selected**.
- **Clear session:** deletes the selected session's requests and timeline events.
- **Settings:** theme (system, light, dark), retention (maximum requests, MB, body KB, timeline events, realtime messages, spans, and an optional age in days), slow-request threshold, capture toggles (console, interactions, stacks, realtime, fetch event streams, frame size), integrations, realtime expectations, OpenAPI contracts, redaction rules, **Apply redaction to stored history**, **Recompute usage**, **Delete all data**.
- The explorer header shows how many requests are stored and their approximate size, plus warnings about storage quota problems.

The oldest requests are removed automatically when a retention limit is exceeded.

## 14. Troubleshooting

**No requests appear.** Check that recording is on (REC badge) for this tab and origin. Reload the page after starting. Verify the site access was granted (`chrome://extensions` → Dev Companion → Details → Site access). Only fetch, XHR and beacon requests are captured. Check the service worker console (`chrome://extensions` → Service worker → Inspect).

**The response body is missing.** Possible causes: binary or streaming content, an opaque (`no-cors`) response, the body-size limit, an interrupted request, or a body already consumed by something that bypassed the recorder. The details pane explains which applies. A missing body does not mean the request failed.

**History disappears after reload.** It shouldn't: history is stored in IndexedDB. Check whether retention removed old entries (Settings) and whether the header shows a storage warning. Requests still `pending` when you navigated become `incomplete`.

**Duplicate requests appear.** Apps often retry, poll or fetch in parallel, and React StrictMode runs effects twice in development. Compare timestamps, initiator stacks and payloads, and see what the Investigations findings conclude, before treating duplicates as a bug.

**A replay fails.** CORS, cookies, authentication, CSRF tokens and the extension `Origin` can all differ from the page. Try **Copy cURL** with your own credentials instead.

**Warnings or errors point to `main-world.js`.** While recording, Dev Companion wraps `console.error` / `console.warn` to put them on the timeline, so tools that read the call stack can name the wrapper instead of your code. The message and your app's behavior are unchanged. Chrome DevTools skips the wrapper (it is ignore-listed). The wrapper is installed when the page starts loading, beneath framework console patches such as Next.js's, so those tools normally see your code. If you started recording on an already-open page, console capture only begins after a reload, and console is left untouched until then. To remove the wrapper entirely, turn off Settings → **Record console errors and warnings**. You lose console events in the timeline, but uncaught errors and unhandled rejections are still recorded.

**A realtime connection is missing.** Sockets opened before recording started (or before the recorder was installed) can't be recovered: reload after starting. Sockets opened inside Web Workers or iframes aren't captured.

**Server spans don't appear.** Check the Overview's "Server / SSR tracing" card. "Not configured" means no integration is set up. "Unreachable" means the dev server isn't running with `DEV_COMPANION_TRACING=1`, or uses another port. "The collector rejected the token" means the token in Settings doesn't match `.dev-companion/token`.

**Capture stopped after updating the extension.** Reload the debugged page; content scripts from the previous extension version disconnect.

## 15. Security guidelines

- Record only the sites you are debugging; access is granted per host.
- Review redaction rules (Settings) before exporting, and add rules for your app's own secret fields.
- Don't upload captured sessions to untrusted services.
- Use staging data for replay.
- Clear recordings that contain sensitive data when you no longer need them.
- Extension storage is not a secrets manager. See [SECURITY.md](SECURITY.md).

## 16. Known limitations

- Captured: page `fetch`, XHR, `sendBeacon`, WebSocket and EventSource in the top frame's main thread. **Not** captured: iframes, Web Workers and service workers (including their sockets), navigations and form posts (advanced capture adds the document response), static resources, and browser-generated traffic.
- Requests made before recording started, or from a page loaded before recording started, are not captured.
- Cookies and browser-added request headers are not visible. Cross-origin response headers are limited by CORS.
- Bodies over the size limit are truncated. Binary bodies are not stored; `text/event-stream` bodies are only parsed with the fetch event-stream option. Binary realtime protocols (SignalR MessagePack, binary Socket.IO attachments) are not decoded.
- OpenAPI documents must be JSON; YAML is not supported.
- Server tracing: development only (no static/ISR pages), Next.js middleware untested, Node.js runtime only.
- Initiator stacks show bundled code locations (no source maps). React component information is not available.
- The explorer shows values as stored. Redaction rules added later apply to exports, but not to what you see until you run **Apply redaction to stored history**, which rewrites requests but not timeline events.
- `window.fetch`, `XMLHttpRequest.prototype.open/send/setRequestHeader` and `navigator.sendBeacon` are replaced by wrappers while the recorder is installed, so code that checks `fetch.toString()` for `[native code]` sees the difference. Request and response behavior is unchanged.
- A request is stored only after the recorder observes it. If the page unloads while the response body is still being read, the entry can end up `incomplete` or without a body.
- Correlation and diagnosis are time- and rule-based, not causal. Verify important findings against backend logs and other tools.

## 17. Recommended workflow

1. Start recording (and reload if the bug involves page load).
2. Add a marker, then reproduce the issue.
3. Find the request (search or filters).
4. Inspect the payload and response.
5. Check the Timeline and Related tabs for console errors and route changes.
6. Compare against a successful request.
7. Read the findings in Investigations and follow the next steps.
8. Fix, repeat the action, and compare again.
9. Export a redacted report if someone else needs to investigate.
