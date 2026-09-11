import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lifecycleConfig, startLifecycle } from '../src/lifecycle.js';

const env = {
  SERVICE_DELIVERY_PORT: '39123',
  SERVICE_DELIVERY_SHA: 'a'.repeat(40),
  SERVICE_DELIVERY_ARTIFACT: 'b'.repeat(64),
  SERVICE_DELIVERY_REQUEST: 'fixture-request',
  SERVICE_DELIVERY_INSTANCE: 'fixture-instance',
};

test('lifecycle is optional and strictly captures identity without repository fallbacks', () => {
  assert.equal(lifecycleConfig({ SERVICE_DELIVERY_SHA: 'invalid' }), null);
  const input = { ...env };
  const config = lifecycleConfig(input);
  input.SERVICE_DELIVERY_SHA = 'c'.repeat(40);
  assert.equal(config.identity.sha, env.SERVICE_DELIVERY_SHA);
  assert.ok(Object.isFrozen(config.identity));
  assert.equal(lifecycleConfig({ ...env, SERVICE_DELIVERY_SHA: 'c'.repeat(64) }).identity.sha.length, 64);
  for (const port of ['', '0', '65536', '1.0', ' 123', '0123', '-1', 'http://localhost', '123\n']) {
    assert.throws(() => lifecycleConfig({ ...env, SERVICE_DELIVERY_PORT: port }),
      { code: 'SERVICE_DELIVERY_PORT_INVALID' });
  }
  for (const name of ['SERVICE_DELIVERY_SHA', 'SERVICE_DELIVERY_ARTIFACT', 'SERVICE_DELIVERY_REQUEST',
    'SERVICE_DELIVERY_INSTANCE']) {
    for (const value of [undefined, '', 'a/b', '\n', 'x'.repeat(121), `${env[name]}\n`]) {
      assert.throws(() => lifecycleConfig({ ...env, [name]: value }), { code: 'SERVICE_DELIVERY_IDENTITY_INVALID' });
    }
  }
  assert.throws(() => lifecycleConfig({ ...env, SERVICE_DELIVERY_SHA: 'A'.repeat(40) }),
    { code: 'SERVICE_DELIVERY_IDENTITY_INVALID' });
});

test('CLI ignores lifecycle configuration outside run, and rejects invalid run identity before profile access', async () => {
  const invoke = (...args) => promisify(execFile)(process.execPath, ['src/cli.js', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env, SERVICE_DELIVERY_SHA: 'invalid' },
  });
  assert.match((await invoke('help')).stdout, /Weixin/);
  await assert.rejects(invoke('run', '--config', 'fixture-profile-must-not-exist.json'), error => {
    assert.match(error.stderr, /SERVICE_DELIVERY_IDENTITY_INVALID/);
    return true;
  });
});

test('loopback lifecycle exposes bounded identity/phase, rejects browser control, and closes without restart', async t => {
  const reserved = net.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const config = lifecycleConfig({ ...env, SERVICE_DELIVERY_PORT: String(port) });
  const state = { running: true, ready: false, drainRequested: false };
  let requests = 0;
  const control = await startLifecycle(config, {
    state: () => ({ ...state, privateText: 'must never be returned' }),
    requestDrain: () => { requests++; state.drainRequested = true; },
  });
  t.after(() => control.close());
  const url = `http://127.0.0.1:${port}`;
  const get = async path => {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  assert.deepEqual(await get('/version'), config.identity);
  assert.deepEqual(await get('/health'), { instanceId: env.SERVICE_DELIVERY_INSTANCE,
    running: true, ok: false, phase: 'starting' });
  state.ready = true;
  assert.equal((await get('/health')).ok, true);
  const post = (body, headers = {}) => fetch(`${url}/admin/restart`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });
  const raw = (method, path, headers, body) => new Promise((resolve, reject) => {
    const request = http.request(`${url}${path}`, { method, headers }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(body);
  });
  for (const headers of [{ origin: 'http://evil.example' }, { origin: 'null' },
    { origin: url }, { host: `evil.example:${port}` }, { 'sec-fetch-site': 'same-origin' }]) {
    assert.equal(await raw('POST', '/admin/restart',
      { 'content-type': 'application/json', ...headers }, '{"pending":true}'), 403);
    assert.equal(await raw('GET', '/version', headers), 403);
  }
  for (const body of ['{}', '{"pending":false}', '{"pending":true,"force":true}', 'null', '[]', '{']) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post('{"pending":true}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(`${' '.repeat(1024)}{"pending":true}`)).status, 400);
  assert.equal((await fetch(`${url}/admin/restart`)).status, 404);
  assert.equal((await fetch(`${url}/status?private=true`)).status, 404);
  assert.equal(requests, 0);
  assert.equal((await post('{"pending":true}')).status, 200);
  assert.equal(requests, 1);
  assert.deepEqual(await get('/status'), { instanceId: env.SERVICE_DELIVERY_INSTANCE,
    drainProtocol: 1, running: true, restartPending: true, phase: 'draining', reason: 'bridge-draining' });
  assert.equal((await get('/health')).ok, false);
  assert.deepEqual(await get('/version'), config.identity);
});

test('lifecycle bind failure is explicit and does not request drain', async t => {
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const config = lifecycleConfig({ ...env, SERVICE_DELIVERY_PORT: String(occupied.address().port) });
  await assert.rejects(startLifecycle(config, { state: () => ({}), requestDrain: () => assert.fail() }),
    { code: 'EADDRINUSE' });
});
