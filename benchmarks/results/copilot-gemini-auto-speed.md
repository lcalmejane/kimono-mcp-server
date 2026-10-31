# Kimono RAG benchmark: hybrid search with `auto-speed`

**2026-10-31 · Gemini 3.8 Flash · Copilot CLI 1.0.103 · Kimono RAG (lexical + semantic)**

Same harness, model and tasks as the [current lexical benchmark](current.md),
but Kimono indexes lexical and semantic data (`indexMode: all`) with the
`auto-speed` embedding policy, so searches are hybrid. Standard search uses
Copilot `grep`, `glob` and `view` in both arms; Kimono adds `aikido_snapshot`,
`aikido_search` and `aikido_file` in the Kimono arm.

This is an exploratory pilot: one run per cell, human quality review pending.
Do not compare it with the lexical report as a savings claim.

## Results

Input tokens are cumulative provider-reported input across model requests,
including cache-read tokens.

| Task | Run | Search method | Elapsed time | Input tokens | Uncached input | Output tokens | Tool calls |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Indexing and ignore-policy research | 1 | Copilot search | 117.2 s | 291,884 | 82,546 | 1,744 | grep 9, view 9, glob 3 |
| Indexing and ignore-policy research | 1 | Kimono RAG | 116.0 s | 308,832 | 80,973 | 2,191 | Kimono 10, grep 7, glob 1 |
| Prepare a `maxDepth` implementation plan | 2 | Copilot search | 338.7 s | 1,668,213 | 300,185 | 3,744 | grep 28, view 31, glob 1 |
| Prepare a `maxDepth` implementation plan | 2 | Kimono RAG | 232.8 s | 937,977 | 148,069 | 3,244 | Kimono 6, grep 13, view 16, glob 1 |
| Prepare a `maxDepth` implementation plan | 1 | Kimono RAG | 190.1 s | 745,204 | 165,062 | 3,643 | Kimono 28 |

| Pair | Input change | Uncached input change | Elapsed-time change |
| --- | ---: | ---: | ---: |
| Research, run 1 (same run) | +5.8% | −1.9% | −1.1% |
| `maxDepth` plan, run 2 (same run) | −43.8% | −50.7% | −31.3% |
| `maxDepth` plan, run 1 Kimono vs run 2 native (two runs) | −55.3% | −45.0% | −43.9% |

Expected-file coverage (automatic check, not a correctness score):

| Task | Copilot search | Kimono RAG |
| --- | ---: | ---: |
| Indexing and ignore-policy research | 50% | 100% |
| Prepare a `maxDepth` implementation plan | 75% | 100% (both runs) |

## Reading the results

- The research task shows no token or time gain with hybrid Kimono. The lexical
  report shows −67.5% input on the same task, with a different corpus slice,
  index mode and run.
- The planning task shows lower input and shorter elapsed time with Kimono in
  both runs.
- The same task and arm varied a lot between runs (Kimono, `maxDepth` plan:
  745,204 and 937,977 input tokens). One run per cell cannot separate the effect
  of Kimono from this variance.

## Benchmark setup

- Five sessions over two runs. Run 1 was interrupted by the tool time limit
  after three cells; run 2 re-ran only the `maxDepth` plan (native, then Kimono).
- Identical corpus in both arms and both runs: 77 files, 854,952 bytes
  (SHA-256 `5f7d502d…e2e07`).
- Kimono mode: RAG, hybrid retrieval, `auto-speed` embedding policy (code:
  `potion-code-16M-v2`, documents: `potion-multilingual-128M`).
- Warm-up outside the cells: 4.3 s (run 1), cold cache.
- Kimono tools: `aikido_snapshot`, `aikido_search` and `aikido_file`;
  search detail `compact`.
- Cell timeout: 900 s. Configuration: [copilot-gemini-auto-speed.json](../copilot-gemini-auto-speed.json).
- Image: local `tatami-core-kimono` build, not an immutable release.
- Machine-readable data: [copilot-gemini-auto-speed.json](copilot-gemini-auto-speed.json).

## Limitations

- One run per cell; no confidence interval.
- Human quality review pending. Automatic checks validate format, path bounds
  and coverage only.
- Provider and OS caches and model variability are uncontrolled. Input tokens
  include cached input and are not a bill.
- Single-agent read-only retrieval; no implementation, multi-agent or Zoo Code
  measurement.
