import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { fixture, incoming, credentials, testPng } from './helpers.js';
import { SessionBridge } from '../src/session-bridge.js';
import { resolveJob } from '../src/bridge.js';
import { Store } from '../src/storage.js';
import { deliveryCheckpoint } from '../src/cockpit.js';
import { normalizeBatch } from '../src/weixin.js';
import { replyParts } from '../src/reply.js';
import { incomingQuoteItems } from '../src/quote.js';
import { cleanMediaScratch, inboundMediaUrl, mediaKey, MEDIA_MAX_BYTES, publishedMediaPath } from '../src/media.js';
import { dimensions } from '../src/image.js';

const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432000000086d646174', 'hex');
const file = Buffer.from('ordinary file, not an image');
const digest = bytes => createHash('md5').update(bytes).digest('hex');
function encrypt(bytes) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
function item(type, bytes, extra = {}) {
  const encrypted = encrypt(bytes);
  return { type, [{ 2: 'image_item', 4: 'file_item', 5: 'video_item' }[type]]: {
    media: { encrypt_query_param: `fixture-${type}`, aes_key: key.toString('base64'), encrypt_type: 1 },
    ...(type === 4 ? { file_name: 'report.svg', len: String(bytes.length), md5: digest(bytes) } : {}),
    ...(type === 5 ? { video_size: encrypted.length, video_md5: digest(bytes) } : {}),
    ...extra,
  } };
}
async function mediaFixture(t, options = {}) {
  const f = await fixture(t, { bridgeClass: SessionBridge, ...options });
  f.config.limits.textBytes = 1800;
  f.config.limits.requestTimeoutMs = 2000;
  f.store.set('historyCheckpoint', deliveryCheckpoint());
  const fetchImpl = f.weixin.fetchImpl;
  const downloads = [];
  f.weixin.fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.origin === 'https://novac2c.cdn.weixin.qq.com' && url.pathname === '/c2c/download') {
      downloads.push(url.href);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers, undefined);
      if (options.download) return options.download(url, init);
      const type = Number(url.searchParams.get('encrypted_query_param').split('-').at(-1));
      return new Response(encrypt({ 2: testPng, 4: file, 5: mp4 }[type]));
    }
    return fetchImpl(input, init);
  };
  return { ...f, downloads };
}

for (const representation of ['plain', 'cipher']) {
  test(`inbound video_size accepts exact ${representation} length`, async t => {
    const videoSize = representation === 'plain' ? mp4.length : encrypt(mp4).length;
    const f = await mediaFixture(t, { batch: [incoming({ item_list: [item(5, mp4, { video_size: videoSize })] })] });
    await f.bridge.receive(); await f.bridge.step();
    assert.equal(f.prompts.length, 1);
    assert.equal(f.store.jobs()[0].retainedMedia[0].size, mp4.length);
  });
}

test('phone JPEG trailing metadata is retained while a missing EOI is rejected', async t => {
  const jpeg = Buffer.from('ffd8ffc00008080001000201ffd9', 'hex');
  const original = Buffer.concat([jpeg, Buffer.alloc(24, 0x42)]);
  assert.deepEqual(dimensions(original, false), { width: 2, height: 1 });
  assert.throws(() => dimensions(jpeg.subarray(0, -2), false), { code: 'INVALID_JPEG' });
  const f = await mediaFixture(t, { batch: [incoming({ item_list: [item(2, original)] })],
    download: () => new Response(encrypt(original)) });
  await f.bridge.receive(); await f.bridge.step();
  assert.deepEqual(f.requests.find(row => row.url.startsWith('/upload?')).bytes, original);
});

