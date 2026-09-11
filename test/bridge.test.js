import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, incoming, credentials } from './helpers.js';
import { Store, RunLock, writePrivate } from '../src/storage.js';
import { Bridge, resolveJob } from '../src/bridge.js';
import { validateConfig, assertBinding, validateApiOrigin } from '../src/config.js';
import { normalizeBatch, login, WeixinClient, sendSuccess } from '../src/weixin.js';
import { requestJson } from '../src/http.js';
import { splitText, errorCode } from '../src/common.js';
import { correlate, quiescent } from '../src/cockpit.js';

test('real local HTTP mocks: enqueue -> authoritative reply; accepted and early idle are not completion', async t => {
  const f = await fixture(t, { earlyIdle: true });
  await f.cockpit.capabilities();
  const meta = await f.cockpit.meta();
  assert.equal(Object.hasOwn(meta, 'error'), false, 'current loaded metadata has no last-error getter');
  assert.equal(quiescent(meta), true);
  await f.bridge.receive();
  await f.bridge.step();
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, 'enqueue');
  assert.ok(f.prompts[0].text.endsWith('\n\n你好，请答复'));
  await f.bridge.step();
  assert.equal(f.store.jobs()[0].status, 'accepted');
  assert.equal(f.sent.length, 0);
  f.finish('中文回复🙂');
  await f.bridge.step();
  assert.equal(f.sent.length, 0);
  await f.drain();
  assert.equal(f.sent[0].msg.item_list[0].text_item.text, '中文回复🙂');
  assert.equal(f.sent[0].msg.context_token, 'FAKE_CONTEXT');
  assert.equal(f.sent[0].msg.to_user_id, credentials.peer);
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.ok(f.requests.every(r => !r.url.includes('cancel') && !r.url.includes('new')));
});

test('Unicode byte-bound chunks preserve text and send one persistent client ID per part', async t => {
  const f = await fixture(t);
  await f.bridge.receive(); await f.bridge.step();
  const value = '这是测试中文🙂'.repeat(40);
  f.finish(value); await f.drain(100);
  assert.ok(f.sent.length > 1);
  const chunks = f.sent.map(row => row.msg.item_list[0].text_item.text);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 128));
  assert.equal(chunks.map(chunk => chunk.replace(/^\[\d+\/\d+\] /u, '')).join(''), value);
  assert.equal(new Set(f.sent.map(row => row.msg.client_id)).size, f.sent.length);
});

test('durable duplicate batch handling and cursor resume after restart', async t => {
  const f = await fixture(t, { repeatBatch: true });
  await f.bridge.receive(); await f.bridge.receive();
  assert.equal(f.store.jobs().length, 1);
  f.closeStore();
  const reopened = new Store(f.config.stateDir);
  try {
    const bridge = new Bridge(f.config, credentials, reopened, f.weixin, f.cockpit, { log() {} });
    bridge.bind(); await bridge.receive(); await bridge.step();
    assert.equal(f.prompts.length, 1);
    assert.equal(f.requests.filter(r => r.url.includes('getupdates')).at(-1).data.get_updates_buf, 'cursor-1');
    assert.equal(reopened.jobs().length, 1);
  } finally { reopened.close(); }
});

test('batch insert and cursor advance roll back together on changed duplicate or queue overflow', async t => {
  const f = await fixture(t);
  await f.bridge.receive();
  f.state.cursor = 'cursor-2';
  f.state.batch = [incoming({ message_id: 43 }), incoming({ item_list: [{ type: 1, text_item: { text: 'changed' } }] })];
  await assert.rejects(f.bridge.receive(), { code: 'DUPLICATE_MESSAGE_CHANGED' });
  assert.equal(f.store.get('cursor'), 'cursor-1');
  assert.equal(f.store.jobs().length, 1);
  f.store.set('pendingBatch', null);
  f.state.batch = [incoming({ message_id: 44 })];
  f.config.limits.maxQueued = 1;
  await assert.rejects(f.bridge.receive(), { code: 'INBOX_FULL' });
  assert.equal(f.store.get('cursor'), 'cursor-1');
});

test('out-of-range message IDs cannot advance the cursor', async t => {
  const f = await fixture(t, { batch: [incoming({ message_id: '18446744073709551616' })] });
  await assert.rejects(f.bridge.receive(), { code: 'STABLE_MESSAGE_ID_REQUIRED' });
  assert.equal(f.store.get('cursor'), null);
});

test('account/peer/group rejection and unsupported media notice without downloads or prompt', async t => {
  const f = await fixture(t, { batch: [
    incoming({ message_id: 1, from_user_id: 'outsider' }),
    incoming({ message_id: 2, to_user_id: 'other-bot' }),
    incoming({ message_id: 3, group_id: 'group-1' }),
    incoming({ message_id: 4, item_list: [{ type: 3, voice_item: { url: 'https://private.invalid' } }] }),
  ] });
  await f.bridge.receive(); await f.drain();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.store.jobs().filter(job => job.status === 'rejected').length, 3);
  assert.ok(f.sent[0].msg.item_list[0].text_item.text.includes('不支持的项目'));
  assert.ok(f.requests.every(req => !req.url.includes('upload') && !req.url.includes('private')));
});

