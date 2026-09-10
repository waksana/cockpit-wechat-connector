import { createHash } from 'node:crypto';
import { BridgeError, errorCode, requireThat, sleep } from './common.js';

const hash = value => createHash('sha256').update(value).digest('hex');
export function replying(meta) {
  return meta.loaded && !['unloaded', 'error'].includes(meta.status) && !meta.error
    && !['ask', 'planRequest', 'elicitation', 'loading', 'closing', 'cancelling', 'compacting']
      .some(key => Boolean(meta[key]))
    && (meta.nativeProcessing === true || meta.activeSubagents > 0 || meta.activeMcpOperations > 0);
}

export class StatusDisplay {
  constructor(config, store, weixin, cockpit, log = console.log) {
    this.config = config; this.store = store; this.weixin = weixin; this.cockpit = cockpit; this.log = log;
    this.state = store.get('statusDisplay') ?? { version: 1, typingMayBeActive: false };
    requireThat(this.state.version === 1, 'STATUS_STATE_VERSION');
    this.save();
    this.ticket = ''; this.refreshAt = 0; this.nextTypingAt = 0;
    this.cancelRetryAt = 0;
    this.typingAttempted = Boolean(this.state.typingMayBeActive);
  }
  save() { this.store.set('statusDisplay', this.state); }
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

  async tick(signal) {
    if (this.stopping?.()) return;
    const context = this.store.jobs().findLast(job => ['text', 'unsupported'].includes(job.kind)
      && job.peer === this.config.weixin.allowedPeer && job.contextToken);
    if (!context) return;
    const meta = await this.cockpit.meta(signal);
    if (this.stopping?.()) return;
    await this.updateTyping(meta, context, signal);
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