test('a failed queued media input never changes an earlier accepted input', async t => {
  const f = await mediaFixture(t, { batch: [
    incoming({ message_id: 81, item_list: [item(5, mp4)] }),
    incoming({ message_id: 82, item_list: [item(2, Buffer.from('broken'))] }),
  ], download: url => new Response(encrypt(url.searchParams.get('encrypted_query_param') === 'fixture-5' ? mp4 : Buffer.from('broken'))) });
  await f.bridge.receive();
  await f.bridge.step();
  const previous = f.store.jobs()[0];
  previous.status = 'accepted'; f.store.save(previous);
  await assert.rejects(f.bridge.step(), { code: 'INBOUND_IMAGE_UNSUPPORTED' });
  assert.deepEqual(f.store.job(previous.id), previous);
  assert.equal(f.store.jobs()[1].status, 'blocked');
  assert.equal(f.store.jobs()[1].reason, 'INBOUND_IMAGE_UNSUPPORTED');
  assert.equal(f.prompts.length, 1);
});

test('video size mismatch cannot enqueue until explicitly resolved before any prompt', async t => {
  let truncated = true;
  const f = await mediaFixture(t, {
    batch: [incoming({ item_list: [item(5, mp4, { video_size: mp4.length })] })],
    download: () => new Response(encrypt(truncated ? mp4.subarray(0, -17) : mp4)),
  });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'MEDIA_SIZE_MISMATCH' });
  const job = f.store.jobs()[0];
  assert.equal(f.prompts.length, 0);
  job.status = 'blocked'; job.reason = 'MEDIA_SIZE_MISMATCH'; f.store.save(job);
  for (const extra of [
    { prompt: 'already prepared' }, { submissionId: 'submitted' }, { userMessageId: 'accepted' },
    { outbox: [] }, { followupEpoch: 'epoch' }, { reason: 'PROMPT_OUTCOME_UNKNOWN' },
  ]) {
    f.store.save({ ...job, ...extra });
    assert.throws(() => resolveJob(f.store, job.id, 'retry-media'), { code: 'MEDIA_RETRY_NOT_APPLICABLE' });
  }
  f.store.save(job);
  resolveJob(f.store, job.id, 'retry-media');
  truncated = false;
  await f.bridge.step();
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.store.job(job.id).status, 'done');
  assert.throws(() => resolveJob(f.store, job.id, 'retry-media'), { code: 'BLOCKED_JOB_REQUIRED' });
});

test('inbound mixed image/video/file stores original bytes before native enqueue; restart never replays', async t => {
  const f = await mediaFixture(t, { repeatBatch: true, batch: [incoming({ item_list: [
    { type: 1, text_item: { text: 'First line' } }, item(2, testPng), item(5, mp4),
    { type: 1, text_item: { text: 'Last line' } }, item(4, file),
  ] })] });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, 'enqueue');
  assert.equal(f.prompts[0].text, '');
  assert.equal(f.prompts[0].attachments, undefined);
  assert.ok(f.prompts[0].parts[0].text.endsWith('First line\n'));
  assert.deepEqual(f.prompts[0].parts.filter(part => part.type === 'file').map(part => [part.attachment.kind, part.attachment.mime]),
    [['image', 'image/png'], ['file', 'video/mp4'], ['file', 'application/octet-stream']]);
  assert.deepEqual(f.prompts[0].parts.map(part => part.type === 'file' ? part.attachment.mime : part.text.includes('Last line') ? 'last-caption' : 'text'),
    ['text', 'image/png', 'text', 'video/mp4', 'last-caption', 'application/octet-stream']);
  const posts = f.requests.filter(row => row.url.startsWith('/upload?'));
  assert.deepEqual(posts.map(row => row.bytes), [testPng, mp4, file]);
  assert.ok(posts.every(row => row.headers['content-type'] === 'application/octet-stream'));
  assert.equal(new Set(posts.map(row => new URL(row.url, 'http://mock').searchParams.get('sourceId'))).size, 3);
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.equal(Object.keys(f.store.jobs()[0].retainedMedia).length, 3);
  assert.deepEqual(f.store.jobs()[0].media, [{ index: 1, type: 2 }, { index: 2, type: 5 }, { index: 4, type: 4 }]);
  assert.match(f.store.jobs()[0].mediaFingerprint, /^[a-f0-9]{64}$/u);
  assert.ok(Object.values(f.store.jobs()[0].retainedMedia).every(attachment => /^[a-f0-9]{64}$/u.test(attachment.sha256)));
  assert.equal(fs.readdirSync(path.join(f.config.stateDir, 'media-work')).length, 0);
  f.closeStore();
  const store = new Store(f.config.stateDir);
  try {
    const bridge = new SessionBridge(f.config, credentials, store, f.weixin, f.cockpit, { log() {} });
    store.recover(); await bridge.receive(); await bridge.step();
    assert.equal(f.prompts.length, 1);
    assert.equal(f.downloads.length, 3);
  } finally { store.close(); }
});

