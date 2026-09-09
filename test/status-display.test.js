import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, credentials } from './helpers.js';
import { StatusDisplay, replying } from '../src/status-display.js';
import { SessionBridge } from '../src/session-bridge.js';
import { historyCheckpoint } from '../src/cockpit.js';
import { validateConfig } from '../src/config.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const toolMessage = (status, id = 'native-tool-1') => ({
  id: `message-${id}`, role: 'assistant', content: 'PRIVATE_COMMENTARY', timestamp: 1,
  thought: 'PRIVATE_THOUGHT',
  toolCalls: [{ toolCallId: id, name: 'bash', title: 'PRIVATE_USER_TEXT',
    args: 'PRIVATE_SECRET_ARGS', output: 'PRIVATE_TOOL_OUTPUT', status }],
});

async function setup(t, options = {}) {
  const f = await fixture(t, { bridgeClass: SessionBridge, ...options });
  f.config.statusDisplay = { typing: true, tools: true, toolFormat: 'native' };
  f.store.set('historyCheckpoint', historyCheckpoint());
  await f.bridge.receive();
  f.display = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, value => f.logs.push(value));
  return f;
}

test('typing follows native processing, not queue presence or a guessed busy status', () => {
  const idle = { loaded: true, status: 'running', nativeProcessing: false, queue: [{ id: 'q' }] };
  assert.equal(replying(idle), false);
  assert.equal(replying({ ...idle, nativeProcessing: true }), true);
  for (const flag of ['ask', 'planRequest', 'elicitation', 'cancelling', 'closing', 'compacting', 'loading', 'error']) {
    assert.equal(replying({ ...idle, nativeProcessing: true, [flag]: true }), false, flag);
  }
  assert.equal(replying({ ...idle, loaded: false, nativeProcessing: true }), false);
  assert.equal(replying({ ...idle, activeSubagents: 1 }), true);
});

test('typing ticket stays private, refresh is throttled and idle cancels without stopping Copilot', async t => {
  const f = await setup(t, { status: 'running', nativeProcessing: true });
  await f.display.tick(); await f.display.tick();
  assert.deepEqual(f.typing.map(row => row.status), [1]);
  assert.equal(f.requests.filter(row => row.url.endsWith('/getconfig')).length, 1);
  f.display.nextTypingAt = 0; await f.display.tick();
  assert.deepEqual(f.typing.map(row => row.status), [1, 1]);
  f.state.status = 'idle'; f.state.nativeProcessing = false;
  await f.display.tick(); await f.display.tick();
  assert.deepEqual(f.typing.map(row => row.status), [1, 1, 2]);
  assert.equal(f.store.get('statusDisplay').typingMayBeActive, false);
  assert.ok(!JSON.stringify(f.store.get('statusDisplay')).includes('FAKE_TYPING_TICKET'));
  assert.ok(!f.logs.join().includes('FAKE_TYPING_TICKET'));
  assert.ok(f.requests.every(row => !/cancel|interrupt|reload|seen/.test(row.url)));
});

test('empty ticket, explicit typing error and unknown JSON envelope never imply confirmed display', async t => {
  const f = await setup(t, { status: 'running', configResponse: {} });
  await f.display.tick();
  assert.equal(f.typing.length, 0);
  assert.ok(f.logs.includes('TYPING_UNAVAILABLE NO_TICKET'));
  for (const response of [{ ret: 5, errmsg: 'PRIVATE_ERROR' }, { success: true }, { errmsg: 'PRIVATE_ERROR' }]) {
    f.state.configResponse = { typing_ticket: 'FAKE_TICKET' }; f.state.typingResponse = response;
    f.display.refreshAt = 0; f.display.nextTypingAt = 0;
    await f.display.tick();
    assert.ok(!f.logs.includes('TYPING_STARTED'));
  }
  assert.ok(!f.logs.join().includes('PRIVATE_ERROR'));
  f.state.typingResponse = {};
  await f.display.cancelTyping();
});

test('restart can clear an interrupted typing display while idle', async t => {
  const f = await setup(t, { status: 'running' });
  await f.display.tick();
  f.state.status = 'idle'; f.state.nativeProcessing = false;
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, value => f.logs.push(value));
  await restarted.tick();
  assert.deepEqual(f.typing.map(row => row.status), [1, 2]);
});

test('failed cancellation retains cleanup intent, backs off and permits a bounded shutdown attempt', async t => {
  const f = await setup(t, { status: 'running' });
  await f.display.tick();
  f.state.status = 'idle'; f.state.nativeProcessing = false; f.state.typingFault = 'disconnect';
  await f.display.tick(); await f.display.tick();
  assert.deepEqual(f.typing.map(row => row.status), [1, 2]);
  assert.equal(f.display.typingAttempted, true);
  assert.equal(f.store.get('statusDisplay').typingMayBeActive, true);
  f.state.typingFault = null;
  await f.display.cancelTyping(undefined, true);
  assert.deepEqual(f.typing.map(row => row.status), [1, 2, 2]);
  assert.equal(f.store.get('statusDisplay').typingMayBeActive, false);
});

