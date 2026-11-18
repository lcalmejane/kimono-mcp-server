import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { onnxPackageUrl, extractFromPackage, nativeRuntimeSelector } from './onnxruntime-package.mjs';

const versions = JSON.parse(await readFile(new URL('../semantic/versions.json', import.meta.url)));
const destination = path.resolve(process.argv[2] ?? '/opt/kimono');
await mkdir(destination, { recursive: true });

async function download(url, target, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  if (hash.digest('hex') !== expected) {
    await rm(target);
    throw new Error(`SHA-256 mismatch: ${url}`);
  }
}

const architecture = { arm64: 'aarch64', x64: 'x64' }[process.arch];
if (process.platform !== 'linux' || !architecture) throw new Error('Semantic image supports Linux arm64 and x64');
// ONNX Runtime : paquet NuGet officiel de Microsoft ; bibliothèque dans onnxruntime/lib/ (ORT_DYLIB_PATH de l'image).
const packagePath = path.join(destination, 'onnxruntime.nupkg');
await download(onnxPackageUrl(versions, versions.onnxRuntime), packagePath, versions.onnxPackages[versions.onnxRuntime]);
const runtime = path.join(destination, 'onnxruntime');
const select = nativeRuntimeSelector(`linux-${architecture === 'aarch64' ? 'arm64' : 'x64'}`);
await extractFromPackage(packagePath, name => {
  const target = select(name);
  return target && (/^lib/.test(target) ? path.join('lib', target) : target);
}, runtime);
await rm(packagePath);
const model = path.join(destination, 'model');
await mkdir(model, { recursive: true });
const base = `https://huggingface.co/${versions.model.repository}/resolve/${versions.model.revision}`;
await download(`${base}/${versions.model.weights}`, path.join(model, 'model.onnx'), versions.model.weightsSha256);
await download(`${base}/tokenizer.json`, path.join(model, 'tokenizer.json'), versions.model.tokenizerSha256);
await download(versions.model.licenseUrl, path.join(model, 'LICENSE'), versions.model.licenseSha256);
await copyFile(new URL('../semantic/model.json', import.meta.url), path.join(model, 'model.json'));
await copyFile(new URL('../semantic/versions.json', import.meta.url), path.join(destination, 'versions.json'));
