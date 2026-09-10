import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBridge } from '../src/session-bridge.js';
import { deliveryCheckpoint, historyCheckpoint } from '../src/cockpit.js';
import { createOutbox, resolveJob } from '../src/bridge.js';
import { Store } from '../src/storage.js';
import { fixture, incoming, credentials } from './helpers.js';
import { setTimeout as delay } from 'node:timers/promises';

async function setup(t, options = {}) {
  const f = await fixture(t, { bridgeClass: SessionBridge, ...options });
  f.config.limits.textBytes = 1800;
  f.store.set('historyCheckpoint', historyCheckpoint());
  f.settle = async (count = 25) => { for (let i = 0; i < count; i++) await f.bridge.step(); };
  return f;
}

test('A completes delivery while B remains in the native queue, including across restart', async t => {
  const f = await setup(t, { nativeQueue: true, status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  const first = f.state.queue.shift();
  f.state.messages.push({ id: 'native-A-user', role: 'user', content: first.text, timestamp: 1 });
  f.state.messages.push({ id: 'A', role: 'assistant', content: 'Completed A', timestamp: 2 });
  f.state.batch = [incoming({ message_id: 43 })];
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.state.queue.length, 1);
  assert.equal(f.state.status, 'running');
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Completed A');
  f.closeStore();
  const store = new Store(f.config.stateDir);
  try {
    store.recover();
    const bridge = new SessionBridge(f.config, credentials, store, f.weixin, f.cockpit, { log() {} });
    for (let i = 0; i < 3; i++) await bridge.step();
    assert.equal(store.jobs().find(job => job.outputMessageId === 'A').status, 'done');
    assert.equal(f.sent.length, 1);
    assert.equal(f.state.queue.length, 1);
    assert.equal(f.state.status, 'running');
  } finally { store.close(); }
});

test('continuous incoming requests and ongoing tool updates cannot starve completed output', async t => {
  const f = await setup(t, { nativeQueue: true, status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  const message = { id: 'A', role: 'assistant', content: 'Visible commentary',
    thought: 'private reasoning', toolCalls: [{ toolCallId: 'tc', status: 'running', args: 'private args' }], timestamp: 2 };
  f.state.messages.push(message);
  for (let i = 0; i < 8; i++) {
    f.state.batch = [incoming({ message_id: 50 + i })];
    await f.bridge.receive();
    message.toolCalls[0].status = i % 2 ? 'completed' : 'running';
    await f.bridge.step();
  }
  assert.equal(f.prompts.length, 9);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Visible commentary');
  assert.ok(!JSON.stringify(f.sent).includes('private'));
  assert.equal(f.store.get('historyCheckpoint').id, 'A');
  assert.equal(f.store.get('historyCheckpoint').version, 3);
  assert.equal(f.state.status, 'running');
});

test('legacy pending and completed records migrate without replaying accepted parts or skipped history', async t => {
  const f = await setup(t, { status: 'running' });
  const old = { id: 'old', role: 'assistant', content: 'Old never replayed', timestamp: 0 };
  f.state.messages.push(old);
  f.store.set('historyCheckpoint', historyCheckpoint(old));
  await f.bridge.receive(); await f.bridge.step();
  const baseline = f.store.get('historyCheckpoint');
  const message = { id: 'pending', role: 'assistant', content: 'Original frozen body', timestamp: 2 };
  f.state.messages.push(message);
  const job = {
    id: 'session-output:test-session:pending', kind: 'session-output', status: 'replying', marker: 'fixture',
    peer: credentials.peer, contextToken: 'FAKE_CONTEXT', receivedAt: 1, original: message.content,
    outputMessageId: message.id, outputBaseline: baseline, outputFingerprint: historyCheckpoint(message).fingerprint,
    outboxPurpose: 'final', outbox: createOutbox(message.content, f.config),
  };
  job.outbox[0].status = 'accepted';
  const clientId = job.outbox[0].clientId;
  f.store.ingest([job], null, 100);
  await f.bridge.step();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.job(job.id).status, 'done');
  assert.equal(f.store.job(job.id).outputVersion, 2);
  assert.ok(clientId);
  await f.settle(3);
  assert.equal(f.sent.length, 0);
});

async function foldedToolCheckpoint(t, { output = true } = {}) {
  const folded = { id: 'old-tool-body', role: 'assistant', content: 'Already delivered body',
    toolCalls: [{ toolCallId: 'bash-1', name: 'bash', title: 'Inspect files',
      args: '{"command":"ls"}', status: 'completed' }] };
  const f = await setup(t, { nativeEvents: [
    { id: 'old-native-event', type: 'assistant.message', data: {
      messageId: folded.id, content: folded.content,
      toolRequests: [{ toolCallId: 'bash-1', name: 'bash', arguments: { command: 'ls' } }],
    } },
    { id: 'tool-complete', type: 'tool.execution_complete', data: { toolCallId: 'bash-1', success: true } },
  ] });
  await f.bridge.receive();
  const context = f.store.jobs()[0];
  context.status = 'done'; f.store.save(context);
  const checkpoint = historyCheckpoint(folded);
  f.store.set('historyCheckpoint', checkpoint);
  const old = { id: `session-output:test-session:${folded.id}`, kind: 'session-output', status: 'done',
    marker: 'legacy-tool', peer: credentials.peer, contextToken: 'FAKE_CONTEXT', receivedAt: 1,
    original: folded.content, outputMessageId: folded.id, outputFingerprint: checkpoint.fingerprint,
    outputBaseline: historyCheckpoint(), outboxPurpose: 'final', outbox: createOutbox(folded.content, f.config) };
  delete old.outbox; // The legacy runner removed outbox only after every part was accepted.
  if (output) f.store.ingest([old], null, 100);
  return { ...f, folded, checkpoint, old };
}

test('real v1 folded-tool hash migrates using matching frozen output without replaying accepted outbox parts', async t => {
  const f = await foldedToolCheckpoint(t);
  const body = 'Later frozen response. '.repeat(20);
  f.config.limits.textBytes = 128;
  const pending = { ...f.old, id: 'session-output:test-session:pending', status: 'replying',
    outputMessageId: 'pending', original: body, outputBaseline: f.checkpoint,
    outputFingerprint: historyCheckpoint({ id: 'pending', role: 'assistant', content: body }).fingerprint,
    outbox: createOutbox(body, f.config) };
  pending.outbox[0].status = 'accepted';
  f.store.ingest([pending], null, 100);
  f.state.nativeEvents.push({ id: 'pending-event', type: 'assistant.message',
    data: { messageId: 'pending', content: body } });
  const page = await f.cockpit.page();
  assert.notEqual(historyCheckpoint(page.messages[0]).fingerprint, f.checkpoint.fingerprint);
  const before = f.requests.length;
  const window = await f.bridge.readWindow(f.checkpoint);
  assert.equal(window.checkpoint.version, 3);
  assert.equal(window.checkpoint.id, f.folded.id);
  assert.deepEqual(window.messages.map(message => message.id), ['pending']);
  const reads = f.requests.slice(before).filter(row => row.url === '/intent/session/chat');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].data.max, 256);
  assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint, 'read-only validation does not advance a cursor');
  await f.settle(15);
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), pending.outbox.slice(1).map(part => part.value));
  assert.deepEqual(f.sent.map(row => row.msg.client_id), pending.outbox.slice(1).map(part => part.clientId));
  assert.equal(f.store.job(pending.id).status, 'done');
  assert.deepEqual(f.store.job(f.old.id), f.old);
  assert.equal(f.store.get('historyCheckpoint').id, 'pending');
  assert.ok(f.store.get('historyCheckpoint').position);
  assert.equal(f.prompts.length, 0);
});

