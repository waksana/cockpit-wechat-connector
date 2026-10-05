// Protocol envelopes adapted from Tencent openclaw-weixin 2.4.8 (MIT).
// Copyright (C) 2026 Tencent. See THIRD_PARTY_NOTICES.md and LICENSE.tencent.
import { randomBytes } from 'node:crypto';

export interface MediaReference {
  encrypt_query_param?: string;
  full_url?: string;
  aes_key?: string;
  encrypt_type?: number;
}
export interface Item {
  type: 1 | 2 | 4 | 5;
  msg_id?: string;
  text_item?: { text: string };
  image_item?: { media: MediaReference; aeskey?: string; mid_size?: number };
  file_item?: { media: MediaReference; file_name?: string; len?: string | number; md5?: string };
  video_item?: { media: MediaReference; video_size?: number; video_md5?: string };
  ref_msg?: Quote;
}
export interface Quote {
  svr_id?: string;
  title?: string;
  message_item?: {
    type: number;
    msg_id?: string;
    text_item?: { text: string };
    file_item?: { file_name: string };
    voice_item?: { text: string };
  };
  partial_text?: { start?: string; end?: string; startindex?: number; endindex?: number; quotemd5?: string };
}
export interface InboundMessage {
  id: string;
  account: string;
  peer: string;
  text: string;
  contextToken: string;
  items: Item[];
  quotes: Quote[];
  createdAt?: number;
}
export interface TransportOptions {
  account: string;
  peer: string;
  token: string;
  apiOrigin?: string;
  requestTimeoutMs?: number;
}

export const API_ORIGIN = 'https://ilinkai.weixin.qq.com';
export const CDN_ORIGIN = 'https://novac2c.cdn.weixin.qq.com';
const MAX_JSON = 4 * 1024 * 1024;
export function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function string(value: unknown, max = 50_000): value is string {
  return typeof value === 'string' && value.length <= max;
}
export function serverMessageId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  assert(typeof id === 'string' && /^(0|[1-9]\d{0,19})$/u.test(id)
    && BigInt(id) <= 18446744073709551615n, 'MESSAGE_ID_INVALID');
  return id;
}
function itemMessageId(value: unknown): string {
  // Item msg_id is opaque metadata, not the uint64 envelope/receipt identity.
  assert(string(value, 1024) && !/[\x00-\x1f\x7f]/u.test(value), 'ITEM_MESSAGE_ID_INVALID');
  return value;
}
type ApiEndpoint = 'ilink/bot/getupdates' | 'ilink/bot/sendmessage' | 'ilink/bot/getuploadurl';
export interface ApiFailure {
  endpoint: ApiEndpoint;
  httpStatus: 200;
  ret: number | 'absent' | 'invalid';
  errcode: number | 'absent' | 'invalid';
  errmsg: 'absent' | 'empty' | 'present' | 'invalid';
  observedAt: number;
}
export class WechatApiError extends Error {
  readonly apiFailure: ApiFailure;
  constructor(value: Record<string, unknown>, endpoint: ApiEndpoint) {
    super(value.ret === -14 || value.errcode === -14 ? 'WECHAT_TOKEN_EXPIRED' : 'WECHAT_API_REJECTED');
    const numeric = (value: unknown): ApiFailure['ret'] => value === undefined ? 'absent'
      : typeof value === 'number' && Number.isSafeInteger(value) ? value : 'invalid';
    // Never retain response text, extra fields, request payloads or credentials.
    this.apiFailure = {
      endpoint, httpStatus: 200, ret: numeric(value.ret), errcode: numeric(value.errcode),
      errmsg: value.errmsg === undefined ? 'absent' : value.errmsg === '' ? 'empty'
        : typeof value.errmsg === 'string' ? 'present' : 'invalid',
      observedAt: Date.now(),
    };
  }
}
export function apiSuccess(value: Record<string, unknown>, endpoint: ApiEndpoint): void {
  if ((value.ret !== undefined && value.ret !== 0) || (value.errcode !== undefined && value.errcode !== 0)
    || (value.errmsg !== undefined && value.errmsg !== '')) throw new WechatApiError(value, endpoint);
}
export function cdnUrl(value: string, operation: 'upload' | 'download'): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('CDN_URL_REFUSED'); }
  assert(url.origin === CDN_ORIGIN && url.pathname === `/c2c/${operation}` && !url.username && !url.password
    && !url.hash && !/[\s\\]/u.test(value) && value.split('?')[0] === `${CDN_ORIGIN}/c2c/${operation}`,
  'CDN_URL_REFUSED');
  return url;
}

