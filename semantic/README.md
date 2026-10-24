# Native semantic runtime

`kimono-semantic` uses the pinned `embsearch-core` ONNX embedder. Its model,
tokenizer, prefixes, normalization, token limit and 500-character chunking are
unchanged by execution tuning.

## CPU-limited deployments

The helper initializes ONNX Runtime's global thread pool **before** constructing
any embedder. Upstream `OnnxEmbedder::from_dir` constructs a default session,
which inherits this pool. Intra-op inference uses at most two threads by default
(one if Rust reports only one available CPU); inter-op parallelism is one and
worker spinning is disabled. This avoids the default physical-core-sized
per-session pool competing for a much smaller Docker CPU quota. For example,
a container can expose 14 CPUs while `cpu.max` allows only two.

Set `KIMONO_SEMANTIC_THREADS` to an integer from 1 through 32 to explicitly tune
intra-op inference for a deployment. Invalid explicit values fail startup rather
than silently falling back. This is a process-wide setting; no dependency patch
or ONNX model conversion is needed.

Document embedding still uses batches of eight. Upstream `upsert_batch` already
calls real batched ONNX inference; increasing batch size can increase padding and
memory use and is not assumed to improve CPU throughput.

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
