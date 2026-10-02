import type { ModuleBackendContext, ModuleRoleAvailabilityReason, RoleAvailabilityCheck, RoleAssignmentNotification,
  ModuleHostIntentResult } from '@waksana/cockpit-module-sdk/backend';
import { invariant, retireBinding, retiredWorkInFlight, Store, unresolved } from './state.js';

export async function sessionMeta(context: ModuleBackendContext, sessionId: string) {
  const result: ModuleHostIntentResult<'session/get'> = await context.host.call('session/get', { sessionId });
  invariant(result && Object.hasOwn(result, 'meta') && Object.keys(result).every(key => key === 'meta'), 'SESSION_QUERY_UNKNOWN');
  const meta = result.meta;
  invariant(meta === null || (meta.sessionId === sessionId && typeof meta.loaded === 'boolean'
    && typeof meta.cwd === 'string' && ['idle', 'running', 'unloaded', 'error'].includes(meta.status)
    && Object.hasOwn(meta, 'ask') && (meta.ask === null || (typeof meta.ask?.requestId === 'string'
      && meta.ask.requestId.length > 0 && typeof meta.ask.question === 'string'
      && (meta.ask.choices === undefined || (Array.isArray(meta.ask.choices)
        && meta.ask.choices.every(choice => typeof choice === 'string')))
      && (meta.ask.allowFreeform === undefined || typeof meta.ask.allowFreeform === 'boolean')))), 'SESSION_QUERY_UNKNOWN');
  return meta;
}
export class BindingManager {
  constructor(private context: ModuleBackendContext, readonly store: Store, private problems: () => string[]) {}
  private active(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.context.stopping.throwIfAborted();
    this.context.signal.throwIfAborted();
  }
  private async reconcile(signal: AbortSignal): Promise<void> {
    this.active(signal);
    const binding = this.store.read().binding;
    if (!binding) return;
    const meta = await sessionMeta(this.context, binding.sessionId);
    this.active(signal);
    if (meta === null) this.store.change(state => retireBinding(state, binding));
  }
  async availability(selection: RoleAvailabilityCheck, signal: AbortSignal) {
    const reasons: ModuleRoleAvailabilityReason[] = [];
    const add = (code: string, status: 'denied' | 'unknown' = 'denied') => reasons.push({
      code, status, message: code, roles: [{ moduleId: this.context.moduleId, roleId: 'wechat' }], capabilities: [],
    });
    for (const code of this.problems()) add(code);
    if (this.context.stopping.aborted) add('SERVICE_STOPPING');
    try {
      await this.reconcile(signal);
      this.active(signal);
    } catch {
      add(signal.aborted || this.context.signal.aborted || this.context.stopping.aborted
        ? 'BINDING_QUERY_CANCELLED' : 'BINDING_EXISTENCE_UNKNOWN', 'unknown');
    }
    const current = this.store.read();
    if (current.binding && current.binding.sessionId !== selection.sessionId) add('BINDING_OCCUPIED');
    if (unresolved(current)) add('UNRESOLVED_HISTORY');
    if (retiredWorkInFlight(current)) add('RETIRED_WORK_IN_FLIGHT');
    return { reasons };
  }
  async saved(notification: RoleAssignmentNotification, signal: AbortSignal): Promise<void> {
    this.active(signal);
    if (this.store.read().notifications.includes(notification.notificationId)) return;
    await this.reconcile(signal);
    this.active(signal);
    const before = this.store.read();
    invariant(this.problems().length === 0, 'SERVICE_UNAVAILABLE');
    invariant(!before.binding || before.binding.sessionId === notification.sessionId, 'BINDING_OCCUPIED');
    invariant(!unresolved(before), 'UNRESOLVED_HISTORY');
    invariant(!retiredWorkInFlight(before), 'RETIRED_WORK_IN_FLIGHT');
    let anchor: string | null | undefined;
    if (!before.binding) {
      const page = await this.context.host.call('session/chat', {
        sessionId: notification.sessionId, source: 'persisted', direction: 'backward',
        max: 1, waitMs: 0, bootstrap: false, includeEphemeral: false,
      });
      this.active(signal);
      invariant(page.sessionId === notification.sessionId && page.source === 'persisted'
        && page.direction === 'backward' && page.cursorStatus === 'ok' && Array.isArray(page.events)
        && page.events.length <= 1 && typeof page.hasMore === 'boolean'
        && (page.events.length > 0 || !page.hasMore), 'BINDING_HISTORY_UNKNOWN');
      anchor = page.events.at(-1)?.id ?? null;
    }
    this.store.change(state => {
      if (state.notifications.includes(notification.notificationId)) return;
      invariant(state.generation === before.generation, 'BINDING_CHANGED');
      invariant(!state.binding || state.binding.sessionId === notification.sessionId, 'BINDING_OCCUPIED');
      invariant(!unresolved(state), 'UNRESOLVED_HISTORY');
      invariant(!retiredWorkInFlight(state), 'RETIRED_WORK_IN_FLIGHT');
      if (!state.binding) {
        state.generation++;
        state.binding = { sessionId: notification.sessionId, generation: state.generation, anchor, boundAt: Date.now() };
      }
      state.notifications.push(notification.notificationId);
    });
  }
}