for (const [type, bytes] of [[2, testPng], [5, mp4], [4, file]]) {
  test(`legacy unsupported media type ${type} remains terminal on redelivery without upgrading or blocking the batch`, async t => {
    const message = incoming({ item_list: [{ type: 1, text_item: { text: 'old caption' } }, item(type, bytes)] });
    const f = await mediaFixture(t, { batch: [message] });
    const legacy = { id: `${f.config.weixin.allowedAccount}:${message.message_id}`, marker: 'legacy-media',
      status: 'done', receivedAt: 1, peer: message.from_user_id, contextToken: message.context_token,
      kind: 'unsupported', original: '', quoteItems: incomingQuoteItems(message.item_list) };
    f.store.ingest([legacy], 'old-cursor', 20);
    f.store.set('pendingBatch', { msgs: [message], get_updates_buf: 'new-cursor' });
    await f.bridge.receive(); await f.bridge.step();
    assert.deepEqual(f.store.job(legacy.id), legacy);
    assert.equal(f.store.get('pendingBatch'), null);
    assert.equal(f.store.get('cursor'), 'new-cursor');
    assert.equal(f.downloads.length, 0);
    assert.equal(f.prompts.length, 0);
    f.store.set('pendingBatch', { msgs: [incoming({ message_id: 999 })], get_updates_buf: 'next-cursor' });
    await f.bridge.receive(); await f.bridge.step();
    assert.equal(f.prompts.length, 1, 'new text is not stranded behind a legacy media replay');
  });
}

test('fresh media stays between text interruption batches and enters the native queue exactly once', async t => {
  const f = await mediaFixture(t, { status: 'running', batch: [
    incoming({ message_id: 41, item_list: [{ type: 1, text_item: { text: 'first text' } }] }),
    incoming({ message_id: 42, item_list: [{ type: 1, text_item: { text: 'image caption' } }, item(2, testPng)] }),
    incoming({ message_id: 43, item_list: [{ type: 1, text_item: { text: 'last text' } }] }),
  ] });
  f.config.nativeInterruptFollowup = true;
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.downloads.length, 0);
  f.state.status = 'idle';
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].text.endsWith('first text'));
  await f.bridge.step();
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts[1].parts[0].text.includes('image caption'));
  assert.equal(f.prompts[1].parts.filter(part => part.type === 'file').length, 1);
  await f.bridge.step();
  assert.equal(f.prompts.length, 2);
  f.state.status = 'idle';
  await f.bridge.step();
  assert.equal(f.prompts.length, 3);
  assert.ok(f.prompts[2].text.endsWith('last text'));
  assert.equal(f.downloads.length, 1);
  assert.deepEqual(f.requests.filter(row => ['/intent/prompt', '/intent/session/interrupt'].includes(row.url)).map(row => row.url),
    ['/intent/session/interrupt', '/intent/prompt', '/intent/prompt', '/intent/session/interrupt', '/intent/prompt']);
});

