import { object, requireThat, splitText } from './common.js';
import { renderWeixinAttachment, renderWeixinLinks } from './links.js';
import { publishedMediaPath } from './media.js';

// Code is display text, not an instruction to upload an image appearing in an example.
function codeSections(content) {
  const sections = [];
  let start = 0;
  let offset = 0;
  while (offset < content.length) {
    const lineStart = offset === 0 || content[offset - 1] === '\n';
    const previousLineStart = lineStart ? content.lastIndexOf('\n', offset - 2) + 1 : 0;
    const afterBlank = offset === 0 || (lineStart && !content.slice(previousLineStart, offset).trim());
    if (lineStart && afterBlank && /^(?: {4}|\t)/u.test(content.slice(offset))) {
      let end = offset;
      while (end < content.length) {
        const newline = content.indexOf('\n', end);
        const lineEnd = newline < 0 ? content.length : newline + 1;
        const line = content.slice(end, lineEnd);
        if (line.trim() && !/^(?: {4}|\t)/u.test(line)) break;
        end = lineEnd;
      }
      if (start < offset) sections.push({ code: false, value: content.slice(start, offset) });
      sections.push({ code: true, value: content.slice(offset, end) });
      start = offset = end;
      continue;
    }
    const fence = lineStart ? /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/u.exec(content.slice(offset)) : null;
    if (fence) {
      const token = fence[2];
      let end = offset + fence[0].length;
      while (end < content.length) {
        const newline = content.indexOf('\n', end);
        const lineEnd = newline < 0 ? content.length : newline + 1;
        const line = content.slice(end, lineEnd).trim();
        end = lineEnd;
        if (line.length >= token.length && [...line].every(char => char === token[0])) break;
      }
      if (start < offset) sections.push({ code: false, value: content.slice(start, offset) });
      sections.push({ code: true, value: content.slice(offset, end) });
      start = offset = end;
      continue;
    }
    if (content[offset] === '`' && content[offset - 1] !== '\\') {
      let runEnd = offset + 1;
      while (content[runEnd] === '`') runEnd++;
      const token = content.slice(offset, runEnd);
      const close = content.indexOf(token, runEnd);
      if (close >= 0) {
        if (start < offset) sections.push({ code: false, value: content.slice(start, offset) });
        const end = close + token.length;
        sections.push({ code: true, value: content.slice(offset, end) });
        start = offset = end;
        continue;
      }
      // An unclosed code span is literal text, with no recognized images in that span.
      if (start < offset) sections.push({ code: false, value: content.slice(start, offset) });
      sections.push({ code: true, value: content.slice(offset) });
      return sections;
    }
    offset++;
  }
  if (start < content.length) sections.push({ code: false, value: content.slice(start) });
  return sections;
}

export function replyParts(content, config, attachment, message) {
  requireThat(typeof content === 'string' && content.length <= 1000000, 'EMPTY_OR_OVERSIZED_REPLY');
  const attachmentPart = attachment => {
    requireThat(object(attachment) && ['image', 'file'].includes(attachment.kind)
      && typeof attachment.name === 'string' && attachment.name.length <= 1000
      && typeof attachment.url === 'string' && attachment.url.length <= 2048, 'INVALID_REPLY_ATTACHMENT');
    const uploadPath = publishedMediaPath(attachment.url, config.cockpit.webUrl);
    if (uploadPath) return [{ kind: attachment.kind === 'image' ? 'image' : 'media', uploadPath }];
    return splitText(renderWeixinAttachment(attachment, config.cockpit.webUrl),
      config.limits.textBytes, config.limits.maxReplyParts).map(value => ({ kind: 'text', value }));
  };
  if (message?.parts?.length) {
    requireThat(Array.isArray(message.parts) && message.parts.length <= 1000, 'INVALID_REPLY_PARTS');
    const ordered = [];
    for (const part of message.parts) {
      requireThat(object(part) && ['text', 'file'].includes(part.type), 'INVALID_REPLY_PARTS');
      if (part.type === 'text') {
        requireThat(typeof part.text === 'string', 'INVALID_REPLY_PARTS');
        if (part.text.trim()) ordered.push(...replyParts(part.text, config));
      } else ordered.push(...attachmentPart(part.attachment));
    }
    requireThat(ordered.length > 0 && ordered.length <= config.limits.maxReplyParts, 'TOO_MANY_REPLY_PARTS');
    return ordered;
  }
  const sections = codeSections(content);
  const references = new Map();
  const key = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();
  const definition = /^[ \t]{0,3}\[([^[\]\n]{1,200})\]:[ \t]*(?:<([^>\n]{1,2048})>|(\S{1,2048}))(?:[ \t]+["'][^\n]*["'])?[ \t]*$/gmu;
  for (const section of sections) {
    if (section.code) continue;
    section.value = section.value.replace(definition, (match, id, angle, bare) => {
      if (!references.has(key(id))) references.set(key(id), angle ?? bare);
      return '';
    });
  }
  const parts = [];
  let text = '';
  const flush = () => {
    if (text.trim()) {
      parts.push(...splitText(text, config.limits.textBytes, config.limits.maxReplyParts)
        .map(value => ({ kind: 'text', value })));
    }
    text = '';
  };
  const render = value => renderWeixinLinks(value, config.cockpit.webUrl, references);
  const images = /(?<![\\!])!?\[([^[\]\n]{0,200})\](?:\([ \t]*(?:<([^>\n]{1,2048})>|([^\s()[\]]{1,2048}))(?:[ \t]+["'][^"\n]{0,200}["'])?[ \t]*\)|\[([^[\]\n]{0,200})\])?/gu;
  for (const section of sections) {
    if (section.code) { text += section.value; continue; }
    let last = 0;
    for (const match of section.value.matchAll(images)) {
      text += render(section.value.slice(last, match.index));
      const target = match[2] ?? match[3] ?? references.get(key(match[4] || match[1])) ?? '';
      const uploadPath = publishedMediaPath(target, config.cockpit.webUrl);
      if (uploadPath) {
        flush();
        parts.push({ kind: match[0].startsWith('!') && /\.(?:png|jpe?g)$/iu.test(uploadPath) ? 'image' : 'media', uploadPath });
      } else {
        text += render(match[0]);
      }
      last = match.index + match[0].length;
    }
    text += render(section.value.slice(last));
  }
  flush();
  if (message?.attachments !== undefined) requireThat(Array.isArray(message.attachments), 'INVALID_REPLY_ATTACHMENT');
  for (const value of [...(message?.attachments ?? []), ...(attachment === undefined ? [] : [attachment])]) {
    for (const part of attachmentPart(value)) {
      if (!part.uploadPath || !parts.some(existing => existing.uploadPath === part.uploadPath)) parts.push(part);
    }
  }
  requireThat(parts.length > 0, 'EMPTY_OR_OVERSIZED_REPLY');
  requireThat(parts.length <= config.limits.maxReplyParts, 'TOO_MANY_REPLY_PARTS');
  return parts;
}
