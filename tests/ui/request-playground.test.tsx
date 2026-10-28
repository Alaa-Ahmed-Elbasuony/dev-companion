// @vitest-environment jsdom
// Request playground: param rows stay in sync with the URL, the body helpers,
// and sending (permission + consent gating, attempt history).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayDraft } from '../../src/analysis/replay-safety';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import type { EntryBodies } from '../../src/shared/types';
import { RequestPlayground } from '../../src/ui/dashboard/RequestPlayground';
import type * as Extension from '../../src/ui/lib/extension';
import { installDomStubs } from '../helpers/dom';
import { entry } from '../helpers/entries';

const bodies = new Map<string, EntryBodies>();
vi.mock('../../src/ui/lib/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof Extension>()),
  getStore: async () => ({ getBodies: async (id: string) => bodies.get(id) }),
  notifyDataChanged: () => undefined,
}));

const executeReplay = vi.fn();
vi.mock('../../src/ui/lib/replay', () => ({
  executeReplay: (...args: unknown[]) => executeReplay(...args),
}));

let requestPermission: ReturnType<typeof vi.fn>;

beforeEach(() => {
  installDomStubs();
  requestPermission = vi.fn(async () => true);
  (globalThis as unknown as { chrome: { permissions: unknown } }).chrome.permissions = {
    request: requestPermission,
  };
  bodies.clear();
  executeReplay.mockReset();
  let n = 0;
  executeReplay.mockImplementation(async (_orig: unknown, draft: ReplayDraft) =>
    entry({ id: `r-${++n}`, method: draft.method, url: draft.url, status: 200 + n, source: 'replay' }),
  );
});
afterEach(cleanup);

function open(overrides = {}) {
  const original = entry({ url: 'https://app.test/api/items?page=1&size=20', ...overrides });
  render(
    <RequestPlayground entry={original} settings={DEFAULT_SETTINGS} onClose={vi.fn()} onCompare={vi.fn()} />,
  );
  return original;
}

const urlInput = () => screen.getByLabelText('URL') as HTMLInputElement;

describe('RequestPlayground', () => {
  it('edits, disables, adds and removes query params, rebuilding the URL', () => {
    open();
    fireEvent.change(screen.getByLabelText('Param 1 value'), { target: { value: '3' } });
    expect(urlInput().value).toBe('https://app.test/api/items?page=3&size=20');

    fireEvent.click(screen.getByLabelText('Send size'));
    expect(urlInput().value).toBe('https://app.test/api/items?page=3');

    fireEvent.click(screen.getByText('+ Add param'));
    fireEvent.change(screen.getByLabelText('Param 3 key'), { target: { value: 'q' } });
    fireEvent.change(screen.getByLabelText('Param 3 value'), { target: { value: 'red shoes' } });
    expect(urlInput().value).toBe('https://app.test/api/items?page=3&q=red%20shoes');

    fireEvent.click(screen.getByLabelText('Remove page'));
    expect(urlInput().value).toBe('https://app.test/api/items?q=red%20shoes');
  });

  it('re-reads params from a typed URL and keeps disabled rows', () => {
    open();
    fireEvent.click(screen.getByLabelText('Send size'));
    fireEvent.change(urlInput(), { target: { value: 'https://app.test/api/items?page=9&sort=asc' } });
    expect((screen.getByLabelText('Param 2 key') as HTMLInputElement).value).toBe('sort');
    expect((screen.getByLabelText('Param 3 key') as HTMLInputElement).value).toBe('size');
    expect(urlInput().value).toBe('https://app.test/api/items?page=9&sort=asc');
  });

  it('sends GET variations and lists each response', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(executeReplay).toHaveBeenCalledTimes(1));
    expect(requestPermission).toHaveBeenCalledWith({ origins: ['https://app.test/*'] });

    fireEvent.change(screen.getByLabelText('Param 1 value'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(executeReplay).toHaveBeenCalledTimes(2));
    expect((executeReplay.mock.calls[1]![1] as ReplayDraft).url).toBe(
      'https://app.test/api/items?page=2&size=20',
    );
    await screen.findByText('#2');
    expect(screen.getByText('#1')).toBeTruthy();
  });

  it('requires consent before sending a POST, and keeps nothing sent when permission is denied', async () => {
    open({ method: 'GET' });
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'POST' } });
    fireEvent.click(screen.getByRole('tab', { name: /Body/ }));
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '{"name":"x"}' } });

    // JSON body without a Content-Type gets a one-click fix.
    fireEvent.click(screen.getByText('Add Content-Type: application/json'));
    fireEvent.click(screen.getByText('Format JSON'));
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe('{\n  "name": "x"\n}');

    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand this sends real POST requests/));
    expect(send.disabled).toBe(false);

    requestPermission.mockResolvedValueOnce(false);
    fireEvent.click(send);
    await screen.findByText(/Permission was not granted/);
    expect(executeReplay).not.toHaveBeenCalled();

    fireEvent.click(send);
    await waitFor(() => expect(executeReplay).toHaveBeenCalledTimes(1));
    const [, draft, assessment] = executeReplay.mock.calls[0]! as [
      unknown,
      ReplayDraft,
      { headersToSend: unknown },
    ];
    expect(draft.method).toBe('POST');
    expect(assessment.headersToSend).toEqual([{ name: 'Content-Type', value: 'application/json' }]);

    // Switching method asks for consent again.
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'DELETE' } });
    fireEvent.click(screen.getByText('Clear body'));
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('loads the captured request body', async () => {
    const original = open({ method: 'POST' });
    bodies.set(original.id, { id: original.id, request: { kind: 'json', text: '{"a":1}' } });
    cleanup();
    render(
      <RequestPlayground
        entry={original}
        settings={DEFAULT_SETTINGS}
        onClose={vi.fn()}
        onCompare={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Body/ }));
    await waitFor(() => expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toBe('{"a":1}'));
  });
});
