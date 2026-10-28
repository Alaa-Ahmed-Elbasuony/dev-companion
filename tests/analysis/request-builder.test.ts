import { describe, expect, it } from 'vitest';
import { formatJsonBody, joinUrl, splitUrl, withParams } from '../../src/analysis/request-builder';

describe('splitUrl', () => {
  it('separates base, decoded params and fragment', () => {
    expect(splitUrl('https://a.test/api/items?q=red+shoes&page=2&flag#top')).toEqual({
      base: 'https://a.test/api/items',
      params: [
        { key: 'q', value: 'red shoes', enabled: true },
        { key: 'page', value: '2', enabled: true },
        { key: 'flag', value: '', enabled: true },
      ],
      hash: '#top',
    });
  });

  it('handles URLs without a query and malformed escapes', () => {
    expect(splitUrl('https://a.test/x')).toEqual({ base: 'https://a.test/x', params: [], hash: '' });
    expect(splitUrl('https://a.test/x?bad=%E0%A4%A').params).toEqual([
      { key: 'bad', value: '%E0%A4%A', enabled: true },
    ]);
  });
});

describe('joinUrl / withParams', () => {
  it('encodes enabled rows and skips disabled or empty-key rows', () => {
    expect(
      joinUrl(
        'https://a.test/api',
        [
          { key: 'q', value: 'a b&c', enabled: true },
          { key: 'off', value: '1', enabled: false },
          { key: '', value: 'x', enabled: true },
        ],
        '#h',
      ),
    ).toBe('https://a.test/api?q=a%20b%26c#h');
  });

  it('drops the "?" when no params remain and keeps the fragment', () => {
    expect(withParams('https://a.test/api?x=1#frag', [])).toBe('https://a.test/api#frag');
  });

  it('round-trips through splitUrl', () => {
    const url = 'https://a.test/api?ids=1%2C2&name=%C3%A9';
    expect(withParams(url, splitUrl(url).params)).toBe(url);
  });
});

describe('formatJsonBody', () => {
  it('pretty-prints JSON and rejects anything else', () => {
    expect(formatJsonBody('{"a":[1]}')).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(formatJsonBody('a=1')).toBeNull();
  });
});
