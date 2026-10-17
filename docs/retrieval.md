# Progressive AI-KIDO retrieval / Recherche progressive

[README](../README.md) · [English usage](usage.en.md) · [Usage français](usage.fr.md)

## English: replace a local harness search

Kimono follows AI-KIDO's **metadata → relevant passages → selective read**
approach. It does not execute the structure shell scripts on a client request
or rewrite the canonical structure indexes. The live discovered files are the
source of truth; generated indexes may be stale.

| Local AI-KIDO concept | MCP equivalent |
| --- | --- |
| V3.1 by-path / by-id | `aikido` `list`, then `aikido_file` `metadata`; `file_id = SHA-256(relative UTF-8 path)[:12]` |
| by-directory / by-type / alphabetical lookup | `pathPrefix`, `type`, `extension`, `kind`, filename/path `query` and pagination on `list` |
| Search skill `path`, `line`, `excerpt` | `aikido_search.results`; `line` is the matched source line, `startLine`/`endLine` delimit the returned excerpt |
| Progressive disclosure of header/instructions/resources | Metadata/header once per file, then outline or a selected range |
| Full instruction activation | Existing `aikido activate` / `execute`, prompts and full resource reads remain explicit |

The search engines remain **fast-grep** for literal/regex and **embsearch-core /
ONNX** for local semantic queries/vectors. Structure indexing is navigation
metadata, not a competing full-text/embedding algorithm. Semantic identity,
cosine ranking and incremental vector caching are preserved.

### Compact JSON, not entire files

Call `aikido`:

```json
{"operation":"list","scope":"memory","type":"concept","pathPrefix":"prompts/gen","limit":10,"offset":0,"maxBytes":16384}
```

The single text content block is JSON: `count` is the number returned,
`total` is the filtered catalogue size, `nextOffset` is the next page or `null`,
and `truncated` signals that another page remains. Follow `nextOffset`, not
`offset + limit`: a byte budget may shorten a page. Discovery is refreshed.
The legacy `count` formerly described an unpaginated complete list; clients
must now use `total` and follow pagination.

Entries carry `id`/`path` (legacy path IDs retained), `file_id`, `name`, `kind`,
`title`, `type`, `extension`, `size_bytes`, `lines`, `modified` (UTC ISO time),
`check_status` and `header`.

`header` includes `startLine`, `endLine`, raw `content` and `truncated`.
YAML frontmatter is returned verbatim, preserving nested `last_check` fields
without pretending to parse arbitrary YAML. Otherwise the initial title,
blockquote metadata and blank lines are returned. Headers are bounded to
40 lines / 4096 UTF-8 bytes; the main response budget also includes JSON escaping.
`check_status` is a presence indicator: `present`, `no-lastcheck`, `no-header`,
`unknown-truncated-header` or `N/A`, **not a truth-validation verdict**.
Use a targeted read to inspect a truncated header.

Call `aikido_search`:

```json
{"query":"workspace","scope":"memory","pathPrefix":"prompts/hard_points","mode":"literal","contextLines":2,"limit":5,"maxBytes":16384}
```

Response structure:

```json
{
  "engine": "fast-grep",
  "count": 1,
  "truncated": false,
  "documents": {"<file_id>": {"path": "prompts/example.md", "header": {}}},
  "results": [
    {
      "path": "prompts/example.md",
      "file_id": "<file_id>",
      "line": 42,
      "startLine": 40,
      "endLine": 44,
      "excerpt": "selected source lines",
      "excerptTruncated": false
    }
  ]
}
```

The example abbreviates metadata; existing `id`, `kind` and `title` remain on
hits for compatibility. Semantic responses additionally preserve model/engine
version, chunk/index statistics and scores.
Headers are in `documents` **once per file**, not copied into every hit.
The matching line remains `line`; a local consumer expecting `matches` can map
`matches = response.results`, and resolve metadata through `documents[file_id]`.
There is no second copy of the JSON in `structuredContent`.

All filters are applied **before** the engine's top-k cap, including vector
search. `pathPrefix` is an exact relative file or directory subtree, not a glob.
`scope=memory` means `prompts/` and a root `index.md`; when ROOT directly
contains the Memory Bank's `index.md` without `prompts/index.md`, the whole ROOT
is memory. `scope=code` is its complement; default `all` covers both. `kind` is the MCP activation classification
(agent/command/skill/workflow/knowledge); `type` is the structure classification
(agent/concept/technique/use_case/hard_point/markdown/script/config/file).
The list query filters names/paths, not document bodies.

