import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, credentials } from './helpers.js';
import { Bridge } from '../src/bridge.js';
import { SessionBridge } from '../src/session-bridge.js';
import { RunLock, writePrivate } from '../src/storage.js';
import { deliveryCheckpoint } from '../src/cockpit.js';

async function waitFor(predicate, message) {
  const until = Date.now() + 5000;
  while (!predicate() && Date.now() < until) await delay(10);
  assert.ok(predicate(), message);
}

function pendingNativeJob(f) {
  const job = f.store.jobs()[0];
  job.kind = 'unsupported'; job.status = 'replying'; job.outboxPurpose = 'unsupported';
  job.outbox = [
    { kind: 'text', value: 'already accepted', clientId: 'old-text', status: 'accepted' },
    { kind: 'image', uploadPath: '/uploads/fixture.png', imageStage: 'uploaded',
      imageItem: { type: 2, image_item: { media: { encrypt_query_param: 'FAKE_ONLY', aes_key: 'FAKE_ONLY', encrypt_type: 1 } } },
      clientId: 'pending-native', status: 'pending' },
    { kind: 'text', value: 'not started during drain', clientId: 'later-text', status: 'pending' },
  ];
  f.store.save(job);
  return job;
}

for (const stop of ['control', 'SIGTERM']) {
  test(`real CLI ${stop} drains an in-flight native send without abort, replay or next-part send`, async t => {
    const f = await fixture(t, { sendFault: 'hold' });
    await f.bridge.receive();
    const job = pendingNativeJob(f);
    const binding = f.store.get('binding');
    const cursor = f.store.get('cursor');
    f.raw.limits.requestTimeoutMs = 2000;
    fs.writeFileSync(f.configFile, JSON.stringify(f.raw), { mode: 0o600 });
    writePrivate(path.join(f.config.stateDir, 'credentials.json'), credentials);
    const args = ['--import', './test/cli-preload.js', 'src/cli.js', 'run', '--config', f.configFile];
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, TEST_MOCK_PORT: String(f.port), COCKPIT_API_TOKEN: 'FAKE_GATE_TOKEN' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        for (const held of f.heldSends) if (!held.response.destroyed) held.release();
        await once(child, 'exit');
      }
    });
    await waitFor(() => f.heldSends.length === 1, output);
    assert.equal(f.store.job(job.id).outbox[1].status, 'sending');
    if (stop === 'control') {
      const result = await promisify(execFile)(process.execPath, ['src/cli.js', 'stop', '--config', f.configFile],
        { cwd: path.resolve(import.meta.dirname, '..') });
      assert.match(result.stdout, /Drain requested/);
    } else {
      child.kill('SIGTERM');
      await waitFor(() => output.includes('BRIDGE_DRAIN_REQUESTED'), output);
      child.kill('SIGTERM');
    }
    await waitFor(() => output.includes('BRIDGE_DRAIN_REQUESTED'), output);
    await delay(50);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(f.heldSends[0].response.destroyed, false);
    assert.equal(f.sent.length, 1);
    const exited = once(child, 'exit');
    f.heldSends[0].release();
    assert.deepEqual(await exited, [0, null], output);
    assert.match(output, /BRIDGE_DRAINED/);
    assert.equal(fs.existsSync(path.join(f.config.stateDir, 'run.lock')), false);
    assert.equal(fs.existsSync(path.join(f.config.stateDir, 'stop.json')), false);
    assert.deepEqual(f.store.get('binding'), binding);
    assert.equal(f.store.get('cursor'), cursor);
    assert.deepEqual(f.store.job(job.id).outbox.map(part => part.status), ['accepted', 'accepted', 'pending']);
    assert.equal(f.store.job(job.id).status, 'replying');
    assert.ok(!f.requests.some(row => row.url.includes('cancel')));
    f.state.sendFault = null;
    const resumed = new Bridge(f.config, credentials, f.store, f.weixin, f.cockpit, { log() {} });
    f.store.recover(); await resumed.step(); await resumed.step();
    assert.deepEqual(f.sent.map(row => row.msg.client_id), ['pending-native', 'later-text']);
    assert.equal(f.store.job(job.id).status, 'done');
  });
}

