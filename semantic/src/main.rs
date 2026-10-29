use embsearch_core::{Database, Embedder, Metric, ModelSpec};
mod device;
mod model;
mod resources;
use model::load_embedder;
use resources::Runtime;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::error::Error;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const INDEX_FORMAT_VERSION: &str = "kimono-semantic-v2";
const CHUNKER_VERSION: &str =
    "tree-sitter-0.25.10;c0.24.2;cpp0.23.4;go0.25.0;java0.23.5;js0.25.0;php0.25.1;py0.25.0;rs0.24.2;ts0.23.2;lines-v7";
const DEFAULT_CHUNK_CHARS: usize = 500;
const MAX_TREE_SITTER_BYTES: usize = 1024 * 1024;
const MAX_SEARCH_CANDIDATES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq)]
struct PassagePolicy {
    max_chars: usize,
}

impl PassagePolicy {
    fn from_config(config: &serde_json::Value) -> Result<Self> {
        let max_chars = match config.get("chunk_chars") {
            None => DEFAULT_CHUNK_CHARS,
            Some(value) => value
                .as_u64()
                .filter(|value| (128..=2048).contains(value))
                .ok_or("model.json chunk_chars must be an integer between 128 and 2048")?
                as usize,
        };
        Ok(Self { max_chars })
    }

    fn from_model(model: &Path) -> Result<Self> {
        Self::from_config(&serde_json::from_slice(&fs::read(
            model.join("model.json"),
        )?)?)
    }

    fn small_fragment_chars(self) -> usize {
        self.max_chars * 2 / 5
    }
}

fn candidate_limit(chunks: usize, limit: usize, filtered: bool) -> usize {
    let requested = if filtered {
        limit.saturating_mul(16).max(256).min(MAX_SEARCH_CANDIDATES)
    } else {
        limit
    };
    chunks.min(requested)
}

fn requested_device(value: Option<&str>) -> Result<&str> {
    let value = value.unwrap_or("auto");
    match value {
        "auto" | "cpu" | "cuda" | "coreml" => Ok(value),
        _ => Err("KIMONO_SEMANTIC_DEVICE must be auto, cpu, cuda or coreml".into()),
    }
}

