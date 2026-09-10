import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBridge } from '../src/session-bridge.js';
import { historyCheckpoint } from '../src/cockpit.js';
import { resolveJob } from '../src/bridge.js';
import { Store } from '../src/storage.js';
import { validateConfig } from '../src/config.js';
import { fixture, incoming, credentials } from './helpers.js';

async function setup(t, options = {}) {
  const f = await fixture(t, { bridgeClass: SessionBridge, ...options });
  f.config.nativeInterruptFollowup = true;
  f.config.deliveryMode = 'session';
  f.config.limits.textBytes = 1800;
  f.store.set('historyCheckpoint', historyCheckpoint());
  f.interrupts = () => f.requests.filter(row => row.url === '/intent/session/interrupt');
  return f;
}

test('default remains enqueue and enabling requires session mode', async t => {
  const f = await setup(t);
  assert.equal(validateConfig(f.raw, f.configFile).nativeInterruptFollowup, false);
  assert.throws(() => validateConfig({ ...f.raw, nativeInterruptFollowup: true }, f.configFile),
    { code: 'INTERRUPT_REQUIRES_SESSION_MODE' });
  f.config.nativeInterruptFollowup = false;
  f.state.status = 'running';
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.interrupts().length, 0);
});

test('idle hands off immediately, without a silence timer or an interrupt', async t => {
  const f = await setup(t);
  assert.equal(Object.hasOwn(await f.cockpit.meta(), 'error'), false);
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.interrupts().length, 0);
});

test('fresh input into an unloaded target uses native enqueue without claiming an empty queue', async t => {
  const queue = [{ id: 'hidden-old-input', text: 'Existing native work' }];
  const f = await setup(t, { loaded: false, status: 'unloaded', queue });
  assert.equal((await f.cockpit.meta()).queue, undefined);
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, 'enqueue');
  assert.equal(f.interrupts().length, 0);
  assert.deepEqual(f.state.queue, queue);
  assert.equal(f.store.get('nativeFollowup'), null);
});

test('an acknowledged interrupt cannot hand off using unknown unloaded queue/error', async t => {
  const f = await setup(t, { status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.interrupts().length, 1);
  f.state.loaded = false; f.state.status = 'unloaded';
  await f.bridge.step(); await f.bridge.step();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.interrupts().length, 1);
  assert.equal(f.store.get('nativeFollowup').phase, 'draining');
  f.state.loaded = true; f.state.status = 'idle';
  assert.equal(Object.hasOwn(await f.cockpit.meta(), 'error'), false);
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.interrupts().length, 1);
});

test('loaded interrupt drain completes with absent error only after current controls are idle', async t => {
  const f = await setup(t, { status: 'running' });
  assert.equal(Object.hasOwn(await f.cockpit.meta(), 'error'), false);
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.interrupts().length, 1);
  assert.equal(f.prompts.length, 0);
  f.state.status = 'idle'; f.state.activeOperations = 1;
  await f.bridge.step();
  assert.equal(f.prompts.length, 0);
  f.state.activeOperations = 0;
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.store.get('nativeFollowup'), null);
  assert.equal(f.interrupts().length, 1);
});

test('interrupt before send; merge same-poll and during-drain text/quotes once in order', async t => {
  const f = await setup(t, { status: 'running', batch: [
    incoming({ message_id: 42, item_list: [{ type: 1, text_item: { text: 'B original' } }] }),
    incoming({ message_id: 43, item_list: [{ type: 1, text_item: { text: 'C original' },
      ref_msg: { title: 'quoted source', message_item: { type: 1, text_item: { text: 'quoted words' } } } }] }),
  ] });
  await f.bridge.receive();
  f.state.onInterrupt = async () => {
    assert.equal(f.store.get('nativeFollowup').phase, 'requesting');
    f.state.batch = [incoming({ message_id: 44, item_list: [{ type: 1, text_item: { text: 'D arrived during interrupt' } }] })];
    await f.bridge.receive();
    assert.equal(f.prompts.length, 0);
  };
  await f.bridge.step();
  assert.equal(f.prompts.length, 0, 'ACK never means ready to send');
  assert.equal(f.interrupts().length, 1);
  f.state.onInterrupt = undefined;
  f.state.status = 'idle';
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  const value = f.prompts[0].text;
  for (const phrase of ['B original', 'C original', 'quoted words', 'D arrived during interrupt']) assert.ok(value.includes(phrase));
  assert.ok(value.indexOf('B original') < value.indexOf('C original'));
  assert.ok(value.indexOf('C original') < value.indexOf('D arrived during interrupt'));
  const inputs = f.store.jobs().filter(job => job.kind === 'text');
  assert.equal(inputs.length, 3);
  assert.ok(inputs.every(job => job.status === 'done' && job.userMessageId === 'u1'));
  assert.equal(f.store.get('nativeFollowup'), null);
  await f.bridge.step();
  assert.equal(f.interrupts().length, 1, 'the already-submitted group never triggers a late interrupt');
});