test('legacy folded-tool migration rejects actually changed body despite matching message and tool IDs', async t => {
  const f = await foldedToolCheckpoint(t);
  f.state.nativeEvents[0].data.content = 'Changed after the checkpoint';
  const jobs = f.store.jobs();
  await assert.rejects(f.bridge.step(), { code: 'CHECKPOINT_CHANGED' });
  assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
  assert.deepEqual(f.store.jobs(), jobs);
  assert.equal(f.sent.length, 0);
  assert.equal(f.prompts.length, 0);
});

test('legacy folded-tool checkpoint without frozen-body evidence requires an explicit review decision', async t => {
  const f = await foldedToolCheckpoint(t, { output: false });
  const jobs = f.store.jobs();
  await assert.rejects(f.bridge.step(), error => {
    assert.equal(error.code, 'LEGACY_CHECKPOINT_REVIEW_REQUIRED');
    assert.match(error.message, /explicit history-review decision/);
    return true;
  });
  await assert.rejects(f.cockpit.since(f.checkpoint), { code: 'LEGACY_CHECKPOINT_REVIEW_REQUIRED' });
  assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
  assert.deepEqual(f.store.jobs(), jobs);
  assert.equal(f.sent.length, 0);
});

test('runner validates legacy folded-tool checkpoint before starting queued input or output work', async t => {
  const f = await foldedToolCheckpoint(t, { output: false });
  f.state.batch = [incoming({ message_id: 43 })];
  await f.bridge.receive();
  const jobs = f.store.jobs();
  const before = f.requests.length;
  await assert.rejects(f.bridge.run(new AbortController().signal), { code: 'LEGACY_CHECKPOINT_REVIEW_REQUIRED' });
  assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
  assert.deepEqual(f.store.jobs(), jobs);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.sent.length, 0);
  assert.ok(f.requests.slice(before).every(row => row.url.startsWith('/capabilities')
    || ['/intent/session/get', '/intent/session/chat'].includes(row.url)));
});

