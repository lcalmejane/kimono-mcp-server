use crate::Result;
use serde::Serialize;
use std::{fs, path::Path};
use sysinfo::System;

const MIB: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub available_cpus: usize,
    pub cpu_percent: usize,
    pub cpu_budget: usize,
    pub available_memory_bytes: u64,
    pub memory_percent: usize,
    pub memory_budget_bytes: u64,
    pub estimated_memory_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Runtime {
    pub workers: usize,
    pub threads: usize,
    pub batch: usize,
    pub resources: Budget,
}

pub fn bounded_setting(
    name: &str,
    value: Option<&str>,
    default: usize,
    max: usize,
) -> Result<usize> {
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

fn percent(bytes: u64, value: usize) -> u64 {
    ((u128::from(bytes) * value as u128) / 100) as u64
}

pub fn plan(
    cpus: usize,
    available_memory: u64,
    session_bytes: u64,
    passage_bytes: u64,
    device: &str,
    var: impl Fn(&str) -> Option<String>,
) -> Result<Runtime> {
    plan_with_shared(
        cpus,
        available_memory,
        0,
        session_bytes,
        passage_bytes,
        device,
        var,
    )
}

fn plan_with_shared(
    cpus: usize,
    available_memory: u64,
    shared_bytes: u64,
    session_bytes: u64,
    passage_bytes: u64,
    device: &str,
    var: impl Fn(&str) -> Option<String>,
) -> Result<Runtime> {
    if cpus == 0
        || available_memory == 0
        || session_bytes == 0
        || passage_bytes == 0
        || shared_bytes >= available_memory
    {
        return Err(
            "Cannot size semantic runtime: CPU, memory and model estimates must be positive".into(),
        );
    }
    let setting = |name, default, max| bounded_setting(name, var(name).as_deref(), default, max);
    let cpu_percent = setting("KIMONO_SEMANTIC_CPU_PERCENT", 80, 100)?;
    let memory_percent = setting("KIMONO_SEMANTIC_MEMORY_PERCENT", 80, 100)?;
    let cpu_budget = (cpus.saturating_mul(cpu_percent) / 100).max(1);
    let memory_budget = percent(available_memory, memory_percent);
    if shared_bytes >= memory_budget {
        return Err("Semantic memory budget cannot fit the shared model weights".into());
    }
    let threads = setting("KIMONO_SEMANTIC_THREADS", 1, 32)?;
    let batch_setting = var("KIMONO_SEMANTIC_BATCH");
    let batch = bounded_setting("KIMONO_SEMANTIC_BATCH", batch_setting.as_deref(), 0, 256)?;
    let minimum_session =
        session_bytes.saturating_add(passage_bytes.saturating_mul(batch.max(1) as u64));
    let memory_workers = (memory_budget - shared_bytes) / minimum_session;
    let memory_workers = memory_workers.min(32) as usize;
    let automatic_workers = (cpu_budget / threads)
        .clamp(1, 32)
        .min(memory_workers)
        .max(1);
    let mut workers = setting("KIMONO_SEMANTIC_WORKERS", automatic_workers, 32)?;
    if device != "cpu" {
        workers = 1;
    }
    if workers == 0 || (memory_budget - shared_bytes) / (workers as u64) < minimum_session {
        return Err(format!("Semantic memory budget ({memory_budget} bytes) cannot fit {workers} model sessions and the requested batch; reduce explicit workers/batch or increase available memory or KIMONO_SEMANTIC_MEMORY_PERCENT").into());
    }
    let batch = if batch == 0 {
        (((memory_budget - shared_bytes) / workers as u64 - session_bytes) / passage_bytes)
            .clamp(1, 256) as usize
    } else {
        batch
    };
    let estimated_memory = shared_bytes.saturating_add(
        workers as u64 * session_bytes.saturating_add(passage_bytes.saturating_mul(batch as u64)),
    );
    if estimated_memory > memory_budget {
        return Err(format!("Semantic memory estimate ({estimated_memory} bytes) exceeds budget ({memory_budget} bytes)").into());
    }
    Ok(Runtime {
        workers,
        threads,
        batch,
        resources: Budget {
            available_cpus: cpus,
            cpu_percent,
            cpu_budget,
            available_memory_bytes: available_memory,
            memory_percent,
            memory_budget_bytes: memory_budget,
            estimated_memory_bytes: estimated_memory,
        },
    })
}

pub fn available_memory() -> Result<u64> {
    let mut system = System::new();
    system.refresh_memory();
    if system.total_memory() == 0 {
        return Err("Cannot detect host memory for semantic auto sizing".into());
    }
    // Darwin's used memory includes wired/active/compressed pages. Its remainder
    // retains reclaimable inactive pages instead of subtracting compression twice.
    #[cfg(target_os = "macos")]
    let mut available = system.total_memory().saturating_sub(system.used_memory());
    #[cfg(not(target_os = "macos"))]
    let mut available = system.available_memory();
    if let Some(limits) = system.cgroup_limits() {
        available = available.min(limits.free_memory);
    }
    #[cfg(target_os = "linux")]
    {
        // The root may be a cgroup namespace; also inspect the process's nested
        // v1/v2 group and its visible ancestors, not just host MemAvailable.
        let groups = fs::read_to_string("/proc/self/cgroup")?;
        for line in groups.lines() {
            let parts: Vec<_> = line.splitn(3, ':').collect();
            if parts.len() != 3 {
                return Err("Invalid /proc/self/cgroup entry".into());
            }
            let (root, limit, usage) = if parts[1].is_empty() {
                (Path::new("/sys/fs/cgroup"), "memory.max", "memory.current")
            } else if parts[1].split(',').any(|controller| controller == "memory") {
                (
                    Path::new("/sys/fs/cgroup/memory"),
                    "memory.limit_in_bytes",
                    "memory.usage_in_bytes",
                )
            } else {
                continue;
            };
            let group = root.join(parts[2].trim_start_matches('/'));
            if !group.starts_with(root)
                || group
                    .components()
                    .any(|part| part == std::path::Component::ParentDir)
            {
                return Err("Invalid memory cgroup path".into());
            }
            for directory in group
                .ancestors()
                .take_while(|directory| directory.starts_with(root))
            {
                available = cgroup_headroom(directory, limit, usage, available)?;
            }
        }
    }
    if available == 0 {
        return Err("No available host/container memory for semantic auto sizing".into());
    }
    Ok(available)
}

#[cfg(any(target_os = "linux", test))]
fn cgroup_headroom(directory: &Path, limit: &str, usage: &str, available: u64) -> Result<u64> {
    let limit = match fs::read_to_string(directory.join(limit)) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(available),
        Err(error) => return Err(error.into()),
    };
    if limit.trim() == "max" {
        return Ok(available);
    }
    let limit: u64 = limit.trim().parse()?;
    let used: u64 = fs::read_to_string(directory.join(usage))?.trim().parse()?;
    Ok(available.min(limit.saturating_sub(used)))
}

