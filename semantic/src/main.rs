use embsearch_core::{Database, Embedder, Metric, OnnxEmbedder};
mod device;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::time::Instant;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn bounded_setting(name: &str, value: Option<&str>, default: usize, max: usize) -> Result<usize> {
    match value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto")
    {
        None => Ok(default),
        Some(value) => match value.parse::<usize>() {
            Ok(value) if (1..=max).contains(&value) => Ok(value),
            _ => Err(format!("{name} must be auto or an integer between 1 and {max}").into()),
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Runtime {
    workers: usize,
    threads: usize,
    batch: usize,
}

fn requested_device(value: Option<&str>) -> Result<&str> {
    let value = value.unwrap_or("auto");
    match value {
        "auto" | "cpu" | "cuda" | "coreml" => Ok(value),
        _ => Err("KIMONO_SEMANTIC_DEVICE must be auto, cpu, cuda or coreml".into()),
    }
}

// available_parallelism honours cgroup CPU quotas, so Docker `cpus:` limits apply.
fn runtime_settings(available: usize, var: impl Fn(&str) -> Option<String>) -> Result<Runtime> {
    let available = available.max(1);
    // One session by default avoids duplicating model weights across automatic workers.
    let workers = bounded_setting(
        "KIMONO_SEMANTIC_WORKERS",
        var("KIMONO_SEMANTIC_WORKERS").as_deref(),
        1,
        32,
    )?;
    let threads = bounded_setting(
        "KIMONO_SEMANTIC_THREADS",
        var("KIMONO_SEMANTIC_THREADS").as_deref(),
        (available / workers).clamp(1, 2),
        32,
    )?;
    let batch = bounded_setting(
        "KIMONO_SEMANTIC_BATCH",
        var("KIMONO_SEMANTIC_BATCH").as_deref(),
        8,
        256,
    )?;
    Ok(Runtime {
        workers,
        threads,
        batch,
    })
}

fn configure_runtime(device: &str) -> Result<Runtime> {
    let mut runtime = runtime_settings(
        std::thread::available_parallelism().map_or(1, |count| count.get()),
        |name| std::env::var(name).ok(),
    )?;
    let providers = device::providers(device)?;
    if device != "cpu" {
        // Multiple model sessions contend for one accelerator and duplicate device allocations.
        runtime.workers = 1;
    }
    // ONNX Runtime parallelises poorly inside one small-model run; throughput
    // comes from independent sessions (workers), each with a small intra pool.
    let options = ort::environment::GlobalThreadPoolOptions::default()
        .with_intra_threads(runtime.threads)?
        .with_inter_threads(1)?
        .with_spin_control(false)?;
    ort::init()
        .with_execution_providers(providers)
        .with_global_thread_pool(options)
        .commit()?;
    eprintln!(
        "KIMONO_PROGRESS {}",
        serde_json::json!({"phase":"runtime_configured",
        "completed":0, "total":0, "executionProvider":device,
        "workers":runtime.workers, "threads":runtime.threads, "batch":runtime.batch})
    );
    Ok(runtime)
}

// A `None` vector means the passage could not be embedded: it is traced and skipped.
fn embedding_batches(texts: &[&str], batch: usize) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..texts.len()).collect();
    order.sort_by_key(|&index| texts[index].len());
    let sorted: Vec<_> = order.chunks(batch).map(<[usize]>::to_vec).collect();
    // Alternate short/long batches: keep padding low without making every later batch slower.
    let mut balanced = Vec::with_capacity(sorted.len());
    let (mut left, mut right) = (0, sorted.len());
    while left < right {
        balanced.push(sorted[left].clone());
        left += 1;
        if left < right {
            right -= 1;
            balanced.push(sorted[right].clone());
        }
    }
    balanced
}

fn embed_parallel<E: Embedder>(
    primary: &E,
    runtime: Runtime,
    texts: &[&str],
    factory: impl Fn() -> Result<E> + Sync,
    mut consume: impl FnMut(usize, Option<Vec<f32>>) -> Result<()>,
) -> Result<()> {
    let total = texts.len();
    let started = Instant::now();
    let batches = embedding_batches(texts, runtime.batch);
    let workers = runtime.workers.min(batches.len()).max(1);
    eprintln!(
        "KIMONO_PROGRESS {}",
        serde_json::json!({"phase": "document_embedding", "completed": 0,
        "total": total, "workers": workers, "batch": runtime.batch, "threads": runtime.threads})
    );
    if total == 0 {
        return Ok(());
    }
    let next = AtomicUsize::new(0);
    let completed = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    // Backpressure bounds queued vectors to one batch per worker, not the entire corpus.
    let (sender, receiver) = sync_channel(workers);
    std::thread::scope(|scope| -> std::result::Result<(), String> {
        let handles: Vec<_> = (0..workers).map(|worker| {
            let (next, completed, failed, batches, factory) = (&next, &completed, &failed, &batches, &factory);
            let sender = sender.clone();
            scope.spawn(move || -> std::result::Result<(), String> {
                let outcome = (|| -> std::result::Result<(), String> {
                    let owned;
                    let embedder = if worker == 0 {
                        primary
                    } else {
                        owned = factory().map_err(|error| error.to_string())?;
                        &owned
                    };
                    while !failed.load(Ordering::Relaxed) {
                        let Some(batch) = batches.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                        let input: Vec<String> = batch.iter().map(|&index| texts[index].to_string()).collect();
                        let batch_started = Instant::now();
                        let usable = |vector: &Vec<f32>| vector.len() == embedder.dim()
                            && vector.iter().all(|value| value.is_finite())
                            && vector.iter().any(|value| *value != 0.0);
                        let vectors: Vec<Option<Vec<f32>>> = match embedder.embed_batch(&input) {
                            Ok(vectors) if vectors.len() == batch.len() =>
                                vectors.into_iter().map(|vector| Some(vector).filter(usable)).collect(),
                            // One bad passage must not discard the batch: retry each one alone.
                            _ => input.iter().map(|text| match embedder.embed_batch(std::slice::from_ref(text)) {
                                Ok(mut single) if single.len() == 1 => single.pop().filter(usable),
                                Ok(_) => None,
                                Err(error) => {
                                    eprintln!("kimono-semantic: passage not embeddable: {error}");
                                    None
                                }
                            }).collect(),
                        };
                        sender.send(batch.iter().copied().zip(vectors).collect::<Vec<_>>())
                            .map_err(|_| "Embedding result consumer closed")?;
                        let done = completed.fetch_add(batch.len(), Ordering::Relaxed) + batch.len();
                        eprintln!("KIMONO_PROGRESS {}", serde_json::json!({
                            "phase": "document_embedding", "completed": done, "total": total,
                            "workers": workers, "batch": runtime.batch, "threads": runtime.threads,
                            "batchMs": batch_started.elapsed().as_millis(),
                            "elapsedMs": started.elapsed().as_millis()
                        }));
                    }
                    Ok(())
                })();
                if outcome.is_err() {
                    failed.store(true, Ordering::Relaxed);
                }
                outcome
            })
        }).collect();
        drop(sender);
        let mut first = Ok(());
        for batch in receiver {
            for (index, vector) in batch {
                if first.is_ok() {
                    if let Err(error) = consume(index, vector) {
                        failed.store(true, Ordering::Relaxed);
                        first = Err(error.to_string());
                    }
                }
            }
        }
        for handle in handles {
            let outcome = handle
                .join()
                .unwrap_or_else(|_| Err("Embedding worker panicked".into()));
            if first.is_ok() {
                first = outcome;
            }
        }
        first
    })?;
    Ok(())
}

fn load_embedder(model: &Path) -> Result<OnnxEmbedder> {
    let started = Instant::now();
    eprintln!(
        "KIMONO_PROGRESS {}",
        serde_json::json!({
            "phase": "model_loading", "completed": 0, "total": 0
        })
    );
    let embedder = OnnxEmbedder::from_dir(model)?;
    eprintln!(
        "KIMONO_PROGRESS {}",
        serde_json::json!({
            "phase": "model_loaded", "completed": 0, "total": 0,
            "elapsedMs": started.elapsed().as_millis()
        })
    );
    Ok(embedder)
}

#[derive(Deserialize)]
struct Document {
    path: String,
    kind: String,
    content: String,
}

#[derive(Deserialize)]
struct Request {
    operation: String,
    model: PathBuf,
    #[serde(default)]
    cache: PathBuf,
    #[serde(default)]
    documents: Vec<Document>,
    text: Option<String>,
    usage: Option<String>,
    query: Option<String>,
    vector: Option<Vec<f32>>,
    #[serde(rename = "embeddingModel")]
    embedding_model: Option<String>,
    kind: Option<String>,
    limit: Option<usize>,
    paths: Option<Vec<String>>,
    #[serde(rename = "syncPaths")]
    sync_paths: Option<Vec<String>>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct Chunk {
    path: String,
    kind: String,
    line: usize,
    text: String,
    hash: String,
}

#[derive(Default, Deserialize, Serialize)]
struct State {
    generation: String,
    chunks: BTreeMap<String, Chunk>,
    model: String,
    #[serde(default)]
    documents: BTreeMap<String, String>,
}

#[derive(Serialize)]
struct Hit {
    path: String,
    line: usize,
    score: f32,
    excerpt: String,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialized_hash(value: &impl Serialize) -> Result<String> {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value)?;
    Ok(format!("{:x}", writer.0.finalize()))
}

fn chunks(documents: Vec<Document>) -> BTreeMap<String, Chunk> {
    let mut result = BTreeMap::new();
    for document in documents {
        let mut text = String::new();
        let mut start = 1;
        let mut ordinal = 0;
        // Bound Unicode passages; the tokenizer independently caps tokens.
        let mut emit = |text: &mut String, line: usize| {
            if text.trim().is_empty() {
                text.clear();
                return;
            }
            let id = format!("{}#{ordinal}", document.path);
            ordinal += 1;
            result.insert(
                id,
                Chunk {
                    path: document.path.clone(),
                    kind: document.kind.clone(),
                    line,
                    hash: hash(text.as_bytes()),
                    text: std::mem::take(text),
                },
            );
        };
        for (line, value) in document.content.lines().enumerate() {
            for piece in value.chars().collect::<Vec<_>>().chunks(499) {
                let piece: String = piece.iter().collect();
                if text.chars().count() + piece.chars().count() + 1 > 500 {
                    emit(&mut text, start);
                }
                if text.is_empty() {
                    start = line + 1;
                }
                text.push_str(&piece);
                text.push('\n');
            }
        }
        emit(&mut text, start);
    }
    result
}

fn read_state(cache: &Path) -> Result<State> {
    match fs::File::open(cache.join("state.json")) {
        Ok(file) => Ok(serde_json::from_reader(BufReader::new(file))?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(error) => Err(error.into()),
    }
}

/// Shares one model session between the embedding pipeline and the index, so
/// each vector batch is inserted as soon as it is produced (no disk spool).
struct SharedEmbedder<E>(Arc<E>);

impl<E: Embedder> Embedder for SharedEmbedder<E> {
    fn dim(&self) -> usize {
        self.0.dim()
    }
    fn model_id(&self) -> &str {
        self.0.model_id()
    }
    fn embed(&self, text: &str) -> embsearch_core::Result<Vec<f32>> {
        self.0.embed(text)
    }
    fn embed_batch(&self, texts: &[String]) -> embsearch_core::Result<Vec<Vec<f32>>> {
        self.0.embed_batch(texts)
    }
    fn embed_query(&self, text: &str) -> embsearch_core::Result<Vec<f32>> {
        self.0.embed_query(text)
    }
    fn embed_query_batch(&self, texts: &[String]) -> embsearch_core::Result<Vec<Vec<f32>>> {
        self.0.embed_query_batch(texts)
    }
}

fn runtime_info(runtime: Runtime, selection: &device::Selection) -> serde_json::Value {
    serde_json::json!({
        "workers": runtime.workers, "threads": runtime.threads, "batch": runtime.batch,
        "executionProvider": selection.execution_provider,
        "gpuExecutionVerified": selection.gpu_execution_verified,
        "benchmarks": selection.benchmarks,
    })
}

fn execute(
    request: Request,
    runtime: Runtime,
    selection: &device::Selection,
) -> Result<serde_json::Value> {
    let runtime_info = runtime_info(runtime, selection);
    if request.operation == "info" {
        let embedder = load_embedder(&request.model)?;
        let spec = embedder.spec();
        let mut files = BTreeMap::new();
        for file in ["model.onnx", "tokenizer.json", "model.json"] {
            let mut writer = HashWriter(Sha256::new());
            std::io::copy(&mut fs::File::open(request.model.join(file))?, &mut writer)?;
            files.insert(file, format!("{:x}", writer.0.finalize()));
        }
        return Ok(serde_json::json!({
            "engine": "embsearch-core", "version": "0.3.4",
            "model": embedder.model_id(), "name": spec.name,
            "dimensions": embedder.dim(), "normalized": spec.normalize,
            "maxTokens": spec.max_tokens, "pooling": spec.pooling,
            "queryPrefix": spec.query_prefix, "documentPrefix": spec.document_prefix,
            "sha256": files,
            "runtime": runtime_info,
            "compatibility": "Reuse model as embeddingModel for vector search. Dimensions and model labels alone cannot prove vector provenance; retain these file hashes and matching preprocessing settings to reproduce embeddings."
        }));
    }
    if request.operation == "embed" {
        let text = request.text.as_deref().ok_or("text is required")?;
        if text.trim().is_empty() || text.len() > 32768 {
            return Err("text must be non-empty and at most 32768 UTF-8 bytes".into());
        }
        let usage = request.usage.as_deref().unwrap_or("query");
        if !["query", "document"].contains(&usage) {
            return Err("usage must be query or document".into());
        }
        let embedder = load_embedder(&request.model)?;
        let vector = if usage == "query" {
            embedder.embed_query(text)?
        } else {
            embedder.embed(text)?
        };
        if vector.len() != embedder.dim() || vector.iter().any(|value| !value.is_finite()) {
            return Err("Invalid embedding vector".into());
        }
        return Ok(serde_json::json!({
            "engine": "embsearch-core", "version": "0.3.4",
            "model": embedder.model_id(), "usage": usage,
            "dimensions": embedder.dim(), "normalized": embedder.spec().normalize,
            "maxTokens": embedder.spec().max_tokens, "vector": vector
            , "runtime": runtime_info
        }));
    }
    if !["search", "update", "rebuild", "compact", "stats"].contains(&request.operation.as_str()) {
        return Err("Invalid semantic operation".into());
    }
    let limit = request.limit.unwrap_or(25);
    if !(1..=101).contains(&limit) {
        return Err("limit must be 1-101 (including the server look-ahead)".into());
    }
    if request.operation == "search" {
        if request.vector.is_some() {
            if request.query.is_some() {
                return Err("Provide exactly one of query or vector".into());
            }
        } else if request.query.as_deref().unwrap_or("").trim().is_empty() {
            return Err("search query must not be empty".into());
        }
    }
    fs::create_dir_all(&request.cache)?;
    let previous = read_state(&request.cache)?;
    if !previous.generation.is_empty() && !valid_generation(&previous.generation) {
        return Err("Invalid semantic generation in state".into());
    }
    // Include weights + tokenizer in identity, not just the model's friendly name.
    let mut identity = HashWriter(Sha256::new());
    for file in ["model.onnx", "tokenizer.json", "model.json"] {
        std::io::copy(
            &mut fs::File::open(request.model.join(file))?,
            &mut identity,
        )?;
    }
    let fingerprint = format!("{:x}", identity.0.finalize());
    let embedder = Arc::new(load_embedder(&request.model)?);
    let model_id = embedder.model_id().to_string();
    let search_vector = if let Some(vector) = &request.vector {
        if request.embedding_model.as_deref() != Some(model_id.as_str()) {
            return Err("embeddingModel must exactly match the active model identifier returned by aikido_embed; dimensions alone do not establish compatibility".into());
        }
        if vector.len() != embedder.dim()
            || vector.iter().any(|value| !value.is_finite())
            || !vector.iter().any(|value| value.is_normal())
        {
            return Err(format!(
                "vector must contain {} finite float32 values with non-zero norm",
                embedder.dim()
            )
            .into());
        }
        // Normalize in f64 so valid large/small float32 vectors do not
        // overflow/underflow the index's float32 sum-of-squares.
        let norm = vector
            .iter()
            .map(|value| (*value as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        Some(
            vector
                .iter()
                .map(|value| (*value as f64 / norm) as f32)
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };
    if request.sync_paths.is_some() && request.operation != "update" {
        return Err("syncPaths requires update".into());
    }
    if request.sync_paths.is_some()
        && previous.model != fingerprint
        && !previous.generation.is_empty()
    {
        return Err(
            "Embedding model changed; run a full update before targeted synchronization".into(),
        );
    }
    let selected = |file: &str| {
        request.sync_paths.as_ref().is_none_or(|paths| {
            paths
                .iter()
                .any(|scope| file == scope || file.starts_with(&format!("{scope}/")))
        })
    };
    let mut previous_documents = previous.documents;
    // Migration from v0.2 state: hashes are unknown until each file is reread.
    for chunk in previous.chunks.values() {
        previous_documents.entry(chunk.path.clone()).or_default();
    }
    let mut documents: BTreeMap<String, String> = previous_documents
        .iter()
        .filter(|(file, _)| !selected(file))
        .map(|(file, hash)| (file.clone(), hash.clone()))
        .collect();
    for document in &request.documents {
        if !selected(&document.path) {
            return Err("Document outside synchronization scope".into());
        }
        documents.insert(document.path.clone(), hash(document.content.as_bytes()));
    }
    let added: Vec<_> = documents
        .keys()
        .filter(|file| !previous_documents.contains_key(*file))
        .cloned()
        .collect();
    let modified: Vec<_> = documents
        .iter()
        .filter(|(file, digest)| {
            previous_documents
                .get(*file)
                .is_some_and(|old| old != *digest)
        })
        .map(|(file, _)| file.clone())
        .collect();
    let deleted: Vec<_> = previous_documents
        .keys()
        .filter(|file| !documents.contains_key(*file))
        .cloned()
        .collect();
    let previous_chunk_signature = serialized_hash(&previous.chunks)?;
    let previous_hashes: BTreeMap<_, _> = previous
        .chunks
        .iter()
        .map(|(id, chunk)| (id.clone(), chunk.hash.clone()))
        .collect();
    let mut current: BTreeMap<String, Chunk> = previous
        .chunks
        .into_iter()
        .filter(|(_, chunk)| !selected(&chunk.path))
        .collect();
    current.extend(chunks(request.documents));
    let reuse = previous.model == fingerprint
        && !previous.generation.is_empty()
        && request.operation != "rebuild";
    let updates: Vec<_> = current
        .iter()
        .filter(|(id, chunk)| !reuse || previous_hashes.get(*id) != Some(&chunk.hash))
        .collect();
    let texts: Vec<&str> = updates
        .iter()
        .map(|(_, chunk)| chunk.text.as_str())
        .collect();
    // The index is built in memory and only persisted after full success, so an
    // interrupted run leaves the published generation untouched.
    let mut db = if reuse {
        Database::open(
            SharedEmbedder(Arc::clone(&embedder)),
            request.cache.join(&previous.generation),
        )?
    } else {
        Database::new(SharedEmbedder(Arc::clone(&embedder)), Metric::Cosine)
    };
    let mut changed = !reuse;
    let mut embedded = 0;
    let mut failed: Vec<String> = Vec::new();
    // Each bounded batch goes straight into the index: no temporary vector file
    // grows on disk and consumed vectors are released immediately.
    embed_parallel(
        &*embedder,
        runtime,
        &texts,
        || Ok(OnnxEmbedder::from_dir(&request.model)?),
        |index, vector| {
            let id = updates[index].0;
            match vector {
                Some(vector) => {
                    if reuse {
                        db.remove(id)?;
                    }
                    db.add_vector(id, vector)?;
                    changed = true;
                    embedded += 1;
                }
                None => failed.push(id.to_string()),
            }
            Ok(())
        },
    )?;
    drop(updates);
    // Ignored passages are traced and left out; they are retried on the next update.
    for id in &failed {
        eprintln!("kimono-semantic: chunk ignored (embedding failed): {id}");
        current.remove(id);
    }
    // Skipping isolated passages is tolerated; a systemic failure (model/runtime) is not.
    if embedded == 0 && !failed.is_empty() {
        return Err(format!(
            "None of the {} passages could be embedded; check the model and ONNX runtime",
            failed.len()
        )
        .into());
    }
    if reuse {
        for id in previous_hashes
            .keys()
            .filter(|id| !current.contains_key(*id))
        {
            db.remove(id)?;
            changed = true;
        }
    }
    if request.operation == "compact" {
        db.compact();
        changed = true;
    }
    let mut generation = previous.generation.clone();
    if changed
        || documents != previous_documents
        || serialized_hash(&current)? != previous_chunk_signature
    {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let digest = serialized_hash(&(&fingerprint, &current, nonce))?;
        generation = format!("store-{}", &digest[..24]);
        let temporary = request.cache.join("building");
        if temporary.exists() {
            fs::remove_dir_all(&temporary)?;
        }
        db.save(&temporary)?;
        let destination = request.cache.join(&generation);
        if destination.exists() {
            // An unchanged generation can be reused; never remove the live
            // store before publishing a replacement.
            fs::remove_dir_all(&temporary)?;
        } else {
            fs::rename(temporary, destination)?;
        }
        #[derive(Serialize)]
        struct StateView<'a> {
            generation: &'a str,
            chunks: &'a BTreeMap<String, Chunk>,
            model: &'a str,
            documents: &'a BTreeMap<String, String>,
        }
        let state = StateView {
            generation: &generation,
            chunks: &current,
            model: &fingerprint,
            documents: &documents,
        };
        let mut writer = BufWriter::new(fs::File::create(request.cache.join("state.pending"))?);
        serde_json::to_writer(&mut writer, &state)?;
        writer.flush()?;
        drop(writer);
        fs::rename(
            request.cache.join("state.pending"),
            request.cache.join("state.json"),
        )?;
        if !previous.generation.is_empty() && previous.generation != generation {
            // Only remove the precise previous generation produced by this helper.
            if valid_generation(&previous.generation) {
                fs::remove_dir_all(request.cache.join(previous.generation))?;
            }
        }
    }
    let mut hits = Vec::new();
    if request.operation == "search" {
        // Filter before limiting: a kind filter must not lose its best matches
        // merely because another kind occupied the global top-k.
        let candidates = if db.len() == 0 {
            Vec::new()
        } else {
            if let Some(vector) = &search_vector {
                db.query_vector(vector, db.len())?
            } else {
                db.query(request.query.as_deref().unwrap(), db.len())?
            }
        };
        for hit in candidates {
            let chunk = current
                .get(&hit.id)
                .ok_or("Index returned an unknown chunk")?;
            if request
                .kind
                .as_ref()
                .is_some_and(|kind| kind != &chunk.kind)
            {
                continue;
            }
            if request
                .paths
                .as_ref()
                .is_some_and(|paths| !paths.contains(&chunk.path))
            {
                continue;
            }
            hits.push(Hit {
                path: chunk.path.clone(),
                line: chunk.line,
                score: hit.score,
                excerpt: chunk.text.clone(),
            });
            if hits.len() == limit {
                break;
            }
        }
    }
    Ok(serde_json::json!({
        "engine": "embsearch-core", "version": "0.3.4", "model": model_id,
        "chunks": db.len(), "embedded": embedded, "skippedChunks": failed.len(), "generation": generation,
        "runtime": runtime_info,
        "count": hits.len(), "results": hits,
        "changes": { "added": added, "modified": modified, "deleted": deleted }
    }))
}

fn valid_generation(value: &str) -> bool {
    value.starts_with("store-")
        && value.len() == 30
        && value[6..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn main() {
    let result = (|| -> Result<()> {
        let path = std::env::args()
            .nth(1)
            .ok_or("Expected a JSON request file")?;
        if path == "--benchmark" {
            let model = std::env::args()
                .nth(2)
                .ok_or("Expected a model directory")?;
            let device = std::env::var("KIMONO_SEMANTIC_DEVICE")?;
            if requested_device(Some(&device))? == "auto" {
                return Err("Benchmark requires an explicit provider".into());
            }
            let runtime = configure_runtime(&device)?;
            println!(
                "{}",
                serde_json::to_string(&device::benchmark(Path::new(&model), runtime, &device)?)?
            );
            return Ok(());
        }
        let request: Request = serde_json::from_reader(BufReader::new(fs::File::open(path)?))?;
        let selection = device::select(&request.model)?;
        let runtime = configure_runtime(&selection.execution_provider)?;
        eprintln!(
            "KIMONO_PROGRESS {}",
            serde_json::json!({
                "phase":"runtime_configured", "completed":0, "total":0,
                "runtime": runtime_info(runtime, &selection)
            })
        );
        let output = execute(request, runtime, &selection)?;
        println!("{}", serde_json::to_string(&output)?);
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("kimono-semantic: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_settings_are_bounded_and_validate_explicit_values() {
        assert_eq!(bounded_setting("threads", None, 2, 32).unwrap(), 2);
        assert_eq!(bounded_setting("threads", Some("auto"), 2, 32).unwrap(), 2);
        for value in [1, 2, 8, 32] {
            assert_eq!(
                bounded_setting("threads", Some(&value.to_string()), 2, 32).unwrap(),
                value
            );
        }
        for value in ["0", "33", "-1", "many", "1.5"] {
            assert!(bounded_setting("threads", Some(value), 2, 32).is_err());
        }
        let none = |_: &str| None;
        assert_eq!(
            runtime_settings(2, none).unwrap(),
            Runtime {
                workers: 1,
                threads: 2,
                batch: 8
            }
        );
        assert_eq!(
            runtime_settings(14, none).unwrap(),
            Runtime {
                workers: 1,
                threads: 2,
                batch: 8
            }
        );
        assert_eq!(
            runtime_settings(1, none).unwrap(),
            Runtime {
                workers: 1,
                threads: 1,
                batch: 8
            }
        );
        let explicit = |name: &str| {
            Some(
                match name {
                    "KIMONO_SEMANTIC_WORKERS" => "3",
                    "KIMONO_SEMANTIC_THREADS" => "2",
                    _ => "64",
                }
                .to_string(),
            )
        };
        assert_eq!(
            runtime_settings(14, explicit).unwrap(),
            Runtime {
                workers: 3,
                threads: 2,
                batch: 64
            }
        );
        assert!(
            runtime_settings(4, |name: &str| (name == "KIMONO_SEMANTIC_BATCH")
                .then(|| "257".to_string()))
            .is_err()
        );
    }

    #[test]
    fn chunks_are_bounded_and_keep_source_lines() {
        let result = chunks(vec![Document {
            path: "prompts/doc.md".into(),
            kind: "knowledge".into(),
            content: format!("{}\nsecond line\n", "é".repeat(700)),
        }]);
        assert!(result.len() >= 2);
        assert!(result
            .values()
            .all(|chunk| chunk.text.chars().count() <= 500));
        assert!(result.values().all(|chunk| chunk.line > 0));
        let lines = chunks(vec![Document {
            path: "lines.md".into(),
            kind: "knowledge".into(),
            content: format!("{}\nsecond line\n", "a".repeat(499)),
        }]);
        assert!(lines
            .values()
            .any(|chunk| chunk.text.contains("second line") && chunk.line == 2));
    }

    #[test]
    fn rejects_generation_path_traversal() {
        assert!(valid_generation("store-0123456789abcdef01234567"));
        assert!(!valid_generation("store-../../private"));
        assert!(!valid_generation("../store-0123456789abcdef01234567"));
        assert!(!valid_generation("store-0123456789abcdef0123456g"));
    }

    #[test]
    fn batches_cover_input_once_and_balance_lengths() {
        let owned: Vec<_> = (1..=35).map(|size| "x".repeat(size)).collect();
        let input: Vec<_> = owned.iter().map(String::as_str).collect();
        let batches = embedding_batches(&input, 8);
        assert_eq!(
            batches.iter().map(|batch| batch[0]).collect::<Vec<_>>(),
            vec![0, 32, 8, 24, 16]
        );
        assert!(batches
            .iter()
            .all(|batch| !batch.is_empty() && batch.len() <= 8));
        let mut indices: Vec<_> = batches.into_iter().flatten().collect();
        indices.sort();
        assert_eq!(indices, (0..35).collect::<Vec<_>>());
        assert!(embedding_batches(&[], 8).is_empty());
    }

    #[test]
    fn bounded_pipeline_consumes_each_result_and_propagates_failures() {
        use embsearch_core::MockEmbedder;
        let runtime = Runtime {
            workers: 3,
            threads: 1,
            batch: 2,
        };
        let primary = MockEmbedder::new(8);
        let mut received = BTreeMap::new();
        embed_parallel(
            &primary,
            runtime,
            &["a", "bb", "ccc", "dddd", "ee", "f"],
            || Ok(MockEmbedder::new(8)),
            |index, vector| {
                assert_eq!(vector.unwrap().len(), 8);
                assert!(received.insert(index, ()).is_none());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(received.len(), 6);
        let error = embed_parallel(
            &primary,
            runtime,
            &["a"; 64],
            || Ok(MockEmbedder::new(8)),
            |_, _| Err("spool write failed".into()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("spool write failed"));
        let error = embed_parallel(
            &primary,
            runtime,
            &["a"; 64],
            || Err("session creation failed".into()),
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("session creation failed"));
        embed_parallel(
            &primary,
            runtime,
            &[],
            || Err("must not load".into()),
            |_, _| Err("must not consume".into()),
        )
        .unwrap();
    }

    #[test]
    fn serialized_hash_matches_previous_buffered_hash() {
        let value = chunks(vec![Document {
            path: "a.md".into(),
            kind: "knowledge".into(),
            content: "a\nb".into(),
        }]);
        assert_eq!(
            serialized_hash(&value).unwrap(),
            hash(&serde_json::to_vec(&value).unwrap())
        );
    }

    #[test]
    fn batches_are_indexed_directly_without_temporary_vector_files() {
        use embsearch_core::MockEmbedder;
        let cache = std::env::temp_dir().join(format!("kimono-direct-{}", std::process::id()));
        fs::create_dir_all(&cache).unwrap();
        let shared = Arc::new(MockEmbedder::new(8));
        let mut db = Database::new(SharedEmbedder(Arc::clone(&shared)), Metric::Cosine);
        let mut inserted = 0;
        let texts: Vec<String> = (0..64).map(|index| format!("passage {index}")).collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let runtime = Runtime {
            workers: 2,
            threads: 1,
            batch: 4,
        };
        embed_parallel(
            &*shared,
            runtime,
            &refs,
            || Ok(MockEmbedder::new(8)),
            |index, vector| {
                if let Some(vector) = vector {
                    db.add_vector(&format!("c{index}"), vector)?;
                    inserted += 1;
                }
                // Inserted progressively, never accumulated in a cache-side file.
                assert_eq!(fs::read_dir(&cache)?.count(), 0);
                Ok(())
            },
        )
        .unwrap();
        assert!(inserted > 0);
        assert_eq!(db.len(), inserted);
        fs::remove_dir_all(&cache).unwrap();
    }
}
