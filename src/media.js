// CDN envelopes and AES encoding follow Tencent openclaw-weixin 2.4.8 (MIT).
// Copyright (C) 2026 Tencent. See THIRD_PARTY_NOTICES.md and LICENSE.tencent.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { BridgeError, errorCode, object, requireThat, text } from './common.js';
import { privateDirectory, secureExisting } from './storage.js';
import { imageUploadUrl, dimensions } from './image.js';

export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CDN = 'https://novac2c.cdn.weixin.qq.com';
const padded = size => Math.ceil((size + 1) / 16) * 16;

export function publishedMediaPath(target, webUrl) {
  if (typeof target !== 'string') return null;
  const origin = new URL(webUrl).origin;
  const value = target.startsWith(`${origin}/`) ? target.slice(origin.length) : target;
  return /^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,190}$/u.test(value) ? value : null;
}

export function mediaKey(item) {
  if (item.type === 2 && item.image_item?.aeskey !== undefined) {
    requireThat(typeof item.image_item.aeskey === 'string'
      && /^[a-f0-9]{32}$/iu.test(item.image_item.aeskey), 'MEDIA_KEY_INVALID');
    return Buffer.from(item.image_item.aeskey, 'hex');
  }
  const value = mediaBody(item)?.media?.aes_key;
  if (value === undefined && item.type === 2) return null;
  requireThat(typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
    && value.length <= 64, 'MEDIA_KEY_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 16) return bytes;
  requireThat(bytes.length === 32 && /^[a-f0-9]{32}$/iu.test(bytes.toString()), 'MEDIA_KEY_INVALID');
  return Buffer.from(bytes.toString(), 'hex');
}

const mediaBody = item => item?.[{ 2: 'image_item', 4: 'file_item', 5: 'video_item' }[item?.type]];

export function inboundMediaUrl(item) {
  const media = mediaBody(item)?.media;
  requireThat(object(media), 'MEDIA_REFERENCE_MISSING');
  if (media.encrypt_type !== undefined) requireThat([0, 1].includes(media.encrypt_type), 'MEDIA_ENCRYPTION_UNSUPPORTED');
  let value;
  if (media.full_url !== undefined) {
    requireThat(text(media.full_url, 16384), 'MEDIA_URL_REFUSED');
    value = media.full_url;
  } else {
    requireThat(text(media.encrypt_query_param), 'MEDIA_REFERENCE_MISSING');
    value = `${CDN}/c2c/download?${new URLSearchParams({ encrypted_query_param: media.encrypt_query_param })}`;
  }
  let url;
  try { url = new URL(value); } catch { throw new BridgeError('MEDIA_URL_REFUSED'); }
  requireThat(url.origin === CDN && url.pathname === '/c2c/download' && !url.username && !url.password
    && !url.hash && !/[\s\\]/u.test(value)
    && value.split('?')[0] === `${CDN}/c2c/download`, 'MEDIA_URL_REFUSED');
  return url;
}

export function validateUploadedFile(file, config, expectedUrl) {
  requireThat(object(file) && ['image', 'file'].includes(file.kind) && text(file.name, 1000)
    && publishedMediaPath(file.url, config.cockpit.webUrl) === file.url
    && (!expectedUrl || expectedUrl === file.url)
    && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MEDIA_MAX_BYTES
    && text(file.mime, 200) && (file.sha256 === undefined || /^[a-f0-9]{64}$/iu.test(file.sha256)),
  'MANAGED_FILE_SCHEMA');
  // No server paths or unrelated metadata enter the inbox or native prompt.
  return { kind: file.kind, name: file.name, url: file.url, size: file.size, mime: file.mime,
    ...(file.sha256 ? { sha256: file.sha256 } : {}) };
}

function scratch(config) {
  const dir = path.join(config.stateDir, 'media-work');
  privateDirectory(dir);
  const file = path.join(dir, `${randomUUID()}.bin`);
  return { file, remove: () => fs.promises.rm(file, { force: true }) };
}

export function cleanMediaScratch(config) {
  const dir = path.join(config.stateDir, 'media-work');
  if (!fs.existsSync(dir)) return;
  secureExisting(dir, true);
  for (const name of fs.readdirSync(dir)) {
    requireThat(/^[a-f0-9-]{36}\.bin$/u.test(name), 'UNSAFE_MEDIA_SCRATCH');
    const file = path.join(dir, name);
    secureExisting(file);
    fs.unlinkSync(file);
  }
}

async function response(fetchImpl, url, init, config, signal) {
  const timeout = AbortSignal.timeout(config.limits.requestTimeoutMs);
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const result = await fetchImpl(url, { ...init, redirect: 'manual', signal: linked });
    return { result, signal: linked };
  } catch {
    throw new BridgeError(signal?.aborted ? 'STOPPED' : timeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
  }
}

function meter(max, state) {
  return new Transform({ transform(chunk, _encoding, callback) {
    state.size = (state.size ?? 0) + chunk.length;
    if (state.size > max) return callback(new BridgeError('MEDIA_TOO_LARGE'));
    state.md5?.update(chunk); state.sha256?.update(chunk);
    callback(null, chunk);
  } });
}

async function saveResponse(result, linked, file, { key, max, videoSize, plainSize, md5, sha256 } = {}) {
  if (result.status !== 200) {
    await result.body?.cancel();
    throw new BridgeError(`MEDIA_DOWNLOAD_HTTP_${result.status}`);
  }
  const raw = { size: 0 };
  const plain = { size: 0, md5: createHash('md5'), sha256: createHash('sha256') };
  const contentLength = result.headers.get('content-length');
  try {
    if (contentLength !== null) requireThat(/^\d+$/u.test(contentLength)
      && Number(contentLength) <= (key ? padded(max) : max), 'MEDIA_TOO_LARGE');
    requireThat(result.body, 'MEDIA_DOWNLOAD_EMPTY');
    const stages = [Readable.fromWeb(result.body), meter(key ? padded(max) : max, raw)];
    if (key) stages.push(createDecipheriv('aes-128-ecb', key, null));
    stages.push(meter(max, plain), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    await pipeline(stages, { signal: linked });
  } catch (error) {
    await result.body?.cancel().catch(() => {});
    if (error instanceof BridgeError) throw error;
    if (error.code?.startsWith('ERR_OSSL_')) throw new BridgeError('MEDIA_DECRYPT_FAILED');
    throw new BridgeError('MEDIA_DOWNLOAD_FAILED');
  }
  requireThat(!key || (raw.size > 0 && raw.size % 16 === 0), 'MEDIA_CORRUPT');
  const hashes = { md5: plain.md5.digest('hex'), sha256: plain.sha256.digest('hex') };
  requireThat((contentLength === null || Number(contentLength) === raw.size)
    // Phone-originated video_size is plaintext length; bot envelopes also use
    // ciphertext length. Require an exact match to one measured representation.
    && (videoSize === undefined || videoSize === raw.size || videoSize === plain.size)
    && (plainSize === undefined || plainSize === plain.size), 'MEDIA_SIZE_MISMATCH');
  requireThat((md5 === undefined || md5.toLowerCase() === hashes.md5)
    && (sha256 === undefined || sha256.toLowerCase() === hashes.sha256), 'MEDIA_HASH_MISMATCH');
  return { size: plain.size, ...hashes };
}

export async function sniffMedia(file, size) {
  const handle = await fs.promises.open(file, 'r');
  const head = Buffer.alloc(512);
  let bytes;
  try { bytes = head.subarray(0, (await handle.read(head, 0, head.length, 0)).bytesRead); }
  finally { await handle.close(); }
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    || bytes.subarray(0, 2).toString('hex') === 'ffd8') {
    requireThat(size <= IMAGE_MAX_BYTES, 'IMAGE_TOO_LARGE');
    const png = bytes[0] === 0x89;
    const image = await fs.promises.readFile(file);
    const geometry = dimensions(image, png);
    if (png) {
      let offset = 8;
      let data = false;
      let ended = false;
      while (offset + 12 <= image.length) {
        const length = image.readUInt32BE(offset);
        requireThat(offset + 12 + length <= image.length, 'INVALID_PNG');
        const type = image.toString('ascii', offset + 4, offset + 8);
        requireThat(crc32(image.subarray(offset + 4, offset + 8 + length))
          === image.readUInt32BE(offset + 8 + length), 'INVALID_PNG');
        if (type === 'IDAT') data = true;
        offset += length + 12;
        if (type === 'IEND') { requireThat(length === 0, 'INVALID_PNG'); ended = true; break; }
      }
      requireThat(data && ended && offset === image.length, 'INVALID_PNG');
    }
    requireThat(geometry.width > 0 && geometry.width <= 8192 && geometry.height > 0 && geometry.height <= 8192,
      'IMAGE_DIMENSIONS_UNSUPPORTED');
    return { mime: png ? 'image/png' : 'image/jpeg', nativeKind: 'image', ...geometry };
  }
  // ISO-BMFF video brands only: HEIF/AVIF and arbitrary filename extensions are not video.
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp'
    && /^(isom|iso[2-6]|iso8|mp4[12]|avc1|M4V |MSNV|dash|qt  )$/u.test(bytes.toString('ascii', 8, 12))) {
    const length = bytes.readUInt32BE(0);
    requireThat(length >= 16 && length <= size, 'MEDIA_CORRUPT');
    return { mime: bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4', nativeKind: 'video' };
  }
  return { mime: 'application/octet-stream', nativeKind: 'file' };
}

function optionalSize(value) {
  if (value === undefined) return undefined;
  requireThat((typeof value === 'number' || typeof value === 'string') && /^\d+$/u.test(String(value))
    && Number.isSafeInteger(Number(value)) && Number(value) <= padded(MEDIA_MAX_BYTES), 'MEDIA_SIZE_INVALID');
  return Number(value);
}

export async function saveInboundMedia(config, client, cockpit, job, entry, signal) {
  requireThat(job.peer === config.weixin.allowedPeer && job.id.startsWith(`${config.weixin.allowedAccount}:`),
    'MEDIA_SOURCE_NOT_ALLOWED');
  const item = entry.item;
  const body = mediaBody(item);
  const url = inboundMediaUrl(item);
  const key = mediaKey(item);
  const md5 = item.type === 4 ? body.md5 : item.type === 5 ? body.video_md5 : undefined;
  requireThat(md5 === undefined || (typeof md5 === 'string' && /^[a-f0-9]{32}$/iu.test(md5)), 'MEDIA_HASH_INVALID');
  const plainSize = item.type === 4 ? optionalSize(body.len) : undefined;
  const videoSize = item.type === 5 ? optionalSize(body.video_size) : undefined;
  const max = item.type === 2 ? IMAGE_MAX_BYTES : MEDIA_MAX_BYTES;
  requireThat((plainSize ?? 0) <= max && (videoSize ?? 0) <= padded(max), 'MEDIA_TOO_LARGE');
  const local = scratch(config);
  try {
    const { result, signal: linked } = await response(client.fetchImpl, url, { method: 'GET' }, config, signal);
    const saved = await saveResponse(result, linked, local.file, { key, max, plainSize, videoSize, md5 });
    const detected = await sniffMedia(local.file, saved.size);
    requireThat(item.type !== 2 || detected.nativeKind === 'image', 'INBOUND_IMAGE_UNSUPPORTED');
    requireThat(item.type !== 5 || detected.nativeKind === 'video', 'INBOUND_VIDEO_UNSUPPORTED');
    const name = item.type === 4 && text(body.file_name, 1000) ? body.file_name
      : `weixin-${entry.index}.${detected.mime === 'image/png' ? 'png' : detected.mime === 'image/jpeg' ? 'jpg'
        : detected.nativeKind === 'video' ? 'mp4' : 'bin'}`;
    const uploaded = await cockpit.uploadFile(local.file, {
      name, mime: detected.mime, source: 'weixin', sessionId: config.cockpit.sessionId,
      sourceId: `${job.id}:item:${entry.index}`,
    }, saved.size, signal);
    const attachment = validateUploadedFile(uploaded, config);
    requireThat(attachment.size === saved.size && (!attachment.sha256 || attachment.sha256 === saved.sha256),
      'MANAGED_FILE_HASH_MISMATCH');
    return attachment;
  } finally { await local.remove(); }
}

export async function preparePublishedMedia(config, cockpit, uploadPath, signal) {
  requireThat(publishedMediaPath(uploadPath, config.cockpit.webUrl) === uploadPath, 'PUBLISHED_MEDIA_REQUIRED');
  requireThat(['127.0.0.1', '[::1]', 'localhost'].includes(new URL(config.cockpit.apiUrl).hostname),
    'MEDIA_BACKEND_MUST_BE_LOOPBACK');
  const attachment = validateUploadedFile(await cockpit.call('files/get', { url: uploadPath }, signal), config, uploadPath);
  const local = scratch(config);
  try {
    const { result, signal: linked } = await response(cockpit.fetchImpl, new URL(uploadPath, config.cockpit.apiUrl),
      { method: 'GET', headers: cockpit.headers }, config, signal);
    const saved = await saveResponse(result, linked, local.file,
      { max: MEDIA_MAX_BYTES, plainSize: attachment.size, sha256: attachment.sha256 });
    const detected = await sniffMedia(local.file, saved.size);
    return { ...local, ...saved, ...detected, attachment };
  } catch (error) { await local.remove(); throw error; }
}

export async function uploadPreparedMedia(config, client, peer, prepared, onStage, signal) {
  requireThat(peer === config.weixin.allowedPeer, 'MEDIA_PEER_MISMATCH');
  const aeskey = randomBytes(16);
  const filekey = randomBytes(16).toString('hex');
  const encrypted = scratch(config);
  try {
    const ciphertext = { sha256: createHash('sha256') };
    await pipeline(fs.createReadStream(prepared.file), createCipheriv('aes-128-ecb', aeskey, null),
      meter(padded(MEDIA_MAX_BYTES), ciphertext), fs.createWriteStream(encrypted.file, { flags: 'wx', mode: 0o600 }));
    onStage('requesting_upload');
    const result = await client.call('ilink/bot/getuploadurl', {
      filekey, media_type: { image: 1, video: 2, file: 3 }[prepared.nativeKind], to_user_id: peer,
      rawsize: prepared.size, rawfilemd5: prepared.md5, filesize: ciphertext.size,
      no_need_thumb: true, aeskey: aeskey.toString('hex'),
    }, { signal });
    const url = imageUploadUrl(result, filekey);
    onStage('uploading');
    const requestId = randomUUID();
    const record = event => client.diagnostics?.record({
      url: url.toString(), method: 'POST', requestId, at: Date.now(), body: null, ...event,
    });
    record({ phase: 'request', headers: { 'Content-Type': 'application/octet-stream' },
      binary: { bytes: ciphertext.size, sha256: ciphertext.sha256.digest('hex') } });
    const stream = fs.createReadStream(encrypted.file);
    let cdn;
    try {
      ({ result: cdn } = await response(client.fetchImpl, url, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(ciphertext.size) },
        body: stream, duplex: 'half',
      }, config, signal));
    } catch (error) {
      record({ phase: 'response', httpStatus: null, capture: 'no-response', outcome: errorCode(error) });
      throw error;
    } finally { stream.destroy(); }
    record({ phase: 'response', httpStatus: cdn.status, headers: cdn.headers, capture: 'cdn-body-not-read' });
    const param = cdn.headers.get('x-encrypted-param');
    await cdn.body?.cancel();
    requireThat(cdn.status === 200, `CDN_UPLOAD_HTTP_${cdn.status}`);
    requireThat(text(param), 'CDN_UPLOAD_RECEIPT_MISSING');
    const media = { encrypt_query_param: param,
      aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'), encrypt_type: 1 };
    if (prepared.nativeKind === 'image') return { type: 2, image_item: { media, mid_size: ciphertext.size } };
    if (prepared.nativeKind === 'video') return { type: 5, video_item: { media, video_size: ciphertext.size } };
    return { type: 4, file_item: { media, file_name: prepared.attachment.name, len: String(prepared.size) } };
  } finally { await encrypted.remove(); }
}
