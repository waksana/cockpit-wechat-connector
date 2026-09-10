import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { CockpitClient } from '../src/cockpit.js';
import { preparePublishedMedia, saveInboundMedia, uploadPreparedMedia } from '../src/media.js';
import { nativeMessages } from '../src/native-messages.js';

const backend = process.env.WEIXIN_TEST_BACKEND_URL;

test('isolated real Cockpit media schema/downloads produce verified fake-CDN IMAGE/VIDEO/FILE envelopes',
  { skip: !backend }, async t => {
    const origin = new URL(backend);
    assert.equal(origin.hostname, '127.0.0.1');
    assert.equal(origin.protocol, 'http:');
    assert.equal(origin.pathname, '/');
    assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash);
    assert.notEqual(origin.port, '8771', 'Never use the production backend for synthetic media writes');
    const health = await fetch(new URL('/health', origin), { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal((await health.json()).login, 'isolated-fixture', 'An explicitly isolated fixture backend is required');
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.backend-media-fixture-'));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true }));
    const config = {
      stateDir: dir,
      cockpit: { apiUrl: origin.origin, webUrl: origin.origin, sessionId: 'managed-media-browser-fixture' },
      weixin: { allowedPeer: 'isolated-fixture-only', allowedAccount: 'isolated-fixture-bot' },
      limits: { requestTimeoutMs: 15000 },
    };
    const requests = [];
    const cockpit = new CockpitClient(config, {
      token: null,
      fetchImpl: (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin, origin.origin, 'Only the explicitly supplied loopback fixture can receive HTTP');
        assert.ok(['/intent/files/list', '/intent/files/get', '/upload', '/intent/prompt', '/intent/session/chat'].includes(url.pathname)
          || (url.pathname.startsWith('/uploads/') && init.method === 'GET'));
        requests.push(url.pathname);
        return fetch(url, init);
      },
    });
    const listing = await cockpit.call('files/list', { sessionId: config.cockpit.sessionId });
    const cases = [
      ['fixture.png', 'image', 1, 2],
      ['fixture.mp4', 'video', 2, 5],
      ['fixture.txt', 'file', 3, 4],
      ['fixture.svg', 'file', 3, 4],
    ];
    const received = [];
    const job = { id: `${config.weixin.allowedAccount}:${randomUUID()}`, peer: config.weixin.allowedPeer };
    for (const [name, kind, mediaType, itemType] of cases) {
      const file = listing.files.find(value => value.name === name);
      assert.ok(file, `Synthetic fixture ${name} must exist`);
      const prepared = await preparePublishedMedia(config, cockpit, file.url);
      try {
        assert.equal(prepared.nativeKind, kind);
        assert.equal(prepared.size, file.size);
        assert.equal(prepared.sha256, file.sha256);
        assert.equal(prepared.attachment.name, name);
        assert.equal(prepared.attachment.path, undefined);
        assert.equal(fs.statSync(prepared.file).mode & 0o777, 0o600);
        assert.ok(prepared.file.startsWith(dir + path.sep));
        let upload;
        const client = {
          async call(endpoint, body) {
            assert.equal(endpoint, 'ilink/bot/getuploadurl');
            assert.equal(body.media_type, mediaType);
            assert.equal(body.rawsize, file.size);
            assert.equal(body.no_need_thumb, true);
            assert.equal(body.to_user_id, config.weixin.allowedPeer);
            upload = body;
            return { upload_param: 'LOCAL_FAKE_ONLY' };
          },
          async fetchImpl(input, init) {
            const url = new URL(input);
            assert.equal(url.origin, 'https://novac2c.cdn.weixin.qq.com');
            assert.equal(url.pathname, '/c2c/upload');
            assert.equal(init.redirect, 'manual');
            assert.equal(init.headers.Authorization, undefined);
            assert.equal(init.duplex, 'half');
            assert.equal(Buffer.isBuffer(init.body), false);
            const cipherHash = createHash('sha256');
            const plainHash = createHash('sha256');
            const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
            let size = 0;
            for await (const chunk of init.body) {
              size += chunk.length;
              cipherHash.update(chunk);
              plainHash.update(decipher.update(chunk));
            }
            plainHash.update(decipher.final());
            assert.equal(plainHash.digest('hex'), file.sha256);
            assert.equal(size, upload.filesize);
            assert.match(cipherHash.digest('hex'), /^[a-f0-9]{64}$/u);
            // Deliberately no fetch: Tencent/CDN traffic is entirely simulated.
            return new Response(null, { headers: { 'x-encrypted-param': 'LOCAL_FAKE_RECEIPT' } });
          },
        };
        const stages = [];
        const item = await uploadPreparedMedia(config, client, config.weixin.allowedPeer, prepared,
          stage => stages.push(stage));
        assert.equal(item.type, itemType);
        assert.deepEqual(stages, ['requesting_upload', 'uploading']);
        const body = item.image_item ?? item.video_item ?? item.file_item;
        assert.equal(Buffer.from(body.media.aes_key, 'base64').toString(), upload.aeskey);
        assert.equal(body.media.encrypt_type, 1);
        if (kind === 'image') assert.equal(body.mid_size, upload.filesize);
        else if (kind === 'video') assert.equal(body.video_size, upload.filesize);
        else {
          assert.equal(body.len, String(file.size));
          assert.equal(body.file_name, name);
        }
        const inbound = await saveInboundMedia(config, {
          async fetchImpl(input, init) {
            assert.equal(new URL(input).origin, 'https://novac2c.cdn.weixin.qq.com');
            assert.equal(new URL(input).pathname, '/c2c/download');
            assert.equal(init.headers, undefined);
            // Feed the exact synthetic original through native AES/CDN decoding,
            // then the real Cockpit streaming upload route. No Tencent request.
            return new Response(Readable.toWeb(fs.createReadStream(prepared.file)
              .pipe(createCipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null))));
          },
        }, cockpit, job, { index: received.length, item });
        assert.equal(inbound.sha256, file.sha256);
        assert.equal(inbound.size, file.size);
        if (kind === 'file') assert.equal(inbound.name, name);
        received.push(inbound);
      } finally { await prepared.remove(); }
    }
    assert.equal(requests.filter(value => value === '/intent/files/get').length, 4);
    assert.equal(requests.filter(value => value.startsWith('/uploads/')).length, 4);
    assert.equal(requests.filter(value => value === '/upload').length, 4);
    const parts = [{ type: 'text', text: 'Real backend ordered fixture start\n' },
      ...received.flatMap(attachment => [{ type: 'file', attachment }, { type: 'text', text: '\nnext fixture\n' }])];
    await cockpit.prompt('', undefined, undefined, parts);
    const history = await cockpit.nativePage({ source: 'persisted', direction: 'backward', max: 64 });
    const message = nativeMessages(history.events).findLast(value => value.role === 'user');
    assert.deepEqual(message.parts.map(part => part.type === 'text' ? part.text : part.attachment.url),
      parts.map(part => part.type === 'text' ? part.text : part.attachment.url));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'media-work')), []);
  });
