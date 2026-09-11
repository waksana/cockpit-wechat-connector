import { BridgeError, object, requireThat, text } from './common.js';
import { createHash } from 'node:crypto';
import { requestJson } from './http.js';
import fs from 'node:fs';
import { secureExisting } from './storage.js';
import { nativeMessages } from './native-messages.js';

export function historyCheckpoint(message) {
  return { ...(message?.nativePosition ? { position: message.nativePosition } : {}),
    id: message?.id ?? null, fingerprint: message ? createHash('sha256')
    .update(JSON.stringify([message.role, message.content, message.subtype, message.toolCalls])).digest('hex') : null };
}

export function verifyCheckpoint(checkpoint, message, legacyOutput) {
  requireThat(message?.id === checkpoint.id, 'CHECKPOINT_CHANGED');
  const actual = checkpoint.version === 2 || checkpoint.version === 3
    ? deliveryCheckpoint(message, checkpoint.version) : historyCheckpoint(message);
  if (actual.fingerprint === checkpoint.fingerprint) return;
  requireThat(checkpoint.version === undefined, 'CHECKPOINT_CHANGED');
  // A v1 checkpoint saved only a hash of folded tool metadata, not its preimage.
  // An old output with that exact hash independently retains the frozen body.
  if (legacyOutput?.kind === 'session-output' && legacyOutput.outboxPurpose === 'final' && legacyOutput.outputVersion === undefined
    && legacyOutput.outputMessageId === checkpoint.id && legacyOutput.outputFingerprint === checkpoint.fingerprint) {
    requireThat(['done', 'abandoned'].includes(legacyOutput.status), 'UNRESOLVED_OUTPUT_STATE');
    requireThat(legacyOutput.status === 'abandoned' || !legacyOutput.outbox
      || legacyOutput.outbox.every(part => part.status === 'accepted'), 'UNRESOLVED_OUTPUT_STATE');
    requireThat(message.role === 'assistant' && !message.subtype && legacyOutput.original === message.content
      && !message.attachment && !message.attachments?.length
      && !message.parts?.some(part => part.type === 'file'), 'CHECKPOINT_CHANGED');
    return;
  }
  throw new BridgeError('LEGACY_CHECKPOINT_REVIEW_REQUIRED',
    'The legacy checkpoint hash includes folded tool fields unavailable in native chat. No matching frozen output proves its original body. Keep the checkpoint/outbox unchanged and obtain an explicit history-review decision; do not automatically trust the latest history.');
}

export function deliveryCheckpoint(message, version = 3) {
  requireThat(version === 2 || version === 3, 'UNKNOWN_CHECKPOINT_VERSION');
  const attachment = message?.attachment;
  return { ...(message?.nativePosition ? { position: message.nativePosition } : {}),
    version, id: message?.id ?? null, fingerprint: message ? createHash('sha256')
    .update(JSON.stringify([message.role, message.content, message.subtype ?? null,
      attachment ? [attachment.kind, attachment.name, attachment.url, attachment.size ?? null, attachment.mime ?? null] : null,
      ...(version === 3 ? [message.parts ?? null, message.attachments ?? null] : [])]))
    .digest('hex') : null };
}

export function nativeCheckpoint(message, position, previous = {}) {
  return {
    ...deliveryCheckpoint(message), position,
    ...(message?.role === 'user' ? { userMessageId: message.id }
      : previous.userMessageId ? { userMessageId: previous.userMessageId } : {}),
  };
}

export function quiescent(meta) {
  return meta.loaded === true && meta.status === 'idle' && Array.isArray(meta.queue) && meta.queue.length === 0
    && !meta.ask && !meta.planRequest && !meta.elicitation && !meta.error
    && !['loading', 'closing', 'cancelling', 'compacting', 'nativeProcessing',
      'activeSubagents', 'activeMcpOperations', 'activeOperations'].some(key => Boolean(meta[key]));
}

