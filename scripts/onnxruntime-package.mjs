// ONNX Runtime from Microsoft's official NuGet package (Microsoft.ML.OnnxRuntime): one package holds the native
// libraries of every platform (runtimes/<rid>/native/) with LICENSE and ThirdPartyNotices.txt. The GitHub release
// archives (github.com/microsoft/onnxruntime) are no longer reachable. Pure Node ZIP reader: no unzip/tar/PowerShell,
// identical behaviour in the Docker image and on every native build host.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const onnxPackageUrl = (versions, version) =>
  `${versions.onnxRuntimeSource}/${version}/microsoft.ml.onnxruntime.${version}.nupkg`;

/** Files of the package whose name matches `select(name)`, written under `destination` (`select` returns the relative target). */
export async function extractFromPackage(packagePath, select, destination) {
  const zip = await readFile(packagePath);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`Not a ZIP package: ${packagePath}`);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const written = [];
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    const relative = select(name);
    if (!relative) continue;
    if (relative.split(/[\\/]/).includes('..') || path.isAbsolute(relative)) throw new Error(`Unsafe package entry: ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    const content = method === 0 ? data : method === 8 ? inflateRawSync(data) : undefined;
    if (!content) throw new Error(`Unsupported compression ${method}: ${name}`);
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(target);
  }
  return written;
}

/** Native libraries of `rid` and the licences, flattened into `destination`. */
export const nativeRuntimeSelector = rid => name =>
  name.startsWith(`runtimes/${rid}/native/`) && !name.endsWith('/') ? path.posix.basename(name)
    : name === 'LICENSE' || name === 'ThirdPartyNotices.txt' ? name : undefined;
