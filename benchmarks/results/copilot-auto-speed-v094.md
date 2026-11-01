# Kimono benchmark: four models with `auto-speed` (v0.9.4)

**2026-11-01 · Copilot CLI 1.0.103 · Kimono 0.9.4 RAG (lexical + semantic) · `auto-speed`**

Same harness, tasks and protocol as the [hybrid `auto-speed` report](copilot-gemini-auto-speed.md),
run once per model on the Kimono repository at tag `v0.9.4`: Gemini 3.8 Flash,
Claude Sonnet 5, GPT-5.6 Luna and Grok 4.7. Standard search uses Copilot `grep`,
`glob` and `view` in both arms; Kimono adds `aikido_snapshot`, `aikido_search`
and `aikido_file` in the Kimono arm.

This is an exploratory pilot: one run per cell, human quality review pending.
It is not a savings claim. The corpus differs from the 2026-10-31 report
(`5f7d502d…`, 77 files), so absolute figures are not comparable with it.

## Runs

| Model | Corpus SHA-256 | Files | Bytes | Working tree |
| --- | --- | ---: | ---: | --- |
| gemini-3.8-flash | `d46dcab3…` | 80 | 875,636 | clean |
| claude-sonnet-5 | `d46dcab3…` | 80 | 875,636 | clean |
| gpt-5.6-luna | `6a289a1f…` | 80 | 876,505 | dirty (see below) |
| grok-4.7 | `6a289a1f…` | 80 | 876,505 | dirty (see below) |

The two series do not share a byte-identical corpus. Runs 1-2 use `d46dcab3…`,
runs 3-4 use `6a289a1f…`. The only difference is `tests/bench-harness.test.ts`
(+12 lines: the isolation test for the `rg` alias, added after the first
GPT-5.6 Luna attempt, see Benchmark setup). No model targeted or cited that file.
The `dirty` flag on runs 3-4 reflects uncommitted changes: the harness alias fix
(`scripts/bench-harness.ts` and its test, the test being inside the measured
corpus as noted above) and the new report files, which are outside it.

## Results

Input tokens are cumulative provider-reported input across model requests,
including cached input. Models are not compared with each other on absolute
tokens or time (different tokenizers, providers and caches); the pairs below
compare each model with itself.

### gemini-3.8-flash

| Task | Search method | Elapsed time | Input tokens | Uncached input | Output tokens | Tool calls |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Indexing and ignore-policy research | Copilot search | 154.2 s | 638,121 | 138,581 | 2,790 | view 16, grep 13, glob 1 |
| Indexing and ignore-policy research | Kimono RAG | 106.0 s | 224,644 | 72,357 | 2,055 | Kimono 3, view 8, grep 6 |
| Prepare a `maxDepth` implementation plan | Copilot search | 226.2 s | 559,805 | 126,079 | 2,616 | view 17, grep 12, glob 1 |
| Prepare a `maxDepth` implementation plan | Kimono RAG | 192.0 s | 662,683 | 139,040 | 2,912 | Kimono 12, grep 16, glob 4 |

| Pair | Input change | Uncached input change | Output change | Elapsed-time change |
| --- | ---: | ---: | ---: | ---: |
| Indexing and ignore-policy research | −64.8% | −47.8% | −26.3% | −31.2% |
| Prepare a `maxDepth` implementation plan | +18.4% | +10.3% | +11.3% | −15.1% |

### claude-sonnet-5

| Task | Search method | Elapsed time | Input tokens | Cache read / write | Output tokens | Tool calls |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Indexing and ignore-policy research | Copilot search | 64.1 s | 301,392 | 262,851 / 38,513 | 4,885 | view 9, grep 5 |
| Indexing and ignore-policy research | Kimono RAG | 58.9 s | 300,181 | 260,621 / 39,538 | 4,571 | Kimono 8, grep 5 |
| Prepare a `maxDepth` implementation plan | Copilot search | 96.9 s | 388,101 | 362,806 / 25,253 | 7,898 | grep 10, view 10, glob 1 |
| Prepare a `maxDepth` implementation plan | Kimono RAG | 115.7 s | 313,298 | 283,249 / 30,021 | 9,848 | Kimono 9, grep 6, view 4 |

