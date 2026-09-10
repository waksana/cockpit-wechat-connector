import { object, requireThat } from './common.js';

const upload = /^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u;

// Decode the existing attachment wire markers; never resolve a chat-authored path.
function files(content, user) {
  const parts = [];
  const attachments = [];
  let end = 0;
  for (const match of content.matchAll(/<cockpit-attachment\b([^>]*?)\/?>(?:<\/cockpit-attachment>)?/gu)) {
    const attrs = match[1];
    const legacyUser = user && !/\bversion="2"/u.test(attrs);
    if (legacyUser && content.slice(0, match.index).trim()) continue;
    const get = key => {
      const value = new RegExp(`${key}="([^"]*)"`, 'u').exec(attrs)?.[1];
      if (value === undefined) return undefined;
      try { return decodeURIComponent(value); } catch { return value; }
    };
    const url = get('url');
    if (!url || !upload.test(url)) continue;
    const size = Number(get('size'));
    const attachment = {
      kind: get('kind') === 'image' ? 'image' : 'file', url, name: get('name') ?? 'file',
      ...(Number.isFinite(size) && size > 0 ? { size } : {}), ...(get('mime') ? { mime: get('mime') } : {}),
    };
    if (legacyUser) return { content: '', attachment };
    if (match.index > end) parts.push({ type: 'text', text: content.slice(end, match.index) });
    parts.push({ type: 'file', attachment });
    attachments.push(attachment);
    end = match.index + match[0].length;
  }
  if (!attachments.length) return { content };
  if (end < content.length) parts.push({ type: 'text', text: content.slice(end) });
  return {
    content: parts.filter(part => part.type === 'text').map(part => part.text).join('').trim(),
    attachment: attachments[0], attachments, parts,
  };
}

export function nativeMessages(events) {
  const messages = [];
  const tools = new Map();
  for (const event of events) {
    requireThat(object(event) && typeof event.id === 'string' && typeof event.type === 'string' && object(event.data),
      'COCKPIT_NATIVE_EVENT_SCHEMA');
    const data = event.data;
    if (event.ephemeral || event.agentId || event.parentToolCallId || data.agentId || data.parentToolCallId) continue;
    if (['user.message', 'assistant.message'].includes(event.type)) {
      if (event.type === 'user.message' && typeof data.source === 'string' && data.source.startsWith('skill-')) continue;
      const message = {
        id: event.type === 'assistant.message' && typeof data.messageId === 'string' ? data.messageId : event.id,
        role: event.type === 'user.message' ? 'user' : 'assistant',
        ...files(typeof data.content === 'string' ? data.content : '', event.type === 'user.message'),
      };
      if (Array.isArray(data.toolRequests) && data.toolRequests.length) {
        message.toolCalls = data.toolRequests.map(tool => {
          const value = { toolCallId: tool.toolCallId, name: tool.name };
          tools.set(value.toolCallId, value);
          return value;
        });
      }
      messages.push(message);
    } else if (event.type === 'tool.execution_start' || event.type === 'tool.execution_complete') {
      const tool = tools.get(data.toolCallId);
      if (tool) tool.status = event.type === 'tool.execution_start' ? 'in_progress' : data.success === false ? 'failed' : 'completed';
    } else if (event.type === 'session.error') {
      messages.push({ id: event.id, role: 'system', level: 'error', content: 'Native session error' });
    }
  }
  return messages;
}
