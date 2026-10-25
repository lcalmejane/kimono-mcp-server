# Changelog

## 0.6.5 - 2026-10-25

- Clarify installation paths for Marketplace-compatible IDEs, Docker and
  native MCP stdio clients in English and French user documentation.
- Document the published GHCR image, version tags and its use as a remote HTTP
  MCP server for GitHub Copilot cloud agent.
- Refresh user-facing RAG, AI-KIDO and measured benchmark descriptions.

## 0.6.4 - 2026-10-25

- Set the VS Code Marketplace display name to `Kimono RAG MCP by AI-KIDO`
  after the Marketplace reported `Kimono MCP` was already taken. The extension
  slug remains `kimono-rag-mcp`.

## 0.6.3 - 2026-10-25

- Rename the VS Code extension slug to `kimono-rag-mcp` after Marketplace
  rejected the previous slug as already existing; the publisher remains
  `ai-kido`. This changes the VS Code extension ID to
  `ai-kido.kimono-rag-mcp`. Reinstall the new extension ID alongside existing
  settings as needed; VS Code treats publisher/name changes as a separate
  extension identity.

## 0.6.2 - 2026-10-25

- VS Code: Kimono Activity Bar view (same kimono icon as Tatami), a management
  panel (settings, per-folder ROOT, remote token, MCP shortcuts, search test
  across modes with recall/precision) and a text status-bar entry. Marketplace
  icon follows the Tatami/AI-KIDO style (dark ensō, blue→teal gradient).
- Live semantic indexing status: files, estimated tokens and chunks
  indexed/total, rate and ETA, published atomically to `KIMONO_STATUS_FILE`
  (default `<cache>/semantic-status.json`) and shared by every process on the
  same ROOT. The panel search test requests `detail=compact`, parses `ranges`
  and displays the exact MCP payload separately from its comparison report.
  No automatic file/excerpt reads, in either RAG or AI-KIDO mode.
  The Activity Bar icon opens the central panel directly, without an intermediate
  navigation tree. Index locks record their owner; another live indexer is awaited
  (`waiting`) instead of failing, and a dead same-host owner is reclaimed.
- One bilingual (automatic FR/EN) management panel shared by the standalone
  extension, Tatami Agent and the Tatami Core web UI: common view
  (`kimono-view.js`), status formatter (`status-format.js`) and stylesheet,
  in a fixed canonical layout. Products fill only their integration sections.
- Anchor native lexical include filters to ROOT so basename matches cannot
  escape a query batch (for example root and nested `README.md` files).
- HTTP readiness accepts standard RAG folders without AI-KIDO entry points;
  authenticated status exposes the active corpus mode.
- Prepare embedded MCP definitions during discovery, not only in the optional
  resolver. Agent hosts that launch the discovered command directly now receive
  the verified bundled engine paths, isolated cache/environment and configured
  corpus mode. Keep remote tokens late-bound in the resolver. Packaged integration
  tests launch both AI-KIDO and RAG without calling the resolver first.

## 0.6.1 - 2026-10-25

- Use `ai-kido.kimono-mcp` as the VSIX identity and future Marketplace namespace,
  rather than a personal publisher. Marketplace availability/access must still
  be verified before submission. Settings lookup uses the installed extension ID.
- Supersedes the unpublished 0.6.0 tag: its distribution/container workflows
  were cancelled before release publication when the publisher choice changed.

## 0.6.0 - 2026-10-25 (unpublished)

- Smaller exposed retrieval definitions (22.5% fewer serialized bytes across
  snapshot/search/file, including batching). `aikido_search` and its `aikido`
  alias accept 1–20 ordered `queries`, sharing filters/mode, one snapshot and
  a total response budget; per-query errors/statuses and `nextQuery` remain
  explicit. Combine hits into the existing 1–50 merged `aikido_file ranges`
  batch. Updated initialization/client guidance and regression tests; no new
  end-to-end model-token savings claimed.
