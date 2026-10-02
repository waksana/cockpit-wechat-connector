import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AskRequest, NativeAttachment } from '@waksana/cockpit-module-sdk/backend';
import type { InboundMessage } from './transport.js';
import type { Snapshot } from './media.js';

export function invariant(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

export function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && stat.uid === process.getuid?.() && realpathSync(directory) === resolve(directory), 'PRIVATE_DIRECTORY_REQUIRED');
}

export type Stage = 'queued' | 'intent' | 'accepted' | 'unknown' | 'abandoned' | 'rejected';
export interface Binding {
  sessionId: string;
  generation: number;
  anchor?: string | null;
  contextToken?: string;
  cwd?: string;
  userMessageId?: string;
  boundAt?: number;
}
export interface Input {
  key: string;
  generation: number;
  message: InboundMessage;
  stage: Stage;
  operation?: 'load' | 'prompt' | 'answer';
  askId?: string;
  messageId?: string;
  attachments?: NativeAttachment[];
  media?: Snapshot[];
  reason?: string;
}
export interface Output {
  key: string;
  generation: number;
  kind: 'reply' | 'ask' | 'notice';
  stage: Stage;
  text: string;
  files: Snapshot[];
  parts: { stage: Stage; clientId: string; text?: string; file?: Snapshot; messageId?: string }[];
  ask?: AskRequest;
  quoteId?: string;
  reason?: string;
}
export interface Question {
  request: AskRequest;
  generation: number;
  outputKey: string;
  stage: 'pending' | 'presented' | 'answered' | 'stale' | 'unknown';
  presentedAt?: number;
}
export interface State {
  schema: 1;
  revision: number;
  identity: string;
  generation: number;
  binding: Binding | null;
  retired: { sessionId: string; generation: number; at: number }[];
  notifications: string[];
  cursor: string;
  inputs: Input[];
  outputs: Output[];
  questions: Question[];
  resolutions: { key: string; note: string; at: number }[];
  fault?: string;
}
const stages = ['queued', 'intent', 'accepted', 'unknown', 'abandoned', 'rejected'];
function validate(value: State): void {
  invariant(value?.schema === 1 && Number.isSafeInteger(value.revision) && Number.isSafeInteger(value.generation)
    && value.revision >= 0 && value.generation >= 0 && typeof value.identity === 'string'
    && typeof value.cursor === 'string' && value.cursor.length <= 1_000_000, 'STATE_SCHEMA_UNSUPPORTED');
  invariant(value.binding === null || (typeof value.binding?.sessionId === 'string'
    && value.binding.sessionId.length > 0 && value.binding.generation === value.generation
    && (value.binding.anchor === undefined || value.binding.anchor === null || typeof value.binding.anchor === 'string')), 'STATE_BINDING_INVALID');
  for (const list of [value.inputs, value.outputs, value.questions, value.retired, value.notifications, value.resolutions]) {
    invariant(Array.isArray(list) && list.length <= 10_000, 'STATE_LIMIT_OR_SCHEMA');
  }
  invariant(value.retired.every(binding => typeof binding.sessionId === 'string' && binding.sessionId.length > 0
    && Number.isSafeInteger(binding.generation) && binding.generation >= 0 && binding.generation < value.generation
    && Number.isFinite(binding.at)), 'STATE_RETIREMENT_INVALID');
  invariant(value.inputs.every(input => typeof input.key === 'string' && stages.includes(input.stage)
    && Number.isSafeInteger(input.generation) && typeof input.message?.id === 'string'), 'STATE_INPUT_INVALID');
  invariant(value.outputs.every(output => typeof output.key === 'string' && stages.includes(output.stage)
    && typeof output.text === 'string' && Array.isArray(output.files) && Array.isArray(output.parts)
    && output.parts.every(part => stages.includes(part.stage) && typeof part.clientId === 'string')), 'STATE_OUTPUT_INVALID');
  invariant(value.questions.every(question => typeof question.request?.requestId === 'string'
    && typeof question.request.question === 'string' && typeof question.outputKey === 'string'
    && Number.isSafeInteger(question.generation)
    && ['pending', 'presented', 'answered', 'stale', 'unknown'].includes(question.stage)), 'STATE_QUESTION_INVALID');
  invariant(value.notifications.every(notification => typeof notification === 'string' && notification.length > 0)
    && new Set(value.notifications).size === value.notifications.length, 'STATE_NOTIFICATION_INVALID');
}