for (const kind of ['prompt', 'send']) {
  test(`${kind} disconnect after remote acceptance stays unknown and is never retried after restart`, async t => {
    const f = await fixture(t, kind === 'prompt' ? { promptFault: 'disconnect' } : { sendFault: 'disconnect' });
    await f.bridge.receive();
    if (kind === 'send') {
      await f.bridge.step(); f.finish(); await f.bridge.step(); await f.bridge.step();
    }
    await assert.rejects(f.bridge.step(), { code: kind === 'prompt' ? 'PROMPT_OUTCOME_UNKNOWN' : 'WEIXIN_OUTCOME_UNKNOWN' });
    const count = kind === 'prompt' ? f.prompts.length : f.sent.length;
    f.store.recover();
    await assert.rejects(f.bridge.step());
    assert.equal(kind === 'prompt' ? f.prompts.length : f.sent.length, count);
    const job = f.store.jobs()[0];
    assert.equal(job.status, 'blocked');
    if (kind === 'prompt') {
      resolveJob(f.store, job.id, 'observe');
      f.finish(); await f.drain();
      assert.equal(f.prompts.length, 1);
    } else {
      resolveJob(f.store, job.id, 'sent');
      await f.drain();
      assert.equal(f.sent.length, 1);
    }
  });
}

test('persist-before-send crash recovery blocks prompt and outbox sending states', async t => {
  const f = await fixture(t);
  await f.bridge.receive();
  let job = f.store.jobs()[0];
  job.status = 'prompting'; f.store.save(job); f.store.recover();
  assert.equal(f.store.jobs()[0].reason, 'PROMPT_OUTCOME_UNKNOWN');
  job = f.store.jobs()[0];
  job.status = 'replying'; job.outbox = [{ status: 'sending' }];
  f.store.save(job); f.store.recover();
  assert.equal(f.store.jobs()[0].outbox[0].status, 'unknown');
  assert.equal(f.store.jobs()[0].reason, 'WEIXIN_OUTCOME_UNKNOWN');
});

test('external concurrent user input blocks transfer and preserves next request', async t => {
  const f = await fixture(t, { batch: [incoming(), incoming({ message_id: 43 })] });
  await f.bridge.receive(); await f.bridge.step();
  f.state.messages.push({ id: 'foreign', role: 'user', content: 'Private unrelated request', timestamp: 12 });
  f.finish('private reply');
  await assert.rejects(f.bridge.step(), { code: 'EXTERNAL_INPUT_DETECTED' });
  assert.equal(f.sent.length, 0);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.store.jobs()[1].status, 'queued');
});

for (const kind of ['ask', 'planRequest', 'elicitation']) {
  test(`${kind} notifies correct Web link once; never responds or guesses authorization`, async t => {
    const f = await fixture(t);
    f.config.limits.textBytes = 1800;
    await f.bridge.receive(); await f.bridge.step();
    f.state[kind] = { requestId: `${kind}-1` };
    await f.bridge.step(); await f.bridge.step(); await f.bridge.step();
    assert.equal(f.sent.length, 1);
    assert.ok(f.sent[0].msg.item_list[0].text_item.text.includes('https://cockpit.example.test/session/test-session'));
    await f.bridge.step(); assert.equal(f.sent.length, 1);
    f.state[kind] = null;
    f.state.messages.push({ id: 'answer', role: 'user', subtype: 'ask-reply', content: 'Proceed', timestamp: 11 });
    f.finish('after choice');
    await f.drain();
    assert.equal(f.sent.at(-1).msg.item_list[0].text_item.text, 'after choice');
    assert.ok(f.requests.every(row => !row.url.includes('respond')));
  });
}

test('correlated queued input explicitly loads its original target; missing or changed target fails closed', async t => {
  const f = await fixture(t, { status: 'unloaded', loaded: false });
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.requests.filter(row => row.url === '/intent/session/load').length, 1);
  assert.equal(f.prompts.length, 1);
  f.state.missing = true;
  await assert.rejects(f.bridge.step(), { code: 'TARGET_SESSION_MISSING' });
  f.state.missing = false; f.state.changedCwd = '/tmp/other';
  await assert.rejects(f.bridge.step(), { code: 'TARGET_CWD_CHANGED' });
  assert.equal(f.sent.length, 0);
});

test('unloaded metadata preserves unknown queue/error; loaded native state remains required', async t => {
  const f = await fixture(t, { status: 'unloaded', loaded: false, lastActivitySource: 'persisted' });
  const meta = await f.cockpit.meta();
  assert.equal(meta.queue, undefined);
  assert.equal(meta.error, undefined);
  assert.equal(meta.lastActivitySource, 'persisted');
  assert.equal(quiescent(meta), false);
  assert.equal(quiescent({ ...meta, queue: [] }), false, 'unloaded state cannot prove current native idle');
  const result = correlate({ prompt: 'own prompt' }, [
    { id: 'user', role: 'user', content: 'own prompt' },
    { id: 'reply', role: 'assistant', content: 'A body is not proof of a drained queue' },
  ], meta);
  assert.equal(result.userMessageId, 'user');
  assert.equal(result.reply, null);
  f.state.loaded = true; f.state.status = 'idle'; f.state.omitNativeState = true;
  await assert.rejects(f.cockpit.meta(), { code: 'COCKPIT_SESSION_SCHEMA' });
  f.state.omitNativeState = false;
  assert.equal(quiescent(await f.cockpit.meta()), true);
});

