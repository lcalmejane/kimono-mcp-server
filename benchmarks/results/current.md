# Current Kimono RAG benchmark

**2026-10-25 · Gemini 3.8 Flash · Copilot CLI 1.0.103 · Kimono RAG**

The benchmark compares standard Copilot search with Kimono RAG for two
repository tasks. Standard search uses Copilot `grep`, `glob` and `view`.
Kimono RAG adds local lexical search with compact file locations and batched
line-range reads.

## Results

Input tokens are cumulative provider-reported input across model requests,
including cache-read tokens.

| Task | Search method | Cumulative input tokens | Output tokens | Elapsed time | Model requests | Tool calls |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Indexing and ignore-policy research | Copilot search | 323,368 | 2,475 | 111.212 s | 21 | 22 |
| Indexing and ignore-policy research | Kimono RAG | 105,223 | 2,270 | 79.077 s | 9 | 8 |
| Prepare a `maxDepth` implementation plan | Copilot search | 454,796 | 3,347 | 175.224 s | 31 | 30 |
| Prepare a `maxDepth` implementation plan | Kimono RAG | 130,244 | 2,433 | 84.034 s | 9 | 8 |

| Task | Cumulative input change | Elapsed-time change |
| --- | ---: | ---: |
| Indexing and ignore-policy research | −67.5% | −28.9% |
| Prepare a `maxDepth` implementation plan | −71.4% | −52.0% |

The measurements show lower cumulative input and shorter elapsed time with
Kimono RAG for both benchmark tasks.

## Benchmark setup

- Four sessions: one native-search session and one Kimono RAG session for each
  task.
- Identical corpus in both search methods: 51 files, 558,634 bytes.
- Kimono mode: RAG, local lexical/text retrieval.
- Kimono retrieval: batched searches with compact file paths and line ranges,
  followed by reads of selected ranges.
- Kimono tools: `aikido_snapshot`, `aikido_search` and `aikido_file`.
- Model: Gemini 3.8 Flash; client: Copilot CLI 1.0.103.
- Search scope: indexing/ignore-policy research and a `maxDepth` implementation
  plan.

## Batch usage

| Task | Search queries | Search calls | Range reads | Kimono tool calls |
| --- | ---: | ---: | ---: | ---: |
| Indexing and ignore-policy research | 8 | 2 | 4 | 8 |
| Prepare a `maxDepth` implementation plan | 8 | 2 | 4 | 8 |

Each task used one snapshot. Search responses contained file paths and
inclusive line ranges; source text was read only for selected ranges.
