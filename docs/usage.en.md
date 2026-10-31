# Kimono usage

[Version française](usage.fr.md) · [Project README](../README.md)

Kimono provides two corpus modes through MCP:

- **RAG** is the default for source code and documentation in any supported
  project. It indexes eligible files locally and provides read-only retrieval.
- **AI-KIDO** is for a knowledge base with `prompts/index.md` or `index.md`.
  It adds AI-KIDO knowledge discovery, instruction activation and explicit
  knowledge collaboration operations.

Both modes return compact locations before source text. Indexing is local, but
an MCP client can send retrieved passages to its model provider.

The current Copilot benchmark using Gemini 3.8 Flash measured 67.5% lower
cumulative input and 28.9% less elapsed time for repository research, and
71.4% lower cumulative input and 52.0% less elapsed time for preparing a
`maxDepth` implementation plan. See the
[benchmark results](../benchmarks/results/current.md).

## Select a mode

Choose the mode when configuring the client/server:

| Configuration surface | RAG | AI-KIDO |
| --- | --- | --- |
| Environment | `KIMONO_CORPUS_MODE=rag` | `KIMONO_CORPUS_MODE=aikido` |
| CLI | `--corpus-mode rag` | `--corpus-mode aikido` |
| VS Code | `kimono.corpusMode: "rag"` | `kimono.corpusMode: "aikido"` |

RAG is the default. The presence of an AI-KIDO index does not switch modes
automatically.

## Search and read

For a consistent multi-step search, begin an immutable snapshot and reuse its
ID for every search and file read:

1. Call `aikido_snapshot` with `{"operation":"begin"}`.
2. Call `aikido_search` with the returned `snapshotId`. Use `text` for lexical
   search, `semantic` for meaning-based search, or `hybrid` for both.
3. Read selected ranges using `aikido_file` with `operation: "ranges"`.
4. Call `aikido_snapshot` with `{"operation":"end","snapshotId":"..."}`.

Search defaults to compact output with paths and inclusive line ranges, not
source text. Batch independent queries in one search call and combine selected
ranges into one read call. Each snapshot is immutable; open a new one to see
file changes. The [retrieval reference](retrieval.md) documents requests,
budgets and continuation.

## AI-KIDO knowledge operations

AI-KIDO mode can list and search knowledge, read documents, and explicitly
activate instructions or workflows for the connected assistant. `activate`
returns instructions to the client; it does not run a model or autonomous
workflow on the server.

`aikido_index` maintains lexical and semantic indexes. Use
`{"operation":"status","mode":"semantic"}` to inspect semantic-index progress.
The index is local and can be rebuilt from the configured ROOT.

For separate AI-KIDO knowledge copies, `aikido_collaboration` supports explicit
status, comparison, revision-pinned reads and publication. Check the current
shared version before making changes, review conflicts and publish only with
an expected version. Collaboration does not commit or push Git changes.

### Automatic delta synchronization

`aikido_collaboration` also automates the per-user flow. Call `mode` with the
absolute `clientRoot` of the client workspace:

- `same-root`: the client edits this exact ROOT (verified embedded stdio only,
  never inferred over HTTP). Files are already shared; `stage`, `overlay` and
  `discard` are skipped and `sync` only refreshes the literal index.
- `replica`: the client has a separate workspace. Changes go through a
  persistent per-user overlay (`owner`, default `default`).

Replica flow:

1. `stage` with `changes` (`content: null` deletes) **when the file is edited**.
   Staging records the shared revision each change started from; syncing
   without staging first loses that base and cannot detect a concurrent edit.
2. `overlay` lists each staged item with a status: `pending`, `integrated`
   (the shared copy already matches) or `conflict` (the shared file moved since
   the change started).
3. `sync` publishes pending items, drops integrated ones, reports conflicts
   explicitly and reindexes the published paths. Resolve a conflict with
   `resolutions: {"path": "local" | "shared"}`; there is no last-write-wins.
4. `discard` removes staged items without publishing.

`aikido_snapshot` `begin` accepts `owner` to capture the shared ROOT merged with
that user's overlay (staged puts replace or add files, staged deletions hide
them). The snapshot `version` then identifies the merged corpus and
`provenance.overlay` reports the owner and file count. Other users and calls
without `owner` keep seeing the shared ROOT only. An index failure during `sync`
is reported as `reindexed: false` and never undoes the publication.

The `aikido_git` tool supports repository information and explicit read-only
remote synchronization after a target is configured. It does not commit, push,
merge or create branches. Local Git operations remain with the client.

## Build a local stdio server

For a client that supports MCP over stdio, build Kimono and its native search
engines from source. Follow the [native setup steps](local-rag.md#native-server-from-source),
then configure the client to launch:

```sh
AIKIDO_ROOT=/absolute/path/to/project KIMONO_CORPUS_MODE=rag node dist/cli.js serve
```

Use `KIMONO_CORPUS_MODE=aikido` and an AI-KIDO ROOT to enable AI-KIDO operations.
Direct integrations designed for specific LLM command-line tools are planned.
For IDEs that accept Visual Studio Marketplace extensions, install the
[Kimono extension](../vscode/README.md).

## Serve multiple clients

One HTTP MCP server can provide a shared corpus to multiple client sessions.
Configure an authorized bearer token and connect clients to its `/mcp`
endpoint. Bind to loopback for local use; remote access requires TLS and an
authenticated reverse proxy. Each independent server process needs its own
cache. See the [distribution guide](vscode-distribution.md) for the VS Code
extension build; server configuration, the published GHCR image and GitHub
Copilot cloud agent setup are described in the [README](../README.md).

## Limits and privacy

Kimono indexes files selected by its corpus policy; it does not scan for
secrets or enforce per-file access control. Local indexing does not guarantee
that retrieved content remains local: the MCP client controls which passages
it sends to its model provider. Review included files and keep credentials out
of the corpus.
