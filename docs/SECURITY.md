# Security and privacy

Dev Companion records network traffic, which routinely includes credentials and personal data. This document describes what it can access, what it stores, and how it limits exposure.

## Permissions

| Permission                                            | Why                                                                                                                                                                          | When granted                                                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                             | Settings (`chrome.storage.local`) and per-tab recording state (`chrome.storage.session`)                                                                                     | Install                                                                                                                                                           |
| `unlimitedStorage`                                    | Lets IndexedDB grow to your retention limit (default 500 MB) without Chrome's per-extension quota cutting in. No install prompt; Dev Companion still enforces its own limits | Install                                                                                                                                                           |
| `scripting`                                           | Register and inject the recorder for granted origins                                                                                                                         | Install                                                                                                                                                           |
| `activeTab`                                           | Read the current tab's URL in the popup when you click the toolbar icon                                                                                                      | Install (no host access by itself)                                                                                                                                |
| Optional host permissions `http://*/*`, `https://*/*` | Inject the recorder into a site; send a confirmed replay to a target                                                                                                         | **Runtime, per host**, when you start recording or confirm a replay                                                                                               |
| `devtools_page`                                       | DevTools panel                                                                                                                                                               | Install                                                                                                                                                           |
| `debugger`                                            | Advanced capture (Chrome DevTools Protocol) for one recording tab                                                                                                            | **Install** (Chrome does not allow it to be optional); used only while you have advanced capture on for a tab, and Chrome shows a debugging banner while attached |
| Optional `cookies`                                    | Storage view and **Clear site data**: list and remove the cookies the inspected site receives (including HttpOnly)                                                           | **Runtime**, when you first open the Storage view or clear cookies                                                                                                |
| Optional `browsingData`                               | **Clear site data**: remove local storage, IndexedDB, Cache Storage and service workers for one origin                                                                       | **Runtime**, when you first clear one of those                                                                                                                    |

No host access is requested at install time. Chrome's prompt asks for one host (for example `https://shop.example.com/*`), and the grant covers every port of that host. You can revoke it in `chrome://extensions` → Dev Companion → Details → Site access.

Not requested: `tabs`, `webRequest`, `downloads`, `<all_urls>` at install. `cookies` and `browsingData` are optional and requested only when you use the Storage view or **Clear site data**, and they act only on the inspected site. `debugger` is granted at install because Chrome does not allow it to be optional, but nothing is attached until you turn on advanced capture for a tab. While attached, it can read all network traffic of that tab, including headers the page cannot see. Turn it off when you don't need it; it is detached when recording stops.

The E2E test build (`npm run build:e2e`, output in `dist-e2e/`) adds `host_permissions: ["http://127.0.0.1/*"]` so automated tests can run without a prompt. Never distribute that build.

## Where scripts run

- Only on `http:` and `https:` pages whose host you granted, and only in tabs where recording is active. The worker ignores events from other tabs.
- Never on `chrome://`, extension pages, the Chrome Web Store, or `file://` (Chrome forbids most of these, and the URL policy rejects the rest).
- Only in the top frame.

## Trust boundaries

- **The main-world recorder runs alongside page scripts.** A malicious page can see the recorder, forge recorder events, or disable it. Forged events can only add data to that page's own recording (including entries with made-up URLs or statuses, which are displayed as text and cannot be replayed to non-http(s) targets). The worker validates every event (`shared/sanitize.ts`): types, enums and sizes are enforced, strings are clipped, and an event cannot overwrite an entry belonging to a different session. Recorder-reported `marker` and `recording` timeline kinds are rejected, because only the extension UI may create those.
- **The worker trusts Chrome's sender information,** not page claims. Capture batches are accepted only from the top frame of a recording tab whose `sender.origin` matches the session origin. Recording-control messages (`start-recording`, `stop-recording`, `add-marker`, …) are accepted only from extension pages (`sender.url` on the extension origin).
- **Realtime frames come from the page or the network** and are untrusted like any captured data: they are size-limited (frame limit, default 64 KB), rate-limited at the bridge, validated, decoded defensively (malformed Socket.IO / SignalR / SSE frames are stored with a parse error, never thrown), and redacted before storage. Binary frames are never read.
- **Server spans come from a local process** you started, but are still validated, size-limited and redacted again on ingest. The worker only contacts collector URLs on `127.0.0.1` / `localhost` / `[::1]`; other URLs are rejected when settings are saved.
- **Imported files are untrusted.** They are size-limited (50 MB, 10,000 entries, body limit), validated, given new ids, redacted, stored in a separate "Imported" session, and never trusted as `pending`.
- **Rendering:** the UI renders all captured and imported content as text. React escapes it, and JSON highlighting builds text nodes; there is no `innerHTML`. Extension pages run under the default MV3 CSP, which blocks inline scripts and `eval`.

