import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, credentials } from './helpers.js';
import { replyParts } from '../src/reply.js';
import { Bridge, resolveJob } from '../src/bridge.js';
import { SessionBridge } from '../src/session-bridge.js';
import { historyCheckpoint } from '../src/cockpit.js';
import { Store } from '../src/storage.js';
import { preparePublishedImage, publishedImagePath } from '../src/image.js';
import { setTimeout as delay } from 'node:timers/promises';

const web = 'https://cockpit.example.test';
const config = { cockpit: { webUrl: web }, limits: { textBytes: 1800, maxReplyParts: 32 } };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const reply = '图片前的文字\n\n![Logo](/uploads/logo.png)\n\n图片后的文字';

test('ordered reply parts split around published images and ordinary files', () => {
  assert.deepEqual(replyParts(reply, config), [
    { kind: 'text', value: '图片前的文字\n\n' }, { kind: 'image', uploadPath: '/uploads/logo.png' },
    { kind: 'text', value: '\n\n图片后的文字' },
  ]);
  assert.deepEqual(replyParts(`![a](${web}/uploads/a.jpg)![b](/uploads/b.JPEG)`, config),
    [{ kind: 'image', uploadPath: '/uploads/a.jpg' }, { kind: 'image', uploadPath: '/uploads/b.JPEG' }]);
  const files = replyParts('[PDF](/uploads/file.pdf) [PNG原文件](/uploads/file.png)', config);
  assert.deepEqual(files, [{ kind: 'media', uploadPath: '/uploads/file.pdf' },
    { kind: 'media', uploadPath: '/uploads/file.png' }]);
});

test('reference images resolve before splitting and code examples are never uploaded', () => {
  for (const syntax of ['![Logo][pic]', '![pic][]', '![pic]']) {
    const content = `${syntax}\n\n[pic]: /uploads/logo.png "title"`;
    assert.deepEqual(replyParts(content, config), [{ kind: 'image', uploadPath: '/uploads/logo.png' }]);
  }
  for (const code of [
    '`![Logo](/uploads/logo.png)`',
    '```markdown\n![Logo](/uploads/logo.png)\n```\n',
    '~~~\n![Logo](/uploads/logo.png)\n~~~\n',
    '```\n![Logo](/uploads/logo.png)',
    '    ![Logo](/uploads/logo.png)',
    '\t![Logo](/uploads/logo.png)',
    '说明\n\n    ![Logo](/uploads/logo.png)\n\n接下来的说明',
  ]) assert.deepEqual(replyParts(code, config), [{ kind: 'text', value: code }]);
  assert.equal(replyParts('\\![Logo](/uploads/logo.png)', config).some(part => part.kind === 'image'), false);
});

test('unsupported and foreign sources never become image fetches; reply count and size are bounded', () => {
  for (const target of ['https://evil.test/uploads/a.png', '/uploads/../a.png', '/uploads/a.png?x=1',
    '/uploads/%61.png', '/home/user/a.png', 'file:///home/user/a.png', '/uploads/a.svg', '/uploads/a.gif']) {
    assert.equal(replyParts(`![A](${target})`, config).some(part => part.kind === 'image'), false, target);
  }
  assert.equal(publishedImagePath('https://cockpit.example.test.evil/uploads/a.png', web), null);
  assert.throws(() => replyParts('![a](/uploads/a.png)'.repeat(33), config), { code: 'TOO_MANY_REPLY_PARTS' });
  assert.throws(() => replyParts('a'.repeat(1000001), config), { code: 'EMPTY_OR_OVERSIZED_REPLY' });
  const start = performance.now();
  assert.equal(replyParts('['.repeat(50000), { ...config, limits: { textBytes: 4000, maxReplyParts: 32 } })
    .every(part => part.kind === 'text'), true);
  assert.ok(performance.now() - start < 2000);
});