| Pair | Input change | Output change | Elapsed-time change |
| --- | ---: | ---: | ---: |
| Indexing and ignore-policy research | −0.4% | −6.4% | −8.2% |
| Prepare a `maxDepth` implementation plan | −19.3% | +24.7% | +19.4% |

### gpt-5.6-luna

| Task | Search method | Elapsed time | Input tokens | Cache read / write | Output tokens | Tool calls |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Indexing and ignore-policy research | Copilot search | 26.6 s | 117,325 | 86,114 / 31,193 | 1,961 | view 9, grep 4, glob 1 |
| Indexing and ignore-policy research | Kimono RAG | 39.8 s | 126,142 | 101,209 / 24,903 | 2,610 | Kimono 14 |
| Prepare a `maxDepth` implementation plan | Copilot search | 40.5 s | 241,921 | 193,953 / 47,944 | 3,602 | view 15, grep 13, glob 1 |
| Prepare a `maxDepth` implementation plan | Kimono RAG | 43.8 s | 252,589 | 223,316 / 29,231 | 2,960 | Kimono 8, view 15 |

| Pair | Input change | Output change | Elapsed-time change |
| --- | ---: | ---: | ---: |
| Indexing and ignore-policy research | +7.5% | +33.1% | +49.4% |
| Prepare a `maxDepth` implementation plan | +4.4% | −17.8% | +8.2% |

### grok-4.7

| Task | Search method | Elapsed time | Input tokens | Uncached input | Output tokens | Tool calls |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Indexing and ignore-policy research | Copilot search | 226.2 s | 977,441 | 148,641 | 18,142 | grep 62, view 33, glob 1 |
| Indexing and ignore-policy research | Kimono RAG | 163.9 s | 437,833 | 154,313 | 12,320 | Kimono 29 |
| Prepare a `maxDepth` implementation plan | Copilot search | 326.1 s | 1,181,660 | 116,956 | 20,188 | grep 62, view 39, glob 4 |
| Prepare a `maxDepth` implementation plan | Kimono RAG | 188.5 s | 509,587 | 58,899 | 12,084 | Kimono 29, glob 1 |

| Pair | Input change | Uncached input change | Output change | Elapsed-time change |
| --- | ---: | ---: | ---: | ---: |
| Indexing and ignore-policy research | −55.2% | +3.8% | −32.1% | −27.5% |
| Prepare a `maxDepth` implementation plan | −56.9% | −49.6% | −40.1% | −42.2% |

Expected-file coverage (automatic check, not a correctness score):

| Task | Model | Copilot search | Kimono RAG |
| --- | --- | ---: | ---: |
| Indexing and ignore-policy research | gemini-3.8-flash | 50% (evidence checks failed) | 100% |
| Indexing and ignore-policy research | claude-sonnet-5 | 100% | 100% |
| Indexing and ignore-policy research | gpt-5.6-luna | 100% | 100% |
| Indexing and ignore-policy research | grok-4.7 | 50% | 50% |
| Prepare a `maxDepth` implementation plan | gemini-3.8-flash | 25% (evidence checks failed) | 100% |
| Prepare a `maxDepth` implementation plan | claude-sonnet-5 | 100% | 100% |
| Prepare a `maxDepth` implementation plan | gpt-5.6-luna | 100% | 100% |
| Prepare a `maxDepth` implementation plan | grok-4.7 | 100% | 100% |

## Reading the results

