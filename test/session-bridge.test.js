import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBridge } from '../src/session-bridge.js';
import { deliveryCheckpoint, historyCheckpoint } from '../src/cockpit.js';
import { createOutbox, resolveJob } from '../src/bridge.js';
import { Store } from '../src/storage.js';
import { fixture, incoming, credentials } from './helpers.js';

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

test('late append and backward pagination preserve complete-message order during native processing', async t => {
  const f = await setup(t, { nativeQueue: true, status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  f.state.messages.push({ id: 'A', role: 'assistant', content: 'A', timestamp: 1 });
  for (let i = 0; i < 205; i++) f.state.messages.push({ id: `tool-${i}`, role: 'assistant', content: '',
    toolCalls: [{ toolCallId: `t-${i}`, status: 'running' }], timestamp: 2 });
  f.state.messages.push({ id: 'B', role: 'assistant', content: 'B', timestamp: 3 });
  await f.bridge.step();
  f.state.messages.push({ id: 'C', role: 'assistant', content: 'C', timestamp: 4 });
  await f.settle(8);
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['A', 'B', 'C']);
  assert.equal(f.state.status, 'running');
  assert.equal(f.store.get('historyCheckpoint').id, 'C');
  assert.ok(f.requests.some(row => row.url === '/intent/session/history' && row.data.beforeMsgId));
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