test('tool start/result use authoritative IDs and states, not titles, arguments or outputs', async t => {
  const f = await setup(t, { status: 'running', messages: [toolMessage('in_progress')] });
  await f.display.tick(); await f.display.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].msg.item_list[0].type, 11);
  const first = f.sent[0].msg.item_list[0].tool_call_start_item;
  assert.equal(first.tool_name, 'bash');
  f.state.messages[0].toolCalls[0].status = 'failed';
  await f.display.tick(); await f.display.tick();
  assert.equal(f.sent.length, 2);
  const last = f.sent[1].msg.item_list[0].tool_call_result_item;
  assert.deepEqual(last, { tool_name: 'bash', tool_call_id: first.tool_call_id, status: 'failed' });
  assert.equal(f.sent[0].msg.run_id, f.sent[1].msg.run_id);
  assert.notEqual(f.sent[0].msg.client_id, f.sent[1].msg.client_id);
  assert.ok(!JSON.stringify(f.sent).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(f.store.get('statusDisplay')).includes('PRIVATE_'));
  assert.ok(f.requests.every(row => !/prompt|respond|seen/.test(row.url)));
});

test('first activation skips completed historical tools; fast new tools emit completion without fabricated start', async t => {
  const f = await setup(t, { messages: [toolMessage('completed', 'old')] });
  await f.display.tick(); assert.equal(f.sent.length, 0);
  f.state.messages.push(toolMessage('completed', 'new'));
  await f.display.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].msg.item_list[0].type, 12);
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, () => {});
  await restarted.tick();
  assert.equal(f.sent.length, 1);
});

test('unknown progress is not replayed after restart and does not block a normal reply', async t => {
  const f = await setup(t, { status: 'running', messages: [toolMessage('in_progress')], sendFault: 'disconnect' });
  await f.display.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(Object.values(f.store.get('statusDisplay').tools)[0].start.status, 'unknown');
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, () => {});
  await restarted.tick(); assert.equal(f.sent.length, 1);
  assert.equal(f.store.jobs()[0].status, 'queued');
  f.state.sendFault = null; f.state.status = 'idle'; f.state.nativeProcessing = false;
  await f.bridge.step(); f.finish('Normal reply'); await f.drain();
  assert.ok(f.sent.some(row => row.msg.item_list[0].text_item?.text === 'Normal reply'));
});

test('interrupted progress send becomes unknown and is not replayed', async t => {
  const f = await setup(t, { status: 'running', messages: [toolMessage('in_progress')] });
  f.display.observeTools(f.state.messages, { loaded: true, nativeProcessing: true }, historyCheckpoint());
  const phase = Object.values(f.display.state.tools)[0].start;
  phase.status = 'sending';
  phase.contextHash = createHash('sha256').update('FAKE_CONTEXT').digest('hex'); f.display.save();
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, () => {});
  f.state.messages[0].toolCalls[0].status = 'completed';
  await restarted.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(restarted.state.pausedContext, phase.contextHash);
});

test('reply cursor advancement cannot hide tool completion or discard pending end events', async t => {
  const f = await setup(t, { status: 'running',
    messages: Array.from({ length: 6 }, (_, i) => toolMessage('in_progress', `batch-${i}`)) });
  await f.display.tick();
  assert.equal(f.sent.length, 5);
  for (const message of f.state.messages) message.toolCalls[0].status = 'completed';
  f.finish('Final answer');
  f.store.set('historyCheckpoint', historyCheckpoint(f.state.messages.at(-1)));
  await f.display.tick(); await f.display.tick(); await f.display.tick();
  assert.equal(f.sent.filter(row => row.msg.item_list[0].type === 12).length, 6);
  assert.equal(f.sent.length, 11);
});

test('delivery can advance repeatedly while a tool remains running without losing its later result', async t => {
  const f = await setup(t, { status: 'running', messages: [toolMessage('in_progress', 'late-tool')] });
  await f.display.tick();
  f.finish('Complete body before tool completion');
  f.state.status = 'running';
  f.store.set('historyCheckpoint', historyCheckpoint(f.state.messages.at(-1)));
  await f.display.tick(); await f.display.tick();
  f.finish('Another complete body');
  f.state.status = 'running';
  f.store.set('historyCheckpoint', historyCheckpoint(f.state.messages.at(-1)));
  await f.display.tick();
  f.state.messages[0].toolCalls[0].status = 'completed';
  await f.display.tick();
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].type), [11, 12]);
});