/** One private database, unrelated to the old CLI schema, profiles, or WAL files. */
export class Store {
  private readonly db: DatabaseSync;
  private state: State;
  constructor(readonly root: string, identity: string | undefined) {
    privateDirectory(root);
    const file = join(root, 'native-v1.sqlite');
    const existing = existsSync(file);
    invariant(existing || identity !== undefined, 'STATE_IDENTITY_REQUIRED');
    if (!existing) {
      const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      fsyncSync(fd);
      closeSync(fd);
    }
    const stat = lstatSync(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0
      && stat.uid === process.getuid?.(), 'PRIVATE_DATABASE_REQUIRED');
    this.db = new DatabaseSync(file);
    const version = this.db.prepare('PRAGMA user_version').get();
    if ((existing && version?.user_version !== 1) || (!existing && version?.user_version !== 0)) {
      this.db.close();
      throw new Error('STATE_SCHEMA_UNSUPPORTED');
    }
    if (!existing) this.db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); PRAGMA user_version=1;');
    const row = this.db.prepare('SELECT json FROM state WHERE id=1').get();
    if (existing && !row) { this.db.close(); throw new Error('STATE_INITIALIZATION_INCOMPLETE'); }
    this.state = row ? JSON.parse(String(row.json)) : {
      schema: 1, revision: 0, identity: identity!, generation: 0, binding: null, retired: [],
      notifications: [], cursor: '', inputs: [], outputs: [], questions: [], resolutions: [],
    };
    try {
      validate(this.state);
      invariant(identity === undefined || this.state.identity === identity, 'ACCOUNT_CONFIGURATION_CHANGED');
    } catch (error) { this.db.close(); throw error; }
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
    this.change(state => {
      for (const input of state.inputs) if (input.stage === 'intent') input.stage = 'unknown';
      for (const output of state.outputs) {
        for (const part of output.parts) if (part.stage === 'intent') part.stage = 'unknown';
        if (output.stage === 'intent') output.stage = 'unknown';
      }
    });
    const fd = openSync(root, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  read(): State { return structuredClone(this.state); }
  change(action: (state: State) => void): void {
    const next = structuredClone(this.state);
    action(next);
    archiveRetired(next);
    if (JSON.stringify(next) === JSON.stringify(this.state) && next.revision > 0) return;
    next.revision++;
    validate(next);
    const json = JSON.stringify(next);
    invariant(Buffer.byteLength(json) <= 32 * 1024 * 1024, 'STATE_FULL');
    this.db.prepare('INSERT INTO state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(json);
    this.state = next;
  }
  close(): void { this.db.close(); }
}

export function retireBinding(state: State, binding: Binding): void {
  if (state.binding?.generation !== binding.generation || state.binding.sessionId !== binding.sessionId) return;
  state.retired.push({ sessionId: binding.sessionId, generation: binding.generation, at: Date.now() });
  state.binding = null;
  state.generation++;
}

function archiveRetired(state: State): void {
  const retired = new Set(state.retired.map(binding => binding.generation));
  for (const record of [...state.inputs, ...state.outputs]) {
    if (retired.has(record.generation) && record.stage === 'queued') {
      record.stage = 'abandoned';
      record.reason = 'RETIRED_BINDING_NOT_SCHEDULED';
    }
  }
  for (const output of state.outputs) {
    if (retired.has(output.generation)) {
      for (const part of output.parts) if (part.stage === 'queued') part.stage = 'abandoned';
    }
  }
  for (const question of state.questions) {
    if (retired.has(question.generation) && ['pending', 'presented'].includes(question.stage)) question.stage = 'stale';
  }
}

export function retiredWorkInFlight(state: State): boolean {
  const retired = new Set(state.retired.map(binding => binding.generation));
  return state.inputs.some(input => retired.has(input.generation) && input.stage === 'intent')
    || state.outputs.some(output => retired.has(output.generation)
      && (output.stage === 'intent' || output.parts.some(part => part.stage === 'intent')));
}
export function unresolved(state: State): boolean {
  const retired = new Set(state.retired.map(binding => binding.generation));
  return !!state.fault || state.inputs.some(input => !retired.has(input.generation) && ['queued', 'intent', 'unknown'].includes(input.stage))
    || state.outputs.some(output => !retired.has(output.generation) && ['queued', 'intent', 'unknown'].includes(output.stage));
}
export function uncertain(state: State): boolean {
  const retired = new Set(state.retired.map(binding => binding.generation));
  return !!state.fault || retiredWorkInFlight(state)
    || state.inputs.some(input => !retired.has(input.generation) && ['intent', 'unknown'].includes(input.stage))
    || state.outputs.some(output => !retired.has(output.generation) && ['intent', 'unknown'].includes(output.stage));
}