test('legacy migration cannot use unrelated evidence or skip an unresolved source outbox', async t => {
  const f = await foldedToolCheckpoint(t);
  const mismatched = { ...f.old, outputFingerprint: 'different-snapshot' };
  f.store.save(mismatched);
  await assert.rejects(f.bridge.readWindow(f.checkpoint), { code: 'LEGACY_CHECKPOINT_REVIEW_REQUIRED' });
  const pending = { ...f.old, status: 'replying', outbox: createOutbox(f.old.original, f.config) };
  pending.outbox[0].status = 'unknown';
  f.store.save(pending);
  await assert.rejects(f.bridge.readWindow(f.checkpoint), { code: 'UNRESOLVED_OUTPUT_STATE' });
  assert.deepEqual(f.store.job(pending.id), pending);
  assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
  assert.equal(f.sent.length, 0);
});

async function coldCheckpoint(t, count) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `old-${i}`, role: 'assistant', content: `Already delivered ${i}`,
  }));
  const f = await setup(t, { loaded: false, status: 'unloaded', eventsEnabled: true, messages });
  await f.bridge.receive();
  const context = f.store.jobs()[0];
  context.status = 'done'; f.store.save(context);
  const source = messages.at(-1);
  const checkpoint = deliveryCheckpoint(source);
  f.store.set('historyCheckpoint', checkpoint);
  const old = { id: `session-output:test-session:${source.id}`, kind: 'session-output', status: 'done',
    marker: 'completed-before-restart', peer: credentials.peer, contextToken: 'FAKE_CONTEXT', receivedAt: 1,
    original: source.content, outputMessageId: source.id, outputVersion: 3,
    outputFingerprint: checkpoint.fingerprint, outputBaseline: deliveryCheckpoint(messages.at(-2)),
    outboxPurpose: 'final' };
  f.store.ingest([old], null, 100);
  return { ...f, checkpoint, old };
}

for (const count of [2, 300]) {
  test(`cold v3 checkpoint with ${count} historical events and no new body remains usable without a native tail`, async t => {
    const f = await coldCheckpoint(t, count);
    const before = f.requests.length;
    await f.bridge.establishCheckpoint();
    await f.settle(3);
    assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
    assert.deepEqual(f.store.job(f.old.id), f.old);
    assert.equal(f.state.loaded, false);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.sent.length, 0);
    const reads = f.requests.slice(before).filter(row => row.url === '/intent/session/chat');
    assert.equal(reads.length, 4);
    assert.ok(reads.every(row => row.data.source === 'persisted' && row.data.direction === 'backward'
      && row.data.max === 256 && row.data.bootstrap === false && row.data.cursor === undefined));
    assert.ok(f.requests.slice(before).every(row => ['/intent/session/get', '/intent/session/chat'].includes(row.url)));
  });
}

