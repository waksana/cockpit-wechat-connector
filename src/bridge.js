import { createHash, randomUUID } from 'node:crypto';
import { assertBinding } from './config.js';
import { correlate, quiescent, historyCheckpoint } from './cockpit.js';
import { BridgeError, errorCode, requireThat, retryableRead, sessionLink, sleep } from './common.js';
import { normalizeBatch } from './weixin.js';
import { replyParts } from './reply.js';
import { cleanMediaScratch, preparePublishedMedia, saveInboundMedia, uploadPreparedMedia } from './media.js';
import { inputParts, inputPrompt, recordDelivery, retainedQuoteAttachments } from './quote.js';

const terminal = new Set(['done', 'abandoned', 'rejected']);
const mediaPart = part => part.kind === 'image' || part.kind === 'media';
const attachmentMetadata = ({ kind, name, url, size, mime }) => ({ kind, name, url, size, mime });
const replyCandidate = (message, version = 3) => JSON.stringify([message.id, message.content,
  ...(version === 3 && (message.attachment || message.attachments || message.parts)
    ? [message.attachment ?? null, message.attachments ?? null, message.parts ?? null] : [])]);

export function createOutbox(content, config, attachment, message) {
  return replyParts(content, config, attachment, message).map(part => ({
    ...part, clientId: `wxc-${randomUUID()}`, status: 'pending',
  }));
}

