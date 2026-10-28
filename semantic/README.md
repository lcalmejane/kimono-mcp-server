# Native semantic runtime

`kimono-semantic` uses the pinned `embsearch-core` ONNX embedder. Its model,
tokenizer, prefixes, normalization, token limit and 500-character chunking are
unchanged by execution tuning.

## CPU-limited deployments

The helper initializes ONNX Runtime's global thread pool **before** constructing
any embedder. Upstream `OnnxEmbedder::from_dir` constructs a default session,
which inherits this pool. Intra-op inference uses one thread by default;
inter-op parallelism is one and worker spinning is disabled. Auto CPU workers
use up to 80% of Rust's available CPU allocation (at least one, up to 32),
reduced to fit the estimated RAM budget. This avoids the default physical-core-sized
per-session pool competing for a much smaller Docker CPU quota. For example,
a container can expose 14 CPUs while `cpu.max` allows only two.

Set `KIMONO_SEMANTIC_THREADS` to an integer from 1 through 32 to explicitly tune
intra-op inference for a deployment. Invalid explicit values fail startup rather
than silently falling back. This is a process-wide setting; no dependency patch
or ONNX model conversion is needed.

`KIMONO_SEMANTIC_CPU_PERCENT` and `KIMONO_SEMANTIC_MEMORY_PERCENT` default to 80
and accept integers 1–100. RAM is sampled for each native operation using host
available memory and visible Linux cgroup memory headroom. Session estimates
include expanded weights, tokenizer and overhead; passage estimates include
hidden states and attention at the model token cap. Auto batches use remaining
estimated RAM, within 1–256 passages. `KIMONO_SEMANTIC_WORKERS`,
`KIMONO_SEMANTIC_THREADS` and `KIMONO_SEMANTIC_BATCH` accept explicit values or
`auto`; explicit sessions/batches that cannot fit the estimated memory budget fail.
Accelerators retain one session and use host RAM for batch sizing, not measured
VRAM. Budgets are per process, not shared across projects, and are not hard OS
limits. The growing index and other allocations are not fully predicted.
`runtime.resources` reports sizing inputs and estimates. More workers/bigger
batches do not guarantee higher throughput.

## Progress and validation

Stderr emits `KIMONO_PROGRESS` JSON objects. `model_loading` and `model_loaded`
phases use `completed: 0, total: 0` (unknown work, not completed indexing).
`document_embedding` retains chunk-based `completed` and `total` counters.
The loaded-model event and embedding batch events include phase-local
`elapsedMs`. Stdout remains the single JSON response.

With Rust and the configured ONNX dynamic library available:

```sh
ORT_SKIP_DOWNLOAD=1 cargo build --release --locked
ORT_SKIP_DOWNLOAD=1 cargo test --locked
```

Compare fresh, isolated caches using identical `rebuild` requests when measuring
throughput. Reusing an existing generation measures cache reuse, not embedding.
Do not replace an active service binary or its cache for a benchmark.
