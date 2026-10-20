// OpenAPI 3.x (JSON) contract validation of captured requests. Only local
// $refs (#/components/...) are resolved; YAML documents and remote refs are
// not supported. Validation uses the JSON Schema subset in contracts.ts, after
// converting OpenAPI 3.0 `nullable` into a type union.
import type { EntryBodies, NetworkEntry } from '../shared/types';
import { headerValue, safeUrl, tryParseJson } from '../shared/util';
import type { ContractIssue } from './contracts';
import { validateJsonSchema } from './contracts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export interface OpenApiDoc {
  title: string;
  version: string;
  servers: string[];
  paths: Obj;
  raw: Obj;
}

export class OpenApiError extends Error {}

export function parseOpenApi(text: string): OpenApiDoc {
  const parsed = tryParseJson(text);
  if (!parsed.ok) {
    throw new OpenApiError(
      'Not valid JSON. Only JSON OpenAPI documents are supported (convert YAML to JSON first).',
    );
  }
  const raw = parsed.value;
  if (!isObj(raw) || typeof raw.openapi !== 'string' || !raw.openapi.startsWith('3.')) {
    throw new OpenApiError('Not an OpenAPI 3.x document (missing "openapi": "3.x").');
  }
  if (!isObj(raw.paths)) throw new OpenApiError('The document has no "paths".');
  const info = isObj(raw.info) ? raw.info : {};
  const servers = Array.isArray(raw.servers)
    ? raw.servers.map((s) => (isObj(s) && typeof s.url === 'string' ? s.url : '')).filter(Boolean)
    : [];
  return {
    title: typeof info.title === 'string' ? info.title : 'API',
    version: typeof info.version === 'string' ? info.version : '',
    servers,
    paths: raw.paths,
    raw,
  };
}

/** Rebuilds a document stored as a parsed object (contracts store, kind "openapi"). */
export function openApiFromObject(raw: unknown): OpenApiDoc | null {
  try {
    return parseOpenApi(JSON.stringify(raw));
  } catch {
    return null;
  }
}

/** Resolves local $refs and converts `nullable` (OpenAPI 3.0) to a JSON Schema type union. */
export function normalizeSchema(schema: unknown, doc: OpenApiDoc, depth = 0): unknown {
  if (depth > 30) return true; // recursive schema: stop validating deeper
  if (Array.isArray(schema)) return schema.map((s) => normalizeSchema(s, doc, depth + 1));
  if (!isObj(schema)) return schema;
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#/')) return true; // remote refs are not followed
    let target: unknown = doc.raw;
    for (const part of schema.$ref.slice(2).split('/')) {
      target = isObj(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    return normalizeSchema(target ?? true, doc, depth + 1);
  }
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    out[k] =
      k === 'properties' && isObj(v)
        ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, normalizeSchema(pv, doc, depth + 1)]))
        : normalizeSchema(v, doc, depth + 1);
  }
  if (out.nullable === true && out.type !== undefined) {
    out.type = [...(Array.isArray(out.type) ? out.type : [out.type]), 'null'];
  }
  if (Array.isArray(out.allOf)) {
    // Merge allOf members (properties and required) — enough for typical API documents.
    const merged: Obj = { type: 'object', properties: {}, required: [] as string[] };
    for (const part of out.allOf) {
      if (!isObj(part)) continue;
      Object.assign(merged.properties as Obj, isObj(part.properties) ? part.properties : {});
      if (Array.isArray(part.required)) (merged.required as string[]).push(...(part.required as string[]));
    }
    delete out.allOf;
    return {
      ...merged,
      ...out,
      properties: { ...(merged.properties as Obj), ...(isObj(out.properties) ? out.properties : {}) },
    };
  }
  return out;
}

export interface MatchedOperation {
  template: string;
  method: string;
  operation: Obj;
  params: Record<string, string>;
  pathItem: Obj;
}

/** Strips a server base path ("https://api/v1" -> "/v1") from the request path. */
function relativePath(pathname: string, doc: OpenApiDoc): string {
  for (const server of doc.servers) {
    const base = (safeUrl(server, 'http://placeholder')?.pathname ?? '').replace(/\/+$/, '');
    if (base && pathname.startsWith(base)) return pathname.slice(base.length) || '/';
  }
  return pathname;
}