- **The Kimono effect on cost and time depends on the model.** Grok 4.7 explores
  heavily with native search (977,441 and 1,181,660 input tokens) and gains the
  most: input −55.2% and −56.9%, elapsed time −27.5% and −42.2%. Gemini 3.8
  Flash drops 64.8% input on research but rises 18.4% on the plan. Claude
  Sonnet 5 and GPT-5.6 Luna are already efficient natively (14 to 21 tool calls
  for Claude, a few hundred thousand input tokens at most) and show no
  consistent gain: Claude research −0.4% input, plan −19.3% input but +19.4%
  time; GPT research +7.5% input and +49.4% time, plan +4.4% input and +8.2%
  time. A tentative reading is that the savings grow with how much a model
  explores natively; four models and one run each do not establish it.
- **The "upward smoothing of relevance" hypothesis is not supported as a general
  effect.** Kimono lifted coverage only for Gemini (50% and 25% to 100% and
  100%). Claude and GPT reach 100% in both arms. Grok stays at 50% on the
  research task with and without Kimono, and at 100% on the plan in both arms.
  With Grok the missing expected file is `tests/corpus.test.ts` in both arms.
- For GPT-5.6 Luna, Kimono made both tasks slower (+49.4% and +8.2%) and sent
  more input on both (+7.5% and +4.4%).
- Output tokens move with input for Grok (−32.1%, −40.1%) and are mixed
  elsewhere, so part of Grok's time saving is shorter answers.

## Benchmark setup

- Kimono 0.9.4 (`fgr` 0.5.0), local image `tatami-core-kimono` built on the
  published `ghcr.io/lcalmejane/kimono-mcp-server:v0.9.4` image. Mode: RAG,
  hybrid retrieval, `auto-speed` embedding policy (code: `potion-code-16M-v2`,
  documents: `potion-multilingual-128M`), search detail `compact`.
- Warm-up outside the cells: 5.6 s (Gemini), 10.4 s (Sonnet), 6.8 s (GPT), 3.5 s (Grok).
- Cell timeout: 900 s. Configurations in `benchmarks/`:
  [Gemini](../copilot-gemini-auto-speed.json),
  [Claude Sonnet 5](../copilot-claude-sonnet5-auto-speed.json),
  [GPT-5.6 Luna](../copilot-gpt56luna-auto-speed.json),
  [Grok 4.7](../copilot-grok47-auto-speed.json); they differ only by `model`.
- Isolation audit passed on all 16 cells and the corpus was unchanged after each.
- **`rg` alias.** The first GPT-5.6 Luna attempt was stopped after its first cell:
  the audit flagged `rg` as an unlisted tool. The CLI was started with
  `--available-tools grep,glob,view`, `rg` takes the same parameters as `grep`
  and returns the same `[grep-paths: …]` output, so it is the CLI `grep` tool
  exposed under another name to this model. The audit now maps only `rg` to
  `grep`, reports it in `aliasedTools`, and still rejects every other unlisted
  name (tested). The discarded attempt is not used. Runs 3 and 4 were executed
  after the fix; the alias only appears on GPT-5.6 Luna's native arm.
- Model choice: Claude Sonnet 5 is the mid-range Anthropic model (picker
  category `versatile`); GPT-5.6 Luna and Grok 4.7 were requested by the user. The
  Copilot catalog exposes no price, so no cost claim is made.
- Machine-readable data: [copilot-auto-speed-v094.json](copilot-auto-speed-v094.json).

## Limitations

- One run per cell; no confidence interval. A claim needs at least three
  repetitions.
- Human quality review pending. Automatic checks validate format, path bounds
  and coverage only.
- Providers report cache differently: Gemini and Grok give uncached input, Claude
  and GPT give cache read and cache write separately (uncached input is a few
  tokens). The uncached column is therefore not comparable across models.
- Provider and OS caches and model variability are uncontrolled. Input tokens
  include cached input and are not a bill.
- Two tasks, one repository, one harness (Copilot CLI). Single-agent read-only
  retrieval; no implementation, multi-agent or Zoo Code measurement.
