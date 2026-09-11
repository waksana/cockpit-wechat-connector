#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { Bridge, resolveJob } from './bridge.js';
import { SessionBridge } from './session-bridge.js';
import { CockpitClient, quiescent } from './cockpit.js';
import { loadConfig, assertBinding } from './config.js';
import { BridgeError, errorCode, requireThat, retryableRead, sessionLink } from './common.js';
import { Store, RunLock, privateDirectory, readPrivate, writePrivate } from './storage.js';
import { WeixinClient, login } from './weixin.js';
import { deliverPublishedPng } from './image.js';
import { lifecycleConfig, startLifecycle } from './lifecycle.js';
import { acquireModuleGate, assertCurrentConfig, readControl } from './module-state.js';
import { moduleStatus } from './module-control.js';

function options(argv) {
  const args = [...argv];
  const index = args.indexOf('--config');
  let file = path.resolve('config.json');
  if (index >= 0) {
    requireThat(args[index + 1] && !args[index + 1].startsWith('--'), 'CONFIG_ARGUMENT_REQUIRED');
    file = path.resolve(args[index + 1]); args.splice(index, 2);
  }
  const confirm = args.includes('--confirm');
  const once = args.includes('--once');
  const positional = args.filter(arg => !['--confirm', '--once'].includes(arg));
  requireThat(!positional.some(arg => arg.startsWith('--')), 'UNKNOWN_ARGUMENT');
  requireThat(!once || positional[0] === 'run', 'ONCE_REQUIRES_RUN');
  return { command: positional[0] ?? 'help', rest: positional.slice(1), file, confirm, once };
}

