#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CockpitClient } from './cockpit.js';
import { BridgeError, requireThat } from './common.js';
import { assertBinding, loadConfig } from './config.js';
import { blocker, acquireModuleGate, assertCurrentConfig, controlFile, inspectBinding,
  readControl, runnerState } from './module-state.js';
import { readPrivate, RunLock, secureExisting, writePrivate } from './storage.js';

const codeOf = error => error instanceof BridgeError && /^[A-Z][A-Z0-9_]{0,100}$/.test(error.code)
  ? error.code : 'MODULE_ADOPTION_FAILED';
const digest = raw => createHash('sha256').update(JSON.stringify(raw)).digest('hex');

function canonicalPrivate(file, directory = false) {
  requireThat(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file,
    'ADOPTION_SOURCE_INVALID');
  try {
    requireThat(fs.realpathSync(file) === file, 'ADOPTION_SOURCE_INVALID');
    secureExisting(file, directory);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('ADOPTION_SOURCE_INVALID');
  }
}

function operationId(value) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]{8,120}(?![\s\S])/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value), 'OPERATION_ID_REQUIRED');
  return value;
}

function effective(config) {
  return {
    deliveryMode: config.deliveryMode,
    nativeInterruptFollowup: config.nativeInterruptFollowup,
    statusDisplay: config.statusDisplay,
    diagnostics: config.diagnostics,
    cockpit: config.cockpit,
    weixin: config.weixin,
    limits: config.limits,
    credentialFile: config.credentialFile,
  };
}

function sourceProfile(moduleConfig, sourceConfigPath) {
  canonicalPrivate(sourceConfigPath);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8')); }
  catch { throw new BridgeError('ADOPTION_SOURCE_INVALID'); }
  requireThat(raw.moduleManaged !== true, 'ADOPTION_SOURCE_INVALID');
  const source = loadConfig(sourceConfigPath);
  requireThat(!source.moduleManaged, 'ADOPTION_SOURCE_INVALID');
  canonicalPrivate(source.stateDir, true);
  canonicalPrivate(source.lockDir, true);
  canonicalPrivate(source.credentialFile);
  requireThat(source.credentialFile === moduleConfig.credentialFile, 'ADOPTION_CREDENTIAL_REFERENCE_MISMATCH');
  const routedModule = {
    ...moduleConfig,
    cockpit: { ...moduleConfig.cockpit, sessionId: source.cockpit.sessionId, cwd: source.cockpit.cwd },
  };
  requireThat(isDeepStrictEqual(effective(source), effective(routedModule)), 'ADOPTION_CONFIG_MISMATCH');
  const credentials = readPrivate(source.credentialFile);
  assertBinding(source, credentials);
  requireThat(fs.existsSync(path.join(source.stateDir, 'bridge.sqlite')), 'ADOPTION_STORE_REQUIRED');
  const inspection = inspectBinding(source.stateDir, { snapshot: true });
  const expected = JSON.parse(JSON.stringify({
    account: source.weixin.allowedAccount,
    peer: source.weixin.allowedPeer,
    ...source.cockpit,
  }));
  requireThat(inspection.binding && isDeepStrictEqual(inspection.binding, expected),
    'PERSISTED_BINDING_CHANGED');
  return { source, raw, sourceDigest: digest(raw), inspection };
}

function assertStopped(config) {
  const runner = runnerState(config);
  requireThat(!runner.running, 'RUNNING');
  requireThat(!runner.runnerUnknown, 'RUNNER_STATE_UNKNOWN');
}

function initialState(config) {
  requireThat(!fs.existsSync(config.moduleStateRoot)
    || fs.readdirSync(config.moduleStateRoot).length === 0, 'LEGACY_ADOPTION_REQUIRED');
  return {
    schemaVersion: 1,
    revision: 0,
    configPath: config.configPath,
    configDigest: config.configDigest,
    configBackup: JSON.parse(fs.readFileSync(config.configPath, 'utf8')),
    active: null,
    history: [],
    operations: {},
  };
}

function replay(state, identity) {
  const previous = state?.operations[identity.operationId];
  if (!previous) return null;
  requireThat(JSON.stringify(previous.request) === JSON.stringify(identity), 'OPERATION_ID_CONFLICT');
  if (previous.phase === 'pending') throw new BridgeError('OPERATION_OUTCOME_UNKNOWN');
  if (previous.result.ok && (state.active?.id !== previous.result.bindingId
    || state.active.sessionId !== previous.result.boundSessionId)) {
    return {
      ok: false,
      operationId: identity.operationId,
      error: { code: 'OPERATION_STATE_CHANGED' },
      revision: state.revision,
      boundSessionId: state.active?.sessionId ?? null,
      replayed: true,
    };
  }
  return {
    ...previous.result,
    ...(previous.result.ok && state.active?.adoption
      ? { preservedPaths: state.active.adoption.preservedPaths } : {}),
    replayed: true,
  };
}

function savePending(config, state, identity) {
  requireThat(!Object.values(state.operations).some(operation => operation.phase === 'pending'),
    'OPERATION_OUTCOME_UNKNOWN');
  requireThat(Object.keys(state.operations).length < 10000, 'OPERATION_LOG_FULL');
  state.operations[identity.operationId] = { phase: 'pending', request: identity };
  try { writePrivate(controlFile(config), state); }
  catch { throw new BridgeError('OPERATION_OUTCOME_UNKNOWN'); }
}

function saveComplete(config, state, identity, result) {
  state.operations[identity.operationId] = { phase: 'complete', request: identity, result };
  try { writePrivate(controlFile(config), state); }
  catch { throw new BridgeError('OPERATION_OUTCOME_UNKNOWN'); }
}

export async function adoptLegacy(configPath, sourceConfigPath, requestedId, { fetchImpl } = {}) {
  operationId(requestedId);
  requireThat(path.isAbsolute(configPath) && path.isAbsolute(sourceConfigPath), 'ABSOLUTE_CONFIG_REQUIRED');
  const config = loadConfig(configPath);
  requireThat(config.moduleManaged, 'MODULE_MANAGED_OPT_IN_REQUIRED');
  secureExisting(configPath);
  const sourceInfo = sourceProfile(config, sourceConfigPath);
  const bindingId = randomUUID();
  const identity = {
    operation: 'adopt',
    operationId: requestedId,
    sessionId: sourceInfo.source.cockpit.sessionId,
    cwd: sourceInfo.source.cockpit.cwd,
    sourceConfigPath,
    sourceConfigDigest: sourceInfo.sourceDigest,
  };
  const existing = replay(readControl(config), identity);
  if (existing) return existing;
  const gate = acquireModuleGate(config);
  let sourceFence;
  try {
    assertCurrentConfig(config);
    assertStopped(config);
    let state = readControl(config);
    const underGateReplay = replay(state, identity);
    if (underGateReplay) return underGateReplay;
    requireThat(!state?.active, 'ALREADY_BOUND');
    state ??= initialState(config);
    assertStopped(sourceInfo.source);
    try { sourceFence = new RunLock(sourceInfo.source.lockDir); }
    catch (error) {
      if (error instanceof BridgeError && error.code === 'LOCKED') throw new BridgeError('ADOPTION_SOURCE_BUSY');
      throw error;
    }
    savePending(config, state, identity);
    let result;
    try {
      await new CockpitClient(sourceInfo.source, { fetchImpl }).meta();
      assertCurrentConfig(config);
      const currentSource = sourceProfile(config, sourceConfigPath);
      requireThat(currentSource.sourceDigest === sourceInfo.sourceDigest, 'ADOPTION_SOURCE_CHANGED');
      state.active = {
        id: bindingId,
        stateDir: sourceInfo.source.stateDir,
        sessionId: sourceInfo.source.cockpit.sessionId,
        cwd: sourceInfo.source.cockpit.cwd,
        activation: 'paused',
        adoption: {
          schemaVersion: 1,
          sourceConfigPath,
          sourceConfigDigest: sourceInfo.sourceDigest,
          sourceStateDir: sourceInfo.source.stateDir,
          credentialFile: sourceInfo.source.credentialFile,
          preservedPaths: [sourceInfo.source.stateDir],
        },
      };
      state.revision++;
      result = {
        ok: true,
        operationId: requestedId,
        revision: state.revision,
        boundSessionId: state.active.sessionId,
        bindingId,
        activation: 'paused',
      };
    } catch (error) {
      result = {
        ok: false,
        operationId: requestedId,
        error: { code: codeOf(error) },
        revision: state.revision,
        boundSessionId: state.active?.sessionId ?? null,
        bindingId,
      };
    }
    saveComplete(config, state, identity, result);
    return {
      ...result,
      ...(result.ok ? { preservedPaths: state.active.adoption.preservedPaths } : {}),
      replayed: false,
    };
  } finally {
    sourceFence?.release();
    gate.release();
  }
}

