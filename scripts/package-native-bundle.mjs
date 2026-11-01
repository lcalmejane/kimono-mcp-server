import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(await readFile(path.join(root, 'semantic/versions.json'), 'utf8'));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const name = key === '--output' ? 'out' : key.slice(2);
  if (!key.startsWith('--') || index + 1 >= process.argv.length || options.has(name)) {
    throw new Error('Usage: npm run bundle:native -- --target <target> --output <empty-dir> [--fgr <path> --semantic <path>] [--assets-dir <prepared-assets>] [--code-model <local-model-dir>]');
  }
  options.set(name, process.argv[index + 1]);
}

const target = options.get('target');
const config = versions.nativeTargets[target];
// A target may pin its own ONNX Runtime when upstream stopped publishing it (macOS Intel).
const onnxRuntimeVersion = config?.onnxRuntime ?? versions.onnxRuntime;
if (!config) throw new Error(`Unsupported native target: ${target ?? '(missing)'}`);
const output = path.resolve(options.get('out') ?? '');
if (!options.has('out')) {
  throw new Error('Usage: npm run bundle:native -- --target <target> --output <empty-dir> [--fgr <path> --semantic <path>] [--assets-dir <prepared-assets>] [--code-model <local-model-dir>]');
}
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error(`Output directory must be empty: ${output}`);

const work = path.join(output, '.prepare');
const runtimeDir = path.join(output, 'lib');
const modelDir = path.join(output, 'model');
const codeModelDir = path.join(output, 'code-model');
const binaryDir = path.join(output, 'bin');
const runtimeLicenseDir = path.join(output, 'licenses/onnxruntime');
const assetsDir = options.has('assets-dir') ? path.resolve(options.get('assets-dir')) : undefined;
const codeModelSource = options.has('code-model') ? path.resolve(options.get('code-model')) : undefined;
await Promise.all([mkdir(work), mkdir(runtimeDir), mkdir(modelDir), mkdir(binaryDir), mkdir(runtimeLicenseDir, { recursive: true })]);
if (codeModelSource) await mkdir(codeModelDir);
let codeModelManifest;
if (codeModelSource) {
  const spec = JSON.parse(await readFile(path.join(codeModelSource, 'model.json'), 'utf8'));
  if (!spec || typeof spec.name !== 'string'
    || !spec.name.startsWith('jina-embeddings-v2-base-code@')
    || spec.dim !== 768 || spec.pooling !== 'mean' || spec.normalize !== true
    || spec.max_tokens !== 512 || (spec.query_prefix != null) || (spec.document_prefix != null)) {
    throw new Error(`Unsupported code model profile in ${codeModelSource}/model.json`);
  }
  for (const filename of ['model.onnx', 'tokenizer.json', 'model.json', 'LICENSE']) {
    const info = await lstat(path.join(codeModelSource, filename));
    if (!info.isFile()) throw new Error(`Code model bundle entry is not a regular file: ${codeModelSource}/${filename}`);
  }
  codeModelManifest = {
    name: spec.name,
    dimensions: spec.dim,
    maxTokens: spec.max_tokens,
    files: {},
  };
}
const extension = target.startsWith('win32-') ? '.exe' : '';
if (options.has('fgr') !== options.has('semantic')) {
  throw new Error('Pass both --fgr and --semantic, or neither to build the executables here.');
}
let fgr;
let semantic;
if (options.has('fgr')) {
  fgr = path.resolve(options.get('fgr'));
  semantic = path.resolve(options.get('semantic'));
} else {
  const nativeHost = {
    'darwin-arm64': process.platform === 'darwin' && process.arch === 'arm64',
    'darwin-x64': process.platform === 'darwin' && process.arch === 'x64',
    'linux-arm64': process.platform === 'linux' && process.arch === 'arm64',
    'linux-x64': process.platform === 'linux' && process.arch === 'x64',
    'win32-x64': process.platform === 'win32' && process.arch === 'x64',
  }[target];
  if (!nativeHost) throw new Error(`Building ${target} requires a matching native runner; provide prebuilt binaries to package cross-target assets.`);
  const cargoBin = path.join(work, 'cargo/bin');
  execFileSync('cargo', [
    'install', 'fast-grep', '--version', versions.fastGrep, '--locked', '--root', path.join(work, 'cargo'),
  ], { cwd: root, stdio: 'inherit' });
  execFileSync('cargo', [
    'build', '--release', '--locked', '--manifest-path', 'semantic/Cargo.toml',
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, ORT_SKIP_DOWNLOAD: '1' } });
  execFileSync('cargo', [
    'test', '--release', '--locked', '--manifest-path', 'semantic/Cargo.toml',
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, ORT_SKIP_DOWNLOAD: '1' } });
  fgr = path.join(cargoBin, `fgr${extension}`);
  semantic = path.join(root, `semantic/target/release/kimono-semantic${extension}`);
}
for (const binary of [fgr, semantic]) {
  if (!(await stat(binary)).isFile()) throw new Error(`Native executable not found: ${binary}`);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, destination, expectedHash) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  if (await sha256(destination) !== expectedHash) {
    await rm(destination, { force: true });
    throw new Error(`SHA-256 mismatch: ${url}`);
  }
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filename));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(filename);
  }
  return files;
}

