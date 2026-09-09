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
  const raw = ': ping\r\nretry: 2000\r\ndata: {"type":"msg/upsert",\r\ndata: "sessionId":"s","message":{"content":"你好"}}\r\n\r\n';
  for (const char of raw) parser.feed(char);
  assert.deepEqual(events, [{ type: 'msg/upsert', sessionId: 's', message: { content: '你好' } }]);
  parser.feed('data: {"type":"snapshot"}\n');
  assert.equal(events.length, 1);
  parser.feed('\n');
  assert.equal(events.length, 2);
  assert.throws(() => new EventDecoder(() => {}).feed('data: invalid\n\n'), { code: 'COCKPIT_SSE_INVALID_EVENT' });
  assert.throws(() => new EventDecoder(() => {}).feed('x'.repeat(4 * 1024 * 1024 + 1)),
    { code: 'COCKPIT_SSE_EVENT_TOO_LARGE' });
});

test('only bound session events or reconnect snapshots wake delivery', () => {
  assert.equal(eventAffectsSession({ type: 'msg/upsert', sessionId: 'other' }, 'bound'), false);
  assert.equal(eventAffectsSession({ type: 'msg/upsert', sessionId: 'bound' }, 'bound'), true);
  assert.equal(eventAffectsSession({ type: 'session/reset', page: { sessionId: 'bound' } }, 'bound'), true);
  assert.equal(eventAffectsSession({ type: 'session/reset', page: { sessionId: 'other' } }, 'bound'), false);
  assert.equal(eventAffectsSession({ type: 'snapshot' }, 'bound'), true);
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
  f.emit({ type: 'msg/upsert', sessionId: 'other', message: { content: 'FOREIGN' } });
  f.emit({ type: 'session/patch', sessionId: 'test-session', status: 'running' });
  await until(() => events.some(event => event.type === 'session/patch'));
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
  f.emit({ type: 'msg/upsert', sessionId: 'test-session', message: { id: 'A', content: 'INCOMPLETE_DRAFT' } });
  await delay(1200);
  assert.equal(f.sent.length, 0);
  f.state.messages.push({ id: 'A', role: 'assistant', content: 'Durable A', timestamp: 1 });
  const requestsBefore = f.requests.filter(request => request.url === '/intent/session/history').length;
  for (let i = 0; i < 40; i++) f.emit({ type: 'msg/upsert', sessionId: 'test-session',
    message: { id: 'A', content: 'Do not send SSE payload' } });
  await until(() => f.sent.length === 1, 2000);
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Durable A');
  assert.equal(f.state.queue.length, 1);
  assert.equal(f.state.status, 'running');
  assert.ok(f.requests.filter(request => request.url === '/intent/session/history').length - requestsBefore < 10);
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
});

test('trailing HTTP confirmation catches persistence arriving after the only SSE message', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge, eventsEnabled: true, status: 'running', nativeQueue: true });
  f.config.statusDisplay = { typing: false, tools: false };
  f.store.set('historyCheckpoint', deliveryCheckpoint());
  const controller = new AbortController();
  const running = f.bridge.run(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.prompts.length === 1 && f.streams.size === 1);
  await delay(1800);
  f.emit({ type: 'msg/upsert', sessionId: 'test-session', message: { id: 'A', content: 'A' } });
  await delay(750);
  assert.equal(f.sent.length, 0);
  f.state.messages.push({ id: 'A', role: 'assistant', content: 'Now persisted', timestamp: 1 });
  await until(() => f.sent.length === 1, 1500);
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

test('stalled event stream times out and releases its connection', async t => {
  const f = await fixture(t, { eventsEnabled: true });
  const controller = new AbortController();
  await assert.rejects(readEventStream(f.cockpit, () => {}, controller.signal, { idleTimeoutMs: 80 }),
    { code: 'COCKPIT_SSE_TIMEOUT' });
  await until(() => f.streams.size === 0);
});
