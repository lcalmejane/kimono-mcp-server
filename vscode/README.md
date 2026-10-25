# Kimono MCP for VS Code / pour VS Code

Standalone AI-KIDO knowledge MCP extension, built entirely from
[Kimono](https://github.com/lcalmejane/kimono-mcp-server).
No Tatami Agent, Tatami Core, Docker, npm or separately installed Node.js is
needed to run it. Each platform VSIX includes Node.js (24 in CI), the MCP server,
fast-grep, the semantic engine, ONNX Runtime and the pinned multilingual model.
Installation does not download engines or model weights. An LLM/chat client
using the tools can still require its own account and network connection.

## Installation (English)

1. Install **VS Code 1.106 or newer**, and enable an MCP-capable chat client
   such as GitHub Copilot. MCP tools are not an LLM or an autonomous agent.
2. Open [GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases)
   and download the matching `kimono-mcp-<version>-<target>.vsix` and
   `SHA256SUMS.txt`. You may verify the SHA-256 with `shasum -a 256 <file>` on
   macOS, `sha256sum <file>` on Linux or `Get-FileHash <file> -Algorithm SHA256`
   in PowerShell.
3. Run **Extensions: Install from VSIX…**, select the file, and reload if asked.
   Alternatively: `code --install-extension /path/to/kimono-mcp-<version>-<target>.vsix`.
4. Open and trust a folder containing your knowledge base. Run **Kimono: Open
   Settings** if its ROOT is not the folder itself.
5. Run **MCP: List Servers**, select **Kimono: …**, and start it. Approve VS
   Code's MCP trust prompt, then enable its tools in your chat client's tool
   picker. Use **Show Output** in the server menu for diagnostics.

| Extension-host OS / architecture | Target |
|---|---|
| macOS Apple Silicon | `darwin-arm64` |
| Linux ARM64 (glibc, not Alpine/musl) | `linux-arm64` |
| Linux Intel/AMD 64-bit (glibc) | `linux-x64` |
| Windows Intel/AMD 64-bit | `win32-x64` |

Choose the **extension host's** platform, not the computer displaying VS Code.
For Remote SSH, WSL and Dev Containers, install in the remote workspace host
using its Extensions menu. A Mac connected to Linux ARM64 needs `linux-arm64`.
Intel macOS, native Windows ARM64 and standalone browser-only `vscode.dev` are
not currently built/supported. There is no Marketplace or Open VSX publication;
download and install a newer VSIX to update.

## Installation (français)

1. Utiliser **VS Code 1.106 minimum** avec un client de chat compatible MCP
   (par exemple GitHub Copilot). Kimono apporte les outils, pas un modèle LLM.
2. Télécharger le VSIX correspondant à l'OS et à l'architecture de **l'hôte
   d'extension** dans les
   [Releases GitHub](https://github.com/lcalmejane/kimono-mcp-server/releases).
   Le tableau ci-dessus donne les quatre plateformes construites.
3. Ouvrir les extensions → menu `…` → **Installer à partir d'un VSIX…**,
   puis sélectionner le fichier. Node.js, les moteurs et le modèle sont inclus.
4. Ouvrir un dossier de connaissances et lui accorder la confiance.
   **Kimono: Open Settings** permet de choisir un autre ROOT.
5. Exécuter **MCP: List Servers**, démarrer **Kimono: …**, accepter la demande
   de confiance MCP et activer les outils dans le sélecteur du chat.

En SSH, WSL ou Dev Container, installer l'extension **côté distant**. Le paquet
ne dépend pas du workspace de développement Tatami. La mise à jour se fait en
installant le nouveau VSIX. Le mode restreint bloque le démarrage. Une politique
d'organisation peut également interdire MCP ou les extensions hors Marketplace.

## Integration / intégration

Settings example (user or remote-host settings):

```json
{
  "kimono.mode": "embedded",
  "kimono.root": "knowledge"
}
```

`kimono.root` can be absolute or relative to a workspace folder. Empty means
the open folder. In a multi-root workspace, each local folder gets a distinct
MCP definition; folder-specific `kimono.root` settings are supported.
ROOT must already exist; Kimono does not clone or populate it on installation.
Both a project containing `prompts/` and a dedicated knowledge directory work.
Caches/indexes live in VS Code's private extension storage, outside ROOT.

The extension owns its MCP provider (`kimono.mcp`). It never edits
`.vscode/mcp.json` or user MCP configuration. Set `kimono.mode` to `disabled`,
disable or uninstall the extension to remove its definitions. Existing manual
Kimono/Tatami Agent definitions remain independent: disable one registration
if you see duplicates. Restart the MCP server after changing ROOT or mode.

All existing MCP tools are available, including snapshot-scoped search,
`aikido_file`, local embeddings and collaboration. For research:

1. Begin with `aikido_snapshot` (`operation=begin`).
2. Use its `snapshotId` with `aikido_search` (`mode=text`, `semantic` or `hybrid`).
3. Read the selected locations with `aikido_file` (`operation=ranges`).
4. End the snapshot (`operation=end`).

Indexing starts in the server. If semantic search reports not ready, inspect
`aikido_index` (`operation=status`, `mode=semantic`) instead of repeating searches.
Knowledge changes and conflict resolution remain explicit; installation does
not automatically sync, publish, commit or push anything.
See the [full MCP retrieval and collaboration documentation](https://github.com/lcalmejane/kimono-mcp-server#knowledge-collaboration-through-mcp).

### Remote HTTP MCP

Set `kimono.mode` to `remote` and `kimono.url` to your existing MCP endpoint,
for example `https://knowledge.example.com/mcp`. HTTPS is required except for
loopback HTTP. URLs with credentials, queries or fragments are rejected.
Use **Kimono: Set Remote Bearer Token** if authentication is required; the
token is stored in VS Code **SecretStorage**, bound to that exact endpoint,
and added only when VS Code resolves the server. Changing the URL requires
setting a token for the new endpoint or clearing it with **Kimono: Clear Remote
Bearer Token**. Never put credentials in settings, URLs, prompts or tool arguments.
Remote mode does not start local engines. Remote ROOT/authentication and
permissions are controlled by the server, not by `kimono.root`.

### Git read access

Git is optional for local knowledge/search. For remote source retrieval through
`aikido_git`, install Git (and OpenSSH for SSH URLs) on the extension host.
Set `kimono.gitProfileFile` in user settings to an absolute path to the existing
private Git profile JSON, outside ROOT; Kimono enforces its 0600/0400 permissions
and exact-host/transport checks. See the
[Git profile contract](https://github.com/lcalmejane/kimono-mcp-server#dynamic-per-instance-git-profile).
Do not store the profile in the repository. No token is accepted as an MCP
argument. Local child processes receive an isolated environment and HOME;
your shell's arbitrary environment variables and Git profiles are not inherited.
Remote MCP uses its own authentication integration.

## Troubleshooting / dépannage

- No tools: verify the workspace is trusted, mode is not disabled, MCP is enabled
  in your VS Code/client, then check **MCP: List Servers → Show Output**.
- Wrong platform/checksum error: reinstall the matching release VSIX; do not
  replace binaries by hand. Only native CI success verifies a platform.
- ROOT/cache error: ROOT must exist and must not contain the extension's storage.
- Offline: installation/search/embeddings are local; Git retrieval and remote
  mode need network access. Model/client providers may also need network access.
- CPU/memory: semantic indexing uses local ONNX sessions and can require
  substantial RAM. It is separate from the consuming LLM's resource use.
- Disabling MCP or an enterprise policy cannot be bypassed by this extension.

Build/release instructions: [GitHub distribution guide](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/vscode-distribution.md).
Kimono is MIT; bundled Node.js, ONNX Runtime, model and server dependency notices
are retained in the distribution.
