# Kimono MCP Server

Standalone MCP server for an AI-KIDO knowledge base, usable by tatami-core, VS Code, Claude Code and other MCP clients. Commands, agents/personas, skills, workflows, concepts, techniques, use cases and hard points are discovered from `AIKIDO_ROOT`, not a static catalogue.

The standard AI-KIDO base is protected. A separate, explicitly writable project/fork can be edited and synchronized with its own Git remote.

## MCP capabilities

| Tool | Operations |
| --- | --- |
| `aikido` | `list`, `search`, `read`, `activate`, `execute`, `refresh` |
| `aikido_root` | `status`, `init`: initialize the configured ROOT from the official or another Git repository |
| `aikido_search` | Literal/regex search through the real Rust fast-grep index, with paths, line numbers and excerpts |
| `aikido_index` | `update`, `rebuild`, `compact`, `stats` |
| `aikido_git` | Scoped, structured Git operations on the configured project |
| `aikido_file` | Create/update/delete text documents; overwrites/deletes require exact previous contents |

Documents also appear as resources (`aikido://<encoded-relative-path>`) and prompts (`aikido.<kind>.<encoded-relative-path>`), with completions.

`activate` and its `execute` alias return instructions/context for the connected assistant. They do **not** claim an LLM workflow has run. The client executes those instructions with its own tools/approvals, including Kimono's file/Git tools when enabled. Kimono has no embedded LLM or unrestricted shell.

The initial Kimono scaffold lacked Git/file actions and indexed search; these are now separate MCP tools.

## Requirements

- Node.js 24+, Git, and `fgr` on PATH for native execution.
- Rust/Cargo to install the published `fast-grep` crate.
- Or Docker Engine with Compose v2: the image contains Node.js, Rust, Cargo, Git, OpenSSH and `fgr`.

```sh
cargo install fast-grep --version 0.5.0 --locked
npm ci
npm run build
```

The crate is named **fast-grep**; its binary is **fgr**, not `fgrep`.

## Initialize or select a ROOT

Select an existing AI-KIDO checkout, or explicitly install one:

```sh
# Standard base:
node dist/cli.js init --root /absolute/path/to/aikido --ref main
# Separate project/fork:
node dist/cli.js init --root /absolute/path/to/project \
  --repository https://github.com/your-org/your-aikido.git --ref main
# Serve an existing ROOT:
node dist/cli.js serve --root /absolute/path/to/project
```

The default source is `https://github.com/lcalmejane/aikido.git`. `--repository` overrides `AIKIDO_REPOSITORY`; `--ref` overrides `AIKIDO_REF`. HTTPS, SSH and absolute local repository paths are accepted.

Installation retains full history, uses argument arrays (no shell interpolation), validates `prompts/index.md` or `index.md`, and places the clone at its target only after success. Absent/empty targets are accepted; non-empty targets are never overwritten.

The server can also start with an absent/empty configured ROOT. Invoke:

```json
{"operation":"init","repository":"https://github.com/your-org/your-aikido.git","ref":"main"}
```

on `aikido_root` to initialize **that ROOT only**, never an arbitrary path provided by the client. Discovery requires initialization first. MCP initialization needs a writable disk mount, but does not unlock subsequent writes to the standard base.

## Indexed search

All knowledge searches use **fast-grep 0.5.0**, installed from crates.io. This is indexed literal/regex search, **not** vector/embedding search.

At startup, Kimono builds/updates the index for the actual ROOT. Before every search it rescans the catalogue and incrementally updates the index, covering added/changed/deleted files, including external edits. MCP Git/file operations also update it.

Only discovered text documents enter a private search mirror. Binary files, symlinks, dependency/build directories and files over 2 MiB are excluded. `prompts/spec/` is excluded unless `AIKIDO_INCLUDE_SPEC=true` explicitly enables that private space. Excluded files never enter the fgr index.

The persistent cache lives **outside AIKIDO_ROOT**. This allows indexing a read-only standard base without changing it. Treat the cache as sensitive: it contains document copies. An image cannot ship a prebuilt index for a ROOT chosen later.

Updates/searches are serialized in-process. Use one server process per ROOT/cache; independent processes need distinct cache directories.

```sh
# Maintain the index without starting MCP:
AIKIDO_ROOT=/absolute/path/to/aikido node dist/cli.js index
```

## MCP clients

Stdio is the default transport. Example VS Code configuration:

```json
{
  "servers": {
    "kimono": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/kimono-mcp-server/dist/index.js"],
      "env": { "AIKIDO_ROOT": "/absolute/path/to/aikido" }
    }
  }
}
```

For Claude Code or another stdio client, use the same executable, arguments and environment in that client's MCP configuration. Diagnostic output goes to stderr, preserving the MCP stdout stream.

## Docker Compose

```sh
cp .env.example .env
# Set AIKIDO_HOST_PARENT and AIKIDO_DIR.
# Set MCP_AUTH_TOKEN to a long random secret.
docker compose up --build -d
```

