import fs from 'node:fs';
import http from 'node:http';
import { requireThat } from './common.js';

export function lifecycleConfig(env = process.env) {
  if (env.SERVICE_DELIVERY_PORT === undefined) return null;
  const port = env.SERVICE_DELIVERY_PORT;
  requireThat(/^[1-9][0-9]{0,4}(?![\s\S])/.test(port ?? '') && Number(port) <= 65535,
    'SERVICE_DELIVERY_PORT_INVALID');
  const sha = env.SERVICE_DELIVERY_SHA;
  const artifactSha256 = env.SERVICE_DELIVERY_ARTIFACT;
  const requestId = env.SERVICE_DELIVERY_REQUEST;
  const instanceId = env.SERVICE_DELIVERY_INSTANCE;
  requireThat(/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/.test(sha ?? '')
    && /^[a-f0-9]{64}(?![\s\S])/.test(artifactSha256 ?? '')
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,119}(?![\s\S])/.test(requestId ?? '')
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}(?![\s\S])/.test(instanceId ?? ''),
  'SERVICE_DELIVERY_IDENTITY_INVALID');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  requireThat(typeof version === 'string' && version.length > 0, 'SERVICE_DELIVERY_VERSION_INVALID');
  return Object.freeze({ port: Number(port),
    identity: Object.freeze({ sha, artifactSha256, requestId, instanceId, version }) });
}

export async function startLifecycle(config, { state, requestDrain }) {
  const { port, identity } = config;
  let closed = false;
  const snapshot = () => {
    const current = state();
    const draining = current.drainRequested || current.draining;
    return { instanceId: identity.instanceId, drainProtocol: 1,
      running: !closed && current.running,
      restartPending: Boolean(draining),
      phase: draining ? 'draining' : current.ready ? 'running' : 'starting',
      reason: draining ? 'bridge-draining' : current.ready ? 'bridge-running' : 'bridge-starting' };
  };
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      res.end(JSON.stringify(value));
    };
    // This is a local process control channel, never a browser-authenticated API.
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${port}`
      || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      reply(403, { error: 'LIFECYCLE_LOCAL_ONLY' }); return;
    }
    if (req.method === 'GET' && req.url === '/version') {
      reply(200, identity); return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      const current = snapshot();
      reply(200, { instanceId: identity.instanceId, running: current.running,
        ok: current.running && current.phase === 'running', phase: current.phase }); return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      reply(200, snapshot()); return;
    }
    if (req.method !== 'POST' || req.url !== '/admin/restart') {
      reply(404, { error: 'LIFECYCLE_NOT_FOUND' }); return;
    }
    if (req.headers['content-type'] !== 'application/json') {
      reply(415, { error: 'LIFECYCLE_JSON_REQUIRED' }); return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        requireThat(size <= 1024, 'LIFECYCLE_BODY_INVALID');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requireThat(body && body.pending === true && Object.keys(body).length === 1,
        'LIFECYCLE_BODY_INVALID');
    } catch {
      reply(400, { error: 'LIFECYCLE_BODY_INVALID' }); return;
    }
    requestDrain();
    reply(200, snapshot());
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.setTimeout(5000, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    async close() {
      closed = true;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
