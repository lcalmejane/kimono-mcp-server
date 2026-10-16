# Kimono MCP Server

Standalone MCP server for an AI-KIDO knowledge base, usable by tatami-core, VS Code, Claude Code and other MCP clients. Commands, agents/personas, skills, workflows, concepts, techniques, use cases and hard points are discovered from `AIKIDO_ROOT`, not a static catalogue.

The standard AI-KIDO base is protected. A separate, explicitly writable project/fork can be edited and synchronized with its own Git remote.

## MCP capabilities

| Tool | Operations |
| --- | --- |
| `aikido` | `list`, `search`, `read`, `activate`, `execute`, `refresh` |
| `aikido_embed` | Generate a local text embedding with `usage=query` (default) or `document`; returns the numeric vector and model metadata without changing ROOT/indexes |
| `aikido_root` | `status`, `init`: initialize the configured ROOT from the official or another Git repository |
| `aikido_search` | `mode`: `literal` (default), `regex` (fast-grep), or `semantic` (local multilingual embsearch-core/ONNX); paths, lines, excerpts and semantic scores |
| `aikido_index` | `update`, `rebuild`, `compact`, `stats`; `mode`: `literal` (default) or `semantic` |
| `aikido_git` | Scoped, structured Git operations on the configured project |
| `aikido_file` | Create/update/delete text documents; overwrites/deletes require exact previous contents |

Documents also appear as resources (`aikido://<encoded-relative-path>`) and prompts (`aikido.<kind>.<encoded-relative-path>`), with completions.

`activate` and its `execute` alias return instructions/context for the connected assistant. They do **not** claim an LLM workflow has run. The client executes those instructions with its own tools/approvals, including Kimono's file/Git tools when enabled. Kimono has no embedded LLM or unrestricted shell.

The initial Kimono scaffold lacked Git/file actions and indexed search; these are now separate MCP tools.

## Requirements

- Node.js 24+, Git, and `fgr` on PATH for native execution.
- Rust/Cargo to install the published `fast-grep` crate.
- Or Docker Engine with Compose v2: the Linux arm64/x64 image contains Node.js, Rust, Cargo, Git, OpenSSH, `fgr`, `kimono-semantic`, ONNX Runtime and the multilingual embedding model.

```sh
cargo install fast-grep --version 0.5.0 --locked
npm ci
npm run build
```

The crate is named **fast-grep**; its binary is **fgr**, not `fgrep`.

## Initialize or select a ROOT

Select an existing AI-KIDO checkout, or explicitly install one:

```sh
# Standard base:
node dist/cli.js init --root /absolute/path/to/aikido --ref main
# Separate project/fork:
node dist/cli.js init --root /absolute/path/to/project \
  --repository https://github.com/your-org/your-aikido.git --ref main
# Serve an existing ROOT:
node dist/cli.js serve --root /absolute/path/to/project
```

The default source is `https://github.com/lcalmejane/aikido.git`. `--repository` overrides `AIKIDO_REPOSITORY`; `--ref` overrides `AIKIDO_REF`. HTTPS, SSH and absolute local repository paths are accepted.

Installation retains full history, uses argument arrays (no shell interpolation), validates `prompts/index.md` or `index.md`, and places the clone at its target only after success. Absent/empty targets are accepted; non-empty targets are never overwritten.

The server can also start with an absent/empty configured ROOT. Invoke:

```json
{"operation":"init","repository":"https://github.com/your-org/your-aikido.git","ref":"main"}
```

on `aikido_root` to initialize **that ROOT only**, never an arbitrary path provided by the client. Discovery requires initialization first. MCP initialization needs a writable disk mount, but does not unlock subsequent writes to the standard base.

## Indexed search

Literal/regex searches use **fast-grep 0.5.0**, installed from crates.io. The default remains literal, so existing clients do not change behavior.

At startup, Kimono builds/updates the index for the actual ROOT. Before every search it rescans the catalogue and incrementally updates the index, covering added/changed/deleted files, including external edits. MCP Git/file operations also update it.

Only discovered text documents enter a private search mirror. Binary files, symlinks, dependency/build directories and files over 2 MiB are excluded. `prompts/spec/` is excluded unless `AIKIDO_INCLUDE_SPEC=true` explicitly enables that private space. Excluded files never enter the fgr index.

The persistent cache lives **outside AIKIDO_ROOT**. This allows indexing a read-only standard base without changing it. Treat the cache as sensitive: it contains document copies. An image cannot ship a prebuilt index for a ROOT chosen later.

