import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { Store } from '../dist/state.js';
import { BindingManager } from '../dist/binding.js';
import { Service } from '../dist/service.js';
import { capabilities } from '../dist/index.js';
import { WechatApiError, WechatTransport } from '../dist/transport.js';

function directory(t) {
  const root = mkdtempSync(join(process.cwd(), '.wechat-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t) {
  const root = mkdtempSync(join(process.cwd(), '.wechat-service-'));
  const source = join(root, 'source');
  mkdirSync(source, { mode: 0o700 });
  const stopping = new AbortController();
  const signal = new AbortController();
  const store = new Store(join(root, 'state'), 'fixture-account');
  const calls = [], sent = [], reports = [];
  let events = [];
  let meta = { sessionId: 'session-original', cwd: source, loaded: false, status: 'unloaded', ask: null };
  let hook;
  const context = {
    moduleId: 'wechat', dataRoot: store.root, apiVersion: 1, serviceReadyVersion: 1, shutdownVersion: 1,
    stopping: stopping.signal, signal: signal.signal, config: {},
    report(error) { reports.push(error.message); }, invalidate() {}, publish() {},
    host: {
      roleAssignmentVersion: 1, roleAvailabilityVersion: 1, sessionLoadVersion: 1, chatReadVersion: 1,
      promptReceiptVersion: 1, askResponseVersion: 1,
      async call(name, body) {
        calls.push({ name, body });
        if (hook) { const result = await hook(name, body); if (result !== undefined) return result; }
        if (name === 'session/get') return { meta };
        if (name === 'session/load') {
          meta = { ...meta, loaded: true, status: 'idle' };
          return { ok: true, sessionId: body.sessionId };
        }
        if (name === 'session/chat') return page(body, events.slice(-body.max));
        if (name === 'prompt') return { ok: true, messageId: `native-receipt-${body.text}` };
        if (name === 'respondAsk') { meta.ask = null; return { ok: true }; }
        assert.fail(`Unexpected host call: ${name}`);
      },
    },
  };
  const config = { account: 'account', peer: 'peer', fileRoots: [source], webUrl: 'https://example.test',
    enabled: true, exclusiveAccountConfirmed: true };
  const transport = {
    async send(items, token, clientId) { sent.push({ items, token, clientId }); return { messageId: String(sent.length + 100) }; },
    async poll() { return { messages: [], cursor: 'wx-cursor' }; },
  };
  const service = new Service(context, config, store, transport);
  const manager = new BindingManager(context, store, () => []);
  const services = [service];
  t.after(async () => {
    stopping.abort();
    await Promise.all(services.map(service => service.stop()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, source, store, calls, sent, reports, context, config, stopping, signal, service, manager, transport,
    setMeta(value) { meta = value; }, getMeta() { return meta; }, setEvents(value) { events = value; },
    setHook(value) { hook = value; },
    serviceWith(transport) {
      const service = new Service(context, config, store, transport);
      services.push(service);
      return service;
    },
  };
}
const selection = { operation: 'add', sessionId: 'session-original',
  roles: [{ moduleId: 'wechat', roleId: 'wechat' }], previousRoles: [] };
const activeSignal = () => new AbortController().signal;
function page(body, events, extra = {}) {
  return { sessionId: body.sessionId, events, source: body.source, direction: body.direction,
    cursor: 'history-cursor', cursorStatus: 'ok', hasMore: false, ...extra };
}
async function bind(f) {
  await f.manager.saved({ ...selection, notificationId: 'notification-1' }, activeSignal());
  await f.service.tick();
}
async function replace(f) {
  f.setMeta(null);
  assert.deepEqual((await f.manager.availability({ ...selection, sessionId: 'replacement' }, activeSignal())).reasons, []);
  await f.manager.saved({ ...selection, sessionId: 'replacement', notificationId: 'replacement' }, activeSignal());
  f.setMeta({ sessionId: 'replacement', cwd: f.source, loaded: true, status: 'idle', ask: null });
  return f.store.read().binding;
}
function message(id, text = 'hello', extra = {}) {
  return { id, text, account: 'account', peer: 'peer', contextToken: 'synthetic-context',
    items: [{ type: 1, text_item: { text } }], quotes: [], ...extra };
}
function event(id, content, extra = {}) {
  return { id, type: 'assistant.message', data: { content }, ...extra };
}
function observe(f, id, content, extra = {}) {
  return f.service.observe({ sessionId: f.store.read().binding.sessionId, cwd: f.source,
    event: event(id, content, extra) });
}
function inputs(f) { return f.store.read().receipts.filter(receipt => receipt.direction === 'input'); }
function outputs(f) { return f.store.read().receipts.filter(receipt => receipt.direction === 'output'); }
async function establishContext(f) {
  await f.service.ingest([message('initial')], 'initial-cursor', f.store.read().binding);
}

test('required capabilities checked before activation can open storage', () => {
  assert.throws(() => capabilities({ host: {} }), /REQUIRED_HOST_CAPABILITIES_MISSING/);
});
test('binding and ticks are passive; real input loads only the original ID and submits immediately', async t => {
  const f = fixture(t);
  await bind(f);
  await f.service.tick();
  assert(!f.calls.some(call => ['session/load', 'prompt', 'session/new'].includes(call.name)));
  assert((await f.manager.availability({ ...selection, sessionId: 'other' }, activeSignal()))
    .reasons.some(reason => reason.code === 'BINDING_OCCUPIED'));
  await f.service.ingest([message('1')], 'cursor-a', f.store.read().binding);
  const mutations = f.calls.filter(call => ['session/load', 'prompt'].includes(call.name));
  assert.deepEqual(mutations.map(call => call.name), ['session/load', 'prompt']);
  assert(mutations.every(call => call.body.sessionId === 'session-original'));
  assert.equal(mutations[1].body.mode, 'immediate');
  assert.equal(inputs(f)[0].status, 'accepted');
  assert.equal(inputs(f)[0].nativeMessageId, 'native-receipt-hello');
  assert.equal(f.store.read().adapter, 2);
  for (const obsolete of ['inputs', 'outputs', 'retired', 'questions', 'fault']) assert(!(obsolete in f.store.read()));
  await f.service.ingest([message('1', 'duplicate')], 'cursor-b', f.store.read().binding);
  assert.equal(inputs(f).length, 1);
  assert.equal(f.store.read().cursor, 'cursor-b');
  assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
});
test('busy native sessions receive ordinary immediate prompts without cancellation or queue management', async t => {
  const f = fixture(t);
  await bind(f);
  f.setMeta({ ...f.getMeta(), loaded: true, status: 'running', processing: true });
  await f.service.ingest([message('1'), message('2', 'second')], 'cursor', f.store.read().binding);
  assert.deepEqual(f.calls.filter(call => call.name === 'prompt').map(call => call.body.mode), ['immediate', 'immediate']);
  assert(f.calls.every(call => ['session/get', 'session/chat', 'prompt'].includes(call.name)));
  assert(inputs(f).every(receipt => receipt.status === 'accepted'));
});
test('opaque item IDs never replace envelope IDs for deduplication or exact quotes', async t => {
  const f = fixture(t);
  await bind(f);
  let batch = 0;
  const transport = new WechatTransport({ account: 'account', peer: 'peer', token: 'synthetic-only' }, async () => {
    const itemId = batch++ === 0 ? 'synthetic-part:alpha/001' : 'changed-item-id';
    return new Response(JSON.stringify({ get_updates_buf: `cursor-${batch}`, msgs: [
      ['9007199254740993', 'first envelope'], ['9007199254740994', 'second envelope'],
    ].map(([id, text], index) => ({
      message_id: id, from_user_id: 'peer', to_user_id: 'account', message_type: 1, message_state: 2,
      context_token: 'fake-context', item_list: [{ type: 1, msg_id: itemId, text_item: { text },
        ...(index ? { ref_msg: { svr_id: '42', message_item: {
          type: 1, msg_id: '9007199254740993', text_item: { text: 'not an envelope match' },
        } } } : {}) }],
    })) }));
  });
  const service = f.serviceWith(transport);
  await service.poll();
  await service.poll();
  assert.deepEqual(inputs(f).map(receipt => receipt.key), ['account:9007199254740993', 'account:9007199254740994']);
  assert(inputs(f).every(receipt => receipt.status === 'accepted'));
  assert.equal(f.store.read().cursor, 'cursor-2');
  const prompts = f.calls.filter(call => call.name === 'prompt');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].body.text, /"resolution":"unresolved"/);
});
test('encrypted CDN file, image and video traverse native attachments, immutable capture and exact outgoing quotes', async t => {
  const f = fixture(t);
  await bind(f);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const video = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  const fixtures = [
    { type: 4, name: 'in.txt', bytes: Buffer.from('incoming fixture') },
    { type: 2, name: 'in.png', bytes: png },
    { type: 5, name: 'in.mp4', bytes: video },
  ];
  const key = Buffer.alloc(16, 7);
  const encrypted = fixtures.map(({ bytes }) => {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
  });
  const sends = [], uploads = [];
  let uploadKey;
  const transport = new WechatTransport({ account: 'account', peer: 'peer', token: 'synthetic-only' }, async (url, init) => {
    if (url.pathname === '/ilink/bot/getupdates') return new Response(JSON.stringify({
      get_updates_buf: 'media', msgs: fixtures.map(({ type, name, bytes }, index) => {
        const media = { encrypt_query_param: String(index), aes_key: key.toString('base64'), encrypt_type: 1 };
        const body = type === 4 ? { file_item: { file_name: name, len: String(bytes.length), media } }
          : type === 2 ? { image_item: { media } } : { video_item: { media, video_size: bytes.length } };
        return { message_id: String(700 + index), from_user_id: 'peer', to_user_id: 'account',
          message_type: 1, message_state: 2, context_token: 'fake-context',
          item_list: [{ type, msg_id: `media-part/${index}`, ...body }] };
      }),
    }));
    if (url.pathname === '/c2c/download') return new Response(encrypted[Number(url.searchParams.get('encrypted_query_param'))]);
    if (url.pathname === '/ilink/bot/getuploadurl') {
      uploadKey = Buffer.from(JSON.parse(init.body).aeskey, 'hex');
      return new Response(JSON.stringify({ upload_param: 'fake-upload' }));
    }
    if (url.pathname === '/c2c/upload') {
      const decipher = createDecipheriv('aes-128-ecb', uploadKey, null);
      uploads.push(Buffer.concat([decipher.update(init.body), decipher.final()]));
      return new Response('', { headers: { 'x-encrypted-param': 'fake-receipt' } });
    }
    assert.equal(url.pathname, '/ilink/bot/sendmessage');
    sends.push(JSON.parse(init.body).msg);
    if (sends.length === 1) for (const item of fixtures) writeFileSync(join(f.source, item.name), 'mutated after capture, before upload');
    return new Response(JSON.stringify({ message_id: String(800 + sends.length) }));
  });
  const service = f.serviceWith(transport);
  await service.poll();
  const prompts = f.calls.filter(call => call.name === 'prompt');
  assert.equal(prompts.length, 3);
  for (const [index, prompt] of prompts.entries()) {
    assert.equal(prompt.body.attachments[0].type, 'file');
    assert.deepEqual(readFileSync(prompt.body.attachments[0].path), fixtures[index].bytes);
    assert.equal(statSync(prompt.body.attachments[0].path).mode & 0o777, 0o400);
  }
  for (const item of fixtures) writeFileSync(join(f.source, item.name), item.bytes);
  await service.observe({ sessionId: 'session-original', cwd: f.source,
    event: event('media-reply', fixtures.map(item => `[result](${join(f.source, item.name)})`).join('\n')) });
  for (const item of fixtures) writeFileSync(join(f.source, item.name), 'mutated source');
  assert.deepEqual(uploads, fixtures.map(item => item.bytes));
  assert.deepEqual(sends.filter(send => send.item_list[0].type !== 1).map(send => send.item_list[0].type), [4, 2, 5]);
  const output = outputs(f).find(receipt => receipt.key.endsWith(':media-reply'));
  assert.equal(output.status, 'accepted');
  for (const file of output.media) assert.equal(statSync(file.path).mode & 0o777, 0o400);
  const retained = output.sent.find(part => part.file?.name === 'in.txt');
  await service.ingest([message('703', 'Quote file', { items: [{
    type: 1, text_item: { text: 'Quote file' }, ref_msg: { svr_id: retained.messageId,
      message_item: { type: 4, msg_id: 'unrelated-item-id' } },
  }] })], 'quote-cursor', f.store.read().binding);
  const quoted = f.calls.filter(call => call.name === 'prompt').at(-1).body;
  assert.match(quoted.text, /exact-local-id/);
  assert.deepEqual(readFileSync(quoted.attachments[0].path), fixtures[0].bytes);
});
test('live primary snapshots send immediately and deduplicate by event ID, not native message ID', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  for (const [id, content] of [['a', 'First'], ['b', 'Updated'], ['a', 'duplicate']])
    await observe(f, id, content, { data: { messageId: 'same-native-id', content } });
  for (const extra of [{ ephemeral: true }, { agentId: 'child' }, { parentToolCallId: 'tool' },
    { data: { content: 'child', agentId: 'child' } }, { data: { content: 'child', parentToolCallId: 'tool' } }])
    await observe(f, `ignored-${JSON.stringify(extra)}`, 'ignored', extra);
  assert.deepEqual(f.sent.map(send => send.items[0].text_item.text), ['First', 'Updated']);
  assert.equal(outputs(f).length, 2);
  assert(outputs(f).every(receipt => receipt.status === 'accepted'));
});
test('failed and ambiguous submissions never replay on duplicate poll, tick or restart and do not block later input', async t => {
  for (const kind of ['load-timeout', 'prompt-timeout', 'missing']) await t.test(kind, async t => {
    const f = fixture(t);
    await bind(f);
    if (kind !== 'load-timeout') f.setMeta({ ...f.getMeta(), loaded: true, status: 'idle' });
    f.setHook(name => {
      if (kind === 'missing' && name === 'session/get') return { meta: null };
      if (name === (kind === 'load-timeout' ? 'session/load' : 'prompt')) throw new Error('timeout');
    });
    await f.service.ingest([message('bad')], 'bad-cursor', f.store.read().binding);
    assert.equal(inputs(f)[0].status, kind === 'missing' ? 'failed' : 'unknown');
    f.setHook(undefined);
    const before = f.calls.filter(call => ['session/load', 'prompt'].includes(call.name)).length;
    f.transport.poll = async () => ({ messages: [message('bad')], cursor: 'duplicate' });
    await f.service.tick();
    await f.service.poll();
    const restarted = f.serviceWith(f.transport);
    await restarted.tick();
    await restarted.poll();
    assert.equal(f.calls.filter(call => ['session/load', 'prompt'].includes(call.name)).length, before);
    await restarted.ingest([message('good', 'later')], 'good-cursor', f.store.read().binding);
    assert.equal(inputs(f).at(-1).status, 'accepted');
    assert.equal(f.calls.filter(call => call.name === 'prompt').at(-1).body.text, 'later');
    assert(!f.calls.some(call => call.name === 'session/new'));
  });
});
test('failed and timeout outputs are diagnostic receipts, not a barrier or a retry schedule', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  await f.service.observe({ sessionId: 'session-original', cwd: f.source,
    event: event('historical-file', '[file](/never/read/mutable.txt)') }, false);
  assert.equal(outputs(f)[0].status, 'failed');
  assert.equal(outputs(f)[0].reason, 'HISTORICAL_FILE_SNAPSHOT_UNAVAILABLE');
  const originalSend = f.transport.send;
  let attempts = 0;
  f.transport.send = async (...args) => {
    attempts++;
    if (attempts === 1) throw new Error('timeout');
    return originalSend(...args);
  };
  await observe(f, 'timeout', 'uncertain');
  await observe(f, 'later', 'delivered');
  const observations = [event('timeout', 'uncertain'), event('later', 'delivered')];
  f.setEvents(observations);
  await f.service.tick();
  await f.service.poll();
  const restarted = f.serviceWith(f.transport);
  await restarted.tick();
  await restarted.observe({ sessionId: 'session-original', event: observations[0] });
  assert.equal(attempts, 2);
  assert.deepEqual(outputs(f).map(receipt => receipt.status), ['failed', 'unknown', 'accepted']);
  assert.deepEqual(f.sent.map(send => send.items[0].text_item.text), ['delivered']);
});
test('displayed pending questions route exact choice and freeform answers to respondAsk, never prompt', async t => {
  for (const [answer, freeform] of [['Blue', false], ['Custom', true]]) await t.test(answer, async t => {
    const f = fixture(t);
    await bind(f);
    await establishContext(f);
    f.getMeta().ask = { requestId: 'ask-1', question: 'Which color?', choices: ['Blue', 'Green'], allowFreeform: true };
    await f.service.tick();
    assert.match(f.sent.at(-1).items[0].text_item.text, /Which color\?[\s\S]*Blue/);
    assert.equal(f.store.read().question.request.requestId, 'ask-1');
    await f.service.ingest([message('answer', answer)], 'answered', f.store.read().binding);
    assert.deepEqual(f.calls.find(call => call.name === 'respondAsk').body,
      { sessionId: 'session-original', requestId: 'ask-1', answer, wasFreeform: freeform });
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.store.read().question.answered, true);
  });
});
test('rejected API sends preserve safe diagnostics without replay or changing unknown delivery semantics', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  const errors = [];
  f.context.report = error => errors.push(error);
  let attempts = 0;
  const transport = new WechatTransport({ account: 'account', peer: 'peer', token: 'synthetic-only' }, async () => {
    attempts++;
    return new Response(JSON.stringify(attempts === 1
      ? { ret: 1, errcode: 123, errmsg: 'SECRET_RESPONSE_TEXT', token: 'SECRET_RESPONSE_TOKEN' }
      : { ret: 0, message_id: '101' }));
  });
  const service = f.serviceWith(transport);
  const observation = { sessionId: 'session-original', event: event('rejected', 'reply') };
  await service.observe(observation);
  const failure = outputs(f)[0];
  assert.equal(failure.status, 'unknown');
  assert.equal(failure.reason, 'WECHAT_API_REJECTED');
  assert.deepEqual(failure.apiFailure, {
    endpoint: 'ilink/bot/sendmessage', httpStatus: 200, ret: 1, errcode: 123, errmsg: 'present',
    observedAt: failure.apiFailure.observedAt,
  });
  assert.deepEqual(f.store.read().lastApiFailure, failure.apiFailure);
  assert.deepEqual(errors[0].apiFailure, failure.apiFailure);
  assert(!JSON.stringify([errors, f.store.read()]).includes('SECRET_RESPONSE'));
  await service.observe(observation);
  assert.equal(attempts, 1);
  await service.observe({ sessionId: 'session-original', event: event('independent', 'new reply') });
  assert.equal(attempts, 2);
  assert.equal(outputs(f).at(-1).status, 'accepted');
  assert.deepEqual(f.store.read().lastApiFailure, failure.apiFailure);
  const reopened = new Store(f.store.root, 'fixture-account');
  try {
    assert.deepEqual(reopened.read().lastApiFailure, failure.apiFailure);
    assert.deepEqual(reopened.read().receipts.find(receipt => receipt.key === failure.key), failure);
  } finally { reopened.close(); }
});
test('poll rejection diagnostics reach the existing loop report without creating message receipts', async t => {
  const f = fixture(t);
  await bind(f);
  const reported = deferred();
  f.context.report = error => reported.resolve(error);
  const transport = new WechatTransport({ account: 'account', peer: 'peer', token: 'synthetic-only' }, async () =>
    new Response(JSON.stringify({ ret: -14, errmsg: 'SECRET_RESPONSE_TEXT' })));
  const service = f.serviceWith(transport);
  await service.start();
  const error = await reported.promise;
  await service.stop();
  assert.equal(error.message, 'WECHAT_TOKEN_EXPIRED');
  assert.equal(error.apiFailure.endpoint, 'ilink/bot/getupdates');
  assert.equal(error.apiFailure.ret, -14);
  assert.deepEqual(f.store.read().lastApiFailure, error.apiFailure);
  assert.equal(f.store.read().receipts.length, 0);
  assert(!JSON.stringify(error).includes('SECRET_RESPONSE'));
});
test('rejected reply contexts survive restart and resume only NEW output after different inbound context', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  let attempts = 0;
  const transport = { ...f.transport, async send() {
    attempts++;
    if (attempts === 1) throw new WechatApiError({ ret: -2, errmsg: 'private' }, 'ilink/bot/sendmessage');
    return { messageId: '123' };
  } };
  const service = f.serviceWith(transport);
  const observe = id => service.observe({ sessionId: 'session-original', event: event(id, id) });
  await observe('rejected');
  assert.equal(outputs(f).at(-1).status, 'unknown');
  assert(f.store.read().binding.replyContextRejection);
  await observe('suppressed');
  assert.equal(attempts, 1);
  assert.equal(outputs(f).at(-1).status, 'skipped');
  assert.equal(outputs(f).at(-1).reason, 'WECHAT_REPLY_CONTEXT_REJECTED');
  await service.ingest([message('initial', 'duplicate', { contextToken: 'not-a-new-input' })], 'duplicate', f.store.read().binding);
  await assert.rejects(service.ingest([message('unauthorized', 'no', {
    peer: 'other-peer', contextToken: 'not-authorized',
  })], 'unauthorized', f.store.read().binding), /INBOUND_IDENTITY/);
  assert(f.store.read().binding.replyContextRejection);
  const reopened = new Store(f.store.root, 'fixture-account');
  const restarted = new Service(f.context, f.config, reopened, transport);
  try {
    await restarted.observe({ sessionId: 'session-original', event: event('restart', 'new') });
    assert.equal(attempts, 1);
    assert.equal(reopened.read().receipts.at(-1).reason, 'WECHAT_REPLY_CONTEXT_REJECTED');
  } finally { await restarted.stop(); reopened.close(); }
  await service.ingest([message('same-token')], 'same', f.store.read().binding);
  await observe('same-still-rejected');
  assert.equal(attempts, 1);
  await service.ingest([message('new-token', 'new request', { contextToken: 'new-context' })], 'new', f.store.read().binding);
  assert.equal(f.store.read().binding.replyContextRejection, undefined);
  await observe('suppressed');
  await observe('rejected');
  assert.equal(attempts, 1);
  await observe('fresh-output');
  assert.equal(attempts, 2);
  assert.equal(outputs(f).at(-1).status, 'accepted');
  assert.equal(f.store.read().lastApiFailure.ret, -2);
});
test('only sendmessage ret=-2 suspends context; other API failures remain independent', async t => {
  for (const [endpoint, body] of [
    ['ilink/bot/getuploadurl', { ret: -2 }], ['ilink/bot/getupdates', { ret: -2 }],
    ['ilink/bot/sendmessage', { ret: -14 }], ['ilink/bot/sendmessage', { ret: 1 }],
    ['ilink/bot/sendmessage', { ret: 0, errcode: -2 }],
  ]) await t.test(`${endpoint}:${JSON.stringify(body)}`, async t => {
    const f = fixture(t);
    await bind(f);
    await establishContext(f);
    let attempts = 0;
    const service = f.serviceWith({ ...f.transport, async send() {
      attempts++;
      if (attempts === 1) throw new WechatApiError(body, endpoint);
      return {};
    } });
    await service.observe({ sessionId: 'session-original', event: event('bad', 'one') });
    assert.equal(f.store.read().binding.replyContextRejection, undefined);
    await service.observe({ sessionId: 'session-original', event: event('good', 'two') });
    assert.equal(attempts, 2);
    assert.equal(outputs(f).at(-1).status, 'accepted');
  });
});
test('queued old-context output is never borrowed into a new context and late rejection cannot poison it', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  const entered = deferred(), gate = deferred();
  const tokens = [];
  const service = f.serviceWith({ ...f.transport, async send(_items, token) {
    tokens.push(token);
    if (tokens.length === 1) { entered.resolve(); await gate.promise; }
    return {};
  } });
  const first = service.observe({ sessionId: 'session-original', event: event('first', 'one') });
  await entered.promise;
  const queued = service.observe({ sessionId: 'session-original', event: event('queued', 'two') });
  await service.ingest([message('fresh', 'new request', { contextToken: 'new-context' })], 'fresh', f.store.read().binding);
  gate.reject(new WechatApiError({ ret: -2 }, 'ilink/bot/sendmessage'));
  await Promise.all([first, queued]);
  assert.equal(f.store.read().binding.replyContextRejection, undefined);
  assert.equal(outputs(f).at(-1).reason, 'WECHAT_REPLY_CONTEXT_CHANGED');
  assert.equal(outputs(f).at(-1).status, 'skipped');
  await service.observe({ sessionId: 'session-original', event: event('new', 'three') });
  assert.deepEqual(tokens, ['synthetic-context', 'new-context']);
});
test('rejection suspends multipart tails and queued media without another API call', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  writeFileSync(join(f.source, 'file.txt'), 'file');
  const entered = deferred(), gate = deferred();
  let attempts = 0;
  const transport = new WechatTransport({ account: 'account', peer: 'peer', token: 'synthetic-only' }, async url => {
    attempts++;
    assert.equal(url.pathname, '/ilink/bot/sendmessage');
    if (attempts === 1) return new Response('{"ret":0,"message_id":"1"}');
    entered.resolve();
    await gate.promise;
    return new Response('{"ret":-2}');
  });
  const service = f.serviceWith(transport);
  const first = service.observe({ sessionId: 'session-original', event: event('multipart', 'x'.repeat(8000)) });
  await entered.promise;
  const queued = service.observe({ sessionId: 'session-original', cwd: f.source,
    event: event('media', `[file](${join(f.source, 'file.txt')})`) });
  gate.resolve();
  await Promise.all([first, queued]);
  assert.equal(attempts, 2);
  assert.equal(outputs(f)[0].sent.length, 1);
  assert.equal(outputs(f)[0].status, 'unknown');
  assert.equal(outputs(f)[1].status, 'skipped');
  assert.equal(outputs(f)[1].reason, 'WECHAT_REPLY_CONTEXT_REJECTED');
});
test('a rejected old binding cannot block its replacement even with the same token', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  const entered = deferred(), gate = deferred();
  let attempts = 0;
  const service = f.serviceWith({ ...f.transport, async send() {
    attempts++;
    if (attempts === 1) { entered.resolve(); await gate.promise; }
    return {};
  } });
  const pending = service.observe({ sessionId: 'session-original', event: event('old', 'one') });
  await entered.promise;
  const binding = await replace(f);
  await service.ingest([message('replacement', 'hello', { createdAt: binding.boundAt })], 'new', binding);
  gate.reject(new WechatApiError({ ret: -2 }, 'ilink/bot/sendmessage'));
  await pending;
  assert.equal(f.store.read().binding.replyContextRejection, undefined);
  await service.observe({ sessionId: 'replacement', event: event('new', 'two') });
  assert.equal(attempts, 2);
});
test('new inbound during a file upload prevents its old-context send', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  writeFileSync(join(f.source, 'upload.txt'), 'file');
  const entered = deferred(), gate = deferred();
  const sentTokens = [];
  const transport = new WechatTransport({ account: 'account', peer: 'peer', token: 'synthetic-only' }, async (url, init) => {
    if (url.pathname === '/ilink/bot/getuploadurl') return new Response('{"upload_param":"synthetic-upload"}');
    if (url.pathname === '/c2c/upload') {
      entered.resolve();
      await gate.promise;
      return new Response('', { headers: { 'x-encrypted-param': 'synthetic-receipt' } });
    }
    assert.equal(url.pathname, '/ilink/bot/sendmessage');
    sentTokens.push(JSON.parse(init.body).msg.context_token);
    return new Response('{"ret":0,"message_id":"42"}');
  });
  const service = f.serviceWith(transport);
  const output = service.observe({ sessionId: 'session-original', cwd: f.source,
    event: event('upload-race', `[file](${join(f.source, 'upload.txt')})`) });
  await entered.promise;
  await service.ingest([message('fresh', 'new', { contextToken: 'fresh-context' })], 'fresh', f.store.read().binding);
  gate.resolve();
  await output;
  assert.equal(outputs(f).at(-1).reason, 'WECHAT_REPLY_CONTEXT_CHANGED');
  assert.equal(outputs(f).at(-1).status, 'unknown');
  assert(sentTokens.every(token => token === 'synthetic-context'));
  const before = sentTokens.length;
  await service.observe({ sessionId: 'session-original', event: event('fresh-reply', 'new') });
  assert.equal(sentTokens.length, before + 1);
  assert.equal(sentTokens.at(-1), 'fresh-context');
});
test('upload URL rejection is attributed to the media output rather than to sendmessage', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  writeFileSync(join(f.source, 'result.txt'), 'synthetic file');
  const endpoints = [];
  const transport = new WechatTransport({ account: 'account', peer: 'peer', token: 'synthetic-only' }, async url => {
    endpoints.push(url.pathname);
    if (url.pathname.endsWith('/getuploadurl')) return new Response(JSON.stringify({ ret: 1, errcode: 456 }));
    assert.equal(url.pathname, '/ilink/bot/sendmessage');
    return new Response(JSON.stringify({ ret: 0, message_id: '101' }));
  });
  const service = f.serviceWith(transport);
  const observation = { sessionId: 'session-original', cwd: f.source,
    event: event('file', `[result](${join(f.source, 'result.txt')})`) };
  await service.observe(observation);
  const output = outputs(f)[0];
  assert.equal(output.status, 'unknown');
  assert.equal(output.apiFailure.endpoint, 'ilink/bot/getuploadurl');
  assert.equal(output.apiFailure.errcode, 456);
  assert.deepEqual(f.store.read().lastApiFailure, output.apiFailure);
  const before = endpoints.length;
  await service.observe(observation);
  assert.equal(endpoints.length, before);
  assert.equal(endpoints.filter(endpoint => endpoint.endsWith('/getuploadurl')).length, 1);
});
test('unpresented, disallowed, pre-presentation and media replies cannot answer a question or become prompts', async t => {
  for (const kind of ['unpresented', 'choice-only', 'old-timestamp', 'media']) await t.test(kind, async t => {
    const f = fixture(t);
    await bind(f);
    await establishContext(f);
    f.getMeta().ask = { requestId: 'ask-1', question: 'Which?', choices: ['Blue'], allowFreeform: kind !== 'choice-only' };
    if (kind !== 'unpresented') await f.service.tick();
    const extra = kind === 'old-timestamp' ? { createdAt: f.store.read().question.presentedAt - 1 }
      : kind === 'media' ? { items: [{ type: 4 }] } : {};
    await f.service.ingest([message('answer', 'custom', extra)], 'answer', f.store.read().binding);
    assert.equal(inputs(f).at(-1).status, 'failed');
    assert.equal(inputs(f).at(-1).reason, 'ANSWER_NOT_CURRENT_OR_NOT_ALLOWED');
    assert(!f.calls.some(call => call.name === 'respondAsk'));
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  });
});
test('invalid choices and query failures preserve a displayed pending question for a later valid answer', async t => {
  for (const kind of ['invalid-choice', 'query-failure']) await t.test(kind, async t => {
    const f = fixture(t);
    await bind(f);
    await establishContext(f);
    f.getMeta().ask = {
      requestId: 'still-pending', question: '[Which color?](/never/read/question.md)',
      choices: ['Blue'], allowFreeform: false,
    };
    await f.service.tick();
    const displayed = f.store.read().question;
    assert.equal(displayed.request.requestId, 'still-pending');
    assert.equal(displayed.answered, false);
    assert.match(f.sent.at(-1).items[0].text_item.text, /\[Which color\?\]\(\/never\/read\/question.md\)/);
    if (kind === 'query-failure') f.setHook(name => {
      if (name === 'session/get') throw new Error('SESSION_QUERY_FAILED');
    });
    await f.service.ingest([message('unsuccessful', kind === 'invalid-choice' ? 'Purple' : 'Blue')],
      'unsuccessful-cursor', f.store.read().binding);
    assert.equal(inputs(f).at(-1).status, 'failed');
    assert.equal(inputs(f).at(-1).reason,
      kind === 'invalid-choice' ? 'ANSWER_NOT_CURRENT_OR_NOT_ALLOWED' : 'SESSION_QUERY_FAILED');
    assert.deepEqual(f.store.read().question, displayed);
    assert(!f.calls.some(call => call.name === 'respondAsk'));
    f.setHook(undefined);
    await f.service.tick();
    assert.deepEqual(f.store.read().question, displayed);
    assert.equal(outputs(f).filter(receipt => receipt.key === 'ask:1:still-pending').length, 1);
    assert.equal(f.sent.filter(send => send.items[0].text_item?.text.includes('Which color?')).length, 1);
    await f.service.ingest([message('valid', 'Blue')], 'valid-cursor', f.store.read().binding);
    assert.deepEqual(f.calls.filter(call => call.name === 'respondAsk').map(call => call.body), [{
      sessionId: 'session-original', requestId: 'still-pending', answer: 'Blue', wasFreeform: false,
    }]);
    assert.equal(inputs(f).at(-1).status, 'accepted');
    assert.equal(f.store.read().question.answered, true);
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
  });
});
test('Web-answer races do not fall through to prompts or freeze the next question', async t => {
  for (const kind of ['already-answered', 'different-request', 'rejected-at-submit']) await t.test(kind, async t => {
    const f = fixture(t);
    await bind(f);
    await establishContext(f);
    f.getMeta().ask = { requestId: 'ask-1', question: 'First question?' };
    await f.service.tick();
    if (kind === 'already-answered') f.getMeta().ask = null;
    if (kind === 'different-request') f.getMeta().ask = { requestId: 'ask-2', question: 'Next question?' };
    if (kind === 'rejected-at-submit') f.setHook(name => {
      if (name === 'respondAsk') {
        f.getMeta().ask = { requestId: 'ask-2', question: 'Next question?' };
        throw Object.assign(new Error('Request no longer pending'), { code: 'REQUEST_NOT_PENDING' });
      }
    });
    await f.service.ingest([message('answer', 'my answer')], 'answer', f.store.read().binding);
    assert.equal(inputs(f).at(-1).status, 'failed');
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, 1);
    assert.equal(f.calls.filter(call => call.name === 'respondAsk').length, kind === 'rejected-at-submit' ? 1 : 0);
    assert.equal(f.store.read().question.answered, true);
    f.setHook(undefined);
    f.getMeta().ask = { requestId: 'ask-2', question: 'Next question?' };
    await f.service.tick();
    assert(f.sent.some(send => send.items[0].text_item?.text.includes('Next question?')));
  });
});
test('history anchors omit old events, walk new pages in order and suppress live/history duplicates', async t => {
  const f = fixture(t);
  f.setEvents([event('anchor', 'Never replay')]);
  await bind(f);
  await establishContext(f);
  await observe(f, 'e2', 'second');
  const queries = [];
  f.setHook((name, body) => {
    if (name !== 'session/chat') return;
    queries.push(body);
    const events = !body.cursor ? [event('e3', 'third'), event('e4', 'fourth')]
      : body.cursor === 'older-1' ? [event('e1', 'first'), event('e2', 'second')] : [event('anchor', 'Never replay')];
    return page(body, events, { hasMore: body.cursor !== 'older-2', cursor: !body.cursor ? 'older-1' : 'older-2' });
  });
  await f.service.tick();
  assert.deepEqual(f.sent.map(send => send.items[0].text_item.text), ['second', 'first', 'third', 'fourth']);
  assert.equal(f.store.read().binding.anchor, 'e4');
  assert.equal(queries.length, 3);
  assert(queries.every(query => query.source === 'persisted' && query.direction === 'backward'));
  await f.service.tick();
  assert.equal(f.sent.length, 4);
});
test('unknown legacy anchor baselines history without replay; missing anchor never blocks live input or output', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  f.store.change(state => { delete state.binding.anchor; });
  f.setEvents([event('old', 'old output')]);
  await f.service.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.read().binding.anchor, 'old');
  f.setEvents([event('unseen', 'not linked')]);
  await assert.rejects(f.service.tick(), /HISTORY_ANCHOR_MISSING/);
  await f.service.ingest([message('fresh')], 'fresh', f.store.read().binding);
  await observe(f, 'live', 'live output');
  assert.equal(inputs(f).at(-1).status, 'accepted');
  assert.equal(f.sent.at(-1).items[0].text_item.text, 'live output');
});
test('exact native user receipt association quotes the envelope ID, never an event UUID', async t => {
  const f = fixture(t);
  await bind(f);
  await f.service.ingest([message('501', 'Original input')], 'cursor', f.store.read().binding);
  await f.service.observe({ sessionId: 'session-original', event: {
    id: 'not-the-message-id', type: 'user.message', data: { messageId: 'native-receipt-Original input' },
  } });
  await observe(f, 'out', 'An answer');
  assert.equal(f.sent[0].items[0].ref_msg.svr_id, '501');
  await f.service.ingest([message('502', 'About that', { items: [{
    type: 1, text_item: { text: 'About that' }, ref_msg: { svr_id: '501' },
  }] })], 'cursor-2', f.store.read().binding);
  assert.match(f.calls.filter(call => call.name === 'prompt').at(-1).body.text, /exact-local-id[\s\S]*Original input/);
});
test('existence uncertainty, cancellation and all existing native states retain occupancy without history gates', async t => {
  for (const kind of ['throw', 'malformed', 'wrong-session', 'cancel', 'stopping', 'disposal', 'unloaded', 'idle', 'running', 'error'])
    await t.test(kind, async t => {
      const f = fixture(t);
      await bind(f);
      const before = f.store.read();
      const abort = new AbortController();
      f.setHook(name => {
        if (name !== 'session/get') return;
        if (kind === 'throw') throw new Error('not found');
        if (kind === 'malformed') return {};
        if (kind === 'wrong-session') return { meta: { ...f.getMeta(), sessionId: 'different' } };
        if (kind === 'cancel') { abort.abort(); return { meta: null }; }
        if (kind === 'stopping') { f.stopping.abort(); return { meta: null }; }
        if (kind === 'disposal') { f.signal.abort(); return { meta: null }; }
        return { meta: { ...f.getMeta(), loaded: kind !== 'unloaded', status: kind } };
      });
      const result = await f.manager.availability({ ...selection, sessionId: 'other' }, abort.signal);
      assert(result.reasons.some(reason => reason.code === 'BINDING_OCCUPIED'));
      assert.deepEqual(f.store.read(), before);
      await assert.rejects(f.manager.saved({ ...selection, sessionId: 'other', notificationId: 'new' }, abort.signal));
      assert.deepEqual(f.store.read(), before);
    });
});
test('availability aggregates configuration and unknown existence without inventing unresolved-history gates', async t => {
  const f = fixture(t);
  await bind(f);
  f.store.change(state => {
    state.lastError = 'UNKNOWN_SEND';
    state.receipts.push({ key: 'old', generation: 1, direction: 'output', status: 'unknown', text: 'old', media: [] });
  });
  f.setHook(name => { if (name === 'session/get') throw new Error('query failed'); });
  const manager = new BindingManager(f.context, f.store, () => ['MISSING_CONFIG']);
  assert.deepEqual(new Set((await manager.availability({ ...selection, sessionId: 'other' }, activeSignal()))
    .reasons.map(reason => reason.code)), new Set(['MISSING_CONFIG', 'BINDING_EXISTENCE_UNKNOWN', 'BINDING_OCCUPIED']));
});
test('saved replay stays idempotent after deletion and two concurrent saved candidates have one CAS winner', async t => {
  const f = fixture(t);
  await bind(f);
  const generation = f.store.read().generation;
  await f.manager.saved({ ...selection, notificationId: 'notification-1' }, activeSignal());
  assert.equal(f.store.read().generation, generation);
  f.setMeta(null);
  await f.manager.availability(selection, activeSignal());
  const entered = deferred(), releases = [];
  f.setHook((name, body) => {
    if (name !== 'session/chat') return;
    const gate = deferred();
    releases.push(() => gate.resolve(page(body, [])));
    if (releases.length === 2) entered.resolve();
    return gate.promise;
  });
  const saves = ['one', 'two'].map(sessionId => f.manager.saved({ ...selection, sessionId, notificationId: sessionId }, activeSignal()));
  await entered.promise;
  releases.forEach(release => release());
  const results = await Promise.allSettled(saves);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /BINDING_CHANGED/);
  assert.equal(f.store.read().notifications.length, 2);
  const state = f.store.read();
  await f.manager.saved({ ...selection, notificationId: 'notification-1' }, activeSignal());
  assert.deepEqual(f.store.read(), state);
});
test('late missing existence responses cannot retire a newer binding generation', async t => {
  const f = fixture(t);
  await bind(f);
  const gate = deferred();
  f.setHook(name => name === 'session/get' ? gate.promise : undefined);
  const pending = f.manager.availability({ ...selection, sessionId: 'other' }, activeSignal());
  f.store.change(state => { state.generation++; state.binding = { sessionId: 'new', generation: state.generation }; });
  gate.resolve({ meta: null });
  await pending;
  assert.equal(f.store.read().binding.sessionId, 'new');
});
test('schema-1 migration preserves queued, intent and unknown records verbatim without replay or changing credentials', async t => {
  const f = fixture(t);
  const root = directory(t);
  const seed = new Store(root, 'fixture-account');
  seed.close();
  const credentials = Buffer.from('{"account":"fixture","token":"synthetic-only"}\n');
  writeFileSync(join(root, 'credentials.json'), credentials, { mode: 0o600 });
  const legacy = {
    schema: 1, revision: 9, identity: 'fixture-account', generation: 2, binding: null,
    notifications: ['old-notification'], cursor: 'retained-cursor', retired: [{ sessionId: 'old', generation: 1, at: 123 }],
    fault: 'OLD_UNKNOWN', questions: [],
    inputs: ['queued', 'intent', 'unknown'].map((stage, index) => ({
      key: `account:${index}`, generation: 1, stage, operation: 'prompt', message: message(String(index)),
    })),
    outputs: ['queued', 'intent', 'unknown'].map(stage => ({
      key: `old-${stage}`, generation: 1, stage, kind: 'reply', text: `old ${stage}`, files: [],
      parts: [{ stage, clientId: stage }], ...(stage === 'unknown' ? { reason: 'WECHAT_API_REJECTED' } : {}),
    })),
  };
  const db = new DatabaseSync(join(root, 'native-v1.sqlite'));
  db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(legacy));
  db.close();
  let recovered = new Store(root, 'fixture-account');
  assert.deepEqual(recovered.read().legacy, legacy);
  assert.deepEqual(recovered.read().receipts.map(receipt => receipt.status), ['skipped', 'unknown', 'unknown', 'skipped', 'unknown', 'unknown']);
  assert.equal(recovered.read().receipts.at(-1).reason, 'WECHAT_API_REJECTED');
  assert.equal(recovered.read().cursor, 'retained-cursor');
  recovered.close();
  recovered = new Store(root, 'fixture-account');
  const service = new Service(f.context, f.config, recovered, f.transport);
  try {
    const manager = new BindingManager(f.context, recovered, () => []);
    assert.deepEqual((await manager.availability(selection, activeSignal())).reasons, []);
    await manager.saved({ ...selection, notificationId: 'replacement' }, activeSignal());
    await service.tick();
    await service.poll();
    assert(!f.calls.some(call => ['prompt', 'respondAsk', 'session/load'].includes(call.name)));
    assert.equal(f.sent.length, 0);
    assert.deepEqual(recovered.read().legacy, legacy);
    assert.deepEqual(readFileSync(join(root, 'credentials.json')), credentials);
  } finally { await service.stop(); recovered.close(); }
});
test('persisted adapter-2 unknown receipts survive reopening without becoming work', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  let sends = 0;
  f.transport.send = async () => { sends++; throw new Error('timeout'); };
  f.setHook(name => { if (name === 'prompt') throw new Error('timeout'); });
  await f.service.ingest([message('uncertain-input')], 'uncertain-cursor', f.store.read().binding);
  await observe(f, 'uncertain', 'possibly delivered');
  const prompts = f.calls.filter(call => call.name === 'prompt').length;
  const attempts = sends;
  f.setHook(undefined);
  f.transport.poll = async () => ({ messages: [message('uncertain-input')], cursor: 'repeated' });
  const root = directory(t);
  copyFileSync(join(f.store.root, 'native-v1.sqlite'), join(root, 'native-v1.sqlite'));
  const reopened = new Store(root, 'fixture-account');
  const service = new Service(f.context, f.config, reopened, f.transport);
  try {
    await service.tick();
    await service.poll();
    await service.observe({ sessionId: 'session-original', event: event('uncertain', 'possibly delivered') });
    assert.deepEqual(reopened.read().receipts, JSON.parse(JSON.stringify(f.store.read().receipts)));
    assert.equal(reopened.read().receipts.at(-1).status, 'unknown');
    assert.equal(f.calls.filter(call => call.name === 'prompt').length, prompts);
    assert.equal(sends, attempts);
  } finally { await service.stop(); reopened.close(); }
});
test('deletion during passive input lookup never loads or submits across the replacement binding', async t => {
  const f = fixture(t);
  await bind(f);
  const gate = deferred(), entered = deferred();
  const oldMeta = f.getMeta();
  let first = true;
  f.setHook(name => {
    if (name === 'session/get' && first) { first = false; entered.resolve(); return gate.promise; }
  });
  const incoming = f.service.ingest([message('old')], 'old', f.store.read().binding);
  await entered.promise;
  await replace(f);
  const replacement = f.store.read().binding;
  gate.resolve({ meta: oldMeta });
  await incoming;
  assert.deepEqual(f.store.read().binding, replacement);
  assert.equal(inputs(f)[0].reason, 'BINDING_CHANGED');
  assert(!f.calls.some(call => ['session/load', 'prompt'].includes(call.name)));
});
test('new bindings are allowed while old load/prompt effects resolve; completions update only old receipts', async t => {
  for (const kind of ['load', 'prompt-accepted', 'prompt-timeout']) await t.test(kind, async t => {
    const f = fixture(t);
    await bind(f);
    if (kind !== 'load') f.setMeta({ ...f.getMeta(), loaded: true, status: 'idle' });
    const effect = kind === 'load' ? 'session/load' : 'prompt';
    const gate = deferred(), entered = deferred();
    f.setHook(name => { if (name === effect) { entered.resolve(); return gate.promise; } });
    const incoming = f.service.ingest([message('old')], 'old', f.store.read().binding);
    await entered.promise;
    await replace(f);
    const replacement = f.store.read().binding;
    if (kind === 'prompt-timeout') gate.reject(new Error('timeout'));
    else gate.resolve(kind === 'load' ? { ok: true, sessionId: 'session-original' } : { ok: true, messageId: 'old-receipt' });
    await incoming;
    assert.deepEqual(f.store.read().binding, replacement);
    assert.equal(inputs(f)[0].status, kind === 'prompt-accepted' ? 'accepted' : 'unknown');
    assert.equal(f.store.read().lastError, undefined);
    assert.equal(f.sent.length, 0);
    f.setHook(undefined);
    await f.service.ingest([message('fresh', 'fresh input', { createdAt: replacement.boundAt + 1 })], 'fresh', replacement);
    assert.equal(inputs(f).at(-1).status, 'accepted');
    assert.equal(f.calls.filter(call => call.name === effect && call.body.sessionId === 'session-original').length, 1);
  });
});
test('new binding during an old send has no historical in-flight barrier; multipart tails never cross it', async t => {
  for (const multipart of [false, true]) await t.test(`multipart: ${multipart}`, async t => {
    const f = fixture(t);
    await bind(f);
    await establishContext(f);
    const gate = deferred(), entered = deferred();
    let attempts = 0;
    f.transport.send = async () => { attempts++; entered.resolve(); return gate.promise; };
    const outgoing = observe(f, 'old-send', multipart ? 'x'.repeat(4000) : 'one part');
    await entered.promise;
    await replace(f);
    const replacement = f.store.read().binding;
    gate.resolve({ messageId: 'old-message-id' });
    await outgoing;
    assert.deepEqual(f.store.read().binding, replacement);
    assert.equal(f.store.read().lastError, undefined);
    const receipt = outputs(f)[0];
    assert.equal(receipt.generation, 1);
    assert.equal(receipt.sent[0].messageId, 'old-message-id');
    assert.equal(receipt.status, multipart ? 'unknown' : 'accepted');
    await f.service.tick();
    assert.equal(attempts, 1);
  });
});
test('deletion during upload prevents a file send after replacement without retrying the upload', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  const path = join(f.source, 'attachment.txt');
  writeFileSync(path, 'frozen fixture');
  const gate = deferred(), entered = deferred();
  let uploads = 0;
  f.transport.call = async () => ({ upload_param: 'fake-upload' });
  f.transport.request = async () => { uploads++; entered.resolve(); return gate.promise; };
  const outgoing = observe(f, 'upload', `[file](${path})`);
  await entered.promise;
  await replace(f);
  const replacement = f.store.read().binding;
  gate.resolve({ headers: new Headers({ 'x-encrypted-param': 'fake-receipt' }) });
  await outgoing;
  assert.deepEqual(f.store.read().binding, replacement);
  assert.equal(uploads, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].items[0].type, 1);
  assert.equal(outputs(f)[0].status, 'unknown');
  assert.equal(outputs(f)[0].reason, 'BINDING_CHANGED');
  assert.equal(f.store.read().lastError, undefined);
  await f.service.tick();
  assert.equal(uploads, 1);
});
test('deletion during asynchronous live capture cannot send the captured file under the new binding', async t => {
  const f = fixture(t);
  await bind(f);
  await establishContext(f);
  const path = join(f.source, 'capture.txt');
  writeFileSync(path, 'captured fixture');
  const gate = deferred(), entered = deferred();
  const original = fsPromises.open;
  const mock = t.mock.method(fsPromises, 'open', async (...args) => {
    if (args[0] === path) { entered.resolve(); await gate.promise; }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const outgoing = observe(f, 'capture', `[file](${path})`);
    await entered.promise;
    await replace(f);
    const replacement = f.store.read().binding;
    gate.resolve();
    await outgoing;
    assert.deepEqual(f.store.read().binding, replacement);
    assert.equal(f.sent.length, 0);
    assert.equal(outputs(f)[0].reason, 'BINDING_CHANGED');
    assert.equal(f.store.read().lastError, undefined);
  } finally { gate.resolve(); mock.mock.restore(); syncBuiltinESMExports(); }
});
test('late polls retain old-generation diagnostics without rerouting, and fresh replacement traffic succeeds', async t => {
  const f = fixture(t);
  await bind(f);
  const gate = deferred();
  f.transport.poll = () => gate.promise;
  const polling = f.service.poll();
  const old = f.store.read().binding;
  const replacement = await replace(f);
  gate.resolve({ messages: [message('late')], cursor: 'late-cursor' });
  await polling;
  assert.equal(inputs(f)[0].generation, old.generation);
  assert.equal(inputs(f)[0].status, 'failed');
  assert.equal(inputs(f)[0].reason, 'BINDING_CHANGED');
  assert.equal(f.store.read().binding.contextToken, undefined);
  assert(!f.calls.some(call => call.name === 'prompt'));
  await f.service.ingest([message('prebinding', 'old', { createdAt: replacement.boundAt - 1 }),
    message('fresh', 'fresh', { createdAt: replacement.boundAt + 1 })], 'fresh-cursor', replacement);
  assert.equal(inputs(f)[1].reason, 'PREBINDING_INPUT_NOT_FORWARDED');
  assert.equal(inputs(f)[2].status, 'accepted');
  assert.deepEqual(f.calls.filter(call => call.name === 'prompt').map(call => call.body.sessionId), ['replacement']);
});
test('cancelled passive observation cannot retire a binding', async t => {
  for (const kind of ['stopping', 'disposal']) await t.test(kind, async t => {
    const f = fixture(t);
    await bind(f);
    const before = f.store.read();
    const gate = deferred();
    f.setHook(name => name === 'session/get' ? gate.promise : undefined);
    const tick = f.service.tick();
    (kind === 'stopping' ? f.stopping : f.signal).abort();
    gate.resolve({ meta: null });
    await assert.rejects(tick, /SERVICE_STOPPING/);
    assert.deepEqual(f.store.read(), before);
  });
});
test('graceful stop joins active prompt/send effects without adding a durable drain queue', async t => {
  for (const kind of ['prompt', 'send']) await t.test(kind, async t => {
    const f = fixture(t);
    await bind(f);
    await establishContext(f);
    const gate = deferred(), entered = deferred();
    if (kind === 'prompt') f.setHook(name => {
      if (name === 'prompt') { entered.resolve(); return gate.promise; }
    });
    else f.transport.send = async () => { entered.resolve(); return gate.promise; };
    const active = kind === 'prompt' ? f.service.ingest([message('active')], 'active', f.store.read().binding)
      : observe(f, 'active', 'active reply');
    await entered.promise;
    f.stopping.abort();
    let stopped = false;
    const stop = f.service.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    gate.resolve(kind === 'prompt' ? { ok: true, messageId: 'accepted-during-stop' } : { messageId: 'sent-during-stop' });
    await Promise.all([active, stop]);
    assert.equal((kind === 'prompt' ? inputs(f) : outputs(f)).at(-1).status, 'accepted');
    await assert.rejects(f.service.tick(), /SERVICE_STOPPING/);
    const count = f.calls.length;
    await f.service.ingest([message('after-stop')], 'after-stop', f.store.read().binding);
    await observe(f, 'after-stop', 'not sent');
    assert.equal(f.calls.length, count);
    for (const obsolete of ['inputs', 'outputs', 'retired', 'questions', 'fault']) assert(!(obsolete in f.store.read()));
  });
});
