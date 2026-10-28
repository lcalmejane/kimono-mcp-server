# Local RAG guide

[Version française](local-rag.fr.md) · [Project README](../README.md)

This guide explains what Kimono indexes, how to choose RAG or AI-KIDO mode,
and how to connect an MCP client.

## Choose the mode

| Mode | Choose it when | Corpus |
| --- | --- | --- |
| `rag` (default) | You want code and documentation search in a regular project | Source, documentation, Office/PDF text and file metadata; no AI-KIDO structure required |
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

Kimono indexes text content matching the mode's file allowlist. RAG supports
common source, documentation, build and configuration formats across languages
including TypeScript/JavaScript, Python, Java, Go, Rust, PHP, C/C++, C#, Swift,
SQL, HTML/CSS and shell. AI-KIDO uses a narrower documentation-oriented
allowlist. See [`src/corpus-config.ts`](../src/corpus-config.ts) for the exact
defaults.

Both modes respect root and nested `.gitignore` files. Dependencies, build
outputs, caches, secrets directories and symlinks are excluded.
Built-in exclusions cannot be overridden by include patterns. Kimono does not
scan file contents for secrets: review the files in your corpus before indexing.

### Office and PDF documents

| Format | Searchable representation |
| --- | --- |
| `.xlsx` | One populated worksheet row per line, with sheet name and A1 addresses, e.g. `Costs!A5=Budget \| B5=42`. Shared strings, inline strings and saved values are extracted; uncached formulas remain formula text. |
| `.docx` | Paragraphs in document order, including text in table cells. |
| `.pptx` | Paragraphs and table cells in presentation slide order, prefixed with `Slide N:`. Speaker notes and text inside images are not extracted. |
| `.pdf` | Text extracted by Poppler's `pdftotext`, in reading order. |

These formats are enabled by default in RAG. In AI-KIDO mode, document
extraction is opt-in through the host's `extensions` configuration. Office
extraction runs locally in Node.js; it does not execute formulas or macros.
PDF extraction requires `pdftotext` on the server's PATH. Docker includes
Poppler; on macOS use `brew install poppler`, or on Debian/Ubuntu use
`sudo apt-get install poppler-utils` for a native server or extension host.
Scanned PDFs need OCR outside Kimono before their contents can be searched.

Archives and extracted text are bounded. `maxFileBytes` limits both the source
document and its extracted text; Office archives have an additional 32 MiB
expanded-size and 4,096-entry ceiling. Search and read line numbers refer to the
extracted representation. Snapshots pin that text without modifying originals.
Office/PDF originals are excluded from AI-KIDO text publication and remote sync.

### Metadata when content is unavailable

RAG keeps files searchable even if their extension is unsupported or their
contents are binary, oversized, unreadable or cannot be extracted. It indexes
the filename, ROOT-relative path, extension, file size and last modification
date when available. Search results include `contentStatus: "metadata-only"`;
reads return an explicit metadata record with the reason, not fabricated
document text. The same metadata is preserved in snapshots and indexed by
lexical and semantic search. Missing filesystem values are marked unavailable.

Content failures are traced on stderr and listed in corpus status
(`metadataOnly`, `skipped`, `skippedFiles`). Intentionally excluded paths,
ignored files, secret paths and symlinks are not cataloged. `extensions`
selects which contents to read; `include`/`exclude` controls which paths can
appear at all. AI-KIDO retains its narrower file allowlist.
If a passage cannot be embedded, `skippedChunks` reports it and the semantic
index basis is marked partial; lexical and file-metadata retrieval remain
available.

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

## Embedding runtime and memory

The default `KIMONO_SEMANTIC_DEVICE=auto` benchmarks the CPU and each available
CUDA/CoreML execution provider when the server first uses a model. Each probe
runs in a separate process, loads the same local model, warms up short and long
batches, then measures three identical short/long trials. The lowest median
embedding time wins. Probe processes exit before indexing, releasing their
model sessions. A failed or timed-out probe is reported explicitly and excluded
from selection; if none succeeds, the operation fails. Each probe has a
30-second timeout.

The choice and timings are reused in memory across subsequent operations and
snapshots within the same Kimono server process. Restart the server to
remeasure after changing the hardware, runtime or model at the same path.
`aikido_index`, `aikido_embed`, model info and the shared index status expose
`runtime.executionProvider`, `runtime.benchmarks` and worker/thread/batch
settings. The management panel displays the selected provider and timings.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `KIMONO_SEMANTIC_DEVICE` | `auto` | Benchmark and select, or explicitly select `cpu`, `cuda` or `coreml`. |
| `KIMONO_SEMANTIC_CPU_PERCENT` | `80` | Per-process automatic CPU budget, 1–100% of available CPUs, respecting visible container quotas. |
| `KIMONO_SEMANTIC_MEMORY_PERCENT` | `80` | Per-process planning budget, 1–100% of currently available host/container RAM. |
| `KIMONO_SEMANTIC_WORKERS` | `auto` | CPU sessions: floor(CPU budget / threads), reduced to fit memory, minimum one and maximum 32. Accelerators use one session. |
| `KIMONO_SEMANTIC_THREADS` | `auto` | One inference thread, favoring parallel independent sessions; explicit range 1–32. |
| `KIMONO_SEMANTIC_BATCH` | `auto` | Passages per batch (1–256), sized from memory remaining after model-session estimates. |

