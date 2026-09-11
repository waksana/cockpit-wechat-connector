#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, assertBinding } from './config.js';
import { CockpitClient, cockpitToken } from './cockpit.js';
import { BridgeError, object, requireThat } from './common.js';
import { privateDirectory, readPrivate, secureExisting, writePrivate } from './storage.js';
import { acquireModuleGate, assertCurrentConfig, blocker, controlFile, gateDir, inspectBinding,
  readControl, routeConfig, runnerState } from './module-state.js';

const MAX_BYTES = 16384;
const sessionValid = sessionId => typeof sessionId === 'string'
  && /^[A-Za-z0-9_-]{1,200}(?![\s\S])/.test(sessionId);
const targetValid = (sessionId, cwd) => sessionValid(sessionId) && typeof cwd === 'string'
  && cwd.length <= 4096 && path.isAbsolute(cwd) && !/[\0\r\n]/.test(cwd);
const codeOf = error => error instanceof BridgeError && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.code)
  ? error.code : 'MODULE_CONTROL_FAILED';

function readiness(config) {
  const credentials = readPrivate(config.credentialFile);
  try {
    assertBinding({ ...config, cockpit: { ...config.cockpit, sessionId: 'validation', cwd: '/' } }, credentials);
    cockpitToken(config);
    return { credentialsPresent: Boolean(credentials), configReady: true };
  } catch (error) {
    return { credentialsPresent: Boolean(credentials), configReady: false, configReason: codeOf(error) };
  }
}

