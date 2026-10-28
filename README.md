# Kimono RAG MCP

[Version française](README.fr.md)

**Local RAG for your code and documentation.** Kimono indexes a project on
your machine and gives MCP-compatible assistants lexical and semantic search.
It returns relevant files and line ranges first, so an assistant can retrieve
specific passages instead of loading whole files.

In the current Copilot benchmark, Kimono RAG measured lower cumulative input
and shorter elapsed time than standard Copilot search on both tested tasks:

| Task | Cumulative input | Elapsed time |
| --- | ---: | ---: |
| Indexing and ignore-policy research | 323,368 → 105,223 tokens (**−67.5%**) | 111.212 → 79.077 s (**−28.9%**) |
| Prepare a `maxDepth` implementation plan | 454,796 → 130,244 tokens (**−71.4%**) | 175.224 → 84.034 s (**−52.0%**) |

The benchmark used Gemini 3.8 Flash in Copilot CLI 1.0.103. Kimono searched
locally and read selected line ranges. See the [benchmark results](benchmarks/results/current.md).
Indexing and embeddings run locally; the client may send retrieved passages
to its configured model provider.

Semantic indexing uses bounded vector batches and balanced short/long batch
scheduling. On first model use, Kimono benchmarks the CPU and available
CUDA/CoreML providers, then reuses the fastest measured provider for that server
session. See [runtime selection and memory settings](docs/local-rag.md#embedding-runtime-and-memory).

## Choose how to use Kimono

To identify the running server, call `aikido_root` with
`{"operation":"status"}`. Its `server` field contains Kimono's package `name`
and `version`, distinct from the embedding engine version and corpus fingerprint.
The MCP initialization response and authenticated HTTP `/statusz` and `/readyz`
endpoints report the same server identity.

| Use | Best for | Setup |
| --- | --- | --- |
| **IDE extension — recommended** | VS Code and IDEs that support Visual Studio Marketplace extensions | Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp). The extension includes the runtime and search engines. |
| **Docker server** | A shared project corpus for multiple MCP clients, including GitHub Copilot cloud agent | Run the published GHCR image or build with Docker Compose, then connect MCP clients to its `/mcp` endpoint. |
| **Native install from source** | A local server for an MCP client that supports stdio | Build the server and native engines, then configure the MCP client to launch the server. |

VS Code-based IDEs can also use the extension when they support Visual Studio
Marketplace extensions. Availability depends on each IDE's extension and
Marketplace configuration.

Direct integrations for LLM CLIs (Claude Code, Codex and others) are planned.
For now, use an MCP-compatible client with the Docker HTTP server or the native
stdio installation.

## Install the extension in VS Code and compatible IDEs

### Marketplace — recommended

1. Install [Kimono RAG MCP](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp)
   from the Visual Studio Marketplace.
2. Open and trust the project folder.
3. In VS Code, run **MCP: List Servers**, start **Kimono**, and enable its
   tools in your chat client's tool picker.
4. Use the **Kimono** management panel to view indexing progress and change
   the project folder or corpus settings.

Requires VS Code 1.106 or newer and a chat client that supports MCP.

### Manual VSIX installation

Download the VSIX for the **extension host** platform from
[GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases):

| Extension host | Package |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| Linux ARM64 (glibc) | `linux-arm64` |
| Linux Intel/AMD 64-bit (glibc) | `linux-x64` |
| Windows Intel/AMD 64-bit | `win32-x64` |

In VS Code, run **Extensions: Install from VSIX…** and choose the downloaded
file. For Remote SSH, WSL or Dev Containers, install the extension on the
remote extension host. The package includes Node.js and the local search
components; no separate runtime installation is required.

## Run a shared Docker Compose server

Use Docker Compose when several MCP clients need the same indexed project.
Install Docker Engine with the Compose plugin, then from this repository:

```sh
cp .env.example .env
mkdir -p data/project
```

Put the project to index in `data/project`. In `.env`, configure:

```dotenv
AIKIDO_HOST_PARENT=./data
AIKIDO_DIR=project
KIMONO_CORPUS_MODE=rag
AIKIDO_VOLUME_MODE=ro
MCP_AUTH_TOKEN=replace-with-a-long-random-token
```