test('loaded metadata without error uses current native controls, without synthesizing a last-error value', async t => {
  const f = await fixture(t);
  const meta = await f.cockpit.meta();
  assert.equal(Object.hasOwn(meta, 'error'), false);
  assert.equal(quiescent(meta), true);
  for (const state of [{ status: 'running' }, { queue: [{ id: 'q', text: 'queued work' }] },
    { nativeProcessing: true }, { activeSubagents: 1 }, { activeMcpOperations: 1 }, { activeOperations: 1 },
    { loading: true }, { closing: true }, { cancelling: true }, { compacting: true },
    { ask: { requestId: 'ask' } }, { planRequest: { requestId: 'plan' } }, { elicitation: { requestId: 'choice' } }]) {
    assert.equal(quiescent({ ...meta, ...state }), false);
  }
  f.state.error = 'Explicit legacy error';
  assert.equal(quiescent(await f.cockpit.meta()), false);
  f.state.error = false;
  await assert.rejects(f.cockpit.meta(), { code: 'COCKPIT_SESSION_SCHEMA' });
});

test('native chat pages need no title/cwd; existing metadata remains the binding authority', async t => {
  const f = await fixture(t, { messages: [{ id: 'answer', role: 'assistant', content: 'Native body' }] });
  const page = await f.cockpit.nativePage({ source: 'live', direction: 'backward', max: 64 });
  assert.equal(page.title, undefined);
  assert.equal(page.cwd, undefined);
  assert.equal((await f.cockpit.page()).messages[0].content, 'Native body');
  f.state.changedCwd = '/another-target';
  await assert.rejects(f.cockpit.page(), { code: 'TARGET_CWD_CHANGED' });
});

test('HTTP/schema errors do not leak remote error bodies or count as successful sends', async t => {
  const f = await fixture(t, { promptFault: 'schema' });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'PROMPT_OUTCOME_UNKNOWN' });
  assert.equal(f.store.jobs()[0].lastError, 'COCKPIT_PROMPT_REJECTED');
  f.state.metaFault = 500;
  await assert.rejects(f.cockpit.meta(), error => errorCode(error) === 'HTTP_500' && !error.message.includes('FAKE_SECRET'));
  f.state.pollFault = -14;
  await assert.rejects(f.bridge.receive(), { code: 'WEIXIN_TOKEN_EXPIRED' });
});

test('no marker even with assistant/idle never returns an unrelated reply', async t => {
  const f = await fixture(t, { noMarker: true, earlyIdle: true });
  await f.bridge.receive(); await f.bridge.step(); f.finish('not provably related');
  await f.bridge.step(); await f.bridge.step();
  assert.equal(f.sent.length, 0);
  const job = f.store.jobs()[0]; job.startedAt = 0; f.store.save(job);
  await assert.rejects(f.bridge.step(), { code: 'RESULT_NEEDS_CONFIRMATION' });
});

test('one bounded legacy migration page locates its anchor and rejects an absent one', async t => {
  const f = await fixture(t);
  f.state.messages = Array.from({ length: 230 }, (_, i) => ({ id: `m${i}`, role: 'assistant', content: `${i}`, timestamp: i }));
  assert.equal((await f.cockpit.since('m1')).length, 228);
  await assert.rejects(f.cockpit.since('removed'), { code: 'CHECKPOINT_MIGRATION_REQUIRED' });
});

test('binding and private permissions are mandatory; unsafe API hosts and redirects refused', async t => {
  const f = await fixture(t);
  assert.throws(() => assertBinding({ ...f.config, weixin: { ...f.config.weixin, allowedPeer: '*' } }, credentials));
  assert.throws(() => assertBinding(f.config, { ...credentials, account: 'wrong' }), { code: 'CREDENTIAL_BINDING_MISMATCH' });
  assert.throws(() => validateApiOrigin('https://ilinkai.weixin.qq.com.attacker.test'), { code: 'UNTRUSTED_WEIXIN_HOST' });
  assert.throws(() => validateApiOrigin('https://other.weixin.qq.com', f.config.weixin.approvedApiOrigins), { code: 'WEIXIN_ORIGIN_NOT_APPROVED' });
  assert.throws(() => validateConfig({ ...f.raw, cockpit: { ...f.raw.cockpit, apiUrl: 'http://remote.invalid' } }, f.configFile));
  await assert.rejects(requestJson('https://example.test', { fetchImpl: async () =>
    new Response('', { status: 302, headers: { Location: 'https://evil.test' } }) }), { code: 'HTTP_REDIRECT_REFUSED' });
  fs.chmodSync(f.config.stateDir, 0o755);
  assert.throws(() => new Store(f.config.stateDir), { code: 'INSECURE_STATE_PERMISSIONS' });
  fs.chmodSync(f.config.stateDir, 0o700);
});

