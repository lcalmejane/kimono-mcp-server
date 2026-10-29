use embsearch_core::{l2_normalize, Embedder, ModelSpec, OnnxEmbedder, Pooling};
use half::f16;
use memmap2::{Mmap, MmapOptions};
use ndarray::{Array2, Axis};
use ort::session::Session;
use ort::value::{DynValue, Value};
use safetensors::tensor::{Dtype, SafeTensors};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokenizers::{Tokenizer, TruncationParams};

use crate::Result;

const JINA_CODE_MODEL_PREFIX: &str = "jina-embeddings-v2-base-code@";
const MODEL2VEC_BACKEND: &str = "model2vec";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Onnx,
    Model2Vec,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Onnx => "onnx",
            Self::Model2Vec => MODEL2VEC_BACKEND,
        }
    }

    pub fn weight_files(self) -> &'static [&'static str] {
        match self {
            Self::Onnx => &["model.onnx", "tokenizer.json", "model.json"],
            Self::Model2Vec => &[
                "model.safetensors",
                "tokenizer.json",
                "config.json",
                "model.json",
            ],
        }
    }
}

#[derive(Hash, PartialEq, Eq)]
struct MappingKey {
    path: PathBuf,
    length: u64,
    modified_nanos: u128,
}

static MAPPINGS: OnceLock<Mutex<HashMap<MappingKey, Weak<Mmap>>>> = OnceLock::new();

fn invalid_model(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn shared_mapping(path: &Path) -> Result<Arc<Mmap>> {
    let path = path.canonicalize()?;
    let metadata = fs::metadata(&path)?;
    let modified_nanos = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| invalid_model(error.to_string()))?
        .as_nanos();
    let key = MappingKey {
        path: path.clone(),
        length: metadata.len(),
        modified_nanos,
    };
    let cache = MAPPINGS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut mappings = cache
        .lock()
        .map_err(|_| invalid_model("static model mapping cache is poisoned"))?;
    if let Some(mapping) = mappings.get(&key).and_then(Weak::upgrade) {
        return Ok(mapping);
    }
    let file = File::open(path)?;
    // The model directory is immutable while an embedder is active.
    let mapping = Arc::new(unsafe { MmapOptions::new().map(&file)? });
    mappings.retain(|_, mapping| mapping.strong_count() > 0);
    mappings.insert(key, Arc::downgrade(&mapping));
    Ok(mapping)
}

pub fn backend_for(model: &Path) -> Result<Backend> {
    let config: serde_json::Value = serde_json::from_slice(&fs::read(model.join("model.json"))?)?;
    match config.get("backend") {
        Some(serde_json::Value::String(backend)) if backend == MODEL2VEC_BACKEND => {
            Ok(Backend::Model2Vec)
        }
        Some(serde_json::Value::String(backend)) if backend == "onnx" => Ok(Backend::Onnx),
        Some(serde_json::Value::String(backend)) => {
            Err(invalid_model(format!("Unsupported semantic backend '{backend}'")).into())
        }
        Some(_) => Err(invalid_model("model.json backend must be a string").into()),
        None => Ok(Backend::Onnx),
    }
}

fn embedding_error(message: impl std::fmt::Display) -> embsearch_core::Error {
    embsearch_core::Error::Embed(message.to_string())
}

pub fn load_embedder(model: &Path) -> Result<Box<dyn Embedder>> {
    let model_json = fs::read(model.join("model.json"))?;
    let spec = ModelSpec::from_json(&model_json)?;
    let backend = backend_for(model)?;
    match backend {
        Backend::Model2Vec => Ok(Box::new(Model2VecEmbedder::from_dir(model, spec)?)),
        Backend::Onnx if spec.name.starts_with(JINA_CODE_MODEL_PREFIX) => {
            Ok(Box::new(JinaCodeEmbedder::from_dir(model, spec)?))
        }
        Backend::Onnx => Ok(Box::new(OnnxEmbedder::from_dir(model)?)),
    }
}

#[derive(Clone, Copy)]
enum WeightDtype {
    F16,
    F32,
}