async function automaticFixture(t, options = {}) {
  const f = await fixture(t, options);
  if (options.bridgeClass === SessionBridge) f.store.set('historyCheckpoint', historyCheckpoint());
  f.config.limits.textBytes = 1800;
  const original = f.weixin.fetchImpl;
  const calls = [];
  f.weixin.fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.origin === f.config.cockpit.apiUrl && url.pathname.startsWith('/uploads/')) {
      if (options.onDownload) options.onDownload(f);
      return new Response(png, { status: options.downloadStatus ?? 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.origin === credentials.baseUrl && url.pathname === '/ilink/bot/getuploadurl') {
      if (options.uploadDisconnect) throw new Error('FAKE_NETWORK');
      return new Response(JSON.stringify({ upload_param: 'FAKE_PARAM' }));
    }
    if (url.origin === 'https://novac2c.cdn.weixin.qq.com') {
      return new Response(null, { headers: { 'x-encrypted-param': 'FAKE_DOWNLOAD' } });
    }
    return original(input, init);
  };
  f.cockpit.fetchImpl = f.weixin.fetchImpl;
  await f.bridge.receive(); await f.bridge.step();
  f.finish(options.reply ?? reply);
  await f.bridge.step(); await f.bridge.step();
  return { ...f, calls };
}

test('real mock bridge sends text-image-text in original order and never mutates Web history', async t => {
  const f = await automaticFixture(t, { repeatBatch: true });
  const original = f.state.messages.at(-1).content;
  assert.deepEqual(f.store.jobs()[0].outbox.map(part => part.kind), ['text', 'image', 'text']);
  await f.drain();
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].type), [1, 2, 1]);
  assert.ok(f.sent[0].msg.item_list[0].text_item.text.includes('图片前'));
  assert.ok(f.sent[2].msg.item_list[0].text_item.text.includes('图片后'));
  assert.equal(f.state.messages.at(-1).content, original);
  assert.equal(f.store.jobs()[0].status, 'done');
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.sent.length, 3);
  assert.equal(f.prompts.length, 1);
});

test('session mirror preserves native image ordering and its image rechecks under external activity', async t => {
  const f = await automaticFixture(t, { bridgeClass: SessionBridge });
  const output = () => f.store.jobs().find(job => job.kind === 'session-output');
  assert.deepEqual(output().outbox.map(part => part.kind), ['text', 'image', 'text']);
  assert.equal(output().outbox[1].imageStage, 'uploaded');
  f.state.messages.push({ id: 'external', role: 'user', content: 'Same conversation', timestamp: 30 });
  f.state.status = 'running';
  await f.bridge.step();
  assert.equal(f.sent.length, 2);
  f.finish('Next reply');
  await f.drain();
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].type), [1, 2, 1, 1]);
  assert.equal(f.calls.filter(call => call === '/ilink/bot/getuploadurl').length, 1);
});

test('native progress grouping propagates the same UUID through text-image-text outbox', async t => {
  const f = await fixture(t, { bridgeClass: SessionBridge });
  f.config.statusDisplay = { typing: false, tools: true, toolFormat: 'native' };
  f.config.limits.textBytes = 1800; f.store.set('historyCheckpoint', historyCheckpoint());
  await f.bridge.receive(); await f.bridge.step(); f.finish(reply);
  const runs = [];
  f.weixin.send = async (_peer, _context, _text, _id, _signal, options) => runs.push(options.runId);
  f.weixin.sendItems = async (_peer, _context, _items, _id, _signal, options) => runs.push(options.runId);
  await f.bridge.step();
  const job = f.store.jobs().find(item => item.kind === 'session-output');
  assert.match(job.runId, /^[0-9a-f-]{36}$/);
  job.outbox[1].imageItem = { type: 2, image_item: { media: {} } };
  f.store.save(job);
  await f.drain();
  assert.deepEqual(runs, [job.runId, job.runId, job.runId]);
});