for (const version of [2, 3]) {
  for (const change of ['body', 'outside-window']) {
    test(`runner validates cold v${version} ${change} checkpoint before submitting queued input`, async t => {
      const f = await coldCheckpoint(t, 300);
      const checkpoint = deliveryCheckpoint(f.state.messages.at(-1), version);
      f.store.set('historyCheckpoint', checkpoint);
      if (change === 'body') f.state.messages.at(-1).content = 'Changed checkpoint body';
      else f.state.messages.push(...Array.from({ length: 300 }, (_, index) => ({
        id: `later-${index}`, role: 'assistant', content: `Later message ${index}`,
      })));
      f.state.batch = [incoming({ message_id: 44 })];
      await f.bridge.receive();
      const jobs = f.store.jobs();
      await assert.rejects(f.bridge.run(new AbortController().signal), {
        code: change === 'body' ? 'CHECKPOINT_CHANGED' : 'CHECKPOINT_MIGRATION_REQUIRED',
      });
      assert.deepEqual(f.store.get('historyCheckpoint'), checkpoint);
      assert.deepEqual(f.store.jobs(), jobs);
      assert.equal(f.prompts.length, 0);
      assert.equal(f.sent.length, 0);
      assert.equal(f.state.loaded, false);
    });
  }
}

test('cold passive migration delivers unseen bodies in order without replay or a fabricated forward cursor', async t => {
  const f = await coldCheckpoint(t, 300);
  f.state.messages.push({ id: 'cold-A', role: 'assistant', content: 'Unseen A' },
    { id: 'cold-B', role: 'assistant', content: 'Unseen B' });
  await f.settle(8);
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['Unseen A', 'Unseen B']);
  assert.equal(f.store.get('historyCheckpoint').id, 'cold-B');
  assert.equal(f.store.get('historyCheckpoint').position, undefined);
  assert.deepEqual(f.store.job(f.old.id), f.old);
  assert.equal(f.state.loaded, false);
  assert.equal(f.prompts.length, 0);
  assert.ok(f.requests.filter(row => row.url === '/intent/session/chat')
    .every(row => row.data.source === 'persisted' && row.data.direction === 'backward' && row.data.max === 256));
  f.state.messages.at(-1).content = 'Changed cold checkpoint body';
  await assert.rejects(f.bridge.step(), { code: 'CHECKPOINT_CHANGED' });
  assert.equal(f.sent.length, 2);
});

test('cold runner keeps its v3 checkpoint until legitimate fresh input supplies a live forward tail', async t => {
  const f = await coldCheckpoint(t, 300);
  f.config.limits.requestTimeoutMs = 2000;
  const controller = new AbortController();
  const running = f.bridge.run(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'cold runner did not make bounded progress');
      await delay(10);
    }
  };
  await until(() => f.requests.some(row => row.url === '/intent/session/chat'));
  await delay(150);
  assert.equal(f.state.loaded, false);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
  f.state.batch = [incoming({ message_id: 43 })];
  await until(() => f.prompts.length === 1 && Boolean(f.store.get('historyCheckpoint').position));
  assert.equal(f.prompts[0].mode, 'enqueue');
  assert.equal(f.state.loaded, true);
  assert.equal(f.store.get('historyCheckpoint').position.source, 'live');
  f.finish('Fresh response after cold resume');
  await until(() => f.sent.length === 1);
  controller.abort(); await running;
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Fresh response after cold resume');
  assert.deepEqual(f.store.job(f.old.id), f.old);
  assert.ok(f.requests.filter(row => row.url === '/intent/session/chat' && row.data.source === 'persisted')
    .every(row => row.data.direction === 'backward' && row.data.bootstrap === false));
  assert.ok(f.requests.every(row => !/reload|resume|interrupt|cancel|trust/.test(row.url)));
});