export class Bridge {
  constructor(config, credentials, store, weixin, cockpit, { log = console.log } = {}) {
    this.config = config; this.credentials = credentials; this.store = store;
    this.weixin = weixin; this.cockpit = cockpit; this.log = log;
  }
  bind() {
    assertBinding(this.config, this.credentials);
    const binding = {
      account: this.config.weixin.allowedAccount, peer: this.config.weixin.allowedPeer,
      ...this.config.cockpit,
    };
    const previous = this.store.get('binding');
    requireThat(!previous || JSON.stringify(previous) === JSON.stringify(binding), 'PERSISTED_BINDING_CHANGED');
    this.store.set('binding', binding);
  }
  async establishCheckpoint(signal, explicit = false) {
    if (this.store.get('historyCheckpoint') && !explicit) return;
    requireThat(quiescent(await this.cockpit.meta(signal)), 'TARGET_NOT_QUIESCENT');
    const first = historyCheckpoint((await this.cockpit.page(undefined, signal)).messages.at(-1));
    requireThat(quiescent(await this.cockpit.meta(signal)), 'TARGET_NOT_QUIESCENT');
    const second = historyCheckpoint((await this.cockpit.page(undefined, signal)).messages.at(-1));
    requireThat(JSON.stringify(first) === JSON.stringify(second), 'HISTORY_CHANGED_DURING_BIND');
    this.store.set('historyCheckpoint', second);
  }
  async evidence(job, signal) {
    const messages = await this.cockpit.since(job.baseline, signal);
    const meta = await this.cockpit.meta(signal);
    const result = correlate(job, messages, meta);
    requireThat(result.userMessageId, 'PROMPT_MARKER_DISAPPEARED');
    if (job.outboxPurpose === 'final') {
      requireThat(!result.failure && !result.choice && result.reply
        && replyCandidate(result.reply, job.candidateVersion ?? 2) === job.candidate, 'FINAL_EVIDENCE_CHANGED');
    }
    return messages;
  }
  block(job, reason) {
    job.status = 'blocked'; job.reason = reason;
    this.store.save(job);
    throw new BridgeError(reason);
  }
  needsEvidence(job) { return Boolean(job.prompt); }
  async observeStatus() {}
  async observeEvents() {}
  wakeWork() {}
  prepareIngress() {}
  async waitForWork(signal) { await sleep(this.config.limits.statusIntervalMs, signal); }
  outbox(job, content, purpose, message) {
    job.outbox = createOutbox(content, this.config, message?.attachment, message);
    job.outboxPurpose = purpose; job.status = 'replying';
    this.store.save(job);
  }
  async receive(signal, timeoutMs = 35000) {
    let result = this.store.get('pendingBatch');
    const freshPoll = !result;
    if (!result) {
      result = await this.weixin.poll(this.store.get('cursor') ?? '', signal, timeoutMs);
      // Keep a validated response privately until normalization and inbox commit succeed.
      this.store.set('pendingBatch', result);
    }
    const jobs = normalizeBatch(result.msgs, this.config);
    this.prepareIngress(jobs, freshPoll);
    const inserted = this.store.ingest(jobs, result.get_updates_buf, this.config.limits.maxQueued, true);
    if (inserted) { this.log(`INBOX_RECEIVED ${inserted}`); this.wakeWork(); }
    return result.longpolling_timeout_ms ?? timeoutMs;
  }
  async step(signal) {
    if (this.draining) return;
    const job = this.store.jobs().find(item => !terminal.has(item.status));
    if (!job) return;
    return this.processJob(job, signal);
  }
  async prepareInput(job, signal) {
    if (this.draining) return false;
    requireThat((job.media?.length ?? 0) <= 20, 'INBOUND_MEDIA_COUNT_EXCEEDED');
    if (job.media?.length) job.mediaFingerprint ??= createHash('sha256').update(JSON.stringify(job.media)).digest('hex');
    for (const entry of job.media ?? []) {
      if (this.draining) return false;
      if (!job.retainedMedia?.[entry.index]) {
        let attachment;
        try { attachment = await saveInboundMedia(this.config, this.weixin, this.cockpit, job, entry, signal); }
        catch (error) {
          if (!retryableRead(errorCode(error))) this.block(job, errorCode(error));
          throw error;
        }
        job.retainedMedia ??= {};
        job.retainedMedia[entry.index] = attachment;
      }
      entry.type ??= entry.item?.type;
      delete entry.item;
      // Storage completion is independent of prompt acceptance. Only this upload identity can be retried.
      // Keep the immutable digest for duplicate checks, not permanent CDN keys/URLs.
      this.store.save(job);
    }
    job.attachments = [...Object.values(job.retainedMedia ?? {}), ...retainedQuoteAttachments(job, this.store, this.config)]
      .filter((attachment, index, all) => all.findIndex(item => item.url === attachment.url) === index)
      .map(attachmentMetadata);
    job.prompt = inputPrompt(job, this.store, this.config);
    if (job.attachments.length) {
      job.promptParts = inputParts(job, this.store, this.config).map(part => part.type === 'text' ? part : {
        type: 'file', attachment: attachmentMetadata(part.attachment),
      });
      requireThat(job.promptParts.length <= 100
        && job.promptParts.filter(part => part.type === 'file').length <= 20, 'INBOUND_MEDIA_COUNT_EXCEEDED');
      job.promptVisible = job.promptParts.filter(part => part.type === 'text').map(part => part.text).join('').trim();
    } else job.promptVisible = job.prompt;
    this.store.save(job);
    return !this.draining;
  }
  async processJob(job, signal) {
    if (this.draining) return;
    if (job.status === 'blocked') throw new BridgeError(job.reason ?? 'JOB_BLOCKED');
    if (job.status === 'queued') {
      if (job.kind === 'unsupported') {
        this.outbox(job, '此消息含不支持的项目（例如语音）；未向模型转发，也未下载。支持文本、JPEG/PNG 图片、MP4/MOV 视频和普通文件。', 'unsupported');
        return;
      }
      const first = await this.cockpit.meta(signal);
      if (first.status === 'error' || first.error) this.block(job, 'TARGET_ERROR');
      if (!quiescent(first)) {
        if (Date.now() - job.receivedAt > this.config.limits.resultTimeoutMs) this.block(job, 'TARGET_NOT_QUIESCENT');
        return;
      }
      await this.establishCheckpoint(signal);
      const checkpoint = this.store.get('historyCheckpoint');
      try {
        requireThat((await this.cockpit.since(checkpoint.id, signal, checkpoint.fingerprint)).length === 0,
          'EXTERNAL_ACTIVITY_BETWEEN_JOBS');
      } catch (error) {
        if (retryableRead(errorCode(error))) throw error;
        this.block(job, errorCode(error));
      }
      const second = await this.cockpit.meta(signal);
      if (!quiescent(second)) return;
      job.baseline = checkpoint.id;
      if (!await this.prepareInput(job, signal)) return;
      if (this.draining) return;
      job.status = 'prompting'; job.startedAt = Date.now();
      this.store.save(job);
      try { await this.cockpit.prompt(job.prompt, signal, job.attachments, job.promptParts); }
      catch (error) {
        job.lastError = errorCode(error);
        this.block(job, 'PROMPT_OUTCOME_UNKNOWN');
      }
      job.status = 'accepted'; this.store.save(job);
      this.log(`PROMPT_ACCEPTED ${job.marker}`);
      return;
    }
    if (job.status === 'accepted') {
      const meta = await this.cockpit.meta(signal);
      const messages = await this.cockpit.since(job.baseline, signal);
      let result;
      try { result = correlate(job, messages, meta); }
      catch (error) { this.block(job, errorCode(error)); }
      if (result.userMessageId) job.userMessageId = result.userMessageId;
      this.store.save(job);
      if (result.failure) {
        this.outbox(job, `Cockpit 本轮报告错误，未将错误原文或工具日志转发。请查看：${sessionLink(this.config)}`, 'error');
        return;
      }
      if (result.choice) {
        if (!(job.notifiedChoices ?? []).includes(result.choice)) {
          job.notifiedChoices = [...(job.notifiedChoices ?? []), result.choice];
          this.outbox(job, `Cockpit 需要你选择，请在网页处理，本连接器不会猜测授权：${sessionLink(this.config)}`, 'choice');
          return;
        }
      } else if (result.reply) {
        const fingerprint = replyCandidate(result.reply);
        if (job.candidate === fingerprint) {
          job.replyMessageId = result.reply.id;
          this.outbox(job, result.reply.content, 'final', result.reply);
          return;
        }
        job.candidate = fingerprint;
        job.candidateVersion = 3;
        this.store.save(job);
      } else if (job.candidate) {
        delete job.candidate; this.store.save(job);
      }
      if (Date.now() - job.startedAt > this.config.limits.resultTimeoutMs) this.block(job, 'RESULT_NEEDS_CONFIRMATION');
      return;
    }
    if (job.status === 'replying') {
      const part = job.outbox.find(item => item.status !== 'accepted');
      if (!part) {
        let checkpoint;
        if (job.prompt && job.outboxPurpose !== 'choice') {
          try { checkpoint = historyCheckpoint((await this.evidence(job, signal)).at(-1)); }
          catch (error) {
            if (retryableRead(errorCode(error))) throw error;
            this.block(job, errorCode(error));
          }
        }
        job.status = job.outboxPurpose === 'choice' ? 'accepted' : 'done';
        delete job.outbox;
        this.store.transaction(() => {
          this.store.save(job);
          if (checkpoint) this.store.set('historyCheckpoint', checkpoint);
        });
        this.log(`REPLY_${job.status === 'done' ? 'DONE' : 'WAITING_WEB'} ${job.marker}`);
        return;
      }
      requireThat(part.status === 'pending', 'WEIXIN_OUTCOME_UNKNOWN');
      if (this.needsEvidence(job)) {
        try { await this.evidence(job, signal); }
        catch (error) {
          if (retryableRead(errorCode(error))) throw error;
          this.block(job, errorCode(error));
        }
      }
      if (this.draining) return;
      if (mediaPart(part) && !part.imageItem) {
        const prepared = await preparePublishedMedia(this.config, this.cockpit, part.uploadPath, signal);
        try {
          // A read may have taken time; recheck before any upload mutation.
          if (this.needsEvidence(job)) await this.evidence(job, signal);
          if (this.draining) return;
          part.nativeKind = prepared.nativeKind;
          part.attachment = prepared.attachment;
          part.status = 'sending'; this.store.save(job);
          part.imageItem = await uploadPreparedMedia(this.config, this.weixin, job.peer, prepared, stage => {
            part.imageStage = stage;
            this.store.save(job);
          }, signal);
          part.imageStage = 'uploaded';
          part.status = 'pending';
          this.store.save(job);
        } catch (error) {
          if (part.status === 'pending') throw error;
          part.status = 'unknown'; job.lastError = errorCode(error);
          this.block(job, 'WEIXIN_OUTCOME_UNKNOWN');
        } finally { await prepared.remove(); }
        return;
      }
      if (this.draining) return;
      part.status = 'sending';
      if (mediaPart(part)) part.imageStage = 'sending_image';
      this.store.save(job);
      try {
        let receipt;
        if (mediaPart(part)) {
          receipt = await this.weixin.sendItems(job.peer, job.contextToken, [part.imageItem], part.clientId, signal,
            { runId: job.runId });
        } else receipt = await this.weixin.send(job.peer, job.contextToken, part.value, part.clientId, signal,
          { runId: job.runId });
        recordDelivery(job, part, receipt);
      }
      catch (error) {
        part.status = 'unknown'; job.lastError = errorCode(error);
        this.block(job, 'WEIXIN_OUTCOME_UNKNOWN');
      }
      part.status = 'accepted'; this.store.save(job);
      return;
    }
    this.block(job, 'UNEXPECTED_JOB_STATE');
  }
  async run(signal, { once = false } = {}) {
    if (signal.aborted) return;
    this.bind();
    cleanMediaScratch(this.config);
    this.store.recover();
    const blocked = this.store.jobs().find(job => job.status === 'blocked');
    requireThat(!blocked, blocked?.reason ?? 'JOB_BLOCKED');
    const previousOnceId = once ? this.store.get('onceJobId') : null;
    if (previousOnceId) {
      const previous = this.store.job(previousOnceId);
      requireThat(previous, 'ONCE_JOB_MISSING');
      if (terminal.has(previous.status)) {
        this.log('ONCE_ALREADY_FINISHED');
        return;
      }
    }
    try {
      await this.cockpit.capabilities(signal);
      await this.cockpit.meta(signal);
      await this.establishCheckpoint(signal);
    } catch (error) {
      if (signal.aborted && (errorCode(error) === 'STOPPED' || error.name === 'AbortError')) return;
      throw error;
    }
    const controller = new AbortController();
    const linked = AbortSignal.any([signal, controller.signal]);
    // Stop cancels polling/waits, never the signal of an already-started mutation.
    // Each HTTP operation retains its own existing timeout and durable unknown fence.
    const operationSignal = new AbortController().signal;
    this.draining = false;
    const drain = () => {
      if (!this.draining) this.log('BRIDGE_DRAIN_REQUESTED');
      this.draining = true;
      controller.abort();
    };
    signal.addEventListener('abort', drain, { once: true });
    if (signal.aborted) drain();
    let failure;
    const guarded = async (action, readOnly = false) => {
      try { await action(); }
      catch (error) {
        const stoppedRead = readOnly && linked.aborted
          && (errorCode(error) === 'STOPPED' || error.name === 'AbortError' || error === linked.reason);
        if (!stoppedRead) failure ??= error;
        drain();
      }
    };
    try { await Promise.all([
      guarded(() => this.observeStatus(operationSignal, linked)),
      guarded(() => this.observeEvents(linked), true),
      guarded(async () => {
        let failures = 0;
        let timeout = 35000;
        while (!linked.aborted) {
          try { timeout = await this.receive(linked, timeout); failures = 0; }
          catch (error) {
            if (!retryableRead(errorCode(error)) || ++failures >= 5) throw error;
            this.log(`POLL_RETRY ${errorCode(error)} ${failures}/5`);
          }
          await sleep(failures ? Math.min(30000, 1000 * 2 ** (failures - 1)) : 100, linked);
        }
      }, true),
      guarded(async () => {
        let failures = 0;
        while (!linked.aborted) {
          try {
            if (once && !this.store.get('onceJobId')) {
              const selected = this.store.jobs().find(job => !terminal.has(job.status));
              if (selected) this.store.set('onceJobId', selected.id);
            }
            await this.step(operationSignal);
            failures = 0;
            if (this.draining) return;
            if (once) {
              const selected = this.store.job(this.store.get('onceJobId') ?? '');
              if (selected && terminal.has(selected.status)) {
                this.log('ONCE_FINISHED');
                drain();
                return;
              }
            }
          }
          catch (error) {
            if (this.draining) throw error;
            if (!retryableRead(errorCode(error))) {
              const jobs = this.store.jobs();
              const job = jobs.find(item => item.status === 'blocked') ?? jobs.find(item => !terminal.has(item.status));
              if (job && job.status !== 'blocked') this.block(job, errorCode(error));
              throw error;
            }
            // Reads can resume after a service restart without replaying an accepted mutation.
            if (++failures >= 5) throw error;
            this.log(`READ_RETRY ${errorCode(error)} ${failures}/5`);
          }
          try {
            if (failures) await sleep(this.config.limits.statusIntervalMs, linked);
            else await this.waitForWork(linked);
          } catch (error) {
            if (!linked.aborted) throw error;
          }
        }
      }),
    ]); } finally { signal.removeEventListener('abort', drain); }
    if (failure) throw failure;
    this.log('BRIDGE_DRAINED');
  }
}

