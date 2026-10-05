import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AskRequest } from '@waksana/cockpit-module-sdk/backend';
import type { Snapshot } from './media.js';
import type { ApiFailure } from './transport.js';

export function invariant(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
export function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
    && stat.uid === process.getuid?.() && realpathSync(directory) === resolve(directory), 'PRIVATE_DIRECTORY_REQUIRED');
}
export interface Binding {
  sessionId: string;
  generation: number;
  anchor?: string | null;
  contextToken?: string;
  cwd?: string;
  userMessageId?: string;
  boundAt?: number;
}
export interface Receipt {
  key: string;
  generation: number;
  direction: 'input' | 'output';
  status: 'unknown' | 'accepted' | 'failed' | 'skipped';
  reason?: string;
  apiFailure?: ApiFailure;
  text: string;
  messageId?: string;
  nativeMessageId?: string;
  media: Snapshot[];
  sent?: { messageId?: string; text?: string; file?: Snapshot }[];
}
export interface State {
  schema: 1;
  adapter: 2;
  revision: number;
  identity: string;
  generation: number;
  binding: Binding | null;
  notifications: string[];
  cursor: string;
  receipts: Receipt[];
  question?: { generation: number; request: AskRequest; presentedAt: number; answered: boolean };
  lastError?: string;
  lastApiFailure?: ApiFailure;
  legacy?: unknown;
}
function validate(value: State): void {
  invariant(value?.schema === 1 && value.adapter === 2 && Number.isSafeInteger(value.revision)
    && value.revision >= 0 && Number.isSafeInteger(value.generation) && value.generation >= 0
    && typeof value.identity === 'string' && typeof value.cursor === 'string'
    && value.cursor.length <= 1_000_000, 'STATE_SCHEMA_UNSUPPORTED');
  invariant(value.binding === null || (typeof value.binding?.sessionId === 'string' && value.binding.sessionId.length > 0
    && value.binding.generation === value.generation
    && (value.binding.anchor === undefined || value.binding.anchor === null || typeof value.binding.anchor === 'string')), 'STATE_BINDING_INVALID');
  invariant(Array.isArray(value.receipts) && value.receipts.length <= 20_000 && value.receipts.every(receipt =>
    typeof receipt.key === 'string' && Number.isSafeInteger(receipt.generation) && typeof receipt.text === 'string'
    && ['input', 'output'].includes(receipt.direction) && ['unknown', 'accepted', 'failed', 'skipped'].includes(receipt.status)
    && Array.isArray(receipt.media) && (receipt.sent === undefined || Array.isArray(receipt.sent))), 'STATE_RECEIPT_INVALID');
  invariant(Array.isArray(value.notifications) && value.notifications.length <= 10_000
    && value.notifications.every(id => typeof id === 'string'), 'STATE_NOTIFICATION_INVALID');
}

interface LegacyState {
  schema: 1; adapter?: undefined; revision: number; identity: string; generation: number;
  binding: Binding | null; notifications: string[]; cursor: string;
  inputs: { key: string; generation: number; stage: string; reason?: string; messageId?: string;
    message: { id: string; text: string }; media?: Snapshot[] }[];
  outputs: { key: string; generation: number; stage: string; reason?: string; text: string;
    parts: { stage: string; messageId?: string; text?: string; file?: Snapshot }[] }[];
  questions?: { generation: number; stage: string; outputKey: string; request: AskRequest; presentedAt?: number }[];
}
function convert(value: State | LegacyState): State {
  if (value.adapter === 2) return value;
  invariant(value.schema === 1 && value.adapter === undefined && Array.isArray(value.inputs)
    && Array.isArray(value.outputs), 'STATE_SCHEMA_UNSUPPORTED');
  const status = (stage: string): Receipt['status'] => stage === 'accepted' ? 'accepted'
    : ['queued', 'abandoned', 'rejected'].includes(stage) ? 'skipped' : 'unknown';
  const question = value.questions?.findLast(question => question.generation === value.binding?.generation
    && question.stage === 'presented' && question.presentedAt !== undefined
    && value.outputs.some(output => output.key === question.outputKey && output.stage === 'accepted'));
  return {
    schema: 1, adapter: 2, revision: value.revision, identity: value.identity, generation: value.generation,
    binding: value.binding, notifications: value.notifications, cursor: value.cursor,
    receipts: [
      ...value.inputs.map(input => ({ key: input.key, generation: input.generation, direction: 'input' as const,
        status: status(input.stage), reason: input.reason ?? 'LEGACY_RECORD_NOT_REPLAYED',
        text: input.message.text ?? '', messageId: input.message.id, nativeMessageId: input.messageId, media: input.media ?? [] })),
      ...value.outputs.map(output => ({ key: output.key, generation: output.generation, direction: 'output' as const,
        status: status(output.stage), reason: output.reason ?? 'LEGACY_RECORD_NOT_REPLAYED', text: output.text, media: [],
        sent: output.parts.filter(part => part.stage === 'accepted')
          .map(part => ({ messageId: part.messageId, text: part.text, file: part.file })) })),
    ],
    // Kept verbatim for audit only. No runtime path reads or schedules these old records.
    legacy: structuredClone(value),
    ...(question ? { question: { generation: question.generation, request: question.request,
      presentedAt: question.presentedAt!, answered: false } } : {}),
  };
}

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
      fsyncSync(fd); closeSync(fd);
    }
    const stat = lstatSync(file);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0
      && stat.uid === process.getuid?.(), 'PRIVATE_DATABASE_REQUIRED');
    this.db = new DatabaseSync(file);
    const version = this.db.prepare('PRAGMA user_version').get();
    if ((existing && version?.user_version !== 1) || (!existing && version?.user_version !== 0)) {
      this.db.close(); throw new Error('STATE_SCHEMA_UNSUPPORTED');
    }
    if (!existing) this.db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); PRAGMA user_version=1;');
    const row = this.db.prepare('SELECT json FROM state WHERE id=1').get();
    if (existing && !row) { this.db.close(); throw new Error('STATE_INITIALIZATION_INCOMPLETE'); }
    const original: State | LegacyState = row ? JSON.parse(String(row.json)) : {
      schema: 1, adapter: 2, revision: 0, identity: identity!, generation: 0, binding: null,
      notifications: [], cursor: '', receipts: [],
    };
    try {
      this.state = convert(original);
      validate(this.state);
      invariant(identity === undefined || this.state.identity === identity, 'ACCOUNT_CONFIGURATION_CHANGED');
    } catch (error) { this.db.close(); throw error; }
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
    try {
      if (!row || original.adapter !== 2) {
        this.state.revision++;
        this.persist(this.state);
      }
    } catch (error) { this.db.close(); throw error; }
    const fd = openSync(root, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  read(): State { return structuredClone(this.state); }
  private persist(state: State): void {
    const json = JSON.stringify(state);
    invariant(Buffer.byteLength(json) <= 64 * 1024 * 1024, 'STATE_FULL');
    this.db.prepare('INSERT INTO state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(json);
  }
  change(action: (state: State) => void): void {
    const next = structuredClone(this.state);
    action(next);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    next.revision++;
    validate(next);
    this.persist(next);
    this.state = next;
  }
  close(): void { this.db.close(); }
}

export function retireBinding(state: State, binding: Binding): void {
  if (state.binding?.generation !== binding.generation || state.binding.sessionId !== binding.sessionId) return;
  state.binding = null;
  state.generation++;
  delete state.question;
}