test('drain old queued turns, preserve completed owner output while busy, and never clear queue', async t => {
  const f = await setup(t, { status: 'running', nativeQueue: true,
    queue: [{ id: 'owner-queue', text: 'Owner result 42' }] });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.state.queue.length, 1);
  f.state.messages.push({ id: 'owner-result', role: 'user', content: 'Owner result 42' });
  f.state.queue = [];
  f.state.messages.push({ id: 'complete-owner', role: 'assistant', content: 'Completed owner handoff' });
  await f.bridge.step();
  assert.equal(f.interrupts().length, 2, 'new queued turn is interrupted before fresh Weixin submission');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Completed owner handoff');
  assert.equal(f.prompts.length, 0);
  f.state.status = 'idle';
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.ok(!f.prompts[0].text.includes('Owner result 42'), 'prior history is not replayed');
  assert.ok(f.requests.every(row => !/cancel|clear|remove|abort|immediate/.test(row.url)));
});

test('busy native operations wait; background work is never cancelled and output is not idle-gated', async t => {
  const f = await setup(t, { status: 'running', activeOperations: 1 });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.interrupts().length, 0);
  f.state.activeOperations = 0;
  f.state.activeSubagents = 1;
  f.state.interrupted = false;
  f.state.messages.push({ id: 'a', role: 'assistant', content: 'Complete while background runs' });
  await f.bridge.step();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.interrupts().length, 1);
  f.state.activeSubagents = 0; f.state.status = 'idle';
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
});

test('duplicate poll, rejected input and old pending batch never start an interrupt', async t => {
  const f = await setup(t);
  await f.bridge.receive(); await f.bridge.step();
  f.state.batch = [incoming(), incoming({ message_id: 43, from_user_id: 'not-the-bound-peer' })];
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.interrupts().length, 0);
  assert.equal(f.prompts.length, 1);
  f.store.set('pendingBatch', { msgs: [incoming({ message_id: 44 })], get_updates_buf: 'saved-before-restart' });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.interrupts().length, 0);
  assert.equal(f.prompts.length, 2);
});

test('queued pre-restart inbox is not a new trigger', async t => {
  const f = await setup(t, { status: 'running' });
  await f.bridge.receive();
  const restarted = new SessionBridge(f.config, credentials, f.store, f.weixin, f.cockpit, { log() {} });
  await restarted.step();
  assert.equal(f.interrupts().length, 0);
  assert.equal(f.prompts.length, 1);
});

for (const fault of ['disconnect', 'schema', 'reject']) {
  test(`interrupt ${fault} is explicit and is never automatically retried`, async t => {
    const f = await setup(t, { status: 'running', interruptFault: fault });
    await f.bridge.receive();
    await assert.rejects(f.bridge.step(), { code: 'INTERRUPT_OUTCOME_UNKNOWN' });
    assert.equal(f.store.get('nativeFollowup').phase, 'blocked');
    f.store.recover();
    await assert.rejects(f.bridge.step(), { code: 'INTERRUPT_OUTCOME_UNKNOWN' });
    assert.equal(f.interrupts().length, 1);
    assert.equal(f.prompts.length, 0);
    assert.throws(() => resolveJob(f.store, f.store.jobs()[0].id, 'observe'), { code: 'OBSERVE_NOT_APPLICABLE' });
    resolveJob(f.store, f.store.jobs()[0].id, 'enqueue');
    f.state.interruptFault = undefined;
    await f.bridge.step();
    assert.equal(f.interrupts().length, 1);
    assert.equal(f.prompts.length, 1, 'explicit recovery submits the saved text without another interruption');
  });
}