CUDA requires a compatible ONNX runtime containing its CUDA provider and GPU
drivers; the standard Linux/Windows bundles contain a CPU runtime. CoreML is
tested when available in the macOS runtime, with CPU/GPU compute units enabled.
An explicitly requested provider that cannot be registered fails rather than
silently switching to CPU. Provider registration and benchmark timing are not
hardware-level GPU execution evidence: `gpuExecutionVerified` remains `false`.

The standalone extension exposes `kimono.semanticDevice`; Tatami Agent exposes
`tatami.kimono.semanticDevice`. Both default to `auto`.

Length-sorted batches alternate short and long work to avoid systematically
slower final batches. A bounded result queue applies backpressure and each
embedded batch is inserted directly into the in-memory index, then released: no
temporary vector file is written, so disk usage does not grow during embedding.
The new generation is written once at the end, then published atomically; the
previous generation is removed only after success. Model hashing and state serialization are
streamed instead of allocating full serialized copies. Native progress includes
`batchMs`, displayed as the last batch duration.

Resource sizing runs before each native operation; cached provider selection
does not freeze the CPU/memory sizing. Explicit worker/thread/batch values remain
supported; an explicit worker or batch request that cannot fit the estimated RAM
budget fails rather than silently shrinking it. Explicit CPU parallelism can
exceed the automatic CPU percentage. At least one CPU is used even if 80% rounds
below one. Model-session estimates account for weights, tokenizer and overhead;
batch estimates account for hidden states and attention at the model token cap.
`runtime.resources` reports available CPUs/RAM, percentages, budgets and estimated
session/batch memory. These estimates are not hard OS memory limits or measured
GPU VRAM usage: other allocations, the growing index and concurrent processes
can require more memory. Percentages apply independently to each process, not
to a shared host scheduler. Increasing CPU workers increases model memory. The
model and in-memory index remain resident while the helper runs; index storage
still grows with the number of passages. Native helper exit releases its process
memory.

## Production diagnostics: no internal trace history

Kimono does not install a telemetry exporter, persist profiling/benchmark traces,
or create log files. `KIMONO_LOG_LEVEL=error` is the default in all environments,
including production. Per-file metadata diagnostics and startup banners are
debug-only; unavailable-content warnings are limited to 32 distinct reasons per
server process. Affected paths and counts remain available in corpus status.
Use `KIMONO_LOG_LEVEL=debug` explicitly during development or diagnosis; the
standalone extension exposes `kimono.logLevel`.

Native progress is an internal pipe used by the live panel, not a persisted log.
Normal mode does not forward these events to the server's stderr. Native
diagnostics are capped per operation at 20 lines of 4,096 characters plus one
omission summary; debug can additionally emit 20 progress lines. Subprocess
stderr retains only a 64 Ki-character in-memory tail for failures.
Errors remain visible; stdout is reserved for MCP/CLI results.

The current semantic status is atomically replaced, throttled to once per 500 ms
during progress, with forced phase/completion updates; no status history is
appended. Index databases, snapshots and extracted-document temporaries
are functional data, not observability archives. Request and extraction
temporaries are cleaned on normal completion/error; a forced
process/machine termination can leave temporary work behind.

The supplied Compose service uses Docker's `local` log driver with rotation
(`max-size: 5m`, `max-file: 2`): approximately 10 MB per container before
compression/driver overhead, not an unbounded JSON log. Existing containers must
be recreated for this setting to apply. Docker, VS Code or another MCP host
controls retention outside Kimono; direct `docker run` needs its own log flags.

For **zero Docker log retention**, use a Compose override (Compose 2.24.4+):

```yaml
services:
  kimono-mcp-server:
    logging: !override
      driver: none
```

For an **external configurable stream**, replace that logging block, for example:

```yaml
services:
  kimono-mcp-server:
    logging: !override
      driver: syslog
      options:
        syslog-address: "${KIMONO_SYSLOG_ADDRESS:?Set an external syslog endpoint}"
        syslog-format: rfc5424
        mode: non-blocking
        max-buffer-size: "1m"
        cache-disabled: "true"
```

The operator supplies the endpoint and applies the override with `docker compose
-f docker-compose.yml -f <override>.yml up -d`. No remote telemetry destination is
enabled automatically. `non-blocking` bounds buffering and may drop logs if the
external collector cannot keep up; `cache-disabled` disables Docker's local
dual-logging cache. Do not redirect stderr to an unrotated file.

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