test('bounded forward pages skip empty tool messages and preserve output order during native processing', async t => {
  const f = await setup(t, { nativeQueue: true, status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  const initialRequests = f.requests.length;
  f.state.messages.push({ id: 'A', role: 'assistant', content: 'A', timestamp: 1 });
  for (let i = 0; i < 205; i++) f.state.messages.push({ id: `tool-${i}`, role: 'assistant', content: '',
    toolCalls: [{ toolCallId: `t-${i}`, status: 'running' }], timestamp: 2 });
  f.state.messages.push({ id: 'B', role: 'assistant', content: 'B', timestamp: 3 });
  await f.bridge.step();
  f.state.messages.push({ id: 'C', role: 'assistant', content: 'C', timestamp: 4 });
  await f.settle(15);
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['A', 'B', 'C']);
  assert.equal(f.state.status, 'running');
  assert.equal(f.store.get('historyCheckpoint').id, 'C');
  const reads = f.requests.slice(initialRequests).filter(row => row.url === '/intent/session/chat');
  assert.ok(reads.length > 0);
  assert.ok(reads.every(row => row.data.direction === 'forward' && row.data.max <= 64));
});

test('passive events without a visible message advance the native cursor without losing user ownership', async t => {
  const f = await setup(t);
  await f.bridge.receive(); await f.bridge.step();
  const before = f.store.get('historyCheckpoint');
  assert.ok(before.position);
  f.state.loaded = false;
  f.state.nativeEvents = [{ id: 'shutdown', type: 'session.shutdown', data: {} }];
  await f.bridge.step();
  const after = f.store.get('historyCheckpoint');
  assert.notEqual(after.position.cursor, before.position.cursor);
  assert.equal(after.id, before.id);
  assert.equal(after.userMessageId, before.userMessageId);
  f.finish('Later durable reply');
  await f.settle(6);
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Later durable reply');
  assert.ok(f.store.get('historyCheckpoint').position);
});

test('existing outbox sends while busy but checks attachment identity and never reads private paths', async t => {
  const f = await setup(t, { status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  const message = { id: 'file', role: 'assistant', content: '',
    attachment: { kind: 'file', name: 'Report', url: '/uploads/report.pdf', size: 8 }, timestamp: 2 };
  f.state.messages.push(message);
  await f.bridge.step();
  await f.bridge.step();
  assert.equal(f.sent[0].msg.item_list[0].type, 4);
  assert.equal(f.sent[0].msg.item_list[0].file_item.file_name, 'report.pdf');
  message.attachment.url = '/uploads/different.pdf';
  await assert.rejects(f.bridge.step(), { code: 'FINAL_EVIDENCE_CHANGED' });
  assert.equal(f.sent.length, 1);
});

test('pending outbox source removed by rewind cannot be sent', async t => {
  const f = await setup(t, { status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  const checkpoint = f.store.get('historyCheckpoint');
  const message = { id: 'removed', role: 'assistant', content: 'Not sent', timestamp: 2 };
  f.bridge.queueOutput('session-output:test-session:removed', message.content, f.store.jobs()[0], message, checkpoint);
  await assert.rejects(f.bridge.step(), { code: 'FINAL_EVIDENCE_CHANGED' });
  assert.equal(f.sent.length, 0);
});

test('delivery identity ignores thought/tool lifecycle but includes attachment and正文', () => {
  const message = { id: 'a', role: 'assistant', content: 'body' };
  assert.deepEqual(deliveryCheckpoint(message), deliveryCheckpoint({ ...message, thought: 'private',
    toolCalls: [{ status: 'running' }] }));
  assert.notEqual(deliveryCheckpoint(message).fingerprint, deliveryCheckpoint({ ...message, content: 'changed' }).fingerprint);
  assert.notEqual(deliveryCheckpoint(message).fingerprint,
    deliveryCheckpoint({ ...message, attachment: { kind: 'image', name: 'x', url: '/uploads/x.png' } }).fingerprint);
});

test('busy target receives all inputs in native enqueue; unrelated writers do not stop session mirror', async t => {
  const f = await setup(t, { nativeQueue: true, status: 'running',
    batch: [incoming(), incoming({ message_id: 43 })],
    messages: [{ id: 'web-user', role: 'user', content: 'Same user on Web', timestamp: 1 }] });
  await f.bridge.receive();
  await f.bridge.step(); await f.bridge.step();
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts.every(prompt => prompt.mode === 'enqueue'));
  assert.equal(f.state.queue.length, 2);
  assert.equal(f.sent.length, 0);
  f.finish('Web reply');
  for (const [index, queued] of f.state.queue.entries()) {
    f.state.messages.push({ id: `native-${index}`, role: 'user', content: queued.text, timestamp: 21 + index });
    f.finish(`Weixin reply ${index}`);
  }
  f.state.queue = [];
  await f.settle();
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text),
    ['Web reply', 'Weixin reply 0', 'Weixin reply 1']);
  assert.ok(f.store.jobs().every(job => job.status === 'done'));
  assert.equal(f.store.get('historyCheckpoint').id, f.state.messages.at(-1).id);
  await f.settle();
  assert.equal(f.sent.length, 3);
  assert.ok(f.requests.every(row => !/cancel|interrupt|new|reload/.test(row.url)));
});

test('unloaded target resumes; native input receipt does not fabricate a completed reply', async t => {
  const f = await setup(t, { status: 'unloaded', loaded: false, earlyIdle: true });
  await f.bridge.receive(); await f.bridge.step(); await f.settle(3);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.equal(f.store.jobs()[0].userMessageId, 'u1');
  assert.equal(f.sent.length, 0);
  f.finish('Recovered'); await f.settle();
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.equal(f.sent.length, 1);
});

test('unloaded unknown native state neither blocks an accepted input as idle nor suppresses durable body delivery', async t => {
  const f = await setup(t, { loaded: false, status: 'unloaded',
    messages: [{ id: 'persisted-body', role: 'assistant', content: 'Durable message while unloaded' }] });
  await f.bridge.receive();
  const input = f.store.jobs()[0];
  input.status = 'accepted'; input.prompt = 'Accepted input not yet observed';
  input.startedAt = Date.now() - f.config.limits.resultTimeoutMs - 1000;
  f.store.save(input);
  await f.settle(3);
  assert.equal(f.store.job(input.id).status, 'accepted');
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['Durable message while unloaded']);
  assert.equal(f.prompts.length, 0);
});

test('shared native delivery handles durable session errors without a loaded metadata error field', async t => {
  const f = await setup(t);
  await f.bridge.receive(); await f.bridge.step();
  f.state.status = 'idle';
  assert.equal(Object.hasOwn(await f.cockpit.meta(), 'error'), false);
  f.state.nativeEvents = [{ id: 'native-error', type: 'session.error', data: { message: 'PRIVATE_NATIVE_ERROR' } },
    { id: 'native-recovery', type: 'assistant.message', data: { messageId: 'recovery', content: 'Recovered body' } }];
  await f.settle(8);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].msg.item_list[0].text_item.text, /报告运行错误/);
  assert.equal(f.sent[1].msg.item_list[0].text_item.text, 'Recovered body');
  assert.ok(!JSON.stringify(f.sent).includes('PRIVATE_NATIVE_ERROR'));
  assert.equal(f.store.job('session-error:test-session:native-error').status, 'done');
  await f.settle(3);
  assert.equal(f.sent.length, 2);
  assert.ok(f.requests.filter(row => row.url === '/intent/session/chat' && row.data.source === 'live')
    .every(row => row.data.types.includes('session.error')));
});

