import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetNames, buildIdentity, git, hash, identity, repository } from './release-identity.mjs';
import { verifyRelease } from './package-release.mjs';

export function mergedIdentity(event, sequence) {
  assert.equal(event.repository.full_name, repository);
  assert.equal(event.action, 'closed');
  assert.equal(event.pull_request.merged, true);
  assert.equal(event.pull_request.base.ref, 'master');
  assert.equal(event.pull_request.base.repo.full_name, repository);
  assert.ok(Number.isSafeInteger(event.number) && event.number > 0);
  return identity(sequence, event.pull_request.merge_commit_sha);
}

// Each write gets one HTTPS request: never redirect, automatically retry, or replace an asset.
export function writeRemote(url, method, value, token = process.env.GH_TOKEN, transport = request) {
  assert.ok(token, 'Missing GitHub token');
  const endpoint = new URL(url);
  assert.ok(endpoint.protocol === 'https:' && ['api.github.com', 'uploads.github.com'].includes(endpoint.hostname)
    && !endpoint.username && !endpoint.password && !endpoint.port);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('GitHub write failed or is uncertain; inspect remote state before any rerun. No retry was sent.'));
    const req = transport(endpoint, { method, headers: {
      Authorization: `Bearer ${token}`, 'User-Agent': 'wechat-rolling-release',
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json',
      'Content-Length': bytes.length,
    } }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) response.destroy(new Error('Response exceeds limit'));
        else chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        if (!(response.statusCode >= 200 && response.statusCode < 300)) return fail();
        try { resolve(JSON.parse(Buffer.concat(chunks))); } catch { fail(); }
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error('Write timeout')));
    req.on('error', fail);
    req.end(bytes);
  });
}

export function githubApi(root) {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  const base = `repos/${repository}`;
  const read = (path, args = []) => execFileSync('gh', ['api', '--hostname', 'github.com', path,
    '--header', 'Cache-Control: no-cache', ...args],
  { timeout: 60_000, maxBuffer: 40 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const json = path => JSON.parse(read(path));
  const list = path => {
    const pages = JSON.parse(read(`${path}?per_page=100`, ['--paginate', '--slurp']));
    assert.ok(Array.isArray(pages) && pages.every(Array.isArray));
    return pages.flat();
  };
  const id = value => { assert.ok(Number.isSafeInteger(value) && value > 0); return value; };
  return {
    tags: tag => {
      const rows = git(root, 'ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
      if (!rows) return null;
      const entries = rows.split('\n').map(row => row.split(/\s+/));
      return (entries.find(row => row[1].endsWith('^{}')) ?? entries[0])[0];
    },
    releases: () => list(`${base}/releases`),
    release: value => json(`${base}/releases/${id(value)}`),
    assets: value => list(`${base}/releases/${id(value)}/assets`),
    download: value => read(`${base}/releases/assets/${id(value)}`, ['--header', 'Accept: application/octet-stream']),
    tag: build => writeRemote(`https://api.github.com/${base}/git/refs`, 'POST',
      { ref: `refs/tags/${build.tag}`, sha: build.sourceSha }),
    create: body => writeRemote(`https://api.github.com/${base}/releases`, 'POST', body),
    upload: (value, file) => writeRemote(
      `https://uploads.github.com/${base}/releases/${id(value)}/assets?name=${encodeURIComponent(file.name)}`, 'POST', file.bytes),
    publish: (value, body) => writeRemote(`https://api.github.com/${base}/releases/${id(value)}`, 'PATCH',
      { draft: false, prerelease: true, make_latest: 'false', body }),
  };
}

export function notes(build, number) {
  return `# WeChat ${build.version}\n\nMerged PR #${number} in ${repository}.\n\n`
    + `Source: ${build.sourceSha}\nTag: ${build.tag}\nSequence: ${build.sequence}\n\n`
    + 'Release publication does not install, restart, migrate, or authorize account consumption.\n';
}

export function seal(assets, files) {
  return '\n<!-- cockpit-rolling-assets-v1 -->\n' + JSON.stringify(assets.map(asset => ({
    id: asset.id, name: asset.name, size: asset.size, sha256: hash(files.find(file => file.name === asset.name).bytes),
  })).sort((a, b) => a.name.localeCompare(b.name))) + '\n';
}

export async function publish(build, number, files, api) {
  assert.deepEqual(files.map(file => file.name).sort(), assetNames(build.version));
  assert.ok(files.every(file => Buffer.isBuffer(file.bytes) && file.bytes.length));
  const body = notes(build, number);
  const verifyTag = async () => assert.equal(await api.tags(build.tag), build.sourceSha, 'Tag missing or changed');
  const inspect = async id => {
    const release = await api.release(id);
    assert.equal(release.id, id);
    assert.equal(release.tag_name, build.tag);
    assert.equal(release.target_commitish, build.sourceSha);
    assert.equal(release.name, `WeChat ${build.tag}`);
    assert.equal(release.prerelease, true);
    assert.equal(typeof release.draft, 'boolean');
    const assets = await api.assets(id);
    assert.equal(new Set(assets.map(asset => asset.name)).size, assets.length);
    assert.equal(new Set(assets.map(asset => asset.id)).size, assets.length);
    for (const asset of assets) {
      assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0);
      const file = files.find(file => file.name === asset.name);
      assert.ok(file, 'Unexpected asset');
      assert.equal(asset.state, 'uploaded');
      assert.equal(asset.size, file.bytes.length);
      assert.deepEqual(await api.download(asset.id), file.bytes, 'Remote bytes differ');
    }
    if (!release.draft) {
      assert.equal(assets.length, files.length, 'Published release incomplete; never mutate it');
      assert.equal(release.body, body + seal(assets, files));
    } else assert.equal(release.body, body);
    return { release, assets };
  };
  const matches = (await api.releases()).filter(release => release.tag_name === build.tag);
  assert.ok(matches.length <= 1, 'Ambiguous release');
  if (matches.length) {
    await verifyTag();
    const existing = await inspect(matches[0].id);
    assert.equal(existing.release.draft, false, 'Existing draft needs operator inspection; not resuming writes automatically');
    return { status: 'already_published', id: existing.release.id, immutable: existing.release.immutable ?? false };
  }
  const tag = await api.tags(build.tag);
  if (tag === null) await api.tag(build);
  else assert.equal(tag, build.sourceSha, 'Never replace a conflicting tag');
  await verifyTag();
  assert.equal((await api.releases()).filter(release => release.tag_name === build.tag).length, 0,
    'Release appeared during publication; inspect before rerun');
  const created = await api.create({ tag_name: build.tag, target_commitish: build.sourceSha,
    name: `WeChat ${build.tag}`, draft: true, prerelease: true, make_latest: 'false', body });
  assert.ok(Number.isSafeInteger(created.id) && created.id > 0, 'Unknown draft identity; inspect remote state');
  let current = await inspect(created.id);
  assert.equal(current.release.draft, true);
  assert.equal(current.assets.length, 0);
  for (const [index, file] of files.entries()) {
    await verifyTag();
    await api.upload(created.id, file);
    current = await inspect(created.id);
    assert.equal(current.release.draft, true);
    assert.deepEqual(current.assets.map(asset => asset.name).sort(), files.slice(0, index + 1).map(item => item.name).sort());
  }
  await verifyTag();
  await api.publish(created.id, body + seal(current.assets, files));
  current = await inspect(created.id);
  assert.equal(current.release.draft, false, 'Publication not confirmed');
  await verifyTag();
  return { status: 'published', id: created.id, immutable: current.release.immutable ?? false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(process.env.GITHUB_EVENT_NAME, 'pull_request_target');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH));
  const build = mergedIdentity(event, process.env.GITHUB_RUN_NUMBER);
  assert.deepEqual(buildIdentity(root), build);
  execFileSync('git', ['merge-base', '--is-ancestor', build.sourceSha, 'origin/master'], { cwd: root });
  const [directory, ...extra] = process.argv.slice(2);
  assert.ok(directory && !extra.length, 'Usage: rolling-release.mjs DIRECTORY');
  verifyRelease(root, resolve(directory), build);
  const files = assetNames(build.version).map(name => ({ name, bytes: readFileSync(join(directory, name)) }));
  console.log(JSON.stringify(await publish(build, event.number, files, githubApi(root))));
}
