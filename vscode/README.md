# Kimono MCP for VS Code / pour VS Code

Standalone local project RAG and AI-KIDO knowledge MCP extension, built entirely from
[Kimono](https://github.com/lcalmejane/kimono-mcp-server).
No Tatami Agent, Tatami Core, Docker, npm or separately installed Node.js is
needed to run it. Each platform VSIX includes Node.js (24 in CI), the MCP server,
fast-grep, the semantic engine, ONNX Runtime and the pinned multilingual model.
Installation does not download engines or model weights. An LLM/chat client
using the tools can still require its own account and network connection.

## One knowledge base. Your team. Your agents.

Give MCP assistants a common way to find evidence in code and documentation
maintained by people. Use the extension alone for local retrieval, or configure
a shared HTTP service when several clients need one corpus. Separate embedded
instances do not automatically synchronize workspaces or conversations.
RAG is read-only by default; versioned publication/conflict handling requires
explicit AI-KIDO mode.

The goal is a useful shared knowledge layer, not a guaranteed cheaper search.
The [current Gemini pilot](https://github.com/lcalmejane/kimono-mcp-server/blob/main/benchmarks/results/current.md)
uses the current runtime on single-agent RAG tasks, not a multi-agent
productivity measurement.
Its planning pair used 71.4% less cumulative input and 52.0% less wall time
with Kimono. One exploratory pair, human review pending; the separate native
research answer failed the JSON-format gate. This is not a validated savings
guarantee or an estimate of billing reduction.
See the [usage guide](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/usage.en.md)
for deployment boundaries and [discover AI-KIDO / Tatami](https://ai-kido.fr)
for the wider workflow.

Batch independent searches with `aikido_search queries:[...]` (up to 20),
then combine selected locations in one `aikido_file operation=ranges` call
(up to 50 ranges, merged per file). Both use the same snapshot and bounded
responses; follow `nextQuery` / `remaining` when truncated. See the
[batch retrieval contract](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/retrieval.md#batch-searches-then-batch-reads).

## Installation (English)

Install **[Kimono RAG MCP by AI-KIDO from the Visual Studio
Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp)**,
or use the GitHub Release VSIX below for offline or manual installation.

1. Install **VS Code 1.106 or newer**, and enable an MCP-capable chat client
   such as GitHub Copilot. MCP tools are not an LLM or an autonomous agent.
2. For manual installation, open
   [GitHub Releases](https://github.com/lcalmejane/kimono-mcp-server/releases)
   and download the matching `kimono-rag-mcp-<version>-<target>.vsix` and
   `SHA256SUMS.txt`. You may verify the SHA-256 with `shasum -a 256 <file>` on
   macOS, `sha256sum <file>` on Linux or `Get-FileHash <file> -Algorithm SHA256`
   in PowerShell.
3. Run **Extensions: Install from VSIX…**, select the file, and reload if asked.
   Alternatively: `code --install-extension /path/to/kimono-rag-mcp-<version>-<target>.vsix`.
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
not currently built/supported. GitHub Releases provide platform-specific VSIX
files for manual installation and remain an alternative distribution channel.

### Kimono panel, live indexing and search test

After installation the **Kimono** icon (the same kimono glyph as Tatami) appears
in the Activity Bar. Clicking it opens the central management panel directly,
without an intermediate sidebar. The panel shows the mode (RAG or AI-KIDO)
and for each workspace ROOT the live semantic index status:

- phase and overall progress (`Indexing · 42% · embedding chunks · ETA 1m 10s`);
- **files** read / total, **tokens (est., bytes÷4)** read / total, **chunks**
  embedded / to embed, rate (chunks/s), ETA and last indexing time.

A text-only status-bar entry (`Kimono: Indexed`, `Kimono: Indexing · 42% …`)
stays visible while the view is closed; click it to open the panel.
**Kimono: Open Management Panel** (title-bar button of the view) gathers:
settings (mode, corpus mode, per-folder ROOT, remote URL/token, config files),
live index status with **Start indexing now**, MCP server shortcuts, and
**Test a search**: one snapshot queried in several modes (exact, regex,
semantic, hybrid…) with latency, hits, response size, overlap/RRF comparison,
and optional expected paths for recall/precision.

Search tests request `detail=compact`, exactly like the default agent search:
`{"results":[{"path":"src/app.ts","ranges":[[12,18]]}]}`. Ranges are inclusive;
warnings or truncation are included only when needed. The same minimal contract
applies in RAG and AI-KIDO mode. No source text is fetched automatically.
**Raw MCP response** shows that exact minified payload and its UTF-8 byte size;
**Full test report** contains the panel's timings/comparison metadata, not the
payload sent to agents. Reading selected source ranges remains an explicit
`aikido_file` action for agents that need the content.

The status is shared: every Kimono process on the same ROOT (Copilot agent host,
VS Code MCP, panel) writes the same `semantic-status.json` in the extension's
global storage. A second process waits for the active indexer instead of
failing; a lock left by a crashed process on the same host is reclaimed.
Search tests and manual indexing use the embedded server only.

The same panel layout (header → status → settings → sharing → MCP server →
search test → governance) is shared with Tatami Agent (Tatami IDE) and the
Tatami Core web UI. Only integration sections differ: collaboration and Git
governance in Tatami, the kind filter in AI-KIDO mode. Panel language is
automatic (French or English, following VS Code or the browser).

### Updating the development VSIX

Versions 0.6.1–0.6.2 use **`ai-kido.kimono-mcp`**; version 0.6.3 changes the
extension identity to **`ai-kido.kimono-rag-mcp`** after the Marketplace
reported the previous slug as already existing. Version 0.6.4 sets the
Marketplace display name to **Kimono RAG MCP by AI-KIDO** after the previous
display name was reported as taken. VS Code treats publisher/name changes as
separate extensions. Uninstall the old `ai-kido.kimono-mcp` extension before
installing 0.6.4 to avoid duplicate MCP providers. Review settings and
re-enter any remote bearer token: secrets and global cache storage are not
migrated between extension identities.
For old AI-KIDO workspaces, explicitly select `kimono.corpusMode: "aikido"`;
the new default is generic read-only RAG.

## Installation (français)

Installer **[Kimono RAG MCP by AI-KIDO depuis le Visual Studio
Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-kido.kimono-rag-mcp)**,
ou utiliser le VSIX de la release GitHub ci-dessous pour une installation
manuelle ou hors ligne.

1. Utiliser **VS Code 1.106 minimum** avec un client de chat compatible MCP
   (par exemple GitHub Copilot). Kimono apporte les outils, pas un modèle LLM.
2. Pour une installation manuelle, télécharger le VSIX correspondant à l'OS et
   à l'architecture de **l'hôte
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

Les versions 0.6.1–0.6.2 utilisent l'identifiant **`ai-kido.kimono-mcp`** ;
la 0.6.3 passe à **`ai-kido.kimono-rag-mcp`** après le conflit de slug signalé
par le Marketplace. La 0.6.4 définit le nom affiché Marketplace
**Kimono RAG MCP by AI-KIDO**, l'ancien étant déjà pris. VS Code considère
ces identifiants comme des extensions distinctes. Désinstaller l'ancienne
extension avant d'installer la 0.6.4 pour éviter deux fournisseurs MCP. Les
secrets et caches ne sont pas migrés entre ces identités ; ressaisir le jeton
distant et sélectionner explicitement `kimono.corpusMode: "aikido"` pour les
anciens workspaces AI-KIDO.

### Panneau Kimono et indexation en temps réel (français)

L'icône **Kimono** (la même que dans Tatami) apparaît dans la barre d'activité.
Un clic ouvre directement le panneau central, sans navigation intermédiaire.
Le panneau affiche le mode et, par ROOT, l'état d'indexation en direct : fichiers,
tokens (estimés) et chunks indexés / total, débit, temps restant (ETA) et date
de la dernière indexation. La barre d'état affiche `Kimono: …` en permanence.
**Kimono: Open Management Panel** regroupe réglages, démarrage d'indexation et
test de recherche multi-modes. Tous les processus Kimono d'un même ROOT
partagent cet état ; un second indexeur attend le premier au lieu d'échouer.
Le même panneau (en-tête, état, réglages, partage, serveur MCP, test de
recherche, gouvernance) est commun à l'extension autonome, à Tatami Agent et à
l'interface Web Tatami Core ; seules les sections d'intégration ou AI-KIDO
diffèrent. La langue (français/anglais) suit automatiquement VS Code ou le
navigateur.
Le test demande le même `detail=compact` qu'un agent : chemins et plages de
lignes uniquement, en RAG comme en AI-KIDO. Aucun extrait n'est lu
automatiquement. « Réponse MCP brute » affiche le JSON minimal exact ;
« Rapport de test complet » contient les métriques et comparaisons du panneau.

## Integration / intégration

### Local RAG for any source project (0.6.0+)

RAG is the default: open a generic code/documentation project without an
AI-KIDO entry point. The explicit setting below is optional:

```json
{
  "kimono.mode": "embedded",
  "kimono.corpusMode": "rag",
  "kimono.root": "",
  "kimono.configFile": "/absolute/private/config/kimono-project.json"
}
```

`configFile` is optional; its host-controlled JSON config can select languages,
include/exclude globs and large-project budgets. `corpusMode` overrides the
file's mode. No project config is loaded implicitly. Restart MCP after changing
configuration. In RAG mode no AI-KIDO entry point is needed and project files
are read-only; Git sync/retarget and collaboration are AI-KIDO-only. Source edits
remain with the client. Generic UTF-8 source languages include TSX/JSX, Java,
Go, Rust, PHP, C/C++ and many others, plus extensionless build files.

Root and nested `.gitignore` files apply automatically in both modes, including
snapshots and lexical/semantic search. Includes cannot override them.
`node_modules`, `dist` and `build` remain excluded even without Git ignore rules.

**Français :** le mode RAG par défaut indexe le code et les documents sans
structure AI-KIDO, en respectant les `.gitignore` et exclusions de dépendances.
Les moteurs/embeddings restent locaux ; le
chat peut transmettre les extraits à son fournisseur. Les gains en tokens ne
sont pas garantis et ne concernent pas automatiquement les complétions inline.
Choisir explicitement `aikido` active le fonctionnement de la Memory Bank.

See [Local RAG: policy, limits and Copilot/Claude Code/Codex/Antigravity setup](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/local-rag.md).
The distribution includes `stdio.cjs` for other MCP clients; installing the
VSIX alone does not configure those clients. RAG requires version 0.6.0+;
0.5.x distributions only provide the original AI-KIDO behavior.

### AI-KIDO (explicit opt-in)

Settings example (user or remote-host settings):

```json
{
  "kimono.mode": "embedded",
  "kimono.corpusMode": "aikido",
  "kimono.root": "knowledge"
}
```

`kimono.root` can be absolute or relative to a workspace folder. Empty means
the open folder. In a multi-root workspace, each local folder gets a distinct
MCP definition; folder-specific `kimono.root` settings are supported.
ROOT must already exist; Kimono does not clone or populate it on installation.
AI-KIDO mode requires `prompts/index.md` or `index.md`. Upgrading from 0.5.x
requires selecting `aikido` explicitly to preserve AI-KIDO-specific workflows;
entry-point presence does not switch modes automatically.
Both a project containing `prompts/` and a dedicated knowledge directory work.
Caches/indexes live in VS Code's private extension storage, outside ROOT.

The extension owns its MCP provider (`kimono.mcp`). It never edits
`.vscode/mcp.json` or user MCP configuration. Set `kimono.mode` to `disabled`,
disable or uninstall the extension to remove its definitions. Existing manual
Kimono/Tatami Agent definitions remain independent: disable one registration
if you see duplicates. Restart the MCP server after changing ROOT or mode.

In AI-KIDO mode all existing MCP tools are available, including snapshot-scoped search,
`aikido_file`, local embeddings and collaboration. For research:

1. Begin with `aikido_snapshot` (`operation=begin`, optional `paths` to capture only relevant subtrees).
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

- Index never ready: open the Kimono view; `Interrupted` means the indexer
  stopped, `Waiting for another indexer` means another process holds the lock.
  Use **Start indexing now** to resume incrementally.
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