Generate a token, for example with `openssl rand -hex 32`, and keep `.env`
private. Start the server:

```sh
docker compose up --build -d
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`. Configure each client to use
the Streamable HTTP transport and send the bearer token. The default Compose
configuration listens on the local machine only. For access from other
machines, use TLS and an authenticated reverse proxy; do not expose the
unauthenticated container port to the Internet.

To use the published container image instead of building it locally, pull the
image and run it with the same settings and mounted project directory:

```sh
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
docker pull ghcr.io/lcalmejane/kimono-mcp-server:latest
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  -e AIKIDO_ROOT=/workspace \
  -e KIMONO_CORPUS_MODE=rag \
  -e MCP_TRANSPORT=http \
  -e MCP_HOST=0.0.0.0 \
  -e MCP_PORT=3000 \
  -e MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN" \
  -v "$PWD:/workspace:ro" \
  -v kimono-cache:/home/node/.cache/kimono \
  ghcr.io/lcalmejane/kimono-mcp-server:latest
```

The image is published to the
[GitHub Container Registry](https://github.com/lcalmejane/kimono-mcp-server/pkgs/container/kimono-mcp-server)
for Linux AMD64 and ARM64. Each `v*` version tag runs the
[container publishing workflow](.github/workflows/publish-container.yml), which
publishes a matching version tag (for example, `v0.6.4`) and updates `latest`.
Use a version tag when you want to pin a deployment; use `latest` to follow the
most recently published version. Docker Compose remains the simpler option for
persistent local service management.

### Connect GitHub Copilot cloud agent

The GHCR package is a container image, not a running MCP endpoint. To use it
with GitHub Copilot cloud agent, deploy the image on a host reachable by GitHub
over HTTPS, configure it to serve HTTP MCP, and mount or synchronize the
repository that Kimono should index. The server's `AIKIDO_ROOT` must point to
that accessible checkout; a remote server does not automatically see the
agent's temporary repository workspace.

In the repository's **Settings → Copilot → coding agent → MCP configuration**,
add a remote server entry. Store the bearer token as an Agents secret named
`COPILOT_MCP_AUTH_TOKEN`:

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

The endpoint must be reachable from GitHub and protected with HTTPS and
authentication. Local Docker Compose binds to loopback and is not directly
reachable by GitHub's cloud agent. See GitHub's
[repository MCP server configuration guide](https://docs.github.com/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers)
and the [local RAG guide](docs/local-rag.md) for server setup and corpus
configuration.

To use AI-KIDO mode instead, set `KIMONO_CORPUS_MODE=aikido` and choose a ROOT
containing `prompts/index.md` or `index.md`. For an existing AI-KIDO checkout,
set `AIKIDO_DIR` to its folder name under `AIKIDO_HOST_PARENT`.

## Build and run the native server from source

To run Kimono without Docker, build the server and native engines from source.
Linux x64 example; choose a matching platform target as described in the
[native bundle guide](docs/native-bundles.md):

```sh
npm ci
npm run build
npm run bundle:native -- --target linux-x64 --output native-bundles/linux-x64
```

Set the environment using the paths in the native bundle's `manifest.json`,
then launch the stdio server with the project ROOT:

```sh
export FGR_BIN="$PWD/native-bundles/linux-x64/bin/fgr"
export KIMONO_SEMANTIC_BIN="$PWD/native-bundles/linux-x64/bin/kimono-semantic"
export KIMONO_MODEL_DIR="$PWD/native-bundles/linux-x64/model"
export ORT_DYLIB_PATH="$PWD/native-bundles/linux-x64/lib/libonnxruntime.so"
AIKIDO_ROOT=/absolute/path/to/project \
KIMONO_CORPUS_MODE=rag \
node dist/cli.js serve
```

Configure the MCP client to launch this command with the same environment.
Platform targets, ONNX libraries and environment variables are documented in
the [native bundle guide](docs/native-bundles.md). To share one index among
clients, use the Docker HTTP server.

## Use RAG

RAG is the default and works with ordinary source-code and documentation
projects; no special project structure is required.

1. Select Kimono's MCP tools in the client.
2. Ask the assistant to search the project for the relevant files or concepts.
3. Let it read the returned line ranges when it needs the source details.

Search uses lexical and semantic retrieval. Results identify files and lines
before any source content is read. `.gitignore` rules apply; common dependency,
build and cache folders are excluded. Kimono does not modify project files.

### Office documents, PDF and file metadata

RAG also extracts text from **Excel `.xlsx`**, **Word `.docx`**, **PowerPoint `.pptx`** and **PDF**
documents. Excel results retain worksheet names and cell addresses, for example
`Costs!A5=Budget | B5=42`. Word results follow paragraph order, including table
cells. PowerPoint text follows presentation slide order, including table cells,
with slide numbers (`Slide 1: …`). Speaker notes and text inside images are not extracted.
Search line numbers refer to the extracted text, not the document's page
layout. Formulas use their saved result when available; Kimono does not run
formulas or macros.

PDF extraction uses `pdftotext` from Poppler. Docker includes it; for native or
embedded extension use, install Poppler separately (`brew install poppler` on
macOS, `sudo apt-get install poppler-utils` on Debian/Ubuntu) and make
`pdftotext` available on the server's PATH. Scanned PDFs are not OCR-processed.

**Files remain discoverable even when their contents cannot be read.** For
unsupported formats, binary, oversized, unreadable or failed-extraction files,
Kimono indexes the filename, ROOT-relative path, extension, size and last
modification date when available. Results explicitly identify
`contentStatus: "metadata-only"` and explain the missing content. This also
applies when PDF extraction is unavailable. Original files are never replaced
with extracted text or metadata.

`.gitignore`, include/exclude rules and built-in safety exclusions still apply
to file metadata. Use path exclusions to remove a file entirely; an extension
allowlist controls content extraction, not the RAG file catalog.

## Configure the corpus

In VS Code, use **Kimono: Open Management Panel** or set:

| Setting | Default | Purpose |
| --- | --- | --- |
| `kimono.corpusMode` | `rag` | `rag` for ordinary projects; `aikido` for an AI-KIDO knowledge base. |
| `kimono.root` | Open workspace folder | Folder to index. |
| `kimono.mode` | `embedded` | `embedded` for a local server, `remote` for an existing HTTP MCP server, or `disabled`. |
| `kimono.url` | Empty | Remote server's HTTPS `/mcp` URL when `kimono.mode` is `remote`. |
| `kimono.configFile` | Empty | Optional absolute path to a host-managed corpus configuration. |

For VS Code settings, see the [extension guide](vscode/README.md). Remote
bearer tokens are entered through **Kimono: Set Remote Token** and stored in
VS Code SecretStorage.

For server installations, `KIMONO_CORPUS_MODE` selects the mode and
`AIKIDO_ROOT` selects the project directory. An optional JSON config can narrow
file types or paths and adjust corpus limits:

```json
{
  "mode": "rag",
  "extensions": [".md", ".ts", ".tsx", ".js", ".py"],
  "include": ["src/**", "docs/**"],
  "exclude": ["**/*.generated.*", "**/fixtures/**"]
}
```

Configuration paths are chosen by the server host; project files are not
loaded as configuration automatically. The defaults limit a corpus to 100,000
files and 512 MiB, with a 4 MiB maximum file size in RAG mode. See the
[RAG setup guide](docs/local-rag.md) for all settings and limits.

## Optional AI-KIDO mode

Kimono can also retrieve an existing AI-KIDO knowledge base when you select
`aikido` mode. It keeps local RAG available for any project and adds
AI-KIDO-specific knowledge discovery and collaboration when needed. Learn more
about the wider method and tools at [www.ai-kido.fr](https://www.ai-kido.fr).

## More help

- [RAG setup, parameters and client configuration](docs/local-rag.md)
- [Using Kimono's MCP features](docs/usage.en.md)
- [Search and selected-file retrieval](docs/retrieval.md)
- [VS Code installation and settings](vscode/README.md)
- [Extension packaging and release details](docs/vscode-distribution.md)