Updates/searches are serialized in-process. Use one server process per ROOT/cache; independent processes need distinct cache directories.

```sh
# Maintain the index without starting MCP:
AIKIDO_ROOT=/absolute/path/to/aikido node dist/cli.js index
```

### Local semantic search

Use `aikido_search` (or `aikido` with `operation: "search"`) with:

```json
{"mode":"semantic","query":"Comment proteger les identifiants secrets ?","limit":5}
```

For a raw embedding, call **`aikido_embed`**:

```json
{"text":"Comment proteger les identifiants secrets ?","usage":"query"}
```

For model introspection without text or inference, call the same tool:

```json
{"operation":"info"}
```

This returns the **active local model**, not a hard-coded catalogue:
`engine`, `version`, `model` (the identifier to reuse as `embeddingModel`),
`name`, `dimensions`, `normalized`, `maxTokens`, `pooling`, `queryPrefix`,
`documentPrefix`, and `sha256` for each of `model.onnx`, `tokenizer.json` and
`model.json`, plus a compatibility disclaimer. The helper opens the model to
validate it, but computes no embedding, reads no ROOT document and updates no
index. Retain this response alongside stored vectors to identify and reproduce
the exact files/preprocessing later; retain the model files or their pinned
download sources too (hashes do not provide a download service).
Only the currently configured model is served; this is not a multi-model
registry or automatic historical-model installer. A missing/incompatible model
produces an explicit error. Existing calls without `operation` still embed text.

The response contains `engine`, `version`, `model`, `usage`, `dimensions`,
`normalized`, `maxTokens`, and `vector` (384 finite numbers with the bundled
model). `query` uses E5's query prefix; `document` uses its passage prefix.
Compare vectors generated by the same model and preprocessing settings.
This tool works even before ROOT initialization and does not read knowledge
documents or update either index. Its private temporary request file is removed
after execution. Input must be non-blank and at most 32,768 UTF-8 bytes.
The model tokenizer truncates to its token cap (512 for the bundled model);
this operation returns one vector, not automatic chunking of a long document.
Missing/incompatible models return an explicit MCP error.

### Search using an existing vector

Pass the `vector` and exact `model` returned by `aikido_embed` to `aikido_search`
as `vector` and `embeddingModel`, respectively:

```js
// embedding = parsed result of aikido_embed({ text: "...", usage: "query" })
const argumentsForSearch = {
  mode: "semantic",
  vector: embedding.vector,
  embeddingModel: embedding.model,
  limit: 5
};
```

Supply **exactly one of `query` or `vector`**. Vector input requires explicit
`mode: "semantic"` and `embeddingModel`; `kind` and `limit` work as for text
search. The `aikido` tool also accepts these fields with `operation: "search"`.
The index synchronizes before vector searches too; Kimono does not re-embed the
supplied query vector, but still embeds new/changed knowledge passages.
The response has the same passage/score shape as text semantic search.

**Model compatibility disclaimer:** dimensions alone are not enough. Kimono
rejects model identifiers differing from its active model, wrong dimensions,
non-finite float32 values and zero vectors. The caller remains responsible for
truthfully identifying vector provenance and using the same weights, tokenizer,
pooling, normalization and prefix conventions. Labeling an incompatible vector
with the expected model identifier does not make it compatible and cannot be
detected reliably. Normally embed search questions with `usage: "query"`.
A `document` vector can also retrieve similar passages, but a single truncated
document vector is not equivalent to the knowledge base's chunk embeddings.
Model changes require regenerating client-held vectors.

**embsearch-core 0.3.4** generates real embeddings with **ONNX Runtime 1.31.0**
and **multilingual-e5-small int8** (384 dimensions, normalized mean pooling,
E5 query/passage prefixes). French questions can retrieve English passages and
vice versa. Documents and queries stay local: no external inference API.
The image downloads the pinned public model/tokenizer (~135 MB combined) and
runtime at build time, verifying SHA-256. Runtime inference works offline.

Results contain `engine`, `version`, `model`, `chunks`, `embedded`, `count`, and
`results` with document metadata, `path`, `line`, `excerpt`, `score` (cosine
similarity, higher is better, not a probability). Filtering by `kind` happens
before the result limit. There is no relevance threshold: unrelated queries can
still produce nearest neighbors. Results are chunks, so a document can appear
more than once.