async function copyRuntimeFiles(files) {
  const mainLibrary = files.find((filename) => path.basename(filename) === config.library);
  if (!mainLibrary) throw new Error(`Runtime assets do not contain ${config.library}`);
  const ordered = [mainLibrary, ...files.filter((filename) => filename !== mainLibrary)];
  const seenHashes = new Set();
  for (const filename of ordered) {
    const digest = await sha256(filename);
    if (seenHashes.has(digest)) continue;
    seenHashes.add(digest);
    await copyFile(filename, path.join(runtimeDir, path.basename(filename)));
  }
}

const archivePath = path.join(work, config.archive);
const runtimePattern = new RegExp(config.libraryPattern);
const modelBase = `https://huggingface.co/${versions.model.repository}/resolve/${versions.model.revision}`;
if (assetsDir) {
  const sourceVersions = JSON.parse(await readFile(path.join(assetsDir, 'versions.json'), 'utf8'));
  if (sourceVersions.onnxRuntime !== onnxRuntimeVersion
    || sourceVersions.model?.revision !== versions.model.revision) {
    throw new Error(`Prepared assets do not match pinned versions: ${assetsDir}`);
  }
  const runtimeSource = path.join(assetsDir, 'onnxruntime');
  const runtimeFiles = (await walk(path.join(runtimeSource, 'lib')))
    .filter((filename) => runtimePattern.test(path.basename(filename)));
  await copyRuntimeFiles(runtimeFiles);
  for (const licenseName of ['LICENSE', 'ThirdPartyNotices.txt']) {
    const license = path.join(runtimeSource, licenseName);
    try {
      await stat(license);
      await copyFile(license, path.join(runtimeLicenseDir, licenseName));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const sourceModelDir = path.join(assetsDir, 'model');
  const sourceModelFiles = [
    ['model.onnx', versions.model.weightsSha256],
    ['tokenizer.json', versions.model.tokenizerSha256],
    ['LICENSE', versions.model.licenseSha256],
  ];
  for (const [name, expectedHash] of sourceModelFiles) {
    const source = path.join(sourceModelDir, name);
    if (await sha256(source) !== expectedHash) throw new Error(`Prepared model file checksum mismatch: ${source}`);
    await copyFile(source, path.join(modelDir, name));
  }
} else {
  const runtimeUrl = `https://github.com/microsoft/onnxruntime/releases/download/v${onnxRuntimeVersion}/${config.archive}`;
  await download(runtimeUrl, archivePath, config.sha256);
  if (config.format === 'tgz') execFileSync('tar', ['-xzf', archivePath, '-C', work]);
  else if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:ORT_ARCHIVE -DestinationPath $env:ORT_DESTINATION -Force',
    ], { env: { ...process.env, ORT_ARCHIVE: archivePath, ORT_DESTINATION: work } });
  } else execFileSync('unzip', ['-q', archivePath, '-d', work]);
  const runtimeFiles = (await walk(work)).filter((filename) => runtimePattern.test(path.basename(filename)));
  await copyRuntimeFiles(runtimeFiles);
  for (const licenseName of ['LICENSE', 'ThirdPartyNotices.txt']) {
    const license = (await walk(work)).find((filename) => path.basename(filename) === licenseName);
    if (license) await copyFile(license, path.join(runtimeLicenseDir, licenseName));
  }
  await Promise.all([
    download(`${modelBase}/${versions.model.weights}`, path.join(modelDir, 'model.onnx'), versions.model.weightsSha256),
    download(`${modelBase}/tokenizer.json`, path.join(modelDir, 'tokenizer.json'), versions.model.tokenizerSha256),
    download(versions.model.licenseUrl, path.join(modelDir, 'LICENSE'), versions.model.licenseSha256),
  ]);
}
await Promise.all([
  copyFile(path.join(root, 'semantic/model.json'), path.join(modelDir, 'model.json')),
  copyFile(path.join(root, 'semantic/versions.json'), path.join(output, 'versions.json')),
  copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'THIRD_PARTY_NOTICES.md')),
  copyFile(fgr, path.join(binaryDir, `fgr${target.startsWith('win32-') ? '.exe' : ''}`)),
  copyFile(semantic, path.join(binaryDir, `kimono-semantic${target.startsWith('win32-') ? '.exe' : ''}`)),
]);
if (codeModelSource) {
  for (const filename of ['model.onnx', 'tokenizer.json', 'model.json', 'LICENSE']) {
    const source = path.join(codeModelSource, filename);
    const destination = path.join(codeModelDir, filename);
    await copyFile(source, destination);
    codeModelManifest.files[filename] = await sha256(destination);
  }
}
await rm(work, { recursive: true, force: true });

