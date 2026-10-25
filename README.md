# Kimono MCP Server

Standalone MCP server for **local project RAG by default**, usable by tatami-core,
VS Code, Claude Code and other MCP clients. It indexes generic UTF-8 source code
and documentation without requiring an AI-KIDO entry point.

Select `KIMONO_CORPUS_MODE=aikido` (CLI `--corpus-mode aikido`, VS Code
`kimono.corpusMode: "aikido"`) for AI-KIDO discovery, activation, private-spec
exclusions and collaboration. Commands, agents/personas, skills and workflows
are then discovered from `AIKIDO_ROOT`, not a static catalogue.
RAG mode is read-only for project files; edits/Git remain with
the client. Both modes use the same local lexical/semantic engines and compact
MCP retrieval, not a hosted embedding API or an embedded LLM.

In both modes, root and nested `.gitignore` rules apply automatically to the
shared corpus used for discovery, snapshots and lexical/semantic search.
Includes cannot override ignored paths. Dependencies/build outputs such as
`node_modules`, `dist` and `build` stay excluded even without a `.gitignore`.
**Migration from 0.5.x:** select `aikido` explicitly to retain AI-KIDO behavior;
the presence of an AI-KIDO entry point does not change the default mode.

See **[Local RAG usage / Usage RAG local](docs/local-rag.md)** for supported
languages, host-controlled include/exclude rules, large-project budgets/scoped
snapshots, and Copilot, Claude Code, Codex and Antigravity configurations.
This can reduce unnecessary context sent to an assistant; it does not guarantee
a token/billing reduction or force a client to use MCP. Retrieved passages can
still be sent to the client's model provider even though indexing is local.

For reproducible evidence rather than unmeasured savings claims, see the
[paired harness benchmark](docs/harness-benchmark.md): frozen corpus, Copilot
with/without MCP, real usage telemetry, persisted results and quality review gates.
The [current fixed-model pilot](benchmarks/results/current.md) uses audited
native-only baselines and the current batched retrieval runtime.
Its planning pair measured **71.4% less cumulative input** and **52.0% less
wall time** with Kimono. This is one exploratory pair, not a validated savings
claim: human review is pending; the separate native research answer failed
the JSON-format gate. No universal percentage or billing reduction is promised.

## One knowledge base. Your team. Your agents.

Kimono is more than a way to shorten a search response: it gives MCP clients
a common retrieval interface over project knowledge that people can maintain.
Use a shared HTTP service when several assistants need the same configured
corpus; embedded stdio remains a dedicated local process per client.
Snapshots pin each research session to a captured version, not a live,
automatically synchronized conversation across agents.

**The value proposition is shared, inspectable knowledge—not a guaranteed
cheaper grep.** Retrieval overhead may be a reasonable trade-off for a team
seeking a common knowledge layer. Single-agent RAG trials do not measure
collaboration benefits or establish a fixed "collaboration tax".
See the [current measurements and limitations](benchmarks/results/current.md).

