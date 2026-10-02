import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assetNames, buildIdentity, hash, identity, inventory, shipped, sourceHash } from '../scripts/release-identity.mjs';
import { packageRelease, verifyRelease } from '../scripts/package-release.mjs';
import { mergedIdentity, publish, writeRemote } from '../scripts/rolling-release.mjs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/state.js';
import { verifySnapshot } from '../dist/media.js';
import { moduleProduct } from '../scripts/deployment-manifest.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wechat-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [...shipped, 'package.json', 'cockpit.module.json', '.gitignore']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(project, path), join(root, path));
  }
  cpSync(join(project, 'native'), join(root, 'native'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--no-gpg-sign', '-qm', 'fixture');
  const env = { ROLLING_SEQUENCE: '7', ROLLING_SOURCE_SHA: git('rev-parse', 'HEAD') };
  const build = buildIdentity(root, env);
  const receipt = () => writeFileSync(join(root, '.module-build-receipt.json'), JSON.stringify({
    build, sourceHash: sourceHash(root), files: inventory(root, shipped),
  }));
  receipt();
  return { root, env, build, receipt };
}

test('Rolling identity and merge-only authority reject invalid inputs', () => {
  for (const sequence of ['0', '-1', '1.5', '01', '9007199254740992', '', undefined]) {
    assert.throws(() => identity(sequence, 'a'.repeat(40)));
  }
  assert.throws(() => identity(1, 'master'));
  const event = { repository: { full_name: 'waksana/cockpit-wechat-connector' }, action: 'closed', number: 6,
    pull_request: { merged: true, merge_commit_sha: 'a'.repeat(40),
      base: { ref: 'master', repo: { full_name: 'waksana/cockpit-wechat-connector' } } } };
  assert.equal(mergedIdentity(event, 1).tag, 'v0.0.0-rolling.1');
  for (const mutate of [
    e => { e.action = 'opened'; }, e => { e.pull_request.merged = false; },
    e => { e.pull_request.base.ref = 'feature'; }, e => { e.repository.full_name = 'fork/repo'; },
    e => { e.pull_request.base.repo.full_name = 'fork/repo'; }, e => { e.pull_request.merge_commit_sha = 'HEAD'; },
  ]) {
    const changed = structuredClone(event); mutate(changed);
    assert.throws(() => mergedIdentity(changed, 1));
  }
});

test('release archive is deterministic, standalone, checked and source-bound', async t => {
  const { root, env, build } = fixture(t);
  const first = join(root, 'module-output');
  const second = join(root, 'release-artifact');
  const archive = packageRelease(root, first, env);
  const contract = verifyRelease(root, first, build);
  packageRelease(root, second, env);
  assert.deepEqual(readFileSync(archive), readFileSync(join(second, `wechat-${build.version}.tgz`)));
  assert.equal(contract.product.id, 'wechat');
  assert.equal(contract.product.databases[0].path, 'native-v1.sqlite');
  assert.deepEqual(contract.product.migrations, []);
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  execFileSync('tar', ['-xzf', archive, '-C', consumer]);
  const backend = await import(pathToFileURL(join(consumer, 'dist/index.js')).href);
  const stopping = new AbortController();
  const isolated = await backend.activate({ apiVersion: 1, moduleId: 'wechat', dataRoot: join(consumer, 'data'),
    apiBase: '/_modules/test', config: {}, serviceReadyVersion: 1, shutdownVersion: 1,
    signal: new AbortController().signal, stopping: stopping.signal, report() {}, invalidate() {}, publish() {},
    host: { roleAssignmentVersion: 1, roleAvailabilityVersion: 1, sessionLoadVersion: 1,
      chatReadVersion: 1, promptReceiptVersion: 1, askResponseVersion: 1,
      call: async () => { throw new Error('No host mutation permitted'); } } });
  await isolated.onReady();
  stopping.abort(); await isolated.onStop(); await isolated.dispose();
  const sourceManifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json')));
  assert.equal(sourceManifest.version, '0.2.1');
  assert.equal(JSON.parse(readFileSync(join(consumer, 'cockpit.module.json'))).version, build.version);
  writeFileSync(join(first, 'cockpit-deployment.json'), '{}');
  assert.throws(() => verifyRelease(root, first, build));
});

test('packaging rejects wrong SHA, dirty source, stale output, and mismatched source identity', t => {
  const { root, env, build } = fixture(t);
  assert.throws(() => buildIdentity(root, { ...env, ROLLING_SOURCE_SHA: 'b'.repeat(40) }));
  assert.throws(() => buildIdentity(root, { ROLLING_SEQUENCE: '7' }));
  writeFileSync(join(root, 'untracked-source.ts'), 'unexpected');
  assert.throws(() => buildIdentity(root, env), /clean source/);
  rmSync(join(root, 'untracked-source.ts'));
  writeFileSync(join(root, 'dist/index.js'), '// stale');
  assert.throws(() => packageRelease(root, join(root, 'module-output'), env), /changed/);
  assert.equal(build.version, '0.0.0-rolling.7');
});

test('consumer rejects rehashed wrong identities and archive members', t => {
  const { root, env, build } = fixture(t);
  const directory = join(root, 'module-output');
  packageRelease(root, directory, env);
  assert.throws(() => verifyRelease(root, directory, { ...build, sourceSha: 'e'.repeat(40) }));
  const path = join(directory, 'cockpit-deployment.json');
  const original = readFileSync(path);
  const invalid = JSON.parse(original);
  invalid.product.requiresCapabilities = [];
  writeFileSync(path, JSON.stringify(invalid));
  writeFileSync(`${path}.sha256`, `${hash(readFileSync(path))}  cockpit-deployment.json\n`);
  assert.throws(() => verifyRelease(root, directory, build));
  writeFileSync(path, original);
  writeFileSync(`${path}.sha256`, `${hash(original)}  cockpit-deployment.json\n`);
  const archive = join(directory, `wechat-${build.version}.tgz`);
  const stage = join(root, 'corrupt-archive');
  mkdirSync(stage);
  writeFileSync(join(stage, 'unexpected'), 'no');
  execFileSync('tar', ['-czf', archive, 'unexpected'], { cwd: stage });
  writeFileSync(`${archive}.sha256`, `${hash(readFileSync(archive))}  wechat-${build.version}.tgz\n`);
  assert.throws(() => verifyRelease(root, directory, build), /archive members/);
});

for (const interrupted of [false, true]) test(`packaged Rolling preserves native data and private files (interrupted=${interrupted})`, async t => {
  const { root, env } = fixture(t);
  const archive = packageRelease(root, join(root, 'module-output'), env);
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  execFileSync('tar', ['-xzf', archive, '-C', consumer]);
  const dataRoot = join(root, 'private-data');
  const store = new Store(dataRoot, 'synthetic-account-peer-identity');
  const paths = ['credentials.json', 'incoming/input-1/0/file', 'outgoing/output-1/file'];
  for (const path of paths) {
    mkdirSync(dirname(join(dataRoot, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataRoot, path), 'synthetic retained bytes', { mode: path === 'credentials.json' ? 0o600 : 0o400 });
  }
  const content = Buffer.from('synthetic retained bytes');
  const snapshot = { path: join(dataRoot, paths[1]), name: 'file', size: content.length, sha256: hash(content),
    md5: createHash('md5').update(content).digest('hex'), mime: 'application/octet-stream', kind: 'file' };
  store.change(state => {
    state.generation = 2;
    state.binding = { sessionId: 'retained-session', generation: 2, anchor: 'anchor', contextToken: 'synthetic-context', cwd: '/synthetic' };
    state.retired.push({ sessionId: 'old-session', generation: 1, at: 1 });
    state.notifications.push('saved-notification');
    state.cursor = 'retained-cursor';
    state.inputs.push({ key: 'input-1', generation: 2, stage: interrupted ? 'intent' : 'accepted',
      message: { id: '123', text: 'synthetic input' }, operation: 'prompt', messageId: 'native-receipt', media: [snapshot] });
    state.outputs.push({ key: 'output-1', generation: 2, kind: 'reply', stage: interrupted ? 'intent' : 'unknown',
      text: 'synthetic output', files: [{ ...snapshot, path: join(dataRoot, paths[2]) }],
      parts: [{ stage: 'accepted', clientId: 'accepted-part', messageId: '456' },
        { stage: interrupted ? 'intent' : 'unknown', clientId: 'uncertain-part' }] });
    state.questions.push({ request: { requestId: 'retained-question', question: 'synthetic question' },
      generation: 2, outputKey: 'output-1', stage: 'presented' });
    state.resolutions.push({ key: 'retired-input', note: 'synthetic disposition', at: 1 });
  });
  const before = store.read(); store.close();
  const dbPath = join(dataRoot, 'native-v1.sqlite');
  const beforeBytes = readFileSync(dbPath);
  const privateFiles = paths.map(path => ({ path, hash: hash(readFileSync(join(dataRoot, path))), mode: lstatSync(join(dataRoot, path)).mode }));
  const backend = await import(pathToFileURL(join(consumer, 'dist/index.js')).href);
  const stopping = new AbortController();
  const instance = await backend.activate({ apiVersion: 1, moduleId: 'wechat', dataRoot, apiBase: '/_modules/test',
    config: {}, serviceReadyVersion: 1, shutdownVersion: 1, signal: new AbortController().signal, stopping: stopping.signal,
    report() {}, invalidate() {}, publish() {}, host: { roleAssignmentVersion: 1, roleAvailabilityVersion: 1,
      sessionLoadVersion: 1, chatReadVersion: 1, promptReceiptVersion: 1, askResponseVersion: 1,
      call: async () => { throw new Error('No network, replay, or host mutation permitted'); } } });
  await instance.onReady();
  stopping.abort(); await instance.onStop(); await instance.dispose();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const after = JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  db.close();
  const expected = structuredClone(before);
  if (interrupted) {
    expected.revision++;
    expected.inputs[0].stage = 'unknown';
    expected.outputs[0].stage = 'unknown';
    expected.outputs[0].parts[1].stage = 'unknown';
  } else assert.deepEqual(readFileSync(dbPath), beforeBytes);
  assert.deepEqual(after, expected);
  await verifySnapshot(after.inputs[0].media[0]);
  await verifySnapshot(after.outputs[0].files[0]);
  assert.deepEqual(paths.map(path => ({ path, hash: hash(readFileSync(join(dataRoot, path))), mode: lstatSync(join(dataRoot, path)).mode })), privateFiles);
});

test('deployment declaration derives exact native schema; unsupported existing stores are unchanged', t => {
  const product = moduleProduct(project);
  assert.deepEqual(product.databases, [{ path: 'native-v1.sqlite', schema: 1, preserve: [{ table: 'state', columns: ['id', 'json'] }] }]);
  for (const alteration of ['PRAGMA user_version=0', 'PRAGMA user_version=2', 'DELETE FROM state',
    "UPDATE state SET json=json_set(json, '$.schema', 2)"]) {
    const directory = mkdtempSync(join(tmpdir(), 'wechat-schema-refusal-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    new Store(directory, 'synthetic').close();
    const path = join(directory, 'native-v1.sqlite');
    const db = new DatabaseSync(path); db.exec(alteration); db.close();
    const before = readFileSync(path);
    assert.throws(() => new Store(directory, 'synthetic'), /STATE_SCHEMA_UNSUPPORTED|STATE_INITIALIZATION_INCOMPLETE/);
    assert.deepEqual(readFileSync(path), before);
  }
});

function remote(build, files) {
  const state = { sha: null, release: null, assets: [], writes: [], nextId: 10 };
  const api = {
    tags: async () => state.sha,
    releases: async () => state.release ? [structuredClone(state.release)] : [],
    release: async () => structuredClone(state.release),
    assets: async () => state.assets.map(({ bytes, ...asset }) => ({ ...asset })),
    download: async id => state.assets.find(asset => asset.id === id).bytes,
    tag: async value => { state.writes.push('tag'); state.sha = value.sourceSha; },
    create: async value => { state.writes.push('create'); state.release = { ...value, id: 1, immutable: false }; return { id: 1 }; },
    upload: async (id, file) => {
      state.writes.push(file.name);
      state.assets.push({ id: state.nextId++, name: file.name, size: file.bytes.length, bytes: file.bytes, state: 'uploaded' });
    },
    publish: async (id, body) => { state.writes.push('publish'); Object.assign(state.release, { draft: false, body }); },
  };
  return { state, api };
}
const build = identity(3, 'c'.repeat(40));
const files = assetNames(build.version).map(name => ({ name, bytes: Buffer.from(`synthetic ${name}`) }));

test('publication downloads all assets, seals identities, and never rewrites published releases', async () => {
  const { state, api } = remote(build, files);
  assert.deepEqual(await publish(build, 6, files, api), { status: 'published', id: 1, immutable: false });
  const writes = [...state.writes];
  assert.equal((await publish(build, 6, files, api)).status, 'already_published');
  assert.deepEqual(state.writes, writes);
  state.assets[0].id += 100;
  await assert.rejects(publish(build, 6, files, api));
  assert.deepEqual(state.writes, writes);
});

test('conflicting tags, partial drafts, corrupt assets and uncertain writes stop without retry', async () => {
  {
    const { api, state } = remote(build, files); state.sha = 'd'.repeat(40);
    await assert.rejects(publish(build, 6, files, api));
    assert.deepEqual(state.writes, []);
  }
  for (const phase of ['tag', 'create', 'upload', 'publish']) {
    const { api, state } = remote(build, files);
    const original = api[phase];
    let calls = 0;
    api[phase] = async (...args) => { calls++; await original(...args); throw new Error('uncertain'); };
    await assert.rejects(publish(build, 6, files, api), /uncertain/);
    assert.equal(calls, 1);
    if (state.release?.draft) {
      const writes = [...state.writes];
      await assert.rejects(publish(build, 6, files, api), /draft/);
      assert.deepEqual(state.writes, writes);
    }
  }
  {
    const { api, state } = remote(build, files);
    api.download = async () => Buffer.from('wrong');
    await assert.rejects(publish(build, 6, files, api), /bytes differ/);
    assert.equal(state.release.draft, true);
    assert.ok(!state.writes.includes('publish'));
  }
});

test('write transport rejects redirects and errors without retrying or leaking tokens', async () => {
  for (const status of [302, 403, 429, 500]) {
    let calls = 0;
    const transport = (url, options, callback) => {
      calls++;
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.end = () => {
        const response = new EventEmitter(); response.statusCode = status;
        callback(response); response.emit('end');
      };
      return req;
    };
    await assert.rejects(writeRemote('https://api.github.com/repos/example/repo/releases', 'POST', {},
      'synthetic-secret', transport), error => !error.message.includes('synthetic-secret') && /No retry/.test(error.message));
    assert.equal(calls, 1);
  }
});

test('workflow only publishes merged master with exact-SHA read-only checks', () => {
  const workflow = readFileSync(join(project, '.github/workflows/rolling.yml'), 'utf8');
  assert.match(workflow, /pull_request_target:\n    branches: \[master\]\n    types: \[closed\]/);
  assert.match(workflow, /if: github\.event\.pull_request\.merged == true/);
  assert.doesNotMatch(workflow, /head\.sha|workflow_dispatch|secrets\.|cancel-in-progress|concurrency:/);
  assert.match(workflow, /needs: checks/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.merge_commit_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.ok([...workflow.matchAll(/uses: ([^\n]+)/g)].every(([, action]) => action.startsWith('./') || /@[a-f0-9]{40}$/.test(action)));
  assert.equal(hash(Buffer.from('fixture')).length, 64);
});
