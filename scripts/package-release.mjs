import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assetNames, buildIdentity, hash, inventory, shipped, sourceHash } from './release-identity.mjs';
import { moduleProduct } from './deployment-manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export function descriptor(project, build) {
  assert.ok(build.sequence, 'A deployment descriptor needs a real Rolling identity');
  return { format: 2, channel: 'rolling', ...build,
    archive: { name: `wechat-${build.version}.tgz` }, product: moduleProduct(project) };
}

export function packageRelease(project, output, env = process.env) {
  const build = buildIdentity(project, env);
  const receipt = JSON.parse(readFileSync(join(project, '.module-build-receipt.json')));
  assert.deepEqual(receipt, { build, sourceHash: sourceHash(project), files: inventory(project, shipped) },
    'Build inputs or output changed; rebuild before packaging');
  const manifest = JSON.parse(readFileSync(join(project, 'cockpit.module.json')));
  const pkg = JSON.parse(readFileSync(join(project, 'package.json')));
  assert.equal(manifest.id, 'wechat');
  assert.equal(manifest.backend, 'dist/index.js');
  manifest.version = build.version;
  const archiveName = `wechat-${build.version}.tgz`;
  mkdirSync(output);
  const stage = mkdtempSync(join(tmpdir(), 'wechat-package-'));
  try {
    for (const path of shipped) {
      assert.ok(lstatSync(join(project, path)).isFile(), `Not a regular package input: ${path}`);
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      cpSync(join(project, path), join(stage, path), { recursive: false });
    }
    writeFileSync(join(stage, 'cockpit.module.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(stage, 'package.json'), JSON.stringify({
      name: pkg.name, version: build.version, type: pkg.type, engines: pkg.engines,
    }, null, 2) + '\n');
    const paths = [...shipped, 'cockpit.module.json', 'package.json'];
    if (build.sequence) {
      const bytes = JSON.stringify(descriptor(project, build), null, 2) + '\n';
      writeFileSync(join(stage, 'cockpit-deployment.json'), bytes);
      writeFileSync(join(output, 'cockpit-deployment.json'), bytes, { flag: 'wx' });
      paths.push('cockpit-deployment.json');
    }
    writeFileSync(join(stage, 'module-build.json'), JSON.stringify({
      format: 1, product: 'wechat', version: build.version, sourceSha: build.sourceSha,
      files: inventory(stage, paths),
    }, null, 2) + '\n');
    execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-czf', join(output, archiveName), ...paths.sort(), 'module-build.json'], { cwd: stage });
    for (const name of [archiveName, ...(build.sequence ? ['cockpit-deployment.json'] : [])]) {
      writeFileSync(join(output, `${name}.sha256`), `${hash(readFileSync(join(output, name)))}  ${name}\n`, { flag: 'wx' });
    }
    return join(output, archiveName);
  } finally {
    rmSync(stage, { recursive: true });
  }
}

export function verifyRelease(project, directory, expected) {
  assert.deepEqual(readdirSync(directory).sort(), assetNames(expected.version));
  const name = `wechat-${expected.version}.tgz`;
  const archive = join(directory, name);
  for (const file of [name, 'cockpit-deployment.json']) {
    assert.equal(readFileSync(join(directory, `${file}.sha256`), 'utf8'),
      `${hash(readFileSync(join(directory, file)))}  ${file}\n`);
  }
  const bytes = readFileSync(join(directory, 'cockpit-deployment.json'));
  assert.deepEqual(JSON.parse(bytes), descriptor(project, expected));
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(new Set(names).size, names.length);
  const paths = [...shipped, 'cockpit.module.json', 'package.json', 'module-build.json', 'cockpit-deployment.json'].sort();
  assert.deepEqual(names.sort(), paths, 'Unexpected archive members');
  const entries = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(entries.every(entry => entry.startsWith('-')), 'Links and special files are forbidden');
  const read = path => execFileSync('tar', ['-xOzf', archive, path], { maxBuffer: 32 * 1024 * 1024 });
  assert.deepEqual(read('cockpit-deployment.json'), bytes);
  const manifest = JSON.parse(read('cockpit.module.json'));
  assert.deepEqual(manifest, { ...JSON.parse(readFileSync(join(project, 'cockpit.module.json'))), version: expected.version });
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, expected.version);
  assert.equal(pkg.type, 'module');
  const receipt = JSON.parse(read('module-build.json'));
  assert.deepEqual(receipt, { format: 1, product: 'wechat', version: expected.version, sourceSha: expected.sourceSha,
    files: [...shipped, 'cockpit.module.json', 'package.json', 'cockpit-deployment.json'].map(path => {
      const content = read(path);
      return { path, bytes: content.length, sha256: hash(content) };
    }) });
  // Packaging provenance includes the exact bundled output, not just an internally consistent inventory.
  for (const path of shipped) assert.deepEqual(read(path), readFileSync(join(project, path)));
  return JSON.parse(bytes);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, ...extra] = process.argv.slice(2);
  assert.ok(directory && extra.length === 0, 'Usage: package-release.mjs pack|verify DIRECTORY');
  if (command === 'pack') console.log(packageRelease(root, resolve(directory)));
  else if (command === 'verify') console.log(verifyRelease(root, resolve(directory), buildIdentity(root)));
  else throw new Error('Expected pack or verify');
}
