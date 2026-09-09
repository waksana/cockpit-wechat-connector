import { BridgeError, object, requireThat } from './common.js';

export const EMPTY_CONTROL_ACK = Symbol('empty-control-http-ack');

function valueType(value) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function protocolFields(value, depth = 0) {
  return Object.entries(value).slice(0, 20).flatMap(([name, item]) => {
    // Retain short protocol identifiers, never dynamic keys, string values or payloads.
    if (!/^[a-z][a-z_]{0,31}$/u.test(name)
      || /token|secret|password|auth|context|text|content|qrcode/u.test(name)) return [];
    const field = { name, type: valueType(item) };
    if (['ret', 'errcode', 'err_code', 'code', 'retcode', 'ret_code'].includes(name)
      && Number.isSafeInteger(item) && item >= -2147483648 && item <= 2147483647) field.code = item;
    if (object(item) && depth < 2) field.fields = protocolFields(item, depth + 1);
    return [field];
  });
}

function responseShape(value) {
  const shape = { bodyType: valueType(value) };
  if (!object(value)) return shape;
  const known = ['ret', 'errcode', 'errmsg'];
  shape.fields = known.filter(key => Object.hasOwn(value, key)).map(name => {
    const field = { name, type: valueType(value[name]) };
    if (name !== 'errmsg' && Number.isSafeInteger(value[name])
      && value[name] >= -2147483648 && value[name] <= 2147483647) field.code = value[name];
    return field;
  });
  shape.otherFieldCount = Object.keys(value).filter(key => !known.includes(key)).length;
  const otherFields = protocolFields(value).filter(field => !known.includes(field.name));
  if (otherFields.length) shape.otherFields = otherFields;
  return shape;
}

export async function requestJson(url, { method = 'POST', body, rawBody, headers = {}, timeoutMs = 15000,
  signal, fetchImpl = fetch, preserveMessageIds = false, onResponseShape, onTraffic,
  allowEmptyControlResponse = false } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let shape = { version: 1, httpStatus: null, bodyType: 'unread' };
  let response;
  let responseBody = null;
  let capture = 'no-response';
  let outcome = 'pending';
  const requestBody = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  onTraffic?.({ phase: 'request', url: String(url), method, headers, body: requestBody });
  try {
    response = await fetchImpl(url, { method, headers, redirect: 'manual', signal: combined,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      ...(rawBody === undefined ? {} : { duplex: 'half' }) });
    shape.httpStatus = response.status;
    capture = 'unread';
    if (onResponseShape) {
      const mime = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      shape.contentType = ['application/json', 'text/plain', 'text/html', 'application/octet-stream'].includes(mime)
        ? mime : mime ? 'other' : 'absent';
    }
    if (!response.ok) {
      if (onTraffic) {
        // Diagnostics may observe an error body, but cannot replace the existing
        // HTTP outcome or follow a redirect. The request's original timeout applies.
        try {
          const reader = response.body?.getReader();
          const chunks = [];
          let size = 0;
          if (reader) for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 4 * 1024 * 1024) { await reader.cancel(); capture = 'too-large'; break; }
            chunks.push(value);
          }
          if (capture !== 'too-large') { responseBody = Buffer.concat(chunks).toString('utf8'); capture = 'complete'; }
        } catch { capture = 'read-failed'; }
      } else await response.body?.cancel();
      throw new BridgeError(response.status >= 300 && response.status < 400
        ? 'HTTP_REDIRECT_REFUSED' : `HTTP_${response.status}`);
    }
    if (!response.body) {
      responseBody = ''; capture = 'complete';
      shape.bodyType = 'empty';
      if (onResponseShape) shape.bodyBytes = 0;
      if (allowEmptyControlResponse && response.status === 200
        && response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/octet-stream') {
        outcome = 'empty-control-ack'; return EMPTY_CONTROL_ACK;
      }
      throw new BridgeError('INVALID_JSON_RESPONSE');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) { capture = 'too-large'; await reader.cancel(); throw new BridgeError('HTTP_BODY_TOO_LARGE'); }
      chunks.push(value);
    }
    let parsed;
    responseBody = Buffer.concat(chunks).toString('utf8'); capture = 'complete';
    if (onResponseShape) shape.bodyBytes = size;
    if (size === 0 && allowEmptyControlResponse && response.status === 200
      && response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/octet-stream') {
      shape.bodyType = 'empty';
      outcome = 'empty-control-ack'; return EMPTY_CONTROL_ACK;
    }
    try {
      parsed = JSON.parse(responseBody, preserveMessageIds
        ? (key, value, context) => {
          // Preserve the original decimal token, never stringify a rounded IEEE-754 value.
          if (['message_id', 'msg_id', 'svr_id'].includes(key) && typeof value === 'number' && !Number.isSafeInteger(value)
            && typeof context.source === 'string' && /^(0|[1-9]\d*)$/u.test(context.source)) return context.source;
          return value;
        } : undefined);
    }
    catch {
      const raw = responseBody;
      shape.bodyType = size === 0 ? 'empty' : raw.trim() === '' ? 'whitespace' : 'invalid-json';
      if (onResponseShape && /^(?:OK|ok|success|undefined|NaN)$/u.test(raw.trim())) shape.literal = raw.trim();
      throw new BridgeError('INVALID_JSON_RESPONSE');
    }
    if (onResponseShape) shape = { ...shape, ...responseShape(parsed) };
    requireThat(object(parsed), 'INVALID_JSON_RESPONSE');
    outcome = 'json';
    return parsed;
  } catch (error) {
    outcome = error instanceof BridgeError ? error.code
      : signal?.aborted ? 'STOPPED' : timeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
    if (error instanceof BridgeError) throw error;
    if (signal?.aborted) throw new BridgeError('STOPPED');
    if (timeout.aborted) throw new BridgeError('REQUEST_TIMEOUT');
    throw new BridgeError('NETWORK_ERROR');
  } finally {
    onTraffic?.({ phase: 'response', url: String(url), method,
      httpStatus: response?.status ?? null, headers: response?.headers, body: responseBody, capture, outcome });
    // Persistence failure must propagate, never turn an uncertain mutation into success.
    if (onResponseShape) onResponseShape(shape);
  }
}
