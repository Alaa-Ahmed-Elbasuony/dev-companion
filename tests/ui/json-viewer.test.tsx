// @vitest-environment jsdom
// JSON tree and code view: large documents stay bounded, malformed input falls
// back to raw text, and captured content is never interpreted as markup.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BodyView, CodeView } from '../../src/ui/components/CodeView';
import { JsonTree } from '../../src/ui/components/ui';
import { installDomStubs } from '../helpers/dom';

beforeEach(installDomStubs);
afterEach(cleanup);

describe('JsonTree', () => {
  it('renders nested values with the first level open and deeper levels collapsed', () => {
    render(<JsonTree text={JSON.stringify({ user: { id: 1, tags: ['a', 'b'] }, ok: true, none: null })} />);
    expect(screen.getByText('"user"')).toBeTruthy();
    expect(screen.getByText('"id"')).toBeTruthy();
    const tags = screen.getByRole('button', { name: /"tags"/ });
    expect(tags.getAttribute('aria-expanded')).toBe('false');
    expect(tags.textContent).toContain('2 items');
    fireEvent.click(tags);
    expect(tags.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('"a"')).toBeTruthy();
  });

  it('shows the error and the raw text for malformed JSON', () => {
    const raw = '{"order": 12, "items": [1, 2,';
    render(<JsonTree text={raw} />);
    expect(screen.getByText(/Not valid JSON/)).toBeTruthy();
    expect(document.querySelector('pre.code')?.textContent).toBe(raw);
  });

  it('caps large arrays at 200 children until asked for more', () => {
    render(<JsonTree value={Array.from({ length: 5000 }, (_, i) => i)} />);
    expect(document.querySelectorAll('.jt-children > .jt-row')).toHaveLength(201); // 200 items + closing bracket
    fireEvent.click(screen.getByRole('button', { name: 'Show 4800 more' }));
    expect(document.querySelectorAll('.jt-children > .jt-row')).toHaveLength(5001);
  });

  it('truncates very long strings with an expander', () => {
    render(<JsonTree value={{ blob: 'x'.repeat(10_000) }} />);
    const more = screen.getByRole('button', { name: '… 8000 more characters' });
    expect(document.querySelector('.tok-string')!.textContent!.length).toBe(2002);
    fireEvent.click(more);
    expect(document.querySelector('.tok-string')!.textContent!.length).toBe(10_002);
  });

  it('parses documents over 256 KB in a worker and reports worker failures', () => {
    const instances: { onerror?: () => void; terminate: () => void; postMessage: (t: string) => void }[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        onmessage?: (e: MessageEvent) => void;
        onerror?: () => void;
        terminate = vi.fn();
        postMessage = vi.fn();
        constructor() {
          instances.push(this);
        }
      },
    );
    try {
      const big = JSON.stringify({
        rows: Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `row ${i}` })),
      });
      expect(big.length).toBeGreaterThan(256 * 1024);
      render(<JsonTree text={big} />);
      expect(screen.getByText('Parsing large JSON…')).toBeTruthy();
      expect(instances).toHaveLength(1);
      expect(instances[0]!.postMessage).toHaveBeenCalledWith(big);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders markup-looking strings as text', () => {
    render(<JsonTree value={{ html: '<img src=x onerror=alert(1)>' }} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('"<img src=x onerror=alert(1)>"')).toBeTruthy();
  });
});

describe('CodeView', () => {
  it('pretty-prints and highlights JSON, with a raw toggle', () => {
    render(<CodeView text='{"a":1,"b":"x","c":null}' />);
    expect(document.querySelector('pre.code')!.textContent).toBe('{\n  "a": 1,\n  "b": "x",\n  "c": null\n}');
    expect(document.querySelector('.tok-number')!.textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(document.querySelector('pre.code')!.textContent).toBe('{"a":1,"b":"x","c":null}');
  });

  it('shows malformed JSON verbatim without a pretty toggle', () => {
    render(<CodeView text='{"a":1,' />);
    expect(document.querySelector('pre.code')!.textContent).toBe('{"a":1,');
    expect(screen.queryByRole('button', { name: 'Raw' })).toBeNull();
  });

  it('skips highlighting above the size limit but still pretty-prints', () => {
    const text = JSON.stringify(Array.from({ length: 30_000 }, (_, i) => ({ i })));
    render(<CodeView text={text} />);
    expect(document.querySelector('.tok-number')).toBeNull();
    expect(document.querySelector('pre.code')!.textContent!.startsWith('[\n  {\n    "i": 0')).toBe(true);
  });

  it('never turns captured HTML into elements', () => {
    render(<CodeView text={'<script>alert(1)</script><b>bold</b>'} json={false} />);
    expect(document.querySelector('pre.code script, pre.code b')).toBeNull();
  });
});

describe('BodyView', () => {
  it('warns about truncated bodies and handles missing ones', () => {
    const { rerender } = render(
      <BodyView
        label="Response"
        body={{ kind: 'json', text: '{"a":', truncated: true, size: 9_999_999, note: 'Limit is 1 MB.' }}
      />,
    );
    expect(screen.getByText(/Truncated: only part of this body was captured/)).toBeTruthy();
    rerender(<BodyView label="Response" body={undefined} />);
    expect(screen.getByText('No response body.')).toBeTruthy();
  });
});
