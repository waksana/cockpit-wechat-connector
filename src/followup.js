import { randomUUID } from 'node:crypto';
import { BridgeError, errorCode, requireThat } from './common.js';
import { quiescent } from './cockpit.js';
import { inputPrompt, retainedQuoteAttachments } from './quote.js';

// Only this process's newly received, authorized text can start an interruption.
// A restart never turns the durable inbox into a fresh interruption trigger.
export class NativeFollowup {
  epoch = randomUUID();
  constructor(bridge) { this.bridge = bridge; }
  textOnly(job) {
    return job.kind === 'text' && !job.media?.length
      && !retainedQuoteAttachments(job, this.bridge.store, this.bridge.config).length;
  }

  tag(jobs, freshPoll) {
    if (!this.bridge.config.nativeInterruptFollowup || !freshPoll) return;
    for (const job of jobs) {
      if (this.textOnly(job) && job.status === 'queued'
        && job.peer === this.bridge.config.weixin.allowedPeer) job.followupEpoch = this.epoch;
    }
  }

  async step(first, meta, signal) {
    if (this.bridge.draining) return true;
    const { store, config, cockpit } = this.bridge;
    let round = store.get('nativeFollowup');
    if (!round && (!config.nativeInterruptFollowup || first.followupEpoch !== this.epoch || !this.textOnly(first))) return false;
    if (!round) {
      round = { id: randomUUID(), epoch: this.epoch, leaderId: first.id,
        startedAt: Date.now(), phase: 'draining', attempts: 0 };
      store.set('nativeFollowup', round);
    }
    requireThat(round.epoch === this.epoch && round.phase === 'draining', 'INTERRUPT_RECOVERY_REQUIRED');
    if (Date.now() - round.startedAt > config.limits.resultTimeoutMs) {
      this.fail(round, first, 'INTERRUPT_DRAIN_TIMEOUT');
    }
    if (meta.error || meta.status === 'error') this.fail(round, first, 'INTERRUPT_TARGET_ERROR');
    if (meta.closing || meta.cancelling || meta.loading || meta.compacting
      || meta.activeOperations || meta.activeMcpOperations) return true;

    if (!quiescent(meta)) {
      // Never leave an interrupt request outstanding when the new prompt is sent.
      // ACK is not idle: an older queued turn may begin while this one unwinds.
      requireThat(meta.loaded, 'INTERRUPT_TARGET_UNLOADED_BUSY');
      round.phase = 'requesting'; round.attempts++;
      store.set('nativeFollowup', round);
      let result;
      try { result = await cockpit.interrupt(signal); }
      catch (error) {
        round.lastError = errorCode(error);
        this.fail(round, first, 'INTERRUPT_OUTCOME_UNKNOWN');
      }
      round.phase = 'draining'; round.lastInterrupted = result.interrupted;
      store.set('nativeFollowup', round);
      this.bridge.log(`INTERRUPT_ACK ${first.marker} ${result.interrupted}`);
      return true;
    }

    // No silence timer: freeze only the inputs already present at this handoff.
    // Keep non-text/legacy work in FIFO position rather than jumping across it.
    const batch = [];
    for (const job of store.jobs().filter(job => job.status === 'queued')) {
      if (!this.textOnly(job) || job.followupEpoch !== this.epoch) break;
      batch.push(job);
    }
    requireThat(batch.length && batch[0].id === first.id, 'INTERRUPT_INBOX_ORDER_CHANGED');
    const prompt = batch.map(job => inputPrompt(job, store, config)).join('\n\n');
    await submitInputs(this.bridge, batch, prompt, signal, round.id);
    return true;
  }

  fail(round, job, code) {
    round.phase = 'blocked'; round.reason = code;
    this.bridge.store.transaction(() => {
      this.bridge.store.set('nativeFollowup', round);
      job.status = 'blocked'; job.reason = code;
      this.bridge.store.save(job);
    });
    throw new BridgeError(code);
  }
}

export async function submitInputs(bridge, jobs, prompt, signal, submissionId = randomUUID(), parts) {
  if (bridge.draining) return;
  const { store, cockpit } = bridge;
  const startedAt = Date.now();
  store.transaction(() => {
    for (const job of jobs) {
      job.prompt = prompt; job.submissionId = submissionId;
      job.promptVisible = parts ? parts.filter(part => part.type === 'text').map(part => part.text).join('').trim() : prompt;
      job.status = 'prompting'; job.startedAt = startedAt;
      store.save(job);
    }
    // The round is now irreversibly in send/observe, never interrupt again for it.
    store.set('nativeFollowup', null);
  });
  try { await cockpit.prompt(prompt, signal, undefined, parts); }
  catch (error) {
    store.transaction(() => {
      for (const job of jobs) {
        job.lastError = errorCode(error); job.status = 'blocked'; job.reason = 'PROMPT_OUTCOME_UNKNOWN';
        store.save(job);
      }
    });
    throw new BridgeError('PROMPT_OUTCOME_UNKNOWN');
  }
  store.transaction(() => {
    for (const job of jobs) { job.status = 'accepted'; store.save(job); }
  });
  bridge.log(`PROMPT_ACCEPTED ${jobs.map(job => job.marker).join(' ')}`);
}
