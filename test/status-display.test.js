import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, credentials } from './helpers.js';
import { StatusDisplay, replying } from '../src/status-display.js';
import { SessionBridge } from '../src/session-bridge.js';
import { historyCheckpoint } from '../src/cockpit.js';
import { validateConfig } from '../src/config.js';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function setup(t, options = {}) {
  const f = await fixture(t, { bridgeClass: SessionBridge, ...options });
  f.config.statusDisplay = { typing: true, tools: false, toolFormat: 'native' };
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

test('retired tool state remains inert and intact while typing and normal replies still work', async t => {
  const f = await setup(t, { status: 'running', messages: [{
    id: 'tool-body', role: 'assistant', content: 'Visible body',
    toolCalls: [{ toolCallId: 'root', name: 'bash', status: 'in_progress' }],
  }, {
    id: 'child', role: 'assistant', subtype: 'subagent', content: 'PRIVATE_CHILD',
    subagent: { toolCallId: 'task', status: 'running' },
  }] });
  const legacy = { version: 1, initialized: true, typingMayBeActive: true, tools: {
    native: { start: { status: 'sending', clientId: 'never-replay' } },
    text: { snapshot: { status: 'unknown', format: 'text' }, end: { status: 'pending' } },
  }, pausedContext: 'legacy-context', lastToolError: 'INTERRUPTED', observationCheckpoint: { id: 'old' } };
  f.store.set('statusDisplay', legacy);
  const diagnostic = `${f.config.stateDir}/last-progress-response.json`;
  fs.writeFileSync(diagnostic, '{"legacy":true}', { mode: 0o600 });
  const restarted = new StatusDisplay(f.config, f.store, f.weixin, f.cockpit, () => {});
  const before = f.requests.length;
  await restarted.tick(); await restarted.tick();
  assert.deepEqual(f.store.get('statusDisplay'), legacy);
  assert.equal(fs.readFileSync(diagnostic, 'utf8'), '{"legacy":true}');
  assert.equal(f.sent.length, 0);
  assert.ok(f.requests.slice(before).every(row => !row.url.includes('/session/chat')));
  assert.deepEqual(f.store.summary().statusDisplay, { typingMayBeActive: true });
  await f.bridge.step(); await f.drain();
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['Visible body']);
  assert.ok(!JSON.stringify(f.sent).includes('PRIVATE_CHILD'));
  assert.deepEqual(f.store.get('statusDisplay').tools, legacy.tools);
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

test('status display defaults preserve typing and legacy disabled native configuration', async t => {
  const f = await setup(t);
  assert.deepEqual(validateConfig(f.raw, f.configFile).statusDisplay, { typing: false, tools: false, toolFormat: 'native' });
  assert.deepEqual(validateConfig({ ...f.raw, deliveryMode: 'session' }, f.configFile).statusDisplay,
    { typing: true, tools: false, toolFormat: 'native' });
  assert.deepEqual(validateConfig({ ...f.raw, deliveryMode: 'session',
    statusDisplay: { typing: true, tools: false, toolFormat: 'native' } }, f.configFile).statusDisplay,
  { typing: true, tools: false, toolFormat: 'native' });
  for (const value of [true, { typing: 'yes' }, { extra: true }, { toolFormat: 'invalid' }]) {
    assert.throws(() => validateConfig({ ...f.raw, statusDisplay: value }, f.configFile), { code: 'INVALID_STATUS_DISPLAY' });
  }
  for (const value of [{ tools: true }, { tools: true, toolFormat: 'text' }, { tools: false, toolFormat: 'text' }]) {
    assert.throws(() => validateConfig({ ...f.raw, statusDisplay: value }, f.configFile), error => {
      assert.equal(error.code, 'TOOL_PROGRESS_RETIRED');
      assert.match(error.message, /native and text fallback.*retired/);
      assert.match(error.message, /tools:false.*typing remains supported/);
      return true;
    });
  }
});

test('empty octet-stream never confirms text or media sends', async t => {
  const f = await setup(t, { sendRaw: '', sendContentType: 'application/octet-stream' });
  for (const item of [{ type: 1, text_item: { text: 'test' } }, { type: 2, image_item: {} }]) {
    await assert.rejects(f.weixin.sendItems(credentials.peer, 'FAKE_CONTEXT', [item], 'test-id'),
      { code: 'INVALID_JSON_RESPONSE' });
  }
});

test('CLI rejects retired tool configuration with migration guidance before any network operation', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.configFile, JSON.stringify({ ...f.raw, statusDisplay: { tools: true } }), { mode: 0o600 });
  await assert.rejects(promisify(execFile)(process.execPath, ['src/cli.js', 'check', '--config', f.configFile]), error => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /TOOL_PROGRESS_RETIRED/);
    assert.match(error.stderr, /tools:false.*typing remains supported/);
    return true;
  });
  assert.equal(f.requests.length, 0);
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
