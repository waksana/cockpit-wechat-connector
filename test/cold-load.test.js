import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge, resolveJob } from '../src/bridge.js';
import { SessionBridge } from '../src/session-bridge.js';
import { Store } from '../src/storage.js';
import { credentials, fixture, incoming } from './helpers.js';

const loads = f => f.requests.filter(row => row.url === '/intent/session/load');
const reads = rows => rows.filter(row => row.url === '/intent/session/chat');

async function cold(t, BridgeClass, options = {}) {
  const f = await fixture(t, { bridgeClass: BridgeClass, ...options });
  f.config.limits.textBytes = 1800;
  f.state.messages.push({ id: 'old-user', role: 'user', content: 'Already persisted input' });
  await f.bridge.establishCheckpoint();
  f.checkpoint = f.store.get('historyCheckpoint');
  f.state.loaded = false; f.state.status = 'unloaded';
  return f;
}

for (const BridgeClass of [Bridge, SessionBridge]) {
  const mode = BridgeClass.name;
  test(`${mode}: one queued input restores the original target and validates its original cursor before one prompt`, async t => {
    const f = await cold(t, BridgeClass);
    await f.bridge.receive();
    const originalJob = f.store.jobs()[0].id, start = f.requests.length;
    await f.bridge.step();
    assert.deepEqual(loads(f).map(row => row.data), [{ sessionId: 'test-session' }]);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0].sessionId, 'test-session');
    assert.equal(f.prompts[0].mode, 'enqueue');
    assert.equal(f.store.job(originalJob).targetLoad.phase, 'confirmed');
    const calls = f.requests.slice(start), prompt = calls.findIndex(row => row.url === '/intent/prompt');
    const prior = reads(calls.slice(0, prompt));
    assert.ok(prior.length > 0);
    assert.equal(prior[0].data.cursor, f.checkpoint.position.cursor);
    assert.ok(prior.every(row => row.data.source === 'live' && row.data.direction === 'forward' && !row.data.bootstrap));
    f.finish('Reply after original cold restore');
    await f.drain(12);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.sent.length, 1);
    assert.equal(loads(f).length, 1);
    assert.equal(f.store.job(originalJob).status, 'done');
    assert.ok(f.requests.every(row => !/reload|session\/new|session\/start|interrupt/.test(row.url)));
  });

  test(`${mode}: an expired original cursor after load blocks before prompting without bootstrap or rescan`, async t => {
    const f = await cold(t, BridgeClass, { expireCursorsOnLoad: true });
    await f.bridge.receive();
    const start = f.requests.length;
    await assert.rejects(f.bridge.step(), { code: 'NATIVE_CURSOR_EXPIRED' });
    await assert.rejects(f.bridge.step(), { code: 'NATIVE_CURSOR_EXPIRED' });
    assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
    assert.equal(f.store.jobs()[0].status, 'blocked');
    assert.equal(f.prompts.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(loads(f).length, 1);
    const attempts = reads(f.requests.slice(start));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].data.cursor, f.checkpoint.position.cursor);
    assert.equal(attempts[0].data.source, 'live');
    assert.equal(attempts[0].data.direction, 'forward');
    assert.equal(attempts[0].data.bootstrap, false);
  });

  for (const loadFault of ['disconnect', 'schema', 'reject']) {
    test(`${mode}: ${loadFault} load outcome is durable and never automatically retried`, async t => {
      const f = await cold(t, BridgeClass, { loadFault });
      await f.bridge.receive();
      await assert.rejects(f.bridge.step(), { code: 'TARGET_LOAD_OUTCOME_UNKNOWN' });
      const job = f.store.jobs()[0];
      assert.equal(job.status, 'blocked');
      assert.equal(job.targetLoad.phase, 'requested');
      assert.ok(job.lastError);
      f.closeStore();
      const store = new Store(f.config.stateDir);
      try {
        store.recover();
        const bridge = new BridgeClass(f.config, credentials, store, f.weixin, f.cockpit);
        await assert.rejects(bridge.step(), { code: 'TARGET_LOAD_OUTCOME_UNKNOWN' });
      } finally { store.close(); }
      assert.equal(loads(f).length, 1);
      assert.equal(f.prompts.length, 0);
      assert.equal(f.sent.length, 0);
    });
  }

  test(`${mode}: interrupted durable load request cannot be inferred successful from an already-loaded target`, async t => {
    const f = await cold(t, BridgeClass);
    await f.bridge.receive();
    const job = f.store.jobs()[0];
    job.targetLoad = { phase: 'requested' }; f.store.save(job);
    f.state.loaded = true; f.state.status = 'idle';
    await assert.rejects(f.bridge.step(), { code: 'TARGET_LOAD_OUTCOME_UNKNOWN' });
    assert.equal(loads(f).length, 0);
    assert.equal(f.prompts.length, 0);
    assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
  });

  test(`${mode}: only explicit retry-load authorizes another readiness attempt, not unknown prompts or expired history`, async t => {
    const f = await cold(t, BridgeClass, { loadFault: 'disconnect' });
    await f.bridge.receive();
    await assert.rejects(f.bridge.step(), { code: 'TARGET_LOAD_OUTCOME_UNKNOWN' });
    const id = f.store.jobs()[0].id;
    resolveJob(f.store, id, 'retry-load');
    assert.equal(loads(f).length, 1, 'recording operator authorization makes no remote call');
    f.state.loadFault = null;
    await f.bridge.step();
    assert.equal(loads(f).length, 2, 'loaded metadata alone does not clear an uncertain readiness result');
    assert.equal(f.prompts.length, 1);
    const job = f.store.job(id);
    job.status = 'blocked'; job.reason = 'PROMPT_OUTCOME_UNKNOWN'; f.store.save(job);
    assert.throws(() => resolveJob(f.store, id, 'retry-load'), { code: 'LOAD_RETRY_NOT_APPLICABLE' });
    job.reason = 'NATIVE_CURSOR_EXPIRED'; f.store.save(job);
    assert.throws(() => resolveJob(f.store, id, 'retry-load'), { code: 'LOAD_RETRY_NOT_APPLICABLE' });
    assert.equal(f.prompts.length, 1);
  });

  test(`${mode}: drain during cold load retains queued input without prompting`, async t => {
    const f = await cold(t, BridgeClass);
    f.state.onLoad = async () => { f.bridge.draining = true; };
    await f.bridge.receive();
    await f.bridge.step();
    assert.equal(loads(f).length, 1);
    assert.equal(f.store.jobs()[0].status, 'queued');
    assert.equal(f.store.jobs()[0].targetLoad.phase, 'confirmed');
    assert.equal(f.prompts.length, 0);
    assert.deepEqual(f.store.get('historyCheckpoint'), f.checkpoint);
  });

  for (const [changed, code] of [[{ missing: true }, 'TARGET_SESSION_MISSING'],
    [{ changedCwd: '/tmp/different-target' }, 'TARGET_CWD_CHANGED']]) {
    test(`${mode}: ${code} never triggers a load or a replacement target`, async t => {
      const f = await cold(t, BridgeClass);
      Object.assign(f.state, changed);
      await f.bridge.receive();
      await assert.rejects(f.bridge.step(), { code });
      assert.equal(loads(f).length, 0);
      assert.equal(f.prompts.length, 0);
    });
  }

  test(`${mode}: cold startup with no checkpoint stays passive until input is received`, async t => {
    const f = await fixture(t, { bridgeClass: BridgeClass, loaded: false, status: 'unloaded', batch: [] });
    f.config.limits.requestTimeoutMs = 2000;
    const stop = new AbortController(), running = f.bridge.run(stop.signal);
    t.after(async () => { stop.abort(); await running; });
    const until = async predicate => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'cold fixture did not make bounded progress');
        await delay(10);
      }
    };
    await until(() => f.requests.some(row => row.url.includes('getupdates')));
    assert.equal(loads(f).length, 0);
    assert.equal(f.store.get('historyCheckpoint'), null);
    f.state.batch = [incoming({ message_id: 123456 })];
    await until(() => f.prompts.length === 1);
    stop.abort(); await running;
    assert.equal(loads(f).length, 1);
    assert.equal(f.prompts.length, 1);
    assert.ok(f.store.get('historyCheckpoint').position);
  });
}

for (const method of ['since', 'deliveryPage']) {
  test(`${method}: cursor source remains persisted even when the original session is loaded`, async t => {
    const f = await fixture(t);
    const page = await f.cockpit.nativePage({ source: 'persisted', direction: 'forward', max: 64 });
    const position = { cursor: page.cursor, source: 'persisted' };
    const start = f.requests.length;
    await f.cockpit[method]({ id: null, position });
    const attempts = reads(f.requests.slice(start));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].data.source, 'persisted');
    assert.equal(attempts[0].data.cursor, position.cursor);
    assert.equal(attempts[0].data.types, undefined);
    assert.equal(loads(f).length, 0);
  });

  test(`${method}: missing or malformed cursor never falls back to a fresh history read`, async t => {
    const f = await fixture(t), start = f.requests.length;
    for (const position of [{ cursor: '', source: 'live' }, { cursor: 'original' },
      { cursor: 'original', source: 'other' }]) {
      await assert.rejects(f.cockpit[method]({ id: null, position }), { code: 'NATIVE_CHECKPOINT_INVALID' });
    }
    assert.equal(reads(f.requests.slice(start)).length, 0);
    assert.equal(loads(f).length, 0);
  });
}
