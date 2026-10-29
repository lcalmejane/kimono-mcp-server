# Native semantic runtime

`kimono-semantic` uses the pinned `embsearch-core` ONNX embedder. Its model,
tokenizer, prefixes, normalization and token limit remain part of the index
identity. Chunks stay bounded to 500 characters.

Code files in C, C++, Go, Java, JavaScript, Python, Rust, TypeScript and TSX
use Tree-sitter definition boundaries before the size limit is applied.
Unsupported extensions, files larger than 1 MiB for parsing, and files with
syntax errors use the bounded line/text fallback. Changing the chunker version
invalidates incompatible semantic index generations and requires rebuilding.

## Persistent worker and search lifecycle

The Node server starts one Rust worker per model/runtime configuration. Its
versioned newline-JSON control messages carry a request ID and a private
temporary request-file path; corpus payloads are not placed on the control
pipe. The pipe accepts one active operation at a time, bounds queued work to
eight requests, enforces each request's deadline, and returns a correlated
success or explicit error. Progress remains on stderr. A crash or malformed
response fails the current request; a later request starts a fresh worker.
Normal server shutdown sends `shutdown` and waits briefly before terminating
the child.

The worker loads ONNX Runtime, the model and its measured device selection
once. It retains up to four recent index generations in memory, invalidating
them when the persisted state changes. A fresh semantic search only queries the
stored index; it does not refresh the source or send corpus documents. The
explicit `aikido_index` update remains responsible for source synchronization.
When the index manifest and model profile are complete and compatible, an
update sends only added/changed documents and explicit deletion paths. An
incomplete or incompatible manifest requires a full update; source validation
still reads documents to compute current content hashes.
Search and stats are read-only: they preserve the stored generation and reject
document payloads or a changed model profile that would require reindexing.
A newly captured immutable snapshot with no matching cached generation is
indexed once before its first search.
Snapshot creation, materialization, immutability and lifecycle are unchanged by
the retrieval work.
`aikido_index` status includes the worker lifecycle (`starting`, `ready`,
`error`, `restarting` or `stopped`) when the worker exists in this server
process. This is separate from index readiness: a ready worker can serve more
than one ROOT/index, and an index can be ready on disk while its worker is
stopped.

`KIMONO_SEMANTIC_PERSISTENT_WORKER=false` restores the previous one-process-per-
operation path for rollout rollback. The worker is enabled by default.

Set `KIMONO_CODE_MODEL_DIR` to opt into a second, code-only ONNX profile. It
has its own persisted index and cache identity; text semantic searches query
both profiles and merge ranked passages without combining their vectors.
Explicit vector searches continue to use only the general model identified by
`embeddingModel`. No code model is downloaded implicitly.

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