Default search response budget: **16 KiB serialized UTF-8 JSON**, configurable
from 2048 to 262144 bytes. Limit: 1–100 hits, with one internal look-ahead;
`truncated` is conservative if the cap or byte budget leaves potential results.
Narrow the query/scope/path or increase the limit/budget; search does not claim
an exact total or provide an offset into a changing ranked corpus.
Context is 0–20 lines (default 2). Excerpts are at most 2000 characters and flag
any character clipping with `excerptTruncated`; expand that range when needed.
Queries are at most 8192 UTF-8 bytes. Regex errors remain errors, not a silent
literal fallback.

### Read only what the harness needs

Call `aikido_file` (no writable ROOT required for these operations):

```json
{"operation":"metadata","path":"prompts/example.md"}
```
```json
{"operation":"outline","path":"prompts/example.md","limit":10,"offset":0}
```
```json
{"operation":"read","path":"prompts/example.md","startLine":40,"endLine":48}
```
```json
{"operation":"read","path":"prompts/example.md","section":"Configuration"}
```

`path` accepts the discovered relative path or its `file_id`. Ranges are
inclusive and **1-based**, and return source text without injected line prefixes.
Markdown outline reports heading levels and section ranges, ignores fenced
code, and paginates with `nextOffset`. Section reads include subsections until
the next same/higher-level heading; duplicate titles are rejected explicitly.
Use an outline/range to resolve duplicates.

Default read: 200 lines, 16 KiB. `truncated` means the requested selection was
cut by the byte budget; `hasMore` and `nextLine` describe continuation in the
file (also after a complete requested range). To finish a chosen range,
repeat with `startLine=nextLine` and the **same original endLine**, stopping
when `truncated=false`. A line that cannot fit causes an explicit error:
increase `maxBytes` rather than silently lose text.

```json
{"operation":"read","path":"prompts/example.md","full":true}
```

An explicit full read returns the exact original content, including its final
newline, with a default 16 MiB response budget (documents remain limited to
2 MiB). A smaller explicit budget may require continuation. `full`, `section`
and line selectors are mutually exclusive. Read budgets permit 2048–16777216
bytes. Metadata and outline share the default 16 KiB budget.

Compatibility: `aikido read` **without selectors** still returns the full raw
file; with selectors/budget it returns the same JSON as `aikido_file read`.
Full resource reads and activation/prompts remain full by intent, not a search
fallback. MCP resource/prompt catalogues use `nextCursor` (25 per page).

Nested `.gitignore` rules, dependency/build/cache exclusions, hidden `.env`
files and opt-in private specs apply to discovery/search/JSON reads. Hidden
capability folders such as `.github/skills` stay discoverable unless ignored.
No path outside ROOT is accepted. Cached search copies remain outside ROOT.
Git tools are not a search sandbox and retain their separate documented policy.

The harness should check MCP `isError`, parse the JSON text, preserve metadata
references and continuation fields, and only expand a selected source passage.
No local AI-KIDO skill, client configuration or Tatami running image is
automatically switched by this change. Configure the harness to prefer these
MCP calls; keep any local fallback explicit and observable.

## Français : parcours recommandé

1. Découvrir avec `aikido list` : métadonnées, en-tête brut, identifiant stable
   SHA-256 du chemin (12 caractères, compatible V3.1), filtres et pagination.
2. Chercher avec `aikido_search` : mêmes moteurs littéral/regex/sémantique,
   mais extraits bornés, contexte et en-tête une seule fois par fichier.
   `line` est la ligne trouvée ; `startLine`/`endLine` bornent l'extrait.
3. Développer seulement la bonne source avec `aikido_file metadata`, `outline`,
   puis `read` par lignes inclusives ou titre de section exact.
4. Lire tout le fichier uniquement sur demande (`full=true`), ou activer
   explicitement les instructions avec `aikido activate`.

Les exemples JSON ci-dessus sont utilisables tels quels par un harnais MCP.
Le résultat est un bloc texte JSON, pas un rapport Markdown à reparcourir.
Un adaptateur du format local `matches` utilise `response.results` et résout
les en-têtes dans `response.documents[result.file_id]`.
Les noms des outils n'ont pas à reproduire les scripts Bash : le besoin
fonctionnel et la divulgation progressive sont conservés.

Les filtres précèdent la limitation, y compris en sémantique/vectoriel.
Le budget par défaut est de **16 Kio de JSON UTF-8**, échappements compris :
ce n'est pas un nombre garanti de tokens, qui dépend du tokenizer du client.
En liste, suivre `nextOffset` jusqu'à `null` ; en recherche, `truncated`
invite à affiner/élargir explicitement. En lecture ciblée, reprendre
`nextLine` en conservant la borne finale souhaitée si `truncated=true`.

Les en-têtes longs sont signalés, les titres ambigus refusés, les fichiers
ignorés/specs privées restent hors périmètre. Une présence de `last_check`
ne certifie pas la vérité du document. La lecture est autorisée sans droits
d'écriture ; les protections Git/fichiers ne sont pas levées.
La bascule du harnais vers le MCP reste une configuration explicite du client.