test('explicit QR login mock: no existing tokens, no auth header on QR GET, host checked before credential use', async t => {
  const f = await fixture(t, { loginStates: [{ status: 'need_verifycode' }, { status: 'confirmed',
    bot_token: credentials.token, ilink_bot_id: credentials.account, ilink_user_id: credentials.peer, baseurl: credentials.baseUrl }] });
  const shown = [];
  const result = await login(f.weixin, { showQr: value => shown.push(value), verifyCode: async () => '123456' });
  assert.equal(result.account, credentials.account);
  assert.equal(shown.length, 1);
  const qr = f.requests.find(row => row.url.includes('get_bot_qrcode'));
  assert.deepEqual(qr.data, { local_token_list: [] });
  assert.equal(qr.headers.authorization, undefined);
  const status = f.requests.filter(row => row.url.includes('get_qrcode_status'));
  assert.equal(status[0].headers.authorization, undefined);
  assert.ok(status[1].url.includes('verify_code=123456'));
  f.state.loginStates = [{ status: 'scaned_but_redirect', redirect_host: 'evil.test' }];
  await assert.rejects(login(f.weixin, { showQr() {}, verifyCode() {} }), { code: 'UNTRUSTED_WEIXIN_HOST' });
});

test('read disconnect can resume same cursor; API business errors cannot be silently accepted', async t => {
  const f = await fixture(t);
  await f.bridge.receive();
  let calls = 0;
  const client = new WeixinClient(f.config, credentials, { fetchImpl: async () => {
    if (++calls === 1) throw new Error('connection lost FAKE_SECRET');
    return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'next' }));
  } });
  await assert.rejects(client.poll('cursor-1'), { code: 'NETWORK_ERROR' });
  assert.equal((await client.poll('cursor-1')).get_updates_buf, 'next');
  assert.equal(calls, 2);
  f.state.sendFault = 'reject';
  await assert.rejects(f.weixin.send(credentials.peer, 'ctx', 'test', 'id'), { code: 'WEIXIN_API_REJECTED' });
});

test('SQLite and credential file permissions; exclusive lock; stop addresses nonce not arbitrary PID', async t => {
  const f = await fixture(t);
  writePrivate(path.join(f.config.stateDir, 'credentials.json'), credentials);
  assert.equal(fs.statSync(path.join(f.config.stateDir, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.config.stateDir, 'bridge.sqlite')).mode & 0o777, 0o600);
  const lock = new RunLock(f.config.stateDir);
  assert.throws(() => new RunLock(f.config.stateDir), { code: 'LOCKED' });
  assert.throws(() => RunLock.unlock(f.config.stateDir), { code: 'LOCK_PROCESS_EXISTS' });
  RunLock.requestStop(f.config.stateDir);
  assert.equal(lock.stopRequested(), true);
  lock.release();
});

test('SIGTERM through real CLI aborts long-poll, releases lock, saves state and never cancels Cockpit', async t => {
  const f = await fixture(t, { batch: [], pollHold: true });
  // CLI must own the initial binding; fixture uses an explicit fake gateway token.
  writePrivate(path.join(f.config.stateDir, 'credentials.json'), credentials);
  const child = spawn(process.execPath, ['--import', './test/cli-preload.js', 'src/cli.js', 'run', '--config', f.configFile],
    { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, TEST_MOCK_PORT: String(f.port), COCKPIT_API_TOKEN: 'FAKE_GATE_TOKEN' },
      stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  const deadline = Date.now() + 5000;
  while (!f.requests.some(row => row.url.includes('getupdates')) && child.exitCode === null && Date.now() < deadline) await delay(20);
  assert.ok(f.requests.some(row => row.url.includes('getupdates')), output);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0, output); assert.equal(signal, null);
  assert.equal(fs.existsSync(path.join(f.config.stateDir, 'run.lock')), false);
  assert.ok(f.requests.every(row => !row.url.includes('cancel')));
  assert.ok(!output.includes(credentials.token));
});

test('split limit fails explicitly instead of truncating', () => {
  assert.throws(() => splitText('中'.repeat(1000), 128, 1), { code: 'TOO_MANY_REPLY_PARTS' });
});

test('failure during cursor commit rolls back already inserted inbox records', async t => {
  const f = await fixture(t);
  const original = f.store.set;
  f.store.set = () => { throw new Error('simulated commit failure'); };
  await assert.rejects(f.bridge.receive(), /simulated commit failure/u);
  f.store.set = original;
  assert.equal(f.store.jobs().length, 0);
  assert.equal(f.store.get('cursor'), null);
});

for (const kind of ['prompt', 'send']) {
  test(`${kind} actual HTTP timeout is unknown with no mutation replay`, async t => {
    const f = await fixture(t, kind === 'prompt' ? { promptFault: 'hold' } : { sendFault: 'hold' });
    await f.bridge.receive();
    if (kind === 'send') { await f.bridge.step(); f.finish(); await f.bridge.step(); await f.bridge.step(); }
    await assert.rejects(f.bridge.step());
    assert.equal(f.store.jobs()[0].lastError, 'REQUEST_TIMEOUT');
    await assert.rejects(f.bridge.step());
    assert.equal(kind === 'prompt' ? f.prompts.length : f.sent.length, 1);
  });
}

