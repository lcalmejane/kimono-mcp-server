# Kimono: standalone and shared knowledge

[README](../README.md) · [Version française](usage.fr.md)

## What Kimono provides

### One knowledge base for your team and agents

Kimono's value is not limited to token savings: different MCP clients can
retrieve from a common, inspectable project corpus maintained by people.
Choose a shared HTTP service for a common endpoint; independent stdio launches
are separate local processes, not a shared server. Each research snapshot
pins its own version; this does not synchronize conversations or code edits.
Default RAG is read-only. Explicit AI-KIDO mode adds versioned knowledge
comparison/publication and conflict handling, described below.

The [current fixed-model pilot](../benchmarks/results/current.md) measures
single-agent RAG tasks, with no collaboration tool exposed. A shared knowledge
layer may be worth retrieval overhead to a team, but this is a value judgment,
not a measured collaboration return. No fixed
overhead rate, savings guarantee or human/team productivity gain is claimed.

On the current planning pair, Kimono used 71.4% less cumulative input and
52.0% less wall time. One repetition, human review pending; the separate
native research answer failed the JSON-format gate. These are exploratory
measurements, not established equivalent-quality savings.

### Support FAQ: why can local MCP use more tokens than native tools?

Local transport and indexing do not themselves invoke a language model.
What counts is the material the client puts into model requests: tool
definitions, server guidance, arguments/results and accumulated conversation.
Native tools have definitions too; enabling MCP adds to that interface.

Fewer response bytes need not mean fewer cumulative input tokens: definitions
and earlier results can remain in context across model requests. Cache-read,
uncached input and output must be reported separately; input is not a bill.
The client's diagnostic `tool_tokens` is not an exact provider billing partition.
See the [current trace-based diagnostics](../benchmarks/results/current.md).
In this pilot, that diagnostic is 680 per request for native tools versus
1,903 with Kimono. Model requests fell from 21 to 9 on research and 31 to 9
on planning, while connection took 0.528/0.395 seconds. Lower cumulative
usage can therefore coexist with a larger per-request tool description;
the test does not isolate batching's causal contribution.
This is a harness/task observation, not a fixed MCP charge. Limit enabled
tools, batch relevant reads and use scoped snapshots where useful; compare
real usage and quality before claiming savings.

### Generic local RAG (v0.6.0)

RAG is the default for source/docs projects, without an AI-KIDO entry point.
Root/nested `.gitignore` rules apply automatically; dependencies such as
`node_modules` remain excluded even without ignore rules.
Select `KIMONO_CORPUS_MODE=aikido`, CLI `--corpus-mode aikido`, or extension
setting `kimono.corpusMode: "aikido"` for AI-KIDO. RAG never publishes files and rejects
collaboration/Git sync; those capabilities below belong to AI-KIDO mode.
The [local RAG guide](local-rag.md) covers languages, include/exclude policy,
configurable budgets/scoped snapshots and Copilot, Claude Code, Codex and
Antigravity configuration. Indexing/embeddings are local; retrieved passages
can still be sent by the chat client to its model provider.

### Knowledge-only Git guidance and remote sync

