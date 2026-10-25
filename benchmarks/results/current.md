# Current Kimono / Copilot benchmark

**2026-10-25 · Gemini 3.8 Flash · Copilot CLI 1.0.103 · Kimono 0.6.0 unreleased**

This is the **sole reference development campaign**. At the owner's request,
previous reports and all private traces of previous Kimono campaigns in this
session were deleted, not archived. Reusable configurations and the runner remain.
No historical performance figures are carried forward or used as a comparator.

[Sanitized measurements and evidence hashes](current.json)
· [Protocol and replay instructions](../../docs/harness-benchmark.md)
· [Exact campaign configuration](../copilot-gemini-compact.json)

## What this pilot shows

Four completed sessions, one with/without pair per task, all on the requested
`gemini-3.8-flash` model. No timeout, session error or isolation failure.
The treatment actually used compact batched searches and batched file ranges.
Measured cumulative input and wall time were lower with Kimono on both tasks.

**These are exploratory observations, not validated equivalent-quality savings.**
The native research answer is invalid JSON and fails the automatic format gate.
The planning pair passes automatic format, citation-bound and expected-path
coverage checks, but **human quality review is pending for all four answers**.
Neither pair is eligible for a publication-ready savings claim. A successful
process exit is not a successful quality evaluation.

## Protocol and provenance

- Same immutable corpus in both arms: **51 files, 558,634 bytes**, source,
  tests and selected documentation from Kimono itself.
- Root/nested gitignore and permanent dependency/secret exclusions apply during
  capture. Agent instruction/customization files are not loaded. Campaign
  questions and expected-path rubrics are outside the exposed corpus.
- Baseline: only ordinary Copilot `grep`, `glob`, `view`. No Kimono, native
  AI-KIDO search agent, other MCP, shell, edits or delegation.
- Treatment: those same native tools plus only `aikido_snapshot`,
  `aikido_search`, `aikido_file`. No AI-KIDO collaboration tool exposed.
- Both arms use fresh HOME/COPILOT_HOME, disabled builtin MCPs and custom
  instructions, and the same required JSON answer contract.
- Default RAG, lexical/text index, compact search paths/inclusive ranges
  without code excerpts; semantic retrieval is **not** measured here.
- Order: research without → with; planning with → without. **One repetition**
  per task, four sessions total. Equal **600-second** per-session limit.
- Docker/MCP root, catalog and literal index verified during a **0.621 s**
  preflight warmup, outside cell timing. Copilot CLI download/version preflight
  also outside timing, with a shared npm download cache.
- Cell wall time includes CLI startup, MCP connection where applicable, snapshot
  work, tool/model turns and final answer. Snapshot-specific first indexing is
  not subtracted. OS and provider caches are uncontrolled.
- All four corpus checks and observed tool/MCP isolation audits pass.
  Runtime module hashes verified unchanged after all cells.
- Captured checkout: `4a50e4422ffce75139c06a5f597d800d44b8d84d`,
  **dirty, unreleased 0.6.0**. That commit alone does not describe this runtime.
  Documentation was updated after capture; the frozen manifest, not the later
  working tree, defines the measured corpus.
- Local Linux ARM64 test image, mounted current compiled JavaScript, macOS ARM64
  host with Node 26.12.1. The image's local tag is not a released product.
  Its inspected image ID and the runtime module manifest are recorded in JSON.

| Component | SHA-256 |
|---|---|
| Frozen corpus manifest | `8b8931e1d072001adf659a31c43c862bef60f92032efa2402c3d38ddaf0409d4` |
| Compiled runtime manifest | `1a0aee36bf83230b7b6f01f21b4795507be75829a76fbf43a60c2f9985e84e48` |
| Runner | `cac7fd11c54c686dc2e8fb5dd56c005525b9524bf480741590644978e6fd49f9` |

## Measured sessions

Input is cumulative provider-reported input across model requests, including
cache-read tokens. Cache counters below are already included, **not additional
input**. Output and reasoning counters are reported separately, not combined.

| Task | Variant | Input tokens | Output tokens | Wall time | Model requests | Tool calls |
|---|---|---:|---:|---:|---:|---:|
| Indexing/ignore policy research | Native | 323,368 | 2,475 | 111.212 s | 21 | 22 |
| Indexing/ignore policy research | Kimono | 105,223 | 2,270 | 79.077 s | 9 | 8 |
| Prepare `maxDepth` implementation plan | Native | 454,796 | 3,347 | 175.224 s | 31 | 30 |
| Prepare `maxDepth` implementation plan | Kimono | 130,244 | 2,433 | 84.034 s | 9 | 8 |

| Task | Input reduction | Wall-time reduction | Interpretation |
|---|---:|---:|---|
| Research | 67.5% | 28.9% | Raw observation only; native answer invalid JSON |
| Planning | 71.4% | 52.0% | Automatic checks pass; human review pending, one pair only |

Percentages are `(native − Kimono) / native`. They describe this execution,
not a guaranteed rate for other sessions, models, harnesses or projects.
No monetary savings or team productivity return is calculated.

### Cache, reasoning and API time

| Task / variant | Uncached input | Cache-read | Cache-write | Reasoning tokens | Reported API time |
|---|---:|---:|---:|---:|---:|
| Research / native | 90,242 | 233,126 | 0 | 5,807 | 105.937 s |
| Research / Kimono | 39,938 | 65,285 | 0 | 4,026 | 72.979 s |
| Planning / native | 138,353 | 316,443 | 0 | 9,300 | 170.105 s |
| Planning / Kimono | 48,614 | 81,630 | 0 | 3,446 | 77.677 s |

