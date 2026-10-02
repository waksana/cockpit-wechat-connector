// CDN envelopes and AES encoding follow Tencent openclaw-weixin 2.4.8 (MIT).
// Copyright (C) 2026 Tencent. See THIRD_PARTY_NOTICES.md and LICENSE.tencent.
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, resolve, sep } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { assert, cdnUrl, CDN_ORIGIN, validateItem, WechatTransport, type Item } from './transport.js';

export interface Snapshot {
  path: string;
  name: string;
  size: number;
  sha256: string;
  md5: string;
  mime: string;
  kind: 'image' | 'video' | 'file';
}
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const padded = (size: number) => Math.ceil((size + 1) / 16) * 16;
const digest = (bytes: Buffer, algorithm: string) => createHash(algorithm).update(bytes).digest('hex');

export async function noSymlinks(target: string): Promise<void> {
  const absolute = resolve(target);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = await lstat(current);
    assert(!stat.isSymbolicLink(), 'SYMLINK_REFUSED');
    if (current !== absolute) assert(stat.isDirectory(), 'SPECIAL_FILE_REFUSED');
  }
}
function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs
    && first.mode === second.mode && first.nlink === second.nlink;
}
export async function readRegularFile(target: string, signal?: AbortSignal, readonly = false): Promise<Buffer> {
  signal?.throwIfAborted();
  assert(resolve(target) === target, 'ABSOLUTE_FILE_REQUIRED');
  await noSymlinks(target);
  const before = await lstat(target, { bigint: true });
  assert(before.isFile() && before.size >= 0n && before.size <= BigInt(MEDIA_MAX_BYTES), 'FILE_SIZE_OR_TYPE_REFUSED');
  if (readonly) assert((before.mode & 0o777n) === 0o400n && before.uid === BigInt(process.getuid!())
    && before.nlink === 1n, 'SNAPSHOT_NOT_IMMUTABLE');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(sameFile(before, await handle.stat({ bigint: true })), 'FILE_CHANGED');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset);
      assert(bytesRead > 0, 'FILE_CHANGED');
      offset += bytesRead;
    }
    assert((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead === 0, 'FILE_CHANGED');
    assert(sameFile(before, await handle.stat({ bigint: true }))
      && sameFile(before, await lstat(target, { bigint: true })), 'FILE_CHANGED');
    await noSymlinks(target);
    assert(await realpath(target) === target, 'FILE_CHANGED');
    signal?.throwIfAborted();
    return bytes;
  } finally { await handle.close(); }
}
export function sniff(bytes: Buffer): Pick<Snapshot, 'kind' | 'mime'> {
  assert(bytes.length <= MEDIA_MAX_BYTES, 'MEDIA_TOO_LARGE');
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    assert(bytes.length <= IMAGE_MAX_BYTES, 'IMAGE_TOO_LARGE');
    assert(bytes.length >= 45 && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'INVALID_PNG');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    assert(width > 0 && width <= 8192 && height > 0 && height <= 8192, 'IMAGE_DIMENSIONS_UNSUPPORTED');
    let offset = 8, data = false, end = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      assert(offset + length + 12 <= bytes.length, 'INVALID_PNG');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      assert(crc32(bytes.subarray(offset + 4, offset + length + 8)) === bytes.readUInt32BE(offset + length + 8), 'INVALID_PNG');
      if (type === 'IDAT') data = true;
      offset += length + 12;
      if (type === 'IEND') { assert(length === 0, 'INVALID_PNG'); end = true; break; }
    }
    assert(data && end && offset === bytes.length, 'INVALID_PNG');
    return { kind: 'image', mime: 'image/png' };
  }
  if (bytes.subarray(0, 2).toString('hex') === 'ffd8') {
    assert(bytes.length <= IMAGE_MAX_BYTES, 'IMAGE_TOO_LARGE');
    const end = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]));
    assert(end >= 2, 'INVALID_JPEG');
    let offset = 2, found = false;
    while (offset + 4 <= bytes.length) {
      assert(bytes[offset++] === 0xff, 'INVALID_JPEG');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      assert(offset + 2 <= bytes.length, 'INVALID_JPEG');
      const length = bytes.readUInt16BE(offset);
      assert(length >= 2 && offset + length <= end, 'INVALID_JPEG');
      if ([0xc0, 0xc1, 0xc2].includes(marker!)) {
        assert(length >= 8, 'INVALID_JPEG');
        const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
        assert(width > 0 && width <= 8192 && height > 0 && height <= 8192, 'IMAGE_DIMENSIONS_UNSUPPORTED');
        found = true;
      }
      offset += length;
    }
    assert(found, 'INVALID_JPEG');
    return { kind: 'image', mime: 'image/jpeg' };
  }
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp'
    && /^(isom|iso[2-6]|iso8|mp4[12]|avc1|M4V |MSNV|dash|qt  )$/u.test(bytes.toString('ascii', 8, 12))) {
    assert(bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length, 'INVALID_VIDEO');
    return { kind: 'video', mime: bytes.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4' };
  }
  return { kind: 'file', mime: 'application/octet-stream' };
}
function safeName(value: string): string {
  const name = basename(value.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/gu, '_');
  assert(name.length > 0 && name !== '.' && name !== '..' && Buffer.byteLength(name) <= 1000, 'MEDIA_NAME_INVALID');
  return name;
}
export async function saveSnapshot(bytes: Buffer, name: string, directory: string, signal?: AbortSignal): Promise<Snapshot> {
  signal?.throwIfAborted();
  const detected = sniff(bytes);
  const displayName = safeName(name);
  const originalExtension = extname(displayName);
  const extension = detected.mime === 'image/png' ? '.png' : detected.mime === 'image/jpeg' ? '.jpg'
    : detected.mime === 'video/mp4' ? '.mp4' : detected.mime === 'video/quicktime' ? '.mov'
      : /^\.[a-z0-9]{1,16}$/iu.test(originalExtension) ? originalExtension : '.bin';
  const root = resolve(directory);
  // Create one component at a time; never traverse an existing symlink.
  let current = parse(root).root;
  for (const component of root.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'PRIVATE_DIRECTORY_REQUIRED');
  }
  const before = await lstat(root, { bigint: true });
  assert((before.mode & 0o077n) === 0n && before.uid === BigInt(process.getuid!()), 'PRIVATE_DIRECTORY_REQUIRED');
  const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const nameOnDisk = `${randomUUID()}${extension}`;
  const target = join(root, nameOnDisk);
  const pinned = `/proc/self/fd/${parent.fd}/${nameOnDisk}`;
  let created = false;
  try {
    const parentStat = await parent.stat({ bigint: true });
    assert(parentStat.dev === before.dev && parentStat.ino === before.ino, 'DIRECTORY_CHANGED');
    const file = await open(pinned, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      await file.writeFile(bytes);
      await file.chmod(0o400);
      await file.sync();
    } finally { await file.close(); }
    signal?.throwIfAborted();
    const after = await lstat(root, { bigint: true });
    assert(after.dev === before.dev && after.ino === before.ino && after.mode === before.mode, 'DIRECTORY_CHANGED');
    await noSymlinks(target);
    await parent.sync();
    return { path: target, name: displayName, size: bytes.length, sha256: digest(bytes, 'sha256'),
      md5: digest(bytes, 'md5'), ...detected };
  } catch (error) {
    if (created) await unlink(pinned).catch(() => {});
    throw error;
  } finally { await parent.close(); }
}