struct Model2VecEmbedder {
    mapping: Arc<Mmap>,
    data_offset: usize,
    rows: usize,
    dtype: WeightDtype,
    tokenizer: Tokenizer,
    unknown_id: Option<u32>,
    spec: ModelSpec,
    model_id: String,
}

impl Model2VecEmbedder {
    fn from_dir(model: &Path, spec: ModelSpec) -> Result<Self> {
        if spec.dim != 256 {
            return Err(invalid_model("Model2Vec requires model.json dim 256").into());
        }
        if spec.pooling != Pooling::Mean || !spec.normalize {
            return Err(invalid_model(
                "Model2Vec supports only mean pooling with L2 normalization",
            )
            .into());
        }
        if spec.query_prefix.is_some() || spec.document_prefix.is_some() {
            return Err(invalid_model("Model2Vec does not support query/document prefixes").into());
        }
        let revision = spec.name.rsplit_once('@').map(|(_, revision)| revision);
        if !revision.is_some_and(|revision| {
            (7..=64).contains(&revision.len())
                && revision
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
        }) {
            return Err(invalid_model(
                "Model2Vec model name must include a pinned 7-64 digit hexadecimal revision after '@'",
            )
            .into());
        }

        let model_config: serde_json::Value =
            serde_json::from_slice(&fs::read(model.join("model.json"))?)?;
        reject_unsupported_options(&model_config, "model.json")?;
        let config: serde_json::Value =
            serde_json::from_slice(&fs::read(model.join("config.json"))?)?;
        reject_unsupported_options(&config, "config.json")?;
        for field in ["hidden_size", "hidden_dim", "dim"] {
            if let Some(value) = config.get(field).and_then(serde_json::Value::as_u64) {
                if value as usize != spec.dim {
                    return Err(invalid_model(format!(
                        "config.json {field} does not match model.json dim"
                    ))
                    .into());
                }
            }
        }
        if config
            .get("normalize")
            .and_then(serde_json::Value::as_bool)
            .is_some_and(|normalize| normalize != spec.normalize)
        {
            return Err(invalid_model("config.json normalize does not match model.json").into());
        }
        if config
            .get("sif_coefficient")
            .is_some_and(|coefficient| !coefficient.is_null())
        {
            return Err(invalid_model(
                "Model2Vec SIF weighting is not supported; use an unweighted mean model",
            )
            .into());
        }

        let mapping = shared_mapping(&model.join("model.safetensors"))?;
        let tensors = SafeTensors::deserialize(&mapping)
            .map_err(|error| invalid_model(format!("Invalid model.safetensors: {error}")))?;
        let tensor = tensors
            .tensor("embeddings")
            .map_err(|error| invalid_model(format!("Missing embeddings tensor: {error}")))?;
        let shape = tensor.shape();
        if shape.len() != 2 || shape[0] == 0 || shape[1] != spec.dim {
            return Err(invalid_model(format!(
                "embeddings must have shape [vocabulary, {}], got {shape:?}",
                spec.dim
            ))
            .into());
        }
        let (dtype, item_size) = match tensor.dtype() {
            Dtype::F16 => (WeightDtype::F16, 2usize),
            Dtype::F32 => (WeightDtype::F32, 4usize),
            dtype => {
                return Err(invalid_model(format!(
                    "Unsupported embeddings dtype {dtype:?}; expected F16 or F32"
                ))
                .into())
            }
        };
        let expected_dtype = match dtype {
            WeightDtype::F16 => "float16",
            WeightDtype::F32 => "float32",
        };
        if let Some(declared_dtype) = config
            .get("embedding_dtype")
            .and_then(serde_json::Value::as_str)
        {
            if declared_dtype != expected_dtype {
                return Err(invalid_model(format!(
                    "config.json embedding_dtype '{declared_dtype}' does not match safetensors dtype {expected_dtype}"
                ))
                .into());
            }
        }
        let expected_bytes = shape[0]
            .checked_mul(spec.dim)
            .and_then(|count| count.checked_mul(item_size))
            .ok_or_else(|| invalid_model("embeddings shape overflows address space"))?;
        let bytes = tensor.data();
        if bytes.len() != expected_bytes {
            return Err(invalid_model("embeddings tensor byte length does not match shape").into());
        }
        let data_offset = (bytes.as_ptr() as usize)
            .checked_sub(mapping.as_ptr() as usize)
            .ok_or_else(|| invalid_model("embeddings tensor is outside its safetensors mapping"))?;
        let mapped_end = data_offset
            .checked_add(bytes.len())
            .ok_or_else(|| invalid_model("embeddings tensor range overflows address space"))?;
        if mapped_end > mapping.len() {
            return Err(invalid_model("embeddings tensor extends beyond model.safetensors").into());
        }
        validate_weights(bytes, dtype)?;
        let rows = shape[0];
        drop(tensor);
        drop(tensors);

        let mut tokenizer = Tokenizer::from_file(model.join("tokenizer.json"))
            .map_err(|error| invalid_model(format!("Invalid tokenizer.json: {error}")))?;
        tokenizer.with_padding(None);
        tokenizer.with_truncation(None).map_err(|error| {
            invalid_model(format!("Invalid tokenizer truncation config: {error}"))
        })?;
        let tokenizer_json: serde_json::Value =
            serde_json::from_slice(&fs::read(model.join("tokenizer.json"))?)?;
        let tokenizer_model = tokenizer_json
            .get("model")
            .ok_or_else(|| invalid_model("tokenizer.json does not declare a model"))?;
        let unknown_token_value = tokenizer_model.get("unk_token");
        let unknown_token = unknown_token_value.and_then(|token| {
            token
                .as_str()
                .or_else(|| token.get("content").and_then(serde_json::Value::as_str))
        });
        if unknown_token_value.is_some_and(|value| !value.is_null()) && unknown_token.is_none() {
            return Err(invalid_model("tokenizer.json has an invalid unknown token").into());
        }
        let token_unknown_id = unknown_token.and_then(|token| tokenizer.token_to_id(token));
        if unknown_token.is_some() && token_unknown_id.is_none() {
            return Err(invalid_model(
                "tokenizer.json unknown token is not present in the tokenizer vocabulary",
            )
            .into());
        }
        let numeric_unknown_id = tokenizer_model
            .get("unk_id")
            .filter(|value| !value.is_null())
            .or_else(|| {
                tokenizer_model
                    .get("unk_token_id")
                    .filter(|value| !value.is_null())
            })
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or_else(|| invalid_model("tokenizer.json unknown id must be a u32"))
            })
            .transpose()?;
        if token_unknown_id.is_some()
            && numeric_unknown_id.is_some()
            && token_unknown_id != numeric_unknown_id
        {
            return Err(
                invalid_model("tokenizer.json unknown token and unknown id do not match").into(),
            );
        }
        let unknown_id = numeric_unknown_id.or(token_unknown_id);
        if unknown_id.is_some_and(|id| id as usize >= rows) {
            return Err(invalid_model(
                "tokenizer.json unknown id exceeds embeddings vocabulary size",
            )
            .into());
        }
        if let Some(max_id) = tokenizer.get_vocab(true).values().copied().max() {
            if max_id as usize >= rows {
                return Err(invalid_model(format!(
                    "tokenizer vocabulary id {max_id} exceeds embeddings vocabulary size {}",
                    rows
                ))
                .into());
            }
        }
        let model_id = spec.model_id();
        Ok(Self {
            mapping,
            data_offset,
            rows,
            dtype,
            tokenizer,
            unknown_id,
            spec,
            model_id,
        })
    }

    fn add_row(&self, id: u32, vector: &mut [f32]) -> embsearch_core::Result<()> {
        if id as usize >= self.rows {
            return Err(embedding_error(format!(
                "Token id {id} exceeds embeddings vocabulary size {}",
                self.rows
            )));
        }
        let item_size = match self.dtype {
            WeightDtype::F16 => 2,
            WeightDtype::F32 => 4,
        };
        let row_bytes = self
            .spec
            .dim
            .checked_mul(item_size)
            .ok_or_else(|| embedding_error("Embedding row size overflow"))?;
        let start = self
            .data_offset
            .checked_add(
                (id as usize)
                    .checked_mul(row_bytes)
                    .ok_or_else(|| embedding_error("Embedding row offset overflow"))?,
            )
            .ok_or_else(|| embedding_error("Embedding row offset overflow"))?;
        let end = start
            .checked_add(row_bytes)
            .ok_or_else(|| embedding_error("Embedding row end overflow"))?;
        let bytes = self.mapping.get(start..end).ok_or_else(|| {
            embedding_error(format!("Embedding row {id} is outside model.safetensors"))
        })?;
        match self.dtype {
            WeightDtype::F16 => {
                for (sum, pair) in vector.iter_mut().zip(bytes.chunks_exact(2)) {
                    *sum += f16::from_le_bytes([pair[0], pair[1]]).to_f32();
                }
            }
            WeightDtype::F32 => {
                for (sum, quad) in vector.iter_mut().zip(bytes.chunks_exact(4)) {
                    *sum += f32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]]);
                }
            }
        }
        Ok(())
    }

    fn embed_texts(&self, texts: &[String]) -> embsearch_core::Result<Vec<Vec<f32>>> {
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), false)
            .map_err(embedding_error)?;
        encodings
            .into_iter()
            .map(|encoding| {
                let mut vector = vec![0.0f32; self.spec.dim];
                let mut count = 0usize;
                for &id in encoding.get_ids() {
                    if Some(id) == self.unknown_id {
                        continue;
                    }
                    self.add_row(id, &mut vector)?;
                    count += 1;
                }
                if count > 0 {
                    for value in &mut vector {
                        *value /= count as f32;
                    }
                }
                if vector.iter().any(|value| !value.is_finite()) {
                    return Err(embedding_error(
                        "Model2Vec produced a non-finite embedding vector",
                    ));
                }
                if self.spec.normalize {
                    l2_normalize(&mut vector);
                }
                Ok(vector)
            })
            .collect()
    }
}