const help = `Weixin <-> Cockpit text/media bridge (no OpenClaw dependency)
node src/cli.js init
node src/cli.js status
node src/cli.js check
node src/cli.js trust-history --confirm
node src/cli.js login --confirm
node src/cli.js run
node src/cli.js run --once
node src/cli.js stop
node src/cli.js unlock --confirm
node src/cli.js resolve JOB_ID observe|sent|abandon|enqueue|retry-media --confirm
node src/cli.js send-image /uploads/PUBLISHED_FILE.png --confirm
All commands accept --config /absolute/config.json.
login performs REAL Weixin authorization. run sends REAL messages when configured.
stop drains this bridge's in-flight sends; it NEVER cancels Cockpit work.
stop refuses legacy runners without drain support; never force-stop them for deployment.
Unknown mutations are never replayed. See README before resolving.`;

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const { command, rest, file, confirm, once } = options(argv);
  const delivery = command === 'run' ? lifecycleConfig() : null;
  if (command === 'help') { console.log(help); return; }
  if (command === 'init') {
    requireThat(rest.length === 0, 'UNKNOWN_ARGUMENT');
    fs.copyFileSync(new URL('../config.example.json', import.meta.url), file, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file, 0o600);
    console.log('Created unbound config. Edit explicitly; no API contacted.');
    return;
  }
  requireThat(['status', 'check', 'trust-history', 'login', 'run', 'stop', 'unlock', 'resolve', 'send-image'].includes(command), 'UNKNOWN_COMMAND');
  requireThat(rest.length === (command === 'resolve' ? 2 : command === 'send-image' ? 1 : 0), 'UNKNOWN_ARGUMENT');
  const config = loadConfig(file);
  const credentialFile = config.credentialFile;
  let store;
  let lock;
  let gate;
  let timer;
  let lifecycle;
  let running = false;
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    if (config.moduleManaged) {
      if (command === 'status') {
        console.log(JSON.stringify(moduleStatus(config), null, 2));
        return;
      }
      gate = acquireModuleGate(config, { unlockStale: command === 'unlock' && confirm });
      assertCurrentConfig(config);
    }
    if (command === 'stop') {
      RunLock.requestStop(config.lockDir, { requireDrain: true });
      console.log('Drain requested; wait for runner exit and lock release. Cockpit work is unchanged.');
      return;
    }
    if (command === 'unlock') {
      requireThat(confirm, 'CONFIRM_REQUIRED');
      if (!config.moduleManaged || fs.existsSync(path.join(config.lockDir, 'run.lock'))) RunLock.unlock(config.lockDir);
      console.log('Removed stale bridge lock.'); return;
    }
    if (config.moduleManaged) {
      requireThat(config.cockpit.sessionId, 'MODULE_NOT_BOUND');
      requireThat(!Object.values(readControl(config)?.operations ?? {}).some(op => op.phase === 'pending'),
        'OPERATION_OUTCOME_UNKNOWN');
      lock = new RunLock(config.lockDir, { drain: command === 'run' });
      gate.release(); gate = null;
    }
    privateDirectory(config.stateDir);
    store = new Store(config.stateDir);
    if (command === 'status') {
      const credentials = readPrivate(credentialFile);
      const running = readPrivate(path.join(config.lockDir, 'run.lock'));
      console.log(JSON.stringify({
        configuredTarget: Boolean(config.cockpit.sessionId && config.cockpit.cwd),
        credentialsPresent: Boolean(credentials), runningPid: running?.pid ?? null,
        drainSupported: running?.drainProtocol === 1,
        drainRequested: Boolean(running && readPrivate(path.join(config.lockDir, 'stop.json'))?.nonce === running.nonce),
        ...store.summary(),
      }, null, 2));
      return;
    }
    lock ??= new RunLock(config.lockDir, { drain: command === 'run' });
    if (command === 'resolve') {
      requireThat(confirm, 'CONFIRM_REQUIRED');
      store.recover();
      resolveJob(store, rest[0], rest[1]);
      console.log('Resolution saved; no message sent, no Cockpit cancellation.');
      return;
    }
    if (command === 'login') {
      requireThat(confirm, 'CONFIRM_REQUIRED');
      requireThat(!store.jobs().some(job => !['done', 'abandoned', 'rejected'].includes(job.status)), 'PENDING_JOBS_BEFORE_LOGIN');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const credentials = await login(new WeixinClient(config, null), {
          signal: abort.signal,
          showQr: url => console.log(`Open this QR URL on a trusted screen and scan with your phone (do not share):\n${url}`),
          verifyCode: () => rl.question('Enter the code shown on your phone (local terminal only): ', { signal: abort.signal }),
        });
        writePrivate(credentialFile, credentials);
        console.log(JSON.stringify({ account: credentials.account, peer: credentials.peer,
          note: 'Login saved, NOT bound. Set allowedAccount/allowedPeer and dedicated target explicitly.' }));
      } finally { rl.close(); }
      return;
    }
    const credentials = readPrivate(credentialFile);
    assertBinding(config, credentials);
    if (command === 'send-image') {
      requireThat(confirm, 'CONFIRM_REQUIRED');
      const result = await deliverPublishedPng(config, credentials, store,
        new WeixinClient(config, credentials), rest[0], abort.signal);
      console.log(JSON.stringify(result));
      return;
    }
    const cockpit = new CockpitClient(config);
    const BridgeClass = config.deliveryMode === 'session' ? SessionBridge : Bridge;
    const bridge = new BridgeClass(config, credentials, store, new WeixinClient(config, credentials), cockpit);
    requireThat(!(once && config.deliveryMode === 'session'), 'ONCE_REQUIRES_CORRELATED_MODE');
    if (command === 'check' || command === 'trust-history') {
      bridge.bind();
      await cockpit.capabilities(abort.signal);
      const meta = await cockpit.meta(abort.signal);
      if (command === 'trust-history') {
        requireThat(confirm, 'CONFIRM_REQUIRED');
        requireThat(store.jobs().every(job => ['queued', 'rejected', 'done', 'abandoned'].includes(job.status)), 'UNRESOLVED_JOBS');
        await bridge.establishCheckpoint(abort.signal, true);
      } else if (quiescent(meta)) await bridge.establishCheckpoint(abort.signal);
      console.log(JSON.stringify({ bindingMatches: true, status: meta.status, quiescent: quiescent(meta),
        web: sessionLink(config), note: 'Cockpit read only; local history checkpoint retained. Weixin token validity NOT checked.' }));
      return;
    }
    timer = setInterval(() => {
      try { if (lock.stopRequested()) abort.abort(); }
      catch { abort.abort(); process.stderr.write('STOP_CONTROL_READ_FAILED\n'); process.exitCode = 1; }
    }, 250);
    if (delivery) lifecycle = await startLifecycle(delivery, {
      state: () => ({ running, ready: bridge.draining === false,
        draining: bridge.draining === true, drainRequested: abort.signal.aborted }),
      requestDrain: onSignal,
    });
    running = true;
    await bridge.run(abort.signal, { once });
    console.log('Bridge stopped; Cockpit work and queue unchanged.');
  } finally {
    running = false;
    if (timer) clearInterval(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try { await lifecycle?.close(); }
    finally {
      try { store?.close(); }
      finally { try { lock?.release(); } finally { gate?.release(); } }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Bridge stopped: ${errorCode(error)}. Inspect status/README; no automatic mutation retry.`);
    if (error instanceof BridgeError && ['TOOL_PROGRESS_RETIRED', 'LEGACY_CHECKPOINT_REVIEW_REQUIRED']
      .includes(error.code)) console.error(error.message);
    process.exitCode = retryableRead(errorCode(error)) ? 75 : error instanceof BridgeError ? 2 : 1;
  });
}