## What is collected

| Data                                                         | Collected                                                | Notes                                                                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request method, URL, page URL                                | Yes                                                      | Query parameters are redacted by key rules                                                                                                            |
| Request headers set by the page                              | Yes                                                      | Redacted by header-name and key rules. Cookies are not visible to page scripts                                                                        |
| Response headers readable by the page                        | Yes                                                      | `set-cookie` is redacted (and is normally not readable anyway)                                                                                        |
| Request and response bodies                                  | Yes, textual, up to the limit (default 1 MB each)        | Redacted by key and value rules before storage. Binary and streams are not stored                                                                     |
| Initiator stack traces                                       | Yes (toggle)                                             | File URLs and line numbers of page scripts; URL parameters redacted by key rules                                                                      |
| Console error/warning messages                               | Yes (toggle)                                             | Arguments are stringified (depth- and length-limited) and token-redacted                                                                              |
| Clicks                                                       | Yes (toggle)                                             | Element tag, id and visible label only                                                                                                                |
| Form submissions                                             | Yes (toggle)                                             | Form id/name, method, action, field count. **Never field values**                                                                                     |
| WebSocket / EventSource frames (text)                        | Yes (toggle), up to the frame limit                      | Redacted by key and value rules (in raw text and decoded arguments) before storage. Binary frames: type and size only                                 |
| Document navigation metadata                                 | Yes                                                      | Navigation Timing, `Server-Timing`, `<meta name="traceparent">`; the URL is redacted                                                                  |
| Notification text (`[role=alert]`, `aria-live`, …)           | Only for origins you opt in (app adapters)               | Text that appears in configured regions, length-limited and token-redacted                                                                            |
| Server spans (dev only)                                      | Only with the server tracer and a configured integration | Span names, timing, status, HTTP method/URL/status, bounded redacted bodies of server `fetch`. DB statements are dropped unless enabled in the tracer |
| Keystrokes, input values, passwords, `localStorage`, cookies | **No**                                                   |                                                                                                                                                       |

## Redaction

Default rules (editable in Settings → Redaction):

- **Header names** (exact): `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`, `x-amz-security-token`.
- **Key rules** for JSON keys (at any depth), form fields, query and fragment parameters, and header names. These are substring matches after lowercasing and removing `-`, `_`, `.` and spaces: `password`, `passwd`, `secret`, `token`, `apikey`, `accesskey`, `privatekey`, `sessionid`, `authorization`, `cookie`, `cardnumber`, `creditcard`. Exact matches: `pwd`, `cvv`, `cvc`, `cvv2`, `ssn`, `pin`, `otp`.
- **Value patterns** anywhere in text: JWTs (`eyJ….….…`), `Bearer` / `Basic` / `Token` credentials, and payment card numbers (Luhn-valid, 15–19 digits, Visa/Mastercard/Amex/Discover prefixes).
- URL user-info (`user:pass@`) is always removed.
- URLs inside free text (initiator stack frames, error messages, console messages, route-change details and timeline page URLs) get the same query, fragment and user-info redaction. This matters for pages whose own URL carries a token, such as an OAuth callback `/?access_token=…`: Chrome writes the document URL into every stack frame of the page's inline scripts.
- Truncated or invalid JSON falls back to pattern-based key redaction. Redaction is best effort: secrets in fields with unusual names, or embedded in free text, may not be detected. Add rules for your application's own fields.

### Removal vs re-redaction on export

- **Removal (default, at capture):** the worker redacts every entry **before** writing it to IndexedDB. The original values are never stored. The entry records how many values were removed.
- **Export:** exports re-apply the current rules, so a rule added later still affects exports.
- **Display is not masked.** The explorer shows what is stored. A rule added later does **not** hide or remove values already in storage. Use **Settings → Apply redaction to stored history** to rewrite stored requests (URLs, headers, bodies, stacks, error messages), or delete them. That action does not rewrite timeline events; clear the session to remove those.
- Deleting data deletes the IndexedDB records. Like any browser storage, freed disk pages may persist until the browser compacts them; that is not cryptographic erasure.

