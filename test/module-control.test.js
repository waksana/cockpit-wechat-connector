import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { control, moduleStatus } from '../src/module-control.js';
import { CockpitClient } from '../src/cockpit.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { acquireModuleGate, assertCurrentConfig, controlFile, readControl } from '../src/module-state.js';
import { readPrivate, RunLock, Store, writePrivate } from '../src/storage.js';

const root = path.resolve(import.meta.dirname, '..');
const actualVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const credentials = { account: 'fixture-account', peer: 'fixture-peer', token: 'FAKE_PRIVATE_TOKEN',
  baseUrl: 'https://ilinkai.weixin.qq.com' };
const bind = (operationId = 'bind-first', sessionId = 'session-one') => ({
  operation: 'bind', operationId, sessionId, cwd: '/fixture/workspace',
});
const unbind = (operationId = 'unbind-first', sessionId = 'session-one') => ({
  operation: 'unbind', operationId, sessionId, cwd: '/fixture/workspace',
});
const sessionUnbind = (operationId = 'session-unbind-first', sessionId = 'session-one') => ({
  operation: 'session-unbind', operationId, sessionId,
});
const storedBinding = config => ({ account: config.weixin.allowedAccount, peer: config.weixin.allowedPeer, ...config.cockpit });

async function fixture(t) {
  const dir = path.join(root, `.module-test-${randomUUID()}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const requests = [];
  let hold;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization });
    if (hold && req.url === '/intent/session/get') await hold;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/intent/session/get') {
      res.end(JSON.stringify({ meta: { sessionId: body.sessionId, cwd: '/fixture/workspace',
        loaded: true, status: 'idle', queue: [], ask: null } }));
    } else if (req.url.startsWith('/capabilities?')) {
      const name = new URL(req.url, 'http://fixture').searchParams.get('name');
      const fields = name === 'prompt' ? ['sessionId', 'text', 'mode']
        : name === 'session/get' ? ['sessionId'] : ['sessionId', 'cursor', 'max', 'source', 'direction'];
      res.end(JSON.stringify({ name, inputSchema: { properties: Object.fromEntries(fields.map(field =>
        [field, field === 'mode' ? { enum: ['enqueue'] } : {}])) }, resultSchema: {} }));
    } else if (req.url === '/intent/session/chat') {
      res.end(JSON.stringify({ sessionId: body.sessionId, events: [], cursor: 'fixture-cursor',
        cursorStatus: 'ok', liveCursor: 'fixture-live', hasMore: false,
        source: body.source, direction: body.direction }));
    } else if (req.url === '/weixin/ilink/bot/getupdates') {
      res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'fixture-inbox-cursor' }));
    } else { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const raw = {
    cockpit: { sessionId: '', cwd: '', apiUrl: `http://127.0.0.1:${port}`, webUrl: `http://127.0.0.1:${port}` },
    weixin: { allowedAccount: credentials.account, allowedPeer: credentials.peer,
      approvedApiOrigins: ['https://ilinkai.weixin.qq.com'] },
    moduleManaged: true, stateDir: path.join(dir, 'bindings'), lockDir: path.join(dir, 'control'),
    credentialFile: path.join(dir, 'credentials.json'), limits: { statusIntervalMs: 20, requestTimeoutMs: 1000 },
  };
  const file = path.join(dir, 'config.json');
  writePrivate(file, raw); writePrivate(raw.credentialFile, credentials);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, raw, requests, port, hold: promise => { hold = promise; } };
}

function cli(file, args = ['status'], options = {}) {
  return processResult(spawn(process.execPath, [...(options.preload ? ['--import', './test/cli-preload.js'] : []),
    'src/cli.js', ...args, '--config', file], {
    cwd: root, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function processResult(child) {
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = once(child, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, done };
}

function wire(file, request) {
  const child = spawn(process.execPath, ['src/module-control.js', '--config', file], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = processResult(child);
  child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  return result.done;
}

function fileSnapshot(dir) {
  const files = {};
  const visit = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      files[path.relative(dir, file)] = { mode: stat.mode,
        digest: stat.isDirectory() ? null : createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(dir);
  return files;
}

test('official manifest, validated paths and unchanged legacy defaults', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'module.json')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.roles.map(role => Object.keys(role).sort()), [['description', 'id', 'name']]);
  assert.equal(manifest.binding, 'wechat');
  assert.deepEqual(manifest.sessionLifecycle, { unbind: { entry: 'src/module-control.js' } });
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json')));
  const config = validateConfig(raw, '/fixture/config.json');
  assert.equal(config.stateDir, '/fixture/.bridge-state');
  assert.equal(config.lockDir, config.stateDir);
  assert.equal(config.credentialFile, '/fixture/.bridge-state/credentials.json');
  for (const field of ['stateDir', 'lockDir', 'credentialFile']) {
    assert.throws(() => validateConfig({ ...raw, [field]: 'relative' }, '/fixture/config.json'),
      { code: 'INVALID_STATE_PATH' });
  }
});

test('offline status, unique binding, durable idempotent receipts and exact native metadata verification', async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(f.file);
  const token = fs.readFileSync(f.raw.credentialFile);
  const before = await control(f.file, { operation: 'status' });
  assert.equal(before.status.available, true);
  assert.equal(before.status.boundSessionId, null);
  assert.equal(before.status.bindingConfirmed, false);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.raw.stateDir), false);
  const bound = await control(f.file, bind());
  assert.equal(bound.ok, true);
  assert.equal(bound.boundSessionId, 'session-one');
  assert.equal(bound.revision, 1);
  assert.deepEqual(f.requests.map(req => req.url), ['/intent/session/get']);
  const replay = await control(f.file, bind());
  assert.deepEqual(replay, { ...bound, replayed: true });
  assert.equal(f.requests.length, 1);
  const unavailable = await control(f.file, { operation: 'status' });
  assert.equal(unavailable.status.reason, 'ALREADY_BOUND');
  assert.equal(unavailable.status.available, false);
  assert.equal(unavailable.status.bindingConfirmed, false, 'a successful fresh bind has not yet initialized a Store');
  const other = await control(f.file, bind('bind-another', 'session-two'));
  assert.equal(other.error.code, 'ALREADY_BOUND');
  await assert.rejects(control(f.file, bind('bind-first', 'session-two')), { code: 'OPERATION_ID_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(fs.readFileSync(f.raw.credentialFile), token);
  const nativeMismatch = await control(f.file, unbind());
  assert.equal(nativeMismatch.ok, true);
  const failed = await control(f.file, { ...bind('wrong-cwd'), cwd: '/wrong' });
  assert.equal(failed.error.code, 'TARGET_CWD_CHANGED');
  assert.equal((await control(f.file, { operation: 'status' })).status.boundSessionId, null);
});

test('binding inconsistency takes precedence over business blockers without changing files or control identity', async t => {
  for (const binding of [
    { sessionId: 'different-session', cwd: '/fixture/workspace' },
    { sessionId: 'session-one', cwd: '/different/workspace' },
  ]) {
    for (const job of [
      { id: 'pending', status: 'queued' },
      { id: 'unknown', status: 'prompting' },
      { id: 'sending', status: 'replying', outbox: [{ status: 'sending' }] },
    ]) {
      const f = await fixture(t);
      await control(f.file, bind());
      const config = loadConfig(f.file);
      const store = new Store(config.stateDir);
      store.set('binding', binding);
      store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id, 1, JSON.stringify(job));
      store.close();
      const before = fileSnapshot(f.dir);
      const response = await wire(f.file, { operation: 'status' });
      assert.equal(response.code, 0, response.stdout);
      const { status } = JSON.parse(response.stdout);
      assert.equal(status.reason, 'PERSISTED_BINDING_CHANGED');
      assert.equal(status.bindingConfirmed, false);
      assert.equal(status.available, false);
      assert.equal(status.boundSessionId, 'session-one');
      assert.equal(status.revision, 1);
      assert.equal(status.unknownOperation, false);
      assert.equal(status.runnerUnknown, false);
      assert.equal(status.pendingJobs, 1);
      assert.equal(status.unknownJobs, job.status === 'queued' ? 0 : 1);
      assert.deepEqual(fileSnapshot(f.dir), before);
      assert.equal(f.requests.length, 1);
    }
  }
});

test('parallel offline status creates no control state and never competes for mutation locks', async t => {
  const f = await fixture(t);
  const initial = fileSnapshot(f.dir);
  const fresh = await Promise.all(Array.from({ length: 12 }, () => wire(f.file, { operation: 'status' })));
  for (const result of fresh) {
    assert.equal(result.code, 0, result.stdout);
    const { status } = JSON.parse(result.stdout);
    assert.equal(status.available, true);
    assert.equal(status.boundSessionId, null);
  }
  assert.deepEqual(fileSnapshot(f.dir), initial);
  assert.equal(f.requests.length, 0);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const store = new Store(config.stateDir);
  store.set('binding', storedBinding(config));
  store.set('historyCheckpoint', { id: 'retained' });
  store.close();
  const before = fileSnapshot(f.dir);
  const bound = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    index % 2 ? wire(f.file, { operation: 'status' }) : cli(f.file).done));
  for (let index = 0; index < bound.length; index++) {
    const result = bound[index];
    assert.equal(result.code, 0, result.stdout);
    const parsed = JSON.parse(result.stdout);
    const status = index % 2 ? parsed.status : parsed;
    assert.equal(status.boundSessionId, 'session-one');
    assert.equal(status.reason, 'ALREADY_BOUND');
    assert.equal(status.bindingConfirmed, true);
  }
  assert.deepEqual(fileSnapshot(f.dir), before);
  assert.equal(f.requests.length, 1);
});

