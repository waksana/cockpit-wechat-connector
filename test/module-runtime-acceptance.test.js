import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { readPrivate, writePrivate } from '../src/storage.js';

const root = path.resolve(import.meta.dirname, '..');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function childResult(child) {
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exit = once(child, 'exit').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, exit };
}

function localRequest(origin, route, body) {
  const url = new URL(route, origin);
  assert.equal(url.hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(3000, () => request.destroy(new Error('Fixture lifecycle request timeout')));
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('committed WeChat archive runs its real service entry, attests identity, and naturally drains over HTTP', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-runtime-acceptance-'));
  const release = path.join(dir, 'release');
  fs.mkdirSync(release, { mode: 0o700 });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const archive = path.join(dir, 'release.tar');
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, commit,
    'src', 'module.json', 'package.json', 'package-lock.json'], { cwd: root });
  execFileSync('tar', ['-xf', archive, '-C', release]);
  const manifest = JSON.parse(fs.readFileSync(path.join(release, 'module.json')));
  assert.equal(manifest.id, 'wechat');
  assert.deepEqual(manifest.service.args, ['run']);
  assert.equal(manifest.service.entry, 'src/cli.js');
  assert.equal(fs.existsSync(path.join(release, 'test')), false);
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(release, 'package.json'))).version);
  const cliHash = sha256(path.join(release, manifest.service.entry));
  assert.equal(cliHash, createHash('sha256')
    .update(execFileSync('git', ['show', `${commit}:src/cli.js`], { cwd: root })).digest('hex'));
  const digest = sha256(archive);
  const provider = path.join(dir, 'provider.mjs');
  fs.copyFileSync(path.join(root, 'test/module-runtime-provider.js'), provider);
  const networkLog = path.join(dir, 'network.jsonl');
  const requests = [];
  let polling = false, pollAborted = false;
  const sessionId = randomUUID();
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  const providerServer = http.createServer(async (request, response) => {
    assert.equal(request.socket.remoteAddress, '127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ method: request.method, path: request.url });
    if (request.url === '/weixin/ilink/bot/getupdates') {
      assert.equal(request.headers.authorization, 'Bearer SYNTHETIC_WECHAT_TOKEN');
      assert.equal(body.get_updates_buf, '');
      polling = true;
      response.on('close', () => { pollAborted = true; });
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer SYNTHETIC_COCKPIT_TOKEN');
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/capabilities?')) {
      const name = new URL(request.url, 'http://fixture').searchParams.get('name');
      const fields = name === 'prompt' ? ['sessionId', 'text', 'mode']
        : name === 'session/get' ? ['sessionId'] : ['sessionId', 'cursor', 'max', 'source', 'direction'];
      response.end(JSON.stringify({ name, inputSchema: { properties: Object.fromEntries(fields.map(field =>
        [field, field === 'mode' ? { enum: ['enqueue'] } : {}])) }, resultSchema: {} }));
      return;
    }
    assert.equal(body.sessionId, sessionId);
    if (request.url === '/intent/session/get') {
      response.end(JSON.stringify({ meta: { sessionId, cwd: workspace,
        loaded: true, status: 'idle', queue: [], ask: null } }));
    } else if (request.url === '/intent/session/chat') {
      response.end(JSON.stringify({ sessionId, events: [], cursor: 'synthetic-cursor', liveCursor: 'synthetic-live',
        cursorStatus: 'ok', source: body.source, direction: body.direction, hasMore: false }));
    } else {
      assert.fail(`Unexpected fixture request: ${request.url}`);
    }
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${providerServer.address().port}`;
  const configFile = path.join(dir, 'config.json');
  const raw = {
    deliveryMode: 'correlated', moduleManaged: true,
    stateDir: path.join(dir, 'bindings'), lockDir: path.join(dir, 'control'),
    credentialFile: path.join(dir, 'credentials.json'),
    cockpit: { apiUrl: origin, webUrl: origin, sessionId: '', cwd: '',
      tokenFile: path.join(dir, 'cockpit-token.txt') },
    weixin: { allowedAccount: 'synthetic-bot', allowedPeer: 'synthetic-peer',
      approvedApiOrigins: ['https://ilinkai.weixin.qq.com'] },
    limits: { requestTimeoutMs: 3000, statusIntervalMs: 20 },
  };
  writePrivate(configFile, raw);
  writePrivate(raw.credentialFile, { account: 'synthetic-bot', peer: 'synthetic-peer',
    token: 'SYNTHETIC_WECHAT_TOKEN', baseUrl: 'https://ilinkai.weixin.qq.com' });
  fs.writeFileSync(raw.cockpit.tokenFile, 'SYNTHETIC_COCKPIT_TOKEN\n', { mode: 0o600 });
  const originalConfig = sha256(configFile), originalCredentials = sha256(raw.credentialFile);
  const originalApiToken = sha256(raw.cockpit.tokenFile);
  // Deliberately do not inherit production identity, auth, proxies or NODE_OPTIONS.
  const env = { PATH: process.env.PATH, HOME: dir,
    WECHAT_FIXTURE_ORIGIN: origin, WECHAT_FIXTURE_NETWORK_LOG: networkLog };
  let runner;
  t.after(async () => {
    if (runner && runner.child.exitCode === null && runner.child.signalCode === null) {
      runner.child.kill('SIGTERM');
      await runner.exit;
    }
    providerServer.closeAllConnections();
    await new Promise(resolve => providerServer.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const binder = childResult(spawn(process.execPath,
    ['--import', provider, path.join(release, 'src/module-control.js'), '--config', configFile],
    { cwd: release, env, stdio: ['pipe', 'pipe', 'pipe'] }));
  binder.child.stdin.end(JSON.stringify({ operation: 'bind', operationId: 'synthetic-bind-0001', sessionId, cwd: workspace }));
  const binding = await binder.exit;
  assert.equal(binding.code, 0, binding.stdout + binding.stderr);
  assert.equal(JSON.parse(binding.stdout).boundSessionId, sessionId);
  const reserved = net.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const moduleEnv = { COCKPIT_MODULE_ID: 'wechat', COCKPIT_MODULE_VERSION: manifest.version,
    COCKPIT_MODULE_DIGEST: digest, COCKPIT_MODULE_INSTANCE: randomUUID(), COCKPIT_MODULE_PORT: String(port) };
  const argv = ['--import', provider, path.join(release, manifest.service.entry),
    ...manifest.service.args, '--config', configFile];
  runner = childResult(spawn(process.execPath, argv, {
    cwd: release, env: { ...env, ...moduleEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const until = Date.now() + 10000;
  while (!polling && Date.now() < until && runner.child.exitCode === null) await delay(10);
  assert.ok(polling, runner.child.exitCode === null ? 'Real runner did not poll fixture' : JSON.stringify(await runner.exit));
  const serviceOrigin = `http://127.0.0.1:${port}`;
  const version = await localRequest(serviceOrigin, manifest.service.versionPath);
  const identity = { moduleApi: 1, moduleId: 'wechat', moduleDigest: digest,
    instanceId: moduleEnv.COCKPIT_MODULE_INSTANCE, version: manifest.version, moduleVersion: manifest.version };
  assert.equal(version.status, 200);
  assert.deepEqual(version.body, identity);
  const health = await localRequest(serviceOrigin, manifest.service.healthPath);
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ...identity, running: true, ok: true, phase: 'running' });
  const boundState = readPrivate(path.join(raw.lockDir, 'module-binding.json'));
  const databaseFiles = ['', '-wal', '-shm'].map(suffix => path.join(boundState.active.stateDir, `bridge.sqlite${suffix}`));
  const beforeProof = databaseFiles.map(file => fs.existsSync(file) ? sha256(file) : null);
  const requestsBeforeProof = requests.length;
  const reader = childResult(spawn(process.execPath,
    [path.join(release, 'src/module-control.js'), '--config', configFile],
    { cwd: release, env, stdio: ['pipe', 'pipe', 'pipe'] }));
  reader.child.stdin.end(JSON.stringify({ operation: 'status' }));
  const proofResult = await reader.exit;
  assert.equal(proofResult.code, 0, proofResult.stdout + proofResult.stderr);
  const bindingProof = JSON.parse(proofResult.stdout).status;
  assert.equal(bindingProof.bindingConfirmed, true);
  assert.equal(bindingProof.boundSessionId, sessionId);
  assert.equal(bindingProof.revision, boundState.revision);
  assert.equal(bindingProof.reason, 'RUNNING');
  assert.equal(bindingProof.detailsAvailable, false);
  assert.equal(bindingProof.pendingJobs, null);
  assert.equal(bindingProof.unknownJobs, null);
  assert.equal(requests.length, requestsBeforeProof);
  assert.deepEqual(databaseFiles.map(file => fs.existsSync(file) ? sha256(file) : null), beforeProof);
  const drain = await localRequest(serviceOrigin, manifest.service.drainPath, { pending: true });
  assert.equal(drain.status, 200);
  assert.deepEqual(drain.body, { ...identity, drainProtocol: 1, running: true,
    restartPending: true, phase: 'draining', reason: 'bridge-draining' });
  const stopped = await runner.exit;
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.signal, null);
  assert.match(stopped.stdout, /BRIDGE_DRAIN_REQUESTED/);
  assert.match(stopped.stdout, /BRIDGE_DRAINED/);
  assert.equal(pollAborted, true);
  assert.equal(fs.existsSync(path.join(raw.lockDir, 'run.lock')), false);
  await assert.rejects(localRequest(serviceOrigin, '/version'), { code: 'ECONNREFUSED' });
  const control = readPrivate(path.join(raw.lockDir, 'module-binding.json'));
  assert.equal(control.active.sessionId, sessionId);
  const db = new DatabaseSync(path.join(control.active.stateDir, 'bridge.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT data FROM jobs').all(), []);
    assert.equal(db.prepare("SELECT value FROM kv WHERE key='cursor'").get(), undefined);
  } finally { db.close(); }
  assert.equal(sha256(configFile), originalConfig);
  assert.equal(sha256(raw.credentialFile), originalCredentials);
  assert.equal(sha256(raw.cockpit.tokenFile), originalApiToken);
  const network = fs.readFileSync(networkLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(network.every(event => event.networkOrigin === origin));
  assert.equal(requests.filter(event => event.path === '/weixin/ilink/bot/getupdates').length, 1);
  assert.ok(requests.every(event => event.path.startsWith('/capabilities?')
    || ['/intent/session/get', '/intent/session/chat', '/weixin/ilink/bot/getupdates'].includes(event.path)));
  const report = { commit, archiveSha256: digest, entrySha256: cliHash, serviceEntry: manifest.service,
    config: raw, launchEnvironment: { ...env, ...moduleEnv }, argv, identity,
    health, bindingProof, drain, exit: stopped, network, pollAborted, retainedBinding: sessionId,
    jobs: 0, cursorSaved: false, credentialFilesUnchanged: true,
    digestAuthority: 'SHA-256 of the fixed-commit fixture archive, not a Cockpit catalog attestation',
    limits: 'Test-only transport redirects the real runner to synthetic loopback providers; no live account/token/native SDK acceptance.' };
  if (process.env.WECHAT_ACCEPTANCE_REPORT) {
    assert.ok(path.isAbsolute(process.env.WECHAT_ACCEPTANCE_REPORT));
    fs.writeFileSync(process.env.WECHAT_ACCEPTANCE_REPORT, JSON.stringify(report, null, 2),
      { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ commit, moduleVersion: manifest.version, moduleDigest: digest,
    instanceId: identity.instanceId, health: health.body.ok, exitCode: stopped.code, exitSignal: stopped.signal,
    pollRequests: 1, pollAborted, onlyLoopback: true, promptSendLoginRequests: 0 }));
});