function mediaKey(item: Item): Buffer | undefined {
  if (item.image_item?.aeskey) return Buffer.from(item.image_item.aeskey, 'hex');
  const body = item.image_item ?? item.file_item ?? item.video_item;
  assert(body, 'MEDIA_ITEM_REQUIRED');
  const raw = body.media.aes_key;
  if (!raw) {
    assert(item.type === 2 && body.media.encrypt_type !== 1, 'MEDIA_KEY_REQUIRED');
    return undefined;
  }
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === 16 ? decoded : Buffer.from(decoded.toString(), 'hex');
}
export async function downloadInbound(transport: WechatTransport, input: Item, directory: string,
  signal?: AbortSignal): Promise<Snapshot> {
  const item = validateItem(input);
  const body = item.image_item ?? item.file_item ?? item.video_item;
  assert(item.type !== 1 && body, 'MEDIA_ITEM_REQUIRED');
  const key = mediaKey(item);
  const maximum = item.type === 2 ? IMAGE_MAX_BYTES : MEDIA_MAX_BYTES;
  const url = body.media.full_url ?? `${CDN_ORIGIN}/c2c/download?${new URLSearchParams({
    encrypted_query_param: body.media.encrypt_query_param!,
  })}`;
  const { bytes: encoded } = await transport.request(cdnUrl(url, 'download'), { method: 'GET' }, key ? padded(maximum) : maximum, signal);
  let bytes = encoded;
  if (key) {
    assert(encoded.length > 0 && encoded.length % 16 === 0, 'MEDIA_CIPHERTEXT_INVALID');
    try {
      const decipher = createDecipheriv('aes-128-ecb', key, null);
      bytes = Buffer.concat([decipher.update(encoded), decipher.final()]);
    } catch { throw new Error('MEDIA_DECRYPT_FAILED'); }
  }
  assert(bytes.length <= maximum, 'MEDIA_TOO_LARGE');
  const expectedSize = item.file_item?.len;
  const videoSize = item.video_item?.video_size;
  const md5 = item.file_item?.md5 ?? item.video_item?.video_md5;
  assert(expectedSize === undefined || Number(expectedSize) === bytes.length, 'MEDIA_SIZE_MISMATCH');
  assert(videoSize === undefined || videoSize === encoded.length || videoSize === bytes.length, 'MEDIA_SIZE_MISMATCH');
  assert(md5 === undefined || digest(bytes, 'md5') === md5.toLowerCase(), 'MEDIA_HASH_MISMATCH');
  const detected = sniff(bytes);
  assert(item.type !== 2 || detected.kind === 'image', 'INBOUND_IMAGE_UNSUPPORTED');
  assert(item.type !== 5 || detected.kind === 'video', 'INBOUND_VIDEO_UNSUPPORTED');
  const extension = detected.mime === 'image/png' ? 'png' : detected.mime === 'image/jpeg' ? 'jpg'
    : detected.mime === 'video/quicktime' ? 'mov' : detected.kind === 'video' ? 'mp4' : 'bin';
  return saveSnapshot(bytes, item.file_item?.file_name || `weixin.${extension}`, directory, signal);
}
async function verifiedSnapshotBytes(snapshot: Snapshot, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  assert(typeof snapshot.path === 'string' && typeof snapshot.name === 'string'
    && Number.isSafeInteger(snapshot.size) && snapshot.size >= 0 && snapshot.size <= MEDIA_MAX_BYTES
    && /^[a-f0-9]{64}$/u.test(snapshot.sha256) && /^[a-f0-9]{32}$/u.test(snapshot.md5), 'SNAPSHOT_INVALID');
  const parent = await lstat(dirname(snapshot.path));
  assert(parent.isDirectory() && (parent.mode & 0o077) === 0 && parent.uid === process.getuid!(), 'PRIVATE_DIRECTORY_REQUIRED');
  const bytes = await readRegularFile(snapshot.path, signal, true);
  assert(bytes.length === snapshot.size && digest(bytes, 'sha256') === snapshot.sha256
    && digest(bytes, 'md5') === snapshot.md5, 'SNAPSHOT_CHANGED');
  const detected = sniff(bytes);
  assert(detected.kind === snapshot.kind && detected.mime === snapshot.mime, 'SNAPSHOT_TYPE_CHANGED');
  return bytes;
}
export async function verifySnapshot(snapshot: Snapshot, signal?: AbortSignal): Promise<void> {
  await verifiedSnapshotBytes(snapshot, signal);
}
export async function uploadOutbound(transport: WechatTransport, snapshot: Snapshot, signal?: AbortSignal,
  beforeEffect?: () => void): Promise<Item> {
  const bytes = await verifiedSnapshotBytes(snapshot, signal);
  const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  beforeEffect?.();
  const result = await transport.call('ilink/bot/getuploadurl', {
    filekey, media_type: { image: 1, video: 2, file: 3 }[snapshot.kind], to_user_id: transport.peer,
    rawsize: bytes.length, rawfilemd5: snapshot.md5, filesize: ciphertext.length,
    no_need_thumb: true, aeskey: key.toString('hex'),
  }, signal);
  assert((typeof result.upload_full_url === 'string' && result.upload_full_url.length <= 16_384)
    || (typeof result.upload_param === 'string' && result.upload_param.length > 0 && result.upload_param.length <= 16_384),
  'UPLOAD_RECEIPT_INVALID');
  const url = typeof result.upload_full_url === 'string' ? result.upload_full_url
    : `${CDN_ORIGIN}/c2c/upload?${new URLSearchParams({ encrypted_query_param: result.upload_param as string, filekey })}`;
  beforeEffect?.();
  const { headers } = await transport.request(cdnUrl(url, 'upload'), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(ciphertext.length) },
    body: new Uint8Array(ciphertext),
  }, 64 * 1024, signal);
  const param = headers.get('x-encrypted-param');
  assert(param && param.length <= 16_384, 'UPLOAD_RECEIPT_MISSING');
  const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 };
  if (snapshot.kind === 'image') return { type: 2, image_item: { media, mid_size: ciphertext.length } };
  if (snapshot.kind === 'video') return { type: 5, video_item: { media, video_size: ciphertext.length } };
  return { type: 4, file_item: { media, file_name: safeName(snapshot.name), len: String(bytes.length) } };
}