test('only bound root tool records are shown; no subagent transcript or unsafe tool names', async t => {
  const f = await setup(t, { status: 'running', messages: [
    { ...toolMessage('in_progress', 'sub'), subtype: 'subagent' },
    { ...toolMessage('in_progress', 'user'), role: 'user' }, toolMessage('in_progress', 'root'),
  ] });
  f.state.messages[2].toolCalls[0].name = 'PRIVATE SECRET STRING';
  await f.display.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].msg.to_user_id, credentials.peer);
  assert.equal(f.sent[0].msg.item_list[0].tool_call_start_item.tool_name, 'tool');
});

test('native subagent summary is shown as task progress without reading or forwarding its transcript', async t => {
  const message = { id: 'subagent-native-task', role: 'assistant', subtype: 'subagent', content: '',
    subagent: { toolCallId: 'native-task', status: 'running', displayName: 'PRIVATE_DISPLAY',
      description: 'PRIVATE_DESCRIPTION', prompt: 'PRIVATE_PROMPT' },
    subMessages: [toolMessage('in_progress', 'private-child')] };
  const f = await setup(t, { status: 'running', activeSubagents: 1, messages: [message] });
  await f.display.tick();
  assert.equal(f.sent[0].msg.item_list[0].tool_call_start_item.tool_name, 'task');
  message.subagent.status = 'completed';
  await f.display.tick();
  assert.equal(f.sent[1].msg.item_list[0].tool_call_result_item.status, 'completed');
  assert.equal(f.sent.length, 2);
  assert.ok(!JSON.stringify(f.sent).includes('PRIVATE'));
  assert.ok(!JSON.stringify(f.store.get('statusDisplay')).includes('PRIVATE'));
});

test('native closing/cancelling pauses ingress without dropping it or failing the connector', async t => {
  const f = await setup(t, { cancelling: true });
  await f.bridge.step();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.store.jobs()[0].status, 'queued');
  f.state.cancelling = false;
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
});

test('status display is mode-gated and invalid status options are rejected', async t => {
  const f = await setup(t);
  assert.deepEqual(validateConfig(f.raw, f.configFile).statusDisplay, { typing: false, tools: false, toolFormat: 'native' });
  assert.deepEqual(validateConfig({ ...f.raw, deliveryMode: 'session' }, f.configFile).statusDisplay,
    { typing: true, tools: false, toolFormat: 'native' });
  for (const value of [true, { typing: 'yes' }, { extra: true }, { toolFormat: 'invalid' }]) {
    assert.throws(() => validateConfig({ ...f.raw, statusDisplay: value }, f.configFile), { code: 'INVALID_STATUS_DISPLAY' });
  }
});

test('text compatibility batches current tool statuses without raw payloads or native control items', async t => {
  const f = await setup(t, { status: 'running', messages: [
    toolMessage('in_progress', 'one'), toolMessage('in_progress', 'two'),
  ] });
  f.config.statusDisplay.toolFormat = 'text';
  await f.display.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].msg.item_list[0].type, 1);
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, '[工具状态]\nbash：执行中\nbash：执行中');
  assert.equal(f.sent[0].msg.run_id, undefined);
  for (const message of f.state.messages) message.toolCalls[0].status = 'completed';
  await f.display.tick(); await f.display.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].msg.item_list[0].text_item.text, '[工具状态]\nbash：完成\nbash：完成');
  assert.ok(!JSON.stringify(f.sent).includes('PRIVATE_'));
});

test('native unknown remains unknown when switching to one fresh current-state text snapshot', async t => {
  const f = await setup(t, { status: 'running', messages: [toolMessage('in_progress')], sendFault: 'schema' });
  await f.display.tick(); assert.equal(f.sent.length, 1);
  f.config.statusDisplay.toolFormat = 'text'; f.state.sendFault = null;
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, () => {});
  await restarted.tick(); await restarted.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].msg.item_list[0].text_item.text, '[工具状态]\nbash：执行中');
  const record = Object.values(f.store.get('statusDisplay').tools)[0];
  assert.equal(record.start.status, 'unknown');
  assert.equal(record.snapshot.status, 'accepted');
  assert.notEqual(record.start.clientId, record.snapshot.clientId);
});