test('runtime backs off a read-only poll failure, resumes cursor and exits on abort', async t => {
  const f = await fixture(t, { pollHttpFaultOnce: true });
  const controller = new AbortController();
  const running = f.bridge.run(controller.signal);
  t.after(() => controller.abort());
  const deadline = Date.now() + 5000;
  while (!f.prompts.length && Date.now() < deadline) await delay(20);
  assert.equal(f.prompts.length, 1);
  f.finish();
  while (f.store.jobs()[0]?.status !== 'done' && Date.now() < deadline) await delay(20);
  controller.abort(); await running;
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.ok(f.logs.some(line => line.startsWith('POLL_RETRY HTTP_503')));
  assert.ok(f.requests.filter(row => row.url.includes('getupdates')).some(row => row.data.get_updates_buf === 'cursor-1'));
});

test('notices never expose thoughts, tool contents or raw native error', async t => {
  const f = await fixture(t);
  f.config.limits.textBytes = 1800;
  await f.bridge.receive(); await f.bridge.step();
  f.state.messages.push({ id: 'tool', role: 'assistant', content: 'private tool log',
    thought: 'private reasoning', timestamp: 11, toolCalls: [{ status: 'completed', result: 'private output' }] });
  f.state.messages.push({ id: 'err', role: 'system', level: 'error', content: 'FAKE_SECRET_IN_ERROR', timestamp: 12 });
  f.state.status = 'error'; f.state.error = 'FAKE_SECRET_IN_ERROR';
  await f.drain();
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].msg.item_list[0].text_item.text.includes('报告错误'));
  assert.ok(!JSON.stringify(f.sent).includes('private'));
  assert.ok(!JSON.stringify(f.sent).includes('FAKE_SECRET_IN_ERROR'));
});

test('history fence detects a completed foreign request between jobs and across restart', async t => {
  const f = await fixture(t);
  await f.bridge.receive(); await f.bridge.step(); f.finish(); await f.drain();
  assert.ok(f.store.get('historyCheckpoint').id);
  f.state.messages.push({ id: 'foreign-u', role: 'user', content: 'unrelated private input', timestamp: 30 },
    { id: 'foreign-a', role: 'assistant', content: 'unrelated private answer', timestamp: 31 });
  f.state.batch = [incoming({ message_id: 43 })];
  await f.bridge.receive();
  f.closeStore();
  const store = new Store(f.config.stateDir);
  try {
    const bridge = new Bridge(f.config, credentials, store, f.weixin, f.cockpit, { log() {} });
    bridge.bind();
    await assert.rejects(bridge.step(), { code: 'EXTERNAL_ACTIVITY_BETWEEN_JOBS' });
    assert.equal(f.prompts.length, 1);
    assert.equal(f.sent.length, 1);
  } finally { store.close(); }
});

test('normal serial requests advance verified fence without adopting arbitrary history', async t => {
  const f = await fixture(t, { batch: [incoming(), incoming({ message_id: 43 })] });
  await f.bridge.receive(); await f.bridge.step(); f.finish('first');
  while (f.store.jobs()[0].status !== 'done') await f.bridge.step();
  await f.bridge.step();
  assert.equal(f.prompts.length, 2);
  f.finish('second'); await f.drain();
  assert.equal(f.sent.at(-1).msg.item_list[0].text_item.text, 'second');
});

for (const mutation of ['running', 'choice', 'error', 'reply-change']) {
  test(`final outbox blocks ${mutation} detected before transmission`, async t => {
    const f = await fixture(t);
    await f.bridge.receive(); await f.bridge.step(); f.finish('old final');
    await f.bridge.step(); await f.bridge.step();
    assert.equal(f.store.jobs()[0].status, 'replying');
    if (mutation === 'running') f.state.status = 'running';
    if (mutation === 'choice') f.state.ask = { requestId: 'late-choice' };
    if (mutation === 'error') f.state.error = 'late-error';
    if (mutation === 'reply-change') f.state.messages.at(-1).content = 'new final';
    await assert.rejects(f.bridge.step(), { code: 'FINAL_EVIDENCE_CHANGED' });
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.jobs()[0].status, 'blocked');
  });
}

test('read-failed outbox can explicitly observe while preserving accepted pieces and IDs', async t => {
  const f = await fixture(t);
  await f.bridge.receive(); await f.bridge.step(); f.finish('中'.repeat(80));
  await f.bridge.step(); await f.bridge.step(); await f.bridge.step();
  const saved = f.store.jobs()[0];
  assert.equal(saved.outbox[0].status, 'accepted');
  const clientIds = saved.outbox.map(part => part.clientId);
  saved.status = 'blocked'; saved.reason = 'HTTP_503'; f.store.save(saved);
  resolveJob(f.store, saved.id, 'observe');
  assert.deepEqual(f.store.jobs()[0].outbox.map(part => part.clientId), clientIds);
  assert.equal(f.store.jobs()[0].outbox[0].status, 'accepted');
  await f.drain();
  assert.equal(f.sent.length, clientIds.length);
  assert.equal(new Set(f.sent.map(row => row.msg.client_id)).size, clientIds.length);
});