test('partial inbound storage drops only retained CDN descriptors while immutable dedup survives retry', async t => {
  let failFile = true;
  const f = await mediaFixture(t, { repeatBatch: true,
    batch: [incoming({ item_list: [item(2, testPng), item(4, file)] })],
    download: url => {
      if (url.searchParams.get('encrypted_query_param') === 'fixture-4') {
        if (failFile) { failFile = false; throw new Error('fixture connection lost'); }
        return new Response(encrypt(file));
      }
      return new Response(encrypt(testPng));
    },
  });
  await f.bridge.receive();
  const original = f.store.jobs()[0];
  const fingerprint = original.mediaFingerprint;
  assert.ok(original.media.every(entry => entry.item));
  await assert.rejects(f.bridge.step(), { code: 'NETWORK_ERROR' });
  const partial = f.store.jobs()[0];
  assert.deepEqual(partial.media[0], { index: 0, type: 2 });
  assert.equal(partial.media[1].item.file_item.media.aes_key, key.toString('base64'));
  assert.equal(partial.mediaFingerprint, fingerprint);
  assert.equal(partial.contextToken, original.contextToken);
  assert.equal(f.prompts.length, 0);
  await f.bridge.receive();
  await f.bridge.step();
  assert.equal(f.downloads.filter(url => url.includes('fixture-2')).length, 1);
  assert.equal(f.uploads.size, 2);
  assert.equal(f.prompts.length, 1);
  assert.ok(f.store.jobs()[0].media.every(entry => !entry.item));
  assert.equal(f.store.jobs()[0].mediaFingerprint, fingerprint);
});

test('idempotent inbound upload retries after lost receipt without duplicate storage or prompt', async t => {
  const f = await mediaFixture(t, { uploadDisconnectOnce: true,
    batch: [incoming({ item_list: [item(4, file)] })] });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'NETWORK_ERROR' });
  assert.equal(f.uploads.size, 1);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.store.jobs()[0].status, 'queued');
  f.store.recover();
  await f.bridge.step();
  assert.equal(f.uploads.size, 1);
  assert.equal(f.prompts.length, 1);
  const identities = f.requests.filter(row => row.url.startsWith('/upload?')).map(row => row.url);
  assert.equal(identities[0], identities[1]);
});

test('inbound prompt unknown retains separately saved files and never re-enqueues', async t => {
  const f = await mediaFixture(t, { promptFault: 'disconnect',
    batch: [incoming({ item_list: [item(2, testPng)] })] });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'PROMPT_OUTCOME_UNKNOWN' });
  assert.equal(Object.keys(f.store.jobs()[0].retainedMedia).length, 1);
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'PROMPT_OUTCOME_UNKNOWN' });
  assert.equal(f.prompts.length, 1); assert.equal(f.downloads.length, 1);
});

test('authorized peers only: foreign/group media never downloads or saves', async t => {
  const items = [item(2, testPng)];
  const f = await mediaFixture(t, { batch: [
    incoming({ message_id: 1, from_user_id: 'foreign', item_list: items }),
    incoming({ message_id: 2, group_id: 'group', item_list: items }),
    incoming({ message_id: 3, to_user_id: 'foreign-bot', item_list: items }),
  ] });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.downloads.length, 0); assert.equal(f.uploads.size, 0); assert.equal(f.prompts.length, 0);
});

test('inbound media duplicate identity changes fail without advancing cursor', async t => {
  const f = await mediaFixture(t, { batch: [incoming({ item_list: [item(4, file)] })] });
  await f.bridge.receive(); await f.bridge.step();
  f.state.batch = [incoming({ item_list: [item(4, file, { len: '999' })] })];
  f.state.cursor = 'changed';
  await assert.rejects(f.bridge.receive(), { code: 'DUPLICATE_MESSAGE_CHANGED' });
  assert.equal(f.store.get('cursor'), 'cursor-1');
});

