use embsearch_core::{Database, Embedder, Metric, OnnxEmbedder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn bounded_setting(name: &str, value: Option<&str>, default: usize, max: usize) -> Result<usize> {
    match value.map(str::trim).filter(|value| !value.is_empty() && *value != "auto") {
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

// available_parallelism honours cgroup CPU quotas, so Docker `cpus:` limits apply.
fn runtime_settings(available: usize, var: impl Fn(&str) -> Option<String>) -> Result<Runtime> {
    let available = available.max(1);
    // Each worker holds its own ONNX session and activations (~600 MiB peak):
    // cap the automatic value to stay within the default 4 GiB container limit.
    let workers = bounded_setting("KIMONO_SEMANTIC_WORKERS", var("KIMONO_SEMANTIC_WORKERS").as_deref(),
        available.min(4), 32)?;
    let threads = bounded_setting("KIMONO_SEMANTIC_THREADS", var("KIMONO_SEMANTIC_THREADS").as_deref(),
        (available / workers).clamp(1, 2), 32)?;
    let batch = bounded_setting("KIMONO_SEMANTIC_BATCH", var("KIMONO_SEMANTIC_BATCH").as_deref(), 8, 256)?;
    Ok(Runtime { workers, threads, batch })
}

fn configure_runtime() -> Result<Runtime> {
    let runtime = runtime_settings(
        std::thread::available_parallelism().map_or(1, |count| count.get()),
        |name| std::env::var(name).ok(),
    )?;
    // ONNX Runtime parallelises poorly inside one small-model run; throughput
    // comes from independent sessions (workers), each with a small intra pool.
    let options = ort::environment::GlobalThreadPoolOptions::default()
        .with_intra_threads(runtime.threads)?
        .with_inter_threads(1)?
        .with_spin_control(false)?;
    ort::init().with_global_thread_pool(options).commit()?;
    Ok(runtime)
}

// A `None` vector means the passage could not be embedded: it is traced and skipped.
fn embed_parallel(primary: &OnnxEmbedder, model: &Path, runtime: Runtime, texts: &[&str]) -> Result<Vec<Option<Vec<f32>>>> {
    let total = texts.len();
    let started = Instant::now();
    // Length-sorted bulk batches minimise padding to the longest passage of each batch.
    let mut order: Vec<usize> = (0..total).collect();
    order.sort_by_key(|&index| texts[index].len());
    let batches: Vec<&[usize]> = order.chunks(runtime.batch).collect();
    let workers = runtime.workers.min(batches.len()).max(1);
    eprintln!("KIMONO_PROGRESS {}", serde_json::json!({"phase": "document_embedding", "completed": 0,
        "total": total, "workers": workers, "batch": runtime.batch, "threads": runtime.threads}));
    if total == 0 {
        return Ok(Vec::new());
    }
    let next = AtomicUsize::new(0);
    let completed = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let results = Mutex::new(vec![None; total]);
    std::thread::scope(|scope| -> std::result::Result<(), String> {
        let handles: Vec<_> = (0..workers).map(|worker| {
            let (next, completed, failed, results, batches) = (&next, &completed, &failed, &results, &batches);
            scope.spawn(move || -> std::result::Result<(), String> {
                let outcome = (|| -> std::result::Result<(), String> {
                    let owned;
                    let embedder = if worker == 0 {
                        primary
                    } else {
                        owned = OnnxEmbedder::from_dir(model).map_err(|error| error.to_string())?;
                        &owned
                    };
                    while !failed.load(Ordering::Relaxed) {
                        let Some(batch) = batches.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                        let input: Vec<String> = batch.iter().map(|&index| texts[index].to_string()).collect();
                        let usable = |vector: &Vec<f32>| !vector.is_empty() && vector.iter().all(|value| value.is_finite());
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
                        {
                            let mut results = results.lock().map_err(|_| "Embedding results lock poisoned")?;
                            for (&index, vector) in batch.iter().zip(vectors) {
                                results[index] = vector;
                            }
                        }
                        let done = completed.fetch_add(batch.len(), Ordering::Relaxed) + batch.len();
                        eprintln!("KIMONO_PROGRESS {}", serde_json::json!({
                            "phase": "document_embedding", "completed": done, "total": total,
                            "workers": workers, "batch": runtime.batch, "threads": runtime.threads,
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
        let mut first = Ok(());
        for handle in handles {
            let outcome = handle.join().unwrap_or_else(|_| Err("Embedding worker panicked".into()));
            if first.is_ok() {
                first = outcome;
            }
        }
        first
    })?;
    let vectors = results.into_inner().map_err(|_| "Embedding results lock poisoned")?;
    Ok(vectors)
}

fn load_embedder(model: &Path) -> Result<OnnxEmbedder> {
    let started = Instant::now();
    eprintln!("KIMONO_PROGRESS {}", serde_json::json!({
        "phase": "model_loading", "completed": 0, "total": 0
    }));
    let embedder = OnnxEmbedder::from_dir(model)?;
    eprintln!("KIMONO_PROGRESS {}", serde_json::json!({
        "phase": "model_loaded", "completed": 0, "total": 0,
        "elapsedMs": started.elapsed().as_millis()
    }));
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

#[derive(Clone, Deserialize, Serialize)]
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
    match fs::read(cache.join("state.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(error) => Err(error.into()),
    }
}

fn execute(request: Request, runtime: Runtime) -> Result<serde_json::Value> {
    if request.operation == "info" {
        let embedder = load_embedder(&request.model)?;
        let spec = embedder.spec();
        let mut files = BTreeMap::new();
        for file in ["model.onnx", "tokenizer.json", "model.json"] {
            files.insert(file, hash(&fs::read(request.model.join(file))?));
        }
        return Ok(serde_json::json!({
            "engine": "embsearch-core", "version": "0.3.4",
            "model": embedder.model_id(), "name": spec.name,
            "dimensions": embedder.dim(), "normalized": spec.normalize,
            "maxTokens": spec.max_tokens, "pooling": spec.pooling,
            "queryPrefix": spec.query_prefix, "documentPrefix": spec.document_prefix,
            "sha256": files,
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
    let mut identity = Sha256::new();
    for file in ["model.onnx", "tokenizer.json", "model.json"] {
        identity.update(fs::read(request.model.join(file))?);
    }
    let fingerprint = format!("{:x}", identity.finalize());
    let embedder = load_embedder(&request.model)?;
    let model_id = embedder.model_id().to_string();
    let search_vector = if let Some(vector) = &request.vector {
        if request.embedding_model.as_deref() != Some(model_id.as_str()) {
            return Err("embeddingModel must exactly match the active model identifier returned by aikido_embed; dimensions alone do not establish compatibility".into());
        }
        if vector.len() != embedder.dim()
            || vector.iter().any(|value| !value.is_finite())
            || !vector.iter().any(|value| value.is_normal())
        {
            return Err(format!("vector must contain {} finite float32 values with non-zero norm", embedder.dim()).into());
        }
        // Normalize in f64 so valid large/small float32 vectors do not
        // overflow/underflow the index's float32 sum-of-squares.
        let norm = vector.iter().map(|value| (*value as f64).powi(2)).sum::<f64>().sqrt();
        Some(vector.iter().map(|value| (*value as f64 / norm) as f32).collect::<Vec<_>>())
    } else {
        None
    };
    if request.sync_paths.is_some() && request.operation != "update" {
        return Err("syncPaths requires update".into());
    }
    if request.sync_paths.is_some() && previous.model != fingerprint && !previous.generation.is_empty() {
        return Err("Embedding model changed; run a full update before targeted synchronization".into());
    }
    let selected = |file: &str| request.sync_paths.as_ref().is_none_or(|paths|
        paths.iter().any(|scope| file == scope || file.starts_with(&format!("{scope}/"))));
    let mut previous_documents = previous.documents.clone();
    // Migration from v0.2 state: hashes are unknown until each file is reread.
    for chunk in previous.chunks.values() {
        previous_documents.entry(chunk.path.clone()).or_default();
    }
    let mut documents: BTreeMap<String, String> = previous_documents.iter()
        .filter(|(file, _)| !selected(file)).map(|(file, hash)| (file.clone(), hash.clone())).collect();
    for document in &request.documents {
        if !selected(&document.path) { return Err("Document outside synchronization scope".into()); }
        documents.insert(document.path.clone(), hash(document.content.as_bytes()));
    }
    let added: Vec<_> = documents.keys().filter(|file| !previous_documents.contains_key(*file)).cloned().collect();
    let modified: Vec<_> = documents.iter().filter(|(file, digest)|
        previous_documents.get(*file).is_some_and(|old| old != *digest)).map(|(file, _)| file.clone()).collect();
    let deleted: Vec<_> = previous_documents.keys().filter(|file| !documents.contains_key(*file)).cloned().collect();
    let mut current: BTreeMap<String, Chunk> = previous.chunks.iter().filter(|(_, chunk)| !selected(&chunk.path))
        .map(|(id, chunk)| (id.clone(), chunk.clone())).collect();
    current.extend(chunks(request.documents));
    let reuse = previous.model == fingerprint
        && !previous.generation.is_empty()
        && request.operation != "rebuild";
    let updates: Vec<_> = current
        .iter()
        .filter(|(id, chunk)| {
            !reuse || previous.chunks.get(*id).map(|old| &old.hash) != Some(&chunk.hash)
        })
        .collect();
    let texts: Vec<&str> = updates.iter().map(|(_, chunk)| chunk.text.as_str()).collect();
    let vectors = embed_parallel(&embedder, &request.model, runtime, &texts)?;
    let mut fresh: Vec<(String, Vec<f32>)> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for ((id, _), vector) in updates.iter().zip(vectors) {
        match vector {
            Some(vector) => fresh.push((id.to_string(), vector)),
            None => failed.push(id.to_string()),
        }
    }
    // Ignored passages are traced and left out; they are retried on the next update.
    for id in &failed {
        eprintln!("kimono-semantic: chunk ignored (embedding failed): {id}");
        current.remove(id);
    }
    // Skipping isolated passages is tolerated; a systemic failure (model/runtime) is not.
    if fresh.is_empty() && !failed.is_empty() {
        return Err(format!("None of the {} passages could be embedded; check the model and ONNX runtime", failed.len()).into());
    }
    let embedded = fresh.len();
    let mut db = if reuse {
        Database::open(embedder, request.cache.join(&previous.generation))?
    } else {
        Database::new(embedder, Metric::Cosine)
    };
    let mut changed = !reuse;
    if reuse {
        for id in previous
            .chunks
            .keys()
            .filter(|id| !current.contains_key(*id))
        {
            db.remove(id)?;
            changed = true;
        }
    }
    for (id, vector) in fresh {
        if reuse {
            db.remove(&id)?;
        }
        db.add_vector(&id, vector)?;
        changed = true;
    }
    if request.operation == "compact" {
        db.compact();
        changed = true;
    }
    let mut generation = previous.generation.clone();
    if changed || documents != previous.documents || serde_json::to_vec(&current)? != serde_json::to_vec(&previous.chunks)? {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let digest = hash(&serde_json::to_vec(&(&fingerprint, &current, nonce))?);
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
        let state = State {
            generation: generation.clone(),
            chunks: current.clone(),
            model: fingerprint,
            documents,
        };
        fs::write(
            request.cache.join("state.pending"),
            serde_json::to_vec(&state)?,
        )?;
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
            if request.paths.as_ref().is_some_and(|paths| !paths.contains(&chunk.path)) {
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
        "runtime": { "workers": runtime.workers, "threads": runtime.threads, "batch": runtime.batch },
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
        let request: Request = serde_json::from_slice(&fs::read(path)?)?;
        let runtime = configure_runtime()?;
        let output = execute(request, runtime)?;
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
            assert_eq!(bounded_setting("threads", Some(&value.to_string()), 2, 32).unwrap(), value);
        }
        for value in ["0", "33", "-1", "many", "1.5"] {
            assert!(bounded_setting("threads", Some(value), 2, 32).is_err());
        }
        let none = |_: &str| None;
        assert_eq!(runtime_settings(2, none).unwrap(), Runtime { workers: 2, threads: 1, batch: 8 });
        assert_eq!(runtime_settings(14, none).unwrap(), Runtime { workers: 4, threads: 2, batch: 8 });
        assert_eq!(runtime_settings(1, none).unwrap(), Runtime { workers: 1, threads: 1, batch: 8 });
        let explicit = |name: &str| Some(match name {
            "KIMONO_SEMANTIC_WORKERS" => "3", "KIMONO_SEMANTIC_THREADS" => "2", _ => "64",
        }.to_string());
        assert_eq!(runtime_settings(14, explicit).unwrap(), Runtime { workers: 3, threads: 2, batch: 64 });
        assert!(runtime_settings(4, |name: &str| (name == "KIMONO_SEMANTIC_BATCH").then(|| "257".to_string())).is_err());
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
}
