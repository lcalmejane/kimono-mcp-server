use embsearch_core::{l2_normalize, Embedder, ModelSpec, OnnxEmbedder, Pooling};
use ndarray::{Array2, Axis};
use ort::session::Session;
use ort::value::{DynValue, Value};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tokenizers::{Tokenizer, TruncationParams};

use crate::Result;

const JINA_CODE_MODEL_PREFIX: &str = "jina-embeddings-v2-base-code@";

fn embedding_error(message: impl std::fmt::Display) -> embsearch_core::Error {
    embsearch_core::Error::Embed(message.to_string())
}

pub fn load_embedder(model: &Path) -> Result<Box<dyn Embedder>> {
    let spec = ModelSpec::from_json(&fs::read(model.join("model.json"))?)?;
    if spec.name.starts_with(JINA_CODE_MODEL_PREFIX) {
        Ok(Box::new(JinaCodeEmbedder::from_dir(model, spec)?))
    } else {
        Ok(Box::new(OnnxEmbedder::from_dir(model)?))
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
