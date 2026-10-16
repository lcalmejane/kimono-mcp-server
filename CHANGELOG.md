# Changelog

## 0.1.1 - 2026-10-16

- Dynamic per-instance SSH/HTTPS Git profiles from a private mounted file: rotation without restart, scoped remote validation, strict SSH host keys, commit identity, temporary credential cleanup and sanitized failures. Applies to initialization and project Git tools; official-origin protections remain.

## 0.1.0 - 2026-10-16

- Concise English/French usage guides for standalone deployments, platform integration and concurrent agents/humans sharing a knowledge base, with explicit coordination and authorization limits.
- Per-instance integration contract: authenticated readiness/status HTTP probes, non-blocking semantic index progress polling and graceful SIGTERM/SIGINT draining with a 30-second deadline; Compose init and stop grace period.
- `aikido_embed` introspection (`operation=info`) exposes the active model identifier, preprocessing and actual SHA-256 hashes of weights/tokenizer/spec without inference or index changes.
- Semantic vector input through `aikido_search` and `aikido` search, with required model identity, dimension/finite/non-zero validation, kind filters and fresh incremental indexing; no query re-embedding.
- `aikido_embed` MCP tool returns local query/document embeddings with model metadata and numeric vectors, without requiring ROOT initialization or changing indexes.
- Local multilingual semantic search with embsearch-core 0.3.4, E5 int8 embeddings and ONNX Runtime 1.31.0, exposed through `aikido_search` and `aikido` (`mode=semantic`).
- Persistent incremental vector index, semantic maintenance via `aikido_index` / CLI, bounded cosine-ranked results and existing private-document exclusions.
- Checksummed/pinned model and runtime assets in Docker (Linux arm64/x64), real ONNX MCP integration tests, weekly latest-version checks.
- Configurable standard/custom Git installation with full history and MCP initialization of a configured ROOT.
- Scoped, opt-in project Git/file tools with protection for the standard AI-KIDO origin.
- Real fast-grep 0.5.0 searches and persistent index maintenance, including hidden capabilities and live file changes.
- Rust, Cargo, Git and OpenSSH in Docker; writable project mode and a separate cache volume.
- Workflow discovery, explicit client execution handoff, expanded integration tests and CI.

- Initial AI-KIDO knowledge discovery and MCP server scaffold.
- Added stdio and authenticated Streamable HTTP transports, dynamic resources/prompts, CLI installer, and Docker Compose deployment.