test('AES inbound keys accept raw/hex base64 and image hex override; invalid keys fail closed', () => {
  assert.deepEqual(mediaKey(item(4, file)), key);
  assert.deepEqual(mediaKey(item(5, mp4, { media: { aes_key: Buffer.from(key.toString('hex')).toString('base64') } })), key);
  assert.deepEqual(mediaKey(item(2, testPng, { aeskey: key.toString('hex'), media: { aes_key: 'invalid' } })), key);
  for (const invalid of ['', '!', Buffer.alloc(17).toString('base64'), 'a'.repeat(100)]) {
    assert.throws(() => mediaKey(item(4, file, { media: { aes_key: invalid } })), { code: 'MEDIA_KEY_INVALID' });
  }
});

test('CDN paths, URLs and redirects are strictly fenced', async t => {
  for (const url of ['https://evil.invalid/c2c/download', 'http://novac2c.cdn.weixin.qq.com/c2c/download',
    'https://novac2c.cdn.weixin.qq.com/a/../c2c/download', 'https://novac2c.cdn.weixin.qq.com/c2c/%64ownload',
    'https://novac2c.cdn.weixin.qq.com/c2c/download#x', 'https://novac2c.cdn.weixin.qq.com/c2c/../download',
    'https://user@novac2c.cdn.weixin.qq.com/c2c/download']) {
    assert.throws(() => inboundMediaUrl(item(4, file, { media: { full_url: url } })), { code: 'MEDIA_URL_REFUSED' });
  }
  const f = await mediaFixture(t, { batch: [incoming({ item_list: [item(4, file)] })],
    download: () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }) });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'MEDIA_DOWNLOAD_HTTP_302' });
  assert.equal(f.downloads.length, 1); assert.equal(f.uploads.size, 0); assert.equal(f.prompts.length, 0);
});

for (const [label, inbound, bytes, code] of [
  ['length', item(4, file, { len: '1' }), encrypt(file), 'MEDIA_SIZE_MISMATCH'],
  ['md5', item(4, file, { md5: '0'.repeat(32) }), encrypt(file), 'MEDIA_HASH_MISMATCH'],
  ['ciphertext', item(4, file), Buffer.from('broken'), 'MEDIA_DECRYPT_FAILED'],
  ['wrong image type', item(2, file), encrypt(file), 'INBOUND_IMAGE_UNSUPPORTED'],
  ['wrong video type', item(5, file), encrypt(file), 'INBOUND_VIDEO_UNSUPPORTED'],
  ['truncated PNG', item(2, testPng.subarray(0, 33)), encrypt(testPng.subarray(0, 33)), 'INVALID_PNG'],
  ['oversized metadata', item(4, file, { len: String(MEDIA_MAX_BYTES + 1) }), encrypt(file), 'MEDIA_TOO_LARGE'],
]) test(`corrupt/unsupported inbound ${label} never uploads or prompts`, async t => {
  const f = await mediaFixture(t, { batch: [incoming({ item_list: [inbound] })], download: () => new Response(bytes) });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code });
  assert.equal(f.uploads.size, 0); assert.equal(f.prompts.length, 0);
  const dir = path.join(f.config.stateDir, 'media-work');
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
});

test('streamed unknown-length overlimit response is cancelled and does not reach backend', async t => {
  let produced = 0;
  let cancelled = false;
  const f = await mediaFixture(t, { batch: [incoming({ item_list: [item(2, testPng)] })],
    download: () => new Response(new ReadableStream({
      pull(controller) { produced++; controller.enqueue(Buffer.alloc(65536)); },
      cancel() { cancelled = true; },
    })) });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'MEDIA_TOO_LARGE' });
  assert.ok(produced < 75); assert.equal(cancelled, true);
  assert.equal(f.uploads.size, 0); assert.equal(f.prompts.length, 0);
});

