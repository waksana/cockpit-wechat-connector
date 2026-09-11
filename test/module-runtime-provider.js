// External test preload only: never included in the module release allowlist.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const origin = process.env.WECHAT_FIXTURE_ORIGIN;
const auditFile = process.env.WECHAT_FIXTURE_NETWORK_LOG;
assert.match(origin ?? '', /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
assert.ok(auditFile);
const transport = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const requested = new URL(input);
  const method = init.method ?? 'GET';
  let target;
  if (requested.origin === 'https://ilinkai.weixin.qq.com') {
    assert.equal(method, 'POST');
    assert.equal(requested.pathname + requested.search, '/ilink/bot/getupdates');
    target = new URL('/weixin/ilink/bot/getupdates', origin);
  } else {
    assert.equal(requested.origin, origin, 'Fixture refuses every external network destination');
    assert.ok((method === 'GET' && requested.pathname === '/capabilities')
      || (method === 'POST' && ['/intent/session/get', '/intent/session/chat'].includes(requested.pathname)),
    'Fixture refuses login, prompt, send, typing and all other mutations');
    target = requested;
  }
  assert.equal(target.origin, origin);
  fs.appendFileSync(auditFile, `${JSON.stringify({
    requestedOrigin: requested.origin, networkOrigin: target.origin, path: target.pathname, method,
  })}\n`, { mode: 0o600 });
  return transport(target, { ...init, redirect: 'manual' });
};