Default RAG provides read-only retrieval. Explicit AI-KIDO mode additionally
supports versioned knowledge publication, comparison and conflict handling.
Human users work through their editors and MCP clients; Kimono is not a
shared chat, permission-management system or concurrent code editor.
See the [shared-service and replica guide](docs/usage.en.md#explicit-knowledge-collaboration-modes)
and [discover the AI-KIDO / Tatami ecosystem](https://ai-kido.fr).

Kimono centralizes project knowledge. Clients edit their own files; shared
knowledge revisions can be explicitly reconciled through `aikido_collaboration`
without writing the client workspace or requiring Git.

## Short usage guides / Guides pratiques

- [VS Code: install the standalone GitHub VSIX (English / français)](vscode/README.md)
- [Build and release the VS Code extension with GitHub CI](docs/vscode-distribution.md)
- [Local RAG: generic projects, large repositories and MCP clients (EN/FR)](docs/local-rag.md)

- [English: standalone, integration and concurrent clients](docs/usage.en.md)
- [Français : standalone, intégration et clients concurrents](docs/usage.fr.md)
- [English / Français: progressive JSON search, metadata, ranges and harness integration](docs/retrieval.md)

## MCP capabilities

| Tool | Operations |
| --- | --- |
| `aikido` | Snapshot-scoped `list`, `search`, `read`, `activate`, `execute` |
| `aikido_snapshot` | `begin`, `end`; immutable multi-call corpus snapshot with expiry/resource limits |
| `aikido_embed` | Generate a local text embedding with `usage=query` (default) or `document`; returns the numeric vector and model metadata without changing ROOT/indexes |
| `aikido_root` | `status` for the configured knowledge ROOT |
| `aikido_search` | Snapshot-scoped literal/regex/text/semantic/hybrid/vector search; default `detail=compact`: only paths, inclusive `[start,end]` ranges and snapshot ID, no code. `locations` adds metadata, `excerpts` adds text; both explicit diagnostics. |
| `aikido_index` | `update` refreshes external indexes; non-blocking semantic `status` |
| `aikido_git` | `infos`, anonymous read-only remote `sync` after explicit `retarget`, metadata-only `retarget` |
| `aikido_collaboration` | Generic MCP-only `guidance`, `status`, three-way `compare`, revision-pinned `read`, and optimistic `publish` |
| `aikido_file` | Snapshot-scoped read-only JSON `ranges` (batch of up to 50 line ranges, merged, one byte budget), `metadata`, `outline`, `read` (lines/section/full) |

**Batch-first retrieval:** send `aikido_search` a `queries` array (1–20 strings,
shared mode/filters, per-query errors and one response budget), then combine
the useful hits into one `aikido_file operation=ranges` call. Single queries and
vectors remain compatible. See [batch contracts and continuation](docs/retrieval.md#batch-searches-then-batch-reads).
The three retrieval tool definitions are **22.5% smaller in serialized bytes**
even with batching added; this is not a new model-token savings measurement.

Kimono is a knowledge-only MCP: it never commits, pushes, merges, creates
branches or changes a Git remote. The ROOT may be a dedicated directory without
`.git`. `retarget` explicitly stores a credential-free Git URL and optional
existing branch in the external cache; the project-policy manifest URL is
informational and is never used as a sync target by itself. `sync` then reads
that remote anonymously or with the current user's host-provided read credentials, publishes/indexes its knowledge files, and preserves
local unpublished knowledge as local-seed/conflict copies. With no retarget,
sync fails and does not imply remote freshness. Current remote sync supports
public and private repositories. Hosts can inject a per-request credential resolver.
For Tatami Core, `connectionId` is a nonsecret reference resolved in the
authenticated member's account; an empty reference forces anonymous access.
Standalone stdio can read `KIMONO_GIT_PROFILE_FILE`, a 0600/0400 JSON file outside
ROOT containing `transport`, `host`, `username`, `secret` and verified
`knownHosts` for SSH. HTTPS credentials and SSH keys are restricted to the exact
configured host and transport; SSH host verification is mandatory.
Authentication material is never accepted in MCP arguments or indexed.
Temporary askpass/key files are removed after each retrieval. External file changes
can still be indexed with `aikido_index update`.

Trusted reverse proxies may explicitly enable `KIMONO_TRUST_GIT_PROFILE_HEADER=true`
for the HTTP listener. They supply a base64 JSON profile through
`x-kimono-git-profile` only after authenticating the requesting user; the profile
is request-local, not shared between simultaneous clients. Do not enable this
option on an untrusted public listener. Without opt-in, this header is ignored.
HTTP does not inherit a process-wide local profile. Secrets must never be
logged, placed in URLs or sent as tool arguments. Core ignores caller-supplied
profile headers and reconstructs this trusted header from its own credential store.

For multi-call research, call `aikido_snapshot` with `{"operation":"begin"}`,
pass its `snapshotId` to every `aikido` list/search/read/activate/execute and
`aikido_search` / `aikido_file` call, then call `{"operation":"end",
"snapshotId":"…"}`. Begin reports content `version` and `provenance`;
compact searches repeat only the ID. AI-KIDO defaults are 15 minutes, 8 active snapshots,
64 MiB per snapshot and 256 MiB total. RAG defaults allow 256 MiB per snapshot
and 512 MiB total. Hosts can configure bounded limits; `begin` also accepts
`paths` to capture selected subtrees, and returns effective snapshot budgets.
See [large-project RAG](docs/local-rag.md#grands-dépôts--large-repositories).

Tatami Core may provide `KIMONO_PROJECT_POLICY_FILE`, a JSON manifest outside
`AIKIDO_ROOT` containing nonsecret `projectId`, `gitUrl`, `gitMode`, `gitPolicy`,
`gitPushAllowed` and optionally `execution`. Kimono reports this policy as
guidance only; it does not grant Git or filesystem permissions. Retarget URLs
reject embedded credentials, query strings and fragments.

Documents also appear as resources (`aikido://<encoded-relative-path>`) and prompts (`aikido.<kind>.<encoded-relative-path>`), with completions.

`activate` and its `execute` alias return instructions/context for the connected assistant. They do **not** claim an LLM workflow has run. Agents use their own approved tools for file edits and Git operations outside MCP. Kimono has no embedded LLM or unrestricted shell.

The initial Kimono scaffold lacked Git/file actions and indexed search; these are now separate MCP tools.

## Knowledge collaboration through MCP

`aikido_collaboration` is a generic MCP contract; clients do not need Tatami,
Git, a CLI-specific API, or an implicit remote. It stores immutable shared
revision manifests and content-addressed UTF-8 blobs in the external Kimono
cache. Successful `publish` also safely materializes the accepted merged
knowledge documents into the configured `AIKIDO_ROOT`; later snapshots and
searches see them. Existing snapshots remain immutable. The first `status` captures the current shared
revision, so replica clients should call it before editing and persist the
returned `sharedVersion` as their `baseVersion`.

There are two explicit client modes:

- **Shared directory:** only when an embedded stdio client has verified it edits
  this exact configured ROOT, edit with the client's own file tools and call
  `aikido_index` `update` afterward (optionally scoped with `paths`). Do not run
  replica reconciliation or publish the same local edits back to themselves.
- **Personal replica:** use for remote HTTP endpoints and every separate local
  workspace. Call `status`, then `compare` with the local path/hash manifest and
  saved `baseVersion`. Apply only `additions`, `modifications` and `deletions`
  from the shared side, after reading the exact `sharedVersion`; never
  overwrite a conflict implicitly. Then explicitly call `publish` with the
  expected current shared version, base, local manifest, changed file contents
  and an explicit `local`/`shared` resolution for each overlap.

`status` returns `localVersion`, `localManifest`, `sharedVersion` and
`sharedManifest`. It refreshes the persistent shared revision from the current
eligible ROOT before returning; direct edits or read-only Git sync therefore
advance sharedVersion, and `publish` performs the same refresh before checking
its optimistic guard. A publish based on a revision predating a ROOT change is
rejected rather than overwriting it. Pass `sharedVersion` to `status` to also
retrieve that immutable historical revision as `requestedRevision` without
moving the current pointer; this lets replica clients obtain a saved base
manifest. `compare` is symmetric: shared changes are pull candidates,
`localChanges` are local edits from base, and `conflicts` are divergent changes
to the same path. The unified `changes` page labels each record `local`,
`shared` or `conflict`; exclude conflict paths from pulls. Without a base, only differing files present on both sides
are treated as conflicts; absence is not interpreted as a deletion. Each
change record has `path`, `kind`, `baseHash`, `localHash` and `sharedHash`.
Manifest and change pages use `offset`/`limit` (up to 100) and `nextOffset`.
`read` requires the exact `sharedVersion` and returns a `files` object of path
to UTF-8 content or `null`. `publish` checks every provided content hash, uses
an optimistic shared-version guard, preserves shared-only changes, and never
resolves conflicts with last-write-wins. A stale version is rejected; refresh
status and compare before retrying.

Collaboration is limited to 2,000 eligible knowledge files, 256 KiB per file
and 8 MiB per revision; serialized publish requests are limited to 512 KiB.
Oversized knowledge remains available for research and read-only retrieval.
Git publication is always a separate client action: this MCP collaboration
workflow never commits, pushes or merges. Publish changes only the configured
knowledge ROOT; it never writes the replica client's workspace directly.
Collaboration revisions never mutate an existing research snapshot. After
shared-directory edits, update indexes and begin a new `aikido_snapshot`;
existing snapshots remain pinned to the corpus captured at their start.

## Requirements

- Node.js 24+, Git, and `fgr` on PATH for native execution. Install GitHub CLI (`gh`) for optional GitHub checks, and `jq` for inspecting JSON results.
- Rust/Cargo to install the published `fast-grep` crate.
- Or Docker Engine with Compose v2: the Linux arm64/x64 image contains Node.js, Rust, Cargo, Git, `gh`, `jq`, OpenSSH, `fgr`, `kimono-semantic`, ONNX Runtime and the multilingual embedding model.

```sh
cargo install fast-grep --version 0.5.0 --locked
npm ci
npm run build
```

The crate is named **fast-grep**; its binary is **fgr**, not `fgrep`.

For native development install missing utilities with your normal package manager
(for example `brew install gh jq` or `apt-get install gh jq`), then run
`npm run dev:check`. This checks versions only; it does not install anything or
authenticate. Never bake GitHub credentials into an image.

## Repository guidance and read-only remote synchronization

MCP `aikido_git` exposes only `infos`, `sync` and `retarget`. The configured
knowledge ROOT may be a plain directory without `.git`; in that case `infos`
returns `repository.available:false`. `retarget` validates and stores a
credential-free repository URL and optional existing branch in the external
cache only. It does not contact or change the remote. `sync` requires this
explicit association, reads the requested branch or remote default HEAD, stages
the remote knowledge tree, preserves local unpublished knowledge, then
publishes and indexes the resulting corpus. It does not check out a worktree or
perform commit/push/merge/branch-creation operations. Public anonymous remotes
are supported; private remotes use a host-provided request resolver or a secure
standalone stdio profile. Credentials must never be tool arguments or stored in the
ROOT/shared cache.

The optional `KIMONO_PROJECT_POLICY_FILE` manifest is guidance, not an active
remote target; its `gitUrl` is not used unless the user explicitly calls
`retarget`. `infos` reports `retarget`, the actually indexed `indexedSource`
(URL, branch, commit and corpus fingerprint), and whether the local ROOT has a
Git repository. For a non-Git ROOT, repository HEAD/branch fields are null;
remote source provenance reflects only the last successful read-and-index
sync, not the policy manifest.

Remote sync refuses to replace or recreate a previously remote-managed path
whose current content (or local deletion) differs from the last successful
remote manifest and the incoming remote content. This protects documentary
knowledge published through collaboration but not yet published to Git.
Resolve those paths explicitly or publish them with external Git tools before
retrying. Local-only seed handling remains available for the initial import.

`indexes.literal` and `indexes.semantic` independently return `lastIndexedSha`,
`freshness` and `basis`. A successful full `basis` contains `head`, `branch`,
`dirty`, `statusFingerprint`, `corpusFingerprint` and `indexedAt`.
`lastIndexedSha` is the last successful **full** index basis, never merely the
current checkout SHA. The corpus hash covers sorted indexed paths, kinds and text
contents under the configured exclusions; non-indexable/binary/ignored files are
not claimed to be indexed. The Git status fingerprint additionally distinguishes
tracked/untracked status changes. A dirty checkout can be freshly indexed, without
pretending those contents are committed.

Freshness is `unknown` without metadata, `fresh` only after a complete successful
index matching the current SHA/branch/status and corpus hash, or `stale` after
changes. `partial` means the last attempt was paths-scoped (even when an older
full basis exists). `failed`, `running` and `concurrent-change` never advertise
freshness. Failed embedding batches retain the previous successful SHA; literal
success does not advance semantic provenance. Pre/post source snapshots and a
fingerprint of the actual engine input detect concurrent changes. Metadata uses
atomic replacement and per-engine exclusive cache locks. After a writer crash,
stop **all** writers before removing only its `literal-basis.lock` or
`semantic-basis.lock` in the external cache, then perform a full update. Legacy
caches without metadata remain `unknown` until fully synchronized.

After externally changing local knowledge files, refresh indexes directly:

```json
{"operation":"sync","mode":"all"}
```

`aikido_index update` refreshes the external lexical/semantic indexes from the
current ROOT without contacting a remote. For remote knowledge retrieval, first
call:

```json
{"operation":"retarget","gitUrl":"https://github.com/example/project.git"}
```

Then call `{"operation":"sync","mode":"all"}`. Omit `branch` at retarget to
follow the remote's advertised default branch; an explicit branch must already
exist. Sync result includes `remoteSynchronized:true`, the credential-free URL,
resolved branch, commit, and published corpus fingerprint only after publication
and index refresh succeed. `mode` selects literal, semantic, or both indexes.
Remote retrieval is anonymous and read-only; private repository support requires
a separately injected host credential resolver and is not currently available.

`retarget` accepts a credential-free `gitUrl` and optional existing `branch`,
validates both, and stores only associated project metadata in the external
cache. It does not modify `.git/config`, create branches or contact the URL.
`KIMONO_PROJECT_POLICY_FILE` optionally points to an external, nonsecret JSON
manifest (`projectId`, `gitUrl`, `gitMode`, `gitPolicy`, `gitPushAllowed`, and
optional `execution`). The policy is surfaced as agent guidance, not permission
to run an operation.

CLI equivalents (JSON on stdout, suitable for `jq`):

```sh
npm run infos -- --root ./project
node dist/cli.js infos --root ./project --github true | jq '.repository, .indexes'
node dist/cli.js sync --root ./project --expected-head FULL_SHA \
  --expected-branch feature/session-123 --mode all
```

For detached CLI sync use `--expected-branch null`. Booleans require explicit
`true`/`false`; network access remains off unless requested.

## Prepare or select a ROOT

Seed the configured knowledge directory before launching the MCP server, for
example by copying approved knowledge files from a workspace. The MCP never
initializes a project; explicit remote sync can publish its knowledge corpus.
The following
CLI/installer examples are explicit administrator-side setup, outside the MCP:

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

The server can also start with an absent/empty configured ROOT, but the host must
seed it before research or synchronization. `aikido_root` exposes `status` only;
the former MCP `init` operation is rejected.

## Indexed search

Literal/regex searches use **fast-grep 0.5.0**, installed from crates.io. The default remains literal, so existing clients do not change behavior.

At startup, Kimono checks the persisted semantic index against the current ROOT
and starts an incremental update in the background only when the index is
missing or stale. A fresh index is reused. `aikido_index` `status` reports the
current stage and embedding progress; semantic search reports `not-ready`
instead of waiting for an index build to finish. Before every search the
catalogue is rescanned and incrementally updated, covering added/changed/deleted
files, including external edits. MCP Git/file operations also update it.

Embedding is CPU-only (ONNX Runtime CPU provider; Docker on macOS cannot reach
the Apple GPU). Passages are sorted by length to minimise padding, grouped in
batches and spread over parallel ONNX sessions: about 7.5 ms per 450-character
passage with 4 CPUs (17 ms with one worker).

Only discovered text documents enter a private search mirror. Symlinks, dependency/build/cache directories, `.env*` and nested `.gitignore` exclusions are omitted. Per-file defaults are 2 MiB in AI-KIDO and 4 MiB in RAG; host configuration can change allowlists, filters and bounded budgets. In AI-KIDO mode, `prompts/spec/` (or `spec/` when ROOT is the prompts directory) requires `AIKIDO_INCLUDE_SPEC=true`. Excluded files never enter the fgr index. See [local RAG corpus policy](docs/local-rag.md#configuration-du-corpus--corpus-policy).

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

For natural-language text retrieval, use `mode: "text"`; it normalizes the
query, searches whole useful terms, and uses bounded one-hop aliases from
Markdown glossary/vocabulary/ontology tables in the ROOT. Enrichment is
**project-only**: there are no built-in translations. Declare bilingual aliases
(for example `Rules | règles, regles`) for cross-language lexical retrieval.
Definition terms only boost passages already matching a term or alias. Ranking
combines term coverage weighted by document frequency, phrase/title/heading
boosts and a repeated-document penalty; `matchedTerms` and `scoreDetails`
explain the evidence. Candidate limits are explicit in branch diagnostics.
`mode: "hybrid"` runs enriched text and semantic retrieval in
parallel and returns both branch diagnostics plus a reciprocal-rank-fused
passage list. `literal` remains exact phrase matching and `regex` remains an
explicit regular-expression search. The query plan includes matched vocabulary
sources and lines so the consuming assistant can inspect the evidence; these
lexical hints are untrusted data, not instructions or factual confidence.
Lexical snapshots build an index on their captured paths once; fgr's
absolute-path indexes cannot safely be copied to another root. Details and a
glossary example: [retrieval contract](docs/retrieval.md).

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

Default results contain only paths, inclusive line ranges and the snapshot ID.
Request `detail=locations` for `engine`, `model`, status/counts, snapshot version
and scores; `detail=excerpts` also returns text. Scores are cosine
similarity (higher is better, not a probability). Filtering by `kind` happens
before the result limit. There is no relevance threshold: unrelated queries can
still produce nearest neighbors. Results are chunks grouped per file: one file
lists each matched chunk as a `[start,end]` line range in `hits`.

The semantic index initializes lazily, refreshes against the current catalogue
before every MCP search/full-index call, and only re-embeds changed chunks. Targeted
`aikido_index update` calls refresh only their explicit paths (see below). The
persistent vector store lives alongside the literal index outside ROOT.
The same exclusions apply, including private specs. Chunking bounds passages to
500 Unicode characters with starting line numbers. It is not a reranker or an
LLM answer generator. The current flat cosine index targets project corpora, not
unbounded document warehouses. The former 64 MiB semantic request ceiling is
replaced by the host's `maxCorpusBytes` budget (512 MiB by default); scoped
snapshots and include/exclude policies are recommended for large repositories.
JS requests are streamed to disk, but the native engine still retains text,
chunks and vectors in memory. Requests load the model locally and verify its fingerprint; initial
indexing takes longer than cached searches. Reserve at least 1 GiB of container
memory initially and measure on your corpus; this is not a hard memory bound.
Semantic searches time out after 60 seconds; index maintenance after one hour.
For a sizeable base, pre-index using the CLI before exposing the server, or
configure a sufficiently long MCP client request timeout for the first indexing
call. Semantic preparation starts in the background at startup; poll
`aikido_index status` with `mode=semantic` until ready. A scoped snapshot builds
its subset index separately on first semantic use.

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

## Integration with per-workspace instance managers

Kimono remains **one ROOT per process**. A manager such as Tatami can run one
instance per project, using the same immutable image.
Mount only that project's dedicated knowledge directory, provide its own persistent cache and HTTP bearer
token, and keep HTTP ports private to the backplane. Do not mount the entire
workspace parent into each instance or expose a client-controlled ROOT.
If every container sees `/knowledge`, **use separate cache volumes**: the cache
key is based on the visible ROOT path, not the container identity.
Set the container UID/GID and writable cache permissions to match the workspace;
the default image user is UID 1000. Git credentials and authorization remain the
manager's responsibility; never share a user's token across unrelated instances.

HTTP probes:

| Endpoint | Authentication | Meaning |
| --- | --- | --- |
| `GET /healthz` | None | Process liveness only; unchanged minimal response. |
| `GET /readyz` | Instance bearer token | 200 if ROOT was initialized, still has a readable entry point and the instance is not draining; otherwise 503. Semantic indexing is not required. |
| `GET /statusz` | Instance bearer token | 200 with `ready`, `stopping`, ROOT availability and semantic state, including failure details. Does not start indexing/inference. |

Keep readiness distinct from liveness: an empty ROOT awaiting host-side seeding
is alive but not ready. Readiness checks filesystem availability, not Git remote
connectivity or a complete rescan of every document. Status/error details must
remain behind instance authorization, not exposed as public diagnostics.

Poll semantic progress through MCP, including while an indexing call is pending:

```json
{"operation":"status","mode":"semantic"}
```

on `aikido_index`. Unlike `stats`, `status` does **not** update or initialize an
index and bypasses the tool queue so it remains responsive. Another HTTP MCP
session may poll the same instance. Semantic state is `unknown`, `running`,
`ready` or `error`, with operation/stage/timestamps, last chunks/model and
`progress: {completed, total}` when available. Progress counts **changed chunks
embedded**, not elapsed time or a percentage of all scanning/model loading/
saving work. `ready` means the last index operation succeeded, not proof that no
external files changed since. Subsequent searches always synchronize as before.
The in-memory status returns to `unknown` on restart; startup validates the
persistent basis against the ROOT and reports `ready` when fresh, or prepares a
stale/missing index in the background.
Failures are explicit in both the original tool result and status.

On `SIGTERM`/`SIGINT`, the running server rejects new tool work, reports not
ready, drains accepted calls, then closes MCP sessions and the HTTP listener.
After **30 seconds**, remaining managed subprocesses are killed, HTTP
connections are forced closed and shutdown is reported as failed (non-zero CLI
exit). Compose uses `init: true` and a 40-second stop grace period; an external
manager must allow more than 30 seconds too. Do not start a second process on
the same cache during draining. Index generations are published before their
previous generation is removed, allowing a later instance to reuse the last
published store after interrupted indexing.

This adds the server-side integration contract only: container provisioning,
workspace membership checks, public-client credentials, idle eviction and
quotas are not implemented by Kimono.

## Targeted synchronization (v0.3.0)

```json
{"operation":"update","mode":"all","paths":["prompts/concepts","src/changed.ts","src/deleted.ts"]}
```

Call `aikido_index` with `paths` as one ROOT-relative string or a list (1–256).
Files and directory subtrees are accepted, including missing paths: previously
indexed files under missing targets are deleted. Prefixes match directory boundaries,
not similarly named neighbors. Overlapping paths are deduplicated. Absolute paths,
traversal, backslashes, empty lists and `paths` on other operations fail explicitly.
Gitignored/private/excluded paths and symlinks never expose source content.

`mode` is `literal` (default), `semantic`, or `all`. Each engine reports its own
`changes: {added:[], modified:[], deleted:[]}` ROOT-relative paths under
`indexes.literal` / `indexes.semantic`; single-engine legacy metadata remains
available at the top level. A cold targeted cache stays partial: unrelated source
bodies are **not** read, indexed or embedded to build a baseline. Semantic model
changes require a full update before targeted reuse. Reports are relative to each
engine's last successful synchronization, not Git status; `all` is sequential,
not an atomic cross-engine transaction (failures remain explicit).

Search refreshes the snapshot's catalogue, not the mutable source. Source changes
become searchable after beginning a new snapshot. Omitting `paths` keeps full
index synchronization. MCP exposes `update` and semantic `status`; other index
maintenance operations remain CLI/library concerns. Caches stay outside ROOT.

CLI: `kimono index --root ./project --mode all --paths '["src/file.ts","prompts/concepts"]'`.

## MCP clients

Stdio is the default transport. Example VS Code configuration:

```json
{
  "servers": {
    "kimono": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/kimono-mcp-server/dist/index.js"],
      "env": { "AIKIDO_ROOT": "/absolute/path/to/aikido", "KIMONO_CORPUS_MODE": "aikido" }
    }
  }
}
```

For Claude Code or another stdio client, use the same executable, arguments and environment in that client's MCP configuration. Diagnostic output goes to stderr, preserving the MCP stdout stream.

## Docker Compose

```sh
cp .env.example .env
# Set AIKIDO_HOST_PARENT and AIKIDO_DIR.
# Set KIMONO_CORPUS_MODE=aikido for the AI-KIDO workflows below (default: rag).
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

### Knowledge publication, not Git writes

`aikido_git` exposes `infos`, `retarget` and `sync` only. Former mutation
operations are rejected even if legacy `AIKIDO_WRITABLE=true` is present.
Agents commit/push/merge with their own authorized tools outside MCP, then
request an explicit sync. A writable ROOT mount is needed only to publish
synchronized knowledge; a read-only mount remains valid for research.

### Dynamic per-instance Git profile

For a platform-managed instance, set `KIMONO_GIT_PROFILE_FILE` to an absolute
path outside ROOT, pointing to a **private JSON file (0600 or 0400, <=64 KiB)**.
The stdio runner must be able to read it. This is host configuration, never an
MCP tool argument. HTTP project instances use request-local profiles instead;
they do not inherit this process-wide file.

SSH profile schema (placeholders, not working credentials):

```json
{
  "transport": "ssh",
  "host": "github.com",
  "username": "git",
  "secret": "<unencrypted private SSH key with JSON-escaped newlines>",
  "knownHosts": "github.com ssh-ed25519 <verified-server-public-key>"
}
```

For HTTPS, use `"transport": "https"`, the Git account `username` and access token
as `secret`; omit `knownHosts`. The schema matches the core fields of Tatami Git
connections. Tatami must authorize the selected connection, retrieve/decrypt its
secret (including resolving a managed SSH key), and provision this file itself;
Kimono does not connect to Tatami's account database.

The stdio profile is reread for every remote sync. Rotate it by atomically replacing the file
inside a mounted **secret directory**; do not rely on replacing the source of a
single-file bind mount (it may retain the old inode). Commands already running
keep their credential snapshot; subsequent commands use the replacement.
No restart or secrets in MCP messages are necessary.

Managed mode enforces the exact host/transport, standard ports (SSH 22 / HTTPS
443) and matching SSH username. Local-path remotes and cross-host/transport redirects
are not supported with a profile; use a separate instance/configuration.
HTTPS uses a temporary askpass helper with credential helpers disabled and
redirects disabled. SSH uses the selected key only, no agent, strict
`known_hosts` verification and no user SSH config. Verified non-hashed host-key
lines for the exact host are required; Kimono never trusts `ssh-keyscan` output
automatically. Passphrase-protected keys are unsupported in managed mode.
No author/committer identity is needed for MCP read synchronization.

Temporary key/helper files are owner-only and removed after the command.
Use a private tmpfs `/tmp` for managed containers to avoid persisting leftovers
after an abrupt kill. Never expose the profile directory to repository code,
commit it, include it in a Docker build context or mount it into another user's
instance. Git subprocesses necessarily receive the credentials needed for their
transport; this remains a trusted-runner feature, not a repository sandbox.
Managed Git failures are intentionally generic to avoid echoing credentials;
HTTPS tokens are redacted from captured process output. Profile load failures
fail closed, without falling back to ambient credentials.

Example standalone stdio invocation:

```sh
KIMONO_GIT_PROFILE_FILE=/secure/project-git/profile.json \
  node dist/cli.js serve --root /absolute/path/to/knowledge
```

For the Compose HTTP listener, use the trusted authenticated proxy/resolver
described above instead of a global profile file. Each member can select their
own connection without replacing another member's credentials.

Without an explicitly resolved profile, remote sync is anonymous: it disables
ambient Git/SSH credentials, helpers and global configuration. An explicit empty
`connectionId` forces anonymous access. Invalid profiles fail closed.

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
| `AIKIDO_ROOT` | required | Corpus root (legacy name retained): AI-KIDO knowledge, or generic project in RAG mode. |
| `KIMONO_CORPUS_MODE` | `rag` | Generic local RAG by default; opt into `aikido` for AI-KIDO workflows. CLI `--corpus-mode`. |
| `KIMONO_CONFIG_FILE` | unset | Absolute host-selected corpus JSON config; CLI `--config`. Never auto-discovered in projects. |
| `AIKIDO_REPOSITORY` | official Git URL | Default source for CLI/MCP/Compose installation. |
| `AIKIDO_REF` | `main` | Branch/tag for explicit installation. |
| `AIKIDO_WRITABLE` | `false` | Legacy installer/library setting; never enables MCP mutation tools. |
| `AIKIDO_INCLUDE_SPEC` | `false` | AI-KIDO-only opt-in to private personal specs; ordinary RAG `spec/` directories are eligible. |
| `KIMONO_GIT_PROFILE_FILE` | unset | Private server-managed SSH/HTTPS profile outside ROOT; reread for Git commands, supports rotation without restart. |
| `KIMONO_CACHE_DIR` | `~/.cache/kimono` | Cache parent outside ROOT; contains sensitive document copies. |
| `KIMONO_STATUS_FILE` | `<cache>/semantic-status.json` | Live, atomically replaced semantic index status shared by every process on this ROOT: `phase` (`running`/`waiting`/`ready`/`error`…), `stage`, `files`, `estimatedTokens`, `embedded` (`{completed,total}`), `chunks`, `chunksPerSecond`, `etaSeconds`, `indexedAt`, `pid`, `host`. Not written for immutable snapshots. |
| `FGR_BIN` | `fgr` | Path to the fast-grep executable. |
| `KIMONO_SEMANTIC_BIN` | `kimono-semantic` | Local embsearch-core helper executable. |
| `KIMONO_SEMANTIC_WORKERS` | `auto` = min(CPUs, 4) | Parallel ONNX sessions for indexing (1-32, ~600 MiB peak each). CPUs follow cgroup quotas. |
| `KIMONO_SEMANTIC_THREADS` | `auto` = 1-2 | ONNX intra-op threads per session (1-32). |
| `KIMONO_SEMANTIC_BATCH` | `8` | Passages per length-sorted embedding batch (1-256). |
| `KIMONO_MODEL_DIR` | `/opt/kimono/model` in Docker | Local ONNX model, tokenizer and spec; required for semantic mode. |
| `ORT_DYLIB_PATH` | `/opt/kimono/onnxruntime/lib/libonnxruntime.so` in Docker | Dynamic ONNX Runtime library; use the native library extension outside Linux. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or authenticated Streamable `http`. |
| `MCP_HOST` | `127.0.0.1` | HTTP address; Compose uses `0.0.0.0` inside the container. |
| `MCP_PORT` | `3000` | HTTP port, 1-65535. |
| `MCP_AUTH_TOKEN` | required for HTTP | Bearer token protecting the complete MCP instance. |
| `AIKIDO_HOST_PARENT` | `./data` | Compose host parent directory. |
| `AIKIDO_DIR` | `aikido` | Checkout directory relative to the host parent. |
| `AIKIDO_VOLUME_MODE` | `ro` | Compose mount mode; `rw` for editing/MCP initialization. |