export function findOperation(doc: OpenApiDoc, method: string, url: string): MatchedOperation | null {
  const u = safeUrl(url);
  if (!u) return null;
  const path = relativePath(u.pathname, doc);
  const m = method.toLowerCase();
  let best: MatchedOperation | null = null;
  for (const [template, item] of Object.entries(doc.paths)) {
    if (!isObj(item) || !isObj(item[m])) continue;
    const names: string[] = [];
    const pattern = template
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\\?\{([^}]+)\\?\}|\{([^}]+)\}/g, (_x, a, b) => {
        names.push(a ?? b);
        return '([^/]+)';
      });
    const match = new RegExp(`^${pattern}/?$`).exec(path);
    if (!match) continue;
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1] ?? '')]));
    // Prefer literal segments over templated ones (/orders/new over /orders/{id}).
    if (!best || names.length < Object.keys(best.params).length) {
      best = { template, method: m, operation: item[m] as Obj, params, pathItem: item };
    }
  }
  return best;
}

export interface OpenApiIssue extends ContractIssue {
  /** Where the issue is: request parameters/body, response status/body/headers. */
  part:
    | 'request.params'
    | 'request.body'
    | 'response.status'
    | 'response.body'
    | 'response.headers'
    | 'request.headers';
  expected?: string;
  actual?: string;
}

export interface OpenApiResult {
  /** No matching operation: the request is not covered by the contract (no claim is made). */
  matched: boolean;
  operation?: string;
  issues: OpenApiIssue[];
  notes: string[];
}

function valueAt(value: unknown, path: string): unknown {
  const parts = path.replace(/^\$/, '').match(/\.([^.[\]]+)|\[(\d+)\]/g) ?? [];
  let v = value;
  for (const p of parts) {
    const key = p.startsWith('[') ? Number(p.slice(1, -1)) : p.slice(1);
    v = v && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined;
  }
  return v;
}

const preview = (v: unknown) => {
  if (v === undefined) return 'absent';
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
};

function mediaSchema(content: unknown, contentType: string | undefined, doc: OpenApiDoc) {
  if (!isObj(content)) return { declared: [] as string[], schema: undefined as unknown };
  const declared = Object.keys(content);
  const base = contentType?.split(';')[0]?.trim().toLowerCase();
  const key =
    declared.find((k) => k.toLowerCase() === base) ??
    declared.find((k) => k.endsWith('/*') && base?.startsWith(k.slice(0, -1))) ??
    declared.find((k) => k === '*/*');
  const media = key ? content[key] : undefined;
  return { declared, key, schema: isObj(media) ? normalizeSchema(media.schema, doc) : undefined };
}

