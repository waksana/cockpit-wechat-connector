import { BridgeError, object, requireThat } from './common.js';

const maxEventSize = 4 * 1024 * 1024;

export class WorkSignal {
  pending = false;
  notify() { this.pending = true; this.resolve?.(); }
  consume() { this.pending = false; }
  async wait(timeoutMs, signal) {
    signal.throwIfAborted();
    if (this.pending) return;
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.resolve = undefined;
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(), timeoutMs);
      this.resolve = () => finish();
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

export class EventDecoder {
  buffer = '';
  data = [];
  size = 0;
  constructor(onEvent) { this.onEvent = onEvent; }
  feed(chunk) {
    this.buffer += chunk;
    let match;
    while ((match = /\r\n|\r|\n/u.exec(this.buffer))) {
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      requireThat(line.length <= maxEventSize, 'COCKPIT_SSE_EVENT_TOO_LARGE');
      if (line === '') {
        if (this.data.length) {
          let event;
          try { event = JSON.parse(this.data.join('\n')); }
          catch { throw new BridgeError('COCKPIT_SSE_INVALID_EVENT'); }
          requireThat(object(event) && typeof event.type === 'string', 'COCKPIT_SSE_INVALID_EVENT');
          this.onEvent(event);
        }
        this.data = []; this.size = 0;
      } else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /u, '');
        this.size += value.length + 1;
        requireThat(this.size <= maxEventSize, 'COCKPIT_SSE_EVENT_TOO_LARGE');
        this.data.push(value);
      }
    }
    requireThat(this.buffer.length <= maxEventSize, 'COCKPIT_SSE_EVENT_TOO_LARGE');
  }
}

export function eventAffectsSession(event, sessionId) {
  if (event.type === 'snapshot' || event.type === 'agent/status') return true;
  if (event.type === 'session/added') return event.session?.sessionId === sessionId;
  return ['chat/invalidated', 'session/invalidated', 'session/patch', 'session/removed', 'session/notify'].includes(event.type)
    && event.sessionId === sessionId;
}

export async function readEventStream(client, onEvent, signal, { idleTimeoutMs = 70000 } = {}) {
  const controller = new AbortController();
  const linked = AbortSignal.any([signal, controller.signal]);
  let timer = setTimeout(() => controller.abort(), client.config.limits.requestTimeoutMs);
  let response;
  let reader;
  try {
    response = await client.fetchImpl(new URL('/events', client.config.cockpit.apiUrl), {
      method: 'GET', headers: { ...client.headers, Accept: 'text/event-stream' }, redirect: 'manual', signal: linked,
    });
    requireThat(response.status === 200, `COCKPIT_SSE_HTTP_${response.status}`);
    requireThat(response.headers.get('content-type')?.split(';', 1)[0]?.trim() === 'text/event-stream'
      && response.body, 'COCKPIT_SSE_CONTENT_TYPE');
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    refresh();
    onEvent({ type: 'connected' });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = new EventDecoder(event => {
      if (eventAffectsSession(event, client.config.cockpit.sessionId)) onEvent(event);
    });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new BridgeError('COCKPIT_SSE_DISCONNECTED');
      refresh();
      events.feed(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (signal.aborted) throw new BridgeError('STOPPED');
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(controller.signal.aborted ? 'COCKPIT_SSE_TIMEOUT' : 'COCKPIT_SSE_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation can reject after a disconnected stream; it is cleanup only.
    if (reader) await reader.cancel().catch(() => {});
    else if (response?.body) await response.body.cancel().catch(() => {});
  }
}
