import { createHash } from 'node:crypto';
import { requireThat } from './common.js';

// Preserve legacy body/media grouping without creating new tool-progress groups.
export function replyRunId(config, store, messages, messageId, checkpoint) {
  const index = messages.findIndex(message => message.id === messageId);
  requireThat(index >= 0, 'REPLY_GROUP_MESSAGE_MISSING');
  const input = messages.slice(0, index + 1).findLast(message => message.role === 'user' && !message.subtype);
  const inputId = input?.id ?? checkpoint.userMessageId;
  const anchor = inputId ? `user:${inputId}` : `after:${checkpoint.id ?? 'beginning'}`;
  const key = `reply-run:${createHash('sha256').update(`${config.cockpit.sessionId}:${anchor}`).digest('hex')}`;
  return store.get(key) ?? undefined;
}