test('binding confirmation distinguishes a live known runner, stale runner and explicitly unbound control', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const store = new Store(config.stateDir);
  store.set('binding', storedBinding(config));
  const runner = new RunLock(config.lockDir);
  try {
    const before = fileSnapshot(f.dir);
    const { status } = await control(f.file, { operation: 'status' });
    assert.equal(status.reason, 'RUNNING');
    assert.equal(status.running, true);
    assert.equal(status.bindingConfirmed, true);
    assert.equal(status.detailsAvailable, false);
    assert.equal(status.pendingJobs, null);
    assert.deepEqual(fileSnapshot(f.dir), before);
  } finally { runner.release(); store.close(); }
  const lockFile = path.join(config.lockDir, 'run.lock');
  writePrivate(lockFile, { pid: 2147483647, nonce: 'fixture-stale-runner' });
  const before = fileSnapshot(f.dir);
  const stale = await control(f.file, { operation: 'status' });
  assert.equal(stale.status.reason, 'RUNNER_STATE_UNKNOWN');
  assert.equal(stale.status.bindingConfirmed, false);
  assert.equal(stale.status.boundSessionId, 'session-one');
  assert.deepEqual(fileSnapshot(f.dir), before);
  fs.unlinkSync(lockFile);
  assert.equal((await control(f.file, unbind())).ok, true);
  assert.equal((await control(f.file, { operation: 'status' })).status.bindingConfirmed, false);
  assert.equal(f.requests.length, 1);
});

test('read-only status preserves authoritative binding while another operation owns the gate', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const gate = acquireModuleGate(config);
  try {
    const before = fileSnapshot(f.dir);
    const results = await Promise.all(Array.from({ length: 8 }, () => wire(f.file, { operation: 'status' })));
    for (const result of results) {
      assert.equal(result.code, 0, result.stdout);
      assert.deepEqual(JSON.parse(result.stdout).status, {
        available: false, reason: 'MODULE_CONTROL_BUSY', boundSessionId: 'session-one',
        credentialsPresent: true, configReady: true, running: null, runnerUnknown: true,
        unknownOperation: false, bindingConfirmed: false, pendingJobs: null, unknownJobs: null, revision: 1,
        managed: true, detailsAvailable: false,
      });
    }
    assert.equal(JSON.parse((await cli(f.file).done).stdout).boundSessionId, 'session-one');
    assert.deepEqual(fileSnapshot(f.dir), before);
  } finally { gate.release(); }
  assert.equal(f.requests.length, 1);
});

test('read-only status never ignores or checkpoints an unconsumed WAL, and keeps trusted target identity', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const store = new Store(config.stateDir);
  store.set('binding', storedBinding(config));
  store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('unknown', 1,
    JSON.stringify({ id: 'unknown', status: 'prompting' }));
  try {
    const before = fileSnapshot(f.dir);
    assert.ok(fs.statSync(path.join(config.stateDir, 'bridge.sqlite-wal')).size > 0);
    const results = await Promise.all(Array.from({ length: 8 }, () => wire(f.file, { operation: 'status' })));
    for (const result of results) {
      assert.equal(result.code, 0, result.stdout);
      const { status } = JSON.parse(result.stdout);
      assert.equal(status.boundSessionId, 'session-one');
      assert.equal(status.reason, 'STATE_SNAPSHOT_UNAVAILABLE');
      assert.equal(status.bindingConfirmed, true);
      assert.equal(status.available, false);
      assert.equal(status.detailsAvailable, false);
      assert.equal(status.unknownJobs, null);
    }
    assert.deepEqual(fileSnapshot(f.dir), before);
    assert.equal(store.job('unknown').status, 'prompting');
  } finally { store.close(); }
  const status = JSON.parse((await wire(f.file, { operation: 'status' })).stdout).status;
  assert.equal(status.reason, 'UNKNOWN_OUTCOMES');
  assert.equal(status.bindingConfirmed, true);
  assert.equal(status.unknownJobs, 1);
  assert.equal(f.requests.length, 1);
});