test('native outgoing IMAGE/VIDEO/FILE uses sniffed bytes and streams encrypted bodies with exact sizes', async t => {
  const f = await mediaFixture(t);
  const resources = { '/uploads/picture.dat': testPng, '/uploads/movie.jpg': mp4,
    '/uploads/vector.png': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') };
  f.state.managedFiles = resources;
  const requests = [];
  const fetchImpl = f.weixin.fetchImpl;
  f.weixin.fetchImpl = async (url, init) => {
    const target = new URL(url);
    if (target.pathname === '/ilink/bot/getuploadurl') requests.push(JSON.parse(init.body));
    if (target.origin === 'https://novac2c.cdn.weixin.qq.com' && target.pathname === '/c2c/upload') {
      assert.equal(Buffer.isBuffer(init.body), false);
      assert.equal(init.duplex, 'half');
      const chunks = []; for await (const chunk of init.body) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const request = requests.at(-1);
      const decipher = createDecipheriv('aes-128-ecb', Buffer.from(request.aeskey, 'hex'), null);
      const bytes = Buffer.concat([decipher.update(body), decipher.final()]);
      assert.deepEqual(bytes, Object.values(resources)[requests.length - 1]);
      assert.equal(request.rawsize, bytes.length);
      assert.equal(request.rawfilemd5, digest(bytes));
      assert.equal(request.filesize, body.length);
      assert.equal(request.no_need_thumb, true);
      return new Response(null, { headers: { 'x-encrypted-param': 'FIXTURE_RECEIPT' } });
    }
    return fetchImpl(url, init);
  };
  await f.bridge.receive(); await f.bridge.step();
  f.finish(Object.keys(resources).map(url => `[file](${url})`).join('\n'));
  await f.drain(12);
  assert.deepEqual(requests.map(value => value.media_type), [1, 2, 3]);
  assert.deepEqual(f.sent.map(value => value.msg.item_list[0].type), [2, 5, 4]);
  const [image, video, document] = f.sent.map(value => value.msg.item_list[0]);
  assert.equal(image.image_item.mid_size, requests[0].filesize);
  assert.equal(video.video_item.video_size, requests[1].filesize);
  assert.equal(document.file_item.len, String(resources['/uploads/vector.png'].length));
  assert.equal(document.file_item.file_name, 'vector.png');
  assert.equal(Buffer.from(video.video_item.media.aes_key, 'base64').toString(), requests[1].aeskey);
  assert.equal(fs.readdirSync(path.join(f.config.stateDir, 'media-work')).length, 0);
});

test('ordinary files larger than the image cap transfer natively without filename-based image inference', async t => {
  const f = await mediaFixture(t);
  const bytes = Buffer.alloc(5 * 1024 * 1024, 0x61);
  f.state.managedFiles = { '/uploads/not-an-image.png': bytes };
  await f.bridge.receive(); await f.bridge.step();
  f.finish('[original](/uploads/not-an-image.png)');
  await f.drain(5);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].msg.item_list[0].type, 4);
  assert.equal(f.sent[0].msg.item_list[0].file_item.len, String(bytes.length));
});

test('authoritative metadata hash mismatch cannot upload, and a full backend URL is never substituted', async t => {
  const f = await mediaFixture(t);
  await f.bridge.receive(); await f.bridge.step();
  f.finish('[original](/uploads/document.bin)');
  const call = f.cockpit.call.bind(f.cockpit);
  f.cockpit.call = async (name, body, signal) => name === 'files/get'
    ? { kind: 'file', name: 'document.bin', url: body.url, size: 8, mime: 'application/octet-stream', sha256: '0'.repeat(64) }
    : call(name, body, signal);
  await assert.rejects(f.bridge.step(), { code: 'MEDIA_HASH_MISMATCH' });
  assert.equal(f.sent.length, 0);
  assert.ok(!f.requests.some(row => row.url.endsWith('/getuploadurl')));
  f.cockpit.call = async (name, body, signal) => name === 'files/get'
    ? { kind: 'file', name: 'document.bin', url: 'https://evil.invalid/document.bin', size: 8, mime: 'application/octet-stream' }
    : call(name, body, signal);
  await assert.rejects(f.bridge.step(), { code: 'MANAGED_FILE_SCHEMA' });
  assert.equal(f.sent.length, 0);
});