- Search now defaults to minimal `detail=compact`: paths and inclusive line-range
  pairs, no excerpts/scores/repeated provenance. `locations` and `excerpts` remain
  explicit diagnostics; failures/truncation stay visible. Snapshot line counts
  are reused across searches. Added fixed Gemini 3.8 Flash benchmark config.
- Replayable paired harness benchmark with frozen corpus hashes, Copilot CLI
  adapter, configurable external-adapter protocol, real usage telemetry,
  persisted evidence and quality gates, tool/MCP isolation audits, shared CLI
  download caching, disk preflight and timeout-aware paired metrics.
  The current batched-runtime pilot supersedes previous development campaigns;
  old reports and private campaign evidence removed at the owner's request.
- Generic local RAG is now the default, without AI-KIDO entry-point requirements;
  explicitly select `aikido` to retain AI-KIDO discovery, private specs and
  collaboration (migration required for 0.5.x AI-KIDO clients).
- Root/nested gitignore exclusions apply to both modes and all retrieval/index
  paths; dependency/build exclusions remain enforced without ignore files.
- Broad source-language/extensionless-file coverage, validated host-only corpus
  configuration, include/exclude globs, per-root/policy cache isolation and
  explicit scan counts and bounded large-corpus budgets.
- Scoped immutable research snapshots, configurable TTL/count/byte budgets,
  streaming semantic requests, per-document fingerprinting, disk-staged lexical
  updates and bounded native query argument batches for large repositories.
- RAG is read-only for project files; collaboration publication and remote Git
  retarget/sync remain AI-KIDO-only. Generic sources are evidence, not personas.
- VS Code corpus settings and portable stdio launcher for other MCP clients;
  local RAG guide with Copilot, Claude Code, Codex and Antigravity configuration,
  token-frugal retrieval instructions and privacy/measurement limitations.
- VSIX publisher identity is now `lcalmejane.kimono-mcp`, preparing the owner's
  Marketplace namespace. Replace the older `tatami.kimono-mcp` VSIX manually
  and re-enter remote credentials; GitHub publication does not publish Marketplace.
- Separate reusable CLI commands from the executable entry point so bundling
  cannot start the MCP twice; package provenance flags uncommitted sources.

## 0.5.0 - 2026-10-25

- Standalone Kimono MCP VS Code extension, with native MCP registration, trusted
  local multi-root workspaces, optional remote HTTP and endpoint-scoped bearer
  tokens in SecretStorage. Independent of Tatami Core and Agent.
- GitHub CI packages platform VSIX files with Node.js, MCP server, lexical and
  semantic engines/model; verifies packaged MCP/native behavior before publishing
  tagged releases with provenance and checksums. Bilingual integration guide.

## 0.3.0 - 2026-10-17

- Genuine paths-scoped index updates for a file, file list or directory subtree, including missing targets as deletions. Only selected source bodies are read and literal batch shards index only selected changes; semantic synchronization retains untouched vectors without re-embedding.
- `aikido_index` adds `mode=all`, independent per-engine added/modified/deleted JSON reports, scoped cold caches, explicit validation and unchanged global automatic search freshness. CLI accepts `--mode all --paths '["prompts/concepts"]'`.
- Actual fast-grep/ONNX regression tests cover targeting, deletion (including empty files), directory boundaries, exclusions, symlinks, independent baselines and automatic full refresh.

## 0.2.0 - 2026-10-17

- Progressive JSON retrieval aligned with AI-KIDO structure V3.1: deterministic SHA-256 path IDs, file/header/type/check metadata, paginated filtered discovery and MCP resource/prompt catalogues.
- Source-grounded search ranges with bounded context/excerpts, deduplicated document headers, UTF-8 JSON budgets and explicit truncation. Scope/path/type/extension filters precede literal/regex and semantic/vector top-k limits.
- Read-only `aikido_file` metadata, Markdown outline and line/section/full reads, with continuation. Legacy complete reads and activation stay available.
- Nested gitignore rules, cache/environment exclusions and prompts-directory ROOT private-spec handling; bilingual harness migration guide and actual-engine/MCP budget regression tests.

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