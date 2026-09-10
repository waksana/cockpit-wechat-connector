import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventDecoder, eventAffectsSession, readEventStream, WorkSignal } from '../src/events.js';
import { SessionBridge } from '../src/session-bridge.js';
import { deliveryCheckpoint } from '../src/cockpit.js';
import { fixture } from './helpers.js';

async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true in time');
    await delay(10);
  }
}

test('SSE parser handles arbitrary chunk/CRLF boundaries, comments and multiline data', () => {
  const events = [];
  const parser = new EventDecoder(event => events.push(event));
  const raw = ': ping\r\nretry: 2000\r\ndata: {"type":"session/patch",\r\ndata: "sessionId":"s","patch":{"title":"你好"}}\r\n\r\n';
  for (const char of raw) parser.feed(char);
  assert.deepEqual(events, [{ type: 'session/patch', sessionId: 's', patch: { title: '你好' } }]);
  parser.feed('data: {"type":"snapshot"}\n');
  assert.equal(events.length, 1);
  parser.feed('\n');
  assert.equal(events.length, 2);
  assert.throws(() => new EventDecoder(() => {}).feed('data: invalid\n\n'), { code: 'COCKPIT_SSE_INVALID_EVENT' });
  assert.throws(() => new EventDecoder(() => {}).feed('x'.repeat(4 * 1024 * 1024 + 1)),
    { code: 'COCKPIT_SSE_EVENT_TOO_LARGE' });
});

test('only bound session events or reconnect snapshots wake delivery', () => {
  for (const type of ['session/invalidated', 'session/patch', 'session/notify', 'session/removed', 'chat/invalidated']) {
    assert.equal(eventAffectsSession({ type, sessionId: 'other' }, 'bound'), false);
    assert.equal(eventAffectsSession({ type, sessionId: 'bound' }, 'bound'), true);
  }
  assert.equal(eventAffectsSession({ type: 'session/added', session: { sessionId: 'bound' } }, 'bound'), true);
  assert.equal(eventAffectsSession({ type: 'session/added', session: { sessionId: 'other' } }, 'bound'), false);
  for (const type of ['msg/upsert', 'session/reset', 'session/history', 'assistant.message']) {
    assert.equal(eventAffectsSession({ type, sessionId: 'bound' }, 'bound'), false);
  }
  assert.equal(eventAffectsSession({ type: 'snapshot' }, 'bound'), true);
  assert.equal(eventAffectsSession({ type: 'agent/status' }, 'bound'), true);
});

test('work latch preserves notifications before wait, coalesces bursts and aborts cleanly', async () => {
  const signal = new AbortController();
  const work = new WorkSignal();
  for (let i = 0; i < 100; i++) work.notify();
  await work.wait(1000, signal.signal);
  assert.equal(work.pending, true);
  work.consume();
  const wait = work.wait(1000, signal.signal);
  work.notify();
  await wait;
  work.consume();
  const aborted = work.wait(1000, signal.signal);
  signal.abort();
  await assert.rejects(aborted);
  assert.equal(work.resolve, undefined);
});

test('event stream uses authenticated same-origin GET, refuses redirects and filters foreign sessions', async t => {
  const f = await fixture(t, { eventsEnabled: true });
  const controller = new AbortController();
  const events = [];
  const reading = readEventStream(f.cockpit, event => events.push(event), controller.signal);
  t.after(async () => { controller.abort(); await reading.catch(() => {}); });
  await until(() => f.streams.size === 1);
  f.emit({ type: 'session/invalidated', sessionId: 'other' });
  f.emit({ type: 'session/invalidated', sessionId: 'test-session' });
  await until(() => events.some(event => event.type === 'session/invalidated'));
  assert.ok(events.every(event => event.sessionId !== 'other'));
  assert.ok(!JSON.stringify(events).includes('FOREIGN'));
  const request = f.requests.find(request => request.url === '/events');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.authorization, 'Bearer FAKE_GATE_TOKEN');
  assert.equal(request.headers.accept, 'text/event-stream');
  controller.abort();
  await assert.rejects(reading, { code: 'STOPPED' });
  const fake = { ...f.cockpit, fetchImpl: async (_url, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://other.test/' } });
  } };
  await assert.rejects(readEventStream(fake, () => {}, new AbortController().signal), { code: 'COCKPIT_SSE_HTTP_302' });
});

