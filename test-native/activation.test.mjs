import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { accountLease, readConfig, credentials } from '../dist/config.js';
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
  const root = mkdtempSync(join(tmpdir(), 'wechat-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = context(root);
  const backend = await activate(fixture.context);
  await backend.onReady();
  const result = await backend.roleAssignments.availability({}, new AbortController().signal);
  assert(result.reasons.length >= 4);
  const status = await backend.routes.find(route => route.path === '/status').handler({});
  assert.equal(status.body.configured, false);
  assert.equal(status.body.binding, null);
  fixture.stopping.abort();
  await backend.onStop();
  await backend.dispose();
});
test('credential provisioning requires exact identity and private regular file', t => {
  const root = mkdtempSync(join(tmpdir(), 'wechat-credentials-'));
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
  const root = mkdtempSync(join(tmpdir(), 'wechat-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root, 'original');
  store.close();
  const before = readFileSync(join(root, 'native-v1.sqlite'));
  assert.throws(() => new Store(root, 'other'), /ACCOUNT_CONFIGURATION_CHANGED/);
  assert.deepEqual(readFileSync(join(root, 'native-v1.sqlite')), before);
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
  const root = mkdtempSync(join(tmpdir(), 'wechat-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'backend.mjs');
  copyFileSync(new URL('../dist/index.js', import.meta.url), bundle);
  const isolated = await import(pathToFileURL(bundle).href);
  assert.equal(typeof isolated.activate, 'function');
  assert.throws(() => isolated.capabilities({ host: {} }), /REQUIRED_HOST_CAPABILITIES_MISSING/);
});
test('invalid config still reports retained occupancy and query uncertainty', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wechat-existing-'));
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
