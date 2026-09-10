// Protocol request construction adapted from Tencent openclaw-weixin 2.4.8 (MIT).
// Copyright (C) 2026 Tencent. See THIRD_PARTY_NOTICES.md and LICENSE.tencent.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { BridgeError, object, requireThat, sleep, text } from './common.js';
import { DEFAULT_ORIGIN, validateApiOrigin } from './config.js';
import { requestJson } from './http.js';
import { privateDirectory, writePrivate } from './storage.js';
import { HttpDiagnostics } from './diagnostics.js';
import { incomingQuoteItems, normalizeQuotes } from './quote.js';

const baseInfo = { channel_version: '2.4.8', bot_agent: 'WeixinCockpitBridge/0.1.0' };
const appHeaders = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x020408) };

function validMessageId(value) {
  return (Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^(0|[1-9]\d{0,19})$/u.test(value)
      && BigInt(value) <= 18446744073709551615n);
}

export function apiSuccess(result, { optionalRet = false } = {}) {
  requireThat(result.ret === 0 || (optionalRet && result.ret === undefined),
    result.ret === -14 || result.errcode === -14 ? 'WEIXIN_TOKEN_EXPIRED' : 'WEIXIN_API_REJECTED');
  requireThat(result.errcode === undefined || result.errcode === 0, result.errcode === -14 ? 'WEIXIN_TOKEN_EXPIRED' : 'WEIXIN_API_REJECTED');
}

export function sendSuccess(result) {
  const receipt = validMessageId(result.message_id) && BigInt(result.message_id) > 0n;
  // Public Tencent API returns a server-assigned uint64 ID even when ret is omitted.
  apiSuccess(result, { optionalRet: receipt });
  requireThat(Object.keys(result).every(key => ['ret', 'errcode', 'errmsg', 'message_id'].includes(key))
    && (result.message_id === undefined || receipt)
    && (result.errmsg === undefined || typeof result.errmsg === 'string')
    && (result.ret !== undefined || result.errmsg === undefined || result.errmsg === ''), 'WEIXIN_SEND_SCHEMA');
}