export function resolveJob(store, id, action) {
  const job = store.job(id);
  requireThat(job?.status === 'blocked', 'BLOCKED_JOB_REQUIRED');
  const round = store.get('nativeFollowup');
  if (action === 'retry-media') {
    requireThat(job.reason === 'MEDIA_SIZE_MISMATCH' && job.media?.length
      && !job.prompt && !job.submissionId && !job.userMessageId && !job.outbox
      && !job.followupEpoch && !round, 'MEDIA_RETRY_NOT_APPLICABLE');
    job.status = 'queued';
    job.resolution = action;
    delete job.reason;
    store.save(job);
    return;
  }
  if (action === 'enqueue') {
    requireThat(round?.leaderId === id && round.phase === 'blocked' && !job.prompt,
      'INTERRUPT_RESOLUTION_NOT_APPLICABLE');
    // Operator must first confirm the previous native operation has settled.
    store.transaction(() => {
      for (const pending of store.jobs()) {
        if (pending.followupEpoch !== round.epoch || !['queued', 'blocked'].includes(pending.status)) continue;
        delete pending.followupEpoch; delete pending.reason;
        pending.status = 'queued'; pending.resolution = 'enqueue'; store.save(pending);
      }
      store.set('nativeFollowup', null);
    });
    return;
  }
  const batch = job.submissionId
    ? store.jobs().filter(item => item.submissionId === job.submissionId && item.status === 'blocked') : [job];
  store.transaction(() => {
    for (const item of batch) resolveOne(store, item, action);
    if (round?.leaderId === id && action === 'abandon') {
      for (const pending of store.jobs()) {
        if (pending.followupEpoch !== round.epoch || pending.status !== 'queued') continue;
        delete pending.followupEpoch; store.save(pending);
      }
      store.set('nativeFollowup', null);
    }
  });
}