The semantic index initializes lazily, refreshes against the current catalogue
before every MCP search/index call, and only re-embeds changed chunks. The
persistent vector store lives alongside the literal index outside ROOT.
The same exclusions apply, including private specs. Chunking bounds passages to
500 Unicode characters with starting line numbers. It is not a reranker or an
LLM answer generator. The current flat cosine index targets knowledge bases, not
large document warehouses; each request accepts at most 64 MiB of discovered
text. Requests load the model locally and verify its fingerprint; initial
indexing takes longer than cached searches. Reserve at least 1 GiB of container
memory initially and measure on your corpus; this is not a hard memory bound.
Semantic subprocesses time out explicitly after ten minutes.
For a sizeable base, pre-index using the CLI before exposing the server, or
configure a sufficiently long MCP client request timeout for the first indexing
call. The index is lazy to avoid blocking server startup.

Measured on the standard AI-KIDO Git base in the local Linux arm64 Docker
environment: **322 documents / 4,378 chunks**, initial indexing **~6 min 12 s**,
then a cached semantic query **~1.74 s**, with **zero chunks re-embedded**.
These are observations, not performance guarantees; CPU/corpus size matters.

Maintain it with `aikido_index`:

```json
{"operation":"rebuild","mode":"semantic"}
```

`update`, `compact` and `stats` also synchronize first (and can initialize an
absent index). CLI equivalent:

```sh
AIKIDO_ROOT=/absolute/path/to/aikido node dist/cli.js index --mode semantic
```

For native semantic execution, build the locked helper and supply a compatible
ONNX model directory and runtime:

```sh
ORT_SKIP_DOWNLOAD=1 cargo build --release --locked --manifest-path semantic/Cargo.toml
export KIMONO_SEMANTIC_BIN="$PWD/semantic/target/release/kimono-semantic"
export KIMONO_MODEL_DIR=/absolute/path/to/model
export ORT_DYLIB_PATH=/absolute/path/to/libonnxruntime.so
```

The model directory must contain `model.onnx`, `tokenizer.json`, and a
[model.json](semantic/model.json) specification matching its dimensions,
pooling and input names (`input_ids`, `attention_mask`, `token_type_ids`).
Missing or incompatible models/runtimes return MCP errors, never a lexical or
fake-vector fallback. Use Docker for the bundled, verified combination.

Versions are pinned for reproducibility in [versions.json](semantic/versions.json)
and [Cargo.lock](semantic/Cargo.lock). `ort 2.0.0-rc.10` is constrained by
embsearch-core; it loads the newer runtime's backward-compatible C API, tested
with real inference. Run `node scripts/check-search-versions.mjs` to compare the
pins with the latest stable crates/runtime and model revision; the weekly GitHub
workflow fails visibly when an update is available. Upgrades require new
checksums/lockfile and passing the real semantic tests, not silent untested
downloads at startup. Third-party provenance is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## MCP clients

Stdio is the default transport. Example VS Code configuration:

```json
{
  "servers": {
    "kimono": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/kimono-mcp-server/dist/index.js"],
      "env": { "AIKIDO_ROOT": "/absolute/path/to/aikido" }
    }
  }
}
```

For Claude Code or another stdio client, use the same executable, arguments and environment in that client's MCP configuration. Diagnostic output goes to stderr, preserving the MCP stdout stream.

## Docker Compose

```sh
cp .env.example .env
# Set AIKIDO_HOST_PARENT and AIKIDO_DIR.
# Set MCP_AUTH_TOKEN to a long random secret.
docker compose up --build -d
```

The image installs `fast-grep` using `cargo install fast-grep --version 0.5.0 --locked` and retains Rust/Cargo at runtime. It runs as UID 1000 (`node`). Host directories must be readable by that UID and writable for installation/project editing.

Defaults expect `./data/aikido`. The knowledge mount is read-only by default; a named `kimono-cache` volume stores the index. Only `127.0.0.1` is published. HTTP MCP requests need `Authorization: Bearer <MCP_AUTH_TOKEN>`. `/healthz` is unauthenticated and reveals no knowledge data.

```sh
# Explicit installation using AIKIDO_REPOSITORY and AIKIDO_REF from .env:
docker compose --profile install run --build --rm install-aikido
docker compose up --build -d kimono-mcp-server
```

The server never performs an implicit Git fetch/pull at startup. For remote/public use, terminate TLS and enforce an authenticated, authorized reverse proxy; do not expose HTTP directly to the Internet.

### Writable projects

For a **separate trusted project/fork**, set both:

```dotenv
AIKIDO_WRITABLE=true
AIKIDO_VOLUME_MODE=rw
```

This does not unlock the official base: the origin and its effective fetch/push URLs are checked before mutations. Adding or pushing/fetching an official remote is rejected. Use separate Kimono instances for the standard base and a writable project.

Supported structured Git operations:

```text
status log diff show blame ls-files reflog remote
add restore rm commit fetch pull push switch checkout branch tag
merge rebase rebase-abort rebase-continue cherry-pick revert reset
stash stash-pop remote-add
```

Examples for `aikido_git`:

```json
{"operation":"add","paths":["prompts/gen/concepts/architecture.md"]}
{"operation":"commit","message":"docs: update project architecture"}
{"operation":"push","remote":"origin","ref":"main","confirm":true}
```

As intentionally agreed, this is a structured Git API, not an unrestricted Git/shell runner. Branch/tag operations create refs; `reset` is mixed and `pull` is fast-forward only. Force-push/hard-reset, custom aliases and arbitrary Git flags/configuration are not exposed. `push`/`reset` need `confirm=true` only after explicit client/user approval. Relevant hooks, fsmonitor, external diff and textconv are disabled.

Configure Git identity and credentials on the runner, not in tool arguments or source files. Native Git supports `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`. With Compose, pass these explicitly through a local service override or mount an appropriate scoped Git config. For SSH, explicitly provide a scoped key/known_hosts or an agent socket; credentials are not bundled in the image.

Writable mode is for trusted repositories and authorized clients: Git configuration/filters and remote servers can execute code. This API is not a sandbox. HTTP tokens authorize the whole configured instance, including enabled writes. Git history/diff tools expose repository contents independently of the search index exclusions; those exclusions are not Git access controls.

## Validation and publication

```sh
npm run typecheck
npm test
npm run build
# Equivalent real Git/fgr tests without local Rust:
docker build --target test -t kimono-mcp-test .
docker run --rm kimono-mcp-test
```

CI builds the Docker test stage and runs type checking, all tests (including real
ONNX inference) and the TypeScript build. Native `npm test` skips semantic tests
unless `KIMONO_MODEL_DIR` is set; Docker/CI always sets it. Rust unit tests run
while building the helper. The container publication workflow publishes GHCR
images for `v*` tags to `ghcr.io/lcalmejane/kimono-mcp-server`.

Source repository: [lcalmejane/kimono-mcp-server](https://github.com/lcalmejane/kimono-mcp-server) (currently private).

## License

MIT. See [LICENSE](LICENSE). Third-party dependencies retain their own licenses.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `AIKIDO_ROOT` | required | Existing AI-KIDO root or absent/empty initialization target. |
| `AIKIDO_REPOSITORY` | official Git URL | Default source for CLI/MCP/Compose installation. |
| `AIKIDO_REF` | `main` | Branch/tag for explicit installation. |
| `AIKIDO_WRITABLE` | `false` | Opt-in project mutations; cannot unlock the official base. |
| `AIKIDO_INCLUDE_SPEC` | `false` | Explicitly expose private personal specs in discovery/indexing. |
| `KIMONO_CACHE_DIR` | `~/.cache/kimono` | Cache parent outside ROOT; contains sensitive document copies. |
| `FGR_BIN` | `fgr` | Path to the fast-grep executable. |
| `KIMONO_SEMANTIC_BIN` | `kimono-semantic` | Local embsearch-core helper executable. |
| `KIMONO_MODEL_DIR` | `/opt/kimono/model` in Docker | Local ONNX model, tokenizer and spec; required for semantic mode. |
| `ORT_DYLIB_PATH` | `/opt/kimono/onnxruntime/lib/libonnxruntime.so` in Docker | Dynamic ONNX Runtime library; use the native library extension outside Linux. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or authenticated Streamable `http`. |
| `MCP_HOST` | `127.0.0.1` | HTTP address; Compose uses `0.0.0.0` inside the container. |
| `MCP_PORT` | `3000` | HTTP port, 1-65535. |
| `MCP_AUTH_TOKEN` | required for HTTP | Bearer token protecting the complete MCP instance. |
| `AIKIDO_HOST_PARENT` | `./data` | Compose host parent directory. |
| `AIKIDO_DIR` | `aikido` | Checkout directory relative to the host parent. |
| `AIKIDO_VOLUME_MODE` | `ro` | Compose mount mode; `rw` for editing/MCP initialization. |