test('one reply UUID is shared by separate tool messages and final reply, not regenerated on observation', async t => {
  const f = await setup(t);
  await f.bridge.step();
  f.state.messages.push(toolMessage('in_progress', 'first'));
  await f.display.tick();
  f.state.messages.push(toolMessage('in_progress', 'second'));
  await f.display.tick();
  const runId = f.sent[0].msg.run_id;
  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const message of f.state.messages) {
    for (const tool of message.toolCalls ?? []) tool.status = 'completed';
  }
  f.finish('Shared reply'); await f.display.tick(); await f.drain();
  assert.ok(f.sent.every(row => row.msg.run_id === runId));
  assert.equal(f.sent.at(-1).msg.item_list[0].text_item.text, 'Shared reply');
  assert.equal(f.sent[0].msg.item_list[0].tool_call_start_item.tool_call_id, 'first');
});

test('progress diagnostics distinguish empty, literal and arbitrary non-JSON without exposing content', async t => {
  for (const raw of ['', 'OK', 'PRIVATE_TOKEN_OR_USER_TEXT']) {
    const f = await setup(t, { status: 'running', messages: [toolMessage('in_progress')], sendRaw: raw });
    await f.display.tick();
    const shape = JSON.parse(fs.readFileSync(`${f.config.stateDir}/last-progress-response.json`, 'utf8'));
    assert.equal(shape.bodyBytes, Buffer.byteLength(raw));
    assert.equal(shape.contentType, 'text/plain');
    assert.equal(shape.bodyType, raw ? 'invalid-json' : 'empty');
    assert.equal(shape.literal, raw === 'OK' ? 'OK' : undefined);
    assert.ok(!JSON.stringify(shape).includes('PRIVATE_'));
    assert.equal(Object.values(f.display.state.tools)[0].start.status, 'unknown');
  }
});

test('exact empty octet-stream control responses are submitted, not confirmed or retried, and permit later end events', async t => {
  const f = await setup(t, { status: 'running', messages: [toolMessage('in_progress')],
    sendRaw: '', sendContentType: 'application/octet-stream' });
  await f.display.tick(); await f.display.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(Object.values(f.display.state.tools)[0].start.status, 'submitted');
  f.state.messages[0].toolCalls[0].status = 'completed';
  await f.display.tick(); await f.display.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(Object.values(f.display.state.tools)[0].end.status, 'submitted');
  assert.equal(f.store.summary().statusDisplay.toolProgressAccepted, 0);
  assert.equal(f.store.summary().statusDisplay.toolProgressSubmitted, 2);
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, () => {});
  await restarted.tick(); assert.equal(f.sent.length, 2);
});

test('empty octet-stream never confirms text/media or text-fallback sends', async t => {
  const f = await setup(t, { sendRaw: '', sendContentType: 'application/octet-stream' });
  for (const item of [{ type: 1, text_item: { text: 'test' } }, { type: 2, image_item: {} }]) {
    await assert.rejects(f.weixin.sendItems(credentials.peer, 'FAKE_CONTEXT', [item], 'test-id', undefined,
      { progress: true }), { code: 'INVALID_JSON_RESPONSE' });
  }
  await assert.rejects(f.weixin.sendItems(credentials.peer, 'FAKE_CONTEXT', [{ type: 11 }], 'test-id'),
    { code: 'INVALID_JSON_RESPONSE' });
});

test('text progress respects the configured byte limit even for long tool names', async t => {
  const messages = Array.from({ length: 5 }, (_, i) => toolMessage('in_progress', `long-${i}`));
  for (const message of messages) message.toolCalls[0].name = 'a'.repeat(120);
  const f = await setup(t, { status: 'running', messages });
  f.config.statusDisplay.toolFormat = 'text'; f.config.limits.textBytes = 128;
  await f.display.tick();
  assert.equal(f.sent.length, 5);
  assert.ok(f.sent.every(row => Buffer.byteLength(row.msg.item_list[0].text_item.text) <= 128));
});

test('unknown text batch retains every phase and cannot resend after restart', async t => {
  const f = await setup(t, { status: 'running',
    messages: [toolMessage('in_progress', 'one'), toolMessage('in_progress', 'two')], sendFault: 'disconnect' });
  f.config.statusDisplay.toolFormat = 'text';
  await f.display.tick();
  assert.equal(f.sent.length, 1);
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, () => {});
  await restarted.tick();
  assert.equal(f.sent.length, 1);
  assert.ok(Object.values(restarted.state.tools).every(tool => tool.start.status === 'unknown'));
});

test('status observer shares the existing runner and cancels display on graceful stop', async t => {
  const f = await setup(t, { status: 'running', nativeQueue: true });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = f.bridge.run(controller.signal);
  const deadline = Date.now() + 3000;
  while (!f.typing.length && Date.now() < deadline) await delay(10);
  controller.abort(); await running;
  assert.deepEqual(f.typing.map(row => row.status), [1, 2]);
  assert.equal(f.state.status, 'running');
  assert.ok(f.requests.every(row => !/cancel|interrupt|reload|seen/.test(row.url)));
});
