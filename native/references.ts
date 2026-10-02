import { fromMarkdown } from 'mdast-util-from-markdown';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './transport.js';
import { noSymlinks, readRegularFile, saveSnapshot, type Snapshot } from './media.js';

export interface CaptureOptions {
  cwd: string;
  allowedRoots: string[];
  deniedRoots: string[];
  directory: string;
}
interface Node {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  alt?: string | null;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface Reference { url: string; name: string; start: number; end: number }
function local(url: string): boolean {
  return !url.startsWith('#') && !url.startsWith('?') && !url.startsWith('//')
    && (!/^[a-z][a-z0-9+.-]*:/iu.test(url) || /^file:/iu.test(url));
}
function nodeText(node: Node): string {
  return node.alt ?? node.value ?? node.children?.map(nodeText).join('') ?? '';
}
function references(text: string): Reference[] {
  assert(typeof text === 'string' && text.length <= 1_000_000, 'REFERENCE_TEXT_TOO_LARGE');
  const tree: Node = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const visit = (node: Node, action: (node: Node) => void) => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return;
    action(node);
    for (const child of node.children ?? []) visit(child, action);
  };
  visit(tree, node => {
    if (node.type === 'definition' && node.identifier && node.url !== undefined && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
  });
  const result: Reference[] = [];
  visit(tree, node => {
    if (!['link', 'image', 'linkReference', 'imageReference'].includes(node.type)) return;
    const url = node.url ?? definitions.get(node.identifier ?? '');
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (url && local(url) && start !== undefined && end !== undefined)
      result.push({ url, name: nodeText(node), start, end });
  });
  assert(result.length <= 100, 'TOO_MANY_FILE_REFERENCES');
  return result.sort((a, b) => a.start - b.start);
}
export function hasLocalReferences(text: string): boolean { return references(text).length > 0; }
function within(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder));
}
function credentialPath(target: string): boolean {
  const parts = target.split(sep);
  return parts.some(part => /^(?:\.env(?:[.-].*)?|\.ssh|\.copilot|\.cockpit|\.config|\.docker|\.password-store|\.aws|\.azure|\.kube|\.gnupg|\.gcloud|\.git|\.npmrc|\.netrc|\.git-credentials|\.bash_history|\.zsh_history|credentials(?:[.-].*)?|secrets?(?:[.-].*)?|tokens?(?:[.-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/iu.test(part))
    || /\.(?:pem|key|p12|pfx|keystore)$/iu.test(target)
    || /(?:^|[/\\])(?:config|auth|accounts?)(?:[.-](?:tokens?|secrets?|credentials))?(?:\.json|\.ya?ml|\.toml|\.ini)$/iu.test(target);
}
function sourcePath(url: string, cwd: string): string {
  assert(!/[\x00-\x1f\x7f]/u.test(url), 'FILE_REFERENCE_INVALID');
  if (/^file:/iu.test(url)) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('FILE_REFERENCE_INVALID'); }
    assert(!parsed.search && !parsed.hash && !parsed.username && !parsed.password && !parsed.hostname, 'FILE_REFERENCE_INVALID');
    return fileURLToPath(parsed);
  }
  let decoded: string;
  try { decoded = decodeURIComponent(url); } catch { throw new Error('FILE_REFERENCE_INVALID'); }
  assert(!/[\x00-\x1f\x7f]/u.test(decoded), 'FILE_REFERENCE_INVALID');
  assert(isAbsolute(decoded) || isAbsolute(cwd), 'REFERENCE_CWD_REQUIRED');
  return resolve(cwd, decoded);
}
export async function captureReferences(text: string, options: CaptureOptions, signal?: AbortSignal):
Promise<{ text: string; files: Snapshot[] }> {
  const found = references(text);
  if (!found.length) return { text, files: [] };
  signal?.throwIfAborted();
  assert(options.allowedRoots.length > 0, 'FILE_ROOT_REQUIRED');
  const allowed = await Promise.all(options.allowedRoots.map(async root => {
    assert(isAbsolute(root), 'FILE_ROOT_REQUIRED');
    await noSymlinks(root);
    assert((await lstat(root)).isDirectory(), 'FILE_ROOT_REQUIRED');
    return realpath(root);
  }));
  const denied: string[] = [];
  for (const root of [...options.deniedRoots, options.directory]) {
    assert(isAbsolute(root), 'FILE_ROOT_REQUIRED');
    denied.push(resolve(root));
    try { denied.push(await realpath(root)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const files: Snapshot[] = [];
  const replacements: { start: number; end: number; text: string }[] = [];
  try {
    let total = 0;
    for (const reference of found) {
      signal?.throwIfAborted();
      const target = sourcePath(reference.url, options.cwd);
      assert(!credentialPath(target) && allowed.some(root => within(root, target))
        && !denied.some(root => within(root, target)), 'FILE_REFERENCE_REFUSED');
      await noSymlinks(target);
      const canonical = await realpath(target);
      assert(canonical === target && !credentialPath(canonical) && allowed.some(root => within(root, canonical))
        && !denied.some(root => within(root, canonical)), 'FILE_REFERENCE_REFUSED');
      const bytes = await readRegularFile(canonical, signal);
      total += bytes.length;
      assert(total <= 100 * 1024 * 1024, 'REFERENCE_BATCH_TOO_LARGE');
      const file = await saveSnapshot(bytes, canonical.split(sep).at(-1)!, options.directory, signal);
      files.push(file);
      replacements.push({ start: reference.start, end: reference.end, text: reference.name || file.name });
    }
    let result = text;
    let lastStart = text.length;
    for (const replacement of replacements.toReversed()) {
      if (replacement.end > lastStart) continue;
      result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
      lastStart = replacement.start;
    }
    return { text: result, files };
  } catch (error) {
    for (const file of files) await unlink(file.path).catch(() => {});
    throw error;
  }
}