function resolveOne(store, job, action) {
  if (action === 'abandon') {
    job.status = 'abandoned';
  } else if (action === 'observe') {
    requireThat(job.prompt, 'OBSERVE_NOT_APPLICABLE');
    if (job.outbox) {
      requireThat(retryableRead(job.reason) && job.outbox.every(part => ['pending', 'accepted'].includes(part.status)),
        'OBSERVE_NOT_APPLICABLE');
      job.status = 'replying';
    } else {
      requireThat(!['EXTERNAL_INPUT_DETECTED', 'EXTERNAL_ACTIVITY_DETECTED'].includes(job.reason), 'OBSERVE_NOT_APPLICABLE');
      job.status = 'accepted'; job.startedAt = Date.now(); delete job.candidate;
    }
  } else if (action === 'sent') {
    const part = job.outbox?.find(item => item.status === 'unknown');
    requireThat(part && job.reason === 'WEIXIN_OUTCOME_UNKNOWN', 'UNKNOWN_REPLY_REQUIRED');
    requireThat(!mediaPart(part) || part.imageStage === 'sending_image', 'IMAGE_NOT_SENT');
    part.status = 'accepted'; job.status = 'replying';
  } else throw new BridgeError('UNKNOWN_RESOLUTION');
  job.resolution = action;
  delete job.reason;
  store.save(job);
}
