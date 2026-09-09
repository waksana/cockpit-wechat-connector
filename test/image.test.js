import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv, createHash } from 'node:crypto';
import { fixture, credentials } from './helpers.js';
import { deliverPublishedPng, imageUploadUrl } from '../src/image.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const resource = '/uploads/test-image.png';
const cdnOrigin = 'https://novac2c.cdn.weixin.qq.com';

async function imageFixture(t, options = {}) {
  const f = await fixture(t);
  await f.bridge.receive();
  const job = f.store.jobs()[0];
  job.status = 'done'; f.store.save(job); f.store.set('onceJobId', job.id);
  const before = JSON.stringify(f.store.jobs());
  const network = [];
  const originalFetch = f.weixin.fetchImpl;
  let uploadRequest;
  let ciphertext;
  f.weixin.fetchImpl = async (input, init) => {
    const url = new URL(input);
    network.push({ origin: url.origin, pathname: url.pathname, method: init.method });
    if (url.origin === f.config.cockpit.apiUrl && url.pathname === resource) {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers, undefined);
      return new Response(options.invalidPng ? Buffer.from('not a png') : png, {
        status: options.downloadRedirect ? 302 : 200, headers: { 'Content-Type': 'image/png' },
      });
    }
    if (url.origin === credentials.baseUrl && url.pathname === '/ilink/bot/getuploadurl') {
      uploadRequest = JSON.parse(init.body);
      return new Response(JSON.stringify(options.uploadResponse ?? { upload_param: 'FAKE_UPLOAD_PARAM' }));
    }
    if (url.origin === cdnOrigin) {
      assert.equal(init.redirect, 'manual');
      assert.deepEqual(init.headers, { 'Content-Type': 'application/octet-stream' });
      ciphertext = Buffer.from(init.body);
      if (options.disconnect) throw new Error('FAKE_SECRET_CONNECTION');
      return new Response(null, {
        status: options.cdnRedirect ? 302 : 200,
        headers: options.noReceipt ? {} : { 'x-encrypted-param': 'FAKE_DOWNLOAD_PARAM' },
      });
    }
    return originalFetch(input, init);
  };
  return { ...f, before, network, request: () => uploadRequest, ciphertext: () => ciphertext };
}

test('native published PNG pipeline encrypts original bytes and sends IMAGE with durable acceptance', async t => {
  const f = await imageFixture(t);
  const result = await deliverPublishedPng(f.config, credentials, f.store, f.weixin, resource);
  assert.deepEqual(result, { status: 'accepted', bytes: png.length, width: 1, height: 1,
    sha256: createHash('sha256').update(png).digest('hex') });
  const request = f.request();
  assert.equal(request.media_type, 1);
  assert.equal(request.rawsize, png.length);
  assert.equal(request.filesize, Math.ceil((png.length + 1) / 16) * 16);
  assert.equal(request.no_need_thumb, true);
  assert.equal(request.rawfilemd5, createHash('md5').update(png).digest('hex'));
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(request.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(f.ciphertext()), decipher.final()]), png);
  assert.equal(f.sent.length, 1);
  const msg = f.sent[0].msg;
  assert.equal(msg.to_user_id, credentials.peer);
  assert.equal(msg.context_token, 'FAKE_CONTEXT');
  assert.equal(msg.item_list[0].type, 2);
  const item = msg.item_list[0].image_item;
  assert.equal(item.mid_size, request.filesize);
  assert.equal(Buffer.from(item.media.aes_key, 'base64').toString(), request.aeskey);
  assert.equal(item.media.encrypt_query_param, 'FAKE_DOWNLOAD_PARAM');
  assert.equal(item.media.encrypt_type, 1);
  assert.equal(JSON.stringify(f.store.jobs()), f.before);
  assert.equal(f.store.get('onceJobId'), f.store.jobs()[0].id);
  const file = path.join(f.config.stateDir, 'image-deliveries',
    `${createHash('sha256').update(resource).digest('hex')}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!saved.includes(request.aeskey) && !saved.includes('FAKE_'));
  const count = f.network.length;
  await assert.rejects(deliverPublishedPng(f.config, credentials, f.store, f.weixin, resource),
    { code: 'IMAGE_ALREADY_ATTEMPTED_NO_REPLAY' });
  assert.equal(f.network.length, count);
});

test('native image refuses arbitrary sources and does not accept CDN host changes or API errors', async t => {
  const f = await imageFixture(t);
  for (const input of ['https://evil.test/x.png', '/home/user/x.png', '/uploads/../x.png',
    '/uploads/%2e%2e/x.png', '/uploads/x.png?secret=x', '/uploads/x.svg']) {
    await assert.rejects(deliverPublishedPng(f.config, credentials, f.store, f.weixin, input),
      { code: 'PUBLISHED_PNG_REQUIRED' });
  }
  assert.equal(f.network.length, 0);
  assert.throws(() => imageUploadUrl({ ret: -14, upload_param: 'p' }, 'k'), { code: 'WEIXIN_TOKEN_EXPIRED' });
  for (const url of ['https://evil.test/c2c/upload', 'http://novac2c.cdn.weixin.qq.com/c2c/upload',
    'https://u:p@novac2c.cdn.weixin.qq.com/c2c/upload', 'https://novac2c.cdn.weixin.qq.com/other']) {
    assert.throws(() => imageUploadUrl({ upload_full_url: url }, 'k'), { code: 'WEIXIN_CDN_HOST_REFUSED' });
  }
  assert.equal(imageUploadUrl({ upload_full_url: `${cdnOrigin}/c2c/upload?x=1` }, 'k').origin, cdnOrigin);
  assert.throws(() => imageUploadUrl({}, 'k'), { code: 'WEIXIN_UPLOAD_SCHEMA' });
});

for (const fault of ['disconnect', 'cdnRedirect', 'noReceipt']) {
  test(`native upload ${fault} stays unknown, sends no image and cannot replay`, async t => {
    const f = await imageFixture(t, { [fault]: true });
    await assert.rejects(deliverPublishedPng(f.config, credentials, f.store, f.weixin, resource),
      { code: 'IMAGE_OUTCOME_UNKNOWN' });
    assert.equal(f.sent.length, 0);
    const count = f.network.length;
    await assert.rejects(deliverPublishedPng(f.config, credentials, f.store, f.weixin, resource),
      { code: 'IMAGE_ALREADY_ATTEMPTED_NO_REPLAY' });
    assert.equal(f.network.length, count);
  });
}

test('native send disconnect after acceptance is never resent and old text jobs remain unchanged', async t => {
  const f = await imageFixture(t);
  f.state.sendFault = 'disconnect';
  await assert.rejects(deliverPublishedPng(f.config, credentials, f.store, f.weixin, resource),
    { code: 'IMAGE_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 1);
  await assert.rejects(deliverPublishedPng(f.config, credentials, f.store, f.weixin, resource),
    { code: 'IMAGE_ALREADY_ATTEMPTED_NO_REPLAY' });
  assert.equal(f.sent.length, 1);
  assert.equal(JSON.stringify(f.store.jobs()), f.before);
});

for (const fault of ['invalidPng', 'downloadRedirect']) {
  test(`native download ${fault} sends no upload or message`, async t => {
    const f = await imageFixture(t, { [fault]: true });
    await assert.rejects(deliverPublishedPng(f.config, credentials, f.store, f.weixin, resource),
      { code: fault === 'invalidPng' ? 'INVALID_PNG' : 'IMAGE_DOWNLOAD_HTTP_302' });
    assert.equal(f.network.length, 1);
    assert.equal(f.sent.length, 0);
  });
}
