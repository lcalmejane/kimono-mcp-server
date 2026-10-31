# Kimono benchmark database

Anyone can re-run the Kimono benchmarks with another LLM or client and add the
result to a shared set of JSON records. Each record is one campaign, validated
against a schema and listed in an index. No LLM is called by the database tooling.

| File | Role |
| --- | --- |
| [`benchmarks/db/records/<id>.json`](../benchmarks/db/records/) | One record per campaign (what you contribute) |
| [`benchmarks/db/record.schema.json`](../benchmarks/db/record.schema.json) | JSON Schema of a record |
| [`benchmarks/db/index.json`](../benchmarks/db/index.json) | Generated list of records and per-client/model medians |
| [`benchmarks/external-template.json`](../benchmarks/external-template.json) | Campaign configuration for any client |
| [`benchmarks/adapters/adapter-template.mjs`](../benchmarks/adapters/adapter-template.mjs) | Adapter skeleton to wire a client |

Two kinds of records exist:

- `harness`: an LLM client run on the same tasks with and without Kimono.
- `embedding`: embedding policies compared without any LLM
  (`scripts/bench-embedding.mjs`).

The human-readable reports in [`benchmarks/results/`](../benchmarks/results/) are
older summaries of the same data; the database is the machine-readable source.

## Contribute a run with another LLM

1. **Prepare the environment.** Node.js 24, Docker, and an image of the Kimono
   server (build it from this repository, or replace `tatami-core-kimono` in the
   configuration with a published image). Copy the embedding models into
   `.bench-models/` at the root of `kimono-mcp-server` (ignored by Git) as described in
   [harness-benchmark.md](harness-benchmark.md#rejouer-les-mesures-autre-llm-autre-machine).
2. **Copy the template.** `cp benchmarks/external-template.json my-run.json`, then
   set `model` to the exact model id and, if useful, `repetitions` (3 or more is
   needed for a pair to be eligible for a claim).
3. **Wire your client.** Copy `benchmarks/adapters/adapter-template.mjs`, implement
   `runClient()` and point `harness.command`/`args` of your configuration to it.
   The adapter must start a fresh session, allow only read/search tools (plus the
   Kimono MCP in the `with` variant), and report observed values only. The
   contract is documented in
   [harness-benchmark.md](harness-benchmark.md#ajouter-un-autre-harnais).
4. **Check without spending anything.**
   `npm run bench:harness -- my-run.json /path/to/out --dry-run` validates the
   configuration and prepares the corpus without calling the model.
5. **Run.** `npm run bench:harness -- my-run.json /path/to/out` (the output
   directory must not exist). Cells run with a time limit and fail loudly.
6. **Review the answers.** Open `answer.txt` and `review.json` in each cell
   directory, fill in `review.json`, then `npm run bench:harness -- --summarize
   /path/to/out`. Skipping the review keeps the record `exploratory`.
7. **Import.**

   ```sh
   npm run bench:db -- import-harness /path/to/out \
     --id claude-code-sonnet-20261101 \
     --contributor "Your name" --contact "https://github.com/you" \
     --harness "Claude Code" --model claude-sonnet-5.5 \
     --note "inputTokens excludes cache reads" \
     --limitation "Single run per cell."
   ```

   Several output directories can be passed to gather runs in one record. Useful
   options: `--harness-version`, `--provider`, `--arm-without`, `--arm-with`,
   `--kimono-version`, `--created-at`, `--force`.
8. **Validate and open a pull request.** `npm run bench:db:check` must pass. Commit
   the new file in `benchmarks/db/records/` and the regenerated `index.json`.

For an embedding comparison, run `node scripts/bench-embedding.mjs ...` and import
its `results.json`:

```sh
npm run bench:db -- import-embedding /path/to/results.json \
  --id embedding-policies-20261101 --contributor "Your name" \
  --corpus-description "What was indexed"
```

## What a record contains

- `llm`: client, client version, model, provider and notes (for example whether
  `inputTokens` includes cache reads, which differs between providers).
- `arms`: what `without` and `with` mean in this campaign.
- `environment` and `kimono`: OS, architecture, Node.js, Kimono commit, image,
  embedding policy, index mode and runtime hash when known.
- `corpus`: SHA-256, file count and size, so results on the same corpus can be
  compared.
- `cells`: one entry per task, repetition and variant, with elapsed time, token
  counters (`null` when the client does not expose them), tool calls, whether
  Kimono was actually called, isolation result and automatic quality checks.
- `pairs`: derived with/without comparison. Negative percentages mean the Kimono
  arm used less. `eligibleForClaim` stays `false` with the reasons until the
  rules in [harness-benchmark.md](harness-benchmark.md) are met.
- `status`: `exploratory`, or `reviewed` when a human review passed on every
  successful cell.
- `limitations`: at least one statement a reader needs to interpret the figures.

## What validation checks

`npm run bench:db:check` (also run by the test suite) rejects a record when:

- it does not match the schema, or its `id` does not match the file name;
- a with/without percentage does not match the cells it summarizes;
- a pair claims to be eligible while it has reasons or a failed cell;
- the status is `reviewed` without a passed human review on every OK cell;
- it contains machine-specific paths (`/Users/...`, `/tmp/...`) or secret-like
  tokens;
- `index.json` is out of date (run `npm run bench:db -- index`).

Compare counters across providers only after checking what they mean. A record
documents its own figures; it is not a ranking of models.