test('new output after completed input is mirrored without forwarding thoughts, tools or old history', async t => {
  const f = await setup(t);
  f.state.messages.push({ id: 'old', role: 'assistant', content: 'Not replayed', timestamp: 0 });
  f.store.set('historyCheckpoint', historyCheckpoint(f.state.messages[0]));
  await f.bridge.receive(); await f.bridge.step(); f.finish('First'); await f.settle();
  f.state.messages.push({ id: 'owner', role: 'user', content: 'Owner task result', timestamp: 30 });
  f.finish('Tool commentary', { toolCalls: [{ status: 'completed', args: 'Private' }] });
  f.finish('Subagent', { subtype: 'subagent' });
  f.finish('Discussion answer', { thought: 'Private reasoning' });
  await f.settle();
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['First', 'Tool commentary', 'Discussion answer']);
  assert.ok(!JSON.stringify(f.sent).includes('Private'));
  assert.equal(f.prompts.length, 1);
});

for (const kind of ['ask', 'planRequest', 'elicitation', 'error']) {
  test(`${kind} emits one Web notice without answering on behalf of user`, async t => {
    const f = await setup(t);
    await f.bridge.receive(); await f.bridge.step();
    if (kind === 'error') { f.state.error = 'Do not forward error text'; f.state.status = 'error'; }
    else f.state[kind] = { requestId: 'choice-1' };
    await f.settle();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].msg.item_list[0].text_item.text, /https:\/\/cockpit.example.test\/session\/test-session/);
    assert.ok(!JSON.stringify(f.sent).includes('Do not forward'));
    assert.ok(f.requests.every(row => !row.url.includes('respond')));
  });
}

