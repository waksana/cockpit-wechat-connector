import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const repository = 'waksana/cockpit-wechat-connector';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
export const shipped = [
  'dist/index.js', 'dist/THIRD_PARTY_LICENSES.txt', 'LICENSE', 'LICENSE.tencent',
  'THIRD_PARTY_NOTICES.md', 'README.md', 'docs/MODULE.md', 'docs/DELIVERY.md',
];

export function identity(sequence, sourceSha) {
  assert.match(String(sequence), /^[1-9]\d*$/);
  assert.ok(Number.isSafeInteger(Number(sequence)));
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const version = `0.0.0-rolling.${sequence}`;
  return { repository, sourceSha, sequence: Number(sequence), version, tag: `v${version}` };
}

export function buildIdentity(root, env = process.env) {
  const sourceSha = git(root, 'rev-parse', 'HEAD');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  const manifest = JSON.parse(readFileSync(join(root, 'cockpit.module.json')));
  assert.equal(pkg.version, manifest.version);
  if (env.ROLLING_SEQUENCE !== undefined || env.ROLLING_SOURCE_SHA !== undefined) {
    assert.equal(env.ROLLING_SOURCE_SHA, sourceSha, 'Rolling source must be the checkout HEAD');
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=normal'), '', 'Rolling requires clean source');
    return identity(env.ROLLING_SEQUENCE, sourceSha);
  }
  return { version: pkg.version, sourceSha };
}

export function sourceHash(root) {
  const paths = git(root, 'ls-files', '-z').split('\0').filter(Boolean).sort();
  return hash(Buffer.concat(paths.flatMap(path => [
    Buffer.from(`${path}\0`), Buffer.from(hash(readFileSync(join(root, path))) + '\0'),
  ])));
}

export function inventory(root, paths) {
  return paths.map(path => {
    const bytes = readFileSync(join(root, path));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  });
}

export function assetNames(version) {
  const name = `wechat-${version}.tgz`;
  return [name, `${name}.sha256`, 'cockpit-deployment.json', 'cockpit-deployment.json.sha256'].sort();
}
