# Marketplace listing

[Version française](fiche.fr.md)

## Extension

- **Publisher:** AI-KIDO
- **Name:** Kimono RAG MCP
- **ID:** `ai-kido.kimono-rag-mcp`
- **Category:** AI, Machine Learning, Other
- **Tags:** `mcp`, `rag`, `semantic search`, `code search`, `local indexing`
- **Minimum VS Code version:** 1.106

## Short description

Local RAG for code and documentation with lexical and semantic search over MCP.

## Overview

Search your codebase locally with Kimono RAG MCP. It combines keyword and
semantic retrieval to find relevant source code and documentation, then gives
your MCP assistant file locations and selected line ranges to read.

Get focused project context without loading whole files up front. Indexing and
embeddings run on your machine, and Kimono does not modify project files.
Your MCP client controls which tools are enabled and what retrieved content is
sent to its model provider.

### Highlights

- Local lexical, semantic and hybrid search.
- Works with regular source-code and documentation projects; no special
  project structure is needed.
- Compact file and line-range results; source is read only when requested.
- Respects `.gitignore` and excludes common dependency, build and cache folders.
- Includes the server, Node.js runtime, search engines and embedding model.
- Provides an in-editor panel for index progress, corpus settings and search.

In the current Copilot benchmark using Gemini 3.8 Flash, Kimono RAG measured:

| Task | Cumulative input tokens | Elapsed time |
| --- | ---: | ---: |
| Repository research | 323,368 → 105,223 (**−67.5%**) | 111.212 → 79.077 s (**−28.9%**) |
| Prepare a `maxDepth` plan | 454,796 → 130,244 (**−71.4%**) | 175.224 → 84.034 s (**−52.0%**) |

The comparison is standard Copilot search versus local Kimono RAG. See the
[benchmark results](https://github.com/lcalmejane/kimono-mcp-server/blob/main/benchmarks/results/current.md).

The optional AI-KIDO knowledge mode supports users who already work with the
AI-KIDO method. Learn more at [www.ai-kido.fr](https://www.ai-kido.fr).

## Install

Install **Kimono RAG MCP** from the Visual Studio Marketplace. Open and trust a
project folder, start **Kimono** from **MCP: List Servers**, then enable its
tools in your MCP chat client.

Requires VS Code 1.106 or later and an MCP-capable client.

## More information

- [English project README](../README.md)
- [Local RAG setup and usage](../docs/local-rag.md)
- [Manual VSIX installation](README.md)
- [Build and release details](../docs/vscode-distribution.md)

MIT licensed. Notices for bundled runtime components and third-party
dependencies are included with the extension.
