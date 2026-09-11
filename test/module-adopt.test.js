import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { adoptLegacy, activateAdoption } from '../src/module-adopt.js';
import { control, moduleStatus } from '../src/module-control.js';
import { loadConfig } from '../src/config.js';
import { readControl } from '../src/module-state.js';
import { RunLock, Store, writePrivate } from '../src/storage.js';

const root = path.resolve(import.meta.dirname, '..');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function tree(dir) {
  const result = {};
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      result[path.relative(dir, file)] = stat.isDirectory() ? 'directory' : sha256(file);
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(dir);
  return result;
}

function childResult(child) {
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return once(child, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr }));
}

async function fixture(t, { unknown = false } = {}) {
  const dir = path.join(root, `.module-adopt-test-${randomUUID()}`);
  const profile = path.join(dir, 'legacy-profile');
  const stateDir = path.join(profile, '.bridge-state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const credentials = {
    account: 'legacy-account',
    peer: 'legacy-peer',
    token: 'UNCHANGED_LEGACY_CREDENTIAL_BYTES',
    baseUrl: 'https://ilinkai.weixin.qq.com',
  };
  const sourceFile = path.join(profile, 'config.json');
  const sourceRaw = {
    deliveryMode: 'session',
    nativeInterruptFollowup: false,
    diagnostics: { weixinHttp: true },
    cockpit: {
      apiUrl: 'http://127.0.0.1:7777',
      webUrl: 'https://cockpit.example.test',
      sessionId: 'old-native-session-id',
      cwd: '/original/native/cwd',
    },
    weixin: {
      allowedAccount: credentials.account,
      allowedPeer: credentials.peer,
      approvedApiOrigins: ['https://ilinkai.weixin.qq.com'],
    },
    limits: { requestTimeoutMs: 100, resultTimeoutMs: 900000, statusIntervalMs: 20,
      maxQueued: 100, textBytes: 1800, maxReplyParts: 32 },
  };
  writePrivate(sourceFile, sourceRaw);
  writePrivate(path.join(stateDir, 'credentials.json'), credentials);
  const source = loadConfig(sourceFile);
  const store = new Store(source.stateDir);
  store.set('binding', {
    account: credentials.account,
    peer: credentials.peer,
    ...source.cockpit,
  });
  store.set('cursor', 'legacy-inbox-cursor');
  store.set('historyCheckpoint', { id: 'old-native-event-id', fingerprint: 'old-history-fingerprint' });
  store.set('customOpaqueCheckpoint', { oldNativeId: 'old-native-session-id', bytes: 'KEEP_EXACTLY' });
  if (unknown) {
    store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('unknown-old-send', 1, JSON.stringify({
      id: 'unknown-old-send',
      status: 'blocked',
      reason: 'WEIXIN_OUTCOME_UNKNOWN',
      original: 'retained private history',
      outbox: [{ clientId: 'original-client-id', status: 'unknown' }],
    }));
  } else {
    store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('done-old-message', 1, JSON.stringify({
      id: 'done-old-message',
      status: 'done',
      original: 'retained private history',
      outbox: [{ clientId: 'original-client-id', status: 'accepted' }],
    }));
  }
  store.close();
  fs.writeFileSync(path.join(stateDir, 'bridge.sqlite-wal'), '', { mode: 0o600 });
  fs.mkdirSync(path.join(stateDir, 'media-work'), { mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, 'media-work', 'legacy.bin'), Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, 'last-send-receipt.json'),
    JSON.stringify({ status: 'unknown', absolutePath: path.join(stateDir, 'media-work', 'legacy.bin') }),
    { mode: 0o600 });
  const moduleFile = path.join(dir, 'module-config.json');
  const moduleRaw = {
    ...sourceRaw,
    moduleManaged: true,
    stateDir: path.join(dir, 'module-bindings'),
    lockDir: path.join(dir, 'module-control'),
    credentialFile: source.credentialFile,
    cockpit: { ...sourceRaw.cockpit, sessionId: '', cwd: '' },
  };
  writePrivate(moduleFile, moduleRaw);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, profile, stateDir, sourceFile, sourceRaw, source, moduleFile, moduleRaw, credentials };
}

