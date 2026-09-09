import { createHash } from 'node:crypto';
import { object, requireThat } from './common.js';
import { quotedInput } from './quote-display.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const itemTypes = new Map([[1, 'text'], [2, 'image'], [3, 'voice'], [4, 'file'], [5, 'video']]);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !/[\s\x00-\x1f\x7f]/u.test(value) ? value
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;

// Keep exact ends, not a paraphrase. Count Unicode code points, never split a surrogate pair.
export function quoteText(value) {
  const points = Array.from(value);
  return points.length <= 1600 ? { text: value } : {
    head: points.slice(0, 1200).join(''), omission: '[middle omitted]',
    omittedCodePoints: points.length - 1600, tail: points.slice(-400).join(''),
    fullTextSha256: hash(value),
  };
}

export function quoteItem(item) {
  if (!object(item)) return { type: 'unknown', contentMissing: true };
  const type = itemTypes.get(item.type) ?? 'unknown';
  const result = { type };
  if (type === 'text' && typeof item.text_item?.text === 'string') result.body = quoteText(item.text_item.text);
  else if (type === 'voice' && typeof item.voice_item?.text === 'string') {
    result.transcript = quoteText(item.voice_item.text);
  } else if (type === 'file' && typeof item.file_item?.file_name === 'string') {
    result.fileName = quoteText(item.file_item.file_name);
  }
  if (type !== 'text') result.mediaNotFetched = true;
  if (!result.body && !result.transcript) result.contentMissing = true;
  if (Object.hasOwn(item, 'ref_msg')) result.nestedQuoteOmitted = true;
  return result;
}

export function incomingQuoteItems(items) {
  return items.map(item => ({
    ...(identifier(item?.msg_id) ? { itemId: identifier(item.msg_id) } : {}),
    content: quoteItem(item),
  }));
}

export function normalizeQuotes(items) {
  return items.flatMap((item, index) => {
    if (!object(item) || !Object.hasOwn(item, 'ref_msg')) return [];
    const ref = item.ref_msg;
    if (!object(ref)) return [{ itemIndex: index, malformed: true }];
    const result = { itemIndex: index };
    const svrId = identifier(ref.svr_id);
    const itemId = identifier(ref.message_item?.msg_id);
    if (svrId) result.svrId = svrId;
    if (itemId) result.itemId = itemId;
    if ((ref.svr_id !== undefined && !svrId)
      || (ref.message_item?.msg_id !== undefined && !itemId)) result.invalidId = true;
    if (ref.message_item !== undefined) result.provided = quoteItem(ref.message_item);
    if (typeof ref.title === 'string') result.title = quoteText(ref.title);
    if (Object.hasOwn(ref, 'partial_text')) {
      // Boundary strings are supplied quote data, never a fuzzy message lookup.
      // Index/hash protocol variants are not treated as a verified selected range.
      const partial = ref.partial_text;
      result.selection = { rangeVerified: false };
      if (object(partial)) {
        for (const key of ['start', 'end']) {
          if (typeof partial[key] === 'string') result.selection[key] = quoteText(partial[key]);
        }
        for (const key of ['startindex', 'endindex']) {
          if (Number.isSafeInteger(partial[key]) && partial[key] >= 0) result.selection[key] = partial[key];
        }
        if (typeof partial.quotemd5 === 'string' && /^[a-f0-9]{32}$/iu.test(partial.quotemd5)) {
          result.selection.quotemd5 = partial.quotemd5;
        }
      } else result.selection.malformed = true;
    }
    return [result];
  });
}

function localSources(job, store, config) {
  const sources = [];
  for (const prior of store.jobs()) {
    if (prior.id === job.id || prior.peer !== config.weixin.allowedPeer || prior.status === 'rejected') continue;
    const prefix = `${config.weixin.allowedAccount}:`;
    if (prior.id.startsWith(prefix)) {
      const items = prior.quoteItems ?? (prior.kind === 'text'
        ? [{ content: { type: 'text', body: quoteText(prior.original) } }] : []);
      sources.push({
        key: `${prior.id}:incoming`,
        ids: [prior.id.slice(prefix.length)],
        source: { direction: 'incoming', ...(prior.userMessageId ? { cockpitMessageId: prior.userMessageId } : {}),
          items: items.map((item, index) => ({ ...item.content,
            ...(prior.retainedMedia?.[index] ? { attachment: prior.retainedMedia[index], mediaNotFetched: false } : {}) })) },
      });
      for (const [index, item] of items.entries()) if (item.itemId) sources.push({
        key: items.length === 1 ? `${prior.id}:incoming` : `${prior.id}:item:${index}`,
        ids: [item.itemId],
        source: { direction: 'incoming', ...(prior.userMessageId ? { cockpitMessageId: prior.userMessageId } : {}),
          items: [{ ...item.content,
            ...(prior.retainedMedia?.[index] ? { attachment: prior.retainedMedia[index], mediaNotFetched: false } : {}) }] },
      });
    }
    for (const delivery of prior.deliveries ?? []) {
      if (!delivery.messageId) continue;
      const cockpitMessageId = prior.outputMessageId ?? prior.replyMessageId;
      sources.push({
        key: `${prior.id}:delivery:${delivery.clientId}`,
        ids: [delivery.messageId],
        source: { direction: 'outgoing', ...(cockpitMessageId ? { cockpitMessageId } : {}),
          scope: 'exact Weixin delivery part, not necessarily the entire Cockpit message',
          items: [delivery.content] },
      });
    }
  }
  return sources;
}

