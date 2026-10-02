import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { createCipheriv,createDecipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/state.js';
import { BindingManager } from '../dist/binding.js';
import { Service } from '../dist/service.js';
import { capabilities } from '../dist/index.js';
import { WechatTransport } from '../dist/transport.js';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'wechat-native-'));
  const stopping=new AbortController();
  const signal=new AbortController();
  const store=new Store(root,'fixture-account');
  const calls=[];
  const sent=[];
  let events=[];
  let meta={ sessionId: 'session-original',cwd: root,loaded: false,status: 'unloaded',ask: null };
  let hook;
  const context={
    moduleId: 'wechat',dataRoot: root,apiVersion: 1,serviceReadyVersion: 1,shutdownVersion: 1,
    stopping: stopping.signal,signal: signal.signal,config: {},report() { },invalidate() { },publish() { },
    host: {
      roleAssignmentVersion: 1,roleAvailabilityVersion: 1,sessionLoadVersion: 1,chatReadVersion: 1,
      promptReceiptVersion: 1,askResponseVersion: 1,
      async call(name,body) {
        calls.push({ name,body });
        if(hook) { const result=await hook(name,body); if(result!==undefined) return result; }
        if(name==='session/get') return { meta };
        if(name==='session/load') { meta={ ...meta,loaded: true,status: 'idle' }; return { ok: true,sessionId: body.sessionId }; }
        if(name==='session/chat') return {
          sessionId: body.sessionId,events: events.slice(-body.max),
          source: body.source,direction: body.direction,cursor: 'cursor-1',cursorStatus: 'ok',hasMore: false
        };
        if(name==='prompt') return { ok: true,queued: true,messageId: 'native-receipt-not-event-uuid' };
        if(name==='respondAsk') { meta.ask=null; return { ok: true }; }
        throw new Error('UNEXPECTED_HOST_CALL');
      },
    },
  };
  const config={ account: 'account',peer: 'peer',fileRoots: [root],webUrl: 'https://example.test',enabled: true,exclusiveAccountConfirmed: true };
  const transport={
    async send(items,token,clientId) { sent.push({ items,token,clientId }); return { messageId: String(sent.length+100) }; },
    async poll() { return { messages: [],cursor: 'wx-cursor' }; }
  };
  const service=new Service(context,config,store,transport);
  const manager=new BindingManager(context,store,() => []);
  t.after(async () => {
    stopping.abort();
    await service.stop();
    store.close();
    rmSync(root,{ recursive: true,force: true });
  });
  return {
    root,store,calls,sent,context,config,stopping,service,manager,transport,
    setMeta(value) { meta=value; },getMeta() { return meta; },setEvents(value) { events=value; },setHook(value) { hook=value; }
  };
}
const selection={ operation: 'add',sessionId: 'session-original',roles: [{ moduleId: 'wechat',roleId: 'wechat' }],previousRoles: [] };
async function bind(f) {
  await f.manager.saved({ ...selection,notificationId: 'notification-1' },new AbortController().signal);
  await f.service.tick();
}
function message(id,text='hello',extra={}) {
  return {
    id,text,account: 'account',peer: 'peer',contextToken: 'synthetic-context',
    items: [{ type: 1,text_item: { text } }],quotes: [],...extra
  };
}
test('required capabilities checked before activation can open storage',() => {
  assert.throws(() => capabilities({ host: {} }),/REQUIRED_HOST_CAPABILITIES_MISSING/);
});
test('without Files, encrypted incoming attachments and immutable outgoing copies traverse native prompt and CDN',async t => {
  const f=fixture(t);
  await bind(f);
  const sourceRoot=mkdtempSync(join(tmpdir(),'wechat-source-'));
  t.after(() => rmSync(sourceRoot,{ recursive: true,force: true }));
  const key=Buffer.alloc(16,7);
  const original=Buffer.from('incoming fixture');
  const cipher=createCipheriv('aes-128-ecb',key,null);
  const ciphertext=Buffer.concat([cipher.update(original),cipher.final()]);
  const sends=[];
  let uploadKey;
  let uploaded;
  const transport=new WechatTransport({ account: 'account',peer: 'peer',token: 'synthetic-only' },async (url,init) => {
    if(url.pathname==='/ilink/bot/getupdates') return new Response(JSON.stringify({
      get_updates_buf: 'with-file',msgs: [{
        message_id: '700',from_user_id: 'peer',to_user_id: 'account',
        message_type: 1,message_state: 2,context_token: 'fake-context',
        item_list: [{
          type: 4,file_item: {
            file_name: 'in.txt',len: String(original.length),
            media: { encrypt_query_param: 'fake',aes_key: key.toString('base64'),encrypt_type: 1 }
          }
        }]
      }],
    }));
    if(url.pathname==='/c2c/download') return new Response(ciphertext);
    if(url.pathname==='/ilink/bot/getuploadurl') {
      uploadKey=Buffer.from(JSON.parse(init.body).aeskey,'hex');
      return new Response(JSON.stringify({ upload_param: 'fake-upload' }));
    }
    if(url.pathname==='/c2c/upload') {
      const decrypt=createDecipheriv('aes-128-ecb',uploadKey,null);
      uploaded=Buffer.concat([decrypt.update(init.body),decrypt.final()]);
      return new Response('',{ headers: { 'x-encrypted-param': 'fake-receipt' } });
    }
    if(url.pathname==='/ilink/bot/sendmessage') {
      sends.push(JSON.parse(init.body).msg);
      return new Response(JSON.stringify({ message_id: String(800+sends.length) }));
    }
    assert.fail(`Unexpected endpoint ${url.pathname}`);
  });
  const service=new Service(f.context,{ ...f.config,fileRoots: [sourceRoot] },f.store,transport);
  await service.poll();
  await service.tick();
  const prompt=f.calls.find(call => call.name==='prompt');
  assert.equal(prompt.body.attachments[0].type,'file');
  assert.deepEqual(readFileSync(prompt.body.attachments[0].path),original);
  const source=join(sourceRoot,'out.txt');
  writeFileSync(source,'frozen output');
  await service.observe({
    sessionId: 'session-original',cwd: sourceRoot,event: {
      id: 'file-reply',type: 'assistant.message',data: { content: `[result](${source})` },
    }
  });
  writeFileSync(source,'changed after live capture');
  await service.tick();
  assert.equal(uploaded.toString(),'frozen output');
  assert(sends.some(send => send.item_list[0].type===4));
  assert(f.calls.every(call => ['session/get','session/chat','session/load','prompt'].includes(call.name)));
  const fileSendIndex=sends.findIndex(send => send.item_list[0].type===4);
  service.ingest([message('701','Quote file',{
    items: [{
      type: 1,text_item: { text: 'Quote file' },
      ref_msg: { svr_id: String(801+fileSendIndex),message_item: { type: 4 } }
    }]
  })],'quote-cursor',f.store.read().binding);
  await service.tick();
  const quotePrompt=f.calls.filter(call => call.name==='prompt').at(-1);
  assert.equal(readFileSync(quotePrompt.body.attachments[0].path,'utf8'),'frozen output');
  await service.stop();
});
test('unloaded binding is occupied; only inbound loads original ID; receipts are not event UUIDs',async t => {
  const f=fixture(t);
  await bind(f);
  assert.equal(f.calls.some(call => ['prompt','session/load'].includes(call.name)),false);
  const other=await f.manager.availability({ ...selection,sessionId: 'other' },new AbortController().signal);
  assert(other.reasons.some(reason => reason.code==='BINDING_OCCUPIED'));
  f.service.ingest([message('1')],'cursor-a',f.store.read().binding);
  await f.service.tick();
  const mutation=f.calls.filter(call => ['prompt','session/load'].includes(call.name));
  assert.deepEqual(mutation.map(call => call.name),['session/load','prompt']);
  assert(mutation.every(call => call.body.sessionId==='session-original'));
  assert.equal(f.store.read().inputs[0].messageId,'native-receipt-not-event-uuid');
  await f.service.observe({
    sessionId: 'session-original',cwd: f.root,event: {
      id: 'event-uuid',type: 'user.message',data: { messageId: 'native-receipt-not-event-uuid',content: 'hello' },
    }
  });
  assert.equal(f.store.read().inputs[0].reason,'NATIVE_MESSAGE_OBSERVED');
  f.service.ingest([message('1')],'cursor-b',f.store.read().binding);
  assert.equal(f.store.read().inputs.length,1);
});
test('availability aggregates configuration, occupied, unresolved and unknown without destructive cleanup',async t => {
  const f=fixture(t);
  await bind(f);
  f.store.change(state => { state.fault='UNKNOWN_SEND'; });
  const manager=new BindingManager(f.context,f.store,() => ['MISSING_CONFIG']);
  f.setHook(name => { if(name==='session/get') throw new Error('404'); });
  const result=await manager.availability({ ...selection,sessionId: 'other' },new AbortController().signal);
  assert.deepEqual(new Set(result.reasons.map(reason => reason.code)),
    new Set(['MISSING_CONFIG','UNRESOLVED_HISTORY','BINDING_EXISTENCE_UNKNOWN','BINDING_OCCUPIED']));
  assert.equal(f.store.read().binding.sessionId,'session-original');
});
test('saved replay is idempotent; competing bindings cannot both win',async t => {
  const f=fixture(t);
  await bind(f);
  const generation=f.store.read().generation;
  await f.manager.saved({ ...selection,notificationId: 'notification-1' },new AbortController().signal);
  assert.equal(f.store.read().generation,generation);
  await assert.rejects(f.manager.saved({ ...selection,sessionId: 'other',notificationId: 'notification-2' },
    new AbortController().signal),/BINDING_OCCUPIED/);
  assert.equal(f.store.read().notifications.length,1);
});
test('late missing query cannot retire a newer generation; abort forbids cleanup',async t => {
  const f=fixture(t);
  await bind(f);
  let resolve;
  f.setHook(name => name==='session/get'? new Promise(done => { resolve=done; }):undefined);
  const pending=f.manager.availability({ ...selection,sessionId: 'other' },new AbortController().signal);
  f.store.change(state => { state.generation++; state.binding={ sessionId: 'new',generation: state.generation }; });
  resolve({ meta: null });
  await pending;
  assert.equal(f.store.read().binding.sessionId,'new');
  const abort=new AbortController();
  const late=f.manager.availability(selection,abort.signal);
  abort.abort();
  resolve({ meta: null });
  await late;
  assert.equal(f.store.read().binding.sessionId,'new');
});
test('authoritative missing retires, but unknown historic work blocks replacement',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  f.setMeta(null);
  const result=await f.manager.availability({ ...selection,sessionId: 'other' },new AbortController().signal);
  assert.equal(f.store.read().binding,null);
  assert(result.reasons.some(reason => reason.code==='UNRESOLVED_HISTORY'));
  await assert.rejects(f.manager.saved({ ...selection,sessionId: 'other',notificationId: 'new' },
    new AbortController().signal),/UNRESOLVED_HISTORY/);
});
test('unknown prompt is persisted and never automatically retried',async t => {
  const f=fixture(t);
  await bind(f);
  f.setHook(name => { if(name==='prompt') throw new Error('timeout'); });
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  await f.service.tick();
  assert.equal(f.store.read().inputs[0].stage,'unknown');
  await f.service.tick();
  assert.equal(f.calls.filter(call => call.name==='prompt').length,1);
});
test('AskUser is sent as text; following text answers exact request, never prompt',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  await f.service.tick();
  f.getMeta().ask={ requestId: 'ask-1',question: 'Which color?',choices: ['Blue','Green'],allowFreeform: true };
  await f.service.tick();
  assert.match(f.sent.at(-1).items[0].text_item.text,/Which color/);
  f.service.ingest([message('2','Blue')],'cursor-2',f.store.read().binding);
  await f.service.tick();
  const answer=f.calls.find(call => call.name==='respondAsk');
  assert.deepEqual(answer.body,{ sessionId: 'session-original',requestId: 'ask-1',answer: 'Blue',wasFreeform: false });
  assert.equal(f.calls.filter(call => call.name==='prompt').length,1);
});
test('freeform answer obeys native allowFreeform and exact question identity',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  await f.service.tick();
  f.getMeta().ask={ requestId: 'ask-1',question: 'Which?',choices: ['Blue'],allowFreeform: false };
  await f.service.tick();
  f.service.ingest([message('2','custom')],'cursor-2',f.store.read().binding);
  await f.service.tick();
  assert.equal(f.calls.filter(call => call.name==='respondAsk').length,0);
  assert.equal(f.store.read().inputs[1].stage,'rejected');
  f.service.ingest([message('3','Blue')],'cursor-3',f.store.read().binding);
  f.getMeta().ask={ requestId: 'ask-2',question: 'Different?' };
  await f.service.tick();
  assert.equal(f.calls.filter(call => call.name==='respondAsk').length,0);
  assert.equal(f.store.read().inputs[2].stage,'rejected');
});
test('Web answered question never falls through to a new prompt',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  await f.service.tick();
  f.getMeta().ask={ requestId: 'ask-1',question: 'Name?',allowFreeform: true };
  await f.service.tick();
  f.service.ingest([message('2','my answer')],'cursor-2',f.store.read().binding);
  f.getMeta().ask=null;
  await f.service.tick();
  assert.equal(f.store.read().inputs[1].stage,'rejected');
  assert.equal(f.calls.filter(call => call.name==='prompt').length,1);
  assert.equal(f.calls.filter(call => call.name==='respondAsk').length,0);
});
test('shared live replies are mirrored once and unknown sends are blocked',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  await f.service.tick();
  const observation={
    sessionId: 'session-original',cwd: f.root,event: {
      id: 'event-2',type: 'assistant.message',data: { messageId: 'assistant-1',content: 'Reply from a Web turn' },
    }
  };
  await f.service.observe(observation);
  await f.service.observe(observation);
  let attempts=0;
  f.transport.send=async () => { attempts++; throw new Error('timeout'); };
  await f.service.tick();
  await f.service.tick();
  assert.equal(attempts,1);
  assert.equal(f.store.read().outputs[0].stage,'unknown');
});
test('historical local references are blocked without reading mutable source',async t => {
  const f=fixture(t);
  await bind(f);
  await f.service.observe({
    sessionId: 'session-original',cwd: f.root,event: {
      id: 'old',type: 'assistant.message',data: { content: '[file](/not/a/real/source.txt)' },
    }
  },false);
  assert.equal(f.store.read().outputs[0].stage,'unknown');
  assert.equal(f.store.read().outputs[0].reason,'HISTORICAL_FILE_SNAPSHOT_UNAVAILABLE');
});
test('stop prevents new sends while joining an already-started send',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  await f.service.tick();
  await f.service.observe({
    sessionId: 'session-original',cwd: f.root,event: {
      id: 'r',type: 'assistant.message',data: { content: 'hello' },
    }
  });
  let release;
  let started;
  const entered=new Promise(resolve => { started=resolve; });
  f.transport.send=() => { started(); return new Promise(resolve => { release=resolve; }); };
  const tick=f.service.tick();
  await entered;
  f.stopping.abort();
  const drain = f.service.stop();
  let drained = false;
  void drain.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release({ messageId: '123' });
  await Promise.all([tick, drain]);
  assert.equal(f.store.read().outputs[0].stage,'accepted');
  await assert.rejects(f.service.tick(),/SERVICE_STOPPING/);
});
test('restart preserves ambiguous intents as unknown',t => {
  const root=mkdtempSync(join(tmpdir(),'wechat-restart-'));
  const store=new Store(root,'account');
  store.change(state => state.inputs.push({ key: 'a:1',generation: 1,message: message('1'),stage: 'intent',operation: 'prompt' }));
  store.close();
  const recovered=new Store(root,'account');
  assert.equal(recovered.read().inputs[0].stage,'unknown');
  recovered.close();
  t.after(() => rmSync(root,{ recursive: true,force: true }));
});
test('expected stopping after a passive read does not persist a permanent fault',async t => {
  const f=fixture(t);
  await bind(f);
  let release;
  let entered;
  const started=new Promise(resolve => { entered=resolve; });
  f.setHook(name => name==='session/get'? new Promise(resolve => { release=resolve; entered(); }):undefined);
  await f.service.start();
  await started;
  f.stopping.abort();
  release({ meta: f.getMeta() });
  await f.service.stop();
  assert.equal(f.store.read().fault,undefined);
});
test('distinct assistant snapshots use event identity even with the same native messageId',async t => {
  const f=fixture(t);
  await bind(f);
  for(const [id,content] of [['snapshot-a','First'],['snapshot-b','Updated']]) {
    await f.service.observe({
      sessionId: 'session-original',cwd: f.root,event: {
        id,type: 'assistant.message',data: { messageId: 'same-native-id',content },
      }
    });
  }
  assert.equal(f.store.read().outputs.length,2);
  assert.deepEqual(f.store.read().outputs.map(output => output.text),['First','Updated']);
});
test('definitive Web answer race is rejected without freezing the next question',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  await f.service.tick();
  f.getMeta().ask={ requestId: 'ask-1',question: 'Question?' };
  await f.service.tick();
  f.service.ingest([message('2','answer')],'cursor-2',f.store.read().binding);
  f.setHook(name => {
    if(name==='respondAsk') {
      f.getMeta().ask={ requestId: 'ask-2',question: 'Next question?' };
      throw Object.assign(new Error('Request no longer pending'),{ code: 'REQUEST_NOT_PENDING' });
    }
  });
  await f.service.tick();
  assert.equal(f.store.read().inputs[1].stage,'rejected');
  await f.service.tick();
  assert(f.sent.some(send => send.items.some(item => item.text_item?.text.includes('Next question?'))));
});
test('unknown lazy load is never retried or replaced by session creation',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('1')],'cursor',f.store.read().binding);
  f.setHook(name => { if(name==='session/load') throw new Error('timeout'); });
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.store.read().inputs[0].operation,'load');
  assert.equal(f.store.read().inputs[0].stage,'unknown');
  assert.equal(f.calls.filter(call => call.name==='session/load').length,1);
  assert.equal(f.calls.filter(call => call.name==='prompt'||call.name==='session/new').length,0);
});
test('history traverses bounded backward pages in chronological delivery order',async t => {
  const f=fixture(t);
  const event=(id,content) => ({ id,type: 'assistant.message',data: { content } });
  f.setEvents([event('anchor','Old text must not replay')]);
  await bind(f);
  const queries=[];
  f.setHook((name,body) => {
    if(name!=='session/chat') return;
    queries.push(body);
    const page=!body.cursor? [event('e3','third'),event('e4','fourth')]
      :body.cursor==='older-1'? [event('e1','first'),event('e2','second')]:[event('anchor','old')];
    return {
      sessionId: body.sessionId,source: body.source,direction: body.direction,cursorStatus: 'ok',
      events: page,hasMore: body.cursor!=='older-2',cursor: !body.cursor? 'older-1':'older-2'
    };
  });
  await f.service.tick();
  assert.deepEqual(f.store.read().outputs.map(output => output.text),['first','second','third','fourth']);
  assert.equal(f.store.read().binding.anchor,'e4');
  assert.equal(queries.length,3);
  assert(queries.every(query => query.source==='persisted'&&query.direction==='backward'));
});
test('exact scoped quotes are retained and outgoing quote IDs require observed native input',async t => {
  const f=fixture(t);
  await bind(f);
  f.service.ingest([message('501','Original input')],'cursor',f.store.read().binding);
  await f.service.tick();
  await f.service.observe({
    sessionId: 'session-original',cwd: f.root,event: {
      id: 'uuid-only',type: 'user.message',data: { messageId: 'native-receipt-not-event-uuid',content: 'Original input' },
    }
  });
  await f.service.observe({
    sessionId: 'session-original',cwd: f.root,event: {
      id: 'out',type: 'assistant.message',data: { content: 'An answer' },
    }
  });
  await f.service.tick();
  assert.equal(f.sent[0].items[0].ref_msg.svr_id,'501');
  f.service.ingest([message('502','About that',{
    items: [{ type: 1,text_item: { text: 'About that' },ref_msg: { svr_id: '501' } }],
  })],'cursor-2',f.store.read().binding);
  await f.service.tick();
  const text=f.calls.filter(call => call.name==='prompt').at(-1).body.text;
  assert.match(text,/exact-local-id/);
  assert.match(text,/Original input/);
});
test('a late poll for a retired generation cannot reroute its message to a new binding',async t => {
  const f=fixture(t);
  await bind(f);
  let release;
  f.transport.poll=() => new Promise(resolve => { release=resolve; });
  const poll=f.service.poll();
  f.store.change(state => {
    state.generation++;
    state.binding={ sessionId: 'replacement',generation: state.generation,anchor: null };
  });
  release({ messages: [message('late')],cursor: 'late-cursor' });
  await poll;
  const state=f.store.read();
  assert.equal(state.inputs[0].generation,state.generation-1);
  assert.equal(state.inputs[0].stage,'unknown');
  assert.equal(state.cursor,'late-cursor');
  assert.equal(state.binding.contextToken,undefined);
  await f.service.tick();
  assert.equal(f.calls.some(call => call.name==='prompt'),false);
});
