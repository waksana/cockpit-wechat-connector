import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { AskRequest, ModuleBackendContext, NativeChatEvent, NativeObservation } from '@waksana/cockpit-module-sdk/backend';
import { type Config } from './config.js';
import { sessionMeta } from './binding.js';
import { type Binding, type Input, type Output, invariant, Store, uncertain } from './state.js';
import { WechatTransport, type InboundMessage, type Item } from './transport.js';
import { downloadInbound, uploadOutbound, verifySnapshot } from './media.js';
import { captureReferences, hasLocalReferences } from './references.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function split(text: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 3500) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  invariant(chunks.length <= 100, 'REPLY_TOO_LARGE');
  return chunks;
}
function primary(event: NativeChatEvent): boolean {
  return !event.ephemeral && !event.agentId && !event.parentToolCallId && !event.data.agentId && !event.data.parentToolCallId;
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{0,100}$/u.test(message) ? message : 'SERVICE_OPERATION_FAILED';
}
function rejectedAnswer(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'REQUEST_NOT_PENDING';
}

export class Service {
  private loops: Promise<void>[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private tail: Promise<void> = Promise.resolve();
  private readonly polling = new AbortController();
  private stopped = false;
  constructor(readonly context: ModuleBackendContext, readonly config: Config, readonly store: Store,
    readonly transport: WechatTransport) {}

  private accepting(): void {
    invariant(!this.stopped && !this.context.stopping.aborted && !this.context.signal.aborted, 'SERVICE_STOPPING');
  }
  private current(binding: Binding): void {
    const current = this.store.read().binding;
    invariant(current?.generation === binding.generation && current.sessionId === binding.sessionId, 'BINDING_CHANGED');
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  private serial(action: () => Promise<void>): Promise<void> {
    const work = this.tail.then(action);
    this.tail = work.catch(error => { if (!this.shutdownCancellation(error)) this.fail(error); });
    return this.track(work);
  }
  private shutdownCancellation(error: unknown): boolean {
    return (this.stopped || this.context.stopping.aborted) && (error === this.context.stopping.reason
      || error === this.polling.signal.reason || (error instanceof Error
        && (error.name === 'AbortError' || error.message === 'SERVICE_STOPPING')));
  }
  private fail(error: unknown): void {
    const code = safeError(error);
    this.store.change(state => { state.fault = code; });
    this.context.report(new Error(code));
    this.context.invalidate();
  }
  async start(): Promise<void> {
    this.accepting();
    invariant(this.loops.length === 0, 'SERVICE_ALREADY_STARTED');
    this.loops = [this.run(() => this.serial(() => this.tick())), this.run(() => this.poll())];
  }
  private async run(action: () => Promise<void>): Promise<void> {
    while (!this.stopped && !this.context.stopping.aborted) {
      try { await action(); }
      catch (error) {
        if (!this.shutdownCancellation(error)) {
          if (this.context.stopping.aborted) throw error;
          this.fail(error);
        }
      }
      try { await delay(1000, undefined, { signal: this.context.stopping }); }
      catch (error) { if (!this.context.stopping.aborted) throw error; }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.polling.abort();
    await Promise.all(this.loops);
    await Promise.all([...this.pending]);
    await this.tail;
  }

  async poll(): Promise<void> {
    this.accepting();
    const before = this.store.read();
    const binding = before.binding;
    if (!binding || binding.anchor === undefined || uncertain(before)) return;
    const batch = await this.transport.poll(before.cursor, AbortSignal.any([this.context.stopping, this.polling.signal]));
    // A completed poll is persisted even during drain, but never submitted after stop.
    this.ingest(batch.messages, batch.cursor, binding);
  }
  ingest(messages: InboundMessage[], cursor: string, binding: Binding): void {
    this.store.change(state => {
      const retired = state.binding?.generation !== binding.generation || state.binding.sessionId !== binding.sessionId;
      for (const message of messages) {
        invariant(message.account === this.config.account && message.peer === this.config.peer, 'INBOUND_IDENTITY');
        const key = `${this.config.account}:${message.id}`;
        if (state.inputs.some(input => input.key === key)) continue;
        const prebinding = state.retired.length > 0 && (message.createdAt === undefined
          || binding.boundAt === undefined || message.createdAt < binding.boundAt);
        const question = state.questions.findLast(question => question.generation === binding.generation);
        const askId = question && ['presented', 'stale', 'unknown'].includes(question.stage) ? question.request.requestId : undefined;
        const early = question?.stage === 'pending' || (askId && message.createdAt !== undefined
          && message.createdAt < (question?.presentedAt ?? Infinity));
        state.inputs.push({ key, generation: binding.generation, message, stage: retired || prebinding ? 'unknown' : early ? 'rejected' : 'queued',
          ...(askId ? { askId } : {}), ...(retired ? { reason: 'RETIRED_BINDING_INBOUND_REQUIRES_DISPOSITION' }
            : prebinding ? { reason: 'PREBINDING_INPUT_REQUIRES_DISPOSITION' }
              : early ? { reason: 'QUESTION_NOT_YET_PRESENTED' } : {}) });
        if (early && !retired && !prebinding) this.appendOutput(state.outputs, binding, `notice:${key}`, 'notice',
          'This message predates the current question. Please send your answer again after reading it.');
        if (!prebinding && state.binding?.generation === binding.generation) state.binding.contextToken = message.contextToken;
      }
      state.cursor = cursor;
    });
  }
  private appendOutput(outputs: Output[], binding: Binding, key: string, kind: Output['kind'], text: string, ask?: AskRequest): void {
    if (outputs.some(output => output.key === key)) return;
    outputs.push({ key, generation: binding.generation, kind, text, stage: 'queued', files: [], ask,
      parts: split(text).map(text => ({ stage: 'queued', text, clientId: `wx-${randomUUID()}` })) });
  }
  private async history(binding: Binding): Promise<void> {
    let cursor: string | undefined;
    const events: NativeChatEvent[] = [];
    let found = binding.anchor === undefined;
    let latest: string | null = null;
    for (let pageNo = 0; pageNo < 40; pageNo++) {
      const page = await this.context.host.call('session/chat', {
        sessionId: binding.sessionId, source: 'persisted', direction: 'backward', cursor,
        max: binding.anchor === undefined ? 1 : 64, waitMs: 0, bootstrap: false, includeEphemeral: false,
      });
      this.current(binding);
      invariant(page.sessionId === binding.sessionId && page.source === 'persisted' && page.direction === 'backward'
        && page.cursorStatus === 'ok' && Array.isArray(page.events) && page.events.length <= 64
        && typeof page.cursor === 'string' && typeof page.hasMore === 'boolean', 'HISTORY_QUERY_UNKNOWN');
      if (pageNo === 0) latest = page.events.at(-1)?.id ?? null;
      if (binding.anchor === undefined) break;
      const index = binding.anchor === null ? -1 : page.events.findIndex(event => event.id === binding.anchor);
      events.unshift(...(index < 0 ? page.events : page.events.slice(index + 1)));
      if (index >= 0 || (!page.hasMore && binding.anchor === null)) { found = true; break; }
      if (!page.hasMore) break;
      invariant(page.cursor !== cursor, 'HISTORY_CURSOR_STUCK');
      cursor = page.cursor;
    }
    invariant(found, 'HISTORY_ANCHOR_MISSING');
    for (const event of events) await this.observe({ sessionId: binding.sessionId, cwd: binding.cwd ?? null, event }, false);
    this.current(binding);
    this.store.change(state => {
      if (state.binding?.generation === binding.generation) state.binding.anchor = latest;
    });
  }
  async observe(observation: NativeObservation, live = true): Promise<void> {
    const state = this.store.read();
    const binding = state.binding;
    if (!binding || observation.sessionId !== binding.sessionId || !primary(observation.event)) return;
    const { event } = observation;
    if (event.type === 'user.message') {
      // Event UUID is a history position, never a prompt acceptance receipt.
      const messageId = event.data.messageId;
      if (typeof messageId !== 'string') return;
      this.store.change(state => {
        if (state.binding?.generation === binding.generation) state.binding.userMessageId = messageId;
        for (const input of state.inputs) {
          if (input.generation === binding.generation && input.messageId === messageId) input.reason = 'NATIVE_MESSAGE_OBSERVED';
        }
      });
      return;
    }
    if (event.type !== 'assistant.message' || typeof event.data.content !== 'string' || !event.data.content.trim()) return;
    if (live && (this.stopped || this.context.stopping.aborted)) return;
    const key = `reply:${binding.generation}:${event.id}`;
    if (state.outputs.some(output => output.key === key)) return;
    const content = event.data.content;
    const quotedInput = state.inputs.find(input => input.generation === binding.generation && input.stage === 'accepted'
      && input.messageId === binding.userMessageId);
    invariant(content.length <= 250_000, 'REPLY_TOO_LARGE');
    // Reserve the output before async capture so duplicate event/history callbacks cannot recapture.
    this.store.change(state => state.outputs.push({
      key, generation: binding.generation, kind: 'reply', stage: 'intent', text: content, files: [], parts: [],
      quoteId: quotedInput?.message.id,
      reason: 'CAPTURING_LIVE_REPLY',
    }));
    const capture = async () => {
      try {
        invariant(live || !hasLocalReferences(content), 'HISTORICAL_FILE_SNAPSHOT_UNAVAILABLE');
        const captured = hasLocalReferences(content) ? await captureReferences(content, {
          cwd: observation.cwd ?? binding.cwd ?? '',
          allowedRoots: this.config.fileRoots,
          deniedRoots: [this.context.dataRoot, join(homedir(), '.ssh'), join(homedir(), '.copilot'), join(homedir(), '.cockpit')],
          directory: join(this.store.root, 'outgoing', hash(key)),
        }, this.context.signal) : { text: content, files: [] };
        this.current(binding);
        this.store.change(state => {
          const output = state.outputs.find(output => output.key === key)!;
          output.text = captured.text;
          output.files = captured.files;
          output.parts = [
            ...split(captured.text).map(text => ({ stage: 'queued' as const, text, clientId: `wx-${randomUUID()}` })),
            ...captured.files.map(file => ({ stage: 'queued' as const, file, clientId: `wx-${randomUUID()}` })),
          ];
          invariant(output.parts.length <= 100, 'REPLY_TOO_LARGE');
          output.stage = 'queued';
          delete output.reason;
        });
      } catch (error) {
        this.store.change(state => {
          const output = state.outputs.find(output => output.key === key)!;
          output.stage = 'unknown'; output.reason = safeError(error);
        });
        this.context.report(new Error(safeError(error)));
      }
    };
    await this.track(capture());
  }
  private async questions(binding: Binding, meta: NonNullable<Awaited<ReturnType<typeof sessionMeta>>>): Promise<void> {
    const ask = meta.ask;
    this.store.change(state => {
      for (const question of state.questions) {
        if (question.generation === binding.generation && ['presented', 'pending'].includes(question.stage)
          && question.request.requestId !== ask?.requestId) {
          question.stage = 'stale';
          const output = state.outputs.find(output => output.key === question.outputKey);
          if (output?.stage === 'queued') output.stage = 'abandoned';
        }
      }
      if (ask && !state.questions.some(question => question.generation === binding.generation && question.request.requestId === ask.requestId)) {
        const key = `ask:${binding.generation}:${ask.requestId}`;
        const text = `${ask.question}${ask.choices?.length ? '\n\n' + ask.choices.map((choice, i) => `${i + 1}. ${choice}`).join('\n') : ''}\n\nReply with the option text${ask.allowFreeform !== false ? ' or your own answer' : ''}.`;
        state.questions.push({ request: ask, generation: binding.generation, stage: 'pending', outputKey: key });
        this.appendOutput(state.outputs, binding, key, 'ask', text, ask);
      }
      for (const decision of [meta.planRequest, meta.elicitation]) {
        if (!decision) continue;
        this.appendOutput(state.outputs, binding, `decision:${binding.generation}:${decision.requestId}`, 'notice',
          `This session needs a Web decision:\n${this.config.webUrl}/session/${encodeURIComponent(binding.sessionId)}`);
      }
    });
  }
  tick(): Promise<void> { return this.track(this.tickWork()); }
  private async tickWork(): Promise<void> {
    this.accepting();
    const state = this.store.read();
    if (!state.binding || uncertain(state)) return;
    const binding = state.binding;
    const meta = await sessionMeta(this.context, binding.sessionId);
    this.current(binding);
    if (!meta) {
      this.store.change(state => {
        state.retired.push({ sessionId: binding.sessionId, generation: binding.generation, at: Date.now() });
        state.binding = null; state.generation++;
      });
      return;
    }
    invariant(!binding.cwd || binding.cwd === meta.cwd, 'SESSION_CWD_CHANGED');
    this.store.change(state => { if (state.binding) state.binding.cwd = meta.cwd; });
    binding.cwd = meta.cwd;
    await this.history(binding);
    this.accepting();
    if (uncertain(this.store.read())) return;
    if (meta.loaded) await this.questions(binding, meta);
    const input = this.store.read().inputs.find(input => input.generation === binding.generation && input.stage === 'queued');
    if (input) await this.submit(binding, input);
    if (uncertain(this.store.read())) return;
    await this.sendOutputs(binding);
  }
  private inputState(key: string, action: (input: Input) => void): void {
    this.store.change(state => action(state.inputs.find(input => input.key === key)!));
  }
  private async submit(binding: Binding, input: Input): Promise<void> {
    this.accepting();
    this.current(binding);
    let meta = await sessionMeta(this.context, binding.sessionId);
    invariant(meta, 'TARGET_SESSION_MISSING');
    if (!meta.loaded) {
      this.accepting();
      this.inputState(input.key, value => { value.stage = 'intent'; value.operation = 'load'; });
      try {
        const result = await this.context.host.call('session/load', { sessionId: binding.sessionId });
        invariant(result.ok === true && result.sessionId === binding.sessionId, 'LOAD_OUTCOME_UNKNOWN');
        this.inputState(input.key, value => { value.stage = 'queued'; delete value.operation; });
      } catch (error) {
        this.inputState(input.key, value => { value.stage = 'unknown'; value.reason = safeError(error); });
        return;
      }
      meta = await sessionMeta(this.context, binding.sessionId);
      invariant(meta?.loaded, 'LOAD_NOT_CONFIRMED');
    }
    this.current(binding);
    this.accepting();
    if (input.askId || meta.ask) {
      const question = this.store.read().questions.find(question => question.generation === binding.generation
        && question.request.requestId === input.askId);
      const choices = meta.ask?.choices ?? [];
      const choice = choices.find(choice => choice === input.message.text);
      const valid = question?.stage === 'presented' && meta.ask?.requestId === input.askId
        && input.message.items.every(item => item.type === 1) && input.message.text.trim()
        && (choice !== undefined || meta.ask?.allowFreeform !== false);
      if (!valid) {
        this.inputState(input.key, value => { value.stage = 'rejected'; value.reason = 'ANSWER_NOT_CURRENT_OR_NOT_ALLOWED'; });
        this.store.change(state => {
          if (question?.stage === 'stale') {
            const stale = state.questions.find(value => value.generation === binding.generation
              && value.request.requestId === question.request.requestId);
            if (stale) stale.stage = 'answered';
          }
          this.appendOutput(state.outputs, binding, `rejected:${input.key}`, 'notice',
            'This text was not submitted: the question changed, was already answered, or does not allow that answer. Read the current question and reply again.');
        });
        return;
      }
      this.inputState(input.key, value => { value.stage = 'intent'; value.operation = 'answer'; });
      try {
        const result = await this.context.host.call('respondAsk', { sessionId: binding.sessionId, requestId: input.askId!,
          answer: choice ?? input.message.text, wasFreeform: choice === undefined });
        invariant(result.ok === true, 'ANSWER_OUTCOME_UNKNOWN');
        this.store.change(state => {
          state.inputs.find(value => value.key === input.key)!.stage = 'accepted';
          state.questions.find(value => value.generation === binding.generation
            && value.request.requestId === question.request.requestId)!.stage = 'answered';
        });
      } catch (error) {
        if (rejectedAnswer(error)) {
          this.inputState(input.key, value => { value.stage = 'rejected'; value.reason = 'REQUEST_NOT_PENDING'; });
          this.store.change(state => {
            this.appendOutput(state.outputs, binding, `stale:${input.key}`, 'notice',
              'This question was already answered or is no longer pending. Your text was not sent as a new prompt.');
          });
        } else this.inputState(input.key, value => { value.stage = 'unknown'; value.reason = safeError(error); });
      }
      return;
    }
    const attachments = input.attachments ?? [];
    const retained = input.media ?? [];
    if (!input.attachments) {
      for (const [index, item] of input.message.items.entries()) {
        if (![2, 4, 5].includes(item.type)) continue;
        this.accepting();
        const file = await downloadInbound(this.transport, item, join(this.store.root, 'incoming', hash(input.key), String(index)), this.context.signal);
        retained.push(file);
        attachments.push({ type: 'file', path: file.path, displayName: file.name });
      }
      this.inputState(input.key, value => { value.attachments = attachments; value.media = retained; });
    }
    for (const snapshot of retained) await verifySnapshot(snapshot, this.context.signal);
    const quote = this.quote(input, binding);
    for (const item of input.message.items) {
      const id = item.ref_msg?.svr_id;
      if (!id) continue;
      const state = this.store.read();
      const candidates = state.inputs.filter(other => other.generation === binding.generation
        && other.message.account === input.message.account && other.message.peer === input.message.peer && other.message.id === id);
      const outgoing = state.outputs.filter(output => output.generation === binding.generation)
        .flatMap(output => output.parts.filter(part => part.stage === 'accepted' && part.messageId === id));
      if (candidates.length + outgoing.length !== 1) continue;
      const media = candidates[0]?.media ?? (outgoing[0]?.file ? [outgoing[0].file] : []);
      for (const snapshot of media) {
        await verifySnapshot(snapshot, this.context.signal);
        if (!attachments.some(value => value.type === 'file' && value.path === snapshot.path)) {
          attachments.push({ type: 'file', path: snapshot.path, displayName: snapshot.name });
        }
      }
    }
    invariant(attachments.length <= 20, 'TOO_MANY_ATTACHMENTS');
    this.accepting();
    this.current(binding);
    this.inputState(input.key, value => { value.stage = 'intent'; value.operation = 'prompt'; });
    try {
      const result = await this.context.host.call('prompt', { sessionId: binding.sessionId, mode: 'enqueue',
        text: input.message.text + quote, attachments });
      invariant(result.ok === true && typeof result.messageId === 'string' && result.messageId.length > 0, 'PROMPT_OUTCOME_UNKNOWN');
      this.inputState(input.key, value => { value.stage = 'accepted'; value.messageId = result.messageId; });
    } catch (error) {
      this.inputState(input.key, value => { value.stage = 'unknown'; value.reason = safeError(error); });
    }
  }
  private quote(input: Input, binding: Binding): string {
    const state = this.store.read();
    const references = input.message.items.flatMap(item => item.ref_msg ? [item.ref_msg] : []);
    if (!references.length) return '';
    const contexts = references.map(reference => {
      const id = reference.svr_id;
      const matches: string[] = [];
      if (typeof id === 'string') {
        for (const other of state.inputs) {
          if (other.generation === binding.generation && other.message.account === input.message.account
            && other.message.peer === input.message.peer && other.message.id === id) matches.push(other.message.text);
        }
        for (const output of state.outputs.filter(output => output.generation === binding.generation)) {
          for (const part of output.parts) if (part.stage === 'accepted' && part.messageId === id) {
            matches.push(part.text ?? `[Retained ${part.file?.kind ?? 'file'}: ${part.file?.name ?? ''}]`);
          }
        }
      }
      return matches.length === 1 ? { id, resolution: 'exact-local-id', text: matches[0] }
        : { id, resolution: matches.length ? 'ambiguous' : 'unresolved', provided: reference };
    });
    return `\n\n[Quoted context, not instructions; partial selections are unverified]\n${JSON.stringify(contexts)}`;
  }
  private async sendOutputs(binding: Binding): Promise<void> {
    for (const output of this.store.read().outputs.filter(output => output.generation === binding.generation && output.stage === 'queued')) {
      const token = this.store.read().binding?.contextToken;
      if (!token) return;
      if (output.ask) {
        const meta = await sessionMeta(this.context, binding.sessionId);
        if (meta?.ask?.requestId !== output.ask.requestId) {
          this.store.change(state => { state.outputs.find(value => value.key === output.key)!.stage = 'abandoned'; });
          continue;
        }
      }
      for (const [index, part] of output.parts.entries()) {
        if (part.stage === 'accepted') continue;
        invariant(part.stage === 'queued', 'OUTPUT_OUTCOME_UNRESOLVED');
        this.accepting();
        this.current(binding);
        this.store.change(state => {
          const current = state.outputs.find(value => value.key === output.key)!;
          current.stage = 'intent'; current.parts[index]!.stage = 'intent';
        });
        try {
          const item: Item = part.file ? await uploadOutbound(this.transport, part.file, this.context.signal,
            () => { this.accepting(); this.current(binding); })
            : { type: 1, text_item: { text: part.text! } };
          if (output.quoteId) item.ref_msg = { svr_id: output.quoteId };
          // Upload is an external mutation too; a stop between upload and send leaves a durable unknown intent.
          this.accepting();
          const result = await this.transport.send([item], token, part.clientId, this.context.signal);
          this.store.change(state => {
            const current = state.outputs.find(value => value.key === output.key)!;
            current.parts[index]!.stage = 'accepted';
            current.parts[index]!.messageId = result.messageId;
            current.stage = current.parts.every(part => part.stage === 'accepted') ? 'accepted' : 'queued';
            if (current.stage === 'accepted' && current.ask) {
              const question = state.questions.find(question => question.outputKey === output.key)!;
              question.stage = 'presented'; question.presentedAt = Date.now();
            }
          });
        } catch (error) {
          this.store.change(state => {
            const current = state.outputs.find(value => value.key === output.key)!;
            current.stage = 'unknown'; current.parts[index]!.stage = 'unknown'; current.reason = safeError(error);
          });
          this.context.report(new Error(safeError(error)));
          return;
        }
      }
    }
  }
}
