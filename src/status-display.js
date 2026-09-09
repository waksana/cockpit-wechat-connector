import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, errorCode, requireThat, sleep, text } from './common.js';
import { replyRunId } from './reply-run.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const finished = status => ['completed', 'failed'].includes(status);
const textHeading = '[工具状态]\n';
function toolLine({ tool, name, phase }) {
  const labels = { in_progress: '执行中', completed: '完成', failed: '失败' };
  const status = name === 'start' ? 'in_progress' : phase.result;
  requireThat(Object.hasOwn(labels, status), 'TOOL_STATUS_SCHEMA');
  const nameLabel = tool.name.length > 80 ? `${tool.name.slice(0, 80)}…` : tool.name;
  return `${nameLabel}：${labels[status]}`;
}

export function replying(meta) {
  return meta.loaded && !['unloaded', 'error'].includes(meta.status) && !meta.error
    && !['ask', 'planRequest', 'elicitation', 'loading', 'closing', 'cancelling', 'compacting']
      .some(key => Boolean(meta[key]))
    && (meta.nativeProcessing === true || meta.activeSubagents > 0 || meta.activeMcpOperations > 0);
}

export class StatusDisplay {
  constructor(config, store, weixin, cockpit, log = console.log) {
    this.config = config; this.store = store; this.weixin = weixin; this.cockpit = cockpit; this.log = log;
    this.state = store.get('statusDisplay') ?? { version: 1, initialized: false, tools: {} };
    requireThat(this.state.version === 1, 'STATUS_STATE_VERSION');
    for (const tool of Object.values(this.state.tools)) {
      for (const phase of [tool.start, tool.end, tool.snapshot]) {
        if (phase?.status === 'sending') {
          requireThat(typeof phase.contextHash === 'string' && /^[a-f0-9]{64}$/u.test(phase.contextHash),
            'STATUS_SENDING_CONTEXT_REQUIRED');
          phase.status = 'unknown';
          this.state.pausedContext = phase.contextHash; this.state.lastToolError = 'INTERRUPTED';
          this.state.pausedFormat = phase.format ?? 'native';
          this.log('TOOL_PROGRESS_UNKNOWN INTERRUPTED');
        }
      }
    }
    this.save();
    this.ticket = ''; this.refreshAt = 0; this.nextTypingAt = 0;
    this.cancelRetryAt = 0;
    this.typingAttempted = Boolean(this.state.typingMayBeActive);
  }
  save() { this.store.set('statusDisplay', this.state); }
  toolFormat() { return this.config.statusDisplay.toolFormat ?? 'native'; }

  async updateTyping(meta, context, signal) {
    if (this.stopping?.()) return;
    if (!this.config.statusDisplay.typing) return;
    const now = Date.now();
    const active = replying(meta);
    if (!active && now < this.cancelRetryAt) return;
    if (now < this.nextTypingAt && (active || !this.ticket)) return;
    if (!active && !this.typingAttempted) return;
    this.nextTypingAt = now + 5000;
    try {
      const contextHash = hash(context.contextToken);
      if (now >= this.refreshAt || this.ticketContext !== contextHash) {
        this.ticketContext = contextHash;
        this.refreshAt = now + 60000;
        this.ticket = await this.weixin.typingTicket(context.peer, context.contextToken, signal);
        this.refreshAt = now + (this.ticket ? 3600000 : 60000);
        if (!this.ticket) this.log('TYPING_UNAVAILABLE NO_TICKET');
      }
      if (!this.ticket || this.stopping?.()) return;
      if (!active) { await this.cancelTyping(signal); return; }
      this.typingAttempted = true;
      this.state.typingMayBeActive = true; this.save();
      await this.weixin.typing(context.peer, this.ticket, true, signal);
      if (!this.typingAccepted) this.log('TYPING_STARTED');
      this.typingAccepted = true; this.cancelRetryAt = 0;
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      if (!signal?.aborted) this.log(`TYPING_UNAVAILABLE ${errorCode(error)}`);
      // State refresh is ephemeral, not a content-message resend. Back off display failures.
      this.nextTypingAt = now + 60000;
    }
  }

