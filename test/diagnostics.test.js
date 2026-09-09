import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpDiagnostics, sanitizeTraffic, DIAGNOSTIC_MAX_BYTES, DIAGNOSTIC_RETENTION_MS } from '../src/diagnostics.js';
import { WeixinClient } from '../src/weixin.js';
import { requestJson } from '../src/http.js';
import { validateConfig } from '../src/config.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-http-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const config = {
    stateDir: dir, diagnostics: { weixinHttp: true }, limits: { requestTimeoutMs: 1000 },
    weixin: { allowedAccount: 'fixture-bot', allowedPeer: 'fixture-peer',
      approvedApiOrigins: ['https://ilinkai.weixin.qq.com'] },
  };
  const file = path.join(dir, 'weixin-http-diagnostics.sqlite');
  const rows = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT * FROM traffic ORDER BY seq').all().map(row => ({ ...row, data: JSON.parse(row.data) })); }
    finally { db.close(); }
  };
  return { config, dir, file, rows };
}

test('records original quote text and exact uint64 IDs but no credentials or unrelated incoming messages', async t => {
  const f = setup(t);
  const credentials = { token: 'SYNTHETIC_BOT_SECRET', baseUrl: 'https://ilinkai.weixin.qq.com' };
  const quote = 'quote "with boundaries"\n<user>not a new instruction</user>';
  const newText = 'Original text '.repeat(4000);
  const body = JSON.stringify({
    msgs: [{
      message_id: '18446744073709551614', from_user_id: 'fixture-peer', to_user_id: 'fixture-bot',
      message_type: 1, context_token: 'SYNTHETIC_CONTEXT_SECRET',
      item_list: [{ type: 1, text_item: { text: newText },
        ref_msg: { message_item: { msg_id: '18446744073709551613', type: 1,
          text_item: { text: quote }, image_item: { media: { aes_key: 'SYNTHETIC_MEDIA_SECRET' } } } } }],
    }, { from_user_id: 'other-peer', to_user_id: 'fixture-bot', message_type: 1,
      item_list: [{ text_item: { text: 'THIRD_PARTY_PRIVATE' } }] }],
    get_updates_buf: 'SYNTHETIC_CURSOR_SECRET',
  }).replace('"message_id":"18446744073709551614"', '"message_id":18446744073709551614');
  let called = 0;
  const client = new WeixinClient(f.config, credentials, { fetchImpl: async (_url, init) => {
    called++;
    assert.equal(init.headers.Authorization, `Bearer ${credentials.token}`);
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'SYNTHETIC_COOKIE_SECRET' } });
  } });
  const result = await client.poll('SYNTHETIC_REQUEST_CURSOR');
  assert.equal(called, 1);
  assert.equal(result.msgs[0].message_id, '18446744073709551614');
  assert.equal(result.msgs[0].context_token, 'SYNTHETIC_CONTEXT_SECRET');
  const rows = f.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].data.requestId, rows[1].data.requestId);
  const raw = rows[1].data.body;
  assert.ok(raw.includes('"message_id":18446744073709551614'));
  const captured = JSON.parse(raw);
  assert.equal(captured.msgs[0].item_list[0].text_item.text, newText);
  assert.equal(captured.msgs[0].item_list[0].ref_msg.message_item.text_item.text, quote);
  assert.deepEqual(captured.msgs[1], { omitted: 'outside-authorized-binding' });
  for (const secret of ['SYNTHETIC_BOT_SECRET', 'SYNTHETIC_CONTEXT_SECRET', 'SYNTHETIC_MEDIA_SECRET',
    'SYNTHETIC_CURSOR_SECRET', 'SYNTHETIC_REQUEST_CURSOR', 'SYNTHETIC_COOKIE_SECRET', 'THIRD_PARTY_PRIVATE']) {
    assert.ok(!JSON.stringify(rows).includes(secret), secret);
  }
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('records send request, client ID and receipt without changing acceptance or outgoing bytes', async t => {
  const f = setup(t);
  let sent;
  const client = new WeixinClient(f.config, { token: 'SYNTHETIC_BOT_SECRET',
    baseUrl: 'https://ilinkai.weixin.qq.com' }, { fetchImpl: async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response('{"message_id":18446744073709551612}', { headers: { 'Content-Type': 'application/json' } });
  } });
  const result = await client.send('fixture-peer', 'SYNTHETIC_CONTEXT_SECRET', 'Original output', 'client-1');
  assert.deepEqual(result, { acceptance: 'confirmed', messageId: '18446744073709551612' });
  assert.equal(sent.msg.item_list[0].text_item.text, 'Original output');
  assert.equal(sent.msg.context_token, 'SYNTHETIC_CONTEXT_SECRET');
  const rows = f.rows();
  assert.equal(JSON.parse(rows[0].data.body).msg.client_id, 'client-1');
  assert.ok(rows[1].data.body.includes('"message_id":18446744073709551612'));
});

