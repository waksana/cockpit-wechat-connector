import { requireThat } from './common.js';

const uploadPath = /^\/uploads\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/u;

function targetUrl(target, webUrl) {
  if (uploadPath.test(target)) {
    const base = new URL(webUrl);
    if (base.protocol !== 'https:') return null;
    return new URL(target, base).href;
  }
  if (!/^https:\/\//u.test(target)) return null;
  let url;
  try { url = new URL(target); } catch { return null; }
  if (url.username || url.password || /[\s\\]/u.test(target)) return null;
  // Do not canonicalize a traversal or encoded path into an apparently safe upload.
  const rawPath = target.slice(target.indexOf('/', 'https://'.length));
  if (rawPath.startsWith('/uploads/') || url.pathname.startsWith('/uploads/')) {
    if (!uploadPath.test(rawPath)) return null;
  }
  return target;
}

function label(value, image) {
  const clean = value.replace(/[\r\n\t]/gu, ' ').trim();
  // A Markdown label can itself be a local path; do not publish that as a label.
  if (!clean || /(?:\/home\/|file:|sandbox:|[A-Za-z]:\\)/u.test(clean)) return image ? '图片' : '文件';
  return [...clean].slice(0, 80).join('');
}

export function renderWeixinAttachment(attachment, webUrl) {
  const image = attachment.kind === 'image';
  const name = label(attachment.name, image);
  const url = targetUrl(attachment.url, webUrl);
  return url ? `${name}${image ? '（原文件链接）' : ''}：\n${url}\n`
    : `${name}（此引用暂不支持微信打开，请在 Cockpit 网页查看）`;
}

export function renderWeixinLinks(content, webUrl, predefinedReferences = new Map()) {
  requireThat(typeof content === 'string', 'INVALID_REPLY_TEXT');
  requireThat(content.length <= 1000000, 'EMPTY_OR_OVERSIZED_REPLY');
  const references = new Map(predefinedReferences);
  const key = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();
  const render = (image, title, target) => {
    const name = label(title, image);
    const url = targetUrl(target, webUrl);
    return url ? `${name}${image ? '（原文件链接）' : ''}：\n${url}\n`
      : `${name}（此引用暂不支持微信打开，请在 Cockpit 网页查看）`;
  };
  let result = content.replace(/^[ \t]{0,3}\[([^[\]\n]{1,200})\]:[ \t]*(?:<([^>\n]{1,2048})>|(\S{1,2048}))(?:[ \t]+["'][^\n]*["'])?[ \t]*$/gmu,
    (_match, id, angle, bare) => { references.set(key(id), angle ?? bare); return ''; });
  result = result.replace(/(!?)\[([^[\]\n]{0,200})\]\(\s*(?:<([^>\n]{1,2048})>|([^\s()[\]]{0,2048}))(?:[ \t]+["'][^"\n]*["'])?\s*\)/gu,
    (_match, bang, title, angle, bare) => render(Boolean(bang), title, angle ?? bare));
  result = result.replace(/(!?)\[([^[\]\n]{0,200})\]\([^)[\]\n]{0,2048}\)/gu,
    (_match, bang, title) => render(Boolean(bang), title, ''));
  result = result.replace(/(!?)\[([^[\]\n]{1,200})\]\[([^[\]\n]{0,200})\]/gu,
    (_match, bang, title, ref) => render(Boolean(bang), title, references.get(key(ref || title)) ?? ''));
  result = result.replace(/(!?)\[([^[\]\n]{1,200})\]/gu, (match, bang, title) => {
    const target = references.get(key(title));
    return target || bang ? render(Boolean(bang), title, target ?? '') : match;
  });
  // Plain upload references are also useful, but never rewrite a suffix of an external URL.
  result = result.replace(/(^|[\s(（])((?:\/uploads\/)[^\s<>"'）)]+)/gu,
    (_match, prefix, target) => `${prefix}${targetUrl(target, webUrl)
      ?? '（此文件引用暂不支持微信打开，请在 Cockpit 网页查看）'}`);
  return result;
}
