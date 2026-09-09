import { BridgeError, object, requireThat, text } from './common.js';
import { createHash } from 'node:crypto';
import { requestJson } from './http.js';
import fs from 'node:fs';

export function historyCheckpoint(message) {
  return { id: message?.id ?? null, fingerprint: message ? createHash('sha256')
    .update(JSON.stringify([message.role, message.content, message.subtype, message.toolCalls])).digest('hex') : null };
}

export function deliveryCheckpoint(message, version = 3) {
  requireThat(version === 2 || version === 3, 'UNKNOWN_CHECKPOINT_VERSION');
  const attachment = message?.attachment;
  return { version, id: message?.id ?? null, fingerprint: message ? createHash('sha256')
    .update(JSON.stringify([message.role, message.content, message.subtype ?? null,
      attachment ? [attachment.kind, attachment.name, attachment.url, attachment.size ?? null, attachment.mime ?? null] : null,
      ...(version === 3 ? [message.parts ?? null, message.attachments ?? null] : [])]))
    .digest('hex') : null };
}

export function quiescent(meta) {
  return ['idle', 'unloaded'].includes(meta.status) && meta.queue.length === 0
    && !meta.ask && !meta.planRequest && !meta.elicitation && !meta.error
    && !['loading', 'closing', 'cancelling', 'compacting', 'nativeProcessing',
      'activeSubagents', 'activeMcpOperations', 'activeOperations'].some(key => Boolean(meta[key]));
}

export class CockpitClient {
  constructor(config, { fetchImpl = fetch, token = process.env.COCKPIT_API_TOKEN } = {}) {
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
      ['session/get', ['sessionId']], ['session/history', ['sessionId', 'beforeMsgId', 'limit', 'details']],
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
      && Array.isArray(meta.queue) && meta.queue.every(item => object(item) && text(item.id) && typeof item.text === 'string')
      && (meta.error === null || typeof meta.error === 'string')
      && (meta.ask === null || object(meta.ask)), 'COCKPIT_SESSION_SCHEMA');
    for (const name of ['ask', 'planRequest', 'elicitation']) {
      if (meta[name]) requireThat(text(meta[name].requestId), 'COCKPIT_CHOICE_SCHEMA');
    }
    requireThat(meta.cwd === this.config.cockpit.cwd, 'TARGET_CWD_CHANGED');
    return meta;
  }
  async page(beforeMsgId, signal) {
    const result = await this.call('session/history', {
      sessionId: this.config.cockpit.sessionId, limit: 200, details: 'summary',
      ...(beforeMsgId ? { beforeMsgId } : {}),
    }, signal);
    requireThat(result.sessionId === this.config.cockpit.sessionId && Array.isArray(result.messages)
      && typeof result.hasMore === 'boolean', 'COCKPIT_HISTORY_SCHEMA');
    for (const message of result.messages) {
      requireThat(object(message) && text(message.id)
        && ['user', 'assistant', 'system', 'tool'].includes(message.role)
        && typeof message.content === 'string'
        && (message.toolCalls === undefined || Array.isArray(message.toolCalls)), 'COCKPIT_MESSAGE_SCHEMA');
    }
    requireThat(new Set(result.messages.map(message => message.id)).size === result.messages.length, 'HISTORY_DUPLICATE_IDS');
    return result;
  }
  async baseline(signal) {
    const page = await this.page(undefined, signal);
    requireThat(page.messages.length > 0 || !page.hasMore, 'COCKPIT_HISTORY_SCHEMA');
    return page.messages.at(-1)?.id ?? null;
  }
  async since(baseline, signal, fingerprint, { version, includeBaseline = false } = {}) {
    let tail = [];
    let before;
    const seen = new Set();
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const page = await this.page(before, signal);
      for (const message of page.messages) {
        requireThat(!seen.has(message.id), 'HISTORY_PAGINATION_CHANGED');
        seen.add(message.id);
      }
      tail = [...page.messages, ...tail];
      if (baseline !== null) {
        const index = tail.findIndex(message => message.id === baseline);
        if (index >= 0) {
          if (fingerprint) requireThat((version === 2 || version === 3
            ? deliveryCheckpoint(tail[index], version) : historyCheckpoint(tail[index])).fingerprint
            === fingerprint, 'CHECKPOINT_CHANGED');
          return tail.slice(index + (includeBaseline ? 0 : 1));
        }
      }
      if (!page.hasMore) {
        requireThat(baseline === null, 'BASELINE_DISAPPEARED');
        return tail;
      }
      requireThat(page.messages.length > 0, 'HISTORY_PAGINATION_CHANGED');
      before = page.messages[0].id;
    }
    throw new BridgeError('HISTORY_WINDOW_EXCEEDED');
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
  requireThat(!foreign && meta.queue.every(item => item.text === job.prompt), 'EXTERNAL_INPUT_DETECTED');
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
