// Response-shape inference and a small JSON Schema subset validator.
// (Ajv is not used: it compiles validators with `new Function`, which the
// extension Content Security Policy forbids.)
import { typeOf } from './request-diff';
import type { ValueType } from './request-diff';

export type Shape =
  | { type: 'string' | 'number' | 'boolean' | 'null' }
  | { type: 'array'; items?: Shape }
  | { type: 'object'; properties: Record<string, Shape> }
  | { type: 'union'; of: Shape[] };

const MAX_DEPTH = 12;

function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === 'union') {
    return a.of.some((s) => s.type === b.type) ? a : { type: 'union', of: [...a.of, b] };
  }
  if (a.type !== b.type) return { type: 'union', of: [a, b] };
  if (a.type === 'object' && b.type === 'object') {
    // Keys present in only some items are kept (array items may vary).
    return { type: 'object', properties: { ...b.properties, ...a.properties } };
  }
  if (a.type === 'array' && b.type === 'array') {
    if (a.items && b.items) return { type: 'array', items: mergeShapes(a.items, b.items) };
    return a.items ? a : b;
  }
  return a;
}

export function inferShape(value: unknown, depth = 0): Shape {
  const t = typeOf(value);
  if (depth > MAX_DEPTH)
    return { type: t === 'array' || t === 'object' || t === 'undefined' ? 'null' : t } as Shape;
  if (t === 'array') {
    const arr = value as unknown[];
    let items: Shape | undefined;
    for (const item of arr.slice(0, 50)) {
      const s = inferShape(item, depth + 1);
      items = items ? mergeShapes(items, s) : s;
    }
    return items ? { type: 'array', items } : { type: 'array' };
  }
  if (t === 'object') {
    const properties: Record<string, Shape> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      properties[k] = inferShape(v, depth + 1);
    return { type: 'object', properties };
  }
  if (t === 'undefined') return { type: 'null' };
  return { type: t };
}

export interface ContractIssue {
  path: string;
  kind: 'missing' | 'unexpected' | 'type-mismatch' | 'constraint';
  message: string;
}

function shapeTypes(shape: Shape): ValueType[] {
  return shape.type === 'union' ? shape.of.flatMap(shapeTypes) : [shape.type];
}

/** Compares a value with an inferred baseline shape. */
export function compareToShape(
  value: unknown,
  shape: Shape,
  path = '$',
  issues: ContractIssue[] = [],
): ContractIssue[] {
  if (issues.length > 200) return issues;
  const actual = typeOf(value);
  const allowed = shapeTypes(shape);
  if (!allowed.includes(actual)) {
    issues.push({ path, kind: 'type-mismatch', message: `Expected ${allowed.join(' | ')}, got ${actual}` });
    return issues;
  }
  const match = shape.type === 'union' ? shape.of.find((s) => s.type === actual) : shape;
  if (!match) return issues;
  if (match.type === 'object' && actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const [k, s] of Object.entries(match.properties)) {
      if (!Object.hasOwn(obj, k))
        issues.push({
          path: `${path}.${k}`,
          kind: 'missing',
          message: 'Field present in baseline is missing',
        });
      else compareToShape(obj[k], s, `${path}.${k}`, issues);
    }
    for (const k of Object.keys(obj)) {
      if (!Object.hasOwn(match.properties, k))
        issues.push({ path: `${path}.${k}`, kind: 'unexpected', message: 'Field not present in baseline' });
    }
  } else if (match.type === 'array' && match.items && actual === 'array') {
    (value as unknown[])
      .slice(0, 50)
      .forEach((item, i) => compareToShape(item, match.items!, `${path}[${i}]`, issues));
  }
  return issues;
}

export const SUPPORTED_SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
] as const;

type Schema = Record<string, unknown>;

function matchesType(value: unknown, type: string): boolean {
  const t = typeOf(value);
  if (type === 'integer') return t === 'number' && Number.isInteger(value);
  return t === type;
}

/** Validates a value against a JSON Schema subset (see SUPPORTED_SCHEMA_KEYWORDS). */
export function validateJsonSchema(
  value: unknown,
  schema: unknown,
  path = '$',
  issues: ContractIssue[] = [],
): ContractIssue[] {
  if (issues.length > 200 || schema === true || schema === undefined) return issues;
  if (schema === false) {
    issues.push({ path, kind: 'constraint', message: 'Schema forbids any value here' });
    return issues;
  }
  if (typeof schema !== 'object' || schema === null) return issues;
  const s = schema as Schema;

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [String(s.type)];
    if (!types.some((t) => matchesType(value, t))) {
      issues.push({
        path,
        kind: 'type-mismatch',
        message: `Expected ${types.join(' | ')}, got ${typeOf(value)}`,
      });
      return issues;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    issues.push({ path, kind: 'constraint', message: `Value not in enum ${JSON.stringify(s.enum)}` });
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) {
    issues.push({ path, kind: 'constraint', message: `Expected constant ${JSON.stringify(s.const)}` });
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = s[key];
    if (Array.isArray(options)) {
      const passing = options.filter((opt) => validateJsonSchema(value, opt, path, []).length === 0).length;
      if (key === 'anyOf' ? passing === 0 : passing !== 1) {
        issues.push({
          path,
          kind: 'constraint',
          message: `Value does not satisfy ${key} (${passing} of ${options.length} matched)`,
        });
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum)
      issues.push({ path, kind: 'constraint', message: `Below minimum ${s.minimum}` });
    if (typeof s.maximum === 'number' && value > s.maximum)
      issues.push({ path, kind: 'constraint', message: `Above maximum ${s.maximum}` });
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength)
      issues.push({ path, kind: 'constraint', message: `Shorter than ${s.minLength}` });
    if (typeof s.maxLength === 'number' && value.length > s.maxLength)
      issues.push({ path, kind: 'constraint', message: `Longer than ${s.maxLength}` });
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern, 'u').test(value))
          issues.push({ path, kind: 'constraint', message: `Does not match pattern ${s.pattern}` });
      } catch {
        issues.push({ path, kind: 'constraint', message: `Invalid pattern in schema: ${s.pattern}` });
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems)
      issues.push({ path, kind: 'constraint', message: `Fewer than ${s.minItems} items` });
    if (typeof s.maxItems === 'number' && value.length > s.maxItems)
      issues.push({ path, kind: 'constraint', message: `More than ${s.maxItems} items` });
    if (s.items !== undefined && !Array.isArray(s.items)) {
      value.slice(0, 200).forEach((item, i) => validateJsonSchema(item, s.items, `${path}[${i}]`, issues));
    }
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<
      string,
      unknown
    >;
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!Object.hasOwn(obj, key))
          issues.push({ path: `${path}.${key}`, kind: 'missing', message: 'Required field is missing' });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      if (Object.hasOwn(props, key)) validateJsonSchema(child, props[key], `${path}.${key}`, issues);
      else if (s.additionalProperties === false) {
        issues.push({
          path: `${path}.${key}`,
          kind: 'unexpected',
          message: 'Additional property not allowed by schema',
        });
      } else if (typeof s.additionalProperties === 'object') {
        validateJsonSchema(child, s.additionalProperties, `${path}.${key}`, issues);
      }
    }
  }
  return issues;
}
