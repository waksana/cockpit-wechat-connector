import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BridgeError, object, requireThat } from './common.js';
import { privateDirectory, readPrivate, RunLock, secureExisting, writePrivate } from './storage.js';

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
      && binding.stateDir === path.join(config.moduleStateRoot, binding.id)
      && (binding.retiredReason === undefined || binding.retiredReason === 'TARGET_SESSION_MISSING'),
    'MODULE_STATE_INVALID');
    requireThat(fs.existsSync(binding.stateDir), 'MODULE_BINDING_STATE_MISSING');
    secureExisting(binding.stateDir, true);
  }
  requireThat(!state.active?.retiredReason, 'MODULE_STATE_INVALID');
  return state;
}

export function routeConfig(config, state = config.moduleManaged ? readControl(config) : null) {
  if (!config.moduleManaged) return config;
  return {
    ...config, moduleRevision: state?.revision ?? 0, moduleBindingId: state?.active?.id ?? null,
    stateDir: state?.active?.stateDir ?? config.moduleStateRoot,
    cockpit: { ...config.cockpit, sessionId: state?.active?.sessionId ?? '', cwd: state?.active?.cwd ?? '' },
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

function assertConfigAuthority(config) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(config.configPath, 'utf8')); }
  catch { throw new BridgeError('CONFIG_READ_FAILED'); }
  requireThat(createHash('sha256').update(JSON.stringify(raw)).digest('hex') === config.configDigest,
    'MODULE_CONFIG_CHANGED');
}

function currentBinding(config, state) {
  return (state?.revision ?? 0) === config.moduleRevision
    && (state?.active?.id ?? null) === config.moduleBindingId
    && (state?.active?.sessionId ?? '') === config.cockpit.sessionId
    && (state?.active?.cwd ?? '') === config.cockpit.cwd
    && (state?.active?.stateDir ?? config.moduleStateRoot) === config.stateDir;
}

export function assertCurrentConfig(config) {
  assertConfigAuthority(config);
  requireThat(currentBinding(config, readControl(config)), 'MODULE_CONFIG_STALE');
}

export function assertActiveBinding(config) {
  if (!config.moduleManaged) return;
  assertConfigAuthority(config);
  const state = readControl(config);
  if (!currentBinding(config, state)) {
    const missing = state?.history.some(binding => binding.id === config.moduleBindingId
      && binding.sessionId === config.cockpit.sessionId && binding.cwd === config.cockpit.cwd
      && binding.retiredReason === 'TARGET_SESSION_MISSING');
    throw new BridgeError(missing ? 'TARGET_SESSION_MISSING' : 'MODULE_CONFIG_STALE');
  }
  requireThat(state?.active, 'MODULE_NOT_BOUND');
}

// Only the caller that read authoritative absence for this exact route may retire it.
export function retireMissingBinding(config) {
  if (!config.moduleManaged || !config.moduleBindingId) return { cleared: false };
  const gate = acquireModuleGate(config);
  try {
    assertConfigAuthority(config);
    const state = readControl(config);
    if (!currentBinding(config, state) || !state?.active) return { cleared: false };
    state.history.push({ ...state.active, retiredReason: 'TARGET_SESSION_MISSING' });
    state.active = null;
    state.revision++;
    try { writePrivate(controlFile(config), state); }
    catch { throw new BridgeError('BINDING_CLEANUP_OUTCOME_UNKNOWN'); }
    try {
      if (readPrivate(path.join(config.lockDir, 'run.lock'))) RunLock.requestStop(config.lockDir, { requireDrain: true });
    } catch (error) {
      if (error.code !== 'NOT_RUNNING') return { cleared: true,
        cleanupCode: error instanceof BridgeError ? error.code : 'BINDING_DRAIN_OUTCOME_UNKNOWN' };
    }
    return { cleared: true };
  } finally { gate.release(); }
}

export function runnerState(config, { snapshot = false } = {}) {
  let lock;
  try { lock = readPrivate(path.join(config.lockDir, 'run.lock')); }
  catch (error) {
    if (snapshot && error.code === 'ENOENT') return { running: false, runnerUnknown: false };
    if (snapshot && error.code === 'INVALID_PRIVATE_FILE'
      && fs.existsSync(path.join(gateDir(config), 'run.lock'))) {
      return { running: null, runnerUnknown: true };
    }
    throw error;
  }
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

function databaseIdentity(file) {
  return ['', '-wal', '-journal'].map(suffix => {
    try {
      const stat = fs.statSync(file + suffix, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }).join('|');
}

export function inspectBinding(dir, { snapshot = false } = {}) {
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
    const before = snapshot ? databaseIdentity(file) : null;
    if (snapshot) {
      for (const suffix of ['-wal', '-journal']) {
        if (fs.existsSync(file + suffix)) {
          requireThat(fs.statSync(file + suffix).size === 0, 'STATE_SNAPSHOT_UNAVAILABLE');
        }
      }
    }
    const source = pathToFileURL(file);
    // Immutable reads never create WAL/SHM, but ignore WAL. Only use them when
    // all data is in the main file, and reject any change during the read.
    if (snapshot) source.searchParams.set('immutable', '1');
    const db = new DatabaseSync(snapshot ? source.href : file, { readOnly: true });
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
    } finally {
      db.close();
      if (snapshot) requireThat(databaseIdentity(file) === before, 'STATE_SNAPSHOT_UNAVAILABLE');
    }
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
