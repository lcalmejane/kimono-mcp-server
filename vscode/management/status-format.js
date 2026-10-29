// Kimono live index status formatting, shared verbatim by the standalone VS Code
// extension, Tatami Agent and the Tatami Core web panel. Canonical source:
// kimono-mcp-server/vscode/management/status-format.js — keep copies identical.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KimonoStatus = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const labels = {
    en: {
      phases: { "not-indexed": "Not indexed yet", unknown: "Unknown", interrupted: "Interrupted", running: "Indexing",
        waiting: "Waiting for another indexer", ready: "Indexed", error: "Error", disabled: "Semantic search disabled" },
      stages: { checking_index: "checking freshness", reading_documents: "reading files", model_loading: "loading model",
        model_loaded: "model loaded", document_embedding: "embedding chunks", device_benchmark: "benchmarking CPU / accelerators",
        runtime_configured: "runtime configured", waiting_for_other_indexer: "another Kimono process holds the index" },
      files: "Files", tokens: "Tokens (est.)", chunks: "Chunks", rate: "Rate", chunksPerSecond: "chunks/s", eta: "ETA",
      finishing: "finishing", indexedAt: "Last indexed", detail: "Detail", locale: "en-US",
      partial: "Partially indexed", skipped: "Skipped chunks",
      provider: "Execution provider", benchmarks: "Startup benchmark", batch: "Last batch", failed: "failed",
      worker: "Persistent worker", workerPhases: { starting: "Starting", ready: "Ready · model warm", error: "Error",
        restarting: "Restarting", stopped: "Stopped", disabled: "Disabled" },
      workerError: "Worker detail", model: "Embedding model", sizing: "Runtime sizing",
      cpuBudget: "CPU budget", cpuUnit: "CPUs", memoryEstimate: "Estimated memory",
      workerUnit: "workers", threadUnit: "threads", batchUnit: "batch",
      hotIndexes: "Warm indexes", hotIndexMemory: "Warm index estimate",
    },
    fr: {
      phases: { "not-indexed": "Pas encore indexé", unknown: "Inconnu", interrupted: "Interrompu", running: "Indexation",
        waiting: "En attente d'un autre indexeur", ready: "Indexé", error: "Erreur", disabled: "Recherche sémantique désactivée" },
      stages: { checking_index: "vérification de la fraîcheur", reading_documents: "lecture des fichiers", model_loading: "chargement du modèle",
        model_loaded: "modèle chargé", document_embedding: "vectorisation des passages", device_benchmark: "comparaison CPU / accélérateurs",
        runtime_configured: "moteur configuré", waiting_for_other_indexer: "un autre processus Kimono tient l'index" },
      files: "Fichiers", tokens: "Tokens (est.)", chunks: "Passages", rate: "Débit", chunksPerSecond: "passages/s", eta: "Temps restant",
      finishing: "finalisation", indexedAt: "Dernière indexation", detail: "Détail", locale: "fr-FR",
      partial: "Indexation partielle", skipped: "Passages non vectorisés",
      provider: "Fournisseur d'exécution", benchmarks: "Mesure au démarrage", batch: "Dernier lot", failed: "échec",
      worker: "Worker persistant", workerPhases: { starting: "Démarrage", ready: "Prêt · modèle chargé", error: "Erreur",
        restarting: "Redémarrage", stopped: "Arrêté", disabled: "Désactivé" },
      workerError: "Détail du worker", model: "Modèle d'embedding", sizing: "Paramètres d'exécution",
      cpuBudget: "Budget CPU", cpuUnit: "cœurs CPU", memoryEstimate: "Mémoire estimée",
      workerUnit: "sessions", threadUnit: "threads", batchUnit: "taille de lot",
      hotIndexes: "Index gardés en mémoire", hotIndexMemory: "Mémoire des index (estim.)",
    },
  };
  const pick = language => labels[String(language || "en").slice(0, 2)] ?? labels.en;
  const count = value => value && Number.isFinite(value.completed) && Number.isFinite(value.total) ? value : undefined;
  const ratio = value => count(value) && value.total > 0 ? Math.min(1, value.completed / value.total) : undefined;
  const active = status => status?.phase === "running" || status?.phase === "waiting";

  function compact(number, language) {
    if (!Number.isFinite(number)) return "—";
    if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 0 : 1)}M`;
    if (number >= 1e4) return `${Math.round(number / 1e3)}k`;
    return number.toLocaleString(pick(language).locale);
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function bytes(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let amount = value, unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return `${unit ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
  }

  // Overall progress: reading files counts for 10%, embedding chunks for 90%.
  function overall(status) {
    if (status?.phase === "ready") return 1;
    const files = ratio(status?.files), embedded = ratio(status?.embedded ?? (status?.stage === "document_embedding" ? status.progress : undefined));
    if (embedded !== undefined) return 0.1 + 0.9 * embedded;
    if (files !== undefined) return 0.1 * files;
    return undefined;
  }

  function summarize(status, language) {
    const text = pick(language);
    const value = status ?? { phase: "unknown" };
    const progress = overall(value);
    const parts = [value.phase === "ready" && value.skippedChunks > 0 ? text.partial : text.phases[value.phase] ?? value.phase];
    if (value.phase === "running" && progress !== undefined) parts.push(`${Math.floor(progress * 100)}%`);
    if (active(value) && text.stages[value.stage]) parts.push(text.stages[value.stage]);
    if (value.phase === "running" && Number.isFinite(value.etaSeconds) && value.etaSeconds > 0) parts.push(`${text.eta} ${duration(value.etaSeconds)}`);
    return parts.join(" · ");
  }

  function lines(status, language) {
    const text = pick(language);
    const value = status ?? {};
    const result = [];
    const pair = (label, item) => { if (count(item)) result.push({ label, value: `${compact(item.completed, language)} / ${compact(item.total, language)}` }); };
    pair(text.files, value.files);
    pair(text.tokens, value.estimatedTokens);
    // Servers older than 0.6.2 only report `progress` (chunks being embedded).
    const embedded = value.embedded ?? (value.stage === "document_embedding" ? value.progress : undefined);
    if (value.phase === "running" || !Number.isFinite(value.chunks)) pair(text.chunks, embedded);
    else result.push({ label: text.chunks, value: compact(value.chunks, language) });
    if (Number.isFinite(value.skippedChunks) && value.skippedChunks > 0) result.push({ label: text.skipped, value: compact(value.skippedChunks, language) });
    if (value.worker && typeof value.worker.phase === "string" && Object.hasOwn(text.workerPhases, value.worker.phase)) {
      result.push({ label: text.worker, value: text.workerPhases[value.worker.phase] });
      if (value.worker.phase === "error" && value.worker.error) {
        result.push({ label: text.workerError, value: String(value.worker.error).slice(0, 300) });
      }
      if (Number.isFinite(value.hotIndexes)) result.push({ label: text.hotIndexes, value: compact(value.hotIndexes, language) });
      if (Number.isFinite(value.hotIndexEstimatedBytes)) {
        result.push({ label: text.hotIndexMemory, value: bytes(value.hotIndexEstimatedBytes) });
      }
    }
    if (typeof value.model === "string" && value.model) result.push({ label: text.model, value: value.model });
    if (value.runtime) {
      if ([value.runtime.workers, value.runtime.threads, value.runtime.batch].every(Number.isFinite)) {
        result.push({ label: text.sizing, value: `${value.runtime.workers} ${text.workerUnit} · ${value.runtime.threads} ${text.threadUnit} · ${value.runtime.batch} ${text.batchUnit}` });
      }
      const resources = value.runtime.resources;
      if (resources && Number.isFinite(resources.cpuBudget) && Number.isFinite(resources.availableCpus)
        && Number.isFinite(resources.cpuPercent)) {
        result.push({ label: text.cpuBudget, value: `${resources.cpuBudget} / ${resources.availableCpus} ${text.cpuUnit} (${resources.cpuPercent}%)` });
      }
      if (resources && Number.isFinite(resources.estimatedMemoryBytes) && Number.isFinite(resources.memoryBudgetBytes)
        && Number.isFinite(resources.memoryPercent)) {
        result.push({ label: text.memoryEstimate,
          value: `${bytes(resources.estimatedMemoryBytes)} / ${bytes(resources.memoryBudgetBytes)} (${resources.memoryPercent}%)` });
      }
    }
    if (value.phase === "running" && Number.isFinite(value.chunksPerSecond)) result.push({ label: text.rate, value: `${value.chunksPerSecond} ${text.chunksPerSecond}` });
    if (value.phase === "running" && Number.isFinite(value.batchMs)) result.push({ label: text.batch, value: `${value.batchMs} ms` });
    if (["cpu", "cuda", "coreml"].includes(value.runtime?.executionProvider)) {
      result.push({ label: text.provider, value: value.runtime.executionProvider.toUpperCase() });
      if (Array.isArray(value.runtime.benchmarks) && value.runtime.benchmarks.length) {
        result.push({ label: text.benchmarks, value: value.runtime.benchmarks.map(item =>
          `${String(item.executionProvider).toUpperCase()}: ${Number.isFinite(item.medianMs) ? `${Math.round(item.medianMs)} ms` : text.failed}`).join(" · ") });
      }
    }
    if (value.phase === "running" && Number.isFinite(value.etaSeconds)) result.push({ label: text.eta, value: value.etaSeconds > 0 ? duration(value.etaSeconds) : text.finishing });
    if (value.indexedAt) result.push({ label: text.indexedAt, value: new Date(value.indexedAt).toLocaleString(text.locale) });
    if (value.error && value.phase !== "ready") result.push({ label: text.detail, value: String(value.error).slice(0, 300) });
    return result;
  }

  // One view model for every Kimono panel: badge text, progress (0..1, null = indeterminate) and rows.
  function view(status, language) {
    const value = status ?? { phase: "unknown" };
    const progress = overall(value);
    return { phase: value.phase, active: active(value), summary: summarize(value, language),
      progress: progress ?? (active(value) ? null : 0), lines: lines(value, language) };
  }

  return { active, compact, duration, lines, overall, summarize, view };
}));