test('an expired native checkpoint blocks submission rather than silently adopting replacement history', async t => {
  const f = await fixture(t);
  f.state.messages = [{ id: 'before', role: 'assistant', content: 'initial', timestamp: 1 }];
  await f.bridge.establishCheckpoint();
  f.state.messages[0] = { id: 'replacement', role: 'assistant', content: 'replacement history', timestamp: 2 };
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'NATIVE_CURSOR_EXPIRED' });
  assert.equal(f.prompts.length, 0);
});

test('CLI init is exclusive, status is offline/redacted, and unconfirmed login/unbound run never contact APIs', async t => {
  const f = await fixture(t);
  const invoke = (...args) => promisify(execFile)(process.execPath, ['src/cli.js', ...args], {
    cwd: path.resolve(import.meta.dirname, '..'),
  });
  const file = path.join(f.dir, 'unbound.json');
  await invoke('init', '--config', file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await assert.rejects(invoke('init', '--config', file));
  const status = await invoke('status', '--config', file);
  assert.equal(JSON.parse(status.stdout).configuredTarget, false);
  await assert.rejects(invoke('login', '--config', file), error => error.stderr.includes('CONFIRM_REQUIRED'));
  await assert.rejects(invoke('run', '--config', file), error => error.stderr.includes('TARGET_NOT_BOUND'));
  assert.equal(f.requests.length, 0);
  assert.ok(!status.stdout.includes(credentials.token));
});

test('transport duplicate of an already blocked job is not mistaken for a changed payload', async t => {
  const f = await fixture(t, { repeatBatch: true, promptFault: 'disconnect' });
  await f.bridge.receive();
  await assert.rejects(f.bridge.step(), { code: 'PROMPT_OUTCOME_UNKNOWN' });
  await f.bridge.receive();
  assert.equal(f.store.jobs().length, 1);
  assert.equal(f.store.jobs()[0].reason, 'PROMPT_OUTCOME_UNKNOWN');
});

test('once mode persists one selected request and exits before a second queued prompt or restart replay', async t => {
  const f = await fixture(t, { batch: [incoming(), incoming({ message_id: 43 })] });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = f.bridge.run(controller.signal, { once: true });
  const deadline = Date.now() + 5000;
  while (f.prompts.length === 0 && Date.now() < deadline) await delay(20);
  assert.equal(f.prompts.length, 1);
  f.finish('one reply');
  await running;
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.jobs()[1].status, 'queued');
  assert.equal(f.store.get('onceJobId'), f.store.jobs()[0].id);
  const requestCount = f.requests.length;
  await f.bridge.run(controller.signal, { once: true });
  assert.equal(f.requests.length, requestCount);
});

test('live poll optional ret accepts complete cursor schema but rejects errors and malformed replies', async t => {
  const f = await fixture(t);
  let response = { msgs: [], sync_buf: '', get_updates_buf: 'cursor' };
  const client = new WeixinClient(f.config, credentials, { fetchImpl: async () =>
    new Response(JSON.stringify(response)) });
  assert.equal((await client.poll('')).get_updates_buf, 'cursor');
  response = { msgs: [], get_updates_buf: 'cursor', errcode: -14 };
  await assert.rejects(client.poll(''), { code: 'WEIXIN_TOKEN_EXPIRED' });
  response = { msgs: [], get_updates_buf: 'cursor', ret: 7 };
  await assert.rejects(client.poll(''), { code: 'WEIXIN_API_REJECTED' });
  response = { ok: true };
  await assert.rejects(client.poll(''), { code: 'WEIXIN_POLL_SCHEMA' });
  response = { msgs: [], get_updates_buf: 'cursor' };
  await assert.rejects(client.send(credentials.peer, 'ctx', 'text', 'id'), { code: 'WEIXIN_API_REJECTED' });
});

test('large live message IDs preserve exact uint64 JSON lexemes without accepting rounded numbers', async t => {
  const f = await fixture(t);
  const wire = JSON.stringify({ ret: 0, msgs: [incoming()], get_updates_buf: 'large-id' })
    .replace('"message_id":42', '"message_id":18446744073709551614');
  const client = new WeixinClient(f.config, credentials, { fetchImpl: async () => new Response(wire) });
  const response = await client.poll('');
  assert.equal(response.msgs[0].message_id, '18446744073709551614');
  assert.ok(normalizeBatch(response.msgs, f.config)[0].id.endsWith(':18446744073709551614'));
  assert.throws(() => normalizeBatch([incoming({ message_id: Number('18446744073709551614') })], f.config),
    { code: 'STABLE_MESSAGE_ID_REQUIRED' });
  for (const message_id of ['18446744073709551616', '-1', '1e20', '01']) {
    assert.throws(() => normalizeBatch([incoming({ message_id })], f.config), { code: 'STABLE_MESSAGE_ID_REQUIRED' });
  }
});

