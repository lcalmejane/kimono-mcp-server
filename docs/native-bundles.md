# Embedded native bundles

The `ci.yml` GitHub Actions workflow builds the locked `fgr` and
`kimono-semantic` executables on native runners for `darwin-arm64`,
`linux-arm64`, `linux-x64`, and `win32-x64`. Each run packages the matching
ONNX Runtime and the pinned multilingual model; the resulting artifacts are
self-contained and need no first-run downloads or container runtime.
`workflow_dispatch` rebuilds all targets on demand; pushing a `v*` version tag
also publishes one `.tar.gz` per target and a `SHA256SUMS.txt` file to that
GitHub Release, after requiring the tag (for example, `v0.3.0`) to match the
package version. Pull requests do not publish release assets. Each native
packaging run compiles and tests the locked semantic crate and runs a real
384-dimensional ONNX embedding against the packaged model/runtime.

On a matching native runner with Rust installed, build both executables and
package the runtime assets with:

```sh
npm run bundle:native -- \
  --target linux-arm64 \
  --output native-bundles/linux-arm64
```

When preparing from an already-built compatible Docker image, extract its
verified `/opt/kimono` assets and pass `--assets-dir /path/to/kimono-assets`.
The packager checks the pinned model-file hashes and the versions metadata
before copying those assets; no dependency rebuild or asset download is needed.

Supported `--target` values are `darwin-arm64`, `linux-arm64`, `linux-x64`,
and `win32-x64`. The output directory must be empty. The command builds
`fgr` and `kimono-semantic` from their pinned versions using Cargo. To package
prebuilt executables instead, pass both `--fgr` and `--semantic`. Versions and SHA-256
checksums for downloaded ONNX Runtime archives and model files are pinned in
[`semantic/versions.json`](../semantic/versions.json); the packager fails on
any mismatch. It retains the model license, ONNX Runtime notices, and the
project's [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

## Bundle manifest contract

Every output has a `manifest.json` with schema version 1:

```json
{
  "schemaVersion": 1,
  "target": "linux-arm64",
  "binaries": {
    "fgr": "bin/fgr",
    "semantic": "bin/kimono-semantic"
  },
  "onnxRuntime": {
    "library": "lib/libonnxruntime.so",
    "directory": "lib"
  },
  "modelDir": "model",
  "files": {
    "bin/fgr": "<sha256>",
    "bin/kimono-semantic": "<sha256>",
    "lib/libonnxruntime.so": "<sha256>",
    "model/model.onnx": "<sha256>"
  }
}
```

The `files` object contains SHA-256 hashes for every regular file in the
bundle except `manifest.json` itself. Consumers must reject unknown targets,
missing files, path traversal, and hash mismatches before using the bundle.
For process launch, use `binaries.fgr`, `binaries.semantic`,
`onnxRuntime.library`, and `modelDir` relative to the bundle root; expose
`lib` to the child process loader as required by the host OS.