export async function activateAdoption(configPath, requestedId, { fetchImpl } = {}) {
  operationId(requestedId);
  requireThat(path.isAbsolute(configPath), 'ABSOLUTE_CONFIG_REQUIRED');
  const config = loadConfig(configPath);
  requireThat(config.moduleManaged, 'MODULE_MANAGED_OPT_IN_REQUIRED');
  secureExisting(configPath);
  const stateBefore = readControl(config);
  requireThat(stateBefore?.active?.adoption, 'ADOPTION_NOT_FOUND');
  const identity = {
    operation: 'activate-adoption',
    operationId: requestedId,
    bindingId: stateBefore.active.id,
    sessionId: stateBefore.active.sessionId,
    cwd: stateBefore.active.cwd,
  };
  const existing = replay(stateBefore, identity);
  if (existing) return existing;
  const gate = acquireModuleGate(config);
  let sourceFence;
  try {
    assertCurrentConfig(config);
    assertStopped(config);
    const state = readControl(config);
    const underGateReplay = replay(state, identity);
    if (underGateReplay) return underGateReplay;
    requireThat(state?.active?.adoption && state.active.id === identity.bindingId
      && state.active.activation === 'paused', 'ADOPTION_STATE_CHANGED');
    const sourceInfo = sourceProfile(config, state.active.adoption.sourceConfigPath);
    requireThat(sourceInfo.sourceDigest === state.active.adoption.sourceConfigDigest,
      'ADOPTION_SOURCE_CHANGED');
    assertStopped(sourceInfo.source);
    try { sourceFence = new RunLock(sourceInfo.source.lockDir); }
    catch (error) {
      if (error instanceof BridgeError && error.code === 'LOCKED') throw new BridgeError('ADOPTION_SOURCE_BUSY');
      throw error;
    }
    const fencedSource = sourceProfile(config, state.active.adoption.sourceConfigPath);
    requireThat(fencedSource.sourceDigest === state.active.adoption.sourceConfigDigest,
      'ADOPTION_SOURCE_CHANGED');
    const blocked = blocker(fencedSource.inspection);
    requireThat(!blocked, blocked);
    savePending(config, state, identity);
    let result;
    try {
      await new CockpitClient(sourceInfo.source, { fetchImpl }).meta();
      assertCurrentConfig(config);
      const currentSource = sourceProfile(config, state.active.adoption.sourceConfigPath);
      requireThat(!blocker(currentSource.inspection), blocker(currentSource.inspection));
      state.active.activation = 'active';
      state.revision++;
      result = {
        ok: true,
        operationId: requestedId,
        revision: state.revision,
        boundSessionId: state.active.sessionId,
        bindingId: state.active.id,
        activation: 'active',
      };
    } catch (error) {
      result = {
        ok: false,
        operationId: requestedId,
        error: { code: codeOf(error) },
        revision: state.revision,
        boundSessionId: state.active.sessionId,
        bindingId: state.active.id,
        activation: 'paused',
      };
    }
    saveComplete(config, state, identity, result);
    return {
      ...result,
      preservedPaths: state.active.adoption.preservedPaths,
      replayed: false,
    };
  } finally {
    sourceFence?.release();
    gate.release();
  }
}

function parse(argv) {
  const [command, ...args] = argv;
  requireThat(['adopt', 'activate'].includes(command), 'UNKNOWN_COMMAND');
  const values = {};
  let confirm = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--confirm') {
      requireThat(!confirm, 'UNKNOWN_ARGUMENT');
      confirm = true;
      continue;
    }
    requireThat(['--config', '--source-config', '--operation-id'].includes(arg)
      && args[index + 1] && !args[index + 1].startsWith('--') && values[arg] === undefined,
    'UNKNOWN_ARGUMENT');
    values[arg] = args[++index];
  }
  requireThat(confirm, 'CONFIRM_REQUIRED');
  requireThat(values['--config'] && values['--operation-id']
    && (command === 'adopt') === Boolean(values['--source-config']), 'UNKNOWN_ARGUMENT');
  return { command, configPath: values['--config'], sourceConfigPath: values['--source-config'],
    requestedId: values['--operation-id'] };
}

async function main() {
  process.umask(0o077);
  const options = parse(process.argv.slice(2));
  return options.command === 'adopt'
    ? adoptLegacy(options.configPath, options.sourceConfigPath, options.requestedId)
    : activateAdoption(options.configPath, options.requestedId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => ({ ok: false, error: { code: codeOf(error) } })).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 2;
  });
}
