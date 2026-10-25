# Local RAG guide

[Version française](local-rag.fr.md) · [Project README](../README.md)

This guide explains what Kimono indexes, how to choose RAG or AI-KIDO mode,
and how to connect an MCP client.

## Choose the mode

| Mode | Choose it when | Corpus |
| --- | --- | --- |
| `rag` (default) | You want code and documentation search in a regular project | Eligible UTF-8 source and documentation files; no AI-KIDO structure required |
| `aikido` | You already have an AI-KIDO knowledge base and want its discovery and knowledge workflows | Requires `prompts/index.md` or `index.md` at the configured ROOT |

RAG is local, read-only retrieval. It discovers eligible files, builds lexical
and semantic indexes, and exposes MCP tools for search and explicit reads.
It does not write project files or perform AI-KIDO publication/collaboration.

AI-KIDO mode adds structured knowledge discovery and activation, together with
the existing explicit knowledge publication, comparison and Git-sync
operations. These operations act only when requested. They do not make Kimono
an editor, chat interface, autonomous coding agent or Git commit/push tool.

Set the corpus mode in the client or server configuration:

| Client | RAG | AI-KIDO |
| --- | --- | --- |
| VS Code | `kimono.corpusMode: "rag"` (default) | `kimono.corpusMode: "aikido"` |
| Environment | `KIMONO_CORPUS_MODE=rag` (default) | `KIMONO_CORPUS_MODE=aikido` |
| CLI | `--corpus-mode rag` (default) | `--corpus-mode aikido` |

An AI-KIDO index file in the repository does not switch modes automatically.

## What gets indexed

Kimono indexes text files matching the mode's file allowlist. RAG supports
common source, documentation, build and configuration formats across languages
including TypeScript/JavaScript, Python, Java, Go, Rust, PHP, C/C++, C#, Swift,
SQL, HTML/CSS and shell. AI-KIDO uses a narrower documentation-oriented
allowlist. See [`src/corpus-config.ts`](../src/corpus-config.ts) for the exact
defaults.

Both modes respect root and nested `.gitignore` files. Dependencies, build
outputs, caches, secrets directories, symlinks and binary files are excluded.
Built-in exclusions cannot be overridden by include patterns. Kimono does not
scan file contents for secrets: review the files in your corpus before indexing.

Indexing and embedding generation run locally with the bundled lexical engine
and multilingual embedding model. No external embedding API is called. A chat
client may still send passages returned by MCP to its configured model provider.
Local indexing alone does not guarantee that all data remains on your device.

## What search returns

Search defaults to compact results: file paths, matching line ranges and a
snapshot ID, not full source text. The assistant can explicitly retrieve only
the selected lines. This avoids loading unrelated file contents into the
conversation and reduces tool round trips when searches and reads are batched.

For predictable multi-step research:

1. Begin a snapshot with `aikido_snapshot` (`operation: "begin"`).
2. Search in that snapshot with `aikido_search`; use `text` for exact terms or
   `hybrid` for lexical and semantic results.
3. Read relevant line ranges in one `aikido_file` call
   (`operation: "ranges"`).
4. End the snapshot with `aikido_snapshot` (`operation: "end"`).

Snapshots pin search and reads to the same captured corpus. They do not update
automatically after file changes; start a new snapshot to see updates. See the
[retrieval reference](retrieval.md) for request formats, limits and pagination.

### Token use

The current benchmark compared standard Copilot search (`grep`, `glob`, `view`)
with Kimono local lexical RAG using batched searches and selected line-range
reads. With Gemini 3.8 Flash in Copilot CLI 1.0.103, repository research
measured 323,368 → 105,223 cumulative input tokens (−67.5%) and 111.212 →
79.077 seconds (−28.9%). Preparing a `maxDepth` implementation plan measured
454,796 → 130,244 cumulative input tokens (−71.4%) and 175.224 → 84.034
seconds (−52.0%). See the [benchmark results](../benchmarks/results/current.md).

## Install and connect

### VS Code and compatible IDEs

Install [Kimono RAG MCP from the Visual Studio
Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp),
or install the platform-specific VSIX from
[GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases).
The extension supports VS Code 1.106 or newer and provides an embedded local
MCP server. VS Code-based IDEs can also use it when they support Visual Studio
Marketplace extensions; availability depends on each IDE's extension and
Marketplace configuration. Approve workspace trust and enable Kimono tools in
the MCP client. Use **Kimono: Open Management Panel** to configure the corpus
and monitor the index. See the [VS Code guide](../vscode/README.md).

### Docker server