export function quoteContext(job, store, config) {
  const sources = localSources(job, store, config);
  return job.quotes.map(quote => {
    const id = quote.svrId ?? quote.itemId;
    const matches = id ? sources.filter(source => source.ids.includes(id)) : [];
    // The same numeric ID can occur in unrelated namespaces. Never pick by text similarity.
    const unique = new Map(matches.map(match => [match.key, match.source]));
    if (matches.length && quote.svrId && quote.itemId && quote.svrId !== quote.itemId) {
      for (const match of sources.filter(source => source.ids.includes(quote.itemId))) {
        unique.set(match.key, match.source);
      }
    }
    const context = { ...quote, resolution: 'missing' };
    if (unique.size === 1) {
      context.resolution = 'exact-local-id';
      context.source = unique.values().next().value;
    } else {
      const provided = quote.provided;
      context.resolution = unique.size > 1 ? 'ambiguous-local-id'
        : provided?.body || provided?.transcript || quote.title ? 'weixin-provided' : 'missing';
      context.notice = unique.size > 1
        ? 'Conflicting local ID records; only Weixin-provided quote data may be used.'
        : 'No exact local ID mapping. Only Weixin-provided data is available; do not guess missing content.';
    }
    if (quote.selection) context.selectionNotice =
      'Partial quote boundaries are unverified Weixin metadata. Any local source is message context, not a verified selection.';
    return context;
  });
}

export function inputPrompt(job, store, config) {
  if (!job.quotes?.length) {
    return `[connector metadata: ${job.marker}; original user text follows unchanged]\n\n${job.original}`;
  }
  return quotedInput(job, quoteContext(job, store, config));
}

export function retainedQuoteAttachments(job, store, config) {
  if (!job.quotes?.length) return [];
  return quoteContext(job, store, config).flatMap(context => context.resolution === 'exact-local-id'
    ? context.source.items.flatMap(item => item.attachment ? [item.attachment] : []) : []);
}

export function inputParts(job, store, config) {
  const parts = [];
  const addText = text => {
    if (parts.at(-1)?.type === 'text') parts.at(-1).text += text;
    else parts.push({ type: 'text', text });
  };
  if (job.inputItems) {
    addText(inputPrompt({ ...job, original: '' }, store, config));
    for (const [index, item] of job.inputItems.entries()) {
      if (index) addText('\n');
      if (item.type === 'text') addText(item.text);
      else {
        const attachment = job.retainedMedia?.[item.index];
        requireThat(attachment, 'RETAINED_MEDIA_MISSING');
        parts.push({ type: 'file', attachment });
      }
    }
  } else {
    // Compatibility for an unpublished/older saved media input without item order.
    for (const attachment of Object.values(job.retainedMedia ?? {})) parts.push({ type: 'file', attachment });
    addText(inputPrompt(job, store, config));
  }
  const attached = new Set(parts.flatMap(part => part.type === 'file' ? [part.attachment.url] : []));
  for (const attachment of retainedQuoteAttachments(job, store, config)) {
    if (attached.has(attachment.url)) continue;
    addText('\n[引用原件附件，仅作背景；尚未声明模型已读取]\n');
    parts.push({ type: 'file', attachment });
    attached.add(attachment.url);
  }
  return parts;
}

export function recordDelivery(job, part, receipt) {
  if (!receipt?.messageId) return;
  const content = part.kind !== 'image' && part.kind !== 'media'
    ? { type: 'text', body: quoteText(part.value) }
    : { type: part.nativeKind ?? 'image', publishedPath: part.uploadPath, mediaNotFetched: true, contentMissing: true,
      ...(part.attachment ? { attachment: part.attachment } : {}) };
  job.deliveries = [...(job.deliveries ?? []), {
    messageId: receipt.messageId, clientId: part.clientId, content,
  }];
}