const nativeHost = {
  'darwin-arm64': process.platform === 'darwin' && process.arch === 'arm64',
  'darwin-x64': process.platform === 'darwin' && process.arch === 'x64',
  'linux-arm64': process.platform === 'linux' && process.arch === 'arm64',
  'linux-x64': process.platform === 'linux' && process.arch === 'x64',
  'win32-x64': process.platform === 'win32' && process.arch === 'x64',
}[target];
if (nativeHost) {
  const requestPath = path.join(output, '.semantic-smoke-request.json');
  await writeFile(requestPath, JSON.stringify({
    operation: 'embed',
    model: modelDir,
    text: 'native semantic bundle smoke test',
    usage: 'query',
  }));
  const searchPath = process.platform === 'win32'
    ? `${runtimeDir};${process.env.PATH ?? ''}`
    : `${runtimeDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const smokeOutput = execFileSync(semantic, [requestPath], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORT_DYLIB_PATH: path.join(runtimeDir, config.library),
      PATH: searchPath,
    },
  });
  await rm(requestPath, { force: true });
  const smoke = JSON.parse(smokeOutput);
  if (smoke.dimensions !== 384 || !Array.isArray(smoke.vector)
    || smoke.vector.length !== 384
    || smoke.vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Native semantic embedding smoke test failed for ${target}`);
  }
}

const relative = (filename) => path.relative(output, filename).split(path.sep).join('/');
const binaryPaths = {
  fgr: `bin/fgr${target.startsWith('win32-') ? '.exe' : ''}`,
  semantic: `bin/kimono-semantic${target.startsWith('win32-') ? '.exe' : ''}`,
};
const files = {};
for (const filename of (await walk(output)).sort()) {
  const name = relative(filename);
  files[name] = await sha256(filename);
}
const manifest = {
  schemaVersion: 1,
  target,
  binaries: binaryPaths,
  onnxRuntime: {
    library: `lib/${config.library}`,
    directory: 'lib',
  },
  modelDir: 'model',
  ...(codeModelManifest ? { codeModelDir: 'code-model', codeModel: codeModelManifest } : {}),
  files,
};
await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Packaged ${target} native assets at ${output}`);
