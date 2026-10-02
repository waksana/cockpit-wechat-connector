import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/state.js';

export function moduleProduct(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json')));
  assert.equal(manifest.id, 'wechat');
  assert.equal(manifest.apiVersion, 1);
  const backend = readFileSync(join(root, 'native/index.ts'), 'utf8');
  const fields = [...backend.matchAll(/context(?:\.host\??)?\.(\w+)Version === (\d+)/g)]
    .map(([, name, version]) => `${name}.v${version}`);
  assert.deepEqual(fields, ['serviceReady.v1', 'shutdown.v1', 'roleAssignment.v1', 'roleAvailability.v1',
    'sessionLoad.v1', 'chatRead.v1', 'promptReceipt.v1', 'askResponse.v1'], 'Review changed host capability gates');
  assert.match(backend, /&& context\.stopping/);
  const native = readdirSync(join(root, 'native')).filter(name => name.endsWith('.ts'))
    .map(name => readFileSync(join(root, 'native', name), 'utf8')).join('\n');
  const requiredIntents = [...new Set([...native.matchAll(/\.host\.call\('([^']+)'/g)].map(match => match[1]))].sort();
  assert.deepEqual(requiredIntents, ['prompt', 'respondAsk', 'session/chat', 'session/get', 'session/load']);
  const source = readFileSync(join(root, 'native/state.ts'), 'utf8');
  assert.match(source, /existing && version\?\.user_version !== 1/);
  assert.match(source, /value\?\.schema === 1/);
  assert.match(source, /value\.adapter === 2/);
  const directory = mkdtempSync(join(tmpdir(), 'wechat-schema-'));
  let store;
  let db;
  try {
    store = new Store(directory, 'synthetic-contract-only');
    assert.equal(store.read().adapter, 2);
    store.close(); store = undefined;
    db = new DatabaseSync(join(directory, 'native-v1.sqlite'), { readOnly: true });
    const schema = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(schema, 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const preserve = tables.map(({ name }) => {
      assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
      return { table: name, columns: db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name) };
    });
    assert.deepEqual(preserve, [{ table: 'state', columns: ['id', 'json'] }], 'Review changed storage contract');
    return { kind: 'module', id: manifest.id, hostApi: { min: 1, max: 1 },
      requiresCapabilities: ['module-api.v1', ...fields], requiredIntents,
      databases: [{ path: 'native-v1.sqlite', schema, preserve }], migrations: [] };
  } finally {
    db?.close();
    store?.close();
    rmSync(directory, { recursive: true });
  }
}