  async cancelTyping(signal, force = false) {
    if (!this.typingAttempted || !this.ticket || (!force && Date.now() < this.cancelRetryAt)) return;
    try {
      await this.weixin.typing(this.config.weixin.allowedPeer, this.ticket, false, signal);
      this.typingAttempted = false; this.typingAccepted = false; this.nextTypingAt = 0;
      this.cancelRetryAt = 0;
      this.state.typingMayBeActive = false; this.save();
      this.log('TYPING_CANCELLED');
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      this.cancelRetryAt = Date.now() + 60000;
      this.log(`TYPING_CANCEL_UNKNOWN ${errorCode(error)}`);
    }
  }

  observeTools(messages, meta, checkpoint) {
    const sourceIds = new Set(messages.map(message => message.id));
    if (this.state.checkpoint !== checkpoint.id) {
      for (const [id, tool] of Object.entries(this.state.tools)) {
        if (!sourceIds.has(tool.messageId) && tool.end?.status !== 'pending') delete this.state.tools[id];
      }
    }
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      let tools = message.toolCalls ?? [];
      if (message.subtype === 'subagent') {
        const child = message.subagent;
        if (!child) continue;
        tools = [{ toolCallId: child.toolCallId ?? message.id, name: 'task',
          status: child.status === 'running' ? 'in_progress' : child.status }];
      } else if (message.subtype) continue;
      for (const tool of tools) {
        requireThat(text(tool.toolCallId, 512), 'TOOL_ID_SCHEMA');
        if (!['pending', 'in_progress', 'completed', 'failed'].includes(tool.status)) continue;
        const id = hash(`${this.config.cockpit.sessionId}:${tool.toolCallId}`);
        let record = this.state.tools[id];
        if (!record) {
          requireThat(Object.keys(this.state.tools).length < 2000, 'STATUS_TOOL_LIMIT');
          record = this.state.tools[id] = {
            messageId: message.id,
            toolId: /^[a-zA-Z0-9_.:-]{1,256}$/u.test(tool.toolCallId) ? tool.toolCallId : `wxt-${id.slice(0, 32)}`,
            runId: replyRunId(this.config, this.store, messages, message.id, checkpoint),
            name: typeof tool.name === 'string' && /^[a-zA-Z][a-zA-Z0-9_./:-]{0,119}$/u.test(tool.name) ? tool.name : 'tool',
          };
          if (!this.state.initialized && finished(tool.status)) record.end = { status: 'skipped' };
        }
        if (finished(tool.status)) {
          if (record.start?.status === 'pending') record.start.status = 'skipped';
          if (record.snapshot?.status === 'pending') record.snapshot.status = 'skipped';
          record.end ??= { status: 'pending', result: tool.status, clientId: `wxp-${randomUUID()}` };
        } else if (tool.status === 'in_progress' && !record.start && !record.end) {
          record.start = { status: replying(meta) ? 'pending' : 'skipped', clientId: `wxp-${randomUUID()}` };
        }
        if (tool.status === 'in_progress' && replying(meta) && this.toolFormat() === 'text'
          && record.start?.status === 'unknown' && (record.start.format ?? 'native') === 'native'
          && !record.snapshot) {
          // A fresh current-state text snapshot is not a replay or success claim for the unknown native event.
          record.snapshot = { status: 'pending', result: 'in_progress', clientId: `wxp-${randomUUID()}` };
        }
      }
    }
    this.state.initialized = true; this.state.checkpoint = checkpoint.id;
    this.save();
  }

  async sendTools(context, signal) {
    const contextHash = hash(context.contextToken);
    const format = this.toolFormat();
    if (this.state.pausedContext === contextHash && (this.state.pausedFormat ?? 'native') === format) return;
    if (this.state.pausedContext) {
      delete this.state.pausedContext; delete this.state.pausedFormat; delete this.state.lastToolError; this.save();
      this.log('TOOL_PROGRESS_RESUMED_NEW_CONTEXT_OR_FORMAT');
    }
    const pending = [];
    for (const tool of Object.values(this.state.tools)) {
      for (const [name, phase] of [['start', tool.start], ['snapshot', tool.snapshot], ['end', tool.end]]) {
        if (phase?.status !== 'pending') continue;
        if (name === 'snapshot' && format !== 'text') continue;
        pending.push({ tool, name, phase });
        if (pending.length >= 5) break;
      }
      if (pending.length >= 5) break;
    }
    if (format === 'text') {
      let batch = [];
      for (const event of pending) {
        if (batch.length && Buffer.byteLength(textHeading + [...batch, event].map(toolLine).join('\n'))
          > this.config.limits.textBytes) {
          if (!await this.deliverProgress(batch, context, contextHash, format, signal)) return;
          batch = [];
        }
        batch.push(event);
      }
      if (batch.length) await this.deliverProgress(batch, context, contextHash, format, signal);
    } else {
      for (const event of pending) {
        if (!await this.deliverProgress([event], context, contextHash, format, signal)) break;
      }
    }
  }

  async deliverProgress(events, context, contextHash, format, signal) {
    if (this.stopping?.()) return false;
    let items;
    const first = events[0];
    if (format === 'text') {
      const value = textHeading + events.map(toolLine).join('\n');
      requireThat(Buffer.byteLength(value) <= this.config.limits.textBytes, 'TOOL_PROGRESS_TOO_LARGE');
      items = [{ type: 1, text_item: { text: value } }];
    } else {
      const ending = first.name === 'end';
      items = [{
        type: ending ? 12 : 11, create_time_ms: Date.now(), is_completed: ending,
        [ending ? 'tool_call_result_item' : 'tool_call_start_item']: {
          tool_name: first.tool.name, tool_call_id: first.tool.toolId,
          ...(ending ? { status: first.phase.result } : {}),
        },
      }];
    }
    const clientId = first.phase.clientId;
    for (const { phase } of events) {
      phase.status = 'sending'; phase.contextHash = contextHash; phase.format = format; phase.clientId = clientId;
    }
    this.save();
    try {
      const receipt = await this.weixin.sendItems(context.peer, context.contextToken, items, clientId, signal,
        { ...(format === 'native' ? { runId: first.tool.runId } : {}), progress: true });
      const submitted = receipt?.acceptance === 'transport-only';
      for (const { phase } of events) phase.status = submitted ? 'submitted' : 'accepted';
      this.save();
      this.log(`TOOL_PROGRESS_${submitted ? 'SUBMITTED' : 'ACCEPTED'} ${format} ${events.length}`);
      return true;
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      for (const { phase } of events) phase.status = 'unknown';
      this.state.pausedContext = contextHash; this.state.pausedFormat = format;
      this.state.lastToolError = errorCode(error); this.save();
      if (!signal?.aborted) this.log(`TOOL_PROGRESS_PAUSED ${errorCode(error)}`);
      return false;
    }
  }

  async tick(signal) {
    if (this.stopping?.()) return;
    const context = this.store.jobs().findLast(job => ['text', 'unsupported'].includes(job.kind)
      && job.peer === this.config.weixin.allowedPeer && job.contextToken);
    if (!context) return;
    const meta = await this.cockpit.meta(signal);
    if (this.stopping?.()) return;
    await this.updateTyping(meta, context, signal);
    if (this.stopping?.()) return;
    if (!this.config.statusDisplay.tools) return;
    const checkpoint = this.store.get('historyCheckpoint');
    if (!checkpoint) return;
    // Catch terminal tool updates before following the reply-delivery cursor past those messages.
    const observed = this.state.observationCheckpoint ?? checkpoint;
    const messages = await this.cockpit.since(observed.id, signal, observed.fingerprint, { version: observed.version });
    this.observeTools(messages, meta, observed);
    // A complete assistant body can now be delivered before its tools finish.
    // Keep their source messages readable until terminal states are observed.
    this.state.observationCheckpoint = Object.values(this.state.tools).some(tool => !tool.end)
      ? observed : checkpoint;
    this.save();
    await this.sendTools(context, signal);
  }

  async run(signal, stopSignal = signal) {
    this.stopping = () => stopSignal.aborted;
    let previousError;
    try {
      while (!stopSignal.aborted) {
        try {
          await this.tick(signal);
          if (previousError) this.log('STATUS_READ_RECOVERED');
          previousError = undefined;
        } catch (error) {
          if (!(error instanceof BridgeError)) throw error;
          if (stopSignal.aborted) break;
          const code = errorCode(error);
          if (code !== previousError) this.log(`STATUS_UNAVAILABLE ${code}`);
          previousError = code;
        }
        try { await sleep(this.config.limits.statusIntervalMs, stopSignal); }
        catch (error) { if (!stopSignal.aborted) throw error; }
      }
    } finally {
      // This only clears Weixin display state. It never interrupts or wakes a Copilot session.
      await this.cancelTyping(AbortSignal.timeout(5000), true);
    }
  }
}