Use [Docker Compose](../README.md#run-a-shared-docker-compose-server) or the
published Docker image to run an authenticated HTTP MCP server. This is the
recommended option when several clients need one shared corpus and index.

The image is published to
[GitHub Container Registry](https://github.com/lcalmejane/kimono-mcp-server/pkgs/container/kimono-mcp-server)
for Linux AMD64 and ARM64. The
[publishing workflow](../.github/workflows/publish-container.yml) runs on each
`v*` tag and publishes both that version tag and `latest`. Pin a version tag
for a fixed deployment; `latest` follows the most recent release.

### GitHub Copilot cloud agent

GitHub Copilot cloud agent can connect to a remote HTTP MCP server. To use the
published image, deploy it on a host reachable by GitHub over HTTPS, mount or
synchronize the repository to index, and set `AIKIDO_ROOT` to that checkout.
The image in GHCR is not itself a running endpoint, and a remote server cannot
automatically access the agent's temporary workspace.

In the repository's **Settings → Copilot → coding agent → MCP configuration**,
configure the HTTPS `/mcp` endpoint and store its token as an Agents secret
named `COPILOT_MCP_AUTH_TOKEN`:

```json
{
  "mcpServers": {
    "kimono": {
      "type": "http",
      "url": "https://kimono.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${COPILOT_MCP_AUTH_TOKEN}"
      },
      "tools": ["aikido_snapshot", "aikido_search", "aikido_file", "aikido_index"]
    }
  }
}
```

The MCP configuration can enable only the tools needed by the agent. The
endpoint must be reachable from GitHub and protected by HTTPS and
authentication; the local Compose configuration binds to loopback and cannot
be used directly by the cloud agent. See GitHub's
[repository MCP configuration guide](https://docs.github.com/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).

### Native server from source

For a local MCP stdio server without Docker, build the server and native
engines from source. Use Node.js 24 or newer and Rust/Cargo for the native
engines. This example targets Linux x64; use the platform target and ONNX
library shown by the generated bundle's `manifest.json`:

```sh
npm ci
npm run build
npm run bundle:native -- --target linux-x64 --output native-bundles/linux-x64
export FGR_BIN="$PWD/native-bundles/linux-x64/bin/fgr"
export KIMONO_SEMANTIC_BIN="$PWD/native-bundles/linux-x64/bin/kimono-semantic"
export KIMONO_MODEL_DIR="$PWD/native-bundles/linux-x64/model"
export ORT_DYLIB_PATH="$PWD/native-bundles/linux-x64/lib/libonnxruntime.so"
AIKIDO_ROOT=/absolute/path/to/project \
KIMONO_CORPUS_MODE=rag \
node dist/cli.js serve
```

Configure the MCP client to launch the server command with the same
environment. Set `KIMONO_CORPUS_MODE=aikido` to use an AI-KIDO knowledge base.
Direct integrations designed for particular LLM command-line tools are on the
roadmap; current use is through a compatible MCP client.

## Configure the corpus

An administrator or trusted host can supply an absolute JSON config path using
`KIMONO_CONFIG_FILE`, the CLI `--config` option or VS Code's
`kimono.configFile` setting. Project files are never auto-discovered as config.
Restart the server after changing the config.

```json
{
  "mode": "rag",
  "extensions": [".md", ".ts", ".tsx", ".js", ".py", ".go", ".rs"],
  "include": ["src/**", "docs/**", "README.md"],
  "exclude": ["**/*.generated.*", "**/fixtures/**"],
  "maxFileBytes": 4194304,
  "maxFiles": 100000,
  "maxCorpusBytes": 536870912
}
```

All fields are optional. `extensions` replaces the default extension list;
`include` and `exclude` are ROOT-relative glob patterns. Exclusions, Git ignore
rules and built-in safety filters always apply. Invalid settings fail with an
error instead of silently falling back.

Default RAG limits are 4 MiB per file, 100,000 files and 512 MiB per corpus.
A snapshot can hold 256 MiB; up to 8 snapshots share a 512 MiB budget and
expire after 15 minutes. These are safety limits, not performance guarantees.
Large semantic indexes require disk, memory and time for initial embedding.
Use include/exclude rules or a scoped snapshot before raising limits.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No search results | Confirm the ROOT, mode, file allowlist, include rules, `.gitignore` and file-size limits. |
| AI-KIDO entry-point error | Select RAG for a regular project, or add the required AI-KIDO entry point to an AI-KIDO corpus. |
| Semantic search not ready | Check `aikido_index` with `operation: "status"` and `mode: "semantic"`; avoid repeating identical failed searches. |
| Old results after editing | Open a new snapshot; existing snapshots intentionally stay unchanged. |
| High indexing time or memory | Narrow the corpus or use a scoped snapshot before increasing limits. |
| Extension cannot start | Trust the workspace, check VS Code's MCP server output and confirm the extension host has a supported platform package. |
| Remote MCP uses a different corpus | ROOT, corpus mode and policy are configured on the remote server. |

### Security and limits

Kimono indexes files permitted by its corpus policy; it is not a sandbox,
secret scanner, code parser or access-control system. The client determines
which MCP tools are enabled and what retrieved passages reach its model
provider. Keep private configuration and caches outside the repository.
