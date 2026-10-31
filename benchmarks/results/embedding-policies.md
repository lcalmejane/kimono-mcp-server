# Kimono embedding policies benchmark

**2026-10-31 · no LLM · image `tatami-core-kimono` · script [`bench-embedding.mjs`](../../scripts/bench-embedding.mjs)**

Compares the embedding policies `e5` (native E5 model), `auto-balanced` and
`auto-speed` on the same corpus, through the Kimono MCP server over stdio. No
language model is involved, so the run costs no credits.

Corpus: Kimono `src/`, `tests/`, `docs/`, `README.md` and `package.json`: 79
files, about 1 MiB (67 code files, 12 documents). 16 hand-written FR/EN queries
with expected files. Each policy runs in a throw-away container with an empty
cache, so indexing is measured cold.

## Cold indexing

| Policy | Start-up | Lexical index | Semantic index | Change vs `e5` |
| --- | ---: | ---: | ---: | ---: |
| `e5` | 708 ms | 173 ms | 18,824 ms | reference |
| `auto-balanced` | 618 ms | 152 ms | 4,532 ms | −76% |
| `auto-speed` | 520 ms | 165 ms | 2,471 ms | −87% |

## Search

Latency is the first run of each query (query embedding and search). Repeated
runs hit the search cache (about 0.5 to 0.7 ms) and are in the JSON file.
Tokens are estimated as response bytes / 4.

| Mode | Policy | Median latency | Response bytes | Hit@1 | Hit@3 | Hit@10 | MRR |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `text` | `e5` | 21.4 ms | 581 | 7/16 | 9/16 | 13/16 | 0.543 |
| `text` | `auto-balanced` | 21.2 ms | 581 | 7/16 | 9/16 | 13/16 | 0.543 |
| `text` | `auto-speed` | 20.7 ms | 581 | 7/16 | 9/16 | 13/16 | 0.543 |
| `semantic` | `e5` | 10.9 ms | 573 | 5/16 | 12/16 | 14/16 | 0.526 |
| `semantic` | `auto-balanced` | 11.4 ms | 596 | 2/16 | 11/16 | 13/16 | 0.417 |
| `semantic` | `auto-speed` | 9.3 ms | 611 | 2/16 | 10/16 | 13/16 | 0.411 |
| `hybrid` | `e5` | 21.0 ms | 562 | 5/16 | 10/16 | 12/16 | 0.497 |
| `hybrid` | `auto-balanced` | 24.0 ms | 565 | 4/16 | 11/16 | 15/16 | 0.502 |
| `hybrid` | `auto-speed` | 21.5 ms | 577 | 4/16 | 10/16 | 15/16 | 0.486 |

## Reading the results

- The gain is on indexing time. Search latency is similar across policies.
- In pure `semantic` mode `auto-speed` and `auto-balanced` put an expected file
  first less often than `e5`. In `hybrid` mode they find more expected files in
  the first ten results (15/16 against 12/16), with a similar MRR.
- A search response weighs about 140 to 150 tokens whatever the policy, so the
  embedding model does not change the token cost of a response.

## Limitations

- 16 queries whose expected files were chosen by the author; one corpus, mostly
  code. Indicative only.
- One cold run per policy for indexing; no confidence interval.
- Tokens are estimated, not counted by a tokenizer.
- Machine-readable data: [embedding-policies.json](embedding-policies.json).