function size(value: unknown, maximum = 25 * 1024 * 1024 + 16): void {
  assert((typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value)) || typeof value === 'number',
    'MEDIA_SIZE_INVALID');
  assert(Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= maximum, 'MEDIA_SIZE_INVALID');
}
function media(value: unknown): MediaReference {
  assert(record(value), 'MEDIA_REFERENCE_INVALID');
  const result: MediaReference = {};
  if (value.full_url !== undefined) {
    assert(string(value.full_url, 16_384) && value.full_url.length > 0, 'MEDIA_REFERENCE_INVALID');
    cdnUrl(value.full_url, 'download');
    result.full_url = value.full_url;
  }
  if (value.encrypt_query_param !== undefined) {
    assert(string(value.encrypt_query_param, 16_384) && value.encrypt_query_param.length > 0, 'MEDIA_REFERENCE_INVALID');
    result.encrypt_query_param = value.encrypt_query_param;
  }
  assert(result.full_url || result.encrypt_query_param, 'MEDIA_REFERENCE_INVALID');
  if (value.aes_key !== undefined) {
    assert(string(value.aes_key, 64) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.aes_key),
      'MEDIA_KEY_INVALID');
    const key = Buffer.from(value.aes_key, 'base64');
    assert(key.length === 16 || (key.length === 32 && /^[a-f0-9]{32}$/iu.test(key.toString())), 'MEDIA_KEY_INVALID');
    result.aes_key = value.aes_key;
  }
  if (value.encrypt_type !== undefined) {
    assert(value.encrypt_type === 0 || value.encrypt_type === 1, 'MEDIA_ENCRYPTION_UNSUPPORTED');
    result.encrypt_type = value.encrypt_type;
  }
  return result;
}
function quote(value: unknown, depth: number): Quote {
  assert(record(value) && depth < 5, 'QUOTE_INVALID');
  const result: Quote = {};
  if (value.svr_id !== undefined) result.svr_id = serverMessageId(value.svr_id);
  if (value.title !== undefined) { assert(string(value.title), 'QUOTE_INVALID'); result.title = value.title; }
  if (value.message_item !== undefined) {
    const item = value.message_item;
    assert(record(item) && typeof item.type === 'number' && Number.isSafeInteger(item.type), 'QUOTE_INVALID');
    result.message_item = { type: item.type };
    if (item.msg_id !== undefined) result.message_item.msg_id = itemMessageId(item.msg_id);
    // Quoted items are descriptive context, not permission to fetch their media.
    if (record(item.text_item) && item.text_item.text !== undefined) {
      assert(string(item.text_item.text), 'QUOTE_INVALID');
      result.message_item.text_item = { text: item.text_item.text };
    }
    if (record(item.file_item) && item.file_item.file_name !== undefined) {
      assert(string(item.file_item.file_name, 1000), 'QUOTE_INVALID');
      result.message_item.file_item = { file_name: item.file_item.file_name };
    }
    if (record(item.voice_item) && item.voice_item.text !== undefined) {
      assert(string(item.voice_item.text), 'QUOTE_INVALID');
      result.message_item.voice_item = { text: item.voice_item.text };
    }
  }
  if (value.partial_text !== undefined) {
    const partial = value.partial_text;
    assert(record(partial), 'QUOTE_INVALID');
    result.partial_text = {};
    for (const key of ['start', 'end'] as const) if (partial[key] !== undefined) {
      assert(string(partial[key]), 'QUOTE_INVALID'); result.partial_text[key] = partial[key];
    }
    for (const key of ['startindex', 'endindex'] as const) if (partial[key] !== undefined) {
      assert(Number.isSafeInteger(partial[key]) && Number(partial[key]) >= 0, 'QUOTE_INVALID');
      result.partial_text[key] = partial[key] as number;
    }
    if (partial.quotemd5 !== undefined) {
      assert(typeof partial.quotemd5 === 'string' && /^[a-f0-9]{32}$/iu.test(partial.quotemd5), 'QUOTE_INVALID');
      result.partial_text.quotemd5 = partial.quotemd5;
    }
  }
  return result;
}
export function validateItem(value: unknown, depth = 0): Item {
  assert(record(value) && [1, 2, 4, 5].includes(Number(value.type)) && typeof value.type === 'number', 'ITEM_INVALID');
  const result: Item = { type: value.type as Item['type'] };
  if (value.msg_id !== undefined) result.msg_id = itemMessageId(value.msg_id);
  if (value.ref_msg !== undefined) result.ref_msg = quote(value.ref_msg, depth);
  if (value.type === 1) {
    assert(record(value.text_item) && string(value.text_item.text), 'ITEM_TEXT_INVALID');
    result.text_item = { text: value.text_item.text };
  } else {
    const key = value.type === 2 ? 'image_item' : value.type === 4 ? 'file_item' : 'video_item';
    const body = value[key];
    assert(record(body), 'ITEM_MEDIA_INVALID');
    const envelope = { media: media(body.media) };
    if (value.type === 2) {
      result.image_item = envelope;
      if (body.aeskey !== undefined) {
        assert(typeof body.aeskey === 'string' && /^[a-f0-9]{32}$/iu.test(body.aeskey), 'MEDIA_KEY_INVALID');
        result.image_item.aeskey = body.aeskey;
      }
      if (body.mid_size !== undefined) { size(body.mid_size, 4 * 1024 * 1024 + 16); result.image_item.mid_size = Number(body.mid_size); }
    } else if (value.type === 4) {
      result.file_item = envelope;
      if (body.file_name !== undefined) {
        assert(string(body.file_name, 1000) && !/[\x00-\x1f\x7f]/u.test(body.file_name), 'MEDIA_NAME_INVALID');
        result.file_item.file_name = body.file_name;
      }
      if (body.len !== undefined) { size(body.len); result.file_item.len = body.len as string | number; }
      if (body.md5 !== undefined) {
        assert(typeof body.md5 === 'string' && /^[a-f0-9]{32}$/iu.test(body.md5), 'MEDIA_HASH_INVALID');
        result.file_item.md5 = body.md5;
      }
    } else {
      result.video_item = envelope;
      if (body.video_size !== undefined) { size(body.video_size); result.video_item.video_size = Number(body.video_size); }
      if (body.video_md5 !== undefined) {
        assert(typeof body.video_md5 === 'string' && /^[a-f0-9]{32}$/iu.test(body.video_md5), 'MEDIA_HASH_INVALID');
        result.video_item.video_md5 = body.video_md5;
      }
    }
    assert(envelope.media.aes_key || (value.type === 2 && (result.image_item?.aeskey || envelope.media.encrypt_type !== 1)),
      'MEDIA_KEY_REQUIRED');
  }
  return result;
}

