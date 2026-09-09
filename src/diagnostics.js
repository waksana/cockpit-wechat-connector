import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { object, requireThat } from './common.js';
import { privateDirectory, secureExisting } from './storage.js';

export const DIAGNOSTIC_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_MAX_BYTES = 100 * 1024 * 1024;
const hidden = '[REDACTED]';
const secretKey = /token|ticket|password|secret|authorization|cookie|aes.?key|encrypt.*param|upload.*(?:param|url)|qrcode|sync_buf|get_updates_buf|filekey/i;
const safeHeader = /^(?:content-type|content-length|date|server|x-request-id|x-correlation-id)$/i;

function secretValues(value, found = []) {
  if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return found;
  for (const [key, item] of Object.entries(value)) {
    if (secretKey.test(key) && typeof item === 'string' && item.length) found.push(item);
    else secretValues(item, found);
  }
  return found;
}

function parseRaw(raw) {
  return JSON.parse(raw, (_key, value, context) =>
    typeof value === 'number' && (!Number.isSafeInteger(value))
      ? JSON.rawJSON(context.source) : value);
}

export function sanitizeTraffic(event, binding, knownSecrets = []) {
  const secrets = new Set(knownSecrets.filter(value => typeof value === 'string' && value.length));
  let parsed;
  let bodyEncoding = event.body == null ? 'none' : 'json';
  if (event.body != null) {
    try { parsed = parseRaw(event.body); }
    catch { bodyEncoding = 'non-json-omitted'; }
  }
  for (const secret of secretValues(parsed)) secrets.add(secret);
  const cleanText = text => {
    for (const secret of secrets) text = text.replaceAll(secret, hidden);
    return text;
  };
  const clean = value => {
    if (typeof value === 'string') return cleanText(value);
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
    if (Array.isArray(value)) return value.map(clean);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (secretKey.test(key)) return [key, hidden];
      if (key === 'msgs' && Array.isArray(item)) {
        return [key, item.map(message => object(message)
          && message.from_user_id === binding.allowedPeer && message.to_user_id === binding.allowedAccount
          && message.message_type === 1 && !message.group_id
          ? clean(message) : { omitted: 'outside-authorized-binding' })];
      }
      return [key, clean(item)];
    }));
  };
  const url = new URL(event.url);
  url.username = ''; url.password = ''; url.hash = '';
  for (const key of url.searchParams.keys()) url.searchParams.set(key, hidden);
  const headers = Object.fromEntries(new Headers(event.headers).entries().map(([key, value]) =>
    [key, safeHeader.test(key) ? cleanText(value) : hidden]));
  return {
    ...event, url: cleanText(url.toString()), headers, bodyEncoding,
    body: bodyEncoding === 'json' ? JSON.stringify(clean(parsed)) : null,
    ...(bodyEncoding === 'non-json-omitted' ? {
      bodyBytes: Buffer.byteLength(event.body), bodySha256: createHash('sha256').update(event.body).digest('hex'),
    } : {}),
  };
}

// Separate diagnostics from delivery state: an observation failure must never turn
// an accepted send into "unknown" or provoke a retry. Report failures without payloads.
export class HttpDiagnostics {
  constructor(config, { secrets = [], now = Date.now, warn = code => console.error(code) } = {}) {
    this.file = path.join(config.stateDir, 'weixin-http-diagnostics.sqlite');
    this.config = config; this.secrets = secrets; this.now = now; this.warn = warn;
    this.lastWarning = null;
    this.maintain();
  }
  database(action) {
    privateDirectory(this.config.stateDir);
    if (!fs.existsSync(this.file)) fs.closeSync(fs.openSync(this.file, 'wx', 0o600));
    secureExisting(this.file);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      if (fs.existsSync(this.file + suffix)) secureExisting(this.file + suffix);
    }
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS traffic (
          seq INTEGER PRIMARY KEY, recorded_at INTEGER NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS traffic_recorded_at ON traffic(recorded_at);`);
      return action(db);
    } finally { db.close(); }
  }
  report(code) {
    if (this.lastWarning !== code) this.warn(code);
    this.lastWarning = code;
  }
  prune(db) {
    db.prepare('DELETE FROM traffic WHERE recorded_at <= ?').run(this.now() - DIAGNOSTIC_RETENTION_MS);
  }
  maintain() {
    try { this.database(db => this.prune(db)); }
    catch { this.report('WEIXIN_DIAGNOSTICS_STORAGE_FAILED'); }
  }
  record(event, requestBody) {
    try {
      const data = JSON.stringify(sanitizeTraffic(event, this.config.weixin,
        [...this.secrets, ...secretValues(requestBody)]));
      const bytes = Buffer.byteLength(data);
      requireThat(bytes <= DIAGNOSTIC_MAX_BYTES, 'DIAGNOSTIC_RECORD_TOO_LARGE');
      this.database(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          this.prune(db);
          db.prepare('INSERT INTO traffic(recorded_at,bytes,data) VALUES(?,?,?)').run(this.now(), bytes, data);
          let total = db.prepare('SELECT COALESCE(SUM(bytes),0) n FROM traffic').get().n;
          if (total > DIAGNOSTIC_MAX_BYTES) {
            for (const row of db.prepare('SELECT seq,bytes FROM traffic ORDER BY seq').all()) {
              if (total <= DIAGNOSTIC_MAX_BYTES) break;
              db.prepare('DELETE FROM traffic WHERE seq=?').run(row.seq);
              total -= row.bytes;
            }
            this.report('WEIXIN_DIAGNOSTICS_SIZE_LIMIT_OLDEST_REMOVED');
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    } catch { this.report('WEIXIN_DIAGNOSTICS_RECORD_FAILED'); }
  }
}
