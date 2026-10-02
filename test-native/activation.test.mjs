import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { accountLease, readConfig, credentials, identity } from '../dist/config.js';
import { activate } from '../dist/index.js';
import { Store } from '../dist/state.js';

function context(root, config = {}) {
  const stopping = new AbortController();
  return { context: { apiVersion: 1, moduleId: 'wechat', dataRoot: root, apiBase: '/_modules/test',
    config, serviceReadyVersion: 1, shutdownVersion: 1, signal: new AbortController().signal,
    stopping: stopping.signal, report() {}, invalidate() {}, publish() {},
    host: { roleAssignmentVersion: 1, roleAvailabilityVersion: 1, sessionLoadVersion: 1, chatReadVersion: 1,
      promptReceiptVersion: 1, askResponseVersion: 1,
      async call() { throw new Error('NO_HOST_CALL_EXPECTED'); } } }, stopping };
}
test('unconfigured installation stays unavailable without reading credentials or calling host', async t => {
  const root = mkdtempSync(join(process.cwd(), '.wechat-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = context(root);
  const backend = await activate(fixture.context);
  await backend.onReady();
  const result = await backend.roleAssignments.availability({}, new AbortController().signal);
  assert(result.reasons.length >= 4);
  const status = await backend.routes.find(route => route.path === '/status').handler({});
  assert.equal(status.body.configured, false);
  assert.equal(status.body.binding, null);
  assert.equal(status.body.lastError, null);
  assert.deepEqual(status.body.receipts, []);
  assert.deepEqual(backend.routes.map(({ method, path }) => ({ method, path })), [{ method: 'GET', path: '/status' }]);
  for (const obsolete of ['inputs', 'outputs', 'fault']) assert(!(obsolete in status.body));
  fixture.stopping.abort();
  await backend.onStop();
  await backend.dispose();
});
test('credential provisioning requires exact identity and private regular file', t => {
  const root = mkdtempSync(join(process.cwd(), '.wechat-credentials-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'credentials.json');
  writeFileSync(path, JSON.stringify({ account: 'a', peer: 'p', token: 'synthetic-only' }), { mode: 0o600 });
  assert.equal(credentials(root, { account: 'a', peer: 'p' }).token, 'synthetic-only');
  assert.throws(() => credentials(root, { account: 'other', peer: 'p' }), /CREDENTIAL_IDENTITY/);
  const parsed = readConfig({ enabled: true, exclusiveAccountConfirmed: true, account: 'a', peer: 'p',
    fileRoots: [], webUrl: 'https://example.test' });
  assert.equal(parsed.reasons.length, 0);
});
test('account lease rejects a second native consumer and releases after close', async () => {
  const account = `synthetic-${process.pid}`;
  const first = await accountLease(account);
  try { await assert.rejects(accountLease(account)); } finally { await new Promise(resolve => first.close(resolve)); }
  const next = await accountLease(account);
  await new Promise(resolve => next.close(resolve));
});
test('private state refuses identity changes and unknown schema without rewriting old bytes', t => {
  const root = mkdtempSync(join(process.cwd(), '.wechat-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root, 'original');
  store.close();
  const before = readFileSync(join(root, 'native-v1.sqlite'));
  assert.throws(() => new Store(root, 'other'), /ACCOUNT_CONFIGURATION_CHANGED/);
  assert.deepEqual(readFileSync(join(root, 'native-v1.sqlite')), before);
  const db = new DatabaseSync(join(root, 'native-v1.sqlite'));
  db.exec('PRAGMA user_version=99');
  db.close();
  const unsupported = readFileSync(join(root, 'native-v1.sqlite'));
  assert.throws(() => new Store(root, 'original'), /STATE_SCHEMA_UNSUPPORTED/);
  assert.deepEqual(readFileSync(join(root, 'native-v1.sqlite')), unsupported);
});
test('module manifest is neutral and version matches package', () => {
  const manifest = JSON.parse(readFileSync(new URL('../cockpit.module.json', import.meta.url)));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(Object.keys(manifest.roles[0]).sort(), ['description', 'id', 'name']);
  assert.equal(manifest.roles[0].id, 'wechat');
  assert.equal(pkg.devDependencies['@waksana/cockpit-module-sdk'], '0.15.0');
});
test('bundled backend imports outside the checkout with no installed dependencies', async t => {
  const root = mkdtempSync(join(process.cwd(), '.wechat-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'backend.mjs');
  copyFileSync(new URL('../dist/index.js', import.meta.url), bundle);
  const isolated = await import(pathToFileURL(bundle).href);
  assert.equal(typeof isolated.activate, 'function');
  assert.throws(() => isolated.capabilities({ host: {} }), /REQUIRED_HOST_CAPABILITIES_MISSING/);
});
test('invalid config still reports retained occupancy and query uncertainty', async t => {
  const root = mkdtempSync(join(process.cwd(), '.wechat-existing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root, 'prior-account');
  store.change(state => { state.generation = 1; state.binding = { sessionId: 'retained', generation: 1 }; });
  store.close();
  const fixture = context(root);
  const backend = await activate(fixture.context);
  const result = await backend.roleAssignments.availability({ sessionId: 'different' }, new AbortController().signal);
  const codes = result.reasons.map(reason => reason.code);
  assert(codes.includes('CONSUMPTION_NOT_ENABLED'));
  assert(codes.includes('BINDING_OCCUPIED'));
  assert(codes.includes('BINDING_EXISTENCE_UNKNOWN'));
  fixture.stopping.abort();
  await backend.onStop();
  await backend.dispose();
});
test('public availability, permit and saved callbacks replace deletion or unbound unknown history and serve fresh traffic', async t => {
  for (const alreadyRetired of [false, true]) await t.test(`already retired: ${alreadyRetired}`, { timeout: 10000 }, async t => {
    const root = mkdtempSync(join(process.cwd(), '.wechat-role-flow-'));
    const config = { enabled: true, exclusiveAccountConfirmed: true, account: `fixture-${process.pid}`,
      peer: 'fake-peer', fileRoots: [], webUrl: 'https://example.test' };
    const store = new Store(root, identity(config));
    store.change(state => {
      state.generation = alreadyRetired ? 2 : 1;
      state.binding = alreadyRetired ? null : { sessionId: 'deleted', generation: 1, anchor: null };
      state.lastError = 'WECHAT_API_REJECTED';
      state.receipts.push(...['unknown', 'skipped'].map(status => ({
        key: `old-${status}`, generation: 1, direction: 'output', status, text: `old ${status}`, media: [],
        reason: status === 'unknown' ? 'WECHAT_API_REJECTED' : 'LEGACY_RECORD_NOT_REPLAYED',
      })));
    });
    store.close();
    writeFileSync(join(root, 'credentials.json'), JSON.stringify({
      account: config.account, peer: config.peer, token: 'synthetic-only',
    }), { mode: 0o600 });
    const credentialBytes = readFileSync(join(root, 'credentials.json'));
    const fixture = context(root, config);
    const calls = [];
    const sent = [];
    let backend;
    fixture.context.host.call = async (name, body) => {
      calls.push({ name, body });
      if (name === 'session/get') return { meta: body.sessionId === 'deleted' ? null
        : { sessionId: body.sessionId, cwd: root, loaded: true, status: 'idle', ask: null } };
      if (name === 'session/chat') return { sessionId: body.sessionId, source: body.source, direction: body.direction,
        events: [], cursor: 'fake', cursorStatus: 'ok', hasMore: false };
      if (name === 'prompt') {
        await backend.events.handle({ sessionId: body.sessionId, cwd: root,
          event: { id: 'new-reply', type: 'assistant.message', data: { content: 'fresh reply only' } } });
        return { ok: true, messageId: 'fresh-native-receipt' };
      }
      assert.fail(`Unexpected host call: ${name}`);
    };
    let resolveSend;
    const received = new Promise(resolve => { resolveSend = resolve; });
    let polled = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (url.pathname === '/ilink/bot/getupdates') {
        if (polled) return new Promise((resolve, reject) => {
          if (init.signal.aborted) reject(init.signal.reason);
          else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
        polled = true;
        return new Response(JSON.stringify({ get_updates_buf: 'fresh-cursor', msgs: [{
          message_id: '123', from_user_id: config.peer, to_user_id: config.account,
          message_type: 1, message_state: 2, context_token: 'fresh-context', create_time_ms: Date.now() + 1,
          item_list: [{ type: 1, text_item: { text: 'fresh input' } }],
        }] }));
      }
      assert.equal(url.pathname, '/ilink/bot/sendmessage');
      sent.push(JSON.parse(init.body).msg);
      resolveSend();
      return new Response(JSON.stringify({ message_id: '456' }));
    });
    backend = await activate(fixture.context);
    t.after(async () => {
      fixture.stopping.abort();
      await backend.onStop();
      await backend.dispose();
      rmSync(root, { recursive: true, force: true });
    });
    const selection = { operation: alreadyRetired ? 'add' : 'create', sessionId: 'replacement',
      roles: [{ moduleId: 'wechat', roleId: 'wechat' }], previousRoles: [] };
    const signal = new AbortController().signal;
    assert.deepEqual((await backend.roleAssignments.availability(selection, signal)).reasons, []);
    assert.deepEqual(await backend.roleAssignments.permit(selection, signal), { allowed: true });
    await backend.roleAssignments.saved({ ...selection, notificationId: 'saved' }, signal);
    await backend.roleAssignments.saved({ ...selection, notificationId: 'saved' }, signal);
    assert(!calls.some(call => ['prompt', 'session/load', 'session/new'].includes(call.name)));
    await backend.onReady();
    await received;
    fixture.stopping.abort();
    await backend.onStop();
    const status = (await backend.routes.find(route => route.path === '/status').handler({})).body;
    assert.equal(status.binding.sessionId, 'replacement');
    assert.equal(status.lastError, 'WECHAT_API_REJECTED');
    assert.equal(status.receipts.find(receipt => receipt.key === 'old-unknown').status, 'unknown');
    assert.equal(status.receipts.find(receipt => receipt.key === 'old-unknown').reason, 'WECHAT_API_REJECTED');
    assert.equal(status.receipts.find(receipt => receipt.key === 'old-skipped').status, 'skipped');
    assert.deepEqual(backend.routes.map(({ method, path }) => ({ method, path })), [{ method: 'GET', path: '/status' }]);
    for (const obsolete of ['inputs', 'outputs', 'fault']) assert(!(obsolete in status));
    assert.deepEqual(readFileSync(join(root, 'credentials.json')), credentialBytes);
    assert.deepEqual(calls.filter(call => call.name === 'prompt').map(call => call.body.sessionId), ['replacement']);
    assert.equal(calls.find(call => call.name === 'prompt').body.mode, 'immediate');
    assert.deepEqual(sent.map(message => message.item_list[0].text_item.text), ['fresh reply only']);
  });
});
