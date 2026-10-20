export const UPSTREAM = process.env.UPSTREAM_URL ?? 'http://127.0.0.1:3101';
// A credential the server sends upstream; it must never appear in traces.
export const UPSTREAM_AUTH = { authorization: 'Bearer upstream-secret-abc123' };
