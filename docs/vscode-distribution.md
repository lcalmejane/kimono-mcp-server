# VS Code distribution

[Version française](vscode-distribution.fr.md) · [Project README](../README.md)

The extension source is in [`vscode/`](../vscode/). Its platform VSIX files are
built by GitHub Actions. See the [installation guide](../vscode/README.md).

## Marketplace text

The text shown in the Marketplace comes from the extension package:

- `displayName`, `description` and `keywords` come from
  [`vscode/package.json`](../vscode/package.json).
- The Marketplace overview is the `README.md` inside the VSIX. The packaging
  script copies [`vscode/README.md`](../vscode/README.md) into the package root.
- [`vscode/fiche.md`](../vscode/fiche.md) is an editorial reference; it is not
  included in the VSIX and does not update the Marketplace page by itself.

The publish workflow uploads an existing release VSIX; it does not rebuild it.
Marketplace text changes therefore require a new package version, a new GitHub
release and a Marketplace publication.

## CI and release

The [CI workflow](../.github/workflows/ci.yml) tests the server and extension on
push/PR. On **Actions → CI → Run workflow** or a `v*` tag it additionally:

1. Builds the five native targets on matching GitHub runners.
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
3. Push the matching tag, for example `v1.2.3` for version `1.2.3`.
4. Only after server tests, extension tests and all native/package smoke jobs pass,
   CI creates a draft release, attaches all `.vsix`, `.build.json`, native archives
   and `SHA256SUMS.txt`, then publishes it. Published immutable releases are not
   overwritten; fix failures before publishing, or use a new version/tag.
5. After release publication succeeds, CI calls the reusable Marketplace workflow
   with that exact tag and the repository's `VSCE_PAT` secret.

The GitHub release job needs no Marketplace account or PAT and has
`contents: write` via `GITHUB_TOKEN`; the other CI jobs have read-only
permissions. Marketplace publishing requires the credential described below.
Open VSX is not published automatically.

## Marketplace publication and recovery

Marketplace publication runs automatically after a successful tagged release using the
[Publish VS Code Marketplace workflow](../.github/workflows/publish-marketplace.yml).
It uploads the five platform VSIX files from the published release without
rebuilding them. The CI calls it directly: a release created with `GITHUB_TOKEN`
does not need to trigger a second workflow event. Before pushing a release tag:

1. Create or verify the Marketplace publisher ID `ai-kido`.
2. Add a publisher-authorized VSCE Personal Access Token as repository secret
   `VSCE_PAT`. Never put the token in the repository, workflow inputs or chat.
3. Review the publisher profile and Marketplace listing/package content.
4. Treat pushing the version tag as approval to publish that package to both
   GitHub Releases and the Marketplace.

For recovery, use **Actions → Publish VS Code Marketplace → Run workflow** on
`main`, enter the existing immutable release tag and check the listing-review
confirmation. No new version or rebuild is needed to retry accepted packages.
PRs, ordinary branch pushes and manual CI builds do not publish to Marketplace.

The workflow checks the tag against both package versions, requires an existing
published non-prerelease GitHub release, downloads and verifies its
`SHA256SUMS.txt`, and confirms all five VSIX targets before invoking `vsce`.
It uploads all five targets before checking Marketplace visibility, so indexing
delays on one platform do not block the others. `--skip-duplicate` makes retries
continue past targets already accepted. Publication runs are serialized and a
new run never cancels an active publication. Visibility checks retry up to sixty
times with twenty-second waits, including failed lookups. If visibility is still
unconfirmed, the workflow fails explicitly; uploaded packages remain published
and the same tag can be retried manually.
VSCE validates `VSCE_PAT` and publisher rights when executing the publish
command; `vsce ls-publishers` is intentionally not used because it lists locally
stored logins, not GitHub Actions credentials.
For manual recovery, the confirmation checkbox authorizes publication.
There is no later Marketplace confirmation step.
The release contains targets `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64` and `win32-x64` under the extension ID `ai-kido.kimono-rag-mcp`.
Marketplace credentials and listing approval remain separate prerequisites.

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

The native matrix currently covers macOS ARM64/Intel, Linux ARM64/x64 (glibc), Windows
x64. `darwin-x64` is built on the `macos-15-intel` runner and pins its own ONNX Runtime
(1.23.2, `onnxRuntime` in the target entry of `semantic/versions.json`) because upstream
stopped publishing `osx-x86_64` archives after that release; the other targets keep 1.31.0.
The packaged Intel build must pass the real 384-dimensional embedding smoke test in CI
on an Intel runner before it is released. Supporting other native hosts requires adding their pinned runtime assets
and real native build/smoke jobs first. A mock provider test is not proof of a
VS Code UI/session: manual VSIX installation in a supported desktop/remote host
remains the final interactive check.
