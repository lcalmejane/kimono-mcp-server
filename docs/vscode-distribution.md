# Standalone VS Code distribution

The extension lives in [`vscode/`](../vscode/) and is built **only from this
repository**. It does not consume Core or Agent sources, and needs no
cross-repository token. [Installation and integration (EN/FR)](../vscode/README.md).

## CI and release

The [CI workflow](../.github/workflows/ci.yml) tests the server and extension on
push/PR. On **Actions → CI → Run workflow** or a `v*` tag it additionally:

1. Builds the four existing native targets on matching GitHub runners.
2. Packages pinned native/model assets, the bundled MCP server and the runner's
   Node.js 24 executable and version-specific license in platform VSIX files.
3. Exercises each packaged provider/Node/server with a real stdio MCP handshake,
   tool listing, ROOT status, lexical search and a 384-dimensional ONNX embedding.
   It also verifies generic RAG without an entry point, scoped code retrieval and
   the client-independent `stdio.cjs` launcher included in the bundle.
   Embedded launch tests intentionally skip `resolveMcpServerDefinition`:
   discovered definitions must already contain verified native paths, isolated
   environment/cache and corpus settings for agent hosts that launch them directly.
   Remote bearer tokens remain late-bound and are not exposed during discovery.
4. Uploads `kimono-vscode-<target>` artifacts (VSIX + build provenance) and the
   existing native bundle artifacts, retained thirty days.

Manual runs **do not publish releases**. For a release:

1. Update **both** server and extension versions in [`package.json`](../package.json)
   and [`vscode/package.json`](../vscode/package.json); update the lockfile and changelog.
2. Commit and push the changes to this repository.
3. Push the matching tag, for example `v0.6.1` for version `0.6.1`.
4. Only after server tests, extension tests and all native/package smoke jobs pass,
   CI creates a draft release, attaches all `.vsix`, `.build.json`, native archives
   and `SHA256SUMS.txt`, then publishes it. Published immutable releases are not
   overwritten; fix failures before publishing, or use a new version/tag.

The GitHub release job needs no Marketplace account or PAT and has
`contents: write` via `GITHUB_TOKEN`; the other CI jobs have read-only
permissions. The tag-triggered CI publishes GitHub Releases only, never to
Marketplace or Open VSX.

Marketplace publication is a separate, explicitly manual operation using the
[Publish VS Code Marketplace workflow](../.github/workflows/publish-marketplace.yml).
It can only be dispatched from `main`, is never triggered by a tag, and
publishes the four platform VSIX files from an existing GitHub release. Before
dispatching it:

1. Create or verify the Marketplace publisher ID `ai-kido`.
2. Add a publisher-authorized VSCE Personal Access Token as repository secret
   `VSCE_PAT`. Never put the token in the repository, workflow inputs or chat.
3. Review the publisher profile and Marketplace listing/package content.
4. In **Actions → Publish VS Code Marketplace → Run workflow**, select the
   intended immutable release tag (default `v0.6.4`) and explicitly check the
   confirmation that the publisher/listing has been reviewed.

The workflow checks the tag against both package versions, requires an existing
published non-prerelease GitHub release, downloads and verifies its
`SHA256SUMS.txt`, and confirms all four VSIX targets before invoking `vsce`.
Each platform is a separate sequential matrix job because `vsce` publishes one
prebuilt platform VSIX per invocation; if a target fails, rerun only that failed
job after resolving the cause. VSCE validates `VSCE_PAT` and publisher rights
when executing the publish command; `vsce ls-publishers` is intentionally not
used because it lists locally stored logins, not GitHub Actions credentials.
The required confirmation checkbox is the final human approval; once the
workflow starts publishing, there is no later Marketplace confirmation step.
Do not dispatch until the listing is approved.
The new `v0.6.4` release will contain targets `darwin-arm64`, `linux-arm64`,
`linux-x64` and `win32-x64` under the extension ID `ai-kido.kimono-rag-mcp`.
Marketplace credentials and listing approval remain separate prerequisites.

See the [Marketplace publication brief](../vscode/fiche.md) for proposed public
metadata, copy and the remaining owner review checklist.

Each `.build.json` records the source commit, whether the checkout has uncommitted
changes (`sourceDirty`), version, host target, actual Node
version, npm lockfile SHA-256, VSIX SHA-256 and native asset manifest. Lockfiles
and model/runtime downloads are pinned. Hosted runner/toolchain updates and ZIP
timestamps mean this is traceable packaging, not a byte-identical build guarantee.
Treat an Actions artifact as a candidate until **the entire run** has passed.

## Local build

Use Node.js >=24 and the matching native OS/architecture. Install Rust/Cargo
when building the native engines:

```sh
npm ci
npm run typecheck
npm run test:vscode
npm run bundle:native -- --target darwin-arm64 --output native-bundles/darwin-arm64
npm run package:vscode
npm run test:vscode:integration
```

`BUILD_TARGET` defaults to the host; cross-packaging is rejected.
`KIMONO_BUNDLE_DIR` can point to an existing verified native bundle instead of
building one. Output is `vscode/kimono-rag-mcp-<version>-<target>.vsix`, plus provenance.
The ignored `vscode/.package/` staging directory must be empty before packaging;
remove only that staging directory before rebuilding.

Packaging bundles JavaScript dependencies with esbuild, retains legal comments,
verifies every native asset hash, and includes runtime/model notices. No workspace
knowledge, `.env`, credentials, tests, sources or development `node_modules` are
included in the VSIX. Internet is needed at build time for dependencies, pinned
assets and Node's license; installed local search needs no runtime downloads.

The native matrix currently covers macOS ARM64, Linux ARM64/x64 (glibc), Windows
x64. Supporting other native hosts requires adding their pinned runtime assets
and real native build/smoke jobs first. A mock provider test is not proof of a
VS Code UI/session: manual VSIX installation in a supported desktop/remote host
remains the final interactive check.
