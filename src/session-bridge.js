import { createHash } from 'node:crypto';
import { Bridge, createOutbox } from './bridge.js';
import { errorCode, requireThat, retryableRead, sessionLink, sleep } from './common.js';
import { deliveryCheckpoint, quiescent, verifyCheckpoint } from './cockpit.js';
import { StatusDisplay } from './status-display.js';
import { replyRunId } from './reply-run.js';
import { readEventStream, WorkSignal } from './events.js';
import { NativeFollowup, submitInputs } from './followup.js';

const visible = message => message.role === 'assistant' && !message.subtype
  && (message.content.trim() || message.attachment || message.attachments?.length || message.parts?.length);
const anchor = message => !message.subtype && ['user', 'assistant'].includes(message.role)
  && (message.content.trim() || message.attachment || message.attachments?.length || message.parts?.length);

// Native execution queue and a single authorized user's view of one shared conversation.
// Inbox acceptance and output delivery are independent: no per-prompt final/run ID is invented.
export class SessionBridge extends Bridge {
  followup = new NativeFollowup(this);
  prepareIngress(jobs, freshPoll) { this.followup.tag(jobs, freshPoll); }
  async establishCheckpoint(signal, explicit = false) {
    const checkpoint = this.store.get('historyCheckpoint');
    if (!explicit && checkpoint?.fingerprint && !checkpoint.position) {
      await this.readWindow(checkpoint, signal);
    }
    return super.establishCheckpoint(signal, explicit);
  }
  work = new WorkSignal();
  wakeWork() { this.work.notify(); }
  async waitForWork(signal) {
    if (this.store.get('nativeFollowup')) {
      await this.work.wait(this.config.limits.statusIntervalMs, signal);
      this.work.consume();
      return;
    }
    const ready = this.deliveryMore || this.store.jobs().some(job => job.status === 'replying'
      || (job.status === 'queued' && !this.ingressPaused));
    if (ready) await sleep(100, signal);
    else {
      const meta = this.deliveryMeta;
      const active = meta?.loaded && (meta.nativeProcessing || meta.status === 'running'
        || meta.activeSubagents > 0 || meta.activeMcpOperations > 0 || meta.queue?.length);
      await this.work.wait(active ? Math.max(1000, this.config.limits.statusIntervalMs) : 30000, signal);
      if (this.work.pending) await sleep(500, signal);
    }
    this.work.consume();
  }
  async observeEvents(signal) {
    let trailing;
    let failures = 0;
    const wake = event => {
      if (event.type === 'connected') { failures = 0; this.log('COCKPIT_SSE_CONNECTED'); }
      this.wakeWork();
      // Metadata/control wakeups can precede durable journal writes. Confirm once
      // after each burst; assistant bodies arrive only through native reads.
      clearTimeout(trailing);
      trailing = setTimeout(() => this.wakeWork(), 1000);
    };
    try {
      while (!signal.aborted) {
        try { await readEventStream(this.cockpit, wake, signal); }
        catch (error) {
          if (signal.aborted) return;
          this.log(`COCKPIT_SSE_FALLBACK ${errorCode(error)}`);
        }
        await sleep(Math.min(30000, 2000 * 2 ** Math.min(failures++, 4)), signal);
      }
    } finally { clearTimeout(trailing); }
  }
  needsEvidence(job) { return job.kind === 'session-output' || super.needsEvidence(job); }
  async observeStatus(signal, stopSignal) {
    if (!this.config.statusDisplay?.typing) return;
    await new StatusDisplay(this.config, this.store, this.weixin, this.cockpit, this.log).run(signal, stopSignal);
  }

  async evidence(job, signal) {
    if (job.kind !== 'session-output') return super.evidence(job, signal);
    await this.cockpit.meta(signal);
    const { messages, checkpoint } = await this.readWindow(job.outputBaseline, signal);
    const message = messages.find(item => item.id === job.outputMessageId);
    this.checkOutput(job, message, 'FINAL_EVIDENCE_CHANGED');
    job.outputBaseline = checkpoint;
    await this.cockpit.meta(signal);
    return messages;
  }