test('binding proof sees committed WAL identity changes independently of business counts without source writes', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file), store = new Store(config.stateDir);
  const expected = storedBinding(config);
  store.set('binding', expected);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('fixture-pending', 1,
    JSON.stringify({ id: 'fixture-pending', status: 'prompting' }));
  try {
    for (const running of [false, true]) {
      const runner = running ? new RunLock(config.lockDir) : null;
      try {
        for (const changed of [
          { sessionId: 'other-session' }, { cwd: '/other-workspace' }, { account: 'other-account' },
          { peer: 'other-peer' }, { apiUrl: 'http://127.0.0.1:1' }, { tokenFile: '/other/credential-reference' },
        ]) {
          store.set('binding', { ...expected, ...changed });
          const before = fileSnapshot(f.dir);
          const response = await wire(f.file, { operation: 'status' });
          assert.equal(response.code, 0, response.stdout);
          const { status } = JSON.parse(response.stdout);
          assert.equal(status.reason, running ? 'RUNNING' : 'STATE_SNAPSHOT_UNAVAILABLE');
          assert.equal(status.bindingConfirmed, false);
          assert.equal(status.boundSessionId, 'session-one');
          assert.equal(status.revision, 1);
          assert.equal(status.pendingJobs, null);
          assert.equal(status.unknownJobs, null);
          assert.deepEqual(fileSnapshot(f.dir), before);
        }
        store.set('binding', expected);
        const before = fileSnapshot(f.dir);
        assert.equal((await control(f.file, { operation: 'status' })).status.bindingConfirmed, true);
        assert.deepEqual(fileSnapshot(f.dir), before);
        store.db.prepare('DELETE FROM kv WHERE key=?').run('binding');
        assert.equal((await control(f.file, { operation: 'status' })).status.bindingConfirmed, false);
      } finally { runner?.release(); }
    }
    assert.equal(store.job('fixture-pending').status, 'prompting');
  } finally { store.close(); }
  assert.equal(f.requests.length, 1, 'identity status never performs another native or WeChat request');
});

test('confirmed identity cannot be borrowed from missing Stores, mismatched authority or ambiguous control receipts', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  assert.equal(moduleStatus(config).bindingConfirmed, false);
  const store = new Store(config.stateDir);
  store.set('binding', storedBinding(config));
  store.close();
  assert.equal(moduleStatus(config).bindingConfirmed, true);
  const original = readControl(config);
  for (const mutate of [
    state => { state.revision++; },
    state => { state.operations['bind-first'].request.cwd = '/other'; },
    state => { state.operations['bind-first'].result.boundSessionId = 'other'; },
    state => {
      state.operations['duplicate-bind'] = structuredClone(state.operations['bind-first']);
      state.operations['duplicate-bind'].request.operationId = 'duplicate-bind';
      state.operations['duplicate-bind'].result.operationId = 'duplicate-bind';
    },
    state => { state.history.push(structuredClone(state.active)); },
  ]) {
    const state = structuredClone(original);
    mutate(state);
    writePrivate(controlFile(config), state);
    const before = fileSnapshot(f.dir);
    assert.equal(moduleStatus(config).bindingConfirmed, false);
    assert.deepEqual(fileSnapshot(f.dir), before);
  }
  writePrivate(controlFile(config), original);
  writePrivate(f.file, { ...f.raw, limits: { ...f.raw.limits, statusIntervalMs: 25 } });
  assert.equal(moduleStatus(config).bindingConfirmed, false, 'stale loaded config cannot prove the current file authority');
  writePrivate(f.file, f.raw);
  fs.unlinkSync(path.join(config.stateDir, 'bridge.sqlite'));
  assert.equal(moduleStatus(config).bindingConfirmed, false, 'deleted Store cannot fall back to the control record');
  assert.equal(f.requests.length, 1);
});

test('binding snapshot rejects racing or oversized sources and always removes its private temporary copy', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file), store = new Store(config.stateDir);
  store.set('binding', storedBinding(config));
  const runner = new RunLock(config.lockDir);
  const main = path.join(config.stateDir, 'bridge.sqlite'), copies = [];
  const makeTemp = fs.mkdtempSync, read = fs.readSync;
  const tempMock = t.mock.method(fs, 'mkdtempSync', (...args) => {
    const directory = makeTemp(...args);
    copies.push(directory);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    return directory;
  });
  let changed = false;
  const readMock = t.mock.method(fs, 'readSync', (fd, ...args) => {
    const bytes = read(fd, ...args);
    if (!changed && fs.fstatSync(fd).ino === fs.statSync(main).ino) {
      changed = true;
      store.set('binding', { ...storedBinding(config), sessionId: 'changed-during-copy' });
    }
    return bytes;
  });
  try {
    try {
      assert.equal(moduleStatus(config).bindingConfirmed, false);
      assert.equal(changed, true);
      assert.equal(copies.length, 1);
      assert.ok(copies.every(directory => !fs.existsSync(directory)));
    } finally {
      readMock.mock.restore(); tempMock.mock.restore(); store.close();
    }
    fs.truncateSync(main, 128 * 1024 * 1024 + 1);
    assert.equal(moduleStatus(config).bindingConfirmed, false);
    assert.equal(fs.statSync(main).size, 128 * 1024 * 1024 + 1);
  } finally { runner.release(); }
});

test('parallel status cannot interfere with unique bind native validation or persist partial routing', async t => {
  const f = await fixture(t);
  f.raw.limits.requestTimeoutMs = 15000;
  writePrivate(f.file, f.raw);
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  t.after(() => release());
  const binding = control(f.file, bind());
  const until = Date.now() + 5000;
  while (f.requests.length < 1 && Date.now() < until) await delay(5);
  assert.equal(f.requests.length, 1);
  const before = fileSnapshot(f.dir);
  const results = await Promise.all(Array.from({ length: 8 }, () => wire(f.file, { operation: 'status' })));
  for (const result of results) {
    assert.equal(result.code, 0, result.stdout);
    const { status } = JSON.parse(result.stdout);
    assert.equal(status.boundSessionId, null);
    assert.equal(status.reason, 'OPERATION_OUTCOME_UNKNOWN');
    assert.equal(status.available, false);
  }
  assert.deepEqual(fileSnapshot(f.dir), before);
  release();
  assert.equal((await binding).ok, true);
  assert.equal(JSON.parse((await wire(f.file, { operation: 'status' })).stdout).status.boundSessionId, 'session-one');
  assert.equal(f.requests.length, 1);
});

test('status routes its database inspection from one atomic record, not a stale loaded config', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const stale = loadConfig(f.file);
  const oldStore = new Store(stale.stateDir);
  oldStore.set('binding', { sessionId: 'session-one', cwd: '/fixture/workspace' });
  oldStore.close();
  await control(f.file, unbind());
  assert.equal(moduleStatus(stale).boundSessionId, null);
  await control(f.file, bind('bind-fresh', 'session-two'));
  const current = loadConfig(f.file);
  const newStore = new Store(current.stateDir);
  newStore.set('binding', { sessionId: 'session-two', cwd: '/fixture/workspace' });
  newStore.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('new-queued', 1,
    JSON.stringify({ id: 'new-queued', status: 'queued' }));
  newStore.close();
  const status = moduleStatus(stale);
  assert.equal(status.boundSessionId, 'session-two');
  assert.equal(status.pendingJobs, 1);
  assert.equal(status.reason, 'PENDING_JOBS');
  assert.equal(status.revision, 3);
  assert.equal(f.requests.length, 2);
});