test('normalization failure preserves private batch and does not poll away unaccepted input', async t => {
  const f = await fixture(t, { batch: [incoming({ message_id: -1 })] });
  await assert.rejects(f.bridge.receive(), { code: 'STABLE_MESSAGE_ID_REQUIRED' });
  assert.equal(f.store.get('pendingBatch').msgs.length, 1);
  assert.equal(f.store.get('cursor'), null);
  const count = f.requests.length;
  await assert.rejects(f.bridge.receive(), { code: 'STABLE_MESSAGE_ID_REQUIRED' });
  assert.equal(f.requests.length, count);
});

test('send ACK diagnostics retain only bounded shape while success and unknown rules stay strict', async t => {
  const f = await fixture(t);
  const file = path.join(f.config.stateDir, 'last-send-response.json');
  const cases = [
    [{ ret: 0, errmsg: '' }, null],
    [{ ret: 0, errcode: 0 }, null],
    [{}, 'WEIXIN_API_REJECTED'],
    [{ ok: true }, 'WEIXIN_API_REJECTED'],
    [{ errcode: 0 }, 'WEIXIN_API_REJECTED'],
    [{ ret: 3 }, 'WEIXIN_API_REJECTED'],
    [{ ret: 0, errcode: 3 }, 'WEIXIN_API_REJECTED'],
    [{ ret: -14 }, 'WEIXIN_TOKEN_EXPIRED'],
    [{ ret: 0, errcode: -14 }, 'WEIXIN_TOKEN_EXPIRED'],
    [{ ret: '0' }, 'WEIXIN_API_REJECTED'],
    [{ ret: false }, 'WEIXIN_API_REJECTED'],
    [{ ret: null }, 'WEIXIN_API_REJECTED'],
    [[], 'INVALID_JSON_RESPONSE'],
    [null, 'INVALID_JSON_RESPONSE'],
    ['FAKE_SECRET_BODY', 'INVALID_JSON_RESPONSE'],
    [{ ret: 'FAKE_SECRET_CODE', errcode: 2147483648, errmsg: 'FAKE_SECRET_MESSAGE',
      FAKE_SECRET_KEY: { context_token: 'FAKE_SECRET_CONTEXT' } }, 'WEIXIN_API_REJECTED'],
  ];
  let calls = 0;
  for (const [body, code] of cases) {
    const client = new WeixinClient(f.config, credentials, { fetchImpl: async () => {
      calls++; return new Response(JSON.stringify(body));
    } });
    const sending = client.send(credentials.peer, 'FAKE_CONTEXT', 'FAKE_SECRET_TEXT', 'FAKE_CLIENT');
    if (code) await assert.rejects(sending, { code });
    else await sending;
    const saved = fs.readFileSync(file, 'utf8');
    const shape = JSON.parse(saved);
    assert.equal(shape.version, 1);
    assert.equal(shape.httpStatus, 200);
    assert.equal(shape.bodyType, body === null ? 'null' : Array.isArray(body) ? 'array' : typeof body);
    assert.ok(!saved.includes('FAKE_'));
    assert.ok(saved.length < 400);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(calls, cases.length);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    version: 1, httpStatus: 200, bodyType: 'object', contentType: 'text/plain',
    bodyBytes: Buffer.byteLength(JSON.stringify(cases.at(-1)[0])),
    fields: [{ name: 'ret', type: 'string' }, { name: 'errcode', type: 'number' },
      { name: 'errmsg', type: 'string' }], otherFieldCount: 1,
  });
});

test('send ACK diagnostics distinguish HTTP and invalid JSON without reading error bodies or retrying', async t => {
  const f = await fixture(t);
  const file = path.join(f.config.stateDir, 'last-send-response.json');
  const cases = [
    [() => new Response('FAKE_SECRET_HTTP_BODY', { status: 503 }), 'HTTP_503', 503, 'unread'],
    [() => new Response('FAKE_SECRET_REDIRECT', { status: 302,
      headers: { Location: 'https://evil.example/FAKE_SECRET' } }), 'HTTP_REDIRECT_REFUSED', 302, 'unread'],
    [() => new Response('FAKE_SECRET_NOT_JSON'), 'INVALID_JSON_RESPONSE', 200, 'invalid-json'],
    [() => new Response(null, { status: 204 }), 'INVALID_JSON_RESPONSE', 204, 'empty'],
    [() => { throw new Error('FAKE_SECRET_NETWORK'); }, 'NETWORK_ERROR', null, 'unread'],
  ];
  let calls = 0;
  for (const [respond, code, httpStatus, bodyType] of cases) {
    const client = new WeixinClient(f.config, credentials, { fetchImpl: async () => { calls++; return respond(); } });
    await assert.rejects(client.send(credentials.peer, 'ctx', 'text', 'id'), { code });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      version: 1, httpStatus, bodyType,
      ...(httpStatus === null ? {} : { contentType: httpStatus === 204 ? 'absent' : 'text/plain' }),
      ...(bodyType === 'empty' ? { bodyBytes: 0 } : {}),
      ...(bodyType === 'invalid-json' ? { bodyBytes: Buffer.byteLength('FAKE_SECRET_NOT_JSON') } : {}),
    });
  }
  assert.equal(calls, cases.length);
});

