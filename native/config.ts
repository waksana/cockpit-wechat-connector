import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { invariant } from './state.js';

export interface Config {
  enabled: boolean;
  exclusiveAccountConfirmed: boolean;
  account: string;
  peer: string;
  fileRoots: string[];
  webUrl: string;
}
export function readConfig(raw: Readonly<Record<string, unknown>>): { config: Config; reasons: string[] } {
  const reasons: string[] = [];
  if (raw.enabled !== true) reasons.push('CONSUMPTION_NOT_ENABLED');
  if (raw.exclusiveAccountConfirmed !== true) reasons.push('EXCLUSIVE_ACCOUNT_NOT_CONFIRMED');
  const identifier = (value: unknown): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f]/u.test(value);
  if (!identifier(raw.account)) reasons.push('ACCOUNT_REQUIRED');
  if (!identifier(raw.peer)) reasons.push('PEER_REQUIRED');
  const roots = Array.isArray(raw.fileRoots) && raw.fileRoots.every(root => typeof root === 'string' && isAbsolute(root))
    ? raw.fileRoots : [];
  if (!Array.isArray(raw.fileRoots) || roots.length !== raw.fileRoots.length || roots.length > 16) reasons.push('FILE_ROOTS_REQUIRED');
  let webUrl = '';
  try {
    const url = new URL(typeof raw.webUrl === 'string' ? raw.webUrl : '');
    invariant(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash, 'WEB_URL_INVALID');
    webUrl = url.origin;
  } catch { reasons.push('WEB_URL_INVALID'); }
  return { config: { enabled: raw.enabled === true, exclusiveAccountConfirmed: raw.exclusiveAccountConfirmed === true,
    account: identifier(raw.account) ? raw.account : '', peer: identifier(raw.peer) ? raw.peer : '', fileRoots: roots, webUrl }, reasons };
}
export function credentials(root: string, config: Config): { token: string; account: string; peer: string } {
  // The only credential file consulted; no profiles, environment, or native homes.
  const fd = openSync(join(root, 'credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    invariant(stat.isFile() && stat.nlink === 1 && stat.size <= 16_384
      && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'CREDENTIAL_PERMISSIONS');
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    invariant(value.account === config.account && value.peer === config.peer
      && typeof value.token === 'string' && /^[\x21-\x7e]{1,8192}$/u.test(value.token), 'CREDENTIAL_IDENTITY');
    return { token: value.token, account: value.account, peer: value.peer };
  } finally { closeSync(fd); }
}
export function identity(config: Config): string {
  return createHash('sha256').update(JSON.stringify([config.account, config.peer])).digest('hex');
}
export async function accountLease(account: string): Promise<Server> {
  invariant(process.platform === 'linux', 'LINUX_REQUIRED');
  const name = createHash('sha256').update(account).digest('hex');
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\0cockpit-wechat-v1-${name}`, () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  return server;
}