test('unknown output stops all retries; confirmed sent resumes without resending', async t => {
  const f = await setup(t, { sendFault: 'disconnect' });
  await f.bridge.receive(); await f.bridge.step(); f.finish('One output');
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 1);
  const output = f.store.jobs().find(job => job.kind === 'session-output');
  resolveJob(f.store, output.id, 'sent');
  await f.settle();
  assert.equal(f.sent.length, 1);
  assert.ok(f.store.jobs().every(job => job.status === 'done'));
});

test('unknown prompt never automatically re-enqueues', async t => {
  const f = await setup(t, { promptFault: 'disconnect' });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'PROMPT_OUTCOME_UNKNOWN' });
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'PROMPT_OUTCOME_UNKNOWN' });
  assert.equal(f.prompts.length, 1);
});

test('restart after accepted output preserves dedup and advances shared cursor only when drained', async t => {
  const f = await setup(t);
  await f.bridge.receive(); await f.bridge.step(); f.finish('Persisted output');
  await f.bridge.step(); await f.bridge.step(); await f.bridge.step();
  assert.equal(f.sent.length, 1);
  f.closeStore();
  const store = new Store(f.config.stateDir);
  try {
    const bridge = new SessionBridge(f.config, credentials, store, f.weixin, f.cockpit, { log() {} });
    bridge.bind(); store.recover();
    for (let i = 0; i < 10; i++) await bridge.step();
    assert.equal(f.sent.length, 1);
    assert.ok(store.jobs().every(job => job.status === 'done'));
  } finally { store.close(); }
});

test('complete output sends while busy; changed frozen source cannot be silently accepted', async t => {
  const f = await setup(t);
  await f.bridge.receive(); await f.bridge.step(); f.finish('Original');
  f.state.status = 'running';
  await f.bridge.step(); assert.equal(f.sent.length, 1);
  f.state.messages.at(-1).content = 'Changed';
  await assert.rejects(f.bridge.step(), { code: 'FINAL_EVIDENCE_CHANGED' });
  assert.equal(f.sent.length, 1);
});

test('timeout retains unresolved marker for observe recovery without re-enqueue', async t => {
  const f = await setup(t, { earlyIdle: true, noMarker: true });
  await f.bridge.receive(); await f.bridge.step();
  const job = f.store.jobs()[0];
  job.startedAt = Date.now() - f.config.limits.resultTimeoutMs - 1;
  f.store.save(job);
  await f.bridge.step();
  assert.equal(f.store.get('historyCheckpoint').id, null);
  assert.equal(f.store.job(job.id).reason, 'PROMPT_NOT_OBSERVED');
  resolveJob(f.store, job.id, 'observe');
  f.state.messages.push({ id: 'late-user', role: 'user', content: job.prompt, timestamp: 10 });
  f.finish('Late answer');
  await f.settle();
  assert.equal(f.store.job(job.id).status, 'done');
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent.length, 1);
});

for (const kind of ['ask', 'planRequest', 'elicitation', 'error']) {
  test(`complete session output and ${kind}/unsupported notices all deliver without idle`, async t => {
    const f = await setup(t);
    await f.bridge.receive(); await f.bridge.step(); f.finish('Pending answer');
    await f.bridge.step(); await f.bridge.step();
    f.state.status = kind === 'error' ? 'error' : 'running';
    if (kind === 'error') f.state.error = 'Do not forward details';
    else f.state[kind] = { requestId: `later-${kind}` };
    f.state.batch = [incoming({ message_id: 43, item_list: [{ type: 3, voice_item: {} }] })];
    await f.bridge.receive(); await f.settle();
    assert.equal(f.sent.length, 3);
    assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Pending answer');
    assert.match(f.sent[1].msg.item_list[0].text_item.text, /不支持的项目/);
    assert.match(f.sent[2].msg.item_list[0].text_item.text, /https:\/\/cockpit.example.test/);
    assert.equal(f.store.jobs().find(job => job.kind === 'session-output').status, 'done');
    f.state.status = 'idle'; f.state.error = null;
    if (kind !== 'error') f.state[kind] = null;
    await f.settle();
    assert.equal(f.sent.length, 3);
  });
}
