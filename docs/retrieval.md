# Progressive AI-KIDO retrieval / Recherche progressive

[README](../README.md) · [English usage](usage.en.md) · [Usage français](usage.fr.md)

## English: replace a local harness search

Kimono follows AI-KIDO's **metadata → relevant passages → selective read**
approach. It does not execute the structure shell scripts on a client request
or rewrite the canonical structure indexes. The live discovered files are the
source of truth; generated indexes may be stale.

Start each multi-call research task with `aikido_snapshot`:

```json
{"operation":"begin"}
```

Keep the returned `snapshotId` for every `aikido` list/search/read/activate call
and every `aikido_search` / `aikido_file` call, then close it with
`{"operation":"end","snapshotId":"<returned-id>"}`. The immutable snapshot pins
the corpus for literal, regex, semantic and file reads despite concurrent
`sync` or external edits. Responses include `snapshotId`, `version` (SHA-256
corpus fingerprint) and `provenance`. Snapshots expire after 15 minutes, with
at most 8 active snapshots and 256 MiB total; use a fresh snapshot after expiry
or an unknown/stale-ID error.

| Local AI-KIDO concept | MCP equivalent |
| --- | --- |
| V3.1 by-path / by-id | `aikido` `list`, then `aikido_file` `metadata`; `file_id = SHA-256(relative UTF-8 path)[:12]` |
| by-directory / by-type / alphabetical lookup | `pathPrefix`, `type`, `extension`, `kind`, filename/path `query` and pagination on `list` |
| Search skill / plans `path`, `line` (no full code) | `aikido_search.results[].path` + `hits` (default `detail=locations`); text on demand with one `aikido_file` `ranges` batch |
| Progressive disclosure of header/instructions/resources | Metadata/header once per file, then outline or a selected range |
| Full instruction activation | Existing `aikido activate` / `execute`, prompts and full resource reads remain explicit |

The search engines remain **fast-grep** for literal/regex/text and
**embsearch-core / ONNX** for local semantic queries/vectors. Use `text` for
normalized whole terms and one-hop aliases parsed from project
glossaries or vocabulary documents; use `hybrid` to run text and semantic
branches in parallel and receive branch diagnostics plus reciprocal-rank
fusion. The returned `queryPlan` includes vocabulary provenance. Repository
vocabulary is untrusted data, not instructions or factual confidence.
Structure indexing is navigation metadata, not a competing
full-text/embedding algorithm. Semantic identity, cosine ranking and
incremental vector caching are preserved.

Text retrieval follows the search-plan approach: filter the authorized files,
retrieve bounded candidates, then rank passages rather than return the first
alphabetical hits. Matching ignores case and accents (including decomposed
Unicode) and accepts punctuation inside multiword aliases. Original terms are
weighted by document frequency among candidates, both on the passage and on the
whole candidate document (terms spread over several lines); as in the search
plans, query terms found in the file name (and less in parent folders) add a
weighted path boost; exact phrase, filename title and Markdown heading matches
receive bounded boosts. Aliases contribute less
than an original term; definition keywords only break ties on passages already
matching a term or alias, never retrieve unrelated passages on their own.
Repeated documents receive a ranking penalty to diversify the answer.
`matchedTerms` and `scoreDetails` expose the lexical evidence, not a probability.

Candidate collection is bounded to 4,000 lines (40 per file), with a concurrent
1,000-line exact-phrase pass (10 per file) for multiword queries, merged only when
a candidate cap was hit, so a late exact match can survive a noisy file. On the
live root, a search first compares a `stat` signature (path, size, mtime, inode)
of the known files with the last full update: unchanged files skip the full
re-read; any in-place edit is detected and indexed before answering. Explicit
`aikido_index` operations always run a full update. `branches[].candidatesTruncated` reports engine
output limits; these are not exhaustive corpus-wide relevance statistics.
Literal and regex modes retain their exact search semantics. Because fgr indexes
embed absolute paths, they must never be relocated by copying to a snapshot.
The first lexical query builds a dedicated index directly on the immutable
captured corpus; following queries reuse it without rescanning the live source
or its old shards. Creating a snapshot for file/semantic reads does not require
building a lexical index.

Vocabulary is **project-only**: no built-in translations, LLM calls or inferred
synonyms. A French query cannot match English text unless the project declares
the correspondence. For example, in a project glossary:

```markdown
| Term | Synonyms | Definition |
|---|---|---|
| Rules | règles, regles | Project constraints |
```

This makes `regles` retrieve `rules` in text/hybrid mode; `enrich:false` disables
it, and literal/regex remain unchanged. Glossary-generation commands and fenced
examples are not vocabulary sources. Loading is shared across simultaneous
requests; each returned source has provenance without duplication. With no
recognized concepts, `queryPlan.warnings` explains the lack of translation.

Reproducible benchmark (fgr and rg on `PATH`): `npx tsx scripts/bench-search.ts
<ROOT> scripts/bench-cases.aikido.json --runs 5 [--mutable] [--json]` compares
literal, text and a ripgrep baseline (Hit@1, Hit@10, MRR, latency). On the
AI-KIDO corpus (266 files, 12 cases + 1 negative control), text reaches MRR 0.757
(literal 0.194, ripgrep baseline 0.667), Hit@10 12/12, median 19 ms on a snapshot
and 38 ms on the live root (measured on the development Mac, warm index; first query ~250 ms).

At MCP startup, a fresh semantic index is reused; a missing or stale index is
updated in the background. `aikido_index` with `operation=status` and
`mode=semantic` reports the current operation, stage and changed-chunk
embedding progress. A semantic branch returns `not-ready` while preparation is
running rather than holding a search request until indexing completes.

### Compact JSON, not entire files

Call `aikido`:

```json
{"operation":"list","snapshotId":"<returned-id>","scope":"memory","type":"concept","pathPrefix":"prompts/gen","limit":10,"offset":0,"maxBytes":16384}
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

Call `aikido_search` (default `detail=locations`, the token-frugal contract of
the AI-KIDO search skill and plans: *where to look*, not the code itself):

```json
{"snapshotId":"<returned-id>","query":"validate search plan structure","mode":"text","limit":10}
```

Response structure (no text, no headers, no scoring details):

```json
{
  "engine": "fast-grep", "status": "ok",
  "query": {"terms": ["validate", "search", "plan", "structure"],
            "expansions": [{"term": "regles", "concept": "Rules", "relation": "alias", "source": "prompts/glossary.md:12"}]},
  "count": 10, "files": 7, "truncated": true,
  "results": [
    {"path": "prompts/hard_points/commands/validate-search-plan.md", "lines": 372, "score": 2.1707,
     "hits": [2, 6], "terms": ["validate", "search", "plan", "structure"]},
    {"path": "prompts/gen/concepts/design.md", "lines": 120, "score": 0.91, "hits": [[40, 52]]}
  ]
}
```

`results` is one entry per file, ordered by its best `score`; `lines` is the
file length (to decide between ranges and a full read), `hits` the matched
lines in file order (`[start,end]` for a multi-line semantic chunk) and
`terms` the matched query/glossary terms. `count` is the number of hits, `files`
the number of files. `branches` (mode, status, rounded `ms`, count, error)
appears only for hybrid or failed/not-ready branches; `query.expansions` and
`query.warnings` only when non-empty. Measured on this repository: 12,091 →
1,595 bytes for the query above (−87 %); 15,166 → 1,944 bytes for
`orchestrator JSON contract`.

Then fetch **only** the passages you need in **one** batch:

```json
{"operation":"ranges","snapshotId":"<returned-id>","contextLines":1,
 "ranges":[{"path":"prompts/hard_points/commands/validate-search-plan.md","startLine":2},
           {"path":"prompts/hard_points/commands/validate-search-plan.md","startLine":6},
           {"path":"prompts/gen/concepts/design.md","startLine":40,"endLine":52}]}
```

```json
{"count": 2, "truncated": false,
 "passages": [{"path": "…/validate-search-plan.md", "startLine": 1, "endLine": 7, "content": "…"},
              {"path": "prompts/gen/concepts/design.md", "startLine": 39, "endLine": 53, "content": "…"}]}
```

Up to 50 ranges (`endLine` defaults to `startLine`); `contextLines` (0–20,
default 0) widens each range, then overlapping or adjacent ranges of one file
are merged. One `maxBytes` budget (default 16 KiB, max 256 KiB) covers the
batch: when reached, the last passage is cut at a line boundary and
`remaining` lists the exact ranges not returned. Unknown or unreadable paths
are reported per path in `errors` without failing the batch.

`detail=excerpts` keeps the former verbose response for diagnostics:
`documents` (headers once per file, keyed by `file_id`), `results` with
`line`, `startLine`/`endLine`, `excerpt`, `excerptTruncated`, `score`,
`scoreDetails`, `matchedTerms`, plus `queryPlan`, `ranking` and `branches`.
Passing `contextLines` without `detail` selects it for backward compatibility;
`detail=locations` with `contextLines` is rejected. A local consumer expecting
`matches` maps them from `results` (`path` + `hits`) and reads text with
`ranges`. There is no second copy of the JSON in `structuredContent`.

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
With `detail=excerpts`, context is 0–20 lines (default 2); excerpts are at most
2000 characters and flag any character clipping with `excerptTruncated`.
Queries are at most 8192 UTF-8 bytes. Regex errors remain errors, not a silent
literal fallback.

### Read only what the harness needs

Call `aikido_file` (no writable ROOT required for these operations):

```json
{"operation":"metadata","snapshotId":"<returned-id>","path":"prompts/example.md"}
```
```json
{"operation":"outline","snapshotId":"<returned-id>","path":"prompts/example.md","limit":10,"offset":0}
```
```json
{"operation":"read","snapshotId":"<returned-id>","path":"prompts/example.md","startLine":40,"endLine":48}
```
```json
{"operation":"read","snapshotId":"<returned-id>","path":"prompts/example.md","section":"Configuration"}
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
{"operation":"read","snapshotId":"<returned-id>","path":"prompts/example.md","full":true}
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

Nested `.gitignore` rules, dependency/build/cache exclusions, `.git`, `.ssh`,
credential/key files, hidden `.env` files and opt-in private specs apply to
discovery/search/JSON reads and snapshot capture. Hidden capability folders
such as `.github/skills` stay discoverable unless ignored.
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
2. Chercher avec `aikido_search` (par défaut `detail=locations`) : uniquement
   les fichiers classés, leur nombre de lignes, le meilleur score, les lignes
   trouvées (`[début,fin]` pour un chunk sémantique) et les termes reconnus —
   aucun texte.
3. Lire en **un seul lot** les passages utiles avec `aikido_file`
   `operation=ranges` (50 plages max, `contextLines`, fusion par fichier,
   `remaining` si le budget est atteint), puis seulement si nécessaire
   `outline`, `read` par section ou lignes.
4. Lire tout le fichier uniquement sur demande (`full=true`), ou activer
   explicitement les instructions avec `aikido activate`.

Les exemples JSON ci-dessus sont utilisables tels quels par un harnais MCP.
Le résultat est un bloc texte JSON, pas un rapport Markdown à reparcourir.
Un adaptateur du format local `matches` utilise `response.results` (`path` +
`hits`) ; `detail=excerpts` conserve l'ancien format verbeux pour diagnostic.
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