test('drain waits for an in-flight accepted prompt and starts no output send or second prompt', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge, promptFault: 'hold' });
  f.config.limits.requestTimeoutMs = 2000;
  f.store.set('historyCheckpoint', deliveryCheckpoint());
  await f.bridge.receive();
  const stop = new AbortController();
  const running = f.bridge.run(stop.signal);
  t.after(() => { stop.abort(); for (const held of f.heldPrompts) if (!held.response.destroyed) held.release(); });
  await waitFor(() => f.heldPrompts.length === 1, 'fixture prompt started');
  stop.abort(); await delay(50);
  assert.equal(f.heldPrompts[0].response.destroyed, false);
  assert.equal(f.store.jobs()[0].status, 'prompting');
  f.heldPrompts[0].release();
  await running;
  assert.equal(f.store.jobs()[0].status, 'accepted');
  assert.equal(f.prompts.length, 1); assert.equal(f.sent.length, 0);
  f.state.promptFault = null;
  const resumed = new SessionBridge(f.config, credentials, f.store, f.weixin, f.cockpit, { log() {} });
  f.store.recover(); await resumed.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.store.jobs()[0].status, 'done');
});

test('natural timeout during drain remains unknown and cannot restart-replay', async t => {
  const f = await fixture(t, { sendFault: 'hold' });
  await f.bridge.receive(); const job = pendingNativeJob(f);
  const stop = new AbortController();
  const running = f.bridge.run(stop.signal);
  const outcome = assert.rejects(running, { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  await waitFor(() => f.heldSends.length === 1, 'fixture native send started');
  stop.abort();
  await outcome;
  assert.equal(f.store.job(job.id).status, 'blocked');
  assert.equal(f.store.job(job.id).outbox[1].status, 'unknown');
  assert.equal(f.store.job(job.id).lastError, 'REQUEST_TIMEOUT');
  const resumed = new Bridge(f.config, credentials, f.store, f.weixin, f.cockpit, { log() {} });
  f.store.recover();
  await assert.rejects(resumed.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 1);
});

test('drain settles an already-started CDN upload but leaves its native send pending', async t => {
  const f = await fixture(t);
  f.config.limits.requestTimeoutMs = 2000;
  await f.bridge.receive();
  const job = pendingNativeJob(f);
  delete job.outbox[1].imageItem; delete job.outbox[1].imageStage;
  f.store.save(job);
  let uploadSignal;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const call = f.weixin.call.bind(f.weixin);
  f.weixin.call = async (endpoint, body, options) => {
    if (endpoint !== 'ilink/bot/getuploadurl') return call(endpoint, body, options);
    uploadSignal = options.signal;
    await gate;
    return { upload_param: 'FIXTURE_ONLY' };
  };
  const stop = new AbortController();
  const running = f.bridge.run(stop.signal);
  t.after(() => { stop.abort(); release(); });
  await waitFor(() => uploadSignal, 'fixture upload started');
  stop.abort();
  assert.equal(uploadSignal.aborted, false);
  release(); await running;
  const part = f.store.job(job.id).outbox[1];
  assert.equal(part.status, 'pending');
  assert.equal(part.imageStage, 'uploaded');
  assert.equal(part.imageItem.type, 2);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.config.stateDir, 'media-work')), []);
});

test('stop command refuses legacy runners instead of aborting their in-flight mutations', async t => {
  const f = await fixture(t);
  const lock = new RunLock(f.config.stateDir);
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['src/cli.js', 'stop', '--config', f.configFile],
      { cwd: path.resolve(import.meta.dirname, '..') }), error => {
      assert.match(error.stderr, /RUNNER_DRAIN_UNAVAILABLE/);
      return true;
    });
    assert.equal(lock.stopRequested(), false);
    assert.equal(fs.existsSync(path.join(f.config.stateDir, 'stop.json')), false);
  } finally { lock.release(); }
});
