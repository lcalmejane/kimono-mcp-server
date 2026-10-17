# Kimono: standalone and shared knowledge

[README](../README.md) · [Version française](usage.fr.md)

## What Kimono provides

### Targeted indexing (v0.3.0)

Call `aikido_index` with `{"operation":"update","mode":"all","paths":["src/file.ts","prompts/concepts","deleted.md"]}`.
`paths` also accepts one string. Only selected source bodies are read; directories
use exact boundaries, missing targets delete previous entries, and both engines
report independent `indexes.literal/semantic.changes` arrays (`added`, `modified`,
`deleted`). Ignored/private files and symlinks stay excluded. Cold targeted caches
remain partial; no unrelated baseline is built. Omit `paths` for full refresh.
All searches still refresh the global catalogue automatically. Read-only clients
may maintain caches outside ROOT; index maintenance never grants file writes.
The CLI equivalent is `kimono index --mode all --paths '["src/file.ts"]' --root ./project`.
`paths` is update-only; unsafe paths and engine errors fail explicitly. `all` is
sequential, not an atomic transaction. The [full contract](../README.md#targeted-synchronization-v030)
documents limits, model changes and legacy single-engine metadata.

Kimono exposes one AI-KIDO knowledge ROOT through MCP: documents, commands,
agents/personas, skills and workflows. Humans using an MCP client and connected
agents can discover the same instructions, search them and act on an authorized
project. There is no built-in chat UI or LLM: `activate` / `execute` load
instructions for the client, not an autonomous workflow running on the server.

| Need | MCP tool |
| --- | --- |
| Discover/read/activate knowledge | `aikido`, resources and prompts |
| Initialize the configured ROOT from official/custom Git | `aikido_root` |
| Literal, regex, semantic or existing-vector search | `aikido_search` |
| Local embeddings and exact active-model information | `aikido_embed` |
| Maintain indexes / poll semantic progress | `aikido_index` |
| Edit documents / perform structured Git operations | `aikido_file`, `aikido_git` |

Semantic inference is local, with multilingual E5 embeddings and ONNX Runtime.
`aikido_embed` with `{"operation":"info"}` returns the active model identifier,
preprocessing settings and file hashes. Vector searches require its model
identifier; callers must ensure the actual vector uses compatible preprocessing.
See the [full reference](../README.md#local-semantic-search).

For a low-token harness, use the [progressive JSON retrieval contract](retrieval.md):
metadata/header discovery, bounded search passages, then only the selected
line range or Markdown section through `aikido_file`. Complete file reads remain
explicit; follow pagination/truncation fields rather than requesting the corpus.

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
- Searches synchronize before querying: additions, edits and deletions completed
  before a request are reflected, including external edits. Semantic indexing
  embeds only changed chunks. It is lazy, not a continuous filesystem watcher.
- Updates/deletes through `aikido_file` require exact previous content via
  `expected`. On a conflict, reread and reconcile; do not blindly retry writes.
- Several tool calls are **not a transaction**: a client's edit/add/commit
  sequence can interleave with another client's calls. Git index, branches and
  working tree are shared. Use a single designated Git writer/coordinator for a
  shared writable ROOT, or separate workspace instances for independent agents.
- External editors and Git processes bypass Kimono's queue. No distributed lock,
  collaborative text merge, per-client roles or per-human commit attribution is
  provided. `confirm=true` relies on the client's explicit approval, not an
  interactive server approval screen.

Read-only sharing is the simplest central knowledge service. Writable mode is
for trusted project/fork repositories and authorized clients only: enable
`AIKIDO_WRITABLE=true` and a writable mount. The official AI-KIDO origin remains
protected. All holders of the HTTP token have the same instance-wide rights;
private specs are excluded by default, but Git access is not filtered by search
exclusions. The Git API is not a sandbox.

**Never share a cache between independent processes.** Separate caches prevent
index collisions, but do not solve concurrent writes to a shared ROOT. For
independent write isolation, use separate clones/workspaces too.

## Integrate into Tatami or another platform

Recommended topology: **one instance per authorized workspace**; in Tatami's
current layout, that means `(user, project)`. Many clients can share that
workspace's instance if they have the same rights.

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

**Platform provisioning/routing is not implemented by Kimono**, and Tatami's
dynamic Kimono manager is a separate integration step. Kimono is not currently
a single-process multi-tenant server accepting arbitrary project paths.

### Git accounts and rotation

Set `KIMONO_GIT_PROFILE_FILE` to a private JSON file outside ROOT (0600/0400,
readable by the runner). It supplies `transport` (`ssh` or `https`), `host`,
`username`, `secret`, `authorName`, `authorEmail`, plus verified `knownHosts`
for SSH. See the [schema and Compose example](../README.md#dynamic-per-instance-git-profile).
The platform retrieves the authorized account's credentials and provisions the
file; private keys/tokens never belong in MCP arguments or repository files.
Use a read-only directory mount and atomically replace the file for rotation.
Git commands reread it without restarting Kimono; in-flight commands retain
their snapshot. Temporary credentials are cleaned up; use a private `/tmp`
tmpfs for abrupt container termination.

SSH uses the configured key (no passphrase/agent), strict host verification and
port 22; HTTPS uses a token on port 443 without redirects. Other hosts,
transports, ports and local-path remotes are rejected in managed mode. One
instance has one Git identity shared by all clients; create separate instances
for different identities. Missing/invalid profiles fail closed. Without this
setting, native runner credentials still work. Official-base write protection
and explicit push approval always remain in effect.

For configuration, write protections and operational limits, see the
[README integration contract](../README.md#integration-with-per-workspace-instance-managers).