test('send ACK diagnostic write failure blocks an accepted mock send and restart cannot replay it', async t => {
  const f = await fixture(t);
  await f.bridge.receive(); await f.bridge.step();
  f.finish(); await f.bridge.step(); await f.bridge.step();
  const file = path.join(f.config.stateDir, 'last-send-response.json');
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.jobs()[0].lastError, 'INSECURE_STATE_PERMISSIONS');
  assert.equal(f.store.jobs()[0].outbox[0].status, 'unknown');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  f.store.recover();
  await assert.rejects(f.bridge.step(), { code: 'WEIXIN_OUTCOME_UNKNOWN' });
  assert.equal(f.sent.length, 1);
});

test('send ACK diagnostics preserve useful nested protocol identifiers without payload values', async t => {
  const f = await fixture(t);
  const client = new WeixinClient(f.config, credentials, { fetchImpl: async () =>
    new Response(JSON.stringify({ base_resp: { ret: 0, err_msg: 'PRIVATE_STRING' },
      message_id: 'PRIVATE_ID', context_token: 'PRIVATE_CONTEXT', text: 'PRIVATE_TEXT',
      arbitrary: 'PRIVATE_VALUE', FAKE_SECRET_KEY: 'PRIVATE_VALUE' })) });
  await assert.rejects(client.send(credentials.peer, 'ctx', 'text', 'id'), { code: 'WEIXIN_API_REJECTED' });
  const shape = JSON.parse(fs.readFileSync(path.join(f.config.stateDir, 'last-send-response.json'), 'utf8'));
  assert.deepEqual(shape.otherFields, [
    { name: 'base_resp', type: 'object', fields: [
      { name: 'ret', type: 'number', code: 0 }, { name: 'err_msg', type: 'string' }] },
    { name: 'message_id', type: 'string' }, { name: 'arbitrary', type: 'string' },
  ]);
  assert.ok(!JSON.stringify(shape).includes('PRIVATE'));
});

test('server-assigned uint64 send receipts require a strict success envelope and explicit errors win', () => {
  for (const value of [{ message_id: '7503283626969446793' }, { message_id: 42 },
    { message_id: '18446744073709551615', errcode: 0, errmsg: '' }, { ret: 0 }]) {
    assert.doesNotThrow(() => sendSuccess(value));
  }
  for (const message_id of ['', '0', 0, '01', '1e12', '-1', '18446744073709551616',
    9007199254740992, null, true, 'PRIVATE_VALUE']) {
    assert.throws(() => sendSuccess({ message_id }), { code: 'WEIXIN_API_REJECTED' });
  }
  for (const value of [
    { message_id: '42', ret: 3 }, { message_id: '42', ret: null },
    { message_id: '42', ret: '0' }, { message_id: '42', errcode: 9 },
  ]) assert.throws(() => sendSuccess(value), { code: 'WEIXIN_API_REJECTED' });
  assert.throws(() => sendSuccess({ message_id: '42', errcode: -14 }), { code: 'WEIXIN_TOKEN_EXPIRED' });
  for (const value of [
    { message_id: '42', errmsg: 'ambiguous' }, { message_id: '42', ok: true },
    { message_id: '42', code: 99 }, { ret: 0, message_id: '' }, { ret: 0, errmsg: {} },
  ]) assert.throws(() => sendSuccess(value), { code: 'WEIXIN_SEND_SCHEMA' });
});

test('exhausted read retries can resume an accepted job without replaying its prompt', async t => {
  const f = await fixture(t);
  const first = new AbortController();
  t.after(() => first.abort());
  const running = f.bridge.run(first.signal);
  const rejection = assert.rejects(running, { code: 'HTTP_503' });
  const deadline = Date.now() + 5000;
  while (!f.prompts.length && Date.now() < deadline) await delay(10);
  assert.equal(f.prompts.length, 1);
  f.state.metaFault = 503;
  await rejection;
  assert.equal(f.store.jobs()[0].status, 'accepted');
  f.state.metaFault = null;
  f.finish();
  const second = new AbortController();
  t.after(() => second.abort());
  const resumed = f.bridge.run(second.signal);
  while (f.store.jobs()[0].status !== 'done' && Date.now() < deadline) await delay(10);
  second.abort(); await resumed;
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent.length, 1);
});

test('CLI read failures exit temporarily while unknown sends retain terminal failure status', async t => {
  const f = await fixture(t, { metaFault: 503 });
  writePrivate(path.join(f.config.stateDir, 'credentials.json'), credentials);
  const exec = promisify(execFile);
  await assert.rejects(exec(process.execPath, ['--import', path.resolve('test/cli-preload.js'),
    path.resolve('src/cli.js'), 'check', '--config', f.configFile],
  { env: { ...process.env, TEST_MOCK_PORT: String(f.port) } }), error => error.code === 75
    && error.stderr.includes('HTTP_503') && !error.stderr.includes('FAKE_SECRET'));
  const unit = fs.readFileSync(path.resolve('deploy/weixin-cockpit-bridge.service'), 'utf8');
  assert.ok(unit.includes('RestartPreventExitStatus=2'));
  assert.ok(unit.includes('Restart=on-failure'));
});