test('restart during acknowledged drain blocks rather than cancelling subsequent turns', async t => {
  const f = await setup(t, { status: 'running' });
  await f.bridge.receive(); await f.bridge.step();
  f.closeStore();
  const store = new Store(f.config.stateDir);
  try {
    store.recover();
    const bridge = new SessionBridge(f.config, credentials, store, f.weixin, f.cockpit, { log() {} });
    await assert.rejects(bridge.step(), { code: 'INTERRUPT_RECOVERY_REQUIRED' });
    assert.equal(f.interrupts().length, 1);
    assert.equal(f.prompts.length, 0);
  } finally { store.close(); }
});

test('a merged prompt with unknown outcome is observed as one group, never replayed', async t => {
  const f = await setup(t, { promptFault: 'disconnect', batch: [incoming(), incoming({ message_id: 43 })] });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'PROMPT_OUTCOME_UNKNOWN' });
  const inputs = f.store.jobs();
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(job => job.status === 'blocked'));
  resolveJob(f.store, inputs[0].id, 'observe');
  await f.bridge.step();
  assert.ok(f.store.jobs().every(job => job.status === 'done' && job.userMessageId === 'u1'));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.interrupts().length, 0);
});

test('new arrivals after handoff start a new round; completed prior replies are retained', async t => {
  const f = await setup(t);
  await f.bridge.receive(); await f.bridge.step();
  f.state.batch = [incoming({ message_id: 43 })];
  await f.bridge.receive();
  f.state.messages.push({ id: 'completed-before-interrupt', role: 'assistant', content: 'Already complete' });
  await f.bridge.step();
  assert.equal(f.interrupts().length, 1);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, 'Already complete');
  f.state.status = 'idle';
  await f.bridge.step();
  assert.equal(f.prompts.length, 2);
  assert.ok(!f.prompts[1].text.includes(f.store.jobs()[0].marker), 'do not replay A');
});

test('crash with interrupt in flight requires explicit resolution, preserving every inbox item', async t => {
  const f = await setup(t, { status: 'running', batch: [incoming(), incoming({ message_id: 43 })] });
  await f.bridge.receive(); await f.bridge.step();
  const round = f.store.get('nativeFollowup');
  round.phase = 'requesting'; f.store.set('nativeFollowup', round);
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'INTERRUPT_OUTCOME_UNKNOWN' });
  resolveJob(f.store, round.leaderId, 'enqueue');
  await f.bridge.step(); await f.bridge.step();
  assert.equal(f.interrupts().length, 1);
  assert.equal(f.prompts.length, 2);
});

test('bounded drain timeout stops without silently losing input or cancelling background tasks', async t => {
  const f = await setup(t, { status: 'running', activeSubagents: 1, interrupted: false });
  await f.bridge.receive(); await f.bridge.step();
  const round = f.store.get('nativeFollowup');
  round.startedAt -= f.config.limits.resultTimeoutMs + 1;
  f.store.set('nativeFollowup', round);
  await assert.rejects(f.bridge.step(), { code: 'INTERRUPT_DRAIN_TIMEOUT' });
  assert.equal(f.state.activeSubagents, 1);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.interrupts().length, 1);
  assert.equal(f.store.jobs()[0].original, incoming().item_list[0].text_item.text);
});

test('preexisting pending media is not crossed while merging fresh text', async t => {
  const f = await setup(t, { batch: [
    incoming(), incoming({ message_id: 43, item_list: [{ type: 2, image_item: {} }] }),
    incoming({ message_id: 44 }),
  ] });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].text.split('connector metadata:').length, 2);
  const last = f.store.jobs().find(job => job.id.endsWith(':44'));
  assert.equal(last.status, 'queued');
});