test('empty ordinary files retain a valid native zero-byte FILE envelope', async t => {
  const f = await mediaFixture(t);
  f.state.managedFiles = { '/uploads/empty.txt': Buffer.alloc(0) };
  await f.bridge.receive(); await f.bridge.step(); f.finish('[empty](/uploads/empty.txt)');
  await f.drain(5);
  assert.equal(f.sent[0].msg.item_list[0].file_item.len, '0');
});

test('ordered native parts ignore duplicate legacy fields and quoted retained media attaches exact references', async t => {
  const f = await mediaFixture(t, { batch: [incoming({ item_list: [item(2, testPng)] })] });
  await f.bridge.receive(); await f.bridge.step();
  const retained = f.prompts[0].parts.find(part => part.type === 'file').attachment;
  f.state.batch = [incoming({ message_id: 43, item_list: [{ type: 1, text_item: { text: 'This image?' },
    ref_msg: { svr_id: '42', message_item: { type: 2 } } }] })];
  await f.bridge.receive(); await f.bridge.step();
  assert.deepEqual(f.prompts[1].parts.filter(part => part.type === 'file').map(part => part.attachment), [retained]);
  assert.match(f.prompts[1].parts.filter(part => part.type === 'text').map(part => part.text).join(''), /原件已保留并附上/);
  assert.equal(f.downloads.length, 1);
  const attachment = { kind: 'file', name: 'file', url: '/uploads/a.svg' };
  const message = { parts: [{ type: 'text', text: 'before' }, { type: 'file', attachment },
    { type: 'text', text: 'after' }], attachments: [attachment], attachment };
  assert.deepEqual(replyParts('duplicated text', f.config, attachment, message),
    [{ kind: 'text', value: 'before' }, { kind: 'media', uploadPath: '/uploads/a.svg' }, { kind: 'text', value: 'after' }]);
  assert.deepEqual(replyParts('[file](/uploads/a.svg)', f.config, attachment, { attachments: [attachment] }),
    [{ kind: 'media', uploadPath: '/uploads/a.svg' }]);
  assert.notEqual(deliveryCheckpoint({ id: 'x', role: 'assistant', content: '', ...message }).fingerprint,
    deliveryCheckpoint({ id: 'x', role: 'assistant', content: '', ...message, parts: [] }).fingerprint);
});

for (const type of ['file', 'video']) test(`unknown outgoing ${type} send blocks and never replays accepted parts`, async t => {
  const f = await mediaFixture(t);
  f.state.managedFiles = { '/uploads/document.bin': type === 'file' ? file : mp4 };
  await f.bridge.receive(); await f.bridge.step();
  f.finish('first[file](/uploads/document.bin)last');
  await f.bridge.step(); await f.bridge.step();
  f.state.sendFault = 'disconnect';
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 2);
  const job = f.store.jobs().find(value => value.kind === 'session-output');
  resolveJob(f.store, job.id, 'sent');
  f.state.sendFault = null; await f.drain(6);
  assert.equal(f.sent.length, 3);
});

test('no arbitrary fetch for code/local paths; stale owned media scratch is securely cleaned', async t => {
  const f = await mediaFixture(t);
  for (const target of ['/uploads/../x', '/uploads/%2e%2e/x', '/uploads/x?token=x', 'file:///etc/x',
    'https://evil.invalid/uploads/x']) assert.equal(publishedMediaPath(target, f.config.cockpit.webUrl), null);
  for (const content of ['`[file](/uploads/a.svg)`', '```\n[file](/uploads/a.mp4)\n```',
    '    [file](/uploads/a.bin)']) assert.ok(replyParts(content, f.config).every(part => part.kind === 'text'));
  const dir = path.join(f.config.stateDir, 'media-work');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, '12345678-1234-1234-1234-123456789abc.bin'), 'partial', { mode: 0o600 });
  cleanMediaScratch(f.config);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(normalizeBatch([incoming({ item_list: [{ type: 3, voice_item: {} }] })], f.config)[0].kind, 'unsupported');
});

