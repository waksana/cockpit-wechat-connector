import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, stat, symlink, chmod, readdir, link } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WechatTransport, CDN_ORIGIN } from '../dist/transport.js';
import { downloadInbound, uploadOutbound, verifySnapshot, saveSnapshot, sniff, IMAGE_MAX_BYTES, MEDIA_MAX_BYTES } from '../dist/media.js';
import { captureReferences, hasLocalReferences } from '../dist/references.js';

const config = { account: 'test-bot', peer: 'test-peer', token: 'test-token' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from('ffd8ffc00008080001000201ffd9', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
async function fixture(t) {
  const root = resolve('test-native', `.media-fixture-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = join(root, 'sources');
  await mkdir(sources, { mode: 0o700 });
  return { root, sources, options: { cwd: sources, allowedRoots: [sources], deniedRoots: [], directory: join(root, 'snapshots') } };
}

test('CommonMark capture ignores inline, fenced, indented, escaped examples and remote links', async t => {
  const { sources, options } = await fixture(t);
  await writeFile(join(sources, 'ordinary.txt'), 'original bytes');
  const text = '`[inline](missing)`\n\n~~~md\n[fenced](missing)\n~~~\n\n    [indented](missing)\n\n\\[escaped](missing)\n\n[remote](https://example.test/x)\n[send](ordinary.txt)';
  const result = await captureReferences(text, options);
  assert.equal(result.files.length, 1);
  assert.equal(await readFile(result.files[0].path, 'utf8'), 'original bytes');
  assert.match(result.text, /\[remote\]\(https:\/\/example.test\/x\)/);
  assert.ok(result.text.endsWith('send'));
  assert.equal(hasLocalReferences('`[x](/secret)`\n\n```\n[x](/secret)\n```\n\n    [x](/secret)'), false);
  assert.equal(hasLocalReferences('[local](./file)'), true);
  assert.equal(hasLocalReferences('[remote](https://example.test/x)'), false);
});

test('absolute paths, file URLs, relative names with spaces, parentheses and reference links snapshot in order', async t => {
  const { sources, options } = await fixture(t);
  for (const name of ['a.txt', 'space name.txt', 'paren(s).txt']) await writeFile(join(sources, name), name);
  const text = `[a](${join(sources, 'a.txt')}) [b](${pathToFileURL(join(sources, 'space name.txt'))}) [c](paren\\(s\\).txt) [d][ref]\n\n[ref]: a.txt`;
  const result = await captureReferences(text, options);
  assert.deepEqual(result.files.map(file => file.name), ['a.txt', 'space name.txt', 'paren(s).txt', 'a.txt']);
  assert.equal((await stat(result.files[0].path)).mode & 0o777, 0o400);
  assert.equal((await stat(options.directory)).mode & 0o777, 0o700);
  await writeFile(join(sources, 'a.txt'), 'changed after capture');
  assert.equal(await readFile(result.files[0].path, 'utf8'), 'a.txt');
});

test('capture refuses credential names, denied roots, traversal, symlinks, directories and sibling-prefix escapes', async t => {
  const { root, sources, options } = await fixture(t);
  await writeFile(join(sources, '.env'), 'not-real-secret');
  await writeFile(join(sources, 'config.json'), '{}');
  await writeFile(join(root, 'outside.txt'), 'outside');
  await writeFile(join(sources, 'normal.txt'), 'normal');
  await symlink(join(sources, 'normal.txt'), join(sources, 'alias.txt'));
  await mkdir(join(sources, 'folder'));
  execFileSync('mkfifo', [join(sources, 'pipe')]);
  await mkdir(`${sources}-sibling`);
  await writeFile(join(`${sources}-sibling`, 'x'), 'outside');
  for (const destination of ['.env', 'config.json', '../outside.txt', 'alias.txt', 'folder', 'pipe', `${sources}-sibling/x`]) {
    await assert.rejects(captureReferences(`[x](${destination})`, options));
  }
  await assert.rejects(captureReferences('[x](normal.txt)', { ...options, deniedRoots: [sources] }), /FILE_REFERENCE_REFUSED/);
  await symlink(sources, join(root, 'alias-directory'));
  await assert.rejects(captureReferences(`[x](${join(root, 'alias-directory', 'normal.txt')})`,
    { ...options, allowedRoots: [root] }), /SYMLINK_REFUSED/);
});

test('failed capture removes its partial snapshots and aborted capture reads nothing', async t => {
  const { sources, options } = await fixture(t);
  await writeFile(join(sources, 'good.txt'), 'good');
  await assert.rejects(captureReferences('[ok](good.txt) [bad](missing.txt)', options));
  assert.deepEqual(await readdir(options.directory), []);
  const controller = new AbortController();
  controller.abort(new Error('STOPPED'));
  await assert.rejects(captureReferences('[x](good.txt)', options, controller.signal), /STOPPED/);
});

test('media type derives from PNG JPEG and ISO-BMFF headers, never names alone', async t => {
  const { sources, options } = await fixture(t);
  await writeFile(join(sources, 'not-an-image.png'), 'just text');
  await writeFile(join(sources, 'opaque.bin'), mp4);
  const result = await captureReferences('[x](not-an-image.png) [y](opaque.bin)', options);
  assert.deepEqual(result.files.map(file => file.kind), ['file', 'video']);
  assert.equal(sniff(mp4).mime, 'video/mp4');
  assert.throws(() => sniff(Buffer.from('ffd80000', 'hex')), /INVALID_JPEG/);
  assert.throws(() => sniff(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(10)])), /INVALID_PNG/);
  assert.throws(() => sniff(Buffer.alloc(MEDIA_MAX_BYTES + 1)), /MEDIA_TOO_LARGE/);
  assert.throws(() => sniff(Buffer.concat([Buffer.from('ffd8', 'hex'), Buffer.alloc(IMAGE_MAX_BYTES)])), /IMAGE_TOO_LARGE/);
});

test('encrypted inbound ordinary file is retained privately with exact plaintext size and hash', async t => {
  const { root } = await fixture(t);
  const bytes = Buffer.from('ordinary document'), key = Buffer.alloc(16, 9);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  let request;
  const transport = new WechatTransport(config, async (url, init) => {
    request = { url: url.href, ...init };
    return new Response(ciphertext);
  });
  const file = await downloadInbound(transport, {
    type: 4, file_item: { file_name: '../../example.txt', len: String(bytes.length), md5: md5(bytes),
      media: { encrypt_query_param: 'test-param', aes_key: key.toString('base64'), encrypt_type: 1 } },
  }, join(root, 'incoming'));
  assert.deepEqual(await readFile(file.path), bytes);
  assert.equal(file.name, 'example.txt');
  assert.equal(file.kind, 'file');
  assert.equal((await stat(file.path)).mode & 0o777, 0o400);
  assert.ok(request.url.startsWith(`${CDN_ORIGIN}/c2c/download?`));
  assert.equal(request.redirect, 'manual');
  assert.equal(request.headers, undefined);
});

test('inbound file hash/size mismatch, false image and redirected CDN fail closed', async t => {
  const { root } = await fixture(t);
  const bytes = Buffer.from('not an image');
  const plaintextImage = { type: 2, image_item: { media: { encrypt_query_param: 'x', encrypt_type: 0 } } };
  await assert.rejects(downloadInbound(new WechatTransport(config, async () => new Response(bytes)), plaintextImage, join(root, 'incoming')), /INBOUND_IMAGE_UNSUPPORTED/);
  await assert.rejects(downloadInbound(new WechatTransport(config, async () => new Response('', { status: 302 })), plaintextImage, join(root, 'incoming')), /HTTP_REDIRECT_REFUSED/);
  const key = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  for (const details of [{ len: 999 }, { md5: '0'.repeat(32) }]) {
    const item = { type: 4, file_item: { media: { encrypt_query_param: 'x', aes_key: key.toString('base64') }, ...details } };
    await assert.rejects(downloadInbound(new WechatTransport(config, async () => new Response(ciphertext)), item, join(root, 'incoming')), /MEDIA_(SIZE|HASH)_MISMATCH/);
  }
});

test('upload verifies immutable captured bytes and uses exact Tencent encryption and file envelope', async t => {
  const { root } = await fixture(t);
  const bytes = Buffer.from('captured, not a source path');
  const snapshot = await saveSnapshot(bytes, 'example.txt', join(root, 'outbound'));
  let upload;
  const transport = new WechatTransport(config, async (url, init) => {
    if (url.pathname === '/ilink/bot/getuploadurl') {
      upload = JSON.parse(init.body);
      return new Response(JSON.stringify({ upload_param: 'test-upload' }));
    }
    assert.equal(url.origin, CDN_ORIGIN);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, 'manual');
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
    assert.deepEqual(Buffer.concat([decipher.update(init.body), decipher.final()]), bytes);
    return new Response('', { headers: { 'x-encrypted-param': 'test-download' } });
  });
  const item = await uploadOutbound(transport, snapshot);
  assert.equal(upload.media_type, 3);
  assert.equal(upload.to_user_id, config.peer);
  assert.equal(upload.rawfilemd5, md5(bytes));
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, 'example.txt');
  assert.equal(item.file_item.len, String(bytes.length));
  assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').toString(), upload.aeskey);
});

test('changed, writable, hardlinked and symlink snapshots are rejected before any network request', async t => {
  const { root } = await fixture(t);
  const snapshot = await saveSnapshot(Buffer.from('original'), 'x', join(root, 'outbound'));
  const transport = new WechatTransport(config, async () => assert.fail('must not fetch'));
  await assert.rejects(uploadOutbound(transport, { ...snapshot, sha256: '0'.repeat(64) }), /SNAPSHOT_CHANGED/);
  await chmod(snapshot.path, 0o600);
  await assert.rejects(uploadOutbound(transport, snapshot), /SNAPSHOT_NOT_IMMUTABLE/);
  await writeFile(snapshot.path, 'tampered');
  await chmod(snapshot.path, 0o400);
  await assert.rejects(uploadOutbound(transport, snapshot), /SNAPSHOT_CHANGED/);
  await link(snapshot.path, join(root, 'linked'));
  await assert.rejects(uploadOutbound(transport, snapshot), /SNAPSHOT_NOT_IMMUTABLE/);
  await symlink(snapshot.path, join(root, 'alias'));
  await assert.rejects(uploadOutbound(transport, { ...snapshot, path: join(root, 'alias') }), /SYMLINK_REFUSED/);
});

test('retained incoming snapshots can be verified locally before quote reuse', async t => {
  const { root } = await fixture(t);
  const snapshot = await saveSnapshot(Buffer.from('retained original'), 'quote.txt', join(root, 'incoming'));
  assert.equal(await verifySnapshot(snapshot), undefined);
  await assert.rejects(verifySnapshot({ ...snapshot, mime: 'image/png' }), /SNAPSHOT_TYPE_CHANGED/);
  await chmod(snapshot.path, 0o600);
  await writeFile(snapshot.path, 'changed original');
  await chmod(snapshot.path, 0o400);
  await assert.rejects(verifySnapshot(snapshot), /SNAPSHOT_CHANGED/);
});

for (const [name, bytes, kind, type, mediaType] of [
  ['PNG', png, 'image', 2, 1], ['JPEG', jpeg, 'image', 2, 1], ['MP4', mp4, 'video', 5, 2],
]) test(`${name} inbound and outbound retain original bytes and use correct media envelope`, async t => {
  const { root } = await fixture(t);
  const key = Buffer.alloc(16, 3);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const body = type === 2 ? 'image_item' : 'video_item';
  const item = { type, [body]: {
    media: { encrypt_query_param: 'test', aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 },
    ...(type === 5 ? { video_size: bytes.length } : {}),
  } };
  const snapshot = await downloadInbound(new WechatTransport(config, async () => new Response(ciphertext)), item, join(root, 'incoming'));
  assert.deepEqual(await readFile(snapshot.path), bytes);
  assert.equal(snapshot.kind, kind);
  let envelope;
  const transport = new WechatTransport(config, async (url, init) => {
    if (url.pathname === '/ilink/bot/getuploadurl') {
      envelope = JSON.parse(init.body);
      return new Response('{"ret":0,"upload_param":"upload-test"}');
    }
    return new Response('', { headers: { 'x-encrypted-param': 'download-test' } });
  });
  const outbound = await uploadOutbound(transport, snapshot);
  assert.equal(outbound.type, type);
  assert.equal(envelope.media_type, mediaType);
  assert.equal(outbound[body][type === 2 ? 'mid_size' : 'video_size'], ciphertext.length);
});

test('snapshot storage refuses symlink and publicly readable directories', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'public'), { mode: 0o755 });
  await chmod(join(root, 'public'), 0o755);
  await assert.rejects(saveSnapshot(Buffer.from('x'), 'x', join(root, 'public')), /PRIVATE_DIRECTORY_REQUIRED/);
  await symlink(join(root, 'public'), join(root, 'alias'));
  await assert.rejects(saveSnapshot(Buffer.from('x'), 'x', join(root, 'alias', 'child')), /PRIVATE_DIRECTORY_REQUIRED/);
});