export function cockpitToken(config, token = process.env.COCKPIT_API_TOKEN) {
  if (config.cockpit.tokenFile !== undefined) {
    requireThat(token === undefined, 'COCKPIT_TOKEN_AUTHORITY_CONFLICT');
    try {
      secureExisting(config.cockpit.tokenFile);
      requireThat(fs.statSync(config.cockpit.tokenFile).size <= 16384, 'COCKPIT_TOKEN_FILE_INVALID');
      token = fs.readFileSync(config.cockpit.tokenFile, 'utf8').replace(/\r?\n$/, '');
      requireThat(/^[\x21-\x7e]{1,16384}(?![\s\S])/.test(token), 'COCKPIT_TOKEN_FILE_INVALID');
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('COCKPIT_TOKEN_FILE_READ_FAILED');
    }
  }
  return token;
}

export class CockpitClient {
  constructor(config, { fetchImpl = fetch, token = process.env.COCKPIT_API_TOKEN } = {}) {
    token = cockpitToken(config, token);
    this.config = config; this.fetchImpl = fetchImpl;
    this.headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }
  call(name, body, signal) {
    return requestJson(new URL(`/intent/${name}`, this.config.cockpit.apiUrl), {
      body, headers: this.headers, timeoutMs: this.config.limits.requestTimeoutMs, signal, fetchImpl: this.fetchImpl,
    });
  }
  async capabilities(signal) {
    for (const [name, fields] of [['prompt', ['sessionId', 'text', 'mode']],
      ['session/get', ['sessionId']], ['session/chat', ['sessionId', 'cursor', 'max', 'source', 'direction']],
      ...(this.config.nativeInterruptFollowup ? [['session/interrupt', ['sessionId']]] : [])]) {
      const detail = await requestJson(new URL(`/capabilities?name=${encodeURIComponent(name)}`, this.config.cockpit.apiUrl),
        { method: 'GET', headers: this.headers, signal, fetchImpl: this.fetchImpl, timeoutMs: this.config.limits.requestTimeoutMs });
      requireThat(detail.name === name && object(detail.inputSchema?.properties)
        && object(detail.resultSchema) && fields.every(field => field in detail.inputSchema.properties), 'COCKPIT_CAPABILITY_CHANGED');
      if (name === 'prompt') {
        requireThat(detail.inputSchema.properties.mode.enum?.includes('enqueue'), 'COCKPIT_ENQUEUE_UNAVAILABLE');
      }
    }
  }
  async meta(signal) {
    const result = await this.call('session/get', { sessionId: this.config.cockpit.sessionId }, signal);
    if (result.meta === null) throw new BridgeError('TARGET_SESSION_MISSING');
    const meta = result.meta;
    requireThat(object(meta) && meta.sessionId === this.config.cockpit.sessionId
      && typeof meta.cwd === 'string' && typeof meta.loaded === 'boolean'
      && ['idle', 'unloaded', 'running', 'error'].includes(meta.status)
      && ((!meta.loaded && meta.queue === undefined) || (Array.isArray(meta.queue)
        && meta.queue.every(item => object(item) && text(item.id) && typeof item.text === 'string')))
      && (meta.error === undefined || meta.error === null || typeof meta.error === 'string')
      && (meta.ask === null || object(meta.ask)), 'COCKPIT_SESSION_SCHEMA');
    for (const name of ['ask', 'planRequest', 'elicitation']) {
      if (meta[name]) requireThat(text(meta[name].requestId), 'COCKPIT_CHOICE_SCHEMA');
    }
    requireThat(meta.cwd === this.config.cockpit.cwd, 'TARGET_CWD_CHANGED');
    return meta;
  }
  async ensureLoaded(signal) {
    const result = await this.call('session/load', { sessionId: this.config.cockpit.sessionId }, signal);
    requireThat(result.ok === true && result.sessionId === this.config.cockpit.sessionId, 'COCKPIT_LOAD_SCHEMA');
  }
  async positionSource(position, signal) {
    requireThat(object(position) && text(position.cursor, 16384)
      && ['live', 'persisted'].includes(position.source), 'NATIVE_CHECKPOINT_INVALID');
    const meta = await this.meta(signal);
    requireThat(position.source !== 'live' || meta.loaded, 'SESSION_OUTPUT_BUSY');
    return position.source;
  }
  async nativePage(query, signal) {
    const result = await this.call('session/chat', {
      sessionId: this.config.cockpit.sessionId, max: 64, waitMs: 0, bootstrap: false,
      includeEphemeral: false, ...query,
    }, signal);
    requireThat(result.sessionId === this.config.cockpit.sessionId && Array.isArray(result.events)
      && typeof result.cursor === 'string' && typeof result.hasMore === 'boolean'
      && result.source === query.source && result.direction === query.direction, 'COCKPIT_HISTORY_SCHEMA');
    requireThat(result.cursorStatus === 'ok', 'NATIVE_CURSOR_EXPIRED');
    requireThat(result.events.length <= (query.max ?? 64), 'NATIVE_PAGE_BOUND_EXCEEDED');
    return result;
  }
  liveFilter() {
    return { agentScope: 'primary', types: ['user.message', 'assistant.message', 'session.error'] };
  }
  async page(before, signal) {
    requireThat(before === undefined, 'CHAT_PROTOCOL_CHANGED');
    const meta = await this.meta(signal);
    const source = meta.loaded ? 'live' : 'persisted';
    const page = await this.nativePage({
      source, direction: 'backward', max: 256, bootstrap: source === 'live',
      ...(source === 'live' ? this.liveFilter() : {}),
    }, signal);
    let position;
    if (page.liveCursor !== undefined) position = { cursor: page.liveCursor, source: 'live' };
    return { messages: nativeMessages(page.events), hasMore: page.hasMore, position };
  }
  async baseline(signal) {
    const page = await this.page(undefined, signal);
    requireThat(page.messages.length > 0 || !page.hasMore, 'COCKPIT_HISTORY_SCHEMA');
    requireThat(page.position, 'CHECKPOINT_REQUIRES_LOADED_SESSION');
    return nativeCheckpoint(page.messages.at(-1), page.position);
  }
  async since(baseline, signal, fingerprint, { version, includeBaseline = false, position } = {}) {
    if (object(baseline)) { position ??= baseline.position; fingerprint ??= baseline.fingerprint; version ??= baseline.version; baseline = baseline.id; }
    if (!position) {
      const page = await this.page(undefined, signal);
      const index = baseline === null ? -1 : page.messages.findIndex(message => message.id === baseline);
      requireThat(baseline === null ? !page.hasMore : index >= 0, 'CHECKPOINT_MIGRATION_REQUIRED');
      if (fingerprint && index >= 0) verifyCheckpoint({ id: baseline, version, fingerprint }, page.messages[index]);
      return page.messages.slice(index + (includeBaseline && index >= 0 ? 0 : 1));
    }
    const events = [];
    const source = await this.positionSource(position, signal);
    let cursor = position.cursor;
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const page = await this.nativePage({
        source, direction: 'forward', cursor, max: 256, ...(source === 'live' ? this.liveFilter() : {}),
      }, signal);
      events.push(...page.events);
      requireThat(!page.hasMore || page.cursor !== cursor, 'HISTORY_PAGINATION_CHANGED');
      cursor = page.cursor;
      if (!page.hasMore) {
        const messages = nativeMessages(events);
        if (messages.length) messages.at(-1).nativePosition = { cursor, source };
        return messages;
      }
    }
    throw new BridgeError('HISTORY_WINDOW_EXCEEDED');
  }
  async deliveryPage(checkpoint, signal) {
    requireThat(checkpoint?.position, 'NATIVE_CHECKPOINT_REQUIRED');
    const source = await this.positionSource(checkpoint.position, signal);
    const query = {
      source, direction: 'forward', cursor: checkpoint.position.cursor, max: 64,
      ...(source === 'live' ? this.liveFilter() : {}),
    };
    let page = await this.nativePage(query, signal);
    const output = page.events.findIndex(event => nativeMessages([event]).some(message =>
      message.role === 'assistant' && (message.content.trim() || message.parts?.length)));
    if (output >= 0 && output + 1 < page.events.length) {
      const prefix = await this.nativePage({ ...query, max: output + 1 }, signal);
      requireThat(JSON.stringify(prefix.events.map(event => event.id))
        === JSON.stringify(page.events.slice(0, output + 1).map(event => event.id)), 'HISTORY_CHANGED_DURING_READ');
      page = prefix;
    }
    requireThat(!page.hasMore || page.cursor !== query.cursor, 'HISTORY_PAGINATION_CHANGED');
    return { messages: nativeMessages(page.events), hasMore: page.hasMore,
      position: { cursor: page.cursor, source } };
  }
  async uploadFile(file, metadata, size, signal) {
    const origin = new URL(this.config.cockpit.apiUrl);
    requireThat(['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname), 'MEDIA_BACKEND_MUST_BE_LOOPBACK');
    const stream = fs.createReadStream(file);
    try {
      return await requestJson(new URL(`/upload?${new URLSearchParams(metadata)}`, origin), {
        rawBody: stream, headers: { ...this.headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        timeoutMs: this.config.limits.requestTimeoutMs, signal, fetchImpl: this.fetchImpl,
      });
    } finally { stream.destroy(); }
  }
  async prompt(value, signal, attachments, parts) {
    const result = await this.call('prompt', {
      sessionId: this.config.cockpit.sessionId, text: parts ? '' : value, mode: 'enqueue',
      ...(parts ? { parts } : attachments?.length ? { attachments } : {}),
    }, signal);
    requireThat(result.ok === true && (result.queued === undefined || typeof result.queued === 'boolean'), 'COCKPIT_PROMPT_REJECTED');
    return result;
  }
  async interrupt(signal) {
    const result = await this.call('session/interrupt', { sessionId: this.config.cockpit.sessionId }, signal);
    requireThat(result.ok === true && typeof result.interrupted === 'boolean', 'COCKPIT_INTERRUPT_SCHEMA');
    return result;
  }
}

export function correlate(job, messages, meta) {
  const own = messages.filter(message => message.role === 'user' && message.content === (job.promptVisible ?? job.prompt));
  requireThat(own.length <= 1, 'DUPLICATE_PROMPT_MARKER');
  const foreign = messages.some(message => message.role === 'user'
    && message.content !== (job.promptVisible ?? job.prompt) && message.subtype !== 'ask-reply');
  requireThat(!foreign && (meta.queue === undefined || meta.queue.every(item => item.text === job.prompt)),
    'EXTERNAL_INPUT_DETECTED');
  if (!own.length) {
    requireThat(!job.userMessageId, 'PROMPT_MARKER_DISAPPEARED');
    return { waiting: true };
  }
  if (job.userMessageId) requireThat(job.userMessageId === own[0].id, 'PROMPT_ID_CHANGED');
  const index = messages.findIndex(message => message.id === own[0].id);
  // New assistant output before our marker indicates another writer raced the baseline.
  requireThat(!messages.slice(0, index).some(message => message.role !== 'system'), 'EXTERNAL_ACTIVITY_DETECTED');
  const after = messages.slice(index + 1);
  const failure = meta.status === 'error' || meta.error || after.some(message => message.level === 'error');
  const choice = ['ask', 'planRequest', 'elicitation'].find(key => meta[key]);
  const pendingTool = after.some(message => message.toolCalls?.some(tool =>
    !object(tool) || ['pending', 'in_progress', 'running'].includes(tool.status)));
  const lastAnswer = after.findLastIndex(message => message.role === 'user');
  const replies = after.slice(lastAnswer + 1).filter(message => message.role === 'assistant'
    && !message.subtype && !message.toolCalls?.length
    && (message.content.trim() || message.attachment || message.attachments?.length || message.parts?.length));
  return {
    userMessageId: own[0].id, failure: Boolean(failure),
    choice: choice ? `${choice}:${meta[choice].requestId}` : null,
    reply: quiescent(meta) && !pendingTool && replies.length ? replies.at(-1) : null,
  };
}
