import { createHash, randomUUID } from 'node:crypto';
import { requireThat } from './common.js';

// Channel display grouping only. Native user-message boundaries are not invented execution run IDs.
export function replyRunId(config, store, messages, messageId, checkpoint, create = true) {
  const index = messages.findIndex(message => message.id === messageId);
  requireThat(index >= 0, 'REPLY_GROUP_MESSAGE_MISSING');
  const input = messages.slice(0, index + 1).findLast(message => message.role === 'user' && !message.subtype);
  const inputId = input?.id ?? checkpoint.userMessageId;
  const anchor = inputId ? `user:${inputId}` : `after:${checkpoint.id ?? 'beginning'}`;
  const key = `reply-run:${createHash('sha256').update(`${config.cockpit.sessionId}:${anchor}`).digest('hex')}`;
  let id = store.get(key);
  if (!id && create) {
    id = randomUUID();
    store.set(key, id);
  }
  return id ?? undefined;
}