  async readWindow(checkpoint, signal) {
    requireThat(checkpoint, 'HISTORY_CHECKPOINT_REQUIRED');
    requireThat(checkpoint.version === undefined || [2, 3].includes(checkpoint.version), 'UNKNOWN_CHECKPOINT_VERSION');
    if (checkpoint.position) {
      const page = await this.cockpit.deliveryPage(checkpoint, signal);
      return { checkpoint, ...page };
    }
    // One bounded migration window. Drain already-observed legacy output before
    // adopting tail(); missing anchors pause delivery, never silently skip it.
    const page = await this.cockpit.page(undefined, signal);
    const index = checkpoint.id === null ? -1 : page.messages.findIndex(message => message.id === checkpoint.id);
    requireThat(checkpoint.id === null ? !page.hasMore : index >= 0, 'CHECKPOINT_MIGRATION_REQUIRED');
    const baseline = index >= 0 ? page.messages[index] : undefined;
    if (checkpoint.fingerprint) verifyCheckpoint(checkpoint, baseline,
      this.store.job(`session-output:${this.config.cockpit.sessionId}:${checkpoint.id}`));
    const messages = page.messages.slice(index + 1);
    const migrated = checkpoint.version === 2 || checkpoint.version === 3 ? checkpoint : {
      ...deliveryCheckpoint(baseline), ...(baseline?.role === 'user' ? { userMessageId: baseline.id } : {}),
    };
    if (!messages.length && page.position) {
      return { checkpoint: { ...migrated, position: page.position }, messages, hasMore: false };
    }
    // A passive backward page cannot bootstrap a forward tail. Keep the verified
    // anchor until normal input/resume provides one; never resume just to read.
    return { checkpoint: migrated, messages, position: page.position, hasMore: false };
  }

  checkOutput(job, message, code) {
    requireThat(message && visible(message) && message.id === job.outputMessageId, code);
    if (job.outputVersion === undefined) {
      // Old records froze only the text. Do not rebuild their outbox, replay
      // accepted pieces, or silently backfill an attachment during migration.
      requireThat(job.original === message.content && !message.attachment, code);
      job.outputVersion = 2; job.outputFingerprint = deliveryCheckpoint(message, 2).fingerprint;
      this.store.save(job);
    }
    // Replay may add rich fields to old native markers. A v2 record still owns
    // only its original body/legacy attachment: never backfill or resend media.
    requireThat([2, 3].includes(job.outputVersion)
      && job.outputFingerprint === deliveryCheckpoint(message, job.outputVersion).fingerprint, code);
  }

