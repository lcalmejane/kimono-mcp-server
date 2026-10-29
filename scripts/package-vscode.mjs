import { build } from 'esbuild';
import { createVSIX } from '@vscode/vsce';
import { cp, mkdir, readFile, readdir, chmod, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeEnvironment } from '../vscode/native.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = `${process.platform}-${process.arch}`;
const target = process.env.BUILD_TARGET ?? host;
const versions = JSON.parse(await readFile(path.join(root, 'semantic/versions.json'), 'utf8'));
if (!versions.nativeTargets[target] || target !== host) {
  throw new Error(`Package on a matching native runner (${host}); unsupported or mismatched target: ${target}`);
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Packaging requires Node.js 24 or newer.');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'vscode/package.json'), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Server and VS Code extension versions must match.');
const bundle = path.resolve(process.env.KIMONO_BUNDLE_DIR ?? path.join(root, 'native-bundles', target));
await nativeEnvironment(bundle, target);
const stage = path.resolve(process.env.KIMONO_VSIX_STAGE ?? path.join(root, 'vscode/.package'));
await mkdir(stage, { recursive: true });
if ((await readdir(stage)).length) throw new Error(`Packaging directory must be empty: ${stage}`);
await Promise.all([
  cp(path.join(root, 'vscode/extension.cjs'), path.join(stage, 'extension.cjs')),
  cp(path.join(root, 'vscode/native.cjs'), path.join(stage, 'native.cjs')),
  cp(path.join(root, 'vscode/stdio.cjs'), path.join(stage, 'stdio.cjs')),
  ...['panel.cjs', 'mcp-client.cjs', 'search.cjs', 'status.cjs'].map(file => cp(path.join(root, 'vscode', file), path.join(stage, file))),
  cp(path.join(root, 'vscode/management'), path.join(stage, 'management'), { recursive: true }),
  cp(path.join(root, 'vscode/media'), path.join(stage, 'media'), { recursive: true }),
  cp(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE')),
  cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(stage, 'THIRD_PARTY_NOTICES.md')),
  cp(path.join(root, 'vscode/README.md'), path.join(stage, 'README.md')),
  cp(bundle, path.join(stage, 'native'), { recursive: true }),
  mkdir(path.join(stage, 'runtime')),
  writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`),
]);
const executable = target.startsWith('win32-') ? 'node.exe' : 'node';
await cp(process.execPath, path.join(stage, 'runtime', executable));
if (process.platform === 'darwin') {
  const dependencies = execFileSync('otool', ['-L', process.execPath], { encoding: 'utf8' });
  const nodeLibrary = dependencies.match(/^\s+@rpath\/(libnode\.[^/\s]+\.dylib)\s/m)?.[1];
  if (nodeLibrary) await cp(path.resolve(path.dirname(process.execPath), '../lib', nodeLibrary),
    path.join(stage, 'runtime', nodeLibrary));
}
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
  { signal: AbortSignal.timeout(60_000) });
if (!license.ok) throw new Error(`Cannot obtain Node.js ${process.version} license: ${license.status}`);
await writeFile(path.join(stage, 'runtime/LICENSE'), await license.text());
const nativeManifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
if (!target.startsWith('win32-')) {
  await Promise.all([`runtime/${executable}`, `native/${nativeManifest.binaries.fgr}`, `native/${nativeManifest.binaries.semantic}`]
    .map(relative => chmod(path.join(stage, relative), 0o755)));
}
await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(stage, 'server/index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: "import { createRequire as kimonoCreateRequire } from 'node:module'; const require = kimonoCreateRequire(import.meta.url);" },
});
const output = path.resolve(process.env.KIMONO_VSIX_OUTPUT ?? path.join(root, 'vscode', `kimono-rag-mcp-${pkg.version}-${target}.vsix`));
await createVSIX({ cwd: stage, packagePath: output, target, dependencies: false });
const sha256 = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');
await writeFile(output.replace(/\.vsix$/, '.build.json'), `${JSON.stringify({
  schemaVersion: 1, version: pkg.version, target,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  node: process.version,
  lockfileSha256: await sha256(path.join(root, 'package-lock.json')),
  vsixSha256: await sha256(output),
  nativeManifest,
}, null, 2)}\n`);
console.log(`Packaged ${output}`);