The image installs `fast-grep` using `cargo install fast-grep --version 0.5.0 --locked` and retains Rust/Cargo at runtime. It runs as UID 1000 (`node`). Host directories must be readable by that UID and writable for installation/project editing.

Defaults expect `./data/aikido`. The knowledge mount is read-only by default; a named `kimono-cache` volume stores the index. Only `127.0.0.1` is published. HTTP MCP requests need `Authorization: Bearer <MCP_AUTH_TOKEN>`. `/healthz` is unauthenticated and reveals no knowledge data.

```sh
# Explicit installation using AIKIDO_REPOSITORY and AIKIDO_REF from .env:
docker compose --profile install run --build --rm install-aikido
docker compose up --build -d kimono-mcp-server
```

The server never performs an implicit Git fetch/pull at startup. For remote/public use, terminate TLS and enforce an authenticated, authorized reverse proxy; do not expose HTTP directly to the Internet.

### Writable projects

For a **separate trusted project/fork**, set both:

```dotenv
AIKIDO_WRITABLE=true
AIKIDO_VOLUME_MODE=rw
```

This does not unlock the official base: the origin and its effective fetch/push URLs are checked before mutations. Adding or pushing/fetching an official remote is rejected. Use separate Kimono instances for the standard base and a writable project.

Supported structured Git operations:

```text
status log diff show blame ls-files reflog remote
add restore rm commit fetch pull push switch checkout branch tag
merge rebase rebase-abort rebase-continue cherry-pick revert reset
stash stash-pop remote-add
```

Examples for `aikido_git`:

```json
{"operation":"add","paths":["prompts/gen/concepts/architecture.md"]}
{"operation":"commit","message":"docs: update project architecture"}
{"operation":"push","remote":"origin","ref":"main","confirm":true}
```

As intentionally agreed, this is a structured Git API, not an unrestricted Git/shell runner. Branch/tag operations create refs; `reset` is mixed and `pull` is fast-forward only. Force-push/hard-reset, custom aliases and arbitrary Git flags/configuration are not exposed. `push`/`reset` need `confirm=true` only after explicit client/user approval. Relevant hooks, fsmonitor, external diff and textconv are disabled.

Configure Git identity and credentials on the runner, not in tool arguments or source files. Native Git supports `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`. With Compose, pass these explicitly through a local service override or mount an appropriate scoped Git config. For SSH, explicitly provide a scoped key/known_hosts or an agent socket; credentials are not bundled in the image.

Writable mode is for trusted repositories and authorized clients: Git configuration/filters and remote servers can execute code. This API is not a sandbox. HTTP tokens authorize the whole configured instance, including enabled writes. Git history/diff tools expose repository contents independently of the search index exclusions; those exclusions are not Git access controls.

## Validation and publication

```sh
npm run typecheck
npm test
npm run build
# Equivalent real Git/fgr tests without local Rust:
docker build --target test -t kimono-mcp-test .
docker run --rm kimono-mcp-test
```

CI installs the pinned Rust crate before type checking, tests and build. The container publication workflow publishes GHCR images for `v*` tags to `ghcr.io/lcalmejane/kimono-mcp-server`.

Source repository: [lcalmejane/kimono-mcp-server](https://github.com/lcalmejane/kimono-mcp-server) (currently private).

## License

MIT. See [LICENSE](LICENSE). Third-party dependencies retain their own licenses.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `AIKIDO_ROOT` | required | Existing AI-KIDO root or absent/empty initialization target. |
| `AIKIDO_REPOSITORY` | official Git URL | Default source for CLI/MCP/Compose installation. |
| `AIKIDO_REF` | `main` | Branch/tag for explicit installation. |
| `AIKIDO_WRITABLE` | `false` | Opt-in project mutations; cannot unlock the official base. |
| `AIKIDO_INCLUDE_SPEC` | `false` | Explicitly expose private personal specs in discovery/indexing. |
| `KIMONO_CACHE_DIR` | `~/.cache/kimono` | Cache parent outside ROOT; contains sensitive document copies. |
| `FGR_BIN` | `fgr` | Path to the fast-grep executable. |
| `MCP_TRANSPORT` | `stdio` | `stdio` or authenticated Streamable `http`. |
| `MCP_HOST` | `127.0.0.1` | HTTP address; Compose uses `0.0.0.0` inside the container. |
| `MCP_PORT` | `3000` | HTTP port, 1-65535. |
| `MCP_AUTH_TOKEN` | required for HTTP | Bearer token protecting the complete MCP instance. |
| `AIKIDO_HOST_PARENT` | `./data` | Compose host parent directory. |
| `AIKIDO_DIR` | `aikido` | Checkout directory relative to the host parent. |
| `AIKIDO_VOLUME_MODE` | `ro` | Compose mount mode; `rw` for editing/MCP initialization. |
