import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { WechatTransport, API_ORIGIN, CDN_ORIGIN } from '../dist/transport.js';

const config = { account: 'test-bot', peer: 'test-peer', token: 'test-token' };
const message = (overrides = {}) => ({
  message_id: '18446744073709551615', from_user_id: config.peer, to_user_id: config.account,
  message_type: 1, message_state: 2, context_token: 'test-context',
  item_list: [{ type: 1, text_item: { text: 'hello' } }], ...overrides,
});
const json = value => new Response(JSON.stringify(value));

test('poll pins official origin and preserves uint64 message and quote IDs losslessly', async () => {
  let request;
  const transport = new WechatTransport(config, async (url, init) => {
    request = { url: url.href, ...init };
    return new Response('{"msgs":[{"message_id":18446744073709551615,"from_user_id":"test-peer","to_user_id":"test-bot","message_type":1,"message_state":2,"context_token":"test-context","create_time_ms":1234,"item_list":[{"type":1,"msg_id":9007199254740993,"text_item":{"text":"hello"},"ref_msg":{"svr_id":18446744073709551614,"partial_text":{"start":"first","end":"last"}}}]}],"get_updates_buf":"next"}');
  });
  const result = await transport.poll('previous');
  assert.equal(result.cursor, 'next');
  assert.equal(result.messages[0].id, '18446744073709551615');
  assert.equal(result.messages[0].items[0].msg_id, '9007199254740993');
  assert.equal(result.messages[0].quotes[0].svr_id, '18446744073709551614');
  assert.equal(result.messages[0].createdAt, 1234);
  assert.equal(request.url, `${API_ORIGIN}/ilink/bot/getupdates`);
  assert.equal(request.redirect, 'manual');
  assert.equal(request.headers.Authorization, 'Bearer test-token');
  assert.equal(JSON.parse(request.body).get_updates_buf, 'previous');
});

test('unauthorized and group messages are never enqueued, even with malformed items', async () => {
  const transport = new WechatTransport(config, async () => json({
    msgs: [message({ from_user_id: 'stranger', item_list: null }), message({ to_user_id: 'another-bot' }),
      message({ group_id: 'group', item_list: null }), message()], get_updates_buf: 'next',
  }));
  assert.equal((await transport.poll('')).messages.length, 1);
});

test('malformed known-authorized messages reject the entire poll without exposing a new cursor', async () => {
  for (const malformed of [
    { message_state: 1 }, { message_type: 2 }, { context_token: '' }, { item_list: [] },
    { item_list: [{ type: 3, voice_item: {} }] }, { message_id: '18446744073709551616' },
    { item_list: [{ type: 1, text_item: { text: 'hello' }, ref_msg: { svr_id: -1 } }] },
    { item_list: [{ type: 2, image_item: { media: { full_url: 'http://127.0.0.1/c2c/download' } } }] },
    { item_list: [{ type: 4, file_item: { media: { encrypt_query_param: 'missing-key' } } }] },
  ]) {
    const transport = new WechatTransport(config, async () => json({ msgs: [message(), message(malformed)], get_updates_buf: 'unsafe' }));
    await assert.rejects(transport.poll('before'));
  }
});

test('send uses bound peer and requires an explicit valid success receipt', async () => {
  let sent;
  const transport = new WechatTransport(config, async (_url, init) => {
    sent = JSON.parse(init.body).msg;
    return new Response('{"message_id":18446744073709551615}');
  });
  const result = await transport.send([{ type: 1, text_item: { text: 'reply' }, ref_msg: { svr_id: '9007199254740993' } }], 'context', 'client-1');
  assert.equal(result.messageId, '18446744073709551615');
  assert.equal(sent.to_user_id, config.peer);
  assert.equal(sent.context_token, 'context');
  assert.equal(sent.item_list[0].ref_msg.svr_id, '9007199254740993');
  for (const receipt of [{}, { ret: 1 }, { ret: 0, message_id: '0' }, { ret: 0, strange: true }, { ret: -14 }]) {
    await assert.rejects(new WechatTransport(config, async () => json(receipt)).send([{ type: 1, text_item: { text: 'x' } }], 'context', 'client'));
  }
  assert.deepEqual(await new WechatTransport(config, async () => json({ ret: 0 })).send([{ type: 1, text_item: { text: 'x' } }], 'context', 'client'), {});
});

test('origin overrides, credential URLs and redirects cannot leak authorization', async () => {
  for (const origin of ['http://ilinkai.weixin.qq.com', 'https://evil.example', `${API_ORIGIN}/`, `${API_ORIGIN}:443`]) {
    assert.throws(() => new WechatTransport({ ...config, apiOrigin: origin }), /API_ORIGIN_REFUSED/);
  }
  let calls = 0;
  const transport = new WechatTransport(config, async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
  });
  await assert.rejects(transport.poll(''), /HTTP_REDIRECT_REFUSED/);
  assert.equal(calls, 1);
  await assert.rejects(transport.request(new URL(`https://user@novac2c.cdn.weixin.qq.com/c2c/download`), {}, 100), /CDN_URL_REFUSED/);
  await assert.rejects(transport.request(new URL(`${CDN_ORIGIN}/other`), {}, 100), /CDN_URL_REFUSED/);
  assert.equal(calls, 1);
});

test('JSON responses have bounded body sizes and exact declared lengths', async () => {
  for (const response of [
    new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } }),
    new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    new Response('{}', { headers: { 'content-length': '1' } }),
  ]) await assert.rejects(new WechatTransport(config, async () => response).poll(''), /RESPONSE_/);
});

test('timeout and caller cancellation bound fetch and body even when an injected implementation ignores signal', async () => {
  const never = new Promise(() => {});
  await assert.rejects(new WechatTransport({ ...config, requestTimeoutMs: 15 }, () => never).poll(''), /REQUEST_TIMEOUT/);
  const transport = new WechatTransport({ ...config, requestTimeoutMs: 15 }, async () =>
    new Response(new ReadableStream({ pull: () => never })));
  await assert.rejects(transport.poll(''), /REQUEST_TIMEOUT/);
  const controller = new AbortController();
  controller.abort(new Error('TEST_STOPPED'));
  await assert.rejects(new WechatTransport(config, () => assert.fail('aborted request must not fetch')).poll('', controller.signal), /TEST_STOPPED/);
});
test('quoted image and file metadata do not require a new downloadable media envelope', async () => {
  const refs = [{ svr_id: '42', message_item: { type: 2 } },
    { svr_id: '43', message_item: { type: 4, file_item: { file_name: 'report.pdf' } } }];
  const transport = new WechatTransport(config, async () => json({
    msgs: refs.map((ref_msg, index) => message({ message_id: String(index + 1),
      item_list: [{ type: 1, text_item: { text: 'About this' }, ref_msg }] })), get_updates_buf: 'next',
  }));
  const result = await transport.poll('');
  assert.deepEqual(result.messages.map(message => message.quotes[0]), refs);
});
test('native fetch decompression accepts compressed receipts without comparing encoded and decoded lengths', async t => {
  const server = createServer((_request, response) => {
    const bytes = gzipSync(JSON.stringify({ message_id: '12345' }));
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': bytes.length });
    response.end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === 'object');
  const transport = new WechatTransport(config, (_url, init) => fetch(`http://127.0.0.1:${address.port}/fake`, init));
  assert.deepEqual(await transport.send([{ type: 1, text_item: { text: 'fake only' } }], 'synthetic', 'test'), { messageId: '12345' });
});
