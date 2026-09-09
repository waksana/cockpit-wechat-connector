// CDN request/encryption/image envelope adapted from Tencent openclaw-weixin 2.4.8 (MIT).
// Copyright (C) 2026 Tencent. See THIRD_PARTY_NOTICES.md and LICENSE.tencent.
import path from 'node:path';
import { createHash, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { assertBinding } from './config.js';
import { BridgeError, errorCode, object, requireThat, text } from './common.js';
import { privateDirectory, readPrivate, writePrivate } from './storage.js';
import { apiSuccess } from './weixin.js';

const cdnOrigin = 'https://novac2c.cdn.weixin.qq.com';
const maxBytes = 4 * 1024 * 1024;

export function imageUploadUrl(response, filekey) {
  apiSuccess(response, { optionalRet: true });
  requireThat(response.errmsg === undefined || response.errmsg === '', 'WEIXIN_UPLOAD_SCHEMA');
  let value;
  if (response.upload_full_url !== undefined) {
    requireThat(text(response.upload_full_url), 'WEIXIN_UPLOAD_SCHEMA');
    value = response.upload_full_url;
  } else {
    requireThat(text(response.upload_param), 'WEIXIN_UPLOAD_SCHEMA');
    value = `${cdnOrigin}/c2c/upload?${new URLSearchParams({
      encrypted_query_param: response.upload_param, filekey,
    })}`;
  }
  let url;
  try { url = new URL(value); } catch { throw new BridgeError('WEIXIN_CDN_HOST_REFUSED'); }
  requireThat(url.origin === cdnOrigin && url.pathname === '/c2c/upload'
    && !url.username && !url.password && !url.hash && !/[\s\\]/u.test(value)
    && value.split('?')[0] === `${cdnOrigin}/c2c/upload`, 'WEIXIN_CDN_HOST_REFUSED');
  return url;
}

async function responseFrom(fetchImpl, url, init, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url, { ...init, redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    if (signal?.aborted) throw new BridgeError('STOPPED');
    throw new BridgeError(timeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
  }
}

export function publishedImagePath(target, webUrl) {
  const origin = new URL(webUrl).origin;
  const value = target.startsWith(`${origin}/`) ? target.slice(origin.length) : target;
  return /^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,190}\.(?:png|jpe?g)$/iu.test(value) ? value : null;
}

export function dimensions(bytes, png) {
  if (png) {
    requireThat(bytes.length >= 33 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      && bytes.toString('ascii', 12, 16) === 'IHDR', 'INVALID_PNG');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  const end = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
  // Weixin may append metadata after JPEG EOI. Preserve those original bytes.
  requireThat(bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && end >= 2, 'INVALID_JPEG');
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    requireThat(bytes[offset++] === 0xff, 'INVALID_JPEG');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    requireThat(offset + 2 <= bytes.length, 'INVALID_JPEG');
    const length = bytes.readUInt16BE(offset);
    requireThat(length >= 2 && offset + length <= bytes.length, 'INVALID_JPEG');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      requireThat(length >= 8 && end >= offset + length, 'INVALID_JPEG');
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new BridgeError('INVALID_JPEG');
}

export async function preparePublishedImage(config, uploadPath, fetchImpl, signal) {
  requireThat(publishedImagePath(uploadPath, config.cockpit.webUrl) === uploadPath,
    'PUBLISHED_IMAGE_REQUIRED');
  const png = /\.png$/iu.test(uploadPath);
  // Fetch only the already published backend resource, never arbitrary URLs or local files.
  const response = await responseFrom(fetchImpl, new URL(uploadPath, config.cockpit.apiUrl),
    { method: 'GET' }, signal, config.limits.requestTimeoutMs);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new BridgeError(`IMAGE_DOWNLOAD_HTTP_${response.status}`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim() !== (png ? 'image/png' : 'image/jpeg')) {
    await response.body?.cancel();
    throw new BridgeError('IMAGE_DOWNLOAD_TYPE');
  }
  const reader = response.body?.getReader();
  requireThat(reader, 'IMAGE_DOWNLOAD_EMPTY');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      requireThat(size <= maxBytes, 'IMAGE_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('IMAGE_DOWNLOAD_FAILED');
  }
  const bytes = Buffer.concat(chunks);
  const geometry = dimensions(bytes, png);
  requireThat(geometry.width > 0 && geometry.width <= 8192 && geometry.height > 0 && geometry.height <= 8192,
    'IMAGE_DIMENSIONS_UNSUPPORTED');
  return { bytes, ...geometry };
}

export async function uploadPreparedImage(config, client, peer, prepared, onStage, signal) {
  requireThat(peer === config.weixin.allowedPeer, 'IMAGE_PEER_MISMATCH');
  const plaintext = prepared.bytes;
  const aeskey = randomBytes(16);
  const filekey = randomBytes(16).toString('hex');
  const cipher = createCipheriv('aes-128-ecb', aeskey, null);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  onStage('requesting_upload');
  const response = await client.call('ilink/bot/getuploadurl', {
    filekey, media_type: 1, to_user_id: peer,
    rawsize: plaintext.length, rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: ciphertext.length, no_need_thumb: true, aeskey: aeskey.toString('hex'),
  }, { signal });
  requireThat(object(response), 'WEIXIN_UPLOAD_SCHEMA');
  const url = imageUploadUrl(response, filekey);
  onStage('uploading');
  const requestId = randomUUID();
  const record = event => client.diagnostics?.record({
    url: url.toString(), method: 'POST', requestId, at: Date.now(), body: null, ...event,
  });
  record({ phase: 'request', headers: { 'Content-Type': 'application/octet-stream' },
    binary: { bytes: ciphertext.length, sha256: createHash('sha256').update(ciphertext).digest('hex') } });
  let cdn;
  try {
    cdn = await responseFrom(client.fetchImpl, url, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext,
    }, signal, config.limits.requestTimeoutMs);
  } catch (error) {
    record({ phase: 'response', httpStatus: null, capture: 'no-response', outcome: errorCode(error) });
    throw error;
  }
  record({ phase: 'response', httpStatus: cdn.status, headers: cdn.headers, capture: 'cdn-body-not-read' });
  const downloadParam = cdn.headers.get('x-encrypted-param');
  await cdn.body?.cancel();
  requireThat(cdn.status === 200, `CDN_UPLOAD_HTTP_${cdn.status}`);
  requireThat(text(downloadParam), 'CDN_UPLOAD_RECEIPT_MISSING');
  return {
    type: 2,
    image_item: {
      media: { encrypt_query_param: downloadParam,
        aes_key: Buffer.from(aeskey.toString('hex')).toString('base64'), encrypt_type: 1 },
      mid_size: ciphertext.length,
    },
  };
}

export async function deliverPublishedPng(config, credentials, store, client, uploadPath, signal) {
  assertBinding(config, credentials);
  requireThat(JSON.stringify(store.get('binding')) === JSON.stringify({
    account: config.weixin.allowedAccount, peer: config.weixin.allowedPeer, ...config.cockpit,
  }), 'PERSISTED_BINDING_CHANGED');
  requireThat(store.jobs().every(job => ['done', 'rejected', 'abandoned'].includes(job.status))
    && !store.get('pendingBatch'), 'PENDING_JOBS_BEFORE_IMAGE');
  const context = store.jobs().findLast(job => job.peer === config.weixin.allowedPeer && text(job.contextToken));
  requireThat(context, 'NO_AUTHORIZED_CONTEXT');
  const dir = path.join(config.stateDir, 'image-deliveries');
  privateDirectory(dir);
  const attemptFile = path.join(dir, `${createHash('sha256').update(uploadPath).digest('hex')}.json`);
  requireThat(!readPrivate(attemptFile), 'IMAGE_ALREADY_ATTEMPTED_NO_REPLAY');
  requireThat(/^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,190}\.png$/iu.test(uploadPath),
    'PUBLISHED_PNG_REQUIRED');
  const prepared = await preparePublishedImage(config, uploadPath, client.fetchImpl, signal);
  const plaintext = prepared.bytes;
  const attempt = {
    status: 'requesting_upload', clientId: `wximg-${randomUUID()}`,
    sha256: createHash('sha256').update(plaintext).digest('hex'), rawsize: plaintext.length,
    width: prepared.width, height: prepared.height, startedAt: Date.now(),
  };
  writePrivate(attemptFile, attempt);
  try {
    const item = await uploadPreparedImage(config, client, config.weixin.allowedPeer, prepared,
      stage => { attempt.status = stage; writePrivate(attemptFile, attempt); }, signal);
    attempt.status = 'sending_image';
    writePrivate(attemptFile, attempt);
    await client.sendItems(config.weixin.allowedPeer, context.contextToken, [item], attempt.clientId, signal);
    attempt.status = 'accepted';
    writePrivate(attemptFile, attempt);
    return { status: attempt.status, bytes: attempt.rawsize, width: attempt.width,
      height: attempt.height, sha256: attempt.sha256 };
  } catch (error) {
    attempt.failedAt = attempt.status;
    attempt.status = 'unknown';
    attempt.error = errorCode(error);
    writePrivate(attemptFile, attempt);
    throw new BridgeError('IMAGE_OUTCOME_UNKNOWN', 'Image attempt stopped; inspect private delivery state. Do not replay.');
  }
}
