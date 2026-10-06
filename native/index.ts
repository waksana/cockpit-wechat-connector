import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:net';
import type { ModuleBackend, ModuleBackendContext, ModuleRoleAvailabilityReason } from '@waksana/cockpit-module-sdk/backend';
import { accountLease, credentials, identity, readConfig } from './config.js';
import { BindingManager } from './binding.js';
import { invariant, Store } from './state.js';
import { Service } from './service.js';
import { WechatTransport } from './transport.js';

export function capabilities(context: ModuleBackendContext): void {
  invariant(context.serviceReadyVersion === 1 && context.shutdownVersion === 1 && context.stopping
    && context.host?.roleAssignmentVersion === 1 && context.host.roleAvailabilityVersion === 1
    && context.host.sessionLoadVersion === 1 && context.host.chatReadVersion === 1
    && context.host.promptReceiptVersion === 1 && context.host.askResponseVersion === 1,
  'REQUIRED_HOST_CAPABILITIES_MISSING');
}
export async function activate(context: ModuleBackendContext): Promise<ModuleBackend> {
  capabilities(context);
  const parsed = readConfig(context.config);
  const problems = [...parsed.reasons];
  let store: Store | undefined;
  let manager: BindingManager | undefined;
  let service: Service | undefined;
  let accountLock: Server | undefined;
  let rootLock: Server | undefined;
  const reasons = (): ModuleRoleAvailabilityReason[] => problems.map(code => ({
    code, message: code, status: 'denied', roles: [{ moduleId: context.moduleId, roleId: 'wechat' }], capabilities: [],
  }));
  const existing = existsSync(join(context.dataRoot, 'native-v1.sqlite'));
  if (!problems.length || existing) {
    rootLock = await accountLease(`storage:${createHash('sha256').update(context.dataRoot).digest('hex')}`);
    try {
      store = new Store(context.dataRoot, existing ? undefined : identity(parsed.config));
      if (store.read().identity !== identity(parsed.config)) problems.push('ACCOUNT_CONFIGURATION_CHANGED');
      manager = new BindingManager(context, store, () => problems);
    } catch (error) {
      rootLock.close();
      throw error;
    }
    if (!problems.length) try {
      const auth = credentials(context.dataRoot, parsed.config);
      service = new Service(context, parsed.config, store, new WechatTransport(auth));
    } catch {
      problems.push('CREDENTIALS_UNAVAILABLE');
    }
  }
  return {
    publicConfig: {},
    routes: [
      { method: 'GET', path: '/status', handler: () => {
        const state = store?.read();
        return { body: { configured: problems.length === 0, problems, running: !!accountLock,
          revision: state?.revision, binding: state?.binding ? { sessionId: state.binding.sessionId, generation: state.binding.generation } : null,
          lastError: state?.lastError ?? null,
          lastApiFailure: state?.lastApiFailure ?? null,
          outbound: {
            state: !state?.binding ? 'unbound' : !state.binding.contextToken ? 'no_context'
              : state.binding.replyContextRejection ? 'awaiting_new_context' : 'ready',
            ...(state?.binding?.replyContextRejection ? {
              reason: 'WECHAT_REPLY_CONTEXT_REJECTED', observedAt: state.binding.replyContextRejection.observedAt,
              action: 'Wait for a natural inbound WeChat message with a different reply context. Old outputs will not be replayed.',
            } : {}),
          },
          receipts: state?.receipts.map(receipt => ({ key: receipt.key, direction: receipt.direction,
            status: receipt.status, reason: receipt.reason,
            ...(receipt.apiFailure ? { apiFailure: receipt.apiFailure } : {}) })) ?? [] } };
      } },
    ],
    roleAssignments: {
      availability: (selection, signal) => manager?.availability(selection, signal) ?? { reasons: reasons() },
      permit: async (selection, signal) => {
        const checked = manager ? await manager.availability(selection, signal) : { reasons: reasons() };
        return checked.reasons.length ? { allowed: false, reason: checked.reasons.map(reason => reason.code).join('; ') } : { allowed: true };
      },
      saved: async (notification, signal) => {
        invariant(manager, 'SERVICE_UNCONFIGURED');
        await manager.saved(notification, signal);
        context.invalidate();
      },
    },
    events: { types: ['assistant.message', 'user.message'], handle: observation => service?.observe(observation) },
    onReady: async () => {
      if (!service) return;
      context.stopping.throwIfAborted();
      try { accountLock = await accountLease(parsed.config.account); }
      catch { problems.push('ACCOUNT_ALREADY_IN_USE'); context.report(new Error('ACCOUNT_ALREADY_IN_USE')); return; }
      context.stopping.throwIfAborted();
      await service.start();
    },
    onStop: async () => { await service?.stop(); },
    dispose: async () => {
      await service?.stop();
      store?.close();
      for (const lock of [accountLock, rootLock]) {
        if (lock) await new Promise<void>((resolve, reject) => lock.close(error => error ? reject(error) : resolve()));
      }
    },
  };
}