export class WeixinClient {
  constructor(config, credentials, { fetchImpl = fetch } = {}) {
    this.config = config; this.credentials = credentials; this.fetchImpl = fetchImpl;
    if (config.diagnostics?.weixinHttp) {
      this.diagnostics = new HttpDiagnostics(config, { secrets: [credentials?.token] });
    }
  }
  async call(endpoint, body, { token = this.credentials?.token, baseUrl = this.credentials?.baseUrl ?? DEFAULT_ORIGIN,
    method = 'POST', timeoutMs = this.config.limits.requestTimeoutMs, signal, base = true, onResponseShape } = {}) {
    const origin = validateApiOrigin(baseUrl, this.config.weixin.approvedApiOrigins);
    const headers = { ...appHeaders };
    if (method === 'POST') {
      Object.assign(headers, {
        'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      });
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const requestBody = body === undefined ? undefined : { ...body, ...(base ? { base_info: baseInfo } : {}) };
    const requestId = this.diagnostics ? randomUUID() : undefined;
    return requestJson(new URL(endpoint, `${origin}/`), {
      method, headers, body: requestBody,
      timeoutMs, signal, fetchImpl: this.fetchImpl, preserveMessageIds: true, onResponseShape,
      onTraffic: this.diagnostics ? event =>
        this.diagnostics.record({ ...event, requestId, at: Date.now() }, requestBody) : undefined,
    });
  }
  async poll(cursor, signal, timeoutMs = 35000) {
    const result = await this.call('ilink/bot/getupdates', { get_updates_buf: cursor }, { signal, timeoutMs: timeoutMs + 5000 });
    // Live getupdates omits success ret; its message/cursor schema is still required.
    apiSuccess(result, { optionalRet: true });
    requireThat(Array.isArray(result.msgs) && result.msgs.length <= 1000
      && typeof result.get_updates_buf === 'string' && result.get_updates_buf.length <= 1000000, 'WEIXIN_POLL_SCHEMA');
    if (result.longpolling_timeout_ms !== undefined) {
      requireThat(Number.isInteger(result.longpolling_timeout_ms) && result.longpolling_timeout_ms > 0
        && result.longpolling_timeout_ms <= 120000, 'WEIXIN_TIMEOUT_SCHEMA');
    }
    return result;
  }
  async send(peer, contextToken, value, clientId, signal, options) {
    return this.sendItems(peer, contextToken, [{ type: 1, text_item: { text: value } }], clientId, signal, options);
  }
  async sendItems(peer, contextToken, items, clientId, signal, { runId } = {}) {
    requireThat(text(contextToken), 'CONTEXT_TOKEN_REQUIRED');
    privateDirectory(this.config.stateDir);
    const result = await this.call('ilink/bot/sendmessage', { msg: {
      from_user_id: '', to_user_id: peer, client_id: clientId, message_type: 2, message_state: 2,
      context_token: contextToken, item_list: items,
      ...(runId ? { run_id: runId } : {}),
    } }, {
      signal,
      onResponseShape: shape =>
      writePrivate(path.join(this.config.stateDir, 'last-send-response.json'), shape) });
    sendSuccess(result);
    return { acceptance: 'confirmed',
      ...(result.message_id === undefined ? {} : { messageId: String(result.message_id) }) };
  }
  async typingTicket(peer, contextToken, signal) {
    const result = await this.call('ilink/bot/getconfig', { ilink_user_id: peer, context_token: contextToken },
      { signal, timeoutMs: 5000 });
    apiSuccess(result, { optionalRet: true });
    requireThat(result.typing_ticket === undefined || text(result.typing_ticket), 'WEIXIN_CONFIG_SCHEMA');
    requireThat(result.ret !== undefined || result.errmsg === undefined || result.errmsg === '', 'WEIXIN_CONFIG_SCHEMA');
    return result.typing_ticket ?? '';
  }
  async typing(peer, ticket, active, signal) {
    requireThat(text(ticket), 'TYPING_TICKET_REQUIRED');
    const result = await this.call('ilink/bot/sendtyping',
      { ilink_user_id: peer, typing_ticket: ticket, status: active ? 1 : 2 },
      { signal, timeoutMs: 5000, onResponseShape: shape =>
        writePrivate(path.join(this.config.stateDir, 'last-typing-response.json'), shape) });
    apiSuccess(result, { optionalRet: true });
    // The published response has optional ret/errmsg; an empty JSON object is valid.
    requireThat(Object.keys(result).every(key => ['ret', 'errcode', 'errmsg'].includes(key))
      && (result.errmsg === undefined || typeof result.errmsg === 'string')
      && (result.ret !== undefined || result.errmsg === undefined || result.errmsg === ''), 'WEIXIN_TYPING_SCHEMA');
  }
}

export async function login(client, { showQr, verifyCode, signal, timeoutMs = 480000 }) {
  const deadline = Date.now() + timeoutMs;
  const qr = await client.call('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] },
    { token: null, baseUrl: DEFAULT_ORIGIN, base: false, signal });
  requireThat(text(qr.qrcode) && text(qr.qrcode_img_content), 'LOGIN_QR_SCHEMA');
  let qrUrl;
  try { qrUrl = new URL(qr.qrcode_img_content); }
  catch { throw new BridgeError('LOGIN_QR_URL_REFUSED'); }
  requireThat(qrUrl.protocol === 'https:' && !qrUrl.username && !qrUrl.password, 'LOGIN_QR_URL_REFUSED');
  requireThat(qrUrl.hostname === 'weixin.qq.com' || qrUrl.hostname.endsWith('.weixin.qq.com'), 'LOGIN_QR_HOST_REFUSED');
  await showQr(qrUrl.href);
  let baseUrl = DEFAULT_ORIGIN;
  let code;
  while (Date.now() < deadline) {
    const query = new URLSearchParams({ qrcode: qr.qrcode, ...(code ? { verify_code: code } : {}) });
    const result = await client.call(`ilink/bot/get_qrcode_status?${query}`, undefined,
      { method: 'GET', token: null, baseUrl, signal, timeoutMs: 35000 });
    switch (result.status) {
      case 'wait': break;
      case 'scaned': code = undefined; break;
      case 'need_verifycode':
        code = await verifyCode();
        requireThat(typeof code === 'string' && /^\d{4,12}$/u.test(code), 'INVALID_VERIFY_CODE');
        break;
      case 'scaned_but_redirect':
        requireThat(text(result.redirect_host) && /^[a-z0-9.-]+$/u.test(result.redirect_host), 'LOGIN_REDIRECT_REFUSED');
        baseUrl = validateApiOrigin(`https://${result.redirect_host}`, client.config.weixin.approvedApiOrigins);
        break;
      case 'confirmed':
        requireThat(text(result.bot_token) && text(result.ilink_bot_id, 200) && text(result.ilink_user_id, 200), 'LOGIN_CREDENTIAL_SCHEMA');
        requireThat(!/[\s\x00-\x1f\x7f]/u.test(result.bot_token + result.ilink_bot_id + result.ilink_user_id), 'LOGIN_CREDENTIAL_SCHEMA');
        return {
          token: result.bot_token, account: result.ilink_bot_id, peer: result.ilink_user_id,
          baseUrl: validateApiOrigin(result.baseurl, client.config.weixin.approvedApiOrigins),
          savedAt: new Date().toISOString(),
        };
      case 'expired': throw new BridgeError('LOGIN_QR_EXPIRED');
      case 'verify_code_blocked': throw new BridgeError('LOGIN_VERIFY_BLOCKED');
      case 'binded_redirect': throw new BridgeError('LOGIN_ALREADY_BOUND', 'No new credentials returned; existing OpenClaw credentials will not be read.');
      default: throw new BridgeError('LOGIN_STATUS_SCHEMA');
    }
    await sleep(1000, signal);
  }
  throw new BridgeError('LOGIN_TIMEOUT');
}

export function normalizeBatch(messages, config) {
  return messages.map(message => {
    requireThat(object(message), 'STABLE_MESSAGE_ID_REQUIRED');
    requireThat(validMessageId(message.message_id), 'STABLE_MESSAGE_ID_REQUIRED');
    const id = `${config.weixin.allowedAccount}:${message.message_id}`;
    const base = { id, marker: `wx-${randomUUID().slice(0, 12)}`, status: 'queued', receivedAt: Date.now() };
    const authorized = message.from_user_id === config.weixin.allowedPeer
      && message.to_user_id === config.weixin.allowedAccount && message.message_type === 1;
    if (!authorized || message.group_id) {
      return { ...base, status: 'rejected', reason: message.group_id ? 'GROUP_UNSUPPORTED' : 'SOURCE_NOT_ALLOWED' };
    }
    requireThat(message.message_state === 2, 'INCOMPLETE_MESSAGE');
    requireThat(text(message.context_token), 'CONTEXT_TOKEN_REQUIRED');
    requireThat(Array.isArray(message.item_list) && message.item_list.length <= 100, 'MESSAGE_ITEMS_SCHEMA');
    const supported = message.item_list.length > 0 && message.item_list.every(item =>
      object(item) && ((item.type === 1 && object(item.text_item) && typeof item.text_item.text === 'string')
        || ([2, 4, 5].includes(item.type) && object(item[{ 2: 'image_item', 4: 'file_item', 5: 'video_item' }[item.type]]))));
    const original = supported ? message.item_list.filter(item => item.type === 1).map(item => item.text_item.text).join('\n') : '';
    requireThat(original.length <= 50000, 'INBOUND_TEXT_TOO_LARGE');
    const quotes = normalizeQuotes(message.item_list);
    const media = supported ? message.item_list.flatMap((item, index) => [2, 4, 5].includes(item.type)
      ? [{ index, item: { type: item.type, [{ 2: 'image_item', 4: 'file_item', 5: 'video_item' }[item.type]]:
        item[{ 2: 'image_item', 4: 'file_item', 5: 'video_item' }[item.type]] } }] : []) : [];
    const textOnly = message.item_list.length > 0 && message.item_list.every(item =>
      object(item) && item.type === 1 && object(item.text_item) && typeof item.text_item.text === 'string');
    const legacyOriginal = textOnly ? original : '';
    return { ...base, peer: message.from_user_id, contextToken: message.context_token,
      kind: supported && (original.trim() || quotes.length || media.length) ? 'text' : 'unsupported', original,
      inputVersion: 2,
      legacyInput: { kind: textOnly && (legacyOriginal.trim() || quotes.length) ? 'text' : 'unsupported', original: legacyOriginal },
      ...(media.length ? { inputItems: message.item_list.map((item, index) => item.type === 1
        ? { type: 'text', text: item.text_item.text } : { type: 'media', index }) } : {}),
      ...(media.length ? { media, mediaFingerprint: createHash('sha256').update(JSON.stringify(media)).digest('hex') } : {}),
      quoteItems: incomingQuoteItems(message.item_list), ...(quotes.length ? { quotes } : {}) };
  });
}
