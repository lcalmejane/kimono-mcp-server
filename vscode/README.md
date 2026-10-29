# Local RAG for code and documentation — in VS Code

[Version française](https://github.com/lcalmejane/kimono-mcp-server/blob/main/vscode/README.fr.md)

Kimono gives your MCP assistant a local search index for the project you are
working on. It combines keyword and semantic search, returns relevant file
locations first, and lets the assistant read only the passages it needs.

Use it to find code, APIs, configuration and documentation across a project
without asking an assistant to load whole files up front. Indexing and
embeddings run locally.

In the current Copilot benchmark using Gemini 3.8 Flash, Kimono RAG measured:

| Task | Cumulative input tokens | Elapsed time |
| --- | ---: | ---: |
| Repository research | 323,368 → 105,223 (**−67.5%**) | 111.212 → 79.077 s (**−28.9%**) |
| Prepare a `maxDepth` plan | 454,796 → 130,244 (**−71.4%**) | 175.224 → 84.034 s (**−52.0%**) |

The comparison is standard Copilot search versus local Kimono RAG. See the
[benchmark results](https://github.com/lcalmejane/kimono-mcp-server/blob/main/benchmarks/results/current.md).

## Choose embedding models explicitly

Open **Kimono → Embedding models** to inspect the connected server's requested
and active policies, reason, corpus mix, profiles and missing downloads. This
section loads metadata only while opened or explicitly refreshed, with a small
status poll every 15 seconds (3 seconds during rebuilding), separate from the
index poll. This also observes transitions owned by another MCP process.
Choose **Auto balanced (recommended)**, **Auto speed**, **Code · very fast**,
**Documents · multilingual fast** (~531 MB download, including a 489 MiB table), or the existing, slower
**Documents · multilingual E5**. Speed and estimated memory do not establish
retrieval quality; compare searches on your own corpus.

Each approved model download has a native VS Code confirmation with its exact
size, pinned revision, license and source. Downloading never activates a model
or uploads your corpus. Switching policy requires a separate rebuild
confirmation; the previous generation stays active until success. There is no
automatic consent, download or fallback. Remote mode manages the configured
server, not local models. Embedded launches use host-controlled persistent model
storage and `kimono.embeddingPolicy=auto-balanced` as an initial default only:
the server's saved policy for that ROOT takes precedence on restart.
After installing missing static models, apply the desired policy again to start
the rebuild. E5 remains host-bundled only and has no download action here.

## What you get

- **Local RAG:** index and search your source code and documentation on your
  machine.
- **Lexical and semantic search:** find exact terms or related concepts.
- **Office documents:** search Excel (`.xlsx`) cells, Word (`.docx`) paragraphs
  and PowerPoint (`.pptx`) slide text and tables, with slide numbers.
- **File catalogue:** when content cannot be read, search the filename, project-relative
  path, extension, size and modification date where available.
- **Targeted context:** receive file paths and line ranges before requesting
  source text.
- **Read-only project access:** Kimono does not change your source files.
- **Useful defaults:** `.gitignore` rules apply and common dependency, build
  and cache folders are excluded.
- **Included runtime:** the extension bundles the server, Node.js, search
  engines and embedding model. No separate runtime installation is required.
- **Progress and settings:** use the Kimono panel to monitor indexing and
  configure the project corpus.

PDF text is searchable when `pdftotext` (Poppler) is installed on the extension
host. Without it, PDF files remain searchable through their filesystem metadata.

## Install from the Marketplace

1. Install **Kimono RAG MCP** from the
   [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp).
2. Open and trust your project folder.
3. Run **MCP: List Servers**, start **Kimono**, and enable its tools in your
   MCP chat client's tool picker.
4. Ask your assistant to find relevant code or documentation. It can read
   selected line ranges when it needs details.

Requires VS Code 1.106 or later and an MCP-capable chat client. VS Code-based
IDEs can also use the extension when they support Visual Studio Marketplace
extensions; availability depends on each IDE's extension and Marketplace
configuration.

## Select a project or mode

The default mode is `rag`; the open workspace folder is the default project:

| Setting | Default | Change it when |
| --- | --- | --- |
| `kimono.corpusMode` | `rag` | Select `aikido` only to search an AI-KIDO knowledge base. |
| `kimono.root` | Open workspace folder | Index a different folder. |
| `kimono.mode` | `embedded` | Select `remote` to connect to an existing HTTP MCP server, or `disabled` to stop Kimono. |
| `kimono.url` | Empty | Set the HTTPS `/mcp` endpoint when using `remote`. |
| `kimono.configFile` | Empty | Supply an optional absolute path to a host-managed corpus configuration. |
| `kimono.semanticDevice` | `auto` | Benchmark CPU and available CUDA/CoreML providers once per server session, or explicitly select one. |
| `kimono.logLevel` | `error` | Enable `debug` only for diagnosis; Kimono creates no trace files. The host controls stderr retention. |

Use **Kimono: Open Management Panel** for corpus settings, index status and a
search test. The local RAG mode does not require a special project structure.
The optional AI-KIDO knowledge mode requires `prompts/index.md` or `index.md`.

Embedding uses one model session by default and bounded vector batches. The
panel displays the persistent worker lifecycle, warm index cache, active
embedding model, runtime sizing and estimated CPU/memory budgets when available,
alongside the selected execution provider and startup timings. Resource figures
are planning estimates, not hard utilization or memory limits. See
[runtime and memory settings](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/local-rag.md#embedding-runtime-and-memory).

## Install manually

Download a platform VSIX from
[GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases),
then run **Extensions: Install from VSIX…** in VS Code:

| Extension host | VSIX target |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| Linux ARM64 (glibc) | `linux-arm64` |
| Linux Intel/AMD 64-bit (glibc) | `linux-x64` |
| Windows Intel/AMD 64-bit | `win32-x64` |

Choose the platform of the extension host. For Remote SSH, WSL or Dev
Containers, install on the remote host.

## Use outside a VS Code-based IDE

For a shared MCP server, run Kimono with Docker Compose or the published Docker
image. For a local stdio server, build Kimono and the native search engines
from source; see the [local RAG setup guide](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/local-rag.md).
The published container can also provide a remote HTTP MCP endpoint for GitHub
Copilot cloud agent when deployed on a host reachable over HTTPS. Direct
integrations designed for specific LLM command-line tools are planned.

Kimono can also search an AI-KIDO knowledge base as an optional mode. Learn
about the wider AI-KIDO method at [www.ai-kido.fr](https://www.ai-kido.fr).
