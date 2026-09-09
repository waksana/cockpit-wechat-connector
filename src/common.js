import { setTimeout as delay } from 'node:timers/promises';

export class BridgeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export function requireThat(condition, code) {
  if (!condition) throw new BridgeError(code);
}

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value, max = 16384) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function errorCode(error) {
  return error instanceof BridgeError ? error.code : 'INTERNAL_ERROR';
}

export function retryableRead(code) {
  return ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'HTTP_502', 'HTTP_503', 'HTTP_504', 'HTTP_500',
    'IMAGE_DOWNLOAD_HTTP_500', 'IMAGE_DOWNLOAD_HTTP_502', 'IMAGE_DOWNLOAD_HTTP_503',
    'IMAGE_DOWNLOAD_HTTP_504', 'IMAGE_DOWNLOAD_FAILED', 'SESSION_OUTPUT_BUSY',
    'MEDIA_DOWNLOAD_HTTP_500', 'MEDIA_DOWNLOAD_HTTP_502', 'MEDIA_DOWNLOAD_HTTP_503',
    'MEDIA_DOWNLOAD_HTTP_504', 'MEDIA_DOWNLOAD_FAILED'].includes(code);
}

export async function sleep(ms, signal) {
  await delay(ms, undefined, { signal });
}

export function sessionLink(config) {
  return new URL(`/session/${encodeURIComponent(config.cockpit.sessionId)}`, config.cockpit.webUrl).href;
}

// Byte-bounded chunks never cut a code point. Reserve room for the part label.
export function splitText(value, byteLimit, maxParts) {
  requireThat(text(value, 1000000), 'EMPTY_OR_OVERSIZED_REPLY');
  const parts = [];
  let part = '';
  let size = 0;
  for (const char of value.match(/https:\/\/[^\s<>]+|[\s\S]/gu) ?? []) {
    const bytes = Buffer.byteLength(char);
    requireThat(bytes <= byteLimit - 32, 'LINK_TOO_LONG_FOR_REPLY_PART');
    if (size + bytes > byteLimit - 32) {
      parts.push(part);
      part = '';
      size = 0;
    }
    part += char;
    size += bytes;
  }
  if (part) parts.push(part);
  requireThat(parts.length <= maxParts, 'TOO_MANY_REPLY_PARTS');
  return parts.map((part, index) => parts.length === 1 ? part : `[${index + 1}/${parts.length}] ${part}`);
}
