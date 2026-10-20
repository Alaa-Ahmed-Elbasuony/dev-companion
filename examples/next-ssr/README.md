# Next.js SSR example

A small Next.js 16 app used to exercise Dev Companion's server tracing ([`@dev-companion/server-tracer`](../../packages/server-tracer/README.md)) by hand and in the automated SSR suite. Its pages make server-side calls to a local "upstream" API with known behavior: one succeeds, one fails with 503, one is slow, one is cached.

## Run it

```bash
cd examples/next-ssr
npm install
npm run dev:traced        # upstream API on :3101 + `next dev` on :3100 with DEV_COMPANION_TRACING=1
```

`dev:traced` starts the upstream API and the dev server together. To run them separately: `npm run upstream` in one terminal, and `DEV_COMPANION_TRACING=1 npm run dev` in another.

On startup the dev server prints the collector URL and the token file:

```
[dev-companion] server tracing on. Collector http://127.0.0.1:4319 (loopback only). Token: …/examples/next-ssr/.dev-companion/token
```

Then, with the extension built and loaded (see the [main README](../../README.md)):

1. Dev Companion → Settings → Integrations → **Add server integration**: app origin `http://127.0.0.1:3100`, collector `http://127.0.0.1:4319`, and the token from `.dev-companion/token`. Click **Test connection**.
2. Open `http://127.0.0.1:3100/orders` and start recording that tab from the toolbar popup. Reload the page.
3. Open the dashboard → **Tracing**. The `GET /orders` trace shows two outbound calls in its waterfall: `/products` (200) and `/inventory` (503, marked as failed). The browser navigation is linked to it by trace id ("shared id").
4. The page's client component then sends `POST /api/orders`. It appears in **Network** as a browser request and in **Tracing** as a separate server trace for the route handler.

Use `127.0.0.1`, not `localhost`: `next.config.mjs` allows dev resources for `127.0.0.1`, which is what the tests use.

## Pages

| Path          | What it does                                                                                                                                                                                                 | What to look for                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/orders`     | App Router page rendered per request. Calls `/products` (200) and `/inventory` (503) in parallel with an `Authorization` header, then renders a client component that POSTs to `/api/orders` after hydration | Waterfall with a failed call; the `Authorization` value and `supplierToken` in the upstream response are `[REDACTED]`; the upstream never receives a `traceparent` header |
| `/api/orders` | Route Handler (`POST`). One outbound call, then JSON                                                                                                                                                         | A server trace separate from the page render, linked to the browser `POST`                                                                                                |
| `/legacy`     | Pages Router `getServerSideProps` using `node:http` instead of `fetch`                                                                                                                                       | A `node:http` client span                                                                                                                                                 |
| `/cached`     | Rendered per request, but its upstream fetch uses `next: { revalidate: 60 }`                                                                                                                                 | The first render calls the upstream; later renders are served from the Next.js data cache, and their fetch span has `next.fetch.cache_status: hit`                        |
| `/slow?tag=x` | Waits for a 600 ms upstream call tagged with `x`                                                                                                                                                             | Used by the tests to load two pages concurrently in two recorded tabs and check that each document links to its own trace                                                 |
| `/static`     | No data fetching                                                                                                                                                                                             | Prerendered by `next build`; under `next dev` it is still rendered per request                                                                                            |

The upstream API (`upstream.mjs`, port 3101, `UPSTREAM_PORT` to change it) records what it received, so tests can check that the tracer didn't add or remove headers.

## Files

| File                     | Purpose                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `instrumentation.js`     | Starts the tracer in the Node.js runtime. Delete it to uninstall                                                            |
| `next.config.mjs`        | `experimental.clientTraceMetadata: ['traceparent']` renders `<meta name="traceparent">`; `allowedDevOrigins: ['127.0.0.1']` |
| `scripts/dev-traced.mjs` | Starts the upstream API and `next dev` with tracing enabled                                                                 |
| `upstream.mjs`           | The upstream API                                                                                                            |
| `.dev-companion/`        | Collector token, created on first start. Ignored by git; don't commit it                                                    |

## Automated tests

From the repository root:

```bash
npm run test:e2e:ssr
```

This builds the test extension, starts the upstream API and `next dev` on ports 3101/3100 with a fixed token, and drives Chrome through 12 checks. They cover the render waterfall, the trace-id link, redaction, client vs server traces, the Pages Router, cached fetches, concurrent tabs, an exporter failure, a server restart, tracing turned off, and uncaught errors. The suite skips itself if `npm install` hasn't been run here.

## Limitations

- Tracing only runs under `next dev`. With `next build` / `next start`, `NODE_ENV` is `production` and the tracer stays off, so static and ISR pages are not traced.
- Middleware is not part of this example and has not been tested.
