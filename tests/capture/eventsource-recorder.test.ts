import { afterEach, describe, expect, it } from 'vitest';
import { installEventSourceRecorder } from '../../src/capture/eventsource-recorder';
import type { PageMessage } from '../../src/shared/messages';
import type { RealtimeConnectionDraft, RealtimeMessageDraft } from '../../src/shared/types';
import { FakeEventSource } from '../helpers/fake-realtime';
import { makeContext } from '../helpers/recorder';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function setup() {
  const host = { EventSource: FakeEventSource as unknown as typeof EventSource };
  const rec = makeContext();
  const uninstall = installEventSourceRecorder(host, rec.ctx);
  cleanups.push(uninstall);
  const ES = host.EventSource as unknown as typeof FakeEventSource;
  const connections = () =>
    rec.messages
      .filter((m): m is Extract<PageMessage, { type: 'rt-connection' }> => m.type === 'rt-connection')
      .map((m) => m.connection as RealtimeConnectionDraft);
  const frames = () =>
    rec.messages
      .filter((m): m is Extract<PageMessage, { type: 'rt-message' }> => m.type === 'rt-message')
      .map((m) => m.message as RealtimeMessageDraft);
  return { host, ES, uninstall, connections, frames };
}

describe('EventSource recorder', () => {
  it('keeps identity and records unnamed message events with ids', () => {
    const { ES, connections, frames } = setup();
    const es = new ES('https://app.test/stream');
    expect(es).toBeInstanceOf(FakeEventSource);
    es.serverOpen();
    es.serverEvent('message', '{"n":1}', '41');
    expect(connections().at(-1)).toMatchObject({ transport: 'eventsource', state: 'open' });
    expect(frames().find((m) => m.direction === 'in')).toMatchObject({
      text: '{"n":1}',
      sse: { type: 'message', lastEventId: '41' },
    });
  });

  it('observes named events only for types the page subscribes to, without affecting its listener', () => {
    const { ES, frames } = setup();
    const es = new ES('https://app.test/stream');
    es.serverOpen();
    es.serverEvent('order.created', '{"id":1}');
    const pageSeen: string[] = [];
    es.addEventListener('order.created', (e) => pageSeen.push((e as MessageEvent).data));
    es.serverEvent('order.created', '{"id":2}');
    es.serverEvent('other', 'x');
    const named = frames().filter((m) => m.sse?.type === 'order.created');
    expect(named.map((m) => m.text)).toEqual(['{"id":2}']);
    expect(pageSeen).toEqual(['{"id":2}']);
    expect(frames().some((m) => m.sse?.type === 'other')).toBe(false);
  });

  it('distinguishes automatic reconnection from a permanent failure', () => {
    const { ES, connections, frames } = setup();
    const es = new ES('https://app.test/stream');
    es.serverOpen();
    es.serverDrop(true);
    expect(connections().at(-1)!.state).toBe('reconnecting');
    es.serverOpen();
    expect(
      frames()
        .filter((m) => m.lifecycle === 'open')
        .at(-1)!.note,
    ).toMatch(/Reconnected/);
    es.serverDrop(false);
    expect(connections().at(-1)!.state).toBe('closed');

    const bad = new ES('https://app.test/missing');
    bad.serverDrop(false);
    expect(connections().at(-1)).toMatchObject({ url: 'https://app.test/missing', state: 'failed' });
  });

  it('records close() by the page and restores the prototype on uninstall', () => {
    const { host, ES, connections, uninstall } = setup();
    const es = new ES('https://app.test/stream');
    es.serverOpen();
    es.close();
    expect(connections().at(-1)!.state).toBe('closed');
    uninstall();
    expect(host.EventSource).toBe(FakeEventSource);
    expect(Object.prototype.hasOwnProperty.call(FakeEventSource.prototype, 'addEventListener')).toBe(false);
  });
});
