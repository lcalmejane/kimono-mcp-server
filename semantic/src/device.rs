use crate::model::load_embedder;
use crate::{requested_device, Result, Runtime};
use embsearch_core::Embedder;
use ort::execution_providers::coreml::{CoreMLComputeUnits, CoreMLModelFormat};
use ort::execution_providers::{
    CPUExecutionProvider, CUDAExecutionProvider, CoreMLExecutionProvider, ExecutionProvider,
    ExecutionProviderDispatch,
};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub execution_provider: String,
    pub median_ms: Option<f64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub execution_provider: String,
    pub gpu_execution_verified: bool,
    pub benchmarks: Vec<Measurement>,
}

pub fn providers(device: &str) -> Result<Vec<ExecutionProviderDispatch>> {
    let cuda = CUDAExecutionProvider::default();
    let coreml = CoreMLExecutionProvider::default()
        .with_compute_units(CoreMLComputeUnits::CPUAndGPU)
        .with_model_format(CoreMLModelFormat::MLProgram);
    let mut providers = Vec::new();
    match device {
        "cuda" if cuda.supported_by_platform() && cuda.is_available()? => {
            providers.push(cuda.build().error_on_failure());
        }
        "coreml" if coreml.supported_by_platform() && coreml.is_available()? => {
            providers.push(coreml.build().error_on_failure());
        }
        "cpu" => {}
        _ => return Err(format!("{device} is unavailable in the loaded ONNX runtime; check the runtime and drivers or select cpu").into()),
    }
    providers.push(CPUExecutionProvider::default().build().error_on_failure());
    Ok(providers)
}

fn probe(model: &Path, device: &str) -> Result<Measurement> {
    let mut child = Command::new(std::env::current_exe()?)
        .arg("--benchmark")
        .arg(model)
        .env("KIMONO_SEMANTIC_DEVICE", device)
        .env("KIMONO_SEMANTIC_WORKERS", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if started.elapsed() > Duration::from_secs(30) => {
                child.kill()?;
                child.wait()?;
                return Err(format!("{device} startup benchmark exceeded 30 seconds").into());
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    if !status.success() {
        return Err(format!(
            "{device} startup benchmark failed ({status}); see native diagnostics"
        )
        .into());
    }
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .ok_or("Missing benchmark output")?
        .read_to_string(&mut stdout)?;
    let measured: Measurement = serde_json::from_str(&stdout)?;
    if measured.execution_provider != device
        || measured.error.is_some()
        || !measured
            .median_ms
            .is_some_and(|ms| ms.is_finite() && ms > 0.0)
    {
        return Err("Invalid execution provider benchmark result".into());
    }
    Ok(measured)
}

pub fn fastest(measurements: &[Measurement]) -> Result<String> {
    measurements
        .iter()
        .filter(|item| item.error.is_none())
        .filter_map(|item| {
            item.median_ms
                .filter(|ms| ms.is_finite() && *ms > 0.0)
                .map(|ms| (item, ms))
        })
        .min_by(|(_, a), (_, b)| a.total_cmp(b))
        .map(|(item, _)| item.execution_provider.clone())
        .ok_or_else(|| "No execution provider completed the startup benchmark".into())
}

pub fn select(model: &Path) -> Result<Selection> {
    let setting = std::env::var("KIMONO_SEMANTIC_DEVICE").ok();
    let requested = requested_device(setting.as_deref())?;
    let mut benchmarks = Vec::new();
    let execution_provider = if requested != "auto" {
        requested.to_string()
    } else {
        let mut candidates = vec!["cpu"];
        let cuda = CUDAExecutionProvider::default();
        let coreml = CoreMLExecutionProvider::default();
        if cuda.supported_by_platform() && cuda.is_available()? {
            candidates.push("cuda");
        }
        if coreml.supported_by_platform() && coreml.is_available()? {
            candidates.push("coreml");
        }
        let total = candidates.len();
        for candidate in candidates {
            eprintln!(
                "KIMONO_PROGRESS {}",
                serde_json::json!({
                    "phase": "device_benchmark", "completed": benchmarks.len(), "total": total,
                    "executionProvider": candidate
                })
            );
            let measured = match probe(model, candidate) {
                Ok(measured) => measured,
                Err(error) => {
                    eprintln!("kimono-semantic: {error}");
                    Measurement {
                        execution_provider: candidate.into(),
                        median_ms: None,
                        error: Some(error.to_string()),
                    }
                }
            };
            benchmarks.push(measured);
        }
        fastest(&benchmarks)?
    };
    // An EP registration or timing does not establish hardware-level GPU execution.
    Ok(Selection {
        execution_provider,
        gpu_execution_verified: false,
        benchmarks,
    })
}

pub fn benchmark(model: &Path, runtime: Runtime, device: &str) -> Result<Measurement> {
    let embedder = load_embedder(model)?;
    let batch = runtime.batch.min(8);
    let short = vec!["Local project search and documentation.".repeat(2); batch];
    let long = vec!["Local project search and documentation.".repeat(12); batch];
    let mut times = Vec::new();
    // Warm both sequence lengths before collecting three identical short/long trials.
    for trial in 0..4 {
        let started = Instant::now();
        for input in [&short, &long] {
            let vectors = embedder.embed_batch(input)?;
            if vectors.len() != input.len()
                || vectors.iter().any(|vector| {
                    vector.len() != embedder.dim()
                        || vector.iter().any(|value| !value.is_finite())
                        || !vector.iter().any(|value| *value != 0.0)
                })
            {
                return Err("Startup benchmark returned invalid embeddings".into());
            }
        }
        if trial > 0 {
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    times.sort_by(f64::total_cmp);
    Ok(Measurement {
        execution_provider: device.into(),
        median_ms: Some(times[1]),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn measured(device: &str, ms: f64) -> Measurement {
        Measurement {
            execution_provider: device.into(),
            median_ms: Some(ms),
            error: None,
        }
    }

    #[test]
    fn selection_uses_measured_speed_not_provider_priority() {
        assert_eq!(
            fastest(&[measured("cpu", 20.0), measured("coreml", 80.0)]).unwrap(),
            "cpu"
        );
        assert_eq!(
            fastest(&[measured("cpu", 20.0), measured("cuda", 5.0)]).unwrap(),
            "cuda"
        );
        let failed = Measurement {
            execution_provider: "cuda".into(),
            median_ms: None,
            error: Some("driver unavailable".into()),
        };
        assert_eq!(fastest(&[failed, measured("cpu", 20.0)]).unwrap(), "cpu");
        assert!(fastest(&[]).is_err());
        assert!(fastest(&[measured("cpu", f64::NAN), measured("cuda", 0.0)]).is_err());
    }

    #[test]
    fn invalid_device_is_rejected() {
        for value in ["auto", "cpu", "cuda", "coreml"] {
            assert_eq!(requested_device(Some(value)).unwrap(), value);
        }
        assert!(requested_device(Some("gpu")).is_err());
    }
}