fn reject_unsupported_options(config: &serde_json::Value, source: &str) -> Result<()> {
    for option in ["weights", "mapping"] {
        if config.get(option).is_some() {
            return Err(invalid_model(format!(
                "{source} option '{option}' is not supported by the Model2Vec backend"
            ))
            .into());
        }
    }
    Ok(())
}

fn validate_weights(bytes: &[u8], dtype: WeightDtype) -> Result<()> {
    let finite = match dtype {
        WeightDtype::F16 => bytes
            .chunks_exact(2)
            .all(|pair| f16::from_le_bytes([pair[0], pair[1]]).to_f32().is_finite()),
        WeightDtype::F32 => bytes
            .chunks_exact(4)
            .all(|quad| f32::from_le_bytes([quad[0], quad[1], quad[2], quad[3]]).is_finite()),
    };
    if !finite {
        return Err(invalid_model("embeddings tensor contains non-finite weights").into());
    }
    Ok(())
}

impl Embedder for Model2VecEmbedder {
    fn dim(&self) -> usize {
        self.spec.dim
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn embed(&self, text: &str) -> embsearch_core::Result<Vec<f32>> {
        self.embed_batch(&[text.to_owned()])?
            .pop()
            .ok_or_else(|| embedding_error("Model2Vec returned no vector"))
    }

    fn embed_batch(&self, texts: &[String]) -> embsearch_core::Result<Vec<Vec<f32>>> {
        self.embed_texts(texts)
    }

    fn embed_query(&self, text: &str) -> embsearch_core::Result<Vec<f32>> {
        self.embed(text)
    }

    fn embed_query_batch(&self, texts: &[String]) -> embsearch_core::Result<Vec<Vec<f32>>> {
        self.embed_texts(texts)
    }
}

struct JinaCodeEmbedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    spec: ModelSpec,
    model_id: String,
}

