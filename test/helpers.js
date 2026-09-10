import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { validateConfig } from '../src/config.js';
import { Store } from '../src/storage.js';
import { WeixinClient } from '../src/weixin.js';
import { CockpitClient } from '../src/cockpit.js';
import { Bridge } from '../src/bridge.js';
import { createHash } from 'node:crypto';

export const testPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

export const credentials = {
  account: 'bot-test@im.bot', peer: 'peer-test@im.wechat',
  token: 'FAKE_TEST_TOKEN_NOT_REAL', baseUrl: 'https://ilinkai.weixin.qq.com',
};

export function incoming(overrides = {}) {
  return { message_id: 42, from_user_id: credentials.peer, to_user_id: credentials.account,
    message_type: 1, message_state: 2, context_token: 'FAKE_CONTEXT',
    item_list: [{ type: 1, text_item: { text: '你好，请答复' } }], ...overrides };
}

export async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-bridge-test-'));
  const requests = [];
  const sent = [];
  const prompts = [];
  const logs = [];
  const typing = [];
  const heldSends = [];
  const heldPrompts = [];
  const streams = new Set();
  const nativeCursors = new Map();
  let nativeCursorSequence = 0;
  let nativeLog = [];
  const state = {
    messages: [], batch: [incoming()], cursor: 'cursor-1', sendFault: null, promptFault: null, pollFault: null,
    status: 'idle', loaded: true, ask: null, planRequest: null, elicitation: null, queue: [], ...options,
  };
  const uploads = new Map();
  const managed = url => {
    const bytes = state.managedFiles?.[url] ?? (/\.png$/iu.test(url) ? testPng
      : /\.svg$/iu.test(url) ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') : Buffer.from('%PDF-1.7'));
    return { bytes, file: { kind: /\.png$/iu.test(url) ? 'image' : 'file', name: url.split('/').at(-1), url,
      size: bytes.length, mime: /\.png$/iu.test(url) ? 'image/png' : 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex') } };
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const binary = req.url.startsWith('/upload?');
    const data = binary ? null : body.length ? JSON.parse(body.toString()) : {};
    requests.push({ url: req.url, data, headers: req.headers, method: req.method, ...(binary ? { bytes: body } : {}) });
    const reply = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
    };
    if (binary) {
      const query = new URL(req.url, 'http://mock').searchParams;
      const identity = JSON.stringify(['source', 'sessionId', 'sourceId'].map(key => query.get(key)));
      let file = uploads.get(identity);
      if (!file) {
        const url = `/uploads/uploaded-${uploads.size}.bin`;
        file = { kind: query.get('mime').startsWith('image/') ? 'image' : 'file', name: query.get('name'), url,
          size: body.length, mime: query.get('mime'), sha256: createHash('sha256').update(body).digest('hex') };
        uploads.set(identity, file);
        state.managedFiles ??= {}; state.managedFiles[url] = body;
      }
      if (state.uploadDisconnectOnce) { state.uploadDisconnectOnce = false; return res.destroy(); }
      return reply(file);
    }
    if (req.url === '/events' && state.eventsEnabled) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"snapshot","sessions":[]}\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (req.url.startsWith('/capabilities?')) {
      const name = new URL(req.url, 'http://mock').searchParams.get('name');
      const fields = name === 'prompt' ? ['sessionId', 'text', 'mode'] :
        ['session/get', 'session/interrupt'].includes(name) ? ['sessionId'] : ['sessionId', 'cursor', 'max', 'source', 'direction'];
      return reply({ name, inputSchema: { type: 'object', properties: Object.fromEntries(fields.map(field =>
        [field, field === 'mode' ? { type: 'string', enum: ['enqueue', 'immediate'] } : { type: 'string' }])) },
      resultSchema: { type: 'object' } });
    }
    if (req.url === '/intent/session/get') {
      if (state.metaFault) return reply({ error: 'FAKE_SECRET_IN_ERROR' }, state.metaFault);
      return reply({ meta: state.missing ? null : {
        sessionId: 'test-session', title: 'Test', cwd: state.changedCwd ?? '/tmp/test-target',
        lastActivity: 1, lastActivitySource: state.lastActivitySource, status: state.status, loaded: state.loaded,
        ...(state.loaded && !state.omitNativeState ? { queue: state.queue,
          ...(state.error === undefined ? {} : { error: state.error }) } : {}),
        ask: state.ask, planRequest: state.planRequest, elicitation: state.elicitation,
        nativeProcessing: state.nativeProcessing ?? state.status === 'running',
        activeSubagents: state.activeSubagents ?? 0, activeMcpOperations: state.activeMcpOperations ?? 0,
        activeOperations: state.activeOperations ?? 0,
        closing: state.closing ?? false, cancelling: state.cancelling ?? false,
        loading: state.loading ?? false, compacting: state.compacting ?? false,
      } });
    }
    if (req.url === '/intent/session/chat') {
      const marker = attachment => `<cockpit-attachment version="2" ${['kind', 'name', 'url', 'size', 'mime']
        .filter(key => attachment[key] !== undefined).map(key => `${key}="${encodeURIComponent(attachment[key])}"`).join(' ')}/>`;
      const generated = state.messages.flatMap(message => {
        const content = message.parts ? message.parts.map(part => part.type === 'text' ? part.text : marker(part.attachment)).join('')
          : (message.attachments ?? (message.attachment ? [message.attachment] : [])).map(marker).join('') + message.content;
        const type = message.subtype === 'ask-reply' ? 'tool.execution_complete'
          : message.subtype === 'subagent' ? 'subagent.started'
          : message.role === 'system' ? 'session.error' : `${message.role}.message`;
        const rows = [{
          id: message.id, type, timestamp: message.timestamp ?? 1,
          data: { messageId: message.id, content,
            ...(message.toolCalls ? { toolRequests: message.toolCalls.map(tool => ({ toolCallId: tool.toolCallId, name: tool.name })) } : {}) },
        }];
        for (const tool of message.toolCalls ?? []) {
          const running = ['in_progress', 'running'].includes(tool.status);
          rows.push({ id: `${message.id}:${tool.toolCallId}:${running ? 'start' : 'complete'}`,
            type: running ? 'tool.execution_start' : 'tool.execution_complete',
            data: { toolCallId: tool.toolCallId, success: tool.status !== 'failed' } });
        }
        return rows.map(event => ({ owner: message.id, event }));
      });
      // Adapt legacy test builders to an append-only event fixture, not a production reader.
      generated.push(...(state.nativeEvents ?? []).map(event => ({ event })));
      nativeLog = nativeLog.filter(row => row.owner === undefined || state.messages.some(message => message.id === row.owner));
      for (const row of generated) {
        const existing = nativeLog.find(item => item.event.id === row.event.id);
        if (existing) existing.event = row.event;
        else nativeLog.push(row);
      }
      const events = nativeLog.map(row => row.event);
      const prior = data.cursor ? nativeCursors.get(data.cursor) : undefined;
      const anchor = prior?.id ? events.findIndex(event => event.id === prior.id) : -1;
      const expired = !!data.cursor && (!prior || (prior.id && anchor < 0));
      const direction = prior?.direction ?? data.direction;
      const boundary = prior ? (prior.id ? anchor + (direction === 'forward' ? 1 : 0) : 0)
        : direction === 'backward' ? events.length : 0;
      const candidates = events.map((event, index) => ({ event, index })).filter(({ event, index }) =>
        (direction === 'backward' ? index < boundary : index >= boundary)
        && (!data.types || data.types.includes(event.type)));
      const selected = direction === 'backward' ? candidates.slice(-data.max) : candidates.slice(0, data.max);
      const nextId = direction === 'backward' ? selected[0]?.event.id : selected.at(-1)?.event.id;
      const cursor = `fixture-native-${++nativeCursorSequence}`;
      nativeCursors.set(cursor, { id: nextId ?? prior?.id, direction });
      let liveCursor;
      if (data.bootstrap) {
        liveCursor = `fixture-native-${++nativeCursorSequence}`;
        nativeCursors.set(liveCursor, { id: events.at(-1)?.id, direction: 'forward' });
      }
      return reply({
        sessionId: 'test-session', source: data.source, direction: data.direction,
        events: selected.map(item => item.event), cursor, cursorStatus: expired ? 'expired' : 'ok',
        hasMore: candidates.length > selected.length, ...(liveCursor ? { liveCursor } : {}),
        read: { rpc: data.bootstrap ? 2 : 1, events: selected.length },
      });
    }
    if (req.url === '/intent/files/get') return reply(managed(data.url).file);
    if (req.url.startsWith('/uploads/')) {
      const resource = managed(req.url);
      res.writeHead(200, { 'Content-Type': resource.file.mime });
      return res.end(resource.bytes);
    }
    if (req.url === '/intent/prompt') {
      prompts.push(data);
      if (state.nativeQueue && state.status === 'running') {
        state.queue.push({ id: `queued-${prompts.length}`, text: data.text });
        return reply({ ok: true, queued: true });
      }
      if (!state.noMarker) state.messages.push({ id: `u${prompts.length}`, role: 'user',
        content: data.parts ? data.parts.filter(part => part.type === 'text').map(part => part.text).join('').trim()
          : data.attachments?.length ? data.text.trim() : data.text, timestamp: 10 });
      state.loaded = true;
      state.status = state.earlyIdle ? 'idle' : 'running';
      if (state.promptFault === 'disconnect') return res.destroy();
      if (state.promptFault === 'hold') {
        heldPrompts.push({ response: res, release: () => reply({ ok: true, queued: false }) });
        return;
      }
      if (state.promptFault === 'schema') return reply({ requestId: 'NONEXISTENT_CONTRACT' });
      return reply({ ok: true, queued: false });
    }
    if (req.url === '/intent/session/interrupt') {
      if (state.onInterrupt) await state.onInterrupt();
      if (state.interruptFault === 'disconnect') return res.destroy();
      if (state.interruptFault === 'schema') return reply({ ok: true });
      if (state.interruptFault === 'reject') return reply({ error: 'operation in progress' }, 409);
      return reply({ ok: true, interrupted: state.interrupted ?? true });
    }
    if (req.url === '/weixin/ilink/bot/getupdates') {
      if (state.pollHold) return;
      if (state.pollHttpFaultOnce) { state.pollHttpFaultOnce = false; return reply({ error: 'temporary' }, 503); }
      if (state.pollFault) return reply({ ret: state.pollFault, errmsg: 'FAKE_SECRET_IN_ERROR' });
      const batch = state.batch;
      if (!state.repeatBatch) state.batch = [];
      return reply({ ret: 0, msgs: batch, get_updates_buf: state.cursor, longpolling_timeout_ms: 1000 });
    }
    if (req.url === '/weixin/ilink/bot/getuploadurl') return reply({ upload_param: 'FAKE_PARAM' });
    if (req.url === '/weixin/ilink/bot/sendmessage') {
      sent.push(data);
      if (typeof state.sendRaw === 'string') {
        res.writeHead(200, { 'Content-Type': state.sendContentType ?? 'text/plain' });
        return res.end(state.sendRaw);
      }
      if (state.sendFault === 'disconnect') return res.destroy();
      if (state.sendFault === 'hold') {
        heldSends.push({ response: res, release: () => reply({ ret: 0 }) });
        return;
      }
      if (state.sendFault === 'schema') return reply({ ok: true });
      if (state.sendFault === 'reject') return reply({ ret: 99, errmsg: 'FAKE_SECRET_IN_ERROR' });
      return reply({ ret: 0 });
    }
    if (req.url === '/weixin/ilink/bot/getconfig') {
      return reply(state.configResponse ?? { typing_ticket: 'FAKE_TYPING_TICKET' });
    }
    if (req.url === '/weixin/ilink/bot/sendtyping') {
      typing.push(data);
      if (state.typingFault === 'disconnect') return res.destroy();
      return reply(state.typingResponse ?? {});
    }
    if (req.url.startsWith('/weixin/ilink/bot/get_bot_qrcode')) {
      return reply({ qrcode: 'FAKE_QR', qrcode_img_content: 'https://ilinkai.weixin.qq.com/FAKE_QR' });
    }
    if (req.url.startsWith('/weixin/ilink/bot/get_qrcode_status')) {
      return reply(state.loginStates?.shift() ?? { status: 'confirmed', bot_token: credentials.token,
        ilink_bot_id: credentials.account, ilink_user_id: credentials.peer, baseurl: credentials.baseUrl });
    }
    reply({ error: 'UNEXPECTED_ENDPOINT' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const configFile = path.join(dir, 'config.json');
  const raw = {
    cockpit: { apiUrl: `http://127.0.0.1:${port}`, webUrl: 'https://cockpit.example.test',
      sessionId: 'test-session', cwd: '/tmp/test-target' },
    weixin: { allowedAccount: credentials.account, allowedPeer: credentials.peer,
      approvedApiOrigins: ['https://ilinkai.weixin.qq.com'] },
    limits: { requestTimeoutMs: 500, statusIntervalMs: 20, textBytes: 128, maxReplyParts: 100 },
  };
  fs.writeFileSync(configFile, JSON.stringify(raw), { mode: 0o600 });
  const config = validateConfig(raw, configFile);
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.origin === 'https://novac2c.cdn.weixin.qq.com' && url.pathname === '/c2c/upload') {
      if (init.body?.[Symbol.asyncIterator]) for await (const _chunk of init.body) { /* Consume the mock upload. */ }
      return new Response(null, { headers: { 'x-encrypted-param': 'FAKE_DOWNLOAD' } });
    }
    if (url.origin === credentials.baseUrl) return fetch(`http://127.0.0.1:${port}/weixin${url.pathname}${url.search}`, init);
    if (url.origin === raw.cockpit.apiUrl) return fetch(url, init);
    throw new Error('Test refuses any external network');
  };
  const store = new Store(config.stateDir);
  const weixin = new WeixinClient(config, credentials, { fetchImpl });
  const cockpit = new CockpitClient(config, { fetchImpl, token: 'FAKE_GATE_TOKEN' });
  const BridgeClass = options.bridgeClass ?? Bridge;
  const bridge = new BridgeClass(config, credentials, store, weixin, cockpit, { log: value => logs.push(value) });
  bridge.bind();
  let closed = false;
  t.after(async () => {
    if (!closed) store.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // This is one resolved mkdtemp test fixture owned by this test.
    fs.rmSync(dir, { recursive: true });
  });
  return {
    dir, port, configFile, config, raw, requests, sent, prompts, logs, typing, state, store, weixin, cockpit, bridge, uploads,
    heldSends, heldPrompts,
    streams,
    emit(event) { for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`); },
    closeStore() { store.close(); closed = true; },
    finish(content = '你好，已完成。', extra = {}) {
      state.messages.push({ id: `a${state.messages.length}`, role: 'assistant', content, timestamp: 20, ...extra });
      state.status = 'idle';
    },
    async drain(limit = 50) {
      for (let i = 0; i < limit && (BridgeClass !== Bridge
        || store.jobs().some(job => !['done', 'abandoned', 'rejected'].includes(job.status))); i++) {
        await bridge.step();
      }
    },
  };
}