fn configure_runtime(model: &Path, device: &str) -> Result<Runtime> {
    let runtime = resources::detect(model, device)?;
    if model::backend_for(model)? == model::Backend::Model2Vec {
        if !matches!(device, "auto" | "cpu") {
            return Err("The Model2Vec static backend runs on CPU; select auto or cpu".into());
        }
        eprintln!(
            "KIMONO_PROGRESS {}",
            serde_json::json!({"phase":"runtime_configured",
            "completed":0, "total":0, "executionProvider":"cpu",
            "backend":"model2vec", "workers":runtime.workers,
            "threads":runtime.threads, "batch":runtime.batch})
        );
        return Ok(runtime);
    }
    let providers = device::providers(device)?;
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
                            outcome => {
                                match outcome {
                                    Err(error) => eprintln!("kimono-semantic: batch embedding failed; retrying passages individually: {error}"),
                                    Ok(vectors) => eprintln!("kimono-semantic: batch returned {} vectors for {} passages; retrying individually", vectors.len(), batch.len()),
                                }
                                input.iter().map(|text| match embedder.embed_batch(std::slice::from_ref(text)) {
                                Ok(mut single) if single.len() == 1 => single.pop().filter(usable),
                                Ok(_) => None,
                                Err(error) => {
                                    eprintln!("kimono-semantic: passage not embeddable: {error}");
                                    None
                                }
                                }).collect()
                            },
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

fn load_embedder_with_progress(model: &Path) -> Result<Box<dyn Embedder>> {
    let started = Instant::now();
    eprintln!(
        "KIMONO_PROGRESS {}",
        serde_json::json!({
            "phase": "model_loading", "completed": 0, "total": 0
        })
    );
    let embedder = load_embedder(model)?;
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
    #[serde(rename = "deletedPaths", default)]
    deleted_paths: Vec<String>,
    #[serde(default)]
    incremental: bool,
}

#[derive(Deserialize)]
struct WorkerMessage {
    version: u8,
    id: String,
    operation: String,
    #[serde(rename = "requestPath")]
    request_path: Option<PathBuf>,
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
    index_version: String,
    #[serde(default)]
    documents: BTreeMap<String, String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct StateStamp {
    length: u64,
    modified_nanos: u128,
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

fn document_hash(kind: &str, content: &str) -> Result<String> {
    serialized_hash(&(kind, content))
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

fn model_fingerprint(model: &Path) -> Result<String> {
    let mut identity = HashWriter(Sha256::new());
    let backend = model::backend_for(model)?;
    identity.write_all(format!("backend={};", backend.as_str()).as_bytes())?;
    for file in backend.weight_files() {
        std::io::copy(&mut fs::File::open(model.join(file))?, &mut identity)?;
    }
    identity.write_all(INDEX_FORMAT_VERSION.as_bytes())?;
    identity.write_all(CHUNKER_VERSION.as_bytes())?;
    identity.write_all(
        format!("default_chunk_chars={DEFAULT_CHUNK_CHARS};small_fragment_ratio=2/5;embsearch-core=0.3.4")
            .as_bytes(),
    )?;
    Ok(format!("{:x}", identity.0.finalize()))
}

fn chunk_documents(documents: Vec<Document>, policy: PassagePolicy) -> BTreeMap<String, Chunk> {
    let mut result = BTreeMap::new();
    for document in documents {
        let code = is_code_source(&document.path);
        let syntax_lines = code
            .then(|| syntax_definition_lines(&document.path, &document.content))
            .flatten();
        let mut text = String::new();
        let mut start = 1;
        let mut passages = Vec::new();
        // Bound Unicode passages; the tokenizer independently caps tokens.
        let mut emit = |text: &mut String, line: usize| {
            if text.trim().is_empty() {
                text.clear();
                return;
            }
            passages.push(Chunk {
                path: document.path.clone(),
                kind: document.kind.clone(),
                line,
                hash: hash(text.as_bytes()),
                text: std::mem::take(text),
            });
        };
        for (line, value) in document.content.lines().enumerate() {
            let definition_start = if let Some(lines) = &syntax_lines {
                lines.contains(&(line + 1))
            } else {
                code && is_definition_start(value)
            };
            if definition_start {
                emit(&mut text, start);
            }
            if value.trim().is_empty() {
                if !text.is_empty() {
                    if text.chars().count() < policy.max_chars {
                        text.push('\n');
                    } else {
                        emit(&mut text, start);
                    }
                }
                continue;
            }
            let mut chars = value.chars().peekable();
            while chars.peek().is_some() {
                let piece: String = chars.by_ref().take(policy.max_chars - 1).collect();
                if text.chars().count() + piece.chars().count() + 1 > policy.max_chars {
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
        for (ordinal, chunk) in coalesce_small_chunks(passages, policy)
            .into_iter()
            .enumerate()
        {
            result.insert(format!("{}#{ordinal}", document.path), chunk);
        }
    }
    result
}

fn coalesce_small_chunks(passages: Vec<Chunk>, policy: PassagePolicy) -> Vec<Chunk> {
    let mut packed: Vec<Chunk> = Vec::new();
    for mut chunk in passages {
        if let Some(previous) = packed.last_mut() {
            let previous_length = previous.text.chars().count();
            let length = chunk.text.chars().count();
            let adjacent = previous.line
                + previous.text.bytes().filter(|&byte| byte == b'\n').count()
                == chunk.line;
            if adjacent
                && previous_length + length <= policy.max_chars
                && (previous_length < policy.small_fragment_chars()
                    || length < policy.small_fragment_chars())
            {
                previous.text.push_str(&chunk.text);
                previous.hash = hash(previous.text.as_bytes());
                continue;
            }
            if adjacent && !has_chunk_content(&chunk.text) {
                // Give a closing-delimiter tail real context without exceeding the cap.
                if let Some((last_content, _)) = previous
                    .text
                    .char_indices()
                    .rfind(|(_, value)| value.is_alphanumeric() || *value == '_')
                {
                    let split = previous.text[..last_content]
                        .rfind('\n')
                        .map_or(0, |index| index + 1);
                    if split > 0
                        && previous.text[split..].chars().count() + length <= policy.max_chars
                    {
                        let tail = previous.text.split_off(split);
                        chunk.text.insert_str(0, &tail);
                        chunk.line = previous.line
                            + previous.text.bytes().filter(|&byte| byte == b'\n').count();
                        previous.hash = hash(previous.text.as_bytes());
                    }
                }
            }
        }
        chunk.hash = hash(chunk.text.as_bytes());
        packed.push(chunk);
    }
    packed
}

fn has_chunk_content(text: &str) -> bool {
    text.chars()
        .any(|value| value.is_alphanumeric() || value == '_')
}

fn syntax_definition_lines(path: &str, content: &str) -> Option<BTreeSet<usize>> {
    if content.len() > MAX_TREE_SITTER_BYTES {
        return None;
    }
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    let language: tree_sitter::Language = match extension.as_str() {
        "c" | "h" => tree_sitter_c::LANGUAGE.into(),
        "cc" | "cpp" | "hpp" => tree_sitter_cpp::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "js" | "jsx" | "mjs" => tree_sitter_javascript::LANGUAGE.into(),
        "php" => tree_sitter_php::LANGUAGE_PHP.into(),
        "py" => tree_sitter_python::LANGUAGE.into(),
        "rs" => tree_sitter_rust::LANGUAGE.into(),
        "ts" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        _ => return None,
    };
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&language).ok()?;
    let tree = parser.parse(content, None)?;
    let root = tree.root_node();
    if root.has_error() {
        return None;
    }
    let mut lines = BTreeSet::new();
    let mut cursor = root.walk();
    let mut visited = vec![root];
    while let Some(node) = visited.pop() {
        if is_syntax_definition(node.kind()) {
            lines.insert(node.start_position().row + 1);
        }
        for child in node.children(&mut cursor) {
            visited.push(child);
        }
    }
    Some(lines)
}

fn is_syntax_definition(kind: &str) -> bool {
    matches!(
        kind,
        "class_declaration"
            | "class_definition"
            | "class_method"
            | "enum_item"
            | "function_declaration"
            | "function_definition"
            | "function_item"
            | "impl_item"
            | "interface_declaration"
            | "method_declaration"
            | "method_definition"
            | "mod_item"
            | "struct_item"
            | "trait_declaration"
            | "trait_item"
            | "type_alias_declaration"
    )
}

fn is_code_source(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    matches!(
        extension.as_deref(),
        Some(
            "c" | "cc"
                | "cpp"
                | "cs"
                | "go"
                | "h"
                | "hpp"
                | "java"
                | "js"
                | "jsx"
                | "mjs"
                | "php"
                | "py"
                | "rb"
                | "rs"
                | "scala"
                | "sh"
                | "swift"
                | "ts"
                | "tsx"
                | "vue"
        )
    )
}

fn is_definition_start(line: &str) -> bool {
    let line = line.trim_start();
    [
        "function ",
        "export function ",
        "export async function ",
        "class ",
        "export class ",
        "interface ",
        "export interface ",
        "type ",
        "export type ",
        "struct ",
        "pub struct ",
        "enum ",
        "pub enum ",
        "fn ",
        "pub fn ",
        "async fn ",
        "def ",
        "async def ",
        "func ",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn read_state(cache: &Path) -> Result<State> {
    match fs::File::open(cache.join("state.json")) {
        Ok(file) => Ok(serde_json::from_reader(BufReader::new(file))?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(error) => Err(error.into()),
    }
}

fn state_stamp(cache: &Path) -> Result<Option<StateStamp>> {
    match fs::metadata(cache.join("state.json")) {
        Ok(metadata) => Ok(Some(StateStamp {
            length: metadata.len(),
            modified_nanos: metadata.modified()?.duration_since(UNIX_EPOCH)?.as_nanos(),
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
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

struct CachedDatabase {
    generation: String,
    database: Database<SharedEmbedder<Box<dyn Embedder>>>,
    state: State,
    stamp: Option<StateStamp>,
    estimated_bytes: u64,
    last_used: Instant,
}

const MAX_HOT_INDEXES: usize = 4;
const MAX_HOT_INDEX_BYTES: u64 = 512 * 1024 * 1024;

fn estimated_index_bytes(state: &State, dimensions: usize) -> u64 {
    let vectors = state.chunks.len() as u64 * (dimensions as u64 * 4 + 64);
    let passages = state.chunks.values().fold(0u64, |total, chunk| {
        total
            .saturating_add(chunk.path.len() as u64)
            .saturating_add(chunk.kind.len() as u64)
            .saturating_add(chunk.text.len() as u64)
            .saturating_add(128)
    });
    let manifest = state.documents.iter().fold(0u64, |total, (path, hash)| {
        total
            .saturating_add(path.len() as u64)
            .saturating_add(hash.len() as u64 + 64)
    });
    vectors.saturating_add(passages).saturating_add(manifest)
}

fn hot_index_bytes(databases: &HashMap<PathBuf, CachedDatabase>) -> u64 {
    databases.values().fold(0u64, |total, cached| {
        total.saturating_add(cached.estimated_bytes)
    })
}

fn runtime_info(runtime: Runtime, selection: &device::Selection) -> serde_json::Value {
    serde_json::json!({
        "workers": runtime.workers, "threads": runtime.threads, "batch": runtime.batch,
        "resources": runtime.resources,
        "executionProvider": selection.execution_provider,
        "gpuExecutionVerified": selection.gpu_execution_verified,
        "benchmarks": selection.benchmarks,
    })
}

fn execute(
    request: Request,
    runtime: Runtime,
    selection: &device::Selection,
    embedder: &Arc<Box<dyn Embedder>>,
    fingerprint: &str,
    databases: &mut HashMap<PathBuf, CachedDatabase>,
) -> Result<serde_json::Value> {
    let passage_policy = PassagePolicy::from_model(&request.model)?;
    let runtime_info = runtime_info(runtime, selection);
    eprintln!(
        "KIMONO_PROGRESS {}",
        serde_json::json!({
            "phase":"runtime_configured", "completed":0, "total":0,
            "runtime": runtime_info
        })
    );
    if request.operation == "info" {
        let spec = ModelSpec::from_json(&fs::read(request.model.join("model.json"))?)?;
        let backend = model::backend_for(&request.model)?;
        let mut files = BTreeMap::new();
        for file in backend.weight_files() {
            let mut writer = HashWriter(Sha256::new());
            std::io::copy(&mut fs::File::open(request.model.join(file))?, &mut writer)?;
            files.insert(file, format!("{:x}", writer.0.finalize()));
        }
        return Ok(serde_json::json!({
            "engine": "embsearch-core", "version": "0.3.4",
            "backend": backend.as_str(),
            "truncation": backend != model::Backend::Model2Vec,
            "model": embedder.model_id(), "name": spec.name,
            "dimensions": embedder.dim(), "normalized": spec.normalize,
            "maxTokens": spec.max_tokens, "pooling": spec.pooling,
            "queryPrefix": spec.query_prefix, "documentPrefix": spec.document_prefix,
            "indexVersion": INDEX_FORMAT_VERSION, "chunkerVersion": CHUNKER_VERSION,
            "passageChars": passage_policy.max_chars,
            "smallFragmentChars": passage_policy.small_fragment_chars(),
            "sha256": files,
            "runtime": runtime_info,
            "compatibility": "Reuse model as embeddingModel for vector search. Dimensions and model labels alone cannot prove vector provenance; retain these file hashes and matching preprocessing settings to reproduce embeddings."
        }));
    }
    if request.operation == "profile" {
        return Ok(serde_json::json!({
            "engine": "embsearch-core", "version": "0.3.4",
            "model": embedder.model_id(), "fingerprint": fingerprint,
            "indexVersion": INDEX_FORMAT_VERSION, "chunkerVersion": CHUNKER_VERSION,
            "passageChars": passage_policy.max_chars,
            "smallFragmentChars": passage_policy.small_fragment_chars()
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
        let vector = if usage == "query" {
            embedder.embed_query(text)?
        } else {
            embedder.embed(text)?
        };
        let spec = ModelSpec::from_json(&fs::read(request.model.join("model.json"))?)?;
        if vector.len() != embedder.dim() || vector.iter().any(|value| !value.is_finite()) {
            return Err("Invalid embedding vector".into());
        }
        let backend = model::backend_for(&request.model)?;
        return Ok(serde_json::json!({
            "engine": "embsearch-core", "version": "0.3.4",
            "backend": backend.as_str(), "truncation": backend != model::Backend::Model2Vec,
            "model": embedder.model_id(), "usage": usage,
            "dimensions": embedder.dim(), "normalized": spec.normalize,
            "maxTokens": spec.max_tokens, "vector": vector
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
    let stamp = state_stamp(&request.cache)?;
    let mut cached = databases.remove(&request.cache);
    let cached_state_matches = cached.as_ref().is_some_and(|value| value.stamp == stamp);
    let previous = if cached_state_matches {
        std::mem::take(&mut cached.as_mut().unwrap().state)
    } else {
        read_state(&request.cache)?
    };
    if !previous.generation.is_empty() && !valid_generation(&previous.generation) {
        return Err("Invalid semantic generation in state".into());
    }
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
    let read_only = matches!(request.operation.as_str(), "search" | "stats");
    let incremental = request.incremental;
    if read_only && !request.documents.is_empty() {
        return Err("Read-only semantic operations cannot include documents".into());
    }
    if incremental && request.operation != "update" {
        return Err("incremental requires update".into());
    }
    if !request.deleted_paths.is_empty() && request.operation != "update" {
        return Err("deletedPaths requires update".into());
    }
    if incremental && (previous.generation.is_empty() || previous.model != fingerprint) {
        return Err(
            "Incremental update requires a compatible existing index; run a full update".into(),
        );
    }
    if read_only && !previous.generation.is_empty() && previous.model != fingerprint {
        return Err("Embedding model changed; run a full update before searching the index".into());
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
    let mut documents: BTreeMap<String, String> = if read_only || incremental {
        previous_documents.clone()
    } else {
        previous_documents
            .iter()
            .filter(|(file, _)| !selected(file))
            .map(|(file, hash)| (file.clone(), hash.clone()))
            .collect()
    };
    for file in &request.deleted_paths {
        if !selected(file)
            || file.is_empty()
            || file.starts_with('/')
            || file
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("Invalid or out-of-scope deleted path".into());
        }
        documents.remove(file);
    }
    for document in &request.documents {
        if !selected(&document.path) {
            return Err("Document outside synchronization scope".into());
        }
        documents.insert(
            document.path.clone(),
            document_hash(&document.kind, &document.content)?,
        );
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
    let touched: BTreeSet<String> = request
        .documents
        .iter()
        .map(|document| document.path.clone())
        .chain(request.deleted_paths.iter().cloned())
        .collect();
    let mut current: BTreeMap<String, Chunk> = previous
        .chunks
        .into_iter()
        .filter(|(_, chunk)| {
            read_only
                || if incremental {
                    !touched.contains(&chunk.path)
                } else {
                    !selected(&chunk.path)
                }
        })
        .collect();
    current.extend(chunk_documents(request.documents, passage_policy));
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
        match cached
            .take()
            .filter(|value| cached_state_matches && value.generation == previous.generation)
        {
            Some(value) => value.database,
            None => Database::open(
                SharedEmbedder(Arc::clone(embedder)),
                request.cache.join(&previous.generation),
            )?,
        }
    } else {
        Database::new(SharedEmbedder(Arc::clone(embedder)), Metric::Cosine)
    };
    let mut changed = !read_only && !reuse;
    let mut embedded = 0;
    let mut failed: Vec<String> = Vec::new();
    // Each bounded batch goes straight into the index: no temporary vector file
    // grows on disk and consumed vectors are released immediately.
    embed_parallel(
        &**embedder,
        runtime,
        &texts,
        || load_embedder(&request.model),
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
    if !read_only
        && (changed
            || documents != previous_documents
            || serialized_hash(&current)? != previous_chunk_signature)
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
            #[serde(rename = "index_version")]
            index_version: &'static str,
            documents: &'a BTreeMap<String, String>,
        }
        let state = StateView {
            generation: &generation,
            chunks: &current,
            model: &fingerprint,
            index_version: INDEX_FORMAT_VERSION,
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
    let mut candidates_examined = 0;
    if request.operation == "search" {
        // The vector API cannot filter its graph traversal. Over-fetch a bounded
        // pool for filtered searches, then apply filters before the result limit.
        let filtered = request.kind.is_some() || request.paths.is_some();
        let candidate_count = candidate_limit(db.len(), limit, filtered);
        let candidates = if db.len() == 0 {
            Vec::new()
        } else {
            if let Some(vector) = &search_vector {
                db.query_vector(vector, candidate_count)?
            } else {
                db.query(request.query.as_deref().unwrap(), candidate_count)?
            }
        };
        for hit in candidates {
            candidates_examined += 1;
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
    let chunks_count = db.len();
    let cache_path = request.cache.clone();
    let cached_state = State {
        generation: generation.clone(),
        chunks: current,
        model: fingerprint.to_string(),
        index_version: INDEX_FORMAT_VERSION.to_string(),
        documents,
    };
    let stamp = state_stamp(&cache_path)?;
    let estimated_bytes = estimated_index_bytes(&cached_state, embedder.dim());
    let hot_budget = (runtime.resources.memory_budget_bytes / 4).min(MAX_HOT_INDEX_BYTES);
    if estimated_bytes <= hot_budget {
        databases.insert(
            cache_path.clone(),
            CachedDatabase {
                generation: generation.clone(),
                database: db,
                state: cached_state,
                stamp,
                estimated_bytes,
                last_used: Instant::now(),
            },
        );
        while databases.len() > MAX_HOT_INDEXES || hot_index_bytes(databases) > hot_budget {
            let oldest = databases
                .iter()
                .filter(|(path, _)| *path != &cache_path)
                .min_by_key(|(_, value)| value.last_used)
                .map(|(path, _)| path.clone());
            if let Some(path) = oldest {
                databases.remove(&path);
            } else {
                databases.remove(&cache_path);
                break;
            }
        }
    }
    let hot_indexes = databases.len();
    let hot_bytes = hot_index_bytes(databases);
    Ok(serde_json::json!({
        "engine": "embsearch-core", "version": "0.3.4", "model": model_id,
        "chunks": chunks_count, "embedded": embedded, "skippedChunks": failed.len(), "generation": generation,
        "indexVersion": INDEX_FORMAT_VERSION, "chunkerVersion": CHUNKER_VERSION,
        "candidatesExamined": candidates_examined,
        "hotIndexes": hot_indexes, "hotIndexEstimatedBytes": hot_bytes,
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

fn run_worker(model: PathBuf) -> Result<()> {
    if !model.is_absolute() {
        return Err("Worker model directory must be absolute".into());
    }
    let selection = device::select(&model)?;
    let runtime = configure_runtime(&model, &selection.execution_provider)?;
    let embedder = Arc::new(load_embedder_with_progress(&model)?);
    let fingerprint = model_fingerprint(&model)?;
    let mut databases = HashMap::new();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let stdout = std::io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    let mut line = String::new();
    loop {
        line.clear();
        if input.read_line(&mut line)? == 0 {
            break;
        }
        let response = (|| -> Result<serde_json::Value> {
            if line.len() > 8192 {
                return Err("Worker protocol message exceeds 8192 bytes".into());
            }
            let message: WorkerMessage = serde_json::from_str(&line)?;
            if message.version != 1 || message.id.is_empty() || message.id.len() > 128 {
                return Err("Invalid worker protocol version or request ID".into());
            }
            if message.operation == "shutdown" {
                return Ok(serde_json::json!({ "shutdown": true }));
            }
            if message.operation != "request" {
                return Err("Invalid worker protocol operation".into());
            }
            let request_path = message.request_path.ok_or("requestPath is required")?;
            if !request_path.is_absolute() {
                return Err("Worker request path must be absolute".into());
            }
            let request: Request =
                serde_json::from_reader(BufReader::new(fs::File::open(request_path)?))?;
            if request.model != model {
                return Err("Worker request model does not match the initialized model".into());
            }
            execute(
                request,
                runtime,
                &selection,
                &embedder,
                &fingerprint,
                &mut databases,
            )
        })();
        let id = serde_json::from_str::<WorkerMessage>(&line)
            .map(|message| message.id)
            .unwrap_or_default();
        let envelope = match response {
            Ok(result) => {
                serde_json::json!({ "version": 1, "id": id, "ok": true, "result": result })
            }
            Err(error) => {
                serde_json::json!({ "version": 1, "id": id, "ok": false, "error": error.to_string() })
            }
        };
        serde_json::to_writer(&mut output, &envelope)?;
        output.write_all(b"\n")?;
        output.flush()?;
        if envelope["result"]["shutdown"] == true {
            break;
        }
    }
    Ok(())
}

fn main() {
    let result = (|| -> Result<()> {
        let mut args = std::env::args().skip(1);
        let first = args.next().ok_or("Expected a JSON request file")?;
        if first == "--worker" {
            let model = args.next().ok_or("Expected a model directory")?;
            if args.next().is_some() {
                return Err("Unexpected worker arguments".into());
            }
            return run_worker(PathBuf::from(model));
        }
        let path = first;
        if path == "--benchmark" {
            let model = args.next().ok_or("Expected a model directory")?;
            let device = std::env::var("KIMONO_SEMANTIC_DEVICE")?;
            if requested_device(Some(&device))? == "auto" {
                return Err("Benchmark requires an explicit provider".into());
            }
            let runtime = configure_runtime(Path::new(&model), &device)?;
            println!(
                "{}",
                serde_json::to_string(&device::benchmark(Path::new(&model), runtime, &device)?)?
            );
            return Ok(());
        }
        let request: Request = serde_json::from_reader(BufReader::new(fs::File::open(path)?))?;
        let selection = device::select(&request.model)?;
        let runtime = configure_runtime(&request.model, &selection.execution_provider)?;
        eprintln!(
            "KIMONO_PROGRESS {}",
            serde_json::json!({
                "phase":"runtime_configured", "completed":0, "total":0,
                "runtime": runtime_info(runtime, &selection)
            })
        );
        let embedder = Arc::new(load_embedder_with_progress(&request.model)?);
        let fingerprint = model_fingerprint(&request.model)?;
        let mut databases = HashMap::new();
        let output = execute(
            request,
            runtime,
            &selection,
            &embedder,
            &fingerprint,
            &mut databases,
        )?;
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

    const MAX_CHUNK_CHARS: usize = 750;

    fn chunks(documents: Vec<Document>) -> BTreeMap<String, Chunk> {
        chunk_documents(
            documents,
            PassagePolicy {
                max_chars: MAX_CHUNK_CHARS,
            },
        )
    }

    #[test]
    fn passage_policy_is_model_specific_and_rejects_invalid_limits() {
        assert_eq!(
            PassagePolicy::from_config(&serde_json::json!({}))
                .unwrap()
                .max_chars,
            500
        );
        for (limit, threshold) in [(384, 153), (500, 200), (750, 300)] {
            let policy =
                PassagePolicy::from_config(&serde_json::json!({"chunk_chars": limit})).unwrap();
            assert_eq!(policy.max_chars, limit);
            assert_eq!(policy.small_fragment_chars(), threshold);
            let content = "A paragraph about indexing and local code retrieval.\n\n".repeat(100);
            let chunks = chunk_documents(
                vec![Document {
                    path: "notes.txt".into(),
                    kind: "knowledge".into(),
                    content: content.clone(),
                }],
                policy,
            );
            assert!(chunks
                .values()
                .all(|chunk| chunk.text.chars().count() <= limit));
            let mut ordered: Vec<_> = chunks.iter().collect();
            ordered.sort_by_key(|(id, _)| id.rsplit_once('#').unwrap().1.parse::<usize>().unwrap());
            assert_eq!(
                ordered
                    .iter()
                    .map(|(_, chunk)| chunk.text.as_str())
                    .collect::<String>(),
                content
            );
        }
        for value in [
            serde_json::json!(null),
            serde_json::json!("750"),
            serde_json::json!(127),
            serde_json::json!(2049),
            serde_json::json!(750.5),
        ] {
            assert!(
                PassagePolicy::from_config(&serde_json::json!({"chunk_chars": value})).is_err()
            );
        }
    }

    #[test]
    fn hot_index_estimate_accounts_for_vectors_and_corpus_metadata() {
        let chunk = Chunk {
            path: "src/lib.rs".into(),
            kind: "code".into(),
            line: 1,
            text: "fn search() {}".into(),
            hash: "abc".into(),
        };
        let state = State {
            chunks: BTreeMap::from([("chunk-1".into(), chunk)]),
            documents: BTreeMap::from([("src/lib.rs".into(), "hash".into())]),
            ..State::default()
        };
        let estimate = estimated_index_bytes(&state, 8);
        assert!(estimate >= 8 * 4 + 64);
        assert!(estimate > estimated_index_bytes(&State::default(), 8));
    }

    #[test]
    fn chunks_are_bounded_and_keep_source_lines() {
        let result = chunks(vec![Document {
            path: "prompts/doc.md".into(),
            kind: "knowledge".into(),
            content: format!("{}\nsecond line\n", "é".repeat(1000)),
        }]);
        assert!(result.len() >= 2);
        assert!(result
            .values()
            .all(|chunk| chunk.text.chars().count() <= MAX_CHUNK_CHARS));
        assert!(result.values().all(|chunk| chunk.line > 0));
        let lines = chunks(vec![Document {
            path: "lines.md".into(),
            kind: "knowledge".into(),
            content: format!("{}\nsecond line\n", "a".repeat(MAX_CHUNK_CHARS - 1)),
        }]);
        assert!(lines
            .values()
            .any(|chunk| chunk.text.contains("second line") && chunk.line == 2));
        let code = chunks(vec![Document {
            path: "src/lib.rs".into(),
            kind: "knowledge".into(),
            content: "fn first() {\n    return 1;\n}\npub fn second() {\n    return 2;\n}".into(),
        }]);
        assert_eq!(code.len(), 1);
        assert!(code
            .values()
            .any(|chunk| chunk.text.contains("pub fn second()")));
    }

    #[test]
    fn blank_lines_do_not_multiply_embedding_work() {
        let paragraph = "A paragraph about local retrieval, indexing and project search.";
        for path in ["notes.md", "notes.txt"] {
            let result = chunks(vec![Document {
                path: path.into(),
                kind: "knowledge".into(),
                content: format!("{paragraph}\n\n").repeat(100),
            }]);
            assert!(
                result.len() <= 10,
                "excessive chunks for {path}: {}",
                result.len()
            );
            assert_eq!(
                result
                    .values()
                    .map(|chunk| chunk.text.matches(paragraph).count())
                    .sum::<usize>(),
                100
            );
            for chunk in result.values() {
                assert!(chunk.text.chars().count() <= MAX_CHUNK_CHARS);
                assert_eq!(chunk.line % 2, 1);
            }
        }
        let result = chunks(vec![Document {
            path: "notes.txt".into(),
            kind: "knowledge".into(),
            content: "first\n\nthird\n".into(),
        }]);
        assert_eq!(result.len(), 1);
        assert_eq!(result.values().next().unwrap().text, "first\n\nthird\n");
    }

    #[test]
    fn tree_sitter_detects_boundaries_and_retains_small_definitions_when_coalesced() {
        let cases = [
            (
                "src/lib.rs",
                "fn first() {\n    return 1;\n}\npub fn second() {\n    return 2;\n}",
                "pub fn second()",
                4,
            ),
            (
                "src/lib.ts",
                "export function first() { return 1; }\nexport function second() { return 2; }",
                "export function second()",
                2,
            ),
            (
                "src/lib.py",
                "def first():\n    return 1\n\ndef second():\n    return 2",
                "def second():",
                4,
            ),
            (
                "src/lib.c",
                "int first() { return 1; }\nint second() { return 2; }",
                "int second()",
                2,
            ),
            (
                "src/lib.cpp",
                "int first() { return 1; }\nint second() { return 2; }",
                "int second()",
                2,
            ),
            (
                "src/lib.go",
                "func first() int { return 1 }\nfunc second() int { return 2 }",
                "func second()",
                2,
            ),
            (
                "src/lib.java",
                "class Sample {\n    int first() { return 1; }\n    int second() { return 2; }\n}",
                "int second()",
                3,
            ),
            (
                "src/lib.php",
                "<?php\nclass Sample {\n    public function first() { return 1; }\n    public function second() { return 2; }\n}",
                "public function second()",
                4,
            ),
            (
                "src/lib.PHP",
                "<?php\nnamespace App;\ntrait Sample {\n    public function first() { return 1; }\n    public function second() { return 2; }\n}",
                "public function second()",
                5,
            ),
            (
                "src/lib.js",
                "function first() { return 1; }\nfunction second() { return 2; }",
                "function second()",
                2,
            ),
        ];
        for (path, content, second_definition, line) in cases {
            assert!(is_code_source(path), "not recognized as code: {path}");
            assert!(
                syntax_definition_lines(path, content)
                    .unwrap()
                    .contains(&line),
                "missing Tree-sitter definition for {path}"
            );
            let result = chunks(vec![Document {
                path: path.into(),
                kind: "knowledge".into(),
                content: content.into(),
            }]);
            assert_eq!(result.len(), 1, "small definitions not packed for {path}");
            let chunk = result.values().next().unwrap();
            assert!(
                chunk.text.contains(second_definition),
                "missing definition for {path}"
            );
            assert_eq!(chunk.line, 1, "wrong packed source line for {path}");
            assert_eq!(chunk.text.trim_end(), content, "lost source for {path}");
        }
    }

    #[test]
    fn substantial_definitions_remain_separate_and_small_symbols_are_retained() {
        let body = format!("    // {}\n", "explanation ".repeat(25));
        let content = format!("fn first() {{\n{body}}}\nfn second() {{\n{body}}}\n");
        let result = chunks(vec![Document {
            path: "src/lib.rs".into(),
            kind: "knowledge".into(),
            content,
        }]);
        assert_eq!(result.len(), 2);
        assert!(result["src/lib.rs#0"].text.contains("fn first()"));
        assert!(!result["src/lib.rs#0"].text.contains("fn second()"));
        assert_eq!(result["src/lib.rs#1"].line, 4);

        let content = "import { x } from './x';\n\n// Keep this explanation.\nexport type Id = string;\nexport const zero = 0;\nexport const disabled = false;\n";
        let result = chunks(vec![Document {
            path: "src/types.ts".into(),
            kind: "knowledge".into(),
            content: content.into(),
        }]);
        assert_eq!(result.len(), 1);
        assert_eq!(result["src/types.ts#0"].text, content);
        assert_eq!(result["src/types.ts#0"].hash, hash(content.as_bytes()));
    }

    #[test]
    fn many_tiny_definitions_share_bounded_passages_without_losing_symbols() {
        let content: String = (0..100)
            .map(|index| format!("export function symbol_{index}() {{ return {index}; }}\n"))
            .collect();
        let result = chunks(vec![Document {
            path: "src/symbols.ts".into(),
            kind: "knowledge".into(),
            content: content.clone(),
        }]);
        assert!(
            result.len() <= 7,
            "tiny definitions fragmented into {} passages",
            result.len()
        );
        for index in 0..100 {
            let definition = format!("export function symbol_{index}()");
            assert_eq!(
                result
                    .values()
                    .map(|chunk| chunk.text.matches(&definition).count())
                    .sum::<usize>(),
                1
            );
        }
        let lines: Vec<_> = content.lines().collect();
        for chunk in result.values() {
            assert_eq!(chunk.text.lines().next().unwrap(), lines[chunk.line - 1]);
            assert!(chunk.text.chars().count() <= MAX_CHUNK_CHARS);
        }
    }

    #[test]
    fn closing_delimiters_get_context_without_dropping_source_or_exceeding_limit() {
        let content = format!("{}\n{}\n}}\n", "a".repeat(398), "b".repeat(350));
        let result = chunks(vec![Document {
            path: "notes.txt".into(),
            kind: "knowledge".into(),
            content: content.clone(),
        }]);
        assert_eq!(result.len(), 2);
        assert_eq!(result["notes.txt#0"].line, 1);
        assert_eq!(result["notes.txt#1"].line, 2);
        assert_eq!(
            format!(
                "{}{}",
                result["notes.txt#0"].text, result["notes.txt#1"].text
            ),
            content
        );
        for chunk in result.values() {
            assert!(has_chunk_content(&chunk.text));
            assert!(chunk.text.chars().count() <= MAX_CHUNK_CHARS);
            assert_eq!(chunk.hash, hash(chunk.text.as_bytes()));
        }
        let result = chunks(vec![Document {
            path: "symbols.txt".into(),
            kind: "knowledge".into(),
            content: "{}\n🙂\n---\n".into(),
        }]);
        assert_eq!(result.len(), 1);
        assert_eq!(result["symbols.txt#0"].text, "{}\n🙂\n---\n");
    }

    #[test]
    fn chunk_packing_preserves_unicode_source_order_and_line_offsets() {
        let content = format!(
            "\n{}\n\n{}\nlast line\n",
            "é".repeat(1600),
            "界".repeat(300)
        );
        let result = chunks(vec![Document {
            path: "unicode.txt".into(),
            kind: "knowledge".into(),
            content: content.clone(),
        }]);
        let mut ordered: Vec<_> = result.iter().collect();
        ordered.sort_by_key(|(id, _)| id.rsplit_once('#').unwrap().1.parse::<usize>().unwrap());
        let joined: String = ordered
            .iter()
            .map(|(_, chunk)| chunk.text.as_str())
            .collect();
        assert_eq!(
            joined
                .chars()
                .filter(|value| !value.is_whitespace())
                .collect::<String>(),
            content
                .chars()
                .filter(|value| !value.is_whitespace())
                .collect::<String>()
        );
        let lines: Vec<_> = content.lines().collect();
        for (_, chunk) in ordered {
            assert!(chunk.text.chars().count() <= MAX_CHUNK_CHARS);
            assert!(lines[chunk.line - 1].contains(chunk.text.lines().next().unwrap()));
        }
    }

    #[test]
    fn syntax_chunking_falls_back_for_parse_errors_large_and_unknown_files() {
        let invalid = "fn first() {\npub fn second() {\n";
        assert!(syntax_definition_lines("src/lib.rs", invalid).is_none());
        assert!(
            syntax_definition_lines("src/large.rs", &" ".repeat(MAX_TREE_SITTER_BYTES + 1))
                .is_none()
        );
        assert!(syntax_definition_lines("src/component.vue", "export default {}").is_none());
        let fallback = chunks(vec![Document {
            path: "src/lib.rs".into(),
            kind: "knowledge".into(),
            content: invalid.into(),
        }]);
        assert!(fallback
            .values()
            .any(|chunk| chunk.text.contains("fn first")));
        assert!(fallback
            .values()
            .any(|chunk| chunk.text.contains("pub fn second")));
    }

    #[test]
    fn rejects_generation_path_traversal() {
        assert!(valid_generation("store-0123456789abcdef01234567"));
        assert!(!valid_generation("store-../../private"));
        assert!(!valid_generation("../store-0123456789abcdef01234567"));
        assert!(!valid_generation("store-0123456789abcdef0123456g"));
    }

    #[test]
    fn filtered_search_oversamples_with_a_hard_candidate_bound() {
        assert_eq!(candidate_limit(80, 5, true), 80);
        assert_eq!(candidate_limit(10_000, 5, true), 256);
        assert_eq!(candidate_limit(10_000, 100, true), 1600);
        assert_eq!(candidate_limit(10_000, 100, false), 100);
        assert_eq!(
            candidate_limit(usize::MAX, usize::MAX, true),
            MAX_SEARCH_CANDIDATES
        );
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
            ..Runtime::default()
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
            ..Runtime::default()
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