impl JinaCodeEmbedder {
    fn from_dir(model: &Path, spec: ModelSpec) -> Result<Self> {
        let weights = fs::read(model.join("model.onnx"))?;
        let session = Session::builder()?.commit_from_memory(&weights)?;
        let mut tokenizer =
            Tokenizer::from_file(model.join("tokenizer.json")).map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
            })?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: spec.max_tokens,
                ..Default::default()
            }))
            .map_err(|error| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string())
            })?;
        let model_id = spec.model_id();
        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            spec,
            model_id,
        })
    }

    fn embed_with(
        &self,
        texts: &[String],
        prefix: Option<&str>,
    ) -> embsearch_core::Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let prepared = match prefix {
            Some(prefix) => texts.iter().map(|text| format!("{prefix}{text}")).collect(),
            None => texts.to_vec(),
        };
        let encodings = self
            .tokenizer
            .encode_batch(prepared, true)
            .map_err(embedding_error)?;
        let batch = encodings.len();
        let sequence = encodings
            .iter()
            .map(|encoding| encoding.len())
            .max()
            .unwrap_or(0);
        let mut ids = Array2::<i64>::zeros((batch, sequence));
        let mut mask = Array2::<i64>::zeros((batch, sequence));
        let types = Array2::<i64>::zeros((batch, sequence));
        let positions = Array2::from_shape_fn((batch, sequence), |(_, column)| column as i64);
        for (row, encoding) in encodings.iter().enumerate() {
            for (column, (&id, &attention)) in encoding
                .get_ids()
                .iter()
                .zip(encoding.get_attention_mask())
                .enumerate()
            {
                ids[[row, column]] = id as i64;
                mask[[row, column]] = attention as i64;
            }
        }

        let mut session = self
            .session
            .lock()
            .map_err(|_| embedding_error("embedding session mutex poisoned"))?;
        let mut inputs = HashMap::<String, DynValue>::new();
        for input in &session.inputs {
            let value = match input.name.as_str() {
                "input_ids" => Value::from_array(ids.clone()).map_err(embedding_error)?,
                "attention_mask" => Value::from_array(mask.clone()).map_err(embedding_error)?,
                "token_type_ids" => Value::from_array(types.clone()).map_err(embedding_error)?,
                "position_ids" => Value::from_array(positions.clone()).map_err(embedding_error)?,
                name => {
                    return Err(embedding_error(format!(
                        "Unsupported ONNX input '{name}' for the Jina code model adapter"
                    )))
                }
            };
            inputs.insert(input.name.clone(), value.into());
        }
        if !inputs.contains_key("input_ids") || !inputs.contains_key("attention_mask") {
            return Err(embedding_error(
                "Jina code model ONNX must declare input_ids and attention_mask",
            ));
        }
        let outputs = session.run(inputs).map_err(embedding_error)?;
        if outputs.len() == 0 {
            return Err(embedding_error("Jina code model returned no output tensor"));
        }
        let (shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(embedding_error)?;
        if shape.len() != 3 || shape[0] as usize != batch || shape[1] as usize != sequence {
            return Err(embedding_error(format!(
                "Jina code model returned an unexpected tensor shape: {shape:?}"
            )));
        }
        let hidden = shape[2] as usize;
        if hidden != self.spec.dim {
            return Err(embedding_error(format!(
                "model '{}' produced {hidden}-d token vectors but model.json declares dim {}",
                self.spec.name, self.spec.dim
            )));
        }
        let token_embeddings = Array2::from_shape_vec((batch * sequence, hidden), data.to_vec())
            .map_err(embedding_error)?;
        let mut vectors = Vec::with_capacity(batch);
        for row in 0..batch {
            let mut vector = vec![0.0f32; hidden];
            match self.spec.pooling {
                Pooling::Mean => {
                    let mut count = 0.0f32;
                    for column in 0..sequence {
                        if mask[[row, column]] == 0 {
                            continue;
                        }
                        for (value, token) in vector.iter_mut().zip(
                            token_embeddings
                                .index_axis(Axis(0), row * sequence + column)
                                .iter(),
                        ) {
                            *value += token;
                        }
                        count += 1.0;
                    }
                    if count > 0.0 {
                        vector.iter_mut().for_each(|value| *value /= count);
                    }
                }
                Pooling::Cls => vector.copy_from_slice(
                    token_embeddings
                        .index_axis(Axis(0), row * sequence)
                        .as_slice()
                        .ok_or_else(|| {
                            embedding_error(
                                "Jina code model produced a non-contiguous token tensor",
                            )
                        })?,
                ),
            }
            if self.spec.normalize {
                l2_normalize(&mut vector);
            }
            vectors.push(vector);
        }
        Ok(vectors)
    }
}

