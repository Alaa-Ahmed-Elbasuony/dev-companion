# Dev Companion — User Guide

## 1. What it does

Dev Companion records the API requests a web page makes (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`) and its realtime traffic (WebSocket, Socket.IO, SignalR, server-sent events) while you reproduce a bug. It keeps the requests, their payloads, their readable responses and the realtime messages after they finish, after page navigation and after reloads. It also records console errors and other page events, so you can see what happened around a failed request. Optionally, it shows what your development server did while rendering the page (section 13). On development origins it can also mock responses and simulate slow or failing APIs (section 11).

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

The dashboard has ten views, also reachable with Alt+1 … Alt+9 and Alt+0:

| View           | Shows                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview       | Recording state, counts of requests, failures, slow and pending requests, console errors, storage; realtime connection health; server tracing status ("Not configured" rather than zero when it isn't set up); capture notes such as rate-limit drops; findings worth investigating |
| Network        | The request list and details (this section)                                                                                                                                                                                                                                         |
| Realtime       | Connections and their messages (section 12)                                                                                                                                                                                                                                         |
| Timeline       | Everything in one chronological list: requests, realtime events, console, navigation, interactions, notifications, server spans                                                                                                                                                     |
| Tracing        | Server traces as a waterfall, with their links to browser events (section 13)                                                                                                                                                                                                       |
| Console        | Console errors and warnings, uncaught errors and unhandled rejections                                                                                                                                                                                                               |
| Storage        | The live site's cookies, local and session storage, IndexedDB, Cache Storage and service workers (section 14)                                                                                                                                                                       |
| Investigations | Findings and the investigation workspace (section 8)                                                                                                                                                                                                                                |
| Simulation     | Mocks, latency and failures for allowlisted development origins (section 11)                                                                                                                                                                                                        |
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
| Alt+1 … Alt+9 | Switch view                                                              |
| `i`           | Investigate the selected event                                           |
| `?`           | Show shortcuts                                                           |

Single-key shortcuts are ignored while you type in a field. Dialogs keep focus inside them until closed, and focus returns to the button that opened them.

## 7. Compare two requests

1. Open the first request and click **Compare as A**.
2. Open the second one (from another attempt or session) and click **Compare as B**.
3. Open **Investigations → Compare**. It shows method, URL, status and duration (with the delta), a structural JSON diff of response and request bodies (added, removed, type-changed and value-changed paths), and request and response header differences. Volatile headers such as `date` and `etag` are hidden unless you include them.

If `price` is a number in A and a string in B, you'll see `$.price  type-changed  number → string`. That points to an inconsistency, but check the intended contract before deciding which response is wrong.

You can compare a simulated request with a real one (for example a mocked error with the server's real response). The request picker tags simulated requests, each side names its rule, and the summary adds an **Outcome from** row (`server`, or the rule) with a note that differences may come from the rule rather than the backend.

### API contract baselines

- **Save as baseline** (request details) stores the shape of a successful JSON response as the baseline for its endpoint. The endpoint key is method + host + path, with id-like segments shown as `:id`.
- In **Investigations → Compare → API contract baselines**, you can instead paste a **JSON Schema**. The supported keywords are listed on screen; others are ignored.
- Later 2xx JSON responses for that endpoint are checked. Results appear in request details and Investigations → Findings. An inferred baseline is one example and reports medium confidence. A schema reports high confidence.
- A simulated request can't be saved as a baseline, and a response a rule produced never produces a contract finding.

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

**Simulated requests in findings.** Each finding is tagged **backend** (it describes the server: a status, body, timing or lifecycle) or **page behavior** (it describes how the page's code reacted to traffic). Simulated requests are used as follows:

| Findings                                                                                                                                        | Simulated requests                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend, from the response: HTTP 4xx/5xx, authentication, contract and OpenAPI checks, cached responses after a mutation, realtime expectations | Only a delayed request the server actually answered (a status and response headers were recorded). Mocks and simulated failures never count. The finding is marked **delayed by simulation** and names the rule. |
| Backend, from timing or lifecycle: slow requests, network failures and timeouts, requests that never finished                                   | Never. Added delay is not server latency, and a timeout or cancellation during or after an added delay is not a server failure.                                                                                  |
| Comparison with the previous session                                                                                                            | Never, on either side.                                                                                                                                                                                           |
| Page behavior: console errors after a failed request, error responses used as data, repeated requests, hydration                                | Always. When a simulated request is involved, the finding is tagged **simulated**, its title names the rule, and its first limitation says the outcome came from the rule, not the server.                       |

A delay rule marks a request as sent when the delay starts. If the page cancels the request or it times out before the delay is over, it was never sent; Dev Companion tells the two apart from the recorded times and response, not from that mark. The failed-request counts in the Overview, the dashboard header and the popup (they always agree) count failures the server returned: real requests, plus a delayed request whose failing response the server sent (the Overview says how many). Mocks, simulated failures, requests never sent and timeouts or cancellations during or after an added delay are not counted; the Overview shows how many simulated failures were left out. The slow and pending counts use real traffic only. The number of simulated requests is shown separately. Simulated requests still appear in the request list, can be investigated and compared, and are labeled wherever they appear.

Each finding lists what was observed, the evidence (with links to the requests), plausible explanations, next steps, a confidence level and its limitations. Treat these as starting points rather than verdicts. For example, 401 commonly means missing or expired authentication, 403 missing permission, 404 a wrong path or id, 422 validation failure, and 500 a server-side error. A failure with no HTTP status can come from CORS, DNS, being offline, a blocker or cancellation, and the browser hides which one from page scripts. Check the browser console for the reason.

**Investigate an event.** Click **Investigate** on a request, a realtime message or a span, or press `i`. The workspace shows what happened, the related events and how strongly each is linked (shared id, same trace, same connection, by time only), the earliest verified point where things diverged, ranked possible causes, the evidence that is missing (for example "server tracing not configured"), next steps and reproduction steps. For a realtime message, a notification checklist shows which stages were observed and which can't be observed without the page adapter. Nothing in it is invented: a stage that wasn't recorded is marked "Unknown" or "Not instrumented". From the workspace you can save the investigation, create a redacted bug report (Markdown or JSON), or copy a Playwright test draft. Interactions that caused mutating requests are commented out in the draft.

In an investigation, a simulated request is titled "(simulated)", the summary says which rule produced it (or how many related requests were simulated), a failure it caused is marked as not coming from the server (or, for a delayed request the server answered, as the server's), each possible cause says whether its finding is about the backend or the page, and reproduction steps say a mocked mutation never reached the server. A request a rule answered without sending is never linked to server spans or realtime messages. Bug reports add a **Simulated requests** section and mark causes that come from findings about the page reacting to simulated traffic, and the Playwright draft adds a `// SIMULATED:` comment where the recorded status came from a rule.

The **Timeline** view merges requests with console errors and warnings, uncaught errors, unhandled rejections, route changes, page loads, clicks, form submissions and markers. Use the chips to filter, and click a request or a related-request link to open it.

## 9. Export and import

**Export…** (Requests toolbar) exports the checked requests or, if none are checked, the currently shown (filtered) ones:

- **Dev Companion JSON:** requests, bodies, sessions and, optionally, timeline events. You can import it again.
- **HAR 1.2:** for other HAR tools. Cookies are not included. Extra Dev Companion fields are under `_devCompanion`.

Simulated requests are exported as recorded, with what happened to them. The JSON export keeps their `simulated` field. HAR has no field for a response no server sent, so a simulated entry gets a standard `response.comment` ("Synthetic: produced by Dev Companion, not returned by a server"; for a delay the server answered, that the response is the server's with time added by the rule; for a delayed request that ended without a response, that none was recorded) and its rule details under `_devCompanion.simulated`. Status, headers and body are kept as the page received them, so a HAR tool that ignores comments and custom fields shows a mocked response like a real one. Importing either format restores the marker.

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

## 11. Simulate responses, latency and failures

Test how your frontend handles errors, slow APIs and unfinished endpoints without changing the backend. Rules apply to the page's `fetch` and `XMLHttpRequest` requests, so libraries built on them (Axios, for example) are covered too. Simulation is off by default and runs only on development origins you allowlist.

1. Start recording the tab, then open the workspace from its popup and go to **Simulation** (Alt+0).
2. Under **Allowlisted origins**, add your development origin (for example `http://localhost:3000`). The list starts empty, and only listed origins can be simulated. Adding an origin does not turn simulation on.
3. Click **New rule**, describe the requests it matches and what should happen, and click **Create rule**.
4. Click **Turn simulation on**. The status table shows whether **this tab** receives the rules. If it doesn't, the view lists why: the switch is off, the origin isn't allowlisted, the tab isn't recording or is paused, or no rule is enabled.
5. Reload the page if requests made during page load should be simulated too.

While simulation is active on a tab, the popup says so and links to the Simulation view.

| Field            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL pattern      | `localhost:3000/api/orders/:id` (host and path), `http://localhost:3000/api/*` (scheme, host and path) or `/api/orders` (a path on any host). `:name` matches one path segment, `*` matches anything. A trailing `/` is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Query parameters | `?status=open&page=*` in the pattern requires those parameters (`*` = any value). Choose whether other parameters are allowed or the query must contain exactly those.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Methods          | Comma-separated, for example `GET, POST`. Empty matches any method.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| What happens     | **Mock a response** (status 200–599, status text, headers, a JSON or text body up to 1 MB; the request never reaches the server), **Delay, then send the real request**, **Network error**, **Timeout** after a set time, or **Hang** (never responds; the request ends only when the page aborts it or its own timeout fires).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Delay            | Waited before the outcome, up to 120 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| When it applies  | Every matching request, a random percentage, the first N matching requests and then pass through (useful for retries), or every Nth. Counts are kept per page load and restart when the rule is saved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Enabled          | Disabled rules are kept but never applied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Auth/payment     | Authentication and payment requests are never simulated unless the rule ticks **Allow this rule to simulate authentication and payment endpoints**. The editor warns when a pattern targets them. Detection looks at the request's host and path: a host named for it (`login.example.com`, `auth.…`, `sso.…`, `api.stripe.com`, `checkout.…`); a segment such as `login`, `token`, `oauth`, `session`, `checkout` or `payment`; unambiguous words inside names written with `-`, `_` or camelCase (`oauth-callback`, `resetPassword`, `payment_methods`); and phrases such as "refresh token", "verify email", "account recovery", "credit card" or "place order". Ambiguous words (`pay`, `card`, `token`, `session`, `verify`) count only as a whole segment or in such a phrase, so `/blog/how-to-pay` or `/api/token-usage` stay simulatable. |

**Priority:** rules are checked from top to bottom, and the first enabled rule that matches decides. Use the arrows in the list to change the order. Rules can be edited, disabled or deleted (after a confirmation) at any time. If the same rule was changed in another window, saving reports it and shows the latest version instead of overwriting it.

**Is it running?** The Simulation view shows **Active on this tab** only after the tab's page confirms that it applies exactly the current rules. Until then it says what it knows: **Saved, not sent to this tab yet**, **Sent to this tab, not confirmed yet** (it waits up to 5 seconds), **Not confirmed by this tab** (the page did not confirm; reload it) or **Page not connected** (no Dev Companion connection in the page; reload it). Only the page currently loaded in the tab can confirm, and only for the current rules: a reloaded page has to confirm again. The popup's warning says whether the page confirmed.

**How long a request can be held:** a page simulates with a 60-second lease that the extension renews every 20 seconds (after a failed renewal it keeps trying). When the lease runs out without renewal (the extension cannot be reached), the page stops simulating and sends every request it was holding, unchanged, as **Turn simulation off** does; such requests are recorded with a note. So a held request is never held more than 60 seconds after the last successful renewal, and a delay never more than 120 seconds. A request the page aborts or times out while it is held is never sent afterwards.

**The switch:** **Turn simulation off** stops simulation in open pages at once. Requests a rule was holding (a delay or a hang) are sent unchanged, and the rules are kept. The switch also turns itself off when the browser restarts or the extension is reloaded. Pausing recording pauses simulation, and stopping recording ends it.

**What is recorded:** simulated requests appear in the Network list and the Timeline like any other, tagged **simulated**, or **delayed by simulation** when the server's response was recorded after an added delay. The **Simulated** filter in the request list (shown in sessions with simulated requests) narrows the list to them and combines with search and the other filters; in the Timeline, search for `simulated` (or `delayed by simulation`). Their details name the rule, whether the request reached the network and where the outcome came from. Backend findings use only responses the server actually returned and never their timing; findings about how the page reacted include them, tagged **simulated**. They are never baselines or counted in backend statistics, and can be investigated, compared and exported (see sections 7–9).

**Not affected:** Replay and the Request playground (they are sent from the extension, not the page), navigations and form posts, `sendBeacon`, WebSocket and EventSource, and requests made in iframes or workers.

**How simulated responses differ from real ones:**

- A mocked `fetch` response is never redirected and its `type` is `default`.
- XHR events are dispatched by Dev Companion, so `event.isTrusted` is `false`. A mocked response is delivered in one step, without `upload` events. `responseType = 'document'` gives `null`.
- While a rule holds an XHR request, changing `xhr.timeout` has no effect and setting `withCredentials` doesn't throw (a real in-flight request would).
- `Set-Cookie` headers in a mock are not exposed to the page and set no cookie.
- A simulated network error looks like any failed request (a `TypeError` from `fetch`, an `error` event from XHR). A specific CORS or DNS failure can't be simulated.
- Auth/payment protection is a safety heuristic over host and path names, not a guarantee: it can miss endpoints named differently, endpoints chosen by a query parameter (`/index.php?action=login`) and GraphQL operations, and it never looks at bodies or headers. Check your app's sign-in and checkout paths before writing broad rules.

## 12. Realtime traffic

WebSocket and EventSource traffic is recorded while recording is on (Settings → Capture → "Record WebSocket and EventSource traffic"). The **Realtime** view lists connections with their transport, protocol, state, close code and reconnect attempt (`#2`, `#3`, …). Select one to see its messages:

- **Decoding:** Socket.IO / Engine.IO events and acknowledgements, SignalR invocations, completions and server calls, and SSE events are decoded and shown with their arguments. Heartbeats (pings, keep-alives) are separated from application messages; **app messages only** hides them.
- **Polling transports:** Socket.IO long polling and SignalR long polling / SSE send requests stay in the Network list, and also appear here as a connection with decoded messages ("derived").
- **Links:** a message that carries the same request id as an HTTP request is linked to it ("shared id"). Reconnects are linked to the previous connection, and a Socket.IO WebSocket to its polling handshake ("upgraded from polling").
- **Limits:** frames over the frame limit (default 64 KB) are truncated. Binary frames are shown by type and size only. If a page sends more than about 500 frames per second for a sustained period, the excess is dropped and the Overview lists a capture note with the count. The page still receives every frame.
- **Parse fetch() event streams** (Settings → Capture) also decodes SSE delivered through `fetch()` instead of `EventSource`.

### Advanced capture

The **Advanced off / on** button in the dashboard header (or the **Advanced** checkbox in the popup) attaches Chrome's debugger to the recording tab. While it is on, Chrome shows "Dev Companion started debugging this browser". Advanced capture adds:

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

## 13. Server-side rendering and API traces

If your app is a Node server (tested with Next.js 16), the development-only [server tracer](../packages/server-tracer/README.md) records what the server did for each request: render phases, route handlers, and outbound `fetch` / `node:http` calls with their status, timing and (redacted) bodies. Setup takes a few minutes and is described in the tracer's README. The [example app](../examples/next-ssr/README.md) shows it end to end.

Once configured (Settings → Integrations → Server tracing), the **Tracing** view lists traces. Select one to see its waterfall: nested spans, durations, failed calls highlighted in red (the trace list shows how many failed), and the browser events linked to it. A page load is linked to its server render by trace id when Next.js renders `<meta name="traceparent">`. Without it, links are made by time and path and labelled "by time only". **Sync now** pulls immediately; otherwise spans are pulled shortly after each navigation or request.

Server tracing only works with `next dev` (it is off in production builds), so statically generated and ISR pages are not traced.

## 14. Recording controls and storage

- **Pause / Resume:** keeps the session but stores nothing while paused.
- **Stop:** the popup, dashboard header or DevTools panel. New events stop being stored immediately. Stopping does **not** delete anything.
- **Delete selected:** tick requests in the list, then click **Delete selected**.
- **Clear session:** deletes the selected session's requests and timeline events.
- **Clear site data:** the second header row lets you pick what to clear for the inspected site (**Cookies**, **Local storage**, **Session storage**, **IndexedDB**, **Cache storage**, **Service workers**, or **All**), then **Clear selected** clears them. Your selection is remembered. The first use asks for the optional `cookies` / `browsingData` permissions. Cookies are removed only if the site receives them, so sibling subdomains are not affected. Recorded requests are kept. Reload the page afterwards.
- **Storage view:** click the site name in that row, or open the **Storage** tab (Alt+7), to see the site's cookies (with HttpOnly, Secure, SameSite, expiry and size), local and session storage keys and values (JSON shown as a tree), IndexedDB databases with record counts, Cache Storage entries and service workers. Delete single items with ✕ or a whole type with **Clear …**. It reads the live tab when opened; use **Refresh** after the page changes something.
- **Updates:** if you built the extension from a git checkout, it checks GitHub every few hours for newer extension changes and shows **Update available** in the popup and dashboard. **How to update** lists the changes and the steps (`git pull`, `npm install`, `npm run build`, then reload the extension in `chrome://extensions`). **Dismiss** hides it until newer changes land. Settings → Updates shows the build's commit, a **Check now** button and a switch to turn checks off.
- **Tab title:** each dashboard tab is titled after the site it works on (e.g. `● app.example.com · Dev Companion`, where `●` means recording), so several dashboards are easy to tell apart.
- **Settings:** theme (system, light, dark), retention (maximum requests, MB, body KB, timeline events, realtime messages, spans, and an optional age in days), slow-request threshold, capture toggles (console, interactions, stacks, realtime, fetch event streams, frame size), integrations, realtime expectations, OpenAPI contracts, redaction rules, **Apply redaction to stored history**, **Recompute usage**, **Delete all data**.
- The explorer header shows how many requests are stored and their approximate size, plus warnings about storage quota problems.

The oldest requests are removed automatically when a retention limit is exceeded.

## 15. Troubleshooting

**No requests appear.** Check that recording is on (REC badge) for this tab and origin. Reload the page after starting. Verify the site access was granted (`chrome://extensions` → Dev Companion → Details → Site access). Only fetch, XHR and beacon requests are captured. Check the service worker console (`chrome://extensions` → Service worker → Inspect).

**The response body is missing.** Possible causes: binary or streaming content, an opaque (`no-cors`) response, the body-size limit, an interrupted request, or a body already consumed by something that bypassed the recorder. The details pane explains which applies. A missing body does not mean the request failed.

**History disappears after reload.** It shouldn't: history is stored in IndexedDB. Check whether retention removed old entries (Settings) and whether the header shows a storage warning. Requests still `pending` when you navigated become `incomplete`.

**Duplicate requests appear.** Apps often retry, poll or fetch in parallel, and React StrictMode runs effects twice in development. Compare timestamps, initiator stacks and payloads, and see what the Investigations findings conclude, before treating duplicates as a bug.

**A replay fails.** CORS, cookies, authentication, CSRF tokens and the extension `Origin` can all differ from the page. Try **Copy cURL** with your own credentials instead.

**Warnings or errors point to `main-world.js`.** While recording, Dev Companion wraps `console.error` / `console.warn` to put them on the timeline, so tools that read the call stack can name the wrapper instead of your code. The message and your app's behavior are unchanged. Chrome DevTools skips the wrapper (it is ignore-listed). The wrapper is installed when the page starts loading, beneath framework console patches such as Next.js's, so those tools normally see your code. If you started recording on an already-open page, console capture only begins after a reload, and console is left untouched until then. To remove the wrapper entirely, turn off Settings → **Record console errors and warnings**. You lose console events in the timeline, but uncaught errors and unhandled rejections are still recorded.

**A realtime connection is missing.** Sockets opened before recording started (or before the recorder was installed) can't be recovered: reload after starting. Sockets opened inside Web Workers or iframes aren't captured.

**Server spans don't appear.** Check the Overview's "Server / SSR tracing" card. "Not configured" means no integration is set up. "Unreachable" means the dev server isn't running with `DEV_COMPANION_TRACING=1`, or uses another port. "The collector rejected the token" means the token in Settings doesn't match `.dev-companion/token`.

**Capture stopped after updating the extension.** Reload the debugged page; content scripts from the previous extension version disconnect.

## 16. Security guidelines

- Record only the sites you are debugging; access is granted per host.
- Review redaction rules (Settings) before exporting, and add rules for your app's own secret fields.
- Don't upload captured sessions to untrusted services.
- Use staging data for replay.
- Clear recordings that contain sensitive data when you no longer need them.
- Extension storage is not a secrets manager. See [SECURITY.md](SECURITY.md).

## 17. Known limitations

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

## 18. Recommended workflow

1. Start recording (and reload if the bug involves page load).
2. Add a marker, then reproduce the issue.
3. Find the request (search or filters).
4. Inspect the payload and response.
5. Check the Timeline and Related tabs for console errors and route changes.
6. Compare against a successful request.
7. Read the findings in Investigations and follow the next steps.
8. Fix, repeat the action, and compare again.
9. Export a redacted report if someone else needs to investigate.