export function validateEntryAgainstOpenApi(
  entry: NetworkEntry,
  bodies: EntryBodies | undefined,
  doc: OpenApiDoc,
): OpenApiResult {
  const op = findOperation(doc, entry.method, entry.url);
  if (!op)
    return { matched: false, issues: [], notes: [`No operation for ${entry.method} in "${doc.title}"`] };
  const issues: OpenApiIssue[] = [];
  const notes: string[] = [];
  const operation = `${entry.method} ${op.template}`;

  // Parameters (path-level and operation-level).
  const params = [
    ...(Array.isArray(op.pathItem.parameters) ? op.pathItem.parameters : []),
    ...(Array.isArray(op.operation.parameters) ? op.operation.parameters : []),
  ]
    .map((p) => normalizeSchema(p, doc))
    .filter(isObj);
  const url = safeUrl(entry.url);
  for (const p of params) {
    const name = String(p.name ?? '');
    let raw: string | undefined;
    if (p.in === 'path') raw = op.params[name];
    else if (p.in === 'query') raw = url?.searchParams.get(name) ?? undefined;
    else if (p.in === 'header') raw = headerValue(entry.requestHeaders, name);
    else continue;
    if (raw === undefined) {
      if (p.required === true) {
        issues.push({
          part: 'request.params',
          path: `${p.in}.${name}`,
          kind: 'missing',
          message: `Required ${p.in} parameter is missing`,
          expected: 'present',
          actual: 'absent',
        });
      }
      continue;
    }
    if (raw === '[REDACTED]') continue;
    const schema = normalizeSchema(p.schema, doc) as Obj | undefined;
    const types = schema ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
    const value =
      types.includes('integer') || types.includes('number')
        ? Number(raw)
        : types.includes('boolean')
          ? raw === 'true'
            ? true
            : raw === 'false'
              ? false
              : raw
          : raw;
    for (const issue of validateJsonSchema(value, schema, `${p.in}.${name}`)) {
      issues.push({ ...issue, part: 'request.params', actual: preview(raw) });
    }
  }

  // Request body.
  const reqBody = normalizeSchema(op.operation.requestBody, doc);
  if (isObj(reqBody)) {
    const text = bodies?.request?.text;
    const { declared, key, schema } = mediaSchema(reqBody.content, entry.requestContentType, doc);
    if (!text && reqBody.required === true && !entry.requestBodySize) {
      issues.push({
        part: 'request.body',
        path: '$',
        kind: 'missing',
        message: 'Request body is required',
        expected: declared.join(' | '),
        actual: 'absent',
      });
    } else if (text) {
      if (!key) {
        issues.push({
          part: 'request.headers',
          path: 'content-type',
          kind: 'constraint',
          message: 'Request Content-Type is not declared for this operation',
          expected: declared.join(' | '),
          actual: entry.requestContentType ?? 'absent',
        });
      } else if (bodies?.request?.truncated) {
        notes.push('Request body was truncated at capture; body validation skipped');
      } else {
        const parsed = tryParseJson(text);
        if (/json/i.test(key) && !parsed.ok) {
          issues.push({
            part: 'request.body',
            path: '$',
            kind: 'type-mismatch',
            message: 'Body is not valid JSON',
            expected: key,
            actual: 'invalid JSON',
          });
        } else if (parsed.ok && schema !== undefined) {
          for (const issue of validateJsonSchema(parsed.value, schema)) {
            issues.push({
              ...issue,
              part: 'request.body',
              actual: preview(valueAt(parsed.value, issue.path)),
            });
          }
        }
      }
    }
  }

  // Response status, Content-Type and body.
  if (entry.state !== 'complete' || entry.status === undefined) {
    notes.push('No HTTP response was received; response validation skipped');
    return { matched: true, operation, issues, notes };
  }
  const responses = isObj(op.operation.responses) ? op.operation.responses : {};
  const status = String(entry.status);
  const responseKey =
    status in responses
      ? status
      : `${status[0]}XX` in responses
        ? `${status[0]}XX`
        : 'default' in responses
          ? 'default'
          : undefined;
  if (!responseKey) {
    issues.push({
      part: 'response.status',
      path: 'status',
      kind: 'unexpected',
      message: 'Response status is not declared for this operation',
      expected: Object.keys(responses).join(' | '),
      actual: status,
    });
    return { matched: true, operation, issues, notes };
  }
  const response = normalizeSchema(responses[responseKey], doc);
  if (!isObj(response) || !isObj(response.content)) return { matched: true, operation, issues, notes };
  const text = bodies?.response?.text;
  const { declared, key, schema } = mediaSchema(response.content, entry.responseContentType, doc);
  if (!key) {
    issues.push({
      part: 'response.headers',
      path: 'content-type',
      kind: 'constraint',
      message: 'Response Content-Type is not declared for this status',
      expected: declared.join(' | '),
      actual: entry.responseContentType ?? 'absent',
    });
    return { matched: true, operation, issues, notes };
  }
  if (!text) {
    notes.push(
      entry.responseBodyKind === 'binary' || entry.responseBodyKind === 'stream'
        ? 'Response body was not captured (binary or stream)'
        : 'No response body captured',
    );
    return { matched: true, operation, issues, notes };
  }
  if (bodies?.response?.truncated) {
    notes.push('Response body was truncated at capture; body validation skipped');
    return { matched: true, operation, issues, notes };
  }
  const parsed = tryParseJson(text);
  if (/json/i.test(key) && !parsed.ok) {
    issues.push({
      part: 'response.body',
      path: '$',
      kind: 'type-mismatch',
      message: 'Body is not valid JSON',
      expected: key,
      actual: 'invalid JSON',
    });
  } else if (parsed.ok && schema !== undefined) {
    for (const issue of validateJsonSchema(parsed.value, schema)) {
      issues.push({ ...issue, part: 'response.body', actual: preview(valueAt(parsed.value, issue.path)) });
    }
  }
  return { matched: true, operation, issues, notes };
}