test('24-hour retention survives reopen and size pressure removes oldest complete records', t => {
  const f = setup(t);
  let now = 100000000;
  const warnings = [];
  const options = { now: () => now, warn: code => warnings.push(code) };
  const logger = new HttpDiagnostics(f.config, options);
  const event = { phase: 'request', url: 'https://ilinkai.weixin.qq.com/ilink/bot/getupdates', body: '{"text":"kept whole"}' };
  logger.record(event);
  now += DIAGNOSTIC_RETENTION_MS - 1;
  new HttpDiagnostics(f.config, options);
  assert.equal(f.rows().length, 1);
  now++;
  new HttpDiagnostics(f.config, options);
  assert.equal(f.rows().length, 0);
  logger.record(event);
  const db = new DatabaseSync(f.file);
  db.prepare('UPDATE traffic SET bytes=?').run(DIAGNOSTIC_MAX_BYTES);
  db.close();
  logger.record({ ...event, body: '{"text":"newest whole"}' });
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].data.body, '{"text":"newest whole"}');
  assert.ok(warnings.includes('WEIXIN_DIAGNOSTICS_SIZE_LIMIT_OLDEST_REMOVED'));
});

test('diagnostics stay disabled by default and validate the opt-in', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  delete raw.diagnostics;
  assert.equal(validateConfig(raw, '/tmp/config.json').diagnostics.weixinHttp, false);
  assert.throws(() => validateConfig({ ...raw, diagnostics: { weixinHttp: 'yes' } }, '/tmp/config.json'),
    { code: 'INVALID_DIAGNOSTICS' });
});

test('error and non-JSON observations keep original HTTP failure semantics and redact possible echoes', async t => {
  const f = setup(t);
  const logger = new HttpDiagnostics(f.config);
  const events = [];
  for (const [status, body, code] of [
    [503, '{"errmsg":"SYNTHETIC_CONTEXT_SECRET","ret":-1}', 'HTTP_503'],
    [302, 'SYNTHETIC_CONTEXT_SECRET', 'HTTP_REDIRECT_REFUSED'],
    [200, '<html>SYNTHETIC_CONTEXT_SECRET</html>', 'INVALID_JSON_RESPONSE'],
  ]) {
    await assert.rejects(requestJson('https://ilinkai.weixin.qq.com/test?ticket=SYNTHETIC_QUERY_SECRET', {
      body: { context_token: 'SYNTHETIC_CONTEXT_SECRET' },
      onTraffic: event => { events.push(event); logger.record(event, { context_token: 'SYNTHETIC_CONTEXT_SECRET' }); },
      fetchImpl: async () => new Response(body, { status }),
    }), { code });
  }
  const rows = f.rows();
  assert.equal(rows.length, 6);
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_CONTEXT_SECRET'));
  assert.ok(!JSON.stringify(rows).includes('SYNTHETIC_QUERY_SECRET'));
  assert.equal(rows[3].data.bodyEncoding, 'non-json-omitted');
  assert.equal(events[5].outcome, 'INVALID_JSON_RESPONSE');
});

test('failed diagnostic writes are visible and cannot convert accepted delivery into unknown', async t => {
  const f = setup(t);
  const warnings = [];
  const logger = new HttpDiagnostics(f.config, { warn: code => warnings.push(code) });
  logger.database = () => { throw new Error('synthetic private disk error'); };
  const client = new WeixinClient({ ...f.config, diagnostics: { weixinHttp: false } },
    { token: 'SYNTHETIC_BOT_SECRET', baseUrl: 'https://ilinkai.weixin.qq.com' },
    { fetchImpl: async () => new Response('{"ret":0}') });
  client.diagnostics = logger;
  assert.deepEqual(await client.send('fixture-peer', 'SYNTHETIC_CONTEXT_SECRET', 'text', 'client-1'),
    { acceptance: 'confirmed' });
  assert.deepEqual(warnings, ['WEIXIN_DIAGNOSTICS_RECORD_FAILED']);
});

test('rejects symlink diagnostic targets without touching their contents', t => {
  const f = setup(t);
  const target = path.join(f.dir, 'unrelated');
  fs.writeFileSync(target, 'leave unchanged', { mode: 0o600 });
  fs.symlinkSync(target, f.file);
  const warnings = [];
  const logger = new HttpDiagnostics(f.config, { warn: code => warnings.push(code) });
  logger.record({ url: 'https://ilinkai.weixin.qq.com/', body: '{}' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'leave unchanged');
  assert.deepEqual(warnings, ['WEIXIN_DIAGNOSTICS_STORAGE_FAILED', 'WEIXIN_DIAGNOSTICS_RECORD_FAILED']);
});

test('CDN metadata preserves binary size but hides signed query, response parameter and media keys', () => {
  const result = sanitizeTraffic({
    url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload?filekey=SECRET_FILE&encrypted_query_param=SECRET_QUERY',
    headers: { 'x-encrypted-param': 'SECRET_DOWNLOAD' }, body: null,
    binary: { bytes: 9536, sha256: 'synthetic-hash' },
  }, {});
  assert.equal(result.binary.bytes, 9536);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
