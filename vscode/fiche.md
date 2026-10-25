# Kimono MCP — Visual Studio Marketplace publication brief

English editorial and publication preparation for version 0.6.0+.
This is not a live Marketplace listing or Microsoft approval.
Public copy is separated from the publisher-only checklist below.

## 1. Positioning

**One knowledge base. Your team. Your agents.**

Kimono gives MCP-enabled assistants a common way to retrieve useful evidence
from project code and documentation maintained by people. Start with local RAG,
then explore shared knowledge workflows when your team needs them.

The promise is not simply "cheaper grep." It is an inspectable knowledge layer
across compatible assistants: explicit corpus rules, local retrieval, targeted
reads and version-pinned research. AI-KIDO mode adds versioned knowledge
publication and conflict handling.

Kimono works independently. No AI-KIDO adoption or Tatami installation is
required for default RAG. The wider method and ecosystem are optional next steps.

## 2. Proposed Marketplace metadata

| Field | Proposal |
|---|---|
| Current technical name | `kimono-mcp` |
| Proposed display name | **Kimono MCP — Shared Knowledge & Local RAG** |
| Current manifest publisher | `lcalmejane` — selected by the owner; verify Marketplace account access before submission |
| Intended full ID | `lcalmejane.kimono-mcp` |
| Short description | Local code and docs RAG for MCP assistants. Give your team and agents a common knowledge layer, with targeted reads and local embeddings. |
| Proposed categories | `AI`, `Other`; validate against the current Marketplace schema before publication |
| Proposed keywords | `MCP`, `RAG`, `local search`, `semantic search`, `Copilot`, `AI-KIDO` |
| License | MIT; retain bundled component and model notices |
| Discovery website | <https://ai-kido.fr> |
| Source | <https://github.com/lcalmejane/kimono-mcp-server> |
| Support / issues | <https://github.com/lcalmejane/kimono-mcp-server/issues> |
| Local RAG guide | <https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/local-rag.md> |
| Existing distributions | <https://github.com/lcalmejane/kimono-mcp-server/releases> |

Publisher/name above match the 0.6.0 manifest; display name, description and
categories remain editorial proposals. GitHub distributions are separate from
Marketplace publication: do not claim that a Marketplace listing exists.

## 3. Public copy — adapt for the Marketplace README

### One knowledge base. Your team. Your agents.

**Keep your assistants. Give them common ground.**

Your project knowledge lives in code, decisions, documentation and workflows.
As more people and AI assistants contribute, finding the right evidence matters
as much as generating the next answer.

**Kimono MCP turns project code and documentation into a locally searchable
knowledge layer for MCP-enabled assistants.** Find relevant files and lines
first, then retrieve the passages the task actually needs.

Start in VS Code with a generic project. Use a shared Kimono HTTP service when
several clients need one configured corpus. Human contributors maintain sources
in their editors; agents retrieve evidence through MCP. Independent embedded
instances remain separate processes: installing the extension does not create
a shared server, synchronize workspaces or share chat history.

### More than a token-saving claim

The value of shared knowledge is not captured by the size of one search result.
Kimono provides:

- **Common retrieval conventions:** the same MCP interface for compatible
  assistants, rather than a new collection of ad hoc pasted documents.
- **An explicit corpus:** root and nested `.gitignore` rules, dependency/build
  exclusions and configurable language, inclusion and size policies.
- **Version-pinned research:** snapshots keep related reads on one captured
  corpus. Independent snapshots can capture different versions.
- **Targeted evidence:** compact path/line results first, selected passages next.
- **Batch-first retrieval:** group up to 20 independent searches, then read
  selected evidence in one merged batch of up to 50 ranges across files.
- **Local retrieval and embeddings:** bundled engines and model, without an
  external embedding API.
- **Optional AI-KIDO knowledge workflows:** structured discovery, versioned
  publication, comparison and explicit conflict handling.

Default RAG is read-only. Knowledge publication requires explicit AI-KIDO mode;
it is not collaborative source-code editing or automatic conflict resolution.
Shared HTTP deployments need appropriate authentication, TLS and host-managed
access controls. Kimono is not a shared chat or a user/permission manager.

### Measured trade-offs, not magic percentages

For a team seeking a common knowledge layer, some retrieval overhead may be a
reasonable trade-off. **That is the value proposition—not a measured team
productivity return.** The current **Gemini 3.8 Flash / Copilot CLI** pilot
uses single-agent RAG tasks, with no collaboration tool exposed. It does not
measure the benefits or costs of multi-agent work or establish a fixed overhead rate.

