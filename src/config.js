import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, object, requireThat, text } from './common.js';
import { createHash } from 'node:crypto';
import { routeConfig } from './module-state.js';

export const DEFAULT_ORIGIN = 'https://ilinkai.weixin.qq.com';

function origin(value, localAllowed) {
  requireThat(text(value), 'INVALID_ORIGIN');
  let url;
  try { url = new URL(value); } catch { throw new BridgeError('INVALID_ORIGIN'); }
  requireThat(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'INVALID_ORIGIN');
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  requireThat(url.protocol === 'https:' || (localAllowed && loopback && url.protocol === 'http:'), 'HTTPS_REQUIRED');
  return url.origin;
}

export function validateApiOrigin(value, approved) {
  const normalized = origin(value, false);
  const host = new URL(normalized).hostname;
  requireThat(host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com'), 'UNTRUSTED_WEIXIN_HOST');
  requireThat(new URL(normalized).port === '', 'UNTRUSTED_WEIXIN_PORT');
  if (approved) requireThat(approved.includes(normalized), 'WEIXIN_ORIGIN_NOT_APPROVED');
  return normalized;
}

export function validateConfig(raw, configPath) {
  requireThat(object(raw) && object(raw.cockpit) && object(raw.weixin), 'INVALID_CONFIG');
  const allowed = raw.weixin.approvedApiOrigins;
  requireThat(Array.isArray(allowed) && allowed.length > 0 && allowed.length <= 10, 'INVALID_API_ALLOWLIST');
  const approved = allowed.map(value => validateApiOrigin(value));
  requireThat(approved.includes(DEFAULT_ORIGIN), 'LOGIN_ORIGIN_REQUIRED');
  for (const field of ['sessionId', 'cwd']) requireThat(typeof raw.cockpit[field] === 'string', 'INVALID_CONFIG');
  requireThat(raw.cockpit.tokenFile === undefined || (text(raw.cockpit.tokenFile, 4096)
    && path.isAbsolute(raw.cockpit.tokenFile) && path.resolve(raw.cockpit.tokenFile) === raw.cockpit.tokenFile
    && !/[\0\r\n]/.test(raw.cockpit.tokenFile)), 'INVALID_COCKPIT_TOKEN_FILE');
  for (const field of ['allowedAccount', 'allowedPeer']) requireThat(typeof raw.weixin[field] === 'string', 'INVALID_CONFIG');
  requireThat(raw.deliveryMode === undefined || ['correlated', 'session'].includes(raw.deliveryMode), 'INVALID_DELIVERY_MODE');
  requireThat(raw.nativeInterruptFollowup === undefined || typeof raw.nativeInterruptFollowup === 'boolean',
    'INVALID_NATIVE_INTERRUPT_FOLLOWUP');
  requireThat(!raw.nativeInterruptFollowup || raw.deliveryMode === 'session', 'INTERRUPT_REQUIRES_SESSION_MODE');
  requireThat(raw.statusDisplay === undefined || object(raw.statusDisplay), 'INVALID_STATUS_DISPLAY');
  requireThat(raw.diagnostics === undefined || (object(raw.diagnostics)
    && Object.keys(raw.diagnostics).every(key => key === 'weixinHttp')
    && typeof raw.diagnostics.weixinHttp === 'boolean'), 'INVALID_DIAGNOSTICS');
  const statusDisplay = {
    typing: raw.deliveryMode === 'session', tools: false,
    toolFormat: 'native', ...raw.statusDisplay,
  };
  requireThat(typeof statusDisplay.typing === 'boolean' && typeof statusDisplay.tools === 'boolean'
    && ['text', 'native'].includes(statusDisplay.toolFormat)
    && Object.keys(statusDisplay).every(key => ['typing', 'tools', 'toolFormat'].includes(key)), 'INVALID_STATUS_DISPLAY');
  if (statusDisplay.tools || statusDisplay.toolFormat === 'text') {
    throw new BridgeError('TOOL_PROGRESS_RETIRED',
      'WeChat tool-progress messages (native and text fallback) are retired. Remove statusDisplay.tools/toolFormat or use tools:false with toolFormat:"native"; typing remains supported.');
  }
  const limits = { requestTimeoutMs: 15000, resultTimeoutMs: 900000, statusIntervalMs: 2000,
    maxQueued: 100, textBytes: 1800, maxReplyParts: 32, ...raw.limits };
  for (const [key, min, max] of [
    ['requestTimeoutMs', 100, 120000], ['resultTimeoutMs', 1000, 86400000],
    ['statusIntervalMs', 20, 60000], ['maxQueued', 1, 1000],
    ['textBytes', 128, 4000], ['maxReplyParts', 1, 100],
  ]) requireThat(Number.isInteger(limits[key]) && limits[key] >= min && limits[key] <= max, 'INVALID_LIMITS');
  for (const key of ['stateDir', 'credentialFile', 'lockDir']) {
    requireThat(raw[key] === undefined || (text(raw[key], 4096) && path.isAbsolute(raw[key])
      && path.resolve(raw[key]) === raw[key] && !/[\0\r\n]/.test(raw[key])), 'INVALID_STATE_PATH');
  }
  requireThat(raw.moduleManaged === undefined || typeof raw.moduleManaged === 'boolean', 'INVALID_MODULE_MODE');
  const stateDir = raw.stateDir ?? path.join(path.dirname(path.resolve(configPath)), '.bridge-state');
  const credentialFile = raw.credentialFile ?? path.join(stateDir, 'credentials.json');
  const lockDir = raw.lockDir ?? stateDir;
  if (raw.moduleManaged) {
    requireThat(raw.stateDir && raw.credentialFile && raw.lockDir
      && raw.cockpit.sessionId === '' && raw.cockpit.cwd === '', 'MODULE_REFERENCE_REQUIRED');
    const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    requireThat(!overlaps(stateDir, lockDir) && !overlaps(stateDir, credentialFile)
      && !overlaps(lockDir, credentialFile), 'MODULE_PATHS_OVERLAP');
  }
  return {
    deliveryMode: raw.deliveryMode ?? 'correlated',
    nativeInterruptFollowup: raw.nativeInterruptFollowup ?? false,
    statusDisplay,
    diagnostics: { weixinHttp: raw.diagnostics?.weixinHttp ?? false },
    cockpit: { ...raw.cockpit, apiUrl: origin(raw.cockpit.apiUrl, true), webUrl: origin(raw.cockpit.webUrl, true) },
    weixin: { ...raw.weixin, approvedApiOrigins: approved },
    limits,
    stateDir, credentialFile, lockDir,
    ...(raw.moduleManaged ? {
      moduleManaged: true, moduleStateRoot: stateDir, configPath: path.resolve(configPath),
      configDigest: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    } : {}),
  };
}

export function loadConfig(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new BridgeError('CONFIG_READ_FAILED', 'Cannot read config; see config.example.json.'); }
  return routeConfig(validateConfig(raw, file));
}

export function assertBinding(config, credentials) {
  const { sessionId, cwd } = config.cockpit;
  const { allowedAccount, allowedPeer, approvedApiOrigins } = config.weixin;
  requireThat(text(sessionId, 200) && !/[\s/*\\]/u.test(sessionId) && path.isAbsolute(cwd), 'TARGET_NOT_BOUND');
  requireThat(text(allowedAccount, 200) && text(allowedPeer, 200)
    && !/[\s*]/u.test(allowedAccount + allowedPeer), 'WEIXIN_NOT_BOUND');
  requireThat(object(credentials) && text(credentials.token) && text(credentials.account)
    && text(credentials.peer) && text(credentials.baseUrl), 'LOGIN_REQUIRED');
  requireThat(credentials.account === allowedAccount && credentials.peer === allowedPeer, 'CREDENTIAL_BINDING_MISMATCH');
  validateApiOrigin(credentials.baseUrl, approvedApiOrigins);
}