test('status bounds read-only snapshot retries and preserves trusted binding under continuous record changes', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const file = controlFile(config);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function(target, ...args) {
    const value = read.call(this, target, ...args);
    if (target === file) {
      const state = JSON.parse(value);
      const request = sessionUnbind(`concurrent-receipt-${++reads}`, 'unrelated-session');
      state.operations[request.operationId] = { phase: 'complete', request,
        result: { ok: true, operationId: request.operationId, sessionId: request.sessionId, unbound: true } };
      writePrivate(file, state);
    }
    return value;
  };
  let status;
  try { status = moduleStatus(config); }
  finally { fs.readFileSync = read; }
  assert.equal(reads, 7);
  assert.equal(status.reason, 'MODULE_CONTROL_BUSY');
  assert.equal(status.boundSessionId, 'session-one');
  assert.equal(status.available, false);
  assert.equal(status.detailsAvailable, false);
  assert.equal(f.requests.length, 1);
});

test('read-only status does not turn corrupt business/control state into a successful unbound fallback', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  fs.writeFileSync(path.join(config.stateDir, 'bridge.sqlite'), 'invalid SQLite fixture', { mode: 0o600 });
  const database = await wire(f.file, { operation: 'status' });
  assert.equal(database.code, 2);
  assert.deepEqual(JSON.parse(database.stdout), { ok: false, error: { code: 'MODULE_CONTROL_FAILED' } });
  const state = readControl(config);
  writePrivate(controlFile(config), { ...state, schemaVersion: 999 });
  const record = await wire(f.file, { operation: 'status' });
  assert.equal(record.code, 2);
  assert.deepEqual(JSON.parse(record.stdout), { ok: false, error: { code: 'MODULE_STATE_INVALID' } });
  assert.equal(f.requests.length, 1);
});

