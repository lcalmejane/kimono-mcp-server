use embsearch_core::{Database, Embedder, Metric, OnnxEmbedder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

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

fn execute(request: Request) -> Result<serde_json::Value> {
    if request.operation == "info" {
        let embedder = OnnxEmbedder::from_dir(&request.model)?;
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
        let embedder = OnnxEmbedder::from_dir(&request.model)?;
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
    let embedder = OnnxEmbedder::from_dir(&request.model)?;
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
    let updates: Vec<_> = current
        .iter()
        .filter(|(id, chunk)| {
            !reuse || previous.chunks.get(*id).map(|old| &old.hash) != Some(&chunk.hash)
        })
        .collect();
    let embedded = updates.len();
    eprintln!("KIMONO_PROGRESS {}", serde_json::json!({"completed": 0, "total": embedded}));
    let mut completed = 0;
    for batch in updates.chunks(8) {
        db.upsert_batch(
            batch
                .iter()
                .map(|(id, chunk)| (id.to_string(), chunk.text.clone())),
        )?;
        completed += batch.len();
        eprintln!("KIMONO_PROGRESS {}", serde_json::json!({"completed": completed, "total": embedded}));
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
        "chunks": db.len(), "embedded": embedded, "generation": generation,
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
        let output = execute(request)?;
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