test('real runner wakes on SSE but sends only durable A while B remains queued; burst and reconnect do not replay', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge, eventsEnabled: true, status: 'running', nativeQueue: true });
  f.config.statusDisplay = { typing: false, tools: false };
  f.config.limits.requestTimeoutMs = 2000;
  f.store.set('historyCheckpoint', deliveryCheckpoint());
  const controller = new AbortController();
  const running = f.bridge.run(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.prompts.length === 1 && f.streams.size === 1);
  f.emit({ type: 'session/invalidated', sessionId: 'test-session' });
  await delay(1200);
  assert.equal(f.sent.length, 0);
  f.state.messages.push({ id: 'A', role: 'assistant', content: 'Durable A', timestamp: 1 });
  const requestsBefore = f.requests.filter(request => request.url === '/intent/session/chat').length;
  for (let i = 0; i < 40; i++) f.emit({ type: 'session/invalidated', sessionId: 'test-session' });
  await until(() => f.sent.length === 1, 2000);
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Durable A');
  assert.equal(f.state.queue.length, 1);
  assert.equal(f.state.status, 'running');
  const nativeReads = f.requests.filter(request => request.url === '/intent/session/chat').length - requestsBefore;
  assert.ok(nativeReads > 0 && nativeReads < 10);
  await until(() => f.store.jobs().some(job => job.outputMessageId === 'A' && job.status === 'done'));
  for (const stream of f.streams) stream.end();
  f.state.messages.push({ id: 'B', role: 'assistant', content: 'Durable B during disconnect', timestamp: 2 });
  await until(() => f.sent.length === 2, 4500);
  assert.equal(f.sent[1].msg.item_list[0].text_item.text, 'Durable B during disconnect');
  assert.ok(f.logs.some(line => line.startsWith('COCKPIT_SSE_FALLBACK')));
  await until(() => f.logs.filter(line => line === 'COCKPIT_SSE_CONNECTED').length >= 2);
  await delay(700);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent.filter(row => row.msg.item_list[0].text_item.text === 'Durable A').length, 1);
  controller.abort(); await running;
});

test('trailing HTTP confirmation catches persistence arriving after the only metadata event', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge, eventsEnabled: true, status: 'running', nativeQueue: true });
  f.config.statusDisplay = { typing: false, tools: false };
  f.config.limits.requestTimeoutMs = 2000;
  f.config.limits.statusIntervalMs = 60000;
  f.store.set('historyCheckpoint', deliveryCheckpoint());
  const controller = new AbortController();
  const running = f.bridge.run(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.prompts.length === 1 && f.streams.size === 1);
  await delay(1800);
  f.emit({ type: 'session/invalidated', sessionId: 'test-session' });
  await delay(750);
  assert.equal(f.sent.length, 0);
  f.state.messages.push({ id: 'A', role: 'assistant', content: 'Now persisted', timestamp: 1 });
  await until(() => f.sent.length === 1, 1500);
  controller.abort(); await running;
});

test('durable native bodies arriving much later while busy are delivered without any SSE chat event', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge, eventsEnabled: true, status: 'running',
    nativeQueue: true, nativeEvents: [] });
  f.config.statusDisplay = { typing: false, tools: false };
  f.config.limits.requestTimeoutMs = 2000;
  f.store.set('historyCheckpoint', deliveryCheckpoint());
  const controller = new AbortController();
  const running = f.bridge.run(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.prompts.length === 1 && f.streams.size === 1);
  await delay(2200); // The initial snapshot's single trailing confirmation has finished.
  assert.equal(f.sent.length, 0);
  const before = f.requests.filter(row => row.url === '/intent/session/chat').length;
  f.state.nativeEvents.push({ id: 'event-A', type: 'assistant.message', data: { messageId: 'A', content: 'Durable A' } });
  await until(() => f.sent.length === 1, 2500);
  await delay(2200);
  f.state.nativeEvents.push({ id: 'event-B', type: 'assistant.message', data: { messageId: 'B', content: 'Later durable B' } });
  await until(() => f.sent.length === 2, 2500);
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['Durable A', 'Later durable B']);
  assert.equal(f.state.status, 'running');
  assert.equal(f.state.queue.length, 1);
  const reads = f.requests.filter(row => row.url === '/intent/session/chat');
  assert.ok(reads.length - before < 20, 'active reads remain bounded');
  assert.ok(reads.filter(row => row.data.direction === 'forward').every(row => row.data.max <= 64));
  assert.ok(f.requests.every(row => !row.url.includes('/session/history')));
  controller.abort(); await running;
});

test('idle fallback waits thirty seconds; local outbox drain never waits for another event', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge });
  const waits = [];
  f.bridge.work.wait = async ms => { waits.push(ms); };
  await f.bridge.waitForWork(new AbortController().signal);
  assert.deepEqual(waits, [30000]);
  f.bridge.deliveryMore = true;
  await f.bridge.waitForWork(new AbortController().signal);
  assert.deepEqual(waits, [30000]);
});

test('active native metadata selects bounded polling, independent of typing and local jobs', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge });
  const waits = [];
  f.bridge.work.wait = async ms => { waits.push(ms); };
  const signal = new AbortController().signal;
  for (const state of [{ status: 'running' }, { nativeProcessing: true }, { activeSubagents: 1 },
    { activeMcpOperations: 1 }, { queue: [{ id: 'queued' }] }]) {
    f.bridge.deliveryMeta = { loaded: true, ...state };
    await f.bridge.waitForWork(signal);
  }
  assert.deepEqual(waits, [1000, 1000, 1000, 1000, 1000]);
  f.config.limits.statusIntervalMs = 2500;
  await f.bridge.waitForWork(signal);
  assert.equal(waits.at(-1), 2500);
  f.bridge.deliveryMeta = { loaded: true, status: 'idle', nativeProcessing: false, queue: [] };
  await f.bridge.waitForWork(signal);
  assert.equal(waits.at(-1), 30000);
});

test('stalled event stream times out and releases its connection', async t => {
  const f = await fixture(t, { eventsEnabled: true });
  const controller = new AbortController();
  await assert.rejects(readEventStream(f.cockpit, () => {}, controller.signal, { idleTimeoutMs: 80 }),
    { code: 'COCKPIT_SSE_TIMEOUT' });
  await until(() => f.streams.size === 0);
});
