import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildIdentity, inventory, shipped, sourceHash } from './release-identity.mjs';
const identity = buildIdentity(process.cwd());
const result = await build({
  entryPoints: ['native/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'bundle',
  metafile: true,
});
const licenses = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  let root = dirname(input);
  while (root !== 'node_modules' && !existsSync(join(root, 'package.json'))) root = dirname(root);
  if (root === 'node_modules') throw new Error(`Missing dependency metadata: ${input}`);
  if (licenses.has(root)) continue;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const license = ['LICENSE', 'license', 'LICENSE.md', 'license.md', 'LICENSE.txt', 'license.txt']
    .map(name => join(root, name)).find(file => existsSync(file));
  if (!license) throw new Error(`Missing bundled dependency license: ${pkg.name}`);
  licenses.set(root, `${pkg.name}@${pkg.version}\n\n${readFileSync(license, 'utf8')}`);
}
writeFileSync('dist/THIRD_PARTY_LICENSES.txt', [...licenses.values()].join('\n\n-----\n\n'));
writeFileSync('.module-build-receipt.json', JSON.stringify({
  build: identity, sourceHash: sourceHash(process.cwd()), files: inventory(process.cwd(), shipped),
}) + '\n');