test('uploaded image and accepted text survive database reopen without reupload or replay', async t => {
  const f = await automaticFixture(t);
  await f.bridge.step(); // text accepted
  await f.bridge.step(); // image uploaded, durable pending send
  assert.equal(f.store.jobs()[0].outbox[1].imageStage, 'uploaded');
  const clientId = f.store.jobs()[0].outbox[1].clientId;
  f.closeStore();
  const store = new Store(f.config.stateDir);
  try {
    store.recover();
    const bridge = new Bridge(f.config, credentials, store, f.weixin, f.cockpit);
    for (let i = 0; i < 4 && store.jobs()[0].status !== 'done'; i++) await bridge.step();
    assert.equal(store.jobs()[0].status, 'done');
    assert.deepEqual(f.sent.map(row => row.msg.item_list[0].type), [1, 2, 1]);
    assert.equal(f.sent[1].msg.client_id, clientId);
    assert.equal(f.calls.filter(call => call === '/ilink/bot/getuploadurl').length, 1);
  } finally { store.close(); }
});

test('unknown upload blocks later text, cannot be resolved as sent and is never retried', async t => {
  const f = await automaticFixture(t, { uploadDisconnect: true });
  await f.bridge.step();
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.jobs()[0].outbox[1].imageStage, 'requesting_upload');
  assert.throws(() => resolveJob(f.store, f.store.jobs()[0].id, 'sent'), { code: 'IMAGE_NOT_SENT' });
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.calls.filter(call => call === '/ilink/bot/getuploadurl').length, 1);
});

test('unknown native send blocks later text and explicit user confirmation only advances that image', async t => {
  const f = await automaticFixture(t);
  await f.bridge.step(); await f.bridge.step();
  f.state.sendFault = 'disconnect';
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 2);
  assert.equal(f.store.jobs()[0].outbox[1].imageStage, 'sending_image');
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 2);
  resolveJob(f.store, f.store.jobs()[0].id, 'sent');
  f.state.sendFault = null;
  await f.drain();
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].type), [1, 2, 1]);
});

test('final answer is checked again after image download and after upload before native send', async t => {
  const f = await automaticFixture(t);
  await f.bridge.step(); await f.bridge.step();
  f.state.messages.at(-1).content = 'different answer';
  await assert.rejects(f.bridge.step(), { code: 'FINAL_EVIDENCE_CHANGED' });
  assert.equal(f.sent.length, 1);
  const g = await automaticFixture(t, { onDownload: state => { state.state.messages.at(-1).content = 'changed'; } });
  await g.bridge.step();
  await assert.rejects(g.bridge.step(), { code: 'FINAL_EVIDENCE_CHANGED' });
  assert.equal(g.calls.filter(call => call === '/ilink/bot/getuploadurl').length, 0);
});

test('JPEG header validation preserves original bytes and rejects invalid or excessive dimensions', async () => {
  const jpeg = Buffer.from('ffd8ffc00008080001000201ffd9', 'hex');
  const c = { ...config, cockpit: { ...config.cockpit, apiUrl: 'http://127.0.0.1:8771' },
    limits: { ...config.limits, requestTimeoutMs: 1000 } };
  const fetchImpl = async () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
  const result = await preparePublishedImage(c, '/uploads/test.jpg', fetchImpl);
  assert.equal(result.width, 2); assert.equal(result.height, 1);
  assert.deepEqual(result.bytes, jpeg);
  await assert.rejects(preparePublishedImage(c, '/uploads/test.jpg', async () =>
    new Response(png, { headers: { 'Content-Type': 'image/jpeg' } })), { code: 'INVALID_JPEG' });
});

test('transient image download failure resumes safely before upload without blocking or duplicating text', async t => {
  const options = { downloadStatus: 503 };
  const f = await automaticFixture(t, options);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = f.bridge.run(controller.signal);
  const deadline = Date.now() + 5000;
  while (!f.logs.some(line => line.includes('MEDIA_DOWNLOAD_HTTP_503')) && Date.now() < deadline) await delay(10);
  assert.equal(f.store.jobs()[0].status, 'replying');
  assert.equal(f.store.jobs()[0].outbox[1].status, 'pending');
  assert.equal(f.calls.filter(call => call === '/ilink/bot/getuploadurl').length, 0);
  options.downloadStatus = 200;
  while (f.store.jobs()[0].status !== 'done' && Date.now() < deadline) await delay(10);
  controller.abort(); await running;
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].type), [1, 2, 1]);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.calls.filter(call => call === '/ilink/bot/getuploadurl').length, 1);
});