  async step(signal) {
    if (this.draining) return;
    this.deliveryMore = false;
    this.ingressPaused = false;
    const jobs = this.store.jobs();
    const blocked = jobs.find(job => job.status === 'blocked');
    if (blocked) this.block(blocked, blocked.reason);
    const queued = jobs.find(job => job.status === 'queued' && job.kind !== 'session-output');
    if (queued) {
      if (queued.kind !== 'text') await this.processJob(queued, signal);
      else {
        const meta = this.deliveryMeta = await this.ensureInputTarget(queued, signal);
        this.ingressPaused = Boolean(!meta.loaded || meta.closing || meta.cancelling || meta.loading || meta.compacting);
        if (this.draining) return;
        if (!this.ingressPaused) {
          if (!this.store.get('historyCheckpoint')) {
            if (!quiescent(meta)) { this.ingressPaused = true; return; }
            await this.establishCheckpoint(signal);
          }
          try {
            const verified = await this.readWindow(this.store.get('historyCheckpoint'), signal);
            this.store.set('historyCheckpoint', verified.checkpoint);
          } catch (error) {
            if (retryableRead(errorCode(error))) throw error;
            this.block(queued, errorCode(error));
          }
        }
        const following = await this.followup.step(queued, meta, signal);
        if (!following && !this.ingressPaused) {
          if (!await this.prepareInput(queued, signal)) return;
          await submitInputs(this, [queued], queued.prompt, signal, undefined, queued.promptParts);
        }
        if (!meta.loaded) return;
      }
      if (this.draining) return;
    }
    // One ingress and one egress step per tick: continuous native enqueue cannot
    // starve an already complete reply, and slow multi-part output cannot stop ingress.
    if (this.draining) return;
    const context = jobs.findLast(job => job.kind === 'text' && job.peer === this.config.weixin.allowedPeer);
    if (!context) {
      const notice = this.store.jobs().find(job => job.status === 'replying');
      if (notice) await this.processJob(notice, signal);
      return;
    }
    const meta = this.deliveryMeta = await this.cockpit.meta(signal);
    if (this.draining) return;
    if (meta.status === 'error' || meta.error) {
      const id = `session-error:${createHash('sha256')
        .update(JSON.stringify([meta.error, meta.lastActivity])).digest('hex')}`;
      if (!this.store.job(id)) this.queueOutput(id,
        `Cockpit 报告运行错误，请在网页查看：${sessionLink(this.config)}`, context, null, null);
    }
    const choice = ['ask', 'planRequest', 'elicitation'].find(key => meta[key]);
    if (choice) {
      const id = `session-choice:${this.config.cockpit.sessionId}:${choice}:${meta[choice].requestId}`;
      if (!this.store.job(id)) this.queueOutput(id,
        `Cockpit 需要你选择，请在网页处理：${sessionLink(this.config)}`, context, null, null);
    }
    // This HTTP API projects persisted SDK events, not live SSE deltas. Nonempty
    // root assistant bodies are complete messages, even while later work is running.
    const { checkpoint, messages, position, hasMore } = await this.readWindow(this.store.get('historyCheckpoint'), signal);
    this.deliveryMeta = await this.cockpit.meta(signal);
    this.store.transaction(() => {
      for (const job of this.store.jobs().filter(item => item.status === 'accepted' && item.kind === 'text')) {
        const own = messages.filter(message => message.role === 'user' && message.content === (job.promptVisible ?? job.prompt));
        requireThat(own.length <= 1, 'DUPLICATE_PROMPT_MARKER');
        if (own.length === 1) {
          // Receipt of the input in native history, not completion of the model's work.
          job.userMessageId = own[0].id; job.status = 'done'; this.store.save(job);
        } else if (!hasMore && quiescent(meta) && Date.now() - job.startedAt > this.config.limits.resultTimeoutMs) {
          job.status = 'blocked'; job.reason = 'PROMPT_NOT_OBSERVED';
          this.store.save(job);
        }
      }
    });
    let nextCheckpoint = checkpoint;
    let consumed = true;
    this.deliveryMore ||= hasMore;
    for (const message of messages) {
      if (message.role === 'system' && message.level === 'error' && meta.status !== 'error' && !meta.error) {
        const id = `session-error:${this.config.cockpit.sessionId}:${message.id}`;
        if (!this.store.job(id)) this.queueOutput(id,
          `Cockpit 报告运行错误，请在网页查看：${sessionLink(this.config)}`, context, null, null);
      }
      if (visible(message)) {
        const id = `session-output:${this.config.cockpit.sessionId}:${message.id}`;
        const existing = this.store.job(id);
        if (!existing) {
          const runId = replyRunId(this.config, this.store, messages, message.id, checkpoint);
          this.queueOutput(id, message.content, context, message, nextCheckpoint, runId);
          this.deliveryMore = true;
          consumed = false;
          break;
        }
        this.checkOutput(existing, message, existing.status === 'replying' ? 'FINAL_EVIDENCE_CHANGED' : 'DELIVERED_OUTPUT_CHANGED');
        if (existing.status === 'replying') { this.deliveryMore = true; consumed = false; break; }
        requireThat(['done', 'abandoned'].includes(existing.status), 'UNRESOLVED_OUTPUT_STATE');
      }
      if (anchor(message)) nextCheckpoint = {
        ...deliveryCheckpoint(message),
        ...(nextCheckpoint.position ? { position: nextCheckpoint.position } : {}),
        ...(message.role === 'user' ? { userMessageId: message.id }
          : nextCheckpoint.userMessageId ? { userMessageId: nextCheckpoint.userMessageId } : {}),
      };
    }
    if (consumed && position) nextCheckpoint = { ...nextCheckpoint, position };
    this.store.set('historyCheckpoint', nextCheckpoint);
    const pending = this.store.jobs().find(job => job.status === 'replying');
    if (pending) await this.processJob(pending, signal);
  }

  queueOutput(id, content, context, message, checkpoint, runId) {
    const job = {
      id, marker: `view-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`,
      kind: message ? 'session-output' : 'session-notice', peer: context.peer, contextToken: context.contextToken,
      original: content, status: 'replying', receivedAt: Date.now(),
      outboxPurpose: message ? 'final' : 'notice', outbox: createOutbox(content, this.config, message?.attachment, message),
      ...(runId ? { runId } : {}),
      ...(message ? { outputVersion: 3, outputMessageId: message.id, outputFingerprint: deliveryCheckpoint(message).fingerprint,
        outputBaseline: checkpoint } : {}),
    };
    this.store.ingest([job], null, this.config.limits.maxQueued + 1);
  }
}
