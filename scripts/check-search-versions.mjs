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
assert.ok(cargo.includes(`ort = { version = "=${pinned.ort}"`), 'Cargo ort pin differs from versions.json');
assert.ok(lock.includes(`name = "ort"\nversion = "${pinned.ort}"`), 'Cargo.lock ort version differs from versions.json');
assert.ok(lock.includes(`name = "embsearch-core"\nversion = "${pinned.embsearchCore}"`), 'Cargo.lock embsearch-core version differs from versions.json');
assert.ok(helper.includes(`"version": "${pinned.embsearchCore}"`), 'Semantic engine response version differs from versions.json');
assert.ok(JSON.parse(spec).name.includes(pinned.model.revision), 'Model name differs from the pinned revision');
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']) {
  const native = pinned.nativeTargets?.[target];
  assert.ok(native, `Missing native runtime pin for ${target}`);
  assert.match(native.runtime ?? '', /^(osx|linux|win)-(arm64|x64)$/, `Invalid ONNX Runtime NuGet platform for ${target}`);
  assert.match(pinned.onnxPackages?.[native.onnxRuntime ?? pinned.onnxRuntime] ?? '', /^[a-f0-9]{64}$/,
    `Missing ONNX Runtime package checksum for ${target}`);
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
  const [fastGrep, embsearchCore, onnxRuntime, model, ort] = await Promise.all([
    json('https://crates.io/api/v1/crates/fast-grep'),
    json('https://crates.io/api/v1/crates/embsearch-core'),
    json(`${pinned.onnxRuntimeSource}/index.json`),
    json(`https://huggingface.co/api/models/${pinned.model.repository}`),
    json('https://crates.io/api/v1/crates/ort'),
  ]);
  // ort (liaison Rust d'ONNX Runtime) n'a que des préversions ; embsearch-core en fixe la version exacte. La montée n'est
  // exigée que si la dernière version d'embsearch-core l'autorise ; sinon elle est signalée comme bloquée.
  const embsearchDeps = await json(`https://crates.io/api/v1/crates/embsearch-core/${embsearchCore.crate.max_stable_version}/dependencies`);
  const ortRequired = embsearchDeps.dependencies?.find((dependency) => dependency.crate_id === 'ort')?.req?.replace(/^=/, '');
  const ortNewest = ort.crate.max_version;
  if (ortNewest !== ortRequired) {
    console.log(`ort ${ortNewest} is published; embsearch-core ${embsearchCore.crate.max_stable_version} still requires ${ortRequired} (upgrade blocked upstream).`);
  }
  const latest = {
    fastGrep: fastGrep.crate.max_stable_version,
    embsearchCore: embsearchCore.crate.max_stable_version,
    // NuGet lists every published version, oldest first; prereleases carry a suffix.
    onnxRuntime: onnxRuntime.versions?.filter((version) => /^\d+\.\d+\.\d+$/.test(version)).at(-1),
    modelRevision: model.sha,
    ort: ortRequired,
  };
  for (const [key, version] of Object.entries(latest)) {
    if (typeof version !== 'string' || !version) throw new Error(`No published stable version found for ${key}`);
  }
  const current = { fastGrep: pinned.fastGrep, embsearchCore: pinned.embsearchCore,
    onnxRuntime: pinned.onnxRuntime, modelRevision: pinned.model.revision, ort: pinned.ort };
  console.log(JSON.stringify({ current, latest }, null, 2));
  if (Object.keys(latest).some((key) => latest[key] !== current[key])) {
    throw new Error('New search dependencies available. Update versions/checksums, Cargo.toml/lock and Docker fast-grep pin, then run the real ONNX regression suite before publishing.');
  }
}
