import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { control } from '../src/module-control.js';
import { CockpitClient } from '../src/cockpit.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { acquireModuleGate, assertCurrentConfig, controlFile, readControl } from '../src/module-state.js';
import { readPrivate, RunLock, Store, writePrivate } from '../src/storage.js';

const root = path.resolve(import.meta.dirname, '..');
const credentials = { account: 'fixture-account', peer: 'fixture-peer', token: 'FAKE_PRIVATE_TOKEN',
  baseUrl: 'https://ilinkai.weixin.qq.com' };
const bind = (operationId = 'bind-first', sessionId = 'session-one') => ({
  operation: 'bind', operationId, sessionId, cwd: '/fixture/workspace',
});
const unbind = (operationId = 'unbind-first', sessionId = 'session-one') => ({
  operation: 'unbind', operationId, sessionId, cwd: '/fixture/workspace',
});

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

test('official manifest, validated paths and unchanged legacy defaults', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'module.json')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.roles.map(role => Object.keys(role).sort()), [['description', 'id', 'name']]);
  assert.equal(manifest.binding, 'wechat');
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

test('status never recovers old jobs, and unbind refuses every unresolved work category', async t => {
  const f = await fixture(t);
  await control(f.file, bind());
  const config = loadConfig(f.file);
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  store.set('binding', { sessionId: config.cockpit.sessionId, cwd: config.cockpit.cwd });
  const cases = [
    [{ id: 'pending', status: 'queued' }, 'PENDING_JOBS'],
    [{ id: 'prompt', status: 'prompting' }, 'UNKNOWN_OUTCOMES'],
    [{ id: 'sending', status: 'replying', outbox: [{ status: 'sending' }] }, 'UNKNOWN_OUTCOMES'],
    [{ id: 'unknown', status: 'blocked', outbox: [{ status: 'unknown' }] }, 'UNKNOWN_OUTCOMES'],
  ];
  for (const [job, reason] of cases) {
    store.db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(job.id, 1, JSON.stringify(job));
    const before = store.job(job.id);
    const status = await control(f.file, { operation: 'status' });
    assert.equal(status.status.reason, reason);
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
  await assert.rejects(control(f.file, unbind('uncertain-operation')), { code: 'OPERATION_OUTCOME_UNKNOWN' });
  await assert.rejects(control(f.file, unbind()), { code: 'OPERATION_OUTCOME_UNKNOWN' });
  const refused = await cli(f.file, ['run']).done;
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /OPERATION_OUTCOME_UNKNOWN/);
  const runner = new RunLock(config.lockDir, { drain: true });
  try {
    assert.equal((await control(f.file, { operation: 'status' })).status.running, true);
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
  const moduleEnv = { COCKPIT_MODULE_ID: 'wechat', COCKPIT_MODULE_VERSION: '0.1.0',
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
    instanceId: moduleEnv.COCKPIT_MODULE_INSTANCE, version: '0.1.0', moduleVersion: '0.1.0' });
  assert.deepEqual(await (await fetch(`${lifecycleUrl}/health`)).json(),
    { ...version, running: true, ok: true, phase: 'running' });
  assert.ok(readPrivate(path.join(config.lockDir, 'run.lock')));
  assert.equal(fs.existsSync(path.join(config.stateDir, 'run.lock')), false);
  assert.equal((await control(f.file, { operation: 'status' })).status.running, true);
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