## What was actually batched

Both treatment sessions called only Kimono's three allowed tools, not native
search tools: two snapshot calls (begin/end), two search calls and four ranges
reads each, eight tool calls total per session.

| Task | Queries per search call | Ranges per read call |
|---|---|---|
| Research | 4, 4 | 4, 1, 1, 1 |
| Planning | 5, 3 | 4, 3, 4, 2 |

That is eight queries in two MCP search calls per task, on one snapshot, with
one envelope instead of one model/tool turn per independent query. Engine
queries still execute individually; batching does not imply parallel engines.
Search hit shape verified as exactly `path` + `ranges`, with inclusive line
bounds checked against the frozen corpus. No code excerpt field was returned.
Selected code was subsequently read using the ranges API.

Search warnings were preserved: all sixteen queries emitted the vocabulary
warning in this generic corpus. Five research and six planning query responses
were truncated at their search limits; no whole-query suffix was omitted.
One research query returned no matches. There were no per-query errors and
no failed treatment tool calls. These are bounded retrieval results, not an
exhaustive search/completeness certificate.

## Calls, initialization or context?

Local JSON-RPC and indexing do not themselves call the language model. The
client exposes tool definitions, guidance and results to it. Even in this
optimized runtime, enabling three extra tools has a description cost.

| Diagnostic | Research native | Research Kimono | Planning native | Planning Kimono |
|---|---:|---:|---:|---:|
| Tools described per model request | 3 | 6 | 3 | 6 |
| Client `tool_tokens` per request | 680 | 1,903 | 680 | 1,903 |
| Sum of diagnostic `tool_tokens` | 14,280 | 17,127 | 21,080 | 17,127 |
| Final request input tokens | 26,421 | 19,053 | 28,501 | 23,572 |
| Tool response content UTF-8 bytes | 61,004 | 40,361 | 58,331 | 55,574 |
| Sum of tool elapsed times | 0.392 s | 0.402 s | 0.270 s | 0.415 s |
| MCP pending → connected | N/A | 0.528 s | N/A | 0.395 s |

Per-request tool diagnostics are **1,223 tokens higher** with Kimono. Research
still has a higher *sum* of diagnostic tool tokens despite lower actual input.
Planning has a lower diagnostic sum because it used many fewer requests.
Neither is an exact additive partition of provider billing; do not subtract
these values from input to invent an exact causal attribution.

Most wall time is reported API time, not local tool execution or connection.
Tool elapsed times are summed diagnostics, not an additive wall-time breakdown
when operations overlap. Result bytes count one `result.content` per tool
completion, not duplicated `detailedContent`/MCP envelopes and not billed tokens.

Request snapshots were deduplicated by `model_call_id` from
`prompt_cache_break` before/after states and the final usage checkpoint.
Their counts match all 21/9/31/9 provider-reported requests, and their
`prompt_tokens` sums exactly match provider input in all four cells.

This explains how schema overhead can coexist with lower cumulative usage:
the treatment took fewer model turns with smaller final contexts here.
It does **not** isolate batching from compact serialization, tool guidance,
retrieval relevance or model variability. No unbatched Kimono control was run.

## Quality and failures: preserved, not repaired

| Cell | Process / isolation / corpus | Automatic answer checks | Human review |
|---|---|---|---|
| Research native | Pass | **Fail: malformed JSON**, evidence checks cannot run | Pending |
| Research Kimono | Pass | Format, in-bounds citations, expected paths pass | Pending |
| Planning native | Pass | Format, in-bounds citations, expected paths pass | Pending |
| Planning Kimono | Pass | Format, in-bounds citations, expected paths pass | Pending |

The native research answer contains an invalid object member before a test
path. It is retained exactly as produced; no post-hoc repair or paid rerun.
One native research `view` call also failed with `view_range out of bounds`;
the model recovered. Its time and tokens remain included.

Automatic path bounds do **not** establish citation relevance or correctness.
For example, native research cites exclusion definitions at lines 35–37, while
the frozen definitions are at 25–26; native planning cites `corpusStatus` at 46,
while it is at 51. This assistant spot-check is not a human review or a full
semantic grading of either arm. All answer/review files remain available
privately, including unfavorable results.

Before a defensible commercial savings claim, obtain human rubric review,
repeat matched pairs (at least the runner's three-repetition gate, preferably
more), preserve failures and report variability. This pilot measures research
and preparation of a change, not implemented/tested refactoring or an addon.
It does not measure multi-agent coordination or AI-KIDO collaboration ROI.

## Evidence and replay

The public JSON contains sanitized measurements, corpus/runtime manifests,
quality/eligibility flags and SHA-256 hashes of private raw evidence. It has
no credentials, absolute private paths, code excerpts or conversation dumps.
Private current-campaign evidence retains immutable corpus, exact invocations,
raw events, provider usage, answers, pending reviews, preflight and diagnostics.
Only the disposable npm download cache is removed after completion.

Replay with a **new external output directory**, using the current source
configuration and an explicitly built runtime:

```sh
npm run build
npm run bench:harness -- benchmarks/copilot-gemini-compact.json /private/bench/kimono-current-001
npm run bench:harness -- --summarize /private/bench/kimono-current-001
```

The JSON configuration controls model, adapter, tasks, timeout and repetitions.
Do not splice cells from different restarts/runtimes into a pair. The measured
hashes above describe this pilot, not an arbitrary replay or a published VSIX.
