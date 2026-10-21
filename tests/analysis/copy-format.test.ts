import { describe, expect, it } from 'vitest';
import {
  headersForCopy,
  prettyForCopy,
  queryForCopy,
  rowsForCopy,
  valueForCopy,
} from '../../src/ui/lib/copy-format';

describe('copy formatting', () => {
  it('pretty-prints JSON objects and arrays and leaves other text alone', () => {
    expect(prettyForCopy('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(prettyForCopy('  [1]  ')).toBe('[\n  1\n]');
    expect(prettyForCopy('{broken')).toBe('{broken');
    expect(prettyForCopy('"just a string"')).toBe('"just a string"');
    expect(prettyForCopy("curl 'https://a.test'")).toBe("curl 'https://a.test'");
    expect(prettyForCopy('42')).toBe('42');
  });

  it('copies values as their natural text', () => {
    expect(valueForCopy('plain')).toBe('plain');
    expect(valueForCopy(3)).toBe('3');
    expect(valueForCopy(null)).toBe('null');
    expect(valueForCopy({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(valueForCopy(undefined)).toBe('undefined');
  });

  it('formats headers, rows and query parameters', () => {
    expect(
      headersForCopy([
        { name: 'content-type', value: 'application/json' },
        { name: 'x-id', value: '7' },
      ]),
    ).toBe('content-type: application/json\nx-id: 7');
    expect(rowsForCopy([{ name: 'Total', value: '12 ms' }])).toBe('Total: 12 ms');
    expect(JSON.parse(queryForCopy(new URLSearchParams('a=1&b=2&a=3')))).toEqual({ a: ['1', '3'], b: '2' });
  });
});