test('legacy v2 baseline and accepted outbox ignore additive replay fields without backfilling media', async t => {
  const f = await mediaFixture(t);
  await f.bridge.receive(); await f.bridge.step();
  const baseline = deliveryCheckpoint(f.state.messages[0], 2);
  const legacy = { id: 'legacy-media', role: 'assistant', content: 'old published file',
    attachment: { kind: 'file', name: 'legacy', url: '/uploads/legacy.pdf', size: 8 } };
  const fingerprint = deliveryCheckpoint(legacy, 2).fingerprint;
  const job = { id: 'session-output:test-session:legacy-media', marker: 'legacy', kind: 'session-output',
    peer: credentials.peer, contextToken: 'FAKE_CONTEXT', status: 'replying', receivedAt: 1,
    original: legacy.content, outputMessageId: legacy.id, outputVersion: 2, outputFingerprint: fingerprint,
    outputBaseline: baseline, outboxPurpose: 'final', outbox: [
      { kind: 'text', value: 'old published file link already accepted', clientId: 'old-accepted', status: 'accepted' },
      { kind: 'text', value: 'old unsent tail', clientId: 'old-pending', status: 'pending' },
    ] };
  f.store.ingest([job], null, 100);
  f.store.set('historyCheckpoint', baseline);
  legacy.parts = [{ type: 'file', attachment: legacy.attachment }, { type: 'text', text: legacy.content }];
  legacy.attachments = [legacy.attachment];
  f.state.messages.push(legacy);
  assert.equal(deliveryCheckpoint(legacy, 2).fingerprint, fingerprint);
  assert.notEqual(deliveryCheckpoint(legacy).fingerprint, fingerprint);
  await f.bridge.step(); await f.bridge.step();
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].text_item.text), ['old unsent tail']);
  assert.equal(f.store.job(job.id).status, 'done');
  assert.equal(f.store.job(job.id).outputVersion, 2);
  assert.ok(!f.requests.some(row => row.url === '/intent/files/get'));
  // A checkpoint already past a fully accepted old output must also validate under v2.
  f.store.set('historyCheckpoint', deliveryCheckpoint(legacy, 2));
  await f.bridge.step();
  assert.equal(f.sent.length, 1);
  assert.equal(f.prompts.length, 1);
});

test('new v3 frozen output rejects ordered media changes even when legacy body/attachment are unchanged', async t => {
  const f = await mediaFixture(t);
  await f.bridge.receive(); await f.bridge.step();
  const attachment = { kind: 'file', name: 'original', url: '/uploads/original.bin' };
  f.finish('', { attachment, attachments: [attachment], parts: [{ type: 'file', attachment }] });
  await f.bridge.step();
  const output = f.store.jobs().find(job => job.kind === 'session-output');
  assert.equal(output.outputVersion, 3);
  f.state.messages.at(-1).parts = [{ type: 'file', attachment: { ...attachment, url: '/uploads/changed.bin' } }];
  await assert.rejects(f.bridge.step(), { code: 'FINAL_EVIDENCE_CHANGED' });
  assert.equal(f.sent.length, 0);
});

test('extensionless stable source names are resolved authoritatively and delivered as native images', async t => {
  const f = await mediaFixture(t);
  const resource = '/uploads/upload-v1-source-' + 'a'.repeat(64);
  f.state.managedFiles = { [resource]: testPng };
  await f.bridge.receive(); await f.bridge.step();
  f.finish(`[published original](${resource})`);
  await f.drain(5);
  assert.equal(f.sent[0].msg.item_list[0].type, 2);
  assert.ok(f.requests.some(row => row.url === '/intent/files/get' && row.data.url === resource));
});