impl Embedder for JinaCodeEmbedder {
    fn dim(&self) -> usize {
        self.spec.dim
    }

    fn model_id(&self) -> &str {
        &self.model_id
    }

    fn embed(&self, text: &str) -> embsearch_core::Result<Vec<f32>> {
        self.embed_batch(&[text.to_owned()])?
            .pop()
            .ok_or_else(|| embedding_error("embedding returned no vector"))
    }

    fn embed_batch(&self, texts: &[String]) -> embsearch_core::Result<Vec<Vec<f32>>> {
        self.embed_with(texts, self.spec.document_prefix.as_deref())
    }

    fn embed_query(&self, text: &str) -> embsearch_core::Result<Vec<f32>> {
        self.embed_query_batch(&[text.to_owned()])?
            .pop()
            .ok_or_else(|| embedding_error("query embedding returned no vector"))
    }

    fn embed_query_batch(&self, texts: &[String]) -> embsearch_core::Result<Vec<Vec<f32>>> {
        self.embed_with(texts, self.spec.query_prefix.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use safetensors::tensor::{serialize, TensorView};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokenizers::models::wordlevel::WordLevel;
    use tokenizers::pre_tokenizers::whitespace::Whitespace;

    const DIM: usize = 256;
    const ROWS: usize = 6;
    static NEXT_MODEL: AtomicUsize = AtomicUsize::new(0);

    struct TestModel(PathBuf);

    impl Drop for TestModel {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn new_model() -> TestModel {
        let id = NEXT_MODEL.fetch_add(1, Ordering::Relaxed);
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("model2vec-tests")
            .join(format!("{}-{id}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        TestModel(path)
    }

    fn tokenizer(path: &Path, max_id: u32) {
        let mut vocab = HashMap::from([
            ("[PAD]".to_string(), 0),
            ("valid".to_string(), 1),
            ("[UNK]".to_string(), 2),
            ("café".to_string(), 3),
            ("second".to_string(), 4),
            ("世界".to_string(), 5),
        ]);
        if max_id > 5 {
            vocab.insert("outside".to_string(), max_id);
        }
        let model = WordLevel::builder()
            .vocab(vocab)
            .unk_token("[UNK]".into())
            .build()
            .unwrap();
        let mut tokenizer = Tokenizer::new(model);
        tokenizer.with_pre_tokenizer(Some(Whitespace));
        tokenizer.save(path, false).unwrap();
    }

    fn write_model(
        model: &TestModel,
        dtype: Dtype,
        shape: Vec<usize>,
        data: Vec<u8>,
        max_token_id: u32,
    ) {
        let name = "tiny-model@e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b";
        fs::write(
            model.0.join("model.json"),
            serde_json::json!({
                "backend": "model2vec",
                "name": name,
                "dim": DIM,
                "pooling": "mean",
                "normalize": true,
                "max_tokens": 32768,
                "chunk_chars": 750,
                "query_prefix": null,
                "document_prefix": null
            })
            .to_string(),
        )
        .unwrap();
        let dtype_name = match dtype {
            Dtype::F16 => "float16",
            Dtype::F32 => "float32",
            _ => "invalid",
        };
        fs::write(
            model.0.join("config.json"),
            serde_json::json!({
                "model_type": "model2vec",
                "normalize": true,
                "embedding_dtype": dtype_name,
                "hidden_dim": DIM,
                "sif_coefficient": null
            })
            .to_string(),
        )
        .unwrap();
        tokenizer(&model.0.join("tokenizer.json"), max_token_id);
        let tensor = TensorView::new(dtype, shape, &data).unwrap();
        let bytes = serialize([("embeddings", tensor)], None).unwrap();
        fs::write(model.0.join("model.safetensors"), bytes).unwrap();
    }

    fn table(dtype: Dtype, rows: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        for row in 0..rows {
            let value = row as f32 + 1.0;
            for column in 0..DIM {
                let value = match column {
                    0 => value,
                    1 => value * 2.0,
                    _ => 0.0,
                };
                match dtype {
                    Dtype::F16 => bytes.extend_from_slice(&f16::from_f32(value).to_le_bytes()),
                    Dtype::F32 => bytes.extend_from_slice(&value.to_le_bytes()),
                    _ => unreachable!(),
                }
            }
        }
        bytes
    }

    #[test]
    fn f32_embeddings_mean_pool_normalize_and_skip_actual_unknown_id() {
        let model = new_model();
        write_model(
            &model,
            Dtype::F32,
            vec![ROWS, DIM],
            table(Dtype::F32, ROWS),
            5,
        );
        let embedder = Model2VecEmbedder::from_dir(
            &model.0,
            ModelSpec::from_json(&fs::read(model.0.join("model.json")).unwrap()).unwrap(),
        )
        .unwrap();

        let valid = embedder.embed("valid").unwrap();
        assert!(valid[0] > 0.44 && valid[0] < 0.45);
        assert!(valid[1] > 0.89 && valid[1] < 0.90);
        assert!(valid[2..].iter().all(|value| *value == 0.0));
        let unknown = embedder.embed("missing").unwrap();
        assert!(unknown.iter().all(|value| *value == 0.0));
        let empty = embedder.embed("").unwrap();
        assert!(empty.iter().all(|value| *value == 0.0));
        assert_eq!(
            embedder.embed_query("valid").unwrap(),
            embedder.embed("valid").unwrap()
        );
        let pooled = embedder.embed("valid second").unwrap();
        assert!((pooled[0] - valid[0]).abs() < 1e-6);
        assert!((pooled[1] - valid[1]).abs() < 1e-6);
    }

    #[test]
    fn f16_embeddings_support_unicode_and_do_not_truncate_long_inputs() {
        let model = new_model();
        write_model(
            &model,
            Dtype::F16,
            vec![ROWS, DIM],
            table(Dtype::F16, ROWS),
            5,
        );
        let spec = ModelSpec::from_json(&fs::read(model.0.join("model.json")).unwrap()).unwrap();
        let embedder = Model2VecEmbedder::from_dir(&model.0, spec).unwrap();
        let unicode = embedder.embed("café 世界").unwrap();
        assert!(unicode.iter().all(|value| value.is_finite()));
        assert!((unicode.iter().map(|value| value * value).sum::<f32>() - 1.0).abs() < 1e-5);

        let long = format!("{} ", "valid ".repeat(32_769));
        let vector = embedder.embed(&long).unwrap();
        assert!((vector[0] - 1.0 / 5.0_f32.sqrt()).abs() < 1e-5);
        assert!((vector[1] - 2.0 / 5.0_f32.sqrt()).abs() < 1e-5);
    }

    #[test]
    fn mapped_tables_are_shared_per_path_without_cross_model_singletons() {
        let first = new_model();
        let second = new_model();
        write_model(
            &first,
            Dtype::F32,
            vec![ROWS, DIM],
            table(Dtype::F32, ROWS),
            5,
        );
        let mut second_table = table(Dtype::F32, ROWS);
        for row in second_table.chunks_exact_mut(DIM * 4) {
            let first = f32::from_le_bytes(row[..4].try_into().unwrap());
            row[..4].copy_from_slice(&(first * 2.0).to_le_bytes());
        }
        write_model(&second, Dtype::F32, vec![ROWS, DIM], second_table, 5);
        let spec = ModelSpec::from_json(&fs::read(first.0.join("model.json")).unwrap()).unwrap();
        let first_embedder = Model2VecEmbedder::from_dir(&first.0, spec.clone()).unwrap();
        let same_path = Model2VecEmbedder::from_dir(&first.0, spec.clone()).unwrap();
        let other_path = Model2VecEmbedder::from_dir(&second.0, spec).unwrap();
        assert!(Arc::ptr_eq(&first_embedder.mapping, &same_path.mapping));
        assert!(!Arc::ptr_eq(&first_embedder.mapping, &other_path.mapping));
        assert_ne!(
            first_embedder.embed("valid").unwrap(),
            other_path.embed("valid").unwrap()
        );
    }

    #[test]
    fn static_model_loader_rejects_bad_shapes_dtypes_options_and_vocabulary_ids() {
        let bad_shape = new_model();
        write_model(
            &bad_shape,
            Dtype::F32,
            vec![ROWS, DIM - 1],
            vec![0; ROWS * (DIM - 1) * 4],
            5,
        );
        let spec =
            ModelSpec::from_json(&fs::read(bad_shape.0.join("model.json")).unwrap()).unwrap();
        assert!(Model2VecEmbedder::from_dir(&bad_shape.0, spec).is_err());

        let bad_dtype = new_model();
        let data = vec![0; ROWS * DIM];
        let tensor = TensorView::new(Dtype::U8, vec![ROWS, DIM], &data).unwrap();
        let bytes = serialize([("embeddings", tensor)], None).unwrap();
        fs::write(bad_dtype.0.join("model.safetensors"), bytes).unwrap();
        fs::write(
            bad_dtype.0.join("model.json"),
            fs::read(bad_shape.0.join("model.json")).unwrap(),
        )
        .unwrap();
        fs::write(
            bad_dtype.0.join("config.json"),
            fs::read(bad_shape.0.join("config.json")).unwrap(),
        )
        .unwrap();
        tokenizer(&bad_dtype.0.join("tokenizer.json"), 5);
        let spec =
            ModelSpec::from_json(&fs::read(bad_dtype.0.join("model.json")).unwrap()).unwrap();
        assert!(Model2VecEmbedder::from_dir(&bad_dtype.0, spec).is_err());

        let bad_id = new_model();
        write_model(
            &bad_id,
            Dtype::F32,
            vec![ROWS, DIM],
            table(Dtype::F32, ROWS),
            ROWS as u32,
        );
        let spec = ModelSpec::from_json(&fs::read(bad_id.0.join("model.json")).unwrap()).unwrap();
        assert!(Model2VecEmbedder::from_dir(&bad_id.0, spec).is_err());

        let bad_options = new_model();
        write_model(
            &bad_options,
            Dtype::F32,
            vec![ROWS, DIM],
            table(Dtype::F32, ROWS),
            5,
        );
        let mut config: serde_json::Value =
            serde_json::from_slice(&fs::read(bad_options.0.join("config.json")).unwrap()).unwrap();
        config["mapping"] = serde_json::json!([]);
        fs::write(bad_options.0.join("config.json"), config.to_string()).unwrap();
        let spec =
            ModelSpec::from_json(&fs::read(bad_options.0.join("model.json")).unwrap()).unwrap();
        assert!(Model2VecEmbedder::from_dir(&bad_options.0, spec).is_err());
    }

    #[test]
    fn static_model_rejects_non_finite_weights() {
        assert!(validate_weights(&f32::NAN.to_le_bytes(), WeightDtype::F32).is_err());
        assert!(validate_weights(&f16::INFINITY.to_le_bytes(), WeightDtype::F16).is_err());
    }

    #[test]
    fn existing_models_keep_onnx_dispatch_and_unknown_backends_fail() {
        let model = new_model();
        for name in [
            "multilingual-e5-small-int8-761b726dd34fb83930e26aab4e9ac3899aa1fa78",
            "jina-embeddings-v2-base-code@0123456789abcdef0123456789abcdef01234567",
        ] {
            fs::write(
                model.0.join("model.json"),
                serde_json::json!({
                    "name": name,
                    "dim": 384,
                    "pooling": "mean",
                    "normalize": true,
                    "max_tokens": 512
                })
                .to_string(),
            )
            .unwrap();
            ModelSpec::from_json(&fs::read(model.0.join("model.json")).unwrap()).unwrap();
            assert_eq!(backend_for(&model.0).unwrap(), Backend::Onnx);
        }
        fs::write(
            model.0.join("model.json"),
            serde_json::json!({
                "backend": "future-backend",
                "name": "model@0123456789abcdef0123456789abcdef01234567",
                "dim": 256,
                "pooling": "mean",
                "max_tokens": 512
            })
            .to_string(),
        )
        .unwrap();
        ModelSpec::from_json(&fs::read(model.0.join("model.json")).unwrap()).unwrap();
        assert!(backend_for(&model.0).is_err());
    }
}