| Current pilot task | Cumulative input reduction | Wall-time reduction | Quality gate |
|---|---:|---:|---|
| Researching indexing rules | 67.5% | 28.9% | Native answer invalid JSON; not comparable-quality evidence |
| Preparing an implementation plan | 71.4% | 52.0% | Automatic checks pass; human review pending |

Four sessions, one pair per task. These percentages describe this execution,
**not validated savings at equivalent quality**, a fixed rate or a billing claim.
Actual `queries[]` searches and `ranges[]` reads were observed in both treatment
sessions; no collaboration tool was exposed.

One pair per task is exploratory; provider caches are not controlled and
human quality review is required. The complete
[current protocol, results and limitations](https://github.com/lcalmejane/kimono-mcp-server/blob/main/benchmarks/results/current.md)
are available for inspection.

Targeted retrieval can avoid unnecessary file dumps, but schemas, tool guidance
and repeated model turns also consume context. No universal token percentage,
billing reduction or automatic adoption by an assistant is promised.

### Find the evidence. Read what matters.

1. **Index locally** the eligible source code and documentation.
2. **Search** by exact terms, expressions, meaning or a hybrid approach.
3. **Select locations** from compact paths and inclusive line ranges.
4. **Read selected passages**, ideally in one batch; widen only when needed.

For example, ask your assistant to locate authentication decisions and relevant
implementations before reading the selected ranges, rather than pasting the
whole module into the conversation.

Kimono provides tools; the assistant decides whether to call them. The extension
does not modify Copilot's inline completion engine or contain its own LLM.

### Start in VS Code

1. Install a supported Kimono MCP build containing generic RAG, version 0.6.0+.
2. Open a folder and grant workspace trust.
3. In **MCP: List Servers**, start **Kimono: …** and approve its execution.
4. Enable its tools in an MCP-capable chat client, such as GitHub Copilot.
5. Ask for a focused project search before reading the useful passages.

Generic RAG is the default. For an existing AI-KIDO Memory Bank, explicitly set:

```json
{
  "kimono.corpusMode": "aikido"
}
```

Suggested assistant instruction:

> Use Kimono to locate evidence relevant to this question. Begin a snapshot,
> batch independent queries, combine selected ranges in one read, then end the snapshot.
> Expand only if the retrieved evidence is insufficient.

The embedded bundle needs no separate Node.js, npm or Docker installation and
does not download model weights at runtime.

### Local retrieval. Clear privacy boundaries.

Embedded indexing, search and embeddings run locally. **That does not mean the
whole conversation stays on your machine:** your chat client may send retrieved
passages to its model provider. Remote HTTP and explicit Git retrieval have
their own network requirements.

Caches contain document copies: protect them like the source material.
Exclusions are not a substitute for secret management or deployment security.

### Start with Kimono. Discover AI-KIDO and Tatami.

Finding the right context is the first step. Structuring, sharing and maintaining
it over time is the next.

**[Discover AI-KIDO at ai-kido.fr](https://ai-kido.fr)** — a method for structured
AI memory, explicit sources of truth and shareable roles, skills and workflows.

| Part of the ecosystem | Explore |
|---|---|
| **Kimono MCP** | Local retrieval and targeted knowledge access for MCP assistants. |
| **Tatami Agent (`tatami-agent`)** | Agent conversations, missions and visualizations through Web and VS Code interfaces. |
| **Tatami IDE (`tatami-ide`)** | The IDE workspace experience within the Tatami workflow. |
| **Tatami Core (`tatami-core`)** | The control plane for projects, orchestration, access, integrations and secrets. |
| **The AI-KIDO method** | Structured Memory Banks, explicit truth sources, roles, skills and shared workflows. |

These are separate components. **You do not need Tatami to use Kimono alone.**
Distribution and availability differ; consult the website for the method and
the evolving ecosystem. Do not assume every component is publicly downloadable.

**Keep your assistant. Build common ground.**

→ [Discover AI-KIDO](https://ai-kido.fr)
· [Read the local RAG guide](https://github.com/lcalmejane/kimono-mcp-server/blob/main/docs/local-rag.md)
· [Inspect the source](https://github.com/lcalmejane/kimono-mcp-server)

### Compatibility and boundaries

- VS Code 1.106 minimum; an MCP-capable chat client with tools enabled.
- Build targets: macOS Apple Silicon, Linux ARM64/x64 with glibc, Windows x64.
  Install on the correct extension host for SSH, WSL or Dev Containers.
- No current build for Intel macOS, native Windows ARM64 or browser-only hosts.
- Bundled engines/model mean a substantial initial package; semantic indexing
  consumes local CPU, RAM and disk.
- Not a compiler/LSP, universal document parser, autonomous agent or code editor.
- RAG does not modify project files. Client tools remain responsible for edits.
- Claude Code, Codex and Antigravity require their own MCP configuration;
  installing the VS Code extension does not configure those clients.
- Historical `aikido_*` tool names also remain in generic RAG mode.

## 4. Short discovery copy

**One knowledge base. Your team. Your agents.**

Kimono MCP brings local code and documentation retrieval to compatible AI
assistants. Find evidence first, read selected passages next, and give your team
a common retrieval interface rather than another pile of pasted context.

Generic RAG by default. Local multilingual embeddings. Gitignore-aware corpus
rules. Version-pinned research. Optional AI-KIDO knowledge publication and
conflict handling. Use it alone, or discover Tatami and the AI-KIDO method.

Built for useful shared context, not guaranteed cheaper searches. A small
single-agent pilot does not measure team productivity or establish a universal
token-saving rate. Shared HTTP services require deliberate deployment;
separate embedded installs do not automatically share a corpus.

**[Keep your assistants. Discover common ground.](https://ai-kido.fr)**

## 5. Publisher checklist — not public listing copy

### Account, identity and assets

- [ ] Create or verify access to the Marketplace publisher `lcalmejane`. A name in the manifest is
  not proof of reservation, ownership or verified identity.
- [ ] Approve the display name; keep a stable technical ID for updates.
- [ ] Declare support contact, repository and issue links.
- [ ] Prepare an original readable PNG icon and declare it in the manifest.
- [ ] Capture real MCP activation, focused search and selected-read screenshots.
  Add an AI-KIDO workflow preview; redact private data and secrets.
- [ ] Use authorized media/public HTTPS links; check current Marketplace rules
  for SVG and README resources.
- [ ] Review Tatami descriptions; link product downloads only when public.

### Package and copy

- [ ] Adapt public copy into the [packaged README](README.md); Marketplace uses
  that file, not this brief. Remove "not published" statements only at launch.
- [ ] Apply approved metadata to the [manifest](package.json): display name,
  description, categories, keywords, icon and support links.
- [ ] Link to an actually published version with default RAG; 0.5.x does not
  include it. Local 0.6.0 work is not evidence of publication.
- [ ] Align server/extension versions, lockfile and changelog; build from an
  identified commit without local modifications.
- [ ] Build/test all four native VSIX targets. Linux ARM64 local validation
  does not certify the other new-version packages.
- [ ] Check licenses, notices, current upload-size limits, and absence of
  project data, caches and secrets from every package.
- [ ] Perform real VS Code installation tests on the target platforms.

### Submission and automation

- [ ] Choose **Manage Publishers** or `vsce` automation; verify the currently
  supported authentication method.
- [ ] Restrict token scope/lifetime if required and store it in CI secrets,
  never in documentation, versioned commands or logs.
- [ ] Publish native VSIX files as platform variants of one extension/version,
  not as an allegedly universal VSIX.
- [ ] For an already built and validated VSIX, the submission command has
  this form:

```sh
npx vsce publish --packagePath vscode/kimono-mcp-<version>-<target>.vsix
```

- [ ] Require human approval for first publication and a separate Marketplace
  job after existing gates. Current CI publishes GitHub Releases, not Marketplace.
- [ ] After acceptance, check the live listing, links, platform downloads and
  upgrade path, then update public installation instructions and announcements.

Official references:
[publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
· [manifest](https://code.visualstudio.com/api/references/extension-manifest)
· [publisher management](https://marketplace.visualstudio.com/manage).

## 6. Evidence policy for commercial/support material

Lead with **shared, inspectable knowledge and useful context**, not a promised
percentage of tokens saved. It is reasonable to discuss the value of a common
knowledge layer despite retrieval overhead, but never label a pilot result
as the fixed price of collaboration: this pilot does not enable or test it.

Keep unfavorable outcomes, timeouts, exact model/harness and quality caveats
visible when quoting figures. Distinguish payload bytes, cumulative model input,
cached input, output, latency and billing. Do not claim "more tokens buys
multi-agent productivity", "saves X%", or "100% private with every assistant".

Before claiming a collaboration return, test multiple people/agents against a
shared service with defined quality, revision freshness, conflict outcomes,
coordination time and total tokens across **all** participants. Compare to a
fair native/team workflow, count server/index costs separately, and publish
repetitions, failures and limitations.