## Storage

- Local only: IndexedDB on the extension's origin, in your browser profile. Nothing is synced or uploaded.
- Bounded by entry count, approximate size (default 10,000 requests / 500 MB) and timeline size. Oldest data is removed first.
- Stopping a recording does not delete data. Use Clear session, Delete selected, or Delete all data. Uninstalling the extension deletes its storage.
- Anyone with access to your browser profile can read this data. Do not treat it as a secure vault.

## Network activity and replay safeguards

Dev Companion sends no analytics or telemetry. It makes two kinds of outbound requests:

- **Update check** (on by default, Settings → Updates): at most once an hour, an unauthenticated `GET https://api.github.com/repos/<repo>/compare/<build commit>...<branch>` (retried against `main` if the branch no longer exists) to the GitHub repository the build was cloned from. It sends only that commit hash and receives commit messages and changed file names. Builds made outside a git checkout never check.
- **Replays** you explicitly confirm:

- Replay is never automatic. It needs an edit step, a review screen naming the **target origin**, and a final click.
- Captured credential values were removed at capture. Headers whose value contains a `[REDACTED]` placeholder are never sent. Placeholders left in the URL or body cannot be dropped automatically; the review screen warns that they would be sent literally, so replace them first.
- Credential-like headers (by name and key rules) are dropped if the target origin differs from the original request's origin.
- Browser-controlled headers (`cookie`, `origin`, `host`, `sec-*`, …) are listed as not sent.
- Cookies are omitted (`credentials: 'omit'`) unless you tick the cookie option.
- State-changing requests (POST/PUT/PATCH/DELETE, or paths mentioning orders, payments, deletion, refunds and the like), cookie use and origin changes require an explicit acknowledgement.
- Only `http:` and `https:` targets are allowed. `CONNECT` / `TRACE` are refused.
- Chrome asks for host access to the target origin before the first replay to it.

If a request type cannot be replayed reliably (truncated or binary body), the UI says so and offers editing or cURL instead.

## Server tracing

The server tracer (`packages/server-tracer`) is a development tool that runs in your Node server process. Its safeguards:

- **Off unless asked, and never in production.** It starts only with `DEV_COMPANION_TRACING=1`, and refuses when `NODE_ENV=production`, during `next build`, and in the Edge runtime.
- **Nothing leaves the machine.** Spans are kept in memory (bounded: 2000 spans, 30 minutes by default) and served only on `127.0.0.1`. There is no exporter to a remote backend.
- **The collector only serves the extension.** It requires `Authorization: Bearer <token>` (compared in constant time), rejects requests whose `Host` is not a loopback name (DNS-rebinding protection), and rejects any request with an `Origin` other than `chrome-extension://…`, so web pages can't read spans even with a guessed token. The collector never keeps the server process alive on its own.
- **The token** is `DEV_COMPANION_TOKEN`, or a random 48-hex-character value stored in `.dev-companion/token` (file mode 0600, with a `.gitignore` of `*` in that folder). In the extension, tokens are kept in `chrome.storage.local` under their own key, separate from settings; they are not included in exports or bug reports.
- **Redaction happens twice.** The tracer redacts header values, URL query parameters, span attributes and bodies with the same default rules as the extension (plus any you add) before a span is buffered. The extension redacts again on ingest. Database statements (`db.statement`, `db.query.text`) are dropped unless you enable them.
- **Outbound requests are not modified** by default. `traceparent` propagation to upstream services is opt-in (`propagateToOutbound`).
- **Failures are contained.** If the collector port is taken, the tracer logs a warning and reports itself disabled (not covered by automated tests). If span export fails, rendering continues; the SSR suite tests this.

## Advanced capture

When you turn on advanced capture, Chrome attaches the extension to one tab as a debugger. It sees the tab's network traffic, including cookies and other headers the page cannot read. Dev Companion enables only the `Network` domain, without request post data, and runs everything through the same redaction as main-world capture before storage. Chrome shows a banner for as long as it is attached. Attachment ends when you turn it off, when recording stops, or when you dismiss the banner.

## Reporting

This is a local development tool. If you find a way for page content to reach extension privileges, or for captured data to leave the browser without user action, treat it as a security bug.