// Race the body as well as fetch: an injected fetch/stream need not honor AbortSignal.
async function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: () => void = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([work, cancellation]); }
  finally { signal.removeEventListener('abort', listener); }
}
export class WechatTransport {
  readonly account: string;
  readonly peer: string;
  readonly requestTimeoutMs: number;
  private readonly token: string;
  private readonly origin: string;
  constructor(options: TransportOptions, readonly fetchImpl: typeof fetch = fetch) {
    assert([options.account, options.peer, options.token].every(value =>
      typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\s\x00-\x1f\x7f]/u.test(value)),
    'TRANSPORT_CONFIG_INVALID');
    this.account = options.account; this.peer = options.peer; this.token = options.token;
    this.origin = options.apiOrigin ?? API_ORIGIN;
    assert(this.origin === API_ORIGIN, 'API_ORIGIN_REFUSED');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 40_000;
    assert(Number.isSafeInteger(this.requestTimeoutMs) && this.requestTimeoutMs > 0 && this.requestTimeoutMs <= 120_000,
      'REQUEST_TIMEOUT_INVALID');
  }
  async request(url: URL, init: RequestInit, maximum: number, signal?: AbortSignal): Promise<{ bytes: Buffer; headers: Headers }> {
    assert((url.origin === this.origin && /^\/ilink\/bot\/(?:getupdates|sendmessage|getuploadurl)$/u.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password)
      || (url.origin === CDN_ORIGIN && Boolean(cdnUrl(url.href, url.pathname === '/c2c/upload' ? 'upload' : 'download'))),
    'REQUEST_URL_REFUSED');
    assert(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= 25 * 1024 * 1024 + 16, 'RESPONSE_LIMIT_INVALID');
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(new Error('REQUEST_TIMEOUT')), this.requestTimeoutMs);
    const linked = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      linked.throwIfAborted();
      const result = await cancellable(Promise.resolve(this.fetchImpl(url, { ...init, redirect: 'manual', signal: linked })), linked);
      if (result.status !== 200 || result.redirected) {
        void result.body?.cancel().catch(() => {});
        throw new Error(result.status >= 300 && result.status < 400 || result.redirected ? 'HTTP_REDIRECT_REFUSED' : 'HTTP_REQUEST_FAILED');
      }
      const length = result.headers.get('content-length');
      const encoded = result.headers.has('content-encoding') && result.headers.get('content-encoding') !== 'identity';
      if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length))
        || Number(length) > maximum + (encoded ? 64 * 1024 : 0))) {
        void result.body?.cancel().catch(() => {}); throw new Error('RESPONSE_TOO_LARGE');
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      reader = result.body?.getReader();
      if (reader) for (;;) {
        const part = await cancellable(reader.read(), linked);
        if (part.done) break;
        total += part.value.byteLength;
        assert(total <= maximum, 'RESPONSE_TOO_LARGE');
        chunks.push(part.value);
      }
      assert(encoded || length === null || Number(length) === total, 'RESPONSE_LENGTH_MISMATCH');
      return { bytes: Buffer.concat(chunks), headers: result.headers };
    } catch (error) {
      void reader?.cancel().catch(() => {});
      if (linked.aborted) throw linked.reason;
      if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)) throw error;
      throw new Error('NETWORK_ERROR');
    } finally { clearTimeout(timeout); }
  }
  async call(endpoint: ApiEndpoint,
    body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    assert(['ilink/bot/getupdates', 'ilink/bot/sendmessage', 'ilink/bot/getuploadurl'].includes(endpoint), 'API_ENDPOINT_REFUSED');
    const encoded = JSON.stringify({ ...body, base_info: { channel_version: '2.4.8', bot_agent: 'CockpitWechat/1.0' } });
    assert(Buffer.byteLength(encoded) <= MAX_JSON, 'REQUEST_TOO_LARGE');
    const { bytes } = await this.request(new URL(endpoint, `${this.origin}/`), {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x020408),
        AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${this.token}`,
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      }, body: encoded,
    }, MAX_JSON, signal);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), ((key: string, item: unknown, context?: { source?: string }) => {
        if (['message_id', 'msg_id', 'svr_id'].includes(key) && typeof item === 'number') {
          assert(typeof context?.source === 'string' && /^(0|[1-9]\d*)$/u.test(context.source), 'MESSAGE_ID_INVALID');
          return key === 'msg_id' ? itemMessageId(context.source) : serverMessageId(context.source);
        }
        return item;
      }) as Parameters<typeof JSON.parse>[1]);
    } catch { throw new Error('RESPONSE_JSON_INVALID'); }
    assert(record(value), 'RESPONSE_JSON_INVALID');
    apiSuccess(value, endpoint);
    return value;
  }
  async poll(cursor: string, signal?: AbortSignal): Promise<{ messages: InboundMessage[]; cursor: string }> {
    assert(string(cursor, 1_000_000), 'CURSOR_INVALID');
    const result = await this.call('ilink/bot/getupdates', { get_updates_buf: cursor }, signal);
    assert(Array.isArray(result.msgs) && result.msgs.length <= 1000 && string(result.get_updates_buf, 1_000_000), 'POLL_SCHEMA_INVALID');
    const messages: InboundMessage[] = [];
    for (const value of result.msgs) {
      assert(record(value), 'POLL_MESSAGE_INVALID');
      if (value.from_user_id !== this.peer || value.to_user_id !== this.account || value.group_id) continue;
      assert(value.message_type === 1 && value.message_state === 2, 'MESSAGE_INCOMPLETE');
      assert(string(value.context_token, 16_384) && value.context_token.length > 0, 'MESSAGE_CONTEXT_INVALID');
      assert(Array.isArray(value.item_list) && value.item_list.length > 0 && value.item_list.length <= 100, 'MESSAGE_ITEMS_INVALID');
      const items = value.item_list.map(item => validateItem(item));
      const text = items.filter(item => item.type === 1).map(item => item.text_item!.text).join('\n');
      assert(text.length <= 50_000, 'MESSAGE_TEXT_TOO_LARGE');
      let createdAt: number | undefined;
      if (value.create_time_ms !== undefined) {
        assert(Number.isSafeInteger(value.create_time_ms) && Number(value.create_time_ms) >= 0, 'MESSAGE_TIME_INVALID');
        createdAt = value.create_time_ms as number;
      }
      messages.push({ id: serverMessageId(value.message_id), account: this.account, peer: this.peer, text,
        contextToken: value.context_token, items, quotes: items.flatMap(item => item.ref_msg ? [item.ref_msg] : []),
        ...(createdAt === undefined ? {} : { createdAt }) });
    }
    return { messages, cursor: result.get_updates_buf };
  }
  async send(items: Item[], contextToken: string, clientId: string, signal?: AbortSignal): Promise<{ messageId?: string }> {
    assert(string(contextToken, 16_384) && contextToken.length > 0, 'MESSAGE_CONTEXT_INVALID');
    assert(string(clientId, 200) && /^[A-Za-z0-9_-]+$/u.test(clientId), 'CLIENT_ID_INVALID');
    assert(Array.isArray(items) && items.length > 0 && items.length <= 100, 'MESSAGE_ITEMS_INVALID');
    const result = await this.call('ilink/bot/sendmessage', { msg: {
      from_user_id: '', to_user_id: this.peer, client_id: clientId, message_type: 2, message_state: 2,
      context_token: contextToken, item_list: items.map(item => validateItem(item)),
    } }, signal);
    assert(Object.keys(result).every(key => ['ret', 'errcode', 'errmsg', 'message_id'].includes(key)), 'SEND_SCHEMA_INVALID');
    const id = result.message_id === undefined ? undefined : serverMessageId(result.message_id);
    assert(id !== '0' && (result.ret === 0 || id !== undefined), 'SEND_SCHEMA_INVALID');
    return id === undefined ? {} : { messageId: id };
  }
}
