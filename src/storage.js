import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BridgeError, object, requireThat, text } from './common.js';

export function secureExisting(file, directory = false) {
  const stat = fs.lstatSync(file);
  requireThat(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'UNSAFE_STATE_PATH');
  requireThat(stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'INSECURE_STATE_PERMISSIONS');
  if (!directory) requireThat(stat.nlink === 1, 'UNSAFE_STATE_LINK');
}

export function privateDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  secureExisting(dir, true);
}

export function readPrivate(file) {
  if (!fs.existsSync(file)) return null;
  secureExisting(file);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new BridgeError('INVALID_PRIVATE_FILE'); }
  requireThat(object(parsed), 'INVALID_PRIVATE_FILE');
  return parsed;
}

export function writePrivate(file, data) {
  if (fs.existsSync(file)) secureExisting(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export class Store {
  constructor(dir) {
    privateDirectory(dir);
    this.dir = dir;
    const file = path.join(dir, 'bridge.sqlite');
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    secureExisting(file);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(file + suffix)) secureExisting(file + suffix);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, data TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  get(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  set(key, value) {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  jobs() {
    return this.db.prepare('SELECT data FROM jobs ORDER BY seq').all().map(row => JSON.parse(row.data));
  }
  job(id) {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
    return row ? JSON.parse(row.data) : null;
  }
  save(job) {
    requireThat(this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id).changes === 1, 'JOB_NOT_FOUND');
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  ingest(jobs, cursor, maxQueued, clearPendingBatch = false) {
    return this.transaction(() => {
      let seq = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM jobs').get().n;
      const active = this.jobs().filter(job => !['done', 'rejected', 'abandoned'].includes(job.status)).length;
      const unique = new Map();
      const payload = (job, legacy = false) => JSON.stringify([
        job.peer, job.kind, job.original, job.status === 'rejected' ? job.reason : null, job.quotes ?? null,
        ...(legacy ? [] : [job.mediaFingerprint
          ?? (job.media ? createHash('sha256').update(JSON.stringify(job.media)).digest('hex') : null)]),
      ]);
      for (const job of jobs) {
        const previous = unique.get(job.id) ?? this.job(job.id);
        if (previous) {
          if (previous.inputVersion === undefined && !previous.media && !previous.mediaFingerprint && job.inputVersion === 2) {
            // Old unsupported media was never read. Compare its original projection,
            // without upgrading the durable job or replaying it as a new media input.
            requireThat(job.legacyInput && payload(previous, true)
              === payload({ ...job, ...job.legacyInput }, true), 'DUPLICATE_MESSAGE_CHANGED');
          } else {
            requireThat(payload(previous) === payload(job), 'DUPLICATE_MESSAGE_CHANGED');
            if (previous.inputVersion === 2) requireThat(job.inputVersion === 2
              && JSON.stringify(previous.inputItems ?? null) === JSON.stringify(job.inputItems ?? null), 'DUPLICATE_MESSAGE_CHANGED');
          }
          if (previous.quoteItems && job.quoteItems) requireThat(
            JSON.stringify(previous.quoteItems) === JSON.stringify(job.quoteItems), 'DUPLICATE_MESSAGE_CHANGED');
        }
        else unique.set(job.id, job);
      }
      const fresh = [...unique.values()];
      requireThat(active + fresh.filter(job => job.status !== 'rejected').length <= maxQueued, 'INBOX_FULL');
      for (const job of fresh) {
        this.db.prepare('INSERT OR IGNORE INTO jobs VALUES (?,?,?)').run(job.id, ++seq, JSON.stringify(job));
      }
      // Inbox records and cursor advance are one durable SQLite transaction.
      if (cursor) this.set('cursor', cursor);
      if (clearPendingBatch) this.set('pendingBatch', null);
      return fresh.length;
    });
  }
  recover() {
    const round = this.get('nativeFollowup');
    if (round && round.phase !== 'blocked') {
      this.transaction(() => {
        round.reason = round.phase === 'requesting' ? 'INTERRUPT_OUTCOME_UNKNOWN' : 'INTERRUPT_RECOVERY_REQUIRED';
        round.phase = 'blocked'; this.set('nativeFollowup', round);
        const job = this.job(round.leaderId);
        requireThat(job, 'INTERRUPT_INBOX_MISSING');
        job.status = 'blocked'; job.reason = round.reason; this.save(job);
      });
    }
    for (const job of this.jobs()) {
      if (job.status === 'prompting') {
        job.status = 'blocked'; job.reason = 'PROMPT_OUTCOME_UNKNOWN'; this.save(job);
      } else if (job.outbox?.some(part => part.status === 'sending')) {
        for (const part of job.outbox) if (part.status === 'sending') part.status = 'unknown';
        job.status = 'blocked'; job.reason = 'WEIXIN_OUTCOME_UNKNOWN'; this.save(job);
      }
    }
  }
  summary() {
    const display = this.get('statusDisplay');
    const phases = Object.values(display?.tools ?? {}).flatMap(tool => [tool.start, tool.end, tool.snapshot]).filter(Boolean);
    return {
      cursorSaved: Boolean(this.get('cursor')),
      bindingSaved: Boolean(this.get('binding')),
      nativeFollowup: this.get('nativeFollowup'),
      statusDisplay: display ? {
        typingMayBeActive: Boolean(display.typingMayBeActive),
        toolProgressAccepted: phases.filter(phase => phase.status === 'accepted').length,
        toolProgressSubmitted: phases.filter(phase => phase.status === 'submitted').length,
        toolProgressUnknown: phases.filter(phase => phase.status === 'unknown').length,
        toolsPaused: Boolean(display.pausedContext), lastToolError: display.lastToolError ?? null,
      } : null,
      jobs: this.jobs().map(job => ({
        id: job.id, marker: job.marker, status: job.status, reason: job.reason,
        parts: job.outbox?.map(part => part.status),
      })),
    };
  }
}

export class RunLock {
  constructor(dir, { drain = false } = {}) {
    privateDirectory(dir);
    this.file = path.join(dir, 'run.lock');
    this.stopFile = path.join(dir, 'stop.json');
    this.nonce = randomUUID();
    let fd;
    try { fd = fs.openSync(this.file, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new BridgeError('LOCKED', 'Already running or stale lock; inspect status/unlock.');
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.nonce, ...(drain ? { drainProtocol: 1 } : {}) }));
      fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
  }
  stopRequested() { return readPrivate(this.stopFile)?.nonce === this.nonce; }
  release() {
    if (readPrivate(this.file)?.nonce === this.nonce) fs.unlinkSync(this.file);
    if (readPrivate(this.stopFile)?.nonce === this.nonce) fs.unlinkSync(this.stopFile);
  }
  static requestStop(dir, { requireDrain = false } = {}) {
    const lock = readPrivate(path.join(dir, 'run.lock'));
    requireThat(lock && text(lock.nonce), 'NOT_RUNNING');
    requireThat(!requireDrain || lock.drainProtocol === 1, 'RUNNER_DRAIN_UNAVAILABLE');
    writePrivate(path.join(dir, 'stop.json'), { nonce: lock.nonce });
  }
  static unlock(dir) {
    const file = path.join(dir, 'run.lock');
    const lock = readPrivate(file);
    requireThat(lock && Number.isSafeInteger(lock.pid) && lock.pid > 0, 'INVALID_LOCK');
    try { process.kill(lock.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { fs.unlinkSync(file); return; }
      throw error;
    }
    throw new BridgeError('LOCK_PROCESS_EXISTS', 'PID still exists; do not unlock or kill an unverified process.');
  }
}