const nativeMeta = f => async (url, init) => {
  assert.equal(new URL(url).pathname, '/intent/session/get');
  assert.deepEqual(JSON.parse(init.body), { sessionId: f.sourceRaw.cockpit.sessionId });
  return Response.json({ meta: {
    sessionId: f.sourceRaw.cockpit.sessionId,
    cwd: f.sourceRaw.cockpit.cwd,
    loaded: false,
    status: 'unloaded',
    ask: null,
  } });
};

test('offline legacy adoption retains exact profile bytes and creates a paused sourced association', async t => {
  const f = await fixture(t, { unknown: true });
  await assert.rejects(control(f.moduleFile, {
    operation: 'adopt',
    operationId: 'remote-adopt-refused',
    sessionId: 'old-native-session-id',
    cwd: '/original/native/cwd',
  }), { code: 'INVALID_REQUEST' });
  const before = tree(f.profile);
  let reads = 0;
  const result = await adoptLegacy(f.moduleFile, f.sourceFile, 'adopt-legacy-0001', {
    fetchImpl: async (...args) => { reads++; return nativeMeta(f)(...args); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.boundSessionId, 'old-native-session-id');
  assert.equal(result.activation, 'paused');
  assert.deepEqual(result.preservedPaths, [f.stateDir]);
  assert.equal(reads, 1);
  assert.deepEqual(tree(f.profile), before);
  const state = readControl(loadConfig(f.moduleFile));
  assert.equal(state.active.stateDir, f.stateDir);
  assert.equal(state.active.cwd, '/original/native/cwd');
  assert.equal(state.active.adoption.sourceConfigPath, f.sourceFile);
  assert.equal(state.active.adoption.credentialFile, f.source.credentialFile);
  assert.equal(state.active.activation, 'paused');
  const status = moduleStatus(loadConfig(f.moduleFile));
  assert.equal(status.available, false);
  assert.equal(status.reason, 'ADOPTION_ACTIVATION_REQUIRED');
  assert.equal(status.bindingConfirmed, true);
  assert.equal(status.unknownJobs, 1);
  assert.equal(status.adopted, true);
  assert.equal(status.activationState, 'paused');
  const replay = await adoptLegacy(f.moduleFile, f.sourceFile, 'adopt-legacy-0001', {
    fetchImpl: async () => { assert.fail('readback must not repeat the native read'); },
  });
  assert.deepEqual(replay, { ...result, replayed: true });
  assert.deepEqual(tree(f.profile), before);
  await assert.rejects(activateAdoption(f.moduleFile, 'activate-legacy-0001', {
    fetchImpl: nativeMeta(f),
  }), { code: 'UNKNOWN_OUTCOMES' });
  const child = spawn(process.execPath, ['src/cli.js', 'check', '--config', f.moduleFile], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: f.dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopped = await childResult(child);
  assert.equal(stopped.code, 2);
  assert.match(stopped.stderr, /ADOPTION_ACTIVATION_REQUIRED/);
  assert.deepEqual(tree(f.profile), before);
});

test('explicit activation revalidates the same native target and remains idempotent', async t => {
  const f = await fixture(t);
  let reads = 0;
  const fetchImpl = async (...args) => { reads++; return nativeMeta(f)(...args); };
  await adoptLegacy(f.moduleFile, f.sourceFile, 'adopt-clean-0001', { fetchImpl });
  const before = tree(f.profile);
  const activated = await activateAdoption(f.moduleFile, 'activate-clean-0001', { fetchImpl });
  assert.equal(activated.ok, true);
  assert.equal(activated.activation, 'active');
  assert.equal(activated.boundSessionId, 'old-native-session-id');
  assert.equal(reads, 2);
  assert.deepEqual(tree(f.profile), before);
  assert.deepEqual(await activateAdoption(f.moduleFile, 'activate-clean-0001', {
    fetchImpl: async () => { assert.fail('activation readback must not repeat native validation'); },
  }), { ...activated, replayed: true });
  const status = moduleStatus(loadConfig(f.moduleFile));
  assert.equal(status.reason, 'ALREADY_BOUND');
  assert.equal(status.bindingConfirmed, true);
  assert.equal(status.activationState, 'active');
  assert.equal(status.pendingJobs, 0);
  assert.deepEqual(tree(f.profile), before);
});

for (const [name, fetchImpl, code] of [
  ['malformed metadata', async () => Response.json({}), 'COCKPIT_SESSION_SCHEMA'],
  ['HTTP 403', async () => Response.json({ meta: null }, { status: 403 }), 'HTTP_403'],
  ['timeout', async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }), 'REQUEST_TIMEOUT'],
]) {
  test(`adoption treats ${name} as failure, never absence or a fresh initialization`, async t => {
    const f = await fixture(t);
    const before = tree(f.profile);
    let reads = 0;
    const result = await adoptLegacy(f.moduleFile, f.sourceFile, `adopt-failure-${code.toLowerCase()}`, {
      fetchImpl: async (...args) => { reads++; return fetchImpl(...args); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.boundSessionId, null);
    assert.equal(readControl(loadConfig(f.moduleFile)).active, null);
    assert.equal(fs.existsSync(f.moduleRaw.stateDir), false);
    assert.equal(reads, 1);
    assert.deepEqual(tree(f.profile), before);
    const replay = await adoptLegacy(f.moduleFile, f.sourceFile, result.operationId, {
      fetchImpl: async () => { assert.fail('failed readback must not repeat native validation'); },
    });
    assert.deepEqual(replay, { ...result, replayed: true });
    assert.equal(reads, 1);
  });
}

test('adoption refuses active legacy writers and concurrent duplicate execution', async t => {
  const active = await fixture(t);
  const runner = new RunLock(active.source.lockDir);
  try {
    await assert.rejects(adoptLegacy(active.moduleFile, active.sourceFile, 'adopt-busy-0001', {
      fetchImpl: nativeMeta(active),
    }), { code: 'RUNNING' });
    assert.equal(readControl(loadConfig(active.moduleFile)), null);
  } finally { runner.release(); }

  const concurrent = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0;
  const first = adoptLegacy(concurrent.moduleFile, concurrent.sourceFile, 'adopt-concurrent-0001', {
    fetchImpl: async (...args) => {
      reads++;
      entered.resolve();
      await release.promise;
      return nativeMeta(concurrent)(...args);
    },
  });
  await entered.promise;
  await assert.rejects(adoptLegacy(concurrent.moduleFile, concurrent.sourceFile, 'adopt-concurrent-0001', {
    fetchImpl: async () => { assert.fail('concurrent readback must not issue a second native read'); },
  }), { code: 'OPERATION_OUTCOME_UNKNOWN' });
  release.resolve();
  assert.equal((await first).ok, true);
  assert.equal(reads, 1);
});

test('adoption accepts an empty stopped WAL but refuses a nonempty WAL without checkpointing it', async t => {
  const f = await fixture(t);
  const wal = path.join(f.stateDir, 'bridge.sqlite-wal');
  assert.equal(fs.statSync(wal).size, 0);
  fs.writeFileSync(wal, 'unconsumed synthetic WAL bytes', { mode: 0o600 });
  const before = tree(f.profile);
  await assert.rejects(adoptLegacy(f.moduleFile, f.sourceFile, 'adopt-nonempty-wal', {
    fetchImpl: nativeMeta(f),
  }), { code: 'STATE_SNAPSHOT_UNAVAILABLE' });
  assert.deepEqual(tree(f.profile), before);
  assert.equal(readControl(loadConfig(f.moduleFile)), null);
});