The MCP exposes `aikido_git` operations `infos`, `sync` and `retarget`. A
knowledge ROOT may have no `.git`: `infos` then reports
`repository.available:false`. `retarget` stores a validated, credential-free
URL and optional existing branch in the external cache; it does not contact the
remote. Only after explicit retarget, `sync` reads the branch (or remote default
HEAD), stages/publishes/indexes knowledge, and preserves local unpublished
knowledge as seed/conflict copies. It never commits, pushes, merges or creates
branches. The policy manifest's URL is informational, not an implicit target.
Remote reads support public anonymous repositories and private repositories
with a host-injected per-request credential resolver or a secure stdio profile;
credentials are not accepted as MCP arguments or stored in shared knowledge.
See the [complete contract](../README.md#repository-guidance-and-read-only-remote-synchronization).

### Targeted indexing (v0.3.0)

Call `aikido_index` with `{"operation":"update","mode":"all","paths":["src/file.ts","prompts/concepts","deleted.md"]}`.
`paths` also accepts one string. Only selected source bodies are read; directories
use exact boundaries, missing targets delete previous entries, and both engines
report independent `indexes.literal/semantic.changes` arrays (`added`, `modified`,
`deleted`). Ignored/private files and symlinks stay excluded. Cold targeted caches
remain partial; no unrelated baseline is built. Omit `paths` for full refresh.
Searches refresh their immutable snapshot's catalogue; begin a new snapshot to
observe source changes. Read-only clients
may maintain caches outside ROOT; index maintenance never grants file writes.
The CLI equivalent is `kimono index --mode all --paths '["src/file.ts"]' --root ./project`.
`paths` is update-only; unsafe paths and engine errors fail explicitly. `all` is
sequential, not an atomic transaction. The [full contract](../README.md#targeted-synchronization-v030)
documents limits, model changes and legacy single-engine metadata.

Kimono exposes one AI-KIDO knowledge ROOT through MCP: documents, commands,
agents/personas, skills and workflows. MCP does not edit arbitrary project
files or perform Git mutations (commit, push, merge, branch creation or remote
configuration). Read-only Git synchronization is explicit through
`aikido_git`; shared knowledge revision publication is separate through
`aikido_collaboration` and never writes a client workspace or Git remote. Seed
the directory before startup; use `aikido_index update` after local edits. There is no
built-in chat UI or LLM: `activate` / `execute` load instructions for the client,
not an autonomous workflow running on the server.

| Need | MCP tool |
| --- | --- |
| Discover/read/activate knowledge | `aikido`, resources and prompts |
| Snapshot-bound multi-call research | `aikido_snapshot` |
| Literal, regex, semantic or existing-vector search | `aikido_search` (requires `snapshotId`) |
| Local embeddings and exact active-model information | `aikido_embed` |
| Maintain indexes / poll semantic progress | `aikido_index` |
| Collaborate across separate knowledge copies | `aikido_collaboration` |
| Read snapshot-pinned documents | `aikido_file` (requires `snapshotId`) |

Semantic inference is local, with multilingual E5 embeddings and ONNX Runtime.
`aikido_embed` with `{"operation":"info"}` returns the active model identifier,
preprocessing settings and file hashes. Vector searches require its model
identifier; callers must ensure the actual vector uses compatible preprocessing.
See the [full reference](../README.md#local-semantic-search).

For multi-call research, start with `aikido_snapshot {"operation":"begin"}`.
Pass the returned `snapshotId` to all `aikido` list/search/read/activate/execute,
`aikido_search` and `aikido_file` calls, then end it with
`aikido_snapshot {"operation":"end","snapshotId":"…"}`. Results include the
same ID; begin supplies corpus `version` and `provenance`, omitted from compact
search responses. AI-KIDO defaults are 15 minutes
and 8 active / 256 MiB total. Hosts can configure bounded limits; `begin paths`
captures selected subtrees. See the [RAG budgets](local-rag.md#grands-dépôts--large-repositories).

For a low-token harness, use the [progressive JSON retrieval contract](retrieval.md):
batch independent questions in `aikido_search queries:[...]` (1–20 strings),
then the selected passages from all queries in one `aikido_file` `ranges` batch
(1–50 ranges, overlaps merged),
and a Markdown section or full file only when needed. The MCP also publishes
this protocol in its initialization `instructions` for any MCP client. Batch
search options are shared; one total byte budget (minimum 4096) covers ordered
answers, per-query errors and `nextQuery` continuation. Reads return `remaining`
when truncated. Single-query/vector operations remain available. Complete file reads remain
explicit; follow pagination/truncation fields rather than requesting the corpus.

## Explicit knowledge collaboration modes

`aikido_collaboration` works through MCP alone; it requires no Tatami API or Git.
For verified embedded stdio editing the exact configured ROOT, use the
**shared-directory** mode: edit with client file tools and call `aikido_index
update`; do not reconcile or publish a replica. Never infer this mode for HTTP.
For remote HTTP or a separate workspace, use **personal-replica** mode: call
`status` before editing, save `sharedVersion` as `baseVersion`, compare local
hashes with the shared revision, read shared pull candidates at the returned
version, then explicitly publish. Conflicts always require an explicit local
or shared resolution; stale versions require a fresh compare. Shared knowledge
publication and Git publication are separate. Status and publish refresh the
persistent shared revision from the current eligible ROOT first, so direct
edits and read-only Git sync make stale publish attempts fail safely. Pass a
saved `sharedVersion` to status to retrieve its historical
`requestedRevision.manifest` for the base without moving the current pointer.
Successful publish synchronizes the accepted document revision into configured
`AIKIDO_ROOT`; later snapshots and searches see it, while snapshots already
open remain immutable. It never commits or pushes Git.

## Standalone

**Recommended: Docker Compose**, which includes Git, Rust search tools, the
runtime and embedding model:

```sh
cp .env.example .env
# Edit .env: set a strong MCP_AUTH_TOKEN and AIKIDO_HOST_PARENT / AIKIDO_DIR.
docker compose up --build -d
```

The configured directory must contain `prompts/index.md` or `index.md`. If it
does not exist yet, explicitly clone the official or configured custom source:

```sh
docker compose --profile install run --build --rm install-aikido
docker compose up --build -d kimono-mcp-server
```

Connect MCP clients to `http://127.0.0.1:3000/mcp` with the instance bearer token
(adapt the port if configured). Compose publishes loopback only; remote access
needs TLS and an authorized reverse proxy. Never put tokens in Git.

For a single client, **native stdio** is also supported after installing the
[native requirements](../README.md#requirements):

```sh
node dist/cli.js serve --root /absolute/path/to/aikido
```

Configure the client to launch this command. Stdio is a dedicated client/server
connection; launching it separately in several clients creates several processes,
not shared HTTP sessions. Native semantic mode additionally requires the helper,
model directory and ONNX library described in the README.

## Centralize one knowledge base for concurrent clients

Use **one HTTP Kimono process, one ROOT and one persistent cache**, with several
MCP sessions connected to that instance. Agents and humans then share the same
working tree and knowledge view, rather than independent stale clones.

- Tool operations managed by the runtime queue are serialized across sessions;
  independent read/resource requests are not global transactions. A long
  index operation can delay queued work. Semantic `status` polling bypasses
  that queue.
- Begin a snapshot before researching and reuse its ID across every read/search.
  Later syncs never change that immutable research view; end it explicitly.
- File editing, commits, pushes, merges and branch creation are not MCP tools,
  even when legacy `AIKIDO_WRITABLE` is set. Agents use their own Git tools and
  then explicitly request `sync` against the retargeted source.
- External editors bypass Kimono's queue. Do not edit the shared directory
  during publication. A sync checks for external changes while staging and
  refuses to overwrite a changed source.

Every authorized project member sees the same indexed knowledge, including
private repository documents fetched with another member's permission.
Credentials remain personal and request-scoped. Only the host/platform decides
membership and resolves personal credential references.

**Never share a cache between independent processes.** Separate caches prevent
index collisions, but do not solve concurrent publication to a shared ROOT.

## Integrate into Tatami or another platform

Recommended topology: **one instance per project**, outside user workspaces.
Tatami exposes one project URL to all its authorized members, with personal
bearer tokens and personal Git credentials resolved only for each sync.

```text
Clients -> platform authentication/authorization -> workspace-specific Kimono
                                                  |-- mounted ROOT
                                                  `-- persistent private cache
```

The platform manager must provision/start/stop instances, validate workspace
membership, route MCP sessions to the correct instance, manage credentials and
quotas, and remove or retain state according to project lifecycle. Mount only
the selected workspace, match its UID/GID, use distinct tokens/caches and avoid
public container ports. Identical `/knowledge` paths in different containers
still need separate cache storage. Image/model layers can be shared on disk;
inference memory and indexing CPU are not pooled across processes.

Kimono already provides these server-side integration points:

| Endpoint / action | Purpose |
| --- | --- |
| `GET /healthz` | Public minimal liveness |
| `GET /readyz` | Authenticated ROOT readiness; 503 when unavailable/draining |
| `GET /statusz` | Authenticated ROOT and semantic state/errors |
| `aikido_index`: `{"operation":"status","mode":"semantic"}` | Non-blocking in-memory index progress; no inference |
| SIGTERM / SIGINT | Drain accepted calls/responses; 30-second deadline |

Readiness does not imply the semantic index is built. Pre-index sizeable bases
or allow a long first-call timeout; progress counts changed chunks embedded, not
all preparation/saving work. Allow more than 30 seconds for container shutdown
(Compose uses 40). After restart, the next search validates/reuses the persistent
index; MCP clients must reconnect and establish new sessions.

**Platform provisioning/routing is not implemented by Kimono**; Tatami's
project manager provides that integration. Kimono is not currently
a single-process multi-tenant server accepting arbitrary project paths.

### Git accounts and rotation

Set `KIMONO_GIT_PROFILE_FILE` to a private JSON file outside ROOT (0600/0400,
readable by the runner). It supplies `transport` (`ssh` or `https`), `host`,
`username`, `secret`, plus verified `knownHosts`
for SSH. See the [schema and Compose example](../README.md#dynamic-per-instance-git-profile).
The platform retrieves the authorized account's credentials and provisions the
file; private keys/tokens never belong in MCP arguments or repository files.
Use a read-only directory mount and atomically replace the file for rotation.
Git commands reread it without restarting Kimono; in-flight commands retain
their snapshot. Temporary credentials are cleaned up; use a private `/tmp`
tmpfs for abrupt container termination.

SSH uses the configured key (no passphrase/agent), strict host verification and
port 22; HTTPS uses a token on port 443 without redirects. Other hosts,
transports, ports and local-path remotes are rejected in managed mode.
This file is for standalone stdio. Shared HTTP servers resolve a separate
profile per authenticated request, never a global file or a previous client's
identity. Missing credentials mean anonymous access; invalid configured
profiles fail closed. Commits and pushes are never MCP operations.

For configuration, write protections and operational limits, see the
[README integration contract](../README.md#integration-with-per-workspace-instance-managers).
