import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const pinned = JSON.parse(await readFile(new URL('../semantic/versions.json', import.meta.url), 'utf8'));
const [dockerfile, cargo, lock, helper, spec] = await Promise.all([
  readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
  readFile(new URL('../semantic/Cargo.toml', import.meta.url), 'utf8'),
  readFile(new URL('../semantic/Cargo.lock', import.meta.url), 'utf8'),
  readFile(new URL('../semantic/src/main.rs', import.meta.url), 'utf8'),
  readFile(new URL('../semantic/model.json', import.meta.url), 'utf8'),
]).then(files => files.map(text => text.replace(/\r\n/g, '\n')));
assert.ok(dockerfile.includes(`ARG FAST_GREP_VERSION=${pinned.fastGrep}\n`), 'Docker fast-grep pin differs from versions.json');
assert.ok(cargo.includes(`embsearch-core = { version = "=${pinned.embsearchCore}"`), 'Cargo embsearch-core pin differs from versions.json');
assert.ok(lock.includes(`name = "embsearch-core"\nversion = "${pinned.embsearchCore}"`), 'Cargo.lock embsearch-core version differs from versions.json');
assert.ok(helper.includes(`"version": "${pinned.embsearchCore}"`), 'Semantic engine response version differs from versions.json');
assert.ok(JSON.parse(spec).name.includes(pinned.model.revision), 'Model name differs from the pinned revision');
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']) {
  const native = pinned.nativeTargets?.[target];
  assert.ok(native, `Missing native runtime pin for ${target}`);
  assert.match(native.sha256, /^[a-f0-9]{64}$/, `Invalid ONNX Runtime archive checksum for ${target}`);
  assert.ok(native.archive.includes(native.onnxRuntime ?? pinned.onnxRuntime), `ONNX Runtime archive version differs for ${target}`);
}

async function json(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'kimono-mcp-server-version-check' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Version lookup failed (${response.status}): ${url}`);
  return response.json();
}

if (process.argv.includes('--offline')) {
  console.log('Search dependency pins are consistent.');
} else {
  const [fastGrep, embsearchCore, onnxRuntime, model] = await Promise.all([
    json('https://crates.io/api/v1/crates/fast-grep'),
    json('https://crates.io/api/v1/crates/embsearch-core'),
    json('https://api.github.com/repos/microsoft/onnxruntime/releases/latest'),
    json(`https://huggingface.co/api/models/${pinned.model.repository}`),
  ]);
  const latest = {
    fastGrep: fastGrep.crate.max_stable_version,
    embsearchCore: embsearchCore.crate.max_stable_version,
    onnxRuntime: onnxRuntime.tag_name?.replace(/^v/, ''),
    modelRevision: model.sha,
  };
  for (const [key, version] of Object.entries(latest)) {
    if (typeof version !== 'string' || !version) throw new Error(`No published stable version found for ${key}`);
  }
  const current = { fastGrep: pinned.fastGrep, embsearchCore: pinned.embsearchCore,
    onnxRuntime: pinned.onnxRuntime, modelRevision: pinned.model.revision };
  console.log(JSON.stringify({ current, latest }, null, 2));
  if (Object.keys(latest).some((key) => latest[key] !== current[key])) {
    throw new Error('New search dependencies available. Update versions/checksums, Cargo.toml/lock and Docker fast-grep pin, then run the real ONNX regression suite before publishing.');
  }
}
