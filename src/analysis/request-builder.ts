// Query-string editing for the request playground. Works on the raw URL text,
// so typing in the URL field is never re-encoded under the cursor; the URL is
// only rebuilt when a param row is edited.

export interface ParamRow {
  key: string;
  value: string;
  /** Disabled rows stay in the table but are left out of the URL. */
  enabled: boolean;
}

function decodeQueryPart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** Splits a URL into the part before "?", its query params and its "#fragment". */
export function splitUrl(url: string): { base: string; params: ParamRow[]; hash: string } {
  const hashAt = url.indexOf('#');
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const rest = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = rest.indexOf('?');
  if (queryAt < 0) return { base: rest, params: [], hash };
  const params = rest
    .slice(queryAt + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return {
        key: decodeQueryPart(eq < 0 ? pair : pair.slice(0, eq)),
        value: eq < 0 ? '' : decodeQueryPart(pair.slice(eq + 1)),
        enabled: true,
      };
    });
  return { base: rest.slice(0, queryAt), params, hash };
}

/** Rebuilds a URL from its base, the enabled param rows and the fragment. */
export function joinUrl(base: string, params: ParamRow[], hash = ''): string {
  const query = params
    .filter((p) => p.enabled && p.key !== '')
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&');
  return `${base}${query ? `?${query}` : ''}${hash}`;
}

/** Replaces the query of `url` with `params`, keeping its base and fragment. */
export function withParams(url: string, params: ParamRow[]): string {
  const { base, hash } = splitUrl(url);
  return joinUrl(base, params, hash);
}

/** Pretty-prints a JSON body; returns null when the text is not JSON. */
export function formatJsonBody(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}