for (const operation of ['unbind', 'session-unbind']) {
  test(`parallel status during ${operation} retains old binding until atomic commit without writes`, async t => {
    const f = await fixture(t);
    await control(f.file, bind());
    const config = loadConfig(f.file);
    const preload = path.join(f.dir, 'pause-control-commit.js');
    const waiting = path.join(f.dir, 'commit-waiting');
    const release = path.join(f.dir, 'commit-release');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      const rename = fs.renameSync;
      let writes = 0;
      fs.renameSync = function(from, to) {
        if (to === ${JSON.stringify(controlFile(config))} && ++writes === 2) {
          fs.writeFileSync(${JSON.stringify(waiting)}, 'waiting', {mode: 0o600});
          const deadline = Date.now() + 10000;
          while (!fs.existsSync(${JSON.stringify(release)})) {
            if (Date.now() > deadline) throw new Error('Fixture commit wait expired');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return rename.call(this, from, to);
      };
    `, { mode: 0o600 });
    const child = spawn(process.execPath, ['--import', preload, 'src/module-control.js', '--config', f.file],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = processResult(child);
    child.stdin.end(JSON.stringify(operation === 'unbind' ? unbind() : sessionUnbind()));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        fs.writeFileSync(release, 'release', { mode: 0o600 });
        await output.done;
      }
    });
    const until = Date.now() + 5000;
    while (!fs.existsSync(waiting) && Date.now() < until && child.exitCode === null) await delay(5);
    assert.ok(fs.existsSync(waiting));
    const before = fileSnapshot(f.dir);
    const results = await Promise.all(Array.from({ length: 8 }, () => wire(f.file, { operation: 'status' })));
    for (const result of results) {
      assert.equal(result.code, 0, result.stdout);
      const { status } = JSON.parse(result.stdout);
      assert.equal(status.boundSessionId, 'session-one');
      assert.equal(status.available, false);
      assert.equal(status.reason, 'OPERATION_OUTCOME_UNKNOWN');
      assert.equal(status.detailsAvailable, false);
    }
    assert.deepEqual(fileSnapshot(f.dir), before);
    fs.writeFileSync(release, 'release', { mode: 0o600 });
    const result = await output.done;
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse((await wire(f.file, { operation: 'status' })).stdout).status.boundSessionId, null);
    assert.equal(f.requests.length, 1);
  });
}

test('concurrent child mutations have one authority; repeated IDs are readback, never native retries', async t => {
  const f = await fixture(t);
  const results = await Promise.all([wire(f.file, bind()), wire(f.file, bind('bind-other', 'session-two'))]);
  const parsed = results.map(result => JSON.parse(result.stdout));
  assert.equal(parsed.filter(result => result.ok).length, 1);
  assert.ok(['MODULE_CONTROL_BUSY', 'MODULE_CONFIG_STALE', 'ALREADY_BOUND'].includes(
    parsed.find(result => !result.ok).error.code));
  assert.equal(f.requests.length, 1);
  assert.ok(!JSON.stringify(results).includes(credentials.token));
});

test('optional session-unbind uses saved cwd, retains all history and needs no native/credential access', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const store = new Store(config.stateDir);
  const binding = { sessionId: 'session-one', cwd: '/fixture/workspace' };
  store.set('binding', binding);
  store.set('historyCheckpoint', { id: 'old-message', fingerprint: 'retained' });
  store.set('cursor', 'old-inbox-cursor');
  store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('done-job', 1,
    JSON.stringify({ id: 'done-job', status: 'done', original: 'PRIVATE_OLD_MESSAGE' }));
  store.close();
  const originalConfig = fs.readFileSync(f.file);
  const dbBefore = fs.readFileSync(path.join(config.stateDir, 'bridge.sqlite'));
  const credentialBackup = path.join(f.dir, 'retained-credential.json');
  fs.renameSync(config.credentialFile, credentialBackup);
  const request = sessionUnbind();
  const result = await wire(f.file, request);
  assert.equal(result.code, 0, result.stdout);
  const expected = { ok: true, operationId: request.operationId,
    sessionId: request.sessionId, unbound: true, replayed: false };
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.deepEqual(JSON.parse((await wire(f.file, request)).stdout), { ...expected, replayed: true });
  const state = readControl(config);
  assert.equal(state.active, null);
  assert.equal(state.revision, 2);
  assert.equal(state.history[0].cwd, binding.cwd);
  assert.equal(state.history[0].stateDir, config.stateDir);
  assert.deepEqual(fs.readFileSync(path.join(config.stateDir, 'bridge.sqlite')), dbBefore);
  assert.deepEqual(fs.readFileSync(f.file), originalConfig);
  assert.deepEqual(readPrivate(credentialBackup), credentials);
  assert.equal(fs.existsSync(config.credentialFile), false);
  assert.equal(f.requests.length, 1);
  assert.ok(!result.stdout.includes('PRIVATE') && !result.stdout.includes('fixture/workspace'));
});

test('session-unbind records absent and different-target receipts without changing newer binding or revision', async t => {
  const f = await fixture(t);
  const absent = sessionUnbind('session-absent');
  const expected = { ok: true, operationId: absent.operationId, sessionId: absent.sessionId,
    unbound: true, replayed: false };
  assert.deepEqual(await control(f.file, absent), expected);
  const config = loadConfig(f.file);
  assert.equal(readControl(config).revision, 0);
  assert.equal(fs.existsSync(f.raw.stateDir), false);
  assert.equal(f.requests.length, 0);
  await control(f.file, bind('bind-new-target', 'session-two'));
  const activeConfig = loadConfig(f.file);
  const before = readControl(activeConfig);
  const store = new Store(activeConfig.stateDir);
  store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('new-unknown', 1,
    JSON.stringify({ id: 'new-unknown', status: 'prompting' }));
  store.close();
  const newData = fs.readFileSync(path.join(activeConfig.stateDir, 'bridge.sqlite'));
  const runner = new RunLock(activeConfig.lockDir, { drain: true });
  try {
    const other = sessionUnbind('session-other-target');
    assert.deepEqual(await control(f.file, other), { ...expected, operationId: other.operationId });
    assert.deepEqual(await control(f.file, other), { ...expected, operationId: other.operationId, replayed: true });
    assert.deepEqual(await control(f.file, absent), { ...expected, replayed: true });
    assert.equal(runner.stopRequested(), false);
  } finally { runner.release(); }
  const after = readControl(activeConfig);
  assert.deepEqual(after.active, before.active);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(fs.readFileSync(path.join(activeConfig.stateDir, 'bridge.sqlite')), newData);
  await assert.rejects(control(f.file, sessionUnbind(absent.operationId, 'session-two')),
    { code: 'OPERATION_ID_CONFLICT' });
  await assert.rejects(control(f.file, unbind(absent.operationId)), { code: 'OPERATION_ID_CONFLICT' });
  assert.equal(f.requests.length, 1);
});

test('session-unbind applies existing exact-target pending/unknown and safe-runner fences', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const runner = new RunLock(config.lockDir, { drain: true });
  try {
    const result = await wire(f.file, sessionUnbind('session-busy'));
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, 'RUNNING');
    assert.equal(runner.stopRequested(), false);
  } finally { runner.release(); }
  const originalState = readControl(config);
  assert.equal(originalState.operations['session-busy'], undefined);
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  store.set('binding', { sessionId: 'session-one', cwd: '/fixture/workspace' });
  for (const [job, code] of [
    [{ id: 'queued', status: 'queued' }, 'PENDING_JOBS'],
    [{ id: 'prompting', status: 'prompting' }, 'UNKNOWN_OUTCOMES'],
    [{ id: 'sending', status: 'replying', outbox: [{ status: 'sending' }] }, 'UNKNOWN_OUTCOMES'],
    [{ id: 'unknown', status: 'blocked', outbox: [{ status: 'unknown' }] }, 'UNKNOWN_OUTCOMES'],
  ]) {
    store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id, 1, JSON.stringify(job));
    const request = sessionUnbind(`session-refuse-${job.id}`);
    await assert.rejects(control(f.file, request), { code });
    await assert.rejects(control(f.file, request), { code });
    assert.deepEqual(store.job(job.id), job);
    assert.deepEqual(readControl(config), originalState);
    store.db.prepare('DELETE FROM jobs').run();
  }
  for (const [key, value, code] of [
    ['pendingBatch', { msgs: [] }, 'PENDING_INBOX_BATCH'],
    ['nativeFollowup', { phase: 'requesting' }, 'NATIVE_FOLLOWUP_UNRESOLVED'],
    ['statusDisplay', { typingMayBeActive: true }, 'TYPING_STATE_UNRESOLVED'],
  ]) {
    store.set(key, value);
    await assert.rejects(control(f.file, sessionUnbind(`session-refuse-${key}`)), { code });
    assert.deepEqual(store.get(key), value);
    assert.deepEqual(readControl(config), originalState);
    store.set(key, null);
  }
  assert.equal(readControl(config).active.sessionId, 'session-one');
  assert.equal(readControl(config).revision, 1);
  assert.equal(f.requests.length, 1);
});

for (const reason of ['RUNNING', 'PENDING_JOBS']) {
  test(`session-unbind ${reason} preflight permits explicit same-ID continuation after safe settlement`, async t => {
    const f = await fixture(t);
    await control(f.file, bind());
    const config = loadConfig(f.file);
    const stateBefore = fs.readFileSync(controlFile(config));
    const request = sessionUnbind('session-continue');
    const store = new Store(config.stateDir);
    t.after(() => store.close());
    store.set('binding', { sessionId: 'session-one', cwd: '/fixture/workspace' });
    let runner;
    if (reason === 'RUNNING') runner = new RunLock(config.lockDir, { drain: true });
    else store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('pending', 1,
      JSON.stringify({ id: 'pending', status: 'queued', original: 'retained input' }));
    try {
      const refused = await wire(f.file, request);
      assert.equal(refused.code, 2);
      assert.deepEqual(JSON.parse(refused.stdout), { ok: false, error: { code: reason } });
      assert.deepEqual(fs.readFileSync(controlFile(config)), stateBefore);
      if (runner) assert.equal(runner.stopRequested(), false);
      else assert.equal(store.job('pending').status, 'queued');
    } finally { runner?.release(); }
    // Model a separately authorized, known completion; the adapter never settles jobs.
    if (reason === 'PENDING_JOBS') store.save({ ...store.job('pending'), status: 'done' });
    const continued = await wire(f.file, request);
    assert.equal(continued.code, 0, continued.stdout);
    const expected = { ok: true, operationId: request.operationId,
      sessionId: 'session-one', unbound: true, replayed: false };
    assert.deepEqual(JSON.parse(continued.stdout), expected);
    assert.deepEqual(JSON.parse((await wire(f.file, request)).stdout), { ...expected, replayed: true });
    const state = readControl(config);
    assert.equal(state.active, null);
    assert.equal(state.history[0].stateDir, config.stateDir);
    assert.equal(state.revision, 2);
    assert.equal(state.operations[request.operationId].phase, 'complete');
    assert.deepEqual(store.get('binding'), { sessionId: 'session-one', cwd: '/fixture/workspace' });
    if (reason === 'PENDING_JOBS') assert.equal(store.job('pending').status, 'done');
    assert.equal(f.requests.length, 1);
  });
}

test('session-unbind preserves strict readback for failures already durably recorded by older code', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const request = sessionUnbind('session-old-failure');
  const result = { ok: false, operationId: request.operationId,
    sessionId: request.sessionId, error: { code: 'RUNNING' } };
  const state = readControl(config);
  state.operations[request.operationId] = { phase: 'complete', request, result };
  writePrivate(controlFile(config), state);
  assert.deepEqual(await control(f.file, request), { ...result, replayed: true });
  assert.deepEqual(readControl(config), state);
  assert.equal(f.requests.length, 1);
});

test('session-unbind racing a rebind cannot remove or reinterpret the newer target', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  await control(f.file, sessionUnbind());
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  t.after(() => release());
  const rebinding = control(f.file, bind('bind-second', 'session-two'));
  const until = Date.now() + 5000;
  while (f.requests.length < 2 && Date.now() < until) await delay(5);
  assert.equal(f.requests.length, 2);
  const request = sessionUnbind('session-after-rebind');
  const busy = await wire(f.file, request);
  assert.equal(JSON.parse(busy.stdout).error.code, 'MODULE_CONTROL_BUSY');
  release();
  assert.equal((await rebinding).ok, true);
  const config = loadConfig(f.file);
  const before = readControl(config);
  const result = await wire(f.file, request);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, operationId: request.operationId,
    sessionId: 'session-one', unbound: true, replayed: false });
  const after = readControl(config);
  assert.deepEqual(after.active, before.active);
  assert.deepEqual(after.history, before.history);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(await control(f.file, sessionUnbind()), { ok: true, operationId: 'session-unbind-first',
    sessionId: 'session-one', unbound: true, replayed: true });
  assert.equal(f.requests.length, 2);
});

test('session-unbind receipt never unbinds a later generation even for the same session ID', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const receipt = await control(f.file, sessionUnbind());
  await control(f.file, bind('bind-same-session-again'));
  const config = loadConfig(f.file);
  const before = readControl(config);
  assert.notEqual(before.active.id, before.history[0].id);
  assert.deepEqual(await control(f.file, sessionUnbind()), { ...receipt, replayed: true });
  assert.deepEqual(readControl(config), before);
  assert.equal(config.cockpit.sessionId, 'session-one');
  assert.equal(f.requests.length, 2);
});

test('session-unbind unknown receipts never replay or resolve, and its wire rejects cwd or missing identity', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const state = readControl(config);
  const request = sessionUnbind('session-uncertain');
  state.operations[request.operationId] = { phase: 'pending', request };
  writePrivate(controlFile(config), state);
  for (const input of [request, sessionUnbind('session-another'), sessionUnbind('session-other', 'session-two')]) {
    const result = await wire(f.file, input);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.code, 'OPERATION_OUTCOME_UNKNOWN');
  }
  assert.deepEqual(readControl(config), state);
  for (const input of [{ ...request, cwd: '/unnecessary' }, { operation: 'session-unbind' },
    { ...request, sessionId: 'bad/session' }, { ...request, operationId: 'short' }]) {
    const result = await wire(f.file, input);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(result.stdout.length < 16384);
  }
  assert.equal(f.requests.length, 1);
});

test('status never recovers old jobs, and unbind refuses every unresolved work category', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  store.set('binding', storedBinding(config));
  const cases = [
    [{ id: 'pending', status: 'queued' }, 'PENDING_JOBS'],
    [{ id: 'prompt', status: 'prompting' }, 'UNKNOWN_OUTCOMES'],
    [{ id: 'sending', status: 'replying', outbox: [{ status: 'sending' }] }, 'UNKNOWN_OUTCOMES'],
    [{ id: 'unknown', status: 'blocked', outbox: [{ status: 'unknown' }] }, 'UNKNOWN_OUTCOMES'],
  ];
  for (const [job, reason] of cases) {
    store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id, 1, JSON.stringify(job));
    const before = store.job(job.id);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const status = await control(f.file, { operation: 'status' });
    assert.equal(status.status.reason, reason);
    assert.equal(status.status.bindingConfirmed, true);
    const result = await control(f.file, unbind(`unbind-${job.id}`));
    assert.equal(result.error.code, reason);
    assert.deepEqual(store.job(job.id), before);
    store.db.prepare('DELETE FROM jobs').run();
  }
  for (const [key, value, reason] of [
    ['pendingBatch', { msgs: [] }, 'PENDING_INBOX_BATCH'],
    ['nativeFollowup', { phase: 'requesting' }, 'NATIVE_FOLLOWUP_UNRESOLVED'],
    ['statusDisplay', { typingMayBeActive: true }, 'TYPING_STATE_UNRESOLVED'],
  ]) {
    store.set(key, value);
    assert.equal((await control(f.file, unbind(`unbind-${key}`))).error.code, reason);
    assert.deepEqual(store.get(key), value);
    store.set(key, null);
  }
  const images = path.join(config.stateDir, 'image-deliveries');
  fs.mkdirSync(images, { mode: 0o700 });
  writePrivate(path.join(images, 'attempt.json'), { status: 'sending_image', token: 'PRIVATE_IMAGE_DATA' });
  assert.equal((await control(f.file, unbind('unbind-image'))).error.code, 'UNKNOWN_OUTCOMES');
  assert.equal(f.requests.length, 1);
});

test('unbind retains Store binding/checkpoints and config backup; clean rebind creates separate state', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const oldConfig = loadConfig(f.file);
  const store = new Store(oldConfig.stateDir);
  store.set('binding', { sessionId: 'session-one', cwd: '/fixture/workspace' });
  store.set('historyCheckpoint', { id: 'old-message', fingerprint: 'old-hash' });
  store.close();
  const dbBefore = fs.readFileSync(path.join(oldConfig.stateDir, 'bridge.sqlite'));
  await control(f.file, unbind());
  assert.deepEqual(fs.readFileSync(path.join(oldConfig.stateDir, 'bridge.sqlite')), dbBefore);
  const second = await control(f.file, bind('bind-second', 'session-two'));
  assert.equal(second.ok, true);
  const newConfig = loadConfig(f.file);
  assert.notEqual(newConfig.stateDir, oldConfig.stateDir);
  assert.equal(newConfig.credentialFile, oldConfig.credentialFile);
  assert.deepEqual(fs.readdirSync(newConfig.stateDir), []);
  const state = readControl(newConfig);
  assert.deepEqual(state.configBackup, f.raw);
  assert.equal(state.history[0].stateDir, oldConfig.stateDir);
  writePrivate(f.file, { ...f.raw, limits: { ...f.raw.limits, statusIntervalMs: 30 } });
  assert.throws(() => loadConfig(f.file), { code: 'MODULE_CONFIG_CHANGED' });
  writePrivate(f.file, state.configBackup);
  assert.equal(loadConfig(f.file).cockpit.sessionId, 'session-two');
  const replay = await control(f.file, bind());
  assert.equal(replay.boundSessionId, 'session-one');
  assert.equal(replay.revision, 1);
  assert.equal(loadConfig(f.file).cockpit.sessionId, 'session-two');
});

test('terminal inbox history is archived but never silently migrated or replayed on rebind', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const store = new Store(config.stateDir);
  store.set('cursor', 'old-inbox-cursor');
  store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run('terminal', 1,
    JSON.stringify({ id: 'terminal', status: 'done', original: 'PRIVATE_OLD_MESSAGE' }));
  store.close();
  assert.equal((await control(f.file, unbind())).ok, true);
  assert.equal((await control(f.file, { operation: 'status' })).status.reason, 'REBIND_HISTORY_REVIEW_REQUIRED');
  const result = await control(f.file, bind('bind-second', 'session-two'));
  assert.equal(result.error.code, 'REBIND_HISTORY_REVIEW_REQUIRED');
  assert.equal(f.requests.length, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_OLD_MESSAGE'));
});

test('missing active or archived state is unknown, never automatically recreated as an empty binding', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const held = `${config.stateDir}-retained`;
  fs.renameSync(config.stateDir, held);
  await assert.rejects(control(f.file, unbind()), { code: 'MODULE_BINDING_STATE_MISSING' });
  assert.equal((await cli(f.file, ['run']).done).code, 2);
  assert.equal(fs.existsSync(config.stateDir), false);
  fs.renameSync(held, config.stateDir);
  await control(f.file, unbind());
  fs.renameSync(config.stateDir, held);
  await assert.rejects(control(f.file, bind('bind-new', 'session-two')), { code: 'MODULE_BINDING_STATE_MISSING' });
  assert.equal(f.requests.length, 1);
});

test('stale snapshots and changed reference during native verification cannot activate a target', async t => {
  const f = await fixture(t);
  const stale = loadConfig(f.file);
  await control(f.file, bind());
  const gate = acquireModuleGate(stale);
  try { assert.throws(() => assertCurrentConfig(stale), { code: 'MODULE_CONFIG_STALE' }); }
  finally { gate.release(); }
  await control(f.file, unbind());
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const binding = control(f.file, bind('bind-delayed', 'session-two'));
  while (f.requests.length < 2) await delay(5);
  writePrivate(f.file, { ...f.raw, limits: { ...f.raw.limits, statusIntervalMs: 30 } });
  release();
  assert.equal((await binding).error.code, 'MODULE_CONFIG_CHANGED');
  writePrivate(f.file, f.raw);
  assert.equal(loadConfig(f.file).cockpit.sessionId, '');
});

test('unknown operation fences mutations and stale locks require explicit operator recovery', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const state = readControl(config);
  state.operations['uncertain-operation'] = { phase: 'pending', request: unbind('uncertain-operation') };
  writePrivate(controlFile(config), state);
  const status = await control(f.file, { operation: 'status' });
  assert.equal(status.status.reason, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(status.status.bindingConfirmed, false);
  await assert.rejects(control(f.file, unbind('uncertain-operation')), { code: 'OPERATION_OUTCOME_UNKNOWN' });
  await assert.rejects(control(f.file, unbind()), { code: 'OPERATION_OUTCOME_UNKNOWN' });
  const refused = await cli(f.file, ['run']).done;
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /OPERATION_OUTCOME_UNKNOWN/);
  const runner = new RunLock(config.lockDir, { drain: true });
  try {
    assert.equal((await control(f.file, { operation: 'status' })).status.running, true);
    assert.equal((await control(f.file, { operation: 'status' })).status.bindingConfirmed, false);
    assert.equal((await cli(f.file, ['unlock', '--confirm']).done).code, 2);
  } finally { runner.release(); }
});

test('real CLI cannot start with a snapshot superseded before its stable gate acquisition', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const old = loadConfig(f.file);
  const preload = path.join(f.dir, 'stale-preload.js');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const open = fs.openSync;
    let changed = false;
    fs.openSync = function(file, ...args) {
      if (!changed && file === ${JSON.stringify(path.join(f.raw.lockDir, 'module-control', 'run.lock'))}
        && args[0] === 'wx') {
        changed = true;
        const result = spawnSync(process.execPath,
          ['src/module-control.js', '--config', ${JSON.stringify(f.file)}],
          { input: ${JSON.stringify(JSON.stringify(unbind()))}, encoding: 'utf8' });
        if (result.status !== 0) throw new Error('Fixture unbind failed');
      }
      return open.call(this, file, ...args);
    };
  `, { mode: 0o600 });
  const result = await processResult(spawn(process.execPath,
    ['--import', preload, 'src/cli.js', 'run', '--config', f.file],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })).done;
  assert.equal(result.code, 2);
  assert.match(result.stderr, /MODULE_CONFIG_STALE/);
  assert.equal(loadConfig(f.file).cockpit.sessionId, '');
  assert.equal(fs.existsSync(path.join(old.stateDir, 'bridge.sqlite')), false);
  assert.equal(fs.existsSync(path.join(old.lockDir, 'run.lock')), false);
  assert.equal(f.requests.length, 1);
});

test('crashed child retains pending operation and config backup; explicit unlock does not resolve it', async t => {
  const f = await fixture(t);
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const child = spawn(process.execPath, ['src/module-control.js', '--config', f.file],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = processResult(child);
  child.stdin.end(JSON.stringify(bind()));
  t.after(() => {
    release();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  const until = Date.now() + 5000;
  while (f.requests.length === 0 && Date.now() < until) await delay(5);
  assert.equal(f.requests.length, 1);
  child.kill('SIGTERM');
  assert.equal((await output.done).signal, 'SIGTERM');
  release();
  const state = readPrivate(path.join(f.raw.lockDir, 'module-binding.json'));
  assert.equal(state.operations['bind-first'].phase, 'pending');
  assert.deepEqual(state.configBackup, f.raw);
  assert.equal((await cli(f.file, ['unlock', '--confirm']).done).code, 0);
  const status = await wire(f.file, { operation: 'status' });
  assert.equal(JSON.parse(status.stdout).status.reason, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(JSON.parse((await wire(f.file, bind())).stdout).error.code, 'OPERATION_OUTCOME_UNKNOWN');
  assert.equal(f.requests.length, 1);
  assert.equal(fs.existsSync(f.raw.stateDir), false);
});

test('unconfigured native target verification failures are persisted without creating state or retrying reads', async t => {
  const f = await fixture(t);
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    return new Response(JSON.stringify({ meta: null }), { headers: { 'content-type': 'application/json' } });
  };
  const failed = await control(f.file, bind(), { fetchImpl });
  assert.equal(failed.error.code, 'TARGET_SESSION_MISSING');
  assert.deepEqual(await control(f.file, bind(), { fetchImpl }), { ...failed, replayed: true });
  assert.equal(requests, 1);
  assert.equal(fs.existsSync(f.raw.stateDir), false);
});

test('legacy status exposes existing target without creating a database, lock or adopting configuration', async t => {
  const f = await fixture(t);
  const raw = { ...f.raw, moduleManaged: false,
    cockpit: { ...f.raw.cockpit, sessionId: 'legacy-session', cwd: '/legacy' } };
  writePrivate(f.file, raw);
  const before = fs.readdirSync(f.dir);
  const result = await control(f.file, { operation: 'status' });
  assert.equal(result.status.reason, 'ALREADY_BOUND');
  assert.equal(result.status.boundSessionId, 'legacy-session');
  assert.equal(result.status.bindingConfirmed, false);
  assert.deepEqual(fs.readdirSync(f.dir), before);
  await assert.rejects(control(f.file, unbind()), { code: 'LEGACY_ADOPTION_REQUIRED' });
  assert.equal(f.requests.length, 0);
});

test('bounded strict wire responses and configuration-not-ready do not leak private data', async t => {
  const f = await fixture(t);
  for (const value of ['invalid', '{}', 'x'.repeat(16385), JSON.stringify({ ...bind(), token: 'PRIVATE' })]) {
    const result = await wire(f.file, value);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(result.stdout.length < 16384);
    assert.ok(!result.stdout.includes('PRIVATE'));
  }
  fs.unlinkSync(f.raw.credentialFile);
  const status = JSON.parse((await wire(f.file, { operation: 'status' })).stdout).status;
  assert.equal(status.configReady, false);
  assert.equal(status.credentialsPresent, false);
  assert.equal(status.reason, 'NOT_CONFIGURED');
  assert.equal(f.requests.length, 0);
});

test('protected Cockpit token-file reference authenticates native bind reads without copying or exposing tokens', async t => {
  const f = await fixture(t);
  const inherited = process.env.COCKPIT_API_TOKEN;
  delete process.env.COCKPIT_API_TOKEN;
  t.after(() => {
    if (inherited === undefined) delete process.env.COCKPIT_API_TOKEN;
    else process.env.COCKPIT_API_TOKEN = inherited;
  });
  const token = 'FAKE_GATEWAY_FILE_TOKEN';
  const tokenFile = path.join(f.dir, 'gateway-token.txt');
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  f.raw.cockpit.tokenFile = tokenFile;
  writePrivate(f.file, f.raw);
  assert.equal((await control(f.file, { operation: 'status' })).status.configReady, true);
  assert.equal(f.requests.length, 0);
  const result = await wire(f.file, bind());
  assert.equal(result.code, 0, result.stdout);
  assert.equal(f.requests[0].authorization, `Bearer ${token}`);
  assert.equal(f.requests[0].url, '/intent/session/get');
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
  assert.ok(!fs.readFileSync(controlFile(loadConfig(f.file)), 'utf8').includes(token));
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), `${token}\n`);
  assert.throws(() => new CockpitClient(loadConfig(f.file), { token: 'FAKE_SECOND_AUTHORITY' }),
    { code: 'COCKPIT_TOKEN_AUTHORITY_CONFLICT' });
  for (const content of ['', 'has spaces', 'two\nlines', 'extra-newline\n\n', 'x'.repeat(16385)]) {
    fs.writeFileSync(tokenFile, content);
    const status = (await control(f.file, { operation: 'status' })).status;
    assert.equal(status.configReady, false);
    assert.equal(status.configReason, 'COCKPIT_TOKEN_FILE_INVALID');
  }
  fs.writeFileSync(tokenFile, token);
  fs.chmodSync(tokenFile, 0o644);
  assert.equal((await control(f.file, { operation: 'status' })).status.configReason, 'INSECURE_STATE_PERMISSIONS');
  fs.chmodSync(tokenFile, 0o600);
  const linked = path.join(f.dir, 'gateway-token-link.txt');
  fs.symlinkSync(tokenFile, linked);
  assert.throws(() => new CockpitClient({ ...loadConfig(f.file),
    cockpit: { ...f.raw.cockpit, tokenFile: linked } }), { code: 'UNSAFE_STATE_PATH' });
  fs.unlinkSync(tokenFile);
  assert.equal((await control(f.file, { operation: 'status' })).status.configReason, 'COCKPIT_TOKEN_FILE_READ_FAILED');
  assert.equal(f.requests.length, 1);
});

test('real managed CLI runner shares stable lock with offline mutations, status, stop and unlock', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const reserved = net.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const lifecyclePort = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const moduleEnv = { COCKPIT_MODULE_ID: 'wechat', COCKPIT_MODULE_VERSION: actualVersion,
    COCKPIT_MODULE_DIGEST: 'c'.repeat(64), COCKPIT_MODULE_INSTANCE: randomUUID(),
    COCKPIT_MODULE_PORT: String(lifecyclePort), SERVICE_DELIVERY_PORT: undefined,
    SERVICE_DELIVERY_SHA: undefined, SERVICE_DELIVERY_ARTIFACT: undefined,
    SERVICE_DELIVERY_REQUEST: undefined, SERVICE_DELIVERY_INSTANCE: undefined };
  const runner = cli(f.file, ['run'], { preload: true, env: { TEST_MOCK_PORT: String(f.port), ...moduleEnv } });
  t.after(async () => {
    if (runner.child.exitCode === null && runner.child.signalCode === null) {
      runner.child.kill('SIGTERM');
      await runner.done;
    }
  });
  const until = Date.now() + 5000;
  while (!f.requests.some(req => req.url === '/weixin/ilink/bot/getupdates') && Date.now() < until) {
    if (runner.child.exitCode !== null) assert.fail(JSON.stringify(await runner.done));
    await delay(10);
  }
  assert.ok(f.requests.some(req => req.url === '/weixin/ilink/bot/getupdates'));
  const lifecycleUrl = `http://127.0.0.1:${lifecyclePort}`;
  const version = await (await fetch(`${lifecycleUrl}/version`)).json();
  assert.deepEqual(version, { moduleApi: 1, moduleId: 'wechat', moduleDigest: moduleEnv.COCKPIT_MODULE_DIGEST,
    instanceId: moduleEnv.COCKPIT_MODULE_INSTANCE, version: actualVersion, moduleVersion: actualVersion });
  assert.deepEqual(await (await fetch(`${lifecycleUrl}/health`)).json(),
    { ...version, running: true, ok: true, phase: 'running' });
  assert.ok(readPrivate(path.join(config.lockDir, 'run.lock')));
  assert.equal(fs.existsSync(path.join(config.stateDir, 'run.lock')), false);
  const runningStatus = (await control(f.file, { operation: 'status' })).status;
  assert.equal(runningStatus.running, true);
  assert.equal(runningStatus.bindingConfirmed, true);
  assert.equal(runningStatus.detailsAvailable, false);
  assert.equal(JSON.parse((await cli(f.file).done).stdout).running, true);
  await assert.rejects(control(f.file, unbind()), { code: 'RUNNING' });
  assert.equal((await cli(f.file, ['run']).done).code, 2);
  assert.equal((await cli(f.file, ['unlock', '--confirm']).done).code, 2);
  assert.equal((await cli(f.file, ['stop']).done).code, 0);
  const stopped = await runner.done;
  assert.equal(stopped.code, 0, stopped.stderr);
  await assert.rejects(fetch(`${lifecycleUrl}/version`));
  assert.equal(fs.existsSync(path.join(config.lockDir, 'run.lock')), false);
  assert.equal((await control(f.file, unbind())).ok, true);
  assert.equal((await cli(f.file, ['run']).done).code, 2);
  assert.ok(!f.requests.some(req => /sendmessage|\/intent\/prompt$|interrupt|cancel/.test(req.url)));
});
