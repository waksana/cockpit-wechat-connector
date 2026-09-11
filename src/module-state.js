import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { BridgeError, object, requireThat } from './common.js';
import { privateDirectory, readPrivate, RunLock, secureExisting } from './storage.js';

export const controlFile = config => path.join(config.lockDir, 'module-binding.json');
export const gateDir = config => path.join(config.lockDir, 'module-control');

export function readControl(config) {
  const state = readPrivate(controlFile(config));
  if (!state) return null;
  requireThat(state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.history) && object(state.operations)
    && (state.active === null || object(state.active)), 'MODULE_STATE_INVALID');
  requireThat(state.configPath === config.configPath && state.configDigest === config.configDigest,
    'MODULE_CONFIG_CHANGED');
  requireThat(object(state.configBackup)
    && createHash('sha256').update(JSON.stringify(state.configBackup)).digest('hex') === state.configDigest,
  'MODULE_STATE_INVALID');
  for (const [id, operation] of Object.entries(state.operations)) {
    requireThat(/^[A-Za-z0-9_-]{8,120}$/.test(id) && object(operation)
      && ['pending', 'complete'].includes(operation.phase)
      && object(operation.request) && operation.request.operationId === id
      && ['bind', 'unbind', 'session-unbind'].includes(operation.request.operation)
      && typeof operation.request.sessionId === 'string'
      && (operation.request.operation === 'session-unbind' ? operation.request.cwd === undefined
        : typeof operation.request.cwd === 'string'),
    'MODULE_STATE_INVALID');
    if (operation.phase === 'complete') {
      const result = operation.result;
      requireThat(object(result) && typeof result.ok === 'boolean' && result.operationId === id
        && (result.ok ? result.error === undefined : object(result.error)
          && Object.keys(result.error).length === 1 && /^[A-Z][A-Z0-9_]{0,100}$/.test(result.error.code)),
      'MODULE_STATE_INVALID');
      if (operation.request.operation === 'session-unbind') {
        requireThat(result.sessionId === operation.request.sessionId
          && (result.ok ? result.unbound === true : result.unbound === undefined)
          && Object.keys(result).every(key => ['ok', 'operationId', 'sessionId', 'unbound', 'error'].includes(key)),
        'MODULE_STATE_INVALID');
      } else {
        requireThat(Number.isSafeInteger(result.revision) && result.revision >= 0 && result.revision <= state.revision
          && (result.boundSessionId === null || typeof result.boundSessionId === 'string')
          && Object.keys(result).every(key => ['ok', 'operationId', 'revision', 'boundSessionId', 'error'].includes(key)),
        'MODULE_STATE_INVALID');
      }
    }
  }
  for (const binding of [...state.history, ...(state.active ? [state.active] : [])]) {
    requireThat(typeof binding.id === 'string' && /^[a-f0-9-]{36}$/.test(binding.id)
      && typeof binding.sessionId === 'string' && typeof binding.cwd === 'string'
      && binding.stateDir === path.join(config.moduleStateRoot, binding.id), 'MODULE_STATE_INVALID');
    requireThat(fs.existsSync(binding.stateDir), 'MODULE_BINDING_STATE_MISSING');
    secureExisting(binding.stateDir, true);
  }
  return state;
}

export function routeConfig(config) {
  if (!config.moduleManaged) return config;
  const state = readControl(config);
  return {
    ...config, moduleRevision: state?.revision ?? 0,
    ...(state?.active ? {
      stateDir: state.active.stateDir,
      cockpit: { ...config.cockpit, sessionId: state.active.sessionId, cwd: state.active.cwd },
    } : {}),
  };
}

// A short gate serializes runner startup, stop/unlock and routing changes.
// The runner retains the separate stable RunLock for its entire lifetime.
export function acquireModuleGate(config, { unlockStale = false } = {}) {
  privateDirectory(config.lockDir);
  const dir = gateDir(config);
  privateDirectory(dir);
  if (unlockStale && fs.existsSync(path.join(dir, 'run.lock'))) RunLock.unlock(dir);
  try { return new RunLock(dir); }
  catch (error) {
    if (error.code === 'LOCKED') throw new BridgeError('MODULE_CONTROL_BUSY');
    throw error;
  }
}

export function assertCurrentConfig(config) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8')); }
  catch { throw new BridgeError('CONFIG_READ_FAILED'); }
  requireThat(createHash('sha256').update(JSON.stringify(raw)).digest('hex') === config.configDigest,
    'MODULE_CONFIG_CHANGED');
  requireThat((readControl(config)?.revision ?? 0) === config.moduleRevision, 'MODULE_CONFIG_STALE');
}

export function runnerState(config) {
  const lock = readPrivate(path.join(config.lockDir, 'run.lock'));
  if (!lock) return { running: false, runnerUnknown: false };
  requireThat(Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.nonce === 'string', 'INVALID_LOCK');
  try {
    process.kill(lock.pid, 0);
    return { running: true, runnerUnknown: false };
  } catch {
    // PID reuse and stale locks are never resolved by the adapter.
    return { running: false, runnerUnknown: true };
  }
}

export function inspectBinding(dir) {
  const empty = { binding: null, pendingJobs: 0, unknownJobs: 0, pendingBatch: false,
    nativeFollowup: false, typingMayBeActive: false, inboxHistory: false };
  if (!fs.existsSync(dir)) return empty;
  secureExisting(dir, true);
  const file = path.join(dir, 'bridge.sqlite');
  let result = empty;
  if (fs.existsSync(file)) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (fs.existsSync(file + suffix)) secureExisting(file + suffix);
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; BEGIN;');
      const get = key => {
        const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : null;
      };
      const jobs = db.prepare('SELECT data FROM jobs').all().map(row => JSON.parse(row.data));
      const unknown = job => job.status === 'prompting' || /UNKNOWN|RECOVERY_REQUIRED/.test(job.reason ?? '')
        || job.outbox?.some(part => ['sending', 'unknown'].includes(part.status));
      result = { binding: get('binding'), pendingJobs: jobs.filter(job =>
        !['done', 'abandoned', 'rejected'].includes(job.status)).length,
      unknownJobs: jobs.filter(unknown).length, pendingBatch: Boolean(get('pendingBatch')),
      nativeFollowup: Boolean(get('nativeFollowup')),
      typingMayBeActive: Boolean(get('statusDisplay')?.typingMayBeActive),
      inboxHistory: Boolean(get('cursor')) || jobs.length > 0 };
    } finally { db.close(); }
  }
  const images = path.join(dir, 'image-deliveries');
  if (fs.existsSync(images)) {
    secureExisting(images, true);
    for (const name of fs.readdirSync(images)) {
      const attempt = readPrivate(path.join(images, name));
      if (attempt?.status !== 'accepted') result.unknownJobs++;
    }
  }
  return result;
}

export function blocker(inspection) {
  if (inspection.unknownJobs) return 'UNKNOWN_OUTCOMES';
  if (inspection.nativeFollowup) return 'NATIVE_FOLLOWUP_UNRESOLVED';
  if (inspection.pendingBatch) return 'PENDING_INBOX_BATCH';
  if (inspection.pendingJobs) return 'PENDING_JOBS';
  if (inspection.typingMayBeActive) return 'TYPING_STATE_UNRESOLVED';
  return null;
}