pub fn detect(model: &Path, device: &str) -> Result<Runtime> {
    let model_config: serde_json::Value =
        serde_json::from_slice(&fs::read(model.join("model.json"))?)?;
    let backend = match model_config.get("backend") {
        None => "onnx",
        Some(serde_json::Value::String(value)) if value == "onnx" => "onnx",
        Some(serde_json::Value::String(value)) if value == "model2vec" => "model2vec",
        Some(serde_json::Value::String(value)) => {
            return Err(format!("Unsupported semantic backend '{value}'").into())
        }
        Some(_) => return Err("model.json backend must be a string".into()),
    };
    let tokens = model_config["max_tokens"]
        .as_u64()
        .filter(|n| *n > 0 && (backend == "model2vec" || *n <= 8192))
        .ok_or("Invalid model max_tokens for semantic memory sizing")?;
    let dimensions = model_config["dim"]
        .as_u64()
        .filter(|n| (1..=65536).contains(n))
        .ok_or("Invalid model dim for semantic memory sizing")?;
    let tokenizer = fs::metadata(model.join("tokenizer.json"))?.len();
    if backend == "model2vec" {
        let weights = fs::metadata(model.join("model.safetensors"))?.len();
        let config = fs::metadata(model.join("config.json"))?.len();
        let session = tokenizer
            .saturating_mul(2)
            .saturating_add(config.saturating_mul(2))
            .saturating_add(8 * MIB);
        let chunk_chars = model_config
            .get("chunk_chars")
            .map(|value| {
                value
                    .as_u64()
                    .filter(|chars| (128..=2048).contains(chars))
                    .ok_or("Invalid model chunk_chars for semantic memory sizing")
            })
            .transpose()?
            .unwrap_or(500);
        let passage = (chunk_chars * 128).max(64 * 1024);
        return plan_with_shared(
            std::thread::available_parallelism()?.get(),
            available_memory()?,
            weights,
            session,
            passage,
            device,
            |name| std::env::var(name).ok(),
        );
    }
    let weights = fs::metadata(model.join("model.onnx"))?.len();
    // Conservative planning estimates: sessions may expand quantized weights;
    // passage workspace includes hidden states and attention at the token cap.
    let session = weights
        .saturating_mul(4)
        .saturating_add(tokenizer.saturating_mul(2))
        .saturating_add(128 * MIB);
    let passage =
        (tokens * dimensions * 4 * 16 + tokens * tokens * 4 * dimensions.div_ceil(32) * 2).max(MIB);
    plan(
        std::thread::available_parallelism()?.get(),
        available_memory()?,
        session,
        passage,
        device,
        |name| std::env::var(name).ok(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_for(cpus: usize, memory_mib: u64, vars: &[(&str, &str)]) -> Result<Runtime> {
        plan(cpus, memory_mib * MIB, 512 * MIB, 32 * MIB, "cpu", |name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        })
    }

    #[test]
    fn automatic_workers_use_eighty_percent_and_scale_with_host() {
        for (cpus, expected) in [(1, 1), (2, 1), (4, 3), (16, 12), (64, 32)] {
            let runtime = plan_for(cpus, 65536, &[]).unwrap();
            assert_eq!(runtime.workers, expected);
            assert_eq!(runtime.threads, 1);
            assert!(
                runtime.resources.estimated_memory_bytes <= runtime.resources.memory_budget_bytes
            );
        }
    }

    #[test]
    fn workers_and_batches_share_the_memory_budget() {
        let small = plan_for(16, 2048, &[]).unwrap();
        let large = plan_for(16, 32768, &[]).unwrap();
        assert_eq!(small.workers, 3);
        assert_eq!(small.batch, 1);
        assert_eq!(large.workers, 12);
        assert!(large.batch > small.batch);
        assert!(plan_for(16, 512, &[]).is_err());
        assert!(plan_for(16, 0, &[]).is_err());
    }

    #[test]
    fn configurable_percentages_and_explicit_overrides() {
        let settings = [
            ("KIMONO_SEMANTIC_CPU_PERCENT", "50"),
            ("KIMONO_SEMANTIC_MEMORY_PERCENT", "60"),
        ];
        let runtime = plan_for(16, 32768, &settings).unwrap();
        assert_eq!(runtime.workers, 8);
        assert_eq!(
            runtime.resources.memory_budget_bytes,
            percent(32768 * MIB, 60)
        );
        let explicit = plan_for(
            16,
            32768,
            &[
                ("KIMONO_SEMANTIC_WORKERS", "3"),
                ("KIMONO_SEMANTIC_THREADS", "2"),
                ("KIMONO_SEMANTIC_BATCH", "64"),
            ],
        )
        .unwrap();
        assert_eq!(
            (explicit.workers, explicit.threads, explicit.batch),
            (3, 2, 64)
        );
        let threaded = plan_for(16, 32768, &[("KIMONO_SEMANTIC_THREADS", "2")]).unwrap();
        assert_eq!(threaded.workers, 6);
        let batched = plan_for(16, 2048, &[("KIMONO_SEMANTIC_BATCH", "16")]).unwrap();
        assert_eq!((batched.workers, batched.batch), (1, 16));
        assert!(plan_for(16, 2048, &[("KIMONO_SEMANTIC_WORKERS", "4")]).is_err());
        for (key, value) in [
            ("KIMONO_SEMANTIC_CPU_PERCENT", "0"),
            ("KIMONO_SEMANTIC_MEMORY_PERCENT", "101"),
            ("KIMONO_SEMANTIC_WORKERS", "33"),
            ("KIMONO_SEMANTIC_BATCH", "257"),
            ("KIMONO_SEMANTIC_THREADS", "-1"),
            ("KIMONO_SEMANTIC_CPU_PERCENT", "80.5"),
        ] {
            assert!(
                plan_for(16, 32768, &[(key, value)]).is_err(),
                "{key}={value}"
            );
        }
    }

    #[test]
    fn accelerators_keep_one_session_and_auto_size_batches() {
        let runtime = plan(16, 8192 * MIB, 512 * MIB, 32 * MIB, "cuda", |_| None).unwrap();
        assert_eq!(runtime.workers, 1);
        assert!(runtime.batch > 8);
        assert!(runtime.resources.estimated_memory_bytes <= runtime.resources.memory_budget_bytes);
    }

    #[test]
    fn shared_model_weights_are_counted_once_across_workers() {
        let runtime = plan_with_shared(4, 4_000, 1_200, 400, 100, "cpu", |_| None).unwrap();
        assert_eq!(runtime.workers, 3);
        assert_eq!(
            runtime.resources.estimated_memory_bytes,
            1_200 + runtime.workers as u64 * (400 + 100 * runtime.batch as u64)
        );
        assert!(runtime.resources.estimated_memory_bytes <= runtime.resources.memory_budget_bytes);
        assert!(plan_with_shared(4, 4_000, 3_300, 400, 100, "cpu", |_| None).is_err());
    }

    #[test]
    fn container_headroom_restricts_host_memory() {
        let root = std::env::temp_dir().join(format!("kimono-cgroup-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let result = (|| -> Result<()> {
            fs::write(root.join("memory.max"), "4096")?;
            fs::write(root.join("memory.current"), "3072")?;
            assert_eq!(
                cgroup_headroom(&root, "memory.max", "memory.current", 16384)?,
                1024
            );
            assert_eq!(
                cgroup_headroom(&root, "memory.max", "memory.current", 512)?,
                512
            );
            fs::write(root.join("memory.max"), "max")?;
            assert_eq!(
                cgroup_headroom(&root, "memory.max", "memory.current", 8192)?,
                8192
            );
            fs::write(root.join("memory.max"), "1024")?;
            assert_eq!(
                cgroup_headroom(&root, "memory.max", "memory.current", 8192)?,
                0
            );
            fs::write(root.join("memory.max"), "invalid")?;
            assert!(cgroup_headroom(&root, "memory.max", "memory.current", 8192).is_err());
            Ok(())
        })();
        fs::remove_dir_all(&root).unwrap();
        result.unwrap();
    }
}