export function moduleStatus(config) {
  if (!config.moduleManaged) return statusDetails(config, null, runnerState(config, { snapshot: true }));
  const gateBusy = () => fs.existsSync(path.join(gateDir(config), 'run.lock'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = readControl(config);
    const routed = routeConfig(config, state);
    if (gateBusy()) return partialStatus(routed, state, { running: null, runnerUnknown: true });
    const runner = runnerState(routed, { snapshot: true });
    let status;
    if (runner.running || runner.runnerUnknown) {
      status = partialStatus(routed, state, runner);
    } else {
      try { status = statusDetails(routed, state, runner); }
      catch (error) {
        if (error instanceof BridgeError && error.code === 'STATE_SNAPSHOT_UNAVAILABLE') {
          status = partialStatus(routed, state, runner, error.code);
        } else {
          if (error.code === 'ENOENT') continue;
          const transient = error.code === 'ERR_SQLITE_ERROR'
            && ([5, 6].includes(error.errcode) || /^no such table: (kv|jobs)$/.test(error.message));
          if (!transient || (!gateBusy() && !runnerState(routed, { snapshot: true }).running)) throw error;
          continue;
        }
      }
    }
    if (!gateBusy() && JSON.stringify(state) === JSON.stringify(readControl(config))) return status;
  }
  const state = readControl(config);
  return partialStatus(routeConfig(config, state), state, { running: null, runnerUnknown: true });
}

function partialStatus(config, state, runner, reason) {
  const unknownOperation = Boolean(state && Object.values(state.operations).some(op => op.phase === 'pending'));
  return { available: false,
    reason: unknownOperation ? 'OPERATION_OUTCOME_UNKNOWN' : reason ?? (runner.running ? 'RUNNING'
      : runner.running === false && runner.runnerUnknown ? 'RUNNER_STATE_UNKNOWN' : 'MODULE_CONTROL_BUSY'),
    boundSessionId: state?.active?.sessionId ?? null, ...readiness(config), ...runner,
    unknownOperation, pendingJobs: null, unknownJobs: null, revision: state?.revision ?? 0,
    managed: true, detailsAvailable: false };
}

function statusDetails(config, state, runner) {
  const managed = Boolean(config.moduleManaged);
  const inspection = inspectBinding(config.stateDir, { snapshot: managed });
  const ready = readiness(config);
  const boundSessionId = state?.active?.sessionId || inspection.binding?.sessionId
    || config.cockpit.sessionId || null;
  const bindingChanged = inspection.binding && (inspection.binding.sessionId !== config.cockpit.sessionId
    || inspection.binding.cwd !== config.cockpit.cwd);
  const unknownOperation = Boolean(state && Object.values(state.operations).some(op => op.phase === 'pending'));
  const historyReview = !state?.active && Boolean(state?.history.some(binding =>
    inspectBinding(binding.stateDir, { snapshot: true }).inboxHistory));
  const legacyData = managed && !state && (inspection.binding || inspection.inboxHistory
    || (fs.existsSync(config.moduleStateRoot) && fs.readdirSync(config.moduleStateRoot).length > 0));
  const reason = unknownOperation ? 'OPERATION_OUTCOME_UNKNOWN'
    : runner.runnerUnknown ? 'RUNNER_STATE_UNKNOWN' : runner.running ? 'RUNNING'
      : (bindingChanged ? 'PERSISTED_BINDING_CHANGED' : null) || blocker(inspection)
        || (legacyData ? 'LEGACY_ADOPTION_REQUIRED' : null)
        || (boundSessionId ? 'ALREADY_BOUND' : null)
        || (!managed ? 'MODULE_MANAGED_OPT_IN_REQUIRED' : null)
        || (!ready.configReady ? 'NOT_CONFIGURED' : null)
        || (historyReview ? 'REBIND_HISTORY_REVIEW_REQUIRED' : null);
  return { available: reason === null, reason, boundSessionId, ...ready, ...runner,
    unknownOperation, pendingJobs: inspection.pendingJobs, unknownJobs: inspection.unknownJobs,
    revision: state?.revision ?? 0, managed };
}

function validateRequest(request) {
  requireThat(object(request) && ['status', 'bind', 'unbind', 'session-unbind'].includes(request.operation), 'INVALID_REQUEST');
  const allowed = request.operation === 'status' ? ['operation']
    : request.operation === 'session-unbind' ? ['operation', 'operationId', 'sessionId']
      : ['operation', 'operationId', 'sessionId', 'cwd'];
  requireThat(Object.keys(request).every(key => allowed.includes(key)), 'INVALID_REQUEST');
  if (request.operation !== 'status') {
    requireThat(typeof request.operationId === 'string' && /^[A-Za-z0-9_-]{8,120}(?![\s\S])/.test(request.operationId)
      && !['__proto__', 'prototype', 'constructor'].includes(request.operationId),
      'OPERATION_ID_REQUIRED');
    requireThat(request.operation === 'session-unbind' ? sessionValid(request.sessionId)
      : targetValid(request.sessionId, request.cwd), 'INVALID_TARGET');
  }
}

function validateArchiveBinding(state, sessionId, cwd) {
  requireThat(state.active, 'NOT_BOUND');
  requireThat(state.active.sessionId === sessionId && state.active.cwd === cwd, 'BINDING_MISMATCH');
  const inspection = inspectBinding(state.active.stateDir);
  requireThat(!inspection.binding || (inspection.binding.sessionId === sessionId
    && inspection.binding.cwd === cwd), 'PERSISTED_BINDING_CHANGED');
  requireThat(!blocker(inspection), blocker(inspection));
}

function archiveBinding(state) {
  state.history.push(state.active);
  state.active = null;
}

function assertStopped(config) {
  const runner = runnerState(config);
  requireThat(!runner.running, 'RUNNING');
  requireThat(!runner.runnerUnknown, 'RUNNER_STATE_UNKNOWN');
}

export async function control(configPath, request, { fetchImpl } = {}) {
  validateRequest(request);
  requireThat(typeof configPath === 'string' && path.isAbsolute(configPath), 'ABSOLUTE_CONFIG_REQUIRED');
  const config = loadConfig(configPath);
  if (!config.moduleManaged) {
    requireThat(request.operation === 'status', 'LEGACY_ADOPTION_REQUIRED');
    return { ok: true, status: moduleStatus(config) };
  }
  secureExisting(configPath);
  if (request.operation === 'status') return { ok: true, status: moduleStatus(config) };
  const gate = acquireModuleGate(config);
  try {
    assertCurrentConfig(config);
    const sessionUnbind = request.operation === 'session-unbind';
    const identity = { operation: request.operation, operationId: request.operationId,
      sessionId: request.sessionId, ...(sessionUnbind ? {} : { cwd: request.cwd }) };
    let state = readControl(config);
    const previous = state?.operations[request.operationId];
    if (previous) {
      requireThat(JSON.stringify(previous.request) === JSON.stringify(identity), 'OPERATION_ID_CONFLICT');
      if (previous.phase === 'pending') throw new BridgeError('OPERATION_OUTCOME_UNKNOWN');
      return { ...previous.result, replayed: true };
    }
    requireThat(!state || !Object.values(state.operations).some(op => op.phase === 'pending'),
      'OPERATION_OUTCOME_UNKNOWN');
    requireThat(Object.keys(state?.operations ?? {}).length < 10000, 'OPERATION_LOG_FULL');
    // A receipt for an unrelated/absent target must not inspect or interrupt a newer runner.
    if (!sessionUnbind || !state) assertStopped(config);
    const initial = !sessionUnbind || !state ? inspectBinding(config.stateDir) : null;
    if (!state) {
      requireThat(!initial.binding && !initial.inboxHistory && !blocker(initial), 'LEGACY_ADOPTION_REQUIRED');
      // An existing nonempty root may contain unrecognized historical data. Never adopt it.
      requireThat(!fs.existsSync(config.moduleStateRoot)
        || fs.readdirSync(config.moduleStateRoot).length === 0, 'LEGACY_ADOPTION_REQUIRED');
      state = { schemaVersion: 1, revision: 0, configPath: config.configPath, configDigest: config.configDigest,
        configBackup: JSON.parse(fs.readFileSync(config.configPath, 'utf8')), active: null, history: [], operations: {} };
    }
    if (sessionUnbind && state.active?.sessionId === request.sessionId) {
      assertStopped(config);
      validateArchiveBinding(state, request.sessionId, state.active.cwd);
    }
    state.operations[request.operationId] = { phase: 'pending', request: identity };
    try { writePrivate(controlFile(config), state); }
    catch { throw new BridgeError('OPERATION_OUTCOME_UNKNOWN'); }
    let result;
    try {
      if (sessionUnbind) {
        if (state.active?.sessionId === request.sessionId) {
          archiveBinding(state);
          state.revision++;
        }
        result = { ok: true, operationId: request.operationId, sessionId: request.sessionId, unbound: true };
      } else if (request.operation === 'bind') {
        requireThat(!state.active, 'ALREADY_BOUND');
        const ready = readiness(config);
        requireThat(ready.configReady, ready.configReason ?? 'NOT_CONFIGURED');
        for (const old of state.history) {
          const inspection = inspectBinding(old.stateDir);
          requireThat(!blocker(inspection), blocker(inspection));
          requireThat(!inspection.inboxHistory, 'REBIND_HISTORY_REVIEW_REQUIRED');
        }
        const targetConfig = { ...config, cockpit: { ...config.cockpit,
          sessionId: request.sessionId, cwd: request.cwd } };
        await new CockpitClient(targetConfig, { fetchImpl }).meta();
        // Re-read after the network wait; external reference edits must not install stale routing.
        assertCurrentConfig(config);
        privateDirectory(config.moduleStateRoot);
        const id = randomUUID();
        const stateDir = path.join(config.moduleStateRoot, id);
        fs.mkdirSync(stateDir, { mode: 0o700 });
        for (const dir of [config.moduleStateRoot, path.dirname(config.moduleStateRoot)]) {
          const fd = fs.openSync(dir, 'r');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        state.active = { id, stateDir, sessionId: request.sessionId, cwd: request.cwd };
      } else {
        validateArchiveBinding(state, request.sessionId, request.cwd);
        archiveBinding(state);
      }
      if (!sessionUnbind) {
        state.revision++;
        result = { ok: true, operationId: request.operationId, revision: state.revision,
          boundSessionId: state.active?.sessionId ?? null };
      }
    } catch (error) {
      result = { ok: false, operationId: request.operationId, error: { code: codeOf(error) }, ...(sessionUnbind
        ? { sessionId: request.sessionId }
        : { boundSessionId: state.active?.sessionId ?? null, revision: state.revision }) };
    }
    state.operations[request.operationId] = { phase: 'complete', request: identity, result };
    try { writePrivate(controlFile(config), state); }
    catch { throw new BridgeError('OPERATION_OUTCOME_UNKNOWN'); }
    return { ...result, replayed: false };
  } finally { gate.release(); }
}

async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  requireThat(args.length === 2 && args[0] === '--config' && path.isAbsolute(args[1]), 'ABSOLUTE_CONFIG_REQUIRED');
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new BridgeError('REQUEST_TIMEOUT')), 5000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      requireThat(bytes <= MAX_BYTES, 'REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('INVALID_REQUEST'); }
  return control(args[1], request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => ({ ok: false, error: { code: codeOf(error) } })).then(result => {
    const output = JSON.stringify(result);
    process.stdout.write(`${output.length <= MAX_BYTES ? output
      : '{"ok":false,"error":{"code":"RESPONSE_TOO_LARGE"}}'}\n`);
    if (!result.ok || output.length > MAX_BYTES) process.exitCode = 2;
  });
}
