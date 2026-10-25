# MCP retrieval reference

[Version française](retrieval.fr.md) · [Project README](../README.md)

Kimono retrieval is progressive: create a consistent snapshot, search for
locations, then explicitly read only the passages needed. No source text is
returned by the default compact search.

## Snapshot lifecycle

Start each multi-call task with `aikido_snapshot`:

```json
{"operation":"begin"}
```

Pass the returned `snapshotId` to every `aikido_search` and `aikido_file`
request. Finish with:

```json
{"operation":"end","snapshotId":"<snapshot-id>"}
```

A snapshot pins the corpus so searches and reads use the same captured files,
even when the source changes. Open a new snapshot to see edits. Snapshots expire
after 15 minutes. Defaults allow 8 active snapshots; total and per-snapshot
byte budgets depend on the mode. `begin` can accept ROOT-relative `paths` to
capture only selected files or directories. The response reports effective
limits.

## Search

`aikido_search` supports `text`, `semantic`, `hybrid`, `literal`, `regex` and
existing-vector queries. `hybrid` combines lexical and semantic results.
`aikido` with `operation: "search"` also supports the search contract.

Use one query:

```json
{
  "snapshotId":"<snapshot-id>",
  "mode":"hybrid",
  "query":"snapshot configuration",
  "limit":5
}
```

Or batch independent queries:

```json
{
  "snapshotId":"<snapshot-id>",
  "mode":"text",
  "queries":["ignore rules","snapshot configuration","file size limits"],
  "limit":5,
  "maxBytes":16384
}
```

`queries` accepts 1–20 strings, each at most 8192 UTF-8 bytes. All queries in a
batch share the snapshot, mode, filters, result limit and response-byte budget.
The server runs them sequentially. A batch response includes a `searches` entry
for each completed query: an empty `results` array means no match, while a query
error is reported separately and does not stop other queries.

Default `detail=compact` returns file paths, inclusive 1-based line ranges and
the snapshot ID:

```json
{
  "results":[
    {"path":"src/index.ts","ranges":[[24,31],[48,50]]}
  ],
  "snapshotId":"<snapshot-id>"
}
```

Compact results contain no source text. `detail=locations` adds search
diagnostics; `detail=excerpts` explicitly includes text for diagnostics.

Search responses default to 16 KiB of serialized JSON. The limit is
configurable from 2048 bytes to 256 KiB for a single query; batches require at
least 4096 bytes. If a batch is truncated before all queries run, it returns
`nextQuery`, the zero-based index to resume with using the same snapshot and
options. If an individual search omits hits, its `truncated` flag applies to
that query; narrow the search or adjust its budget. A batch continuation does
not retrieve omitted hits from an already executed query.

## Read selected passages

Combine ranges from relevant search results into one `aikido_file` call:

```json
{
  "operation":"ranges",
  "snapshotId":"<snapshot-id>",
  "contextLines":1,
  "ranges":[
    {"path":"src/index.ts","startLine":24,"endLine":31},
    {"path":"src/config.ts","startLine":90,"endLine":95}
  ],
  "maxBytes":16384
}
```

Ranges are inclusive and 1-based. Up to 50 ranges can be requested across
files; overlaps and adjacent ranges within a file are merged. `contextLines`
accepts 0–20 lines and defaults to 0. Results include the exact `remaining`
ranges if the byte budget truncates the response. Unknown or unreadable paths
are reported in `errors`.

Other read operations include:

```json
{"operation":"metadata","snapshotId":"<snapshot-id>","path":"src/index.ts"}
{"operation":"outline","snapshotId":"<snapshot-id>","path":"docs/guide.md"}
{"operation":"read","snapshotId":"<snapshot-id>","path":"docs/guide.md","section":"Configuration"}
{"operation":"read","snapshotId":"<snapshot-id>","path":"src/index.ts","startLine":24,"endLine":31}
```

Line numbers are 1-based. `outline` returns Markdown headings and their ranges.
Section reads include subsections up to the next heading at the same or a
higher level. Full-file reads are explicit; they are not used as an automatic
search fallback. Follow `nextLine` and `remaining` fields when a read is
truncated.

## Filters and corpus boundaries

Search filters apply before result limits. `pathPrefix` selects a relative file
or directory subtree; it is not a glob. AI-KIDO `scope=memory` selects its
knowledge area, while `scope=code` selects the complement. `kind`, `type` and
extension filters restrict eligible documents. `aikido` list operations support
filters and pagination; follow `nextOffset`.

Root and nested `.gitignore` rules and built-in exclusions apply to discovery,
snapshots, search and reads. No path outside ROOT is accepted. Hidden
credentials, dependency/build/cache directories and symlinks are excluded.
Review the [local RAG guide](local-rag.md) for corpus policy and file limits.

## Client guidance

Clients should check MCP `isError`, parse the JSON result, preserve
`snapshotId`, `truncated`, `nextQuery`, `nextLine` and `remaining`, and retrieve
full text only for selected passages. Batch independent queries and reads to
reduce tool round trips. The observed Copilot input and elapsed-time results
are listed in the [current benchmark](../benchmarks/results/current.md).
