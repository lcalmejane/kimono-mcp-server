import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { hostname, tmpdir } from 'node:os';
import type { AikidoKnowledgeBase, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';
import { within, type ChangeReport } from './synchronization.js';
import { IndexLockedError, indexInfos, processAlive, trackIndex } from './index-basis.js';
import { nativeDiagnostics } from './diagnostics.js';
import { semanticWorkerEnabled, semanticWorkerFor, semanticWorkerStatus, type SemanticWorkerStatus } from './semantic-worker.js';

export interface SemanticRuntime {
  executionProvider: 'cpu' | 'cuda' | 'coreml';
  gpuExecutionVerified: boolean;
  workers: number; threads: number; batch: number;
  resources?: {
    availableCpus: number; cpuPercent: number; cpuBudget: number;
    availableMemoryBytes: number; memoryPercent: number;
    memoryBudgetBytes: number; estimatedMemoryBytes: number;
  };
  benchmarks: Array<{ executionProvider: string; medianMs: number | null; error: string | null }>;
}

export interface SemanticResult {
  engine: 'embsearch-core';
  version: string;
  model: string;
  indexVersion?: string;
  chunkerVersion?: string;
  candidatesExamined?: number;
  hotIndexes?: number;
  hotIndexEstimatedBytes?: number;
  chunks: number;
  embedded: number;
  skippedChunks?: number;
  runtime?: SemanticRuntime;
  count: number;
  results: Array<SearchMatch & { score: number }>;
  changes: ChangeReport;
}

export interface EmbeddingResult {
  engine: 'embsearch-core';
  version: string;
  model: string;
  usage: 'query' | 'document';
  dimensions: number;
  normalized: boolean;
  maxTokens: number;
  vector: number[];
  runtime?: SemanticRuntime;
}

interface SemanticOptions {
  query?: string;
  vector?: number[];
  embeddingModel?: string;
  profile?: 'code';
  kind?: KnowledgeKind;
  limit?: number;
  paths?: string[];
  syncPaths?: string[];
  refreshed?: boolean;
}

interface Count { completed: number; total: number }
interface SemanticManifest {
  generation: string;
  model: string;
  indexVersion: string;
  documents: Record<string, string>;
  chunks: Record<string, unknown>;
  complete: boolean;
}
export interface SemanticStatus {
  phase: 'unknown' | 'running' | 'waiting' | 'ready' | 'error' | 'disabled';
  operation?: string; stage?: string; startedAt?: string; completedAt?: string; indexedAt?: string;
  progress?: Count; error?: string;
  chunks?: number; model?: string;
  hotIndexes?: number; hotIndexEstimatedBytes?: number;
  skippedChunks?: number;
  runtime?: SemanticRuntime;
  batchMs?: number;
  /** Live counters: corpus files read, estimated tokens (UTF-8 bytes / 4) and embedded chunks (nodes). */
  files?: Count; estimatedTokens?: Count; embedded?: Count;
  chunksPerSecond?: number; etaSeconds?: number; updatedAt?: string;
  source?: 'this-process' | 'another-process';
  worker?: SemanticWorkerStatus;
}

const estimateTokens = (bytes: number) => Math.ceil(bytes / 4);
const codeSource = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|py|rb|rs|scala|sh|swift|ts|tsx|vue)$/i;

function semanticBasisFingerprint(documents: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [file, digest] of Object.entries(documents).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([file, digest]));
  }
  return hash.digest('hex');
}

function codeProfileEnabled(): boolean {
  return process.env.KIMONO_CODE_PROFILE_ENABLED === 'true'
    && Boolean(process.env.KIMONO_CODE_MODEL_DIR);
}

export class SemanticIndex {
  private pending: Promise<unknown> = Promise.resolve();
  private state: SemanticStatus = { phase: 'unknown' };
  private persistedAt = 0;
  private embeddingStarted = 0;
  private retry: NodeJS.Timeout | undefined;
  constructor(private readonly knowledge: AikidoKnowledgeBase) {}

  /** Shared with other Kimono processes on the same ROOT and with the VS Code panel. */
  get statusFile(): string {
    return process.env.KIMONO_STATUS_FILE ?? path.join(this.knowledge.searchIndex.directory, 'semantic-status.json');
  }

  status(): SemanticStatus {
    const own = structuredClone(this.state);
    let status = own;
    if (own.phase !== 'running' && !this.knowledge.immutable) {
      const shared = this.readShared();
      if (shared?.phase === 'running' || shared?.phase === 'waiting') status = shared;
      else if (own.phase === 'unknown' && shared) status = shared;
    }
    const worker = this.workerStatus();
    if (worker) status = { ...status, worker };
    return status;
  }

  private workerStatus(): SemanticWorkerStatus | undefined {
    const model = process.env.KIMONO_MODEL_DIR;
    if (!model) return undefined;
    if (!semanticWorkerEnabled()) return { phase: 'disabled' };
    return semanticWorkerStatus(path.resolve(this.knowledge.root, model), process.env);
  }

  private readonly workerStatusChanged = (worker: SemanticWorkerStatus): void => this.persist(true, worker);

  private readShared(): SemanticStatus | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.statusFile, 'utf8'));
      if (!record(value) || typeof value.phase !== 'string' || value.pid === process.pid) return undefined;
      const { pid, host, ...status } = value;
      if ((status.phase === 'running' || status.phase === 'waiting') && (host !== hostname() || !processAlive(pid))) {
        return { ...status, phase: 'unknown', stage: 'interrupted', source: 'another-process' } as SemanticStatus;
      }
      return { ...status, source: 'another-process' } as SemanticStatus;
    } catch { return undefined; }
  }

  private update(next: SemanticStatus, force = true): void {
    this.state = next;
    this.persist(force);
  }

  private persist(force = true, worker = this.workerStatus()): void {
    if (this.knowledge.immutable) return;
    const now = Date.now();
    if (!force && now - this.persistedAt < 500) return;
    this.persistedAt = now;
    this.state.updatedAt = new Date(now).toISOString();
    const file = this.statusFile;
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(pending, JSON.stringify({ ...this.state, worker, source: undefined, pid: process.pid, host: hostname() }), { mode: 0o600 });
      renameSync(pending, file);
    } catch (error) {
      try { rmSync(pending, { force: true }); }
      catch (cleanupError) {
        console.error('Could not remove temporary semantic status file:',
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
      console.error('Could not publish semantic status:', error instanceof Error ? error.message : String(error));
    }
  }

  async idle(): Promise<void> { await this.pending; }

  warmup(): void {
    if (this.state.phase === 'running') return;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    if (!process.env.KIMONO_MODEL_DIR) {
      this.update({ phase: 'disabled', error: 'KIMONO_MODEL_DIR is not configured; semantic search is unavailable.' });
      return;
    }
    const startedAt = new Date().toISOString();
    this.update({ phase: 'running', operation: 'update', stage: 'checking_index', startedAt });
    const result = this.pending.then(async () => {
      try {
        const info = await indexInfos(this.knowledge);
        const semantic = info.indexes.semantic;
        if (record(semantic) && semantic.freshness === 'fresh') {
          const basis = record(semantic.basis) ? semantic.basis : undefined;
          const previous = this.readShared();
          const corpus = this.knowledge.corpusStatus;
          this.update({
            ...(previous?.phase === 'ready' ? previous : {}), source: undefined,
            phase: 'ready', operation: 'update', startedAt, completedAt: new Date().toISOString(),
            files: { completed: corpus.files, total: corpus.files },
            estimatedTokens: { completed: estimateTokens(corpus.bytes), total: estimateTokens(corpus.bytes) },
            ...(typeof basis?.indexedAt === 'string' ? { indexedAt: basis.indexedAt } : {}),
          });
          return;
        }
        await this.perform('update');
      } catch (error) {
        if (error instanceof IndexLockedError) {
          // Another Kimono process on this ROOT is writing: wait and re-check freshness instead of failing.
          this.update({ phase: 'waiting', operation: 'update', stage: 'waiting_for_other_indexer', startedAt, error: error.message });
          this.retry = setTimeout(() => { this.retry = undefined; this.warmup(); }, 2000);
          this.retry.unref();
          return;
        }
        this.update({ phase: 'error', operation: 'update', startedAt, completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
    this.pending = result.then(() => undefined, () => undefined);
    void result.catch(error => {
      console.error('Semantic index preparation failed:', error instanceof Error ? error.message : String(error));
    });
  }

  async seedFrom(source: SemanticIndex, fingerprint: string): Promise<boolean> {
    if (source.state.phase !== 'ready') return false;
    const copy = source.pending.then(async () => {
      const basis: unknown = JSON.parse(await readFile(path.join(source.knowledge.searchIndex.directory, 'semantic-basis.json'), 'utf8'));
      if (!record(basis) || basis.phase !== 'ready' || !record(basis.lastSuccessful)
        || basis.lastSuccessful.corpusFingerprint !== fingerprint) return false;
      const from = path.join(source.knowledge.searchIndex.directory, 'semantic');
      const to = path.join(this.knowledge.searchIndex.directory, 'semantic');
      const state: unknown = JSON.parse(await readFile(path.join(from, 'state.json'), 'utf8'));
      if (!record(state) || typeof state.generation !== 'string' || !/^store-[a-f0-9]{24}$/.test(state.generation)) {
        throw new Error('Invalid semantic cache generation');
      }
      await mkdir(to, { recursive: true, mode: 0o700 });
      await cp(path.join(from, state.generation), path.join(to, state.generation), { recursive: true });
      await writeFile(path.join(to, 'state.json'), JSON.stringify(state), { mode: 0o600 });
      this.state = { ...source.state };
      return true;
    });
    source.pending = copy.then(() => undefined, () => undefined);
    return copy;
  }

  async info(): Promise<Record<string, unknown>> {
    const model = process.env.KIMONO_MODEL_DIR;
    if (!model) throw new Error('Model introspection requires KIMONO_MODEL_DIR with a local ONNX model');
    const result = this.pending.then(async () => {
      const raw = await invokeSemantic({ operation: 'info', model }, this.knowledge.root, this.workerStatusChanged);
      if (!validModelInfo(raw)) {
        throw new Error('Invalid model introspection response');
      }
      this.state.runtime = readRuntime(raw.runtime);
      if (!codeProfileEnabled()) return raw;
      const codeModel = await invokeSemantic({ operation: 'info', model: process.env.KIMONO_CODE_MODEL_DIR },
        this.knowledge.root, this.workerStatusChanged);
      if (!validModelInfo(codeModel)) throw new Error('Invalid code model introspection response');
      return { ...raw, profiles: { multilingual: raw, code: codeModel } };
    });
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async embed(text: string, usage: 'query' | 'document' = 'query'): Promise<EmbeddingResult> {
    if (!text.trim() || Buffer.byteLength(text) > 32_768) throw new Error('text must be non-empty and at most 32768 UTF-8 bytes');
    if (usage !== 'query' && usage !== 'document') throw new Error('usage must be query or document');
    const model = process.env.KIMONO_MODEL_DIR;
    if (!model) throw new Error('Embedding requires KIMONO_MODEL_DIR with a local ONNX model');
    const result = this.pending.then(async () => {
      const raw = await invokeSemantic({ operation: 'embed', model, text, usage }, this.knowledge.root,
        this.workerStatusChanged);
      if (!record(raw) || raw.engine !== 'embsearch-core' || typeof raw.version !== 'string'
        || typeof raw.model !== 'string' || raw.usage !== usage || typeof raw.normalized !== 'boolean'
        || typeof raw.dimensions !== 'number' || !Number.isSafeInteger(raw.dimensions) || raw.dimensions < 1
        || typeof raw.maxTokens !== 'number' || !Number.isSafeInteger(raw.maxTokens) || raw.maxTokens < 1
        || !Array.isArray(raw.vector) || raw.vector.length !== raw.dimensions
        || !raw.vector.every((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('Invalid embedding engine response');
      }
      return { engine: 'embsearch-core' as const, version: raw.version, model: raw.model, usage,
        dimensions: raw.dimensions, normalized: raw.normalized, maxTokens: raw.maxTokens, vector: raw.vector,
        ...(raw.runtime ? { runtime: readRuntime(raw.runtime) } : {}) };
    });
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  async run(
    operation: 'search' | 'update' | 'rebuild' | 'compact' | 'stats',
    options: SemanticOptions = {},
  ): Promise<SemanticResult> {
    const result = this.pending.then(() => this.performProfiles(operation, options));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performProfiles(
    operation: 'search' | 'update' | 'rebuild' | 'compact' | 'stats',
    options: SemanticOptions,
  ): Promise<SemanticResult> {
    const enabled = codeProfileEnabled();
    if (options.profile === 'code' && !enabled) {
      throw new Error('The code embedding profile is paused; explicitly set KIMONO_CODE_PROFILE_ENABLED=true to enable it.');
    }
    if (options.profile || !enabled || options.vector) {
      return this.perform(operation, options);
    }

    const document = await this.perform(operation, options);
    const code = await this.perform(operation, {
      ...options,
      profile: 'code',
      refreshed: operation === 'search' ? options.refreshed : true,
      ...(operation === 'search' ? {
        paths: this.knowledge.list().filter(entry => codeSource.test(entry.path)
          && (!options.kind || entry.kind === options.kind)
          && (!options.paths || options.paths.includes(entry.path))).map(entry => entry.path),
      } : {}),
    });
    const fused = new Map<string, SemanticResult['results'][number]>();
    for (const profile of [document, code]) {
      profile.results.forEach((result, rank) => {
        const key = `${result.path}:${result.line}`;
        const prior = fused.get(key);
        fused.set(key, { ...result, score: (prior?.score ?? 0) + 1 / (60 + rank + 1) });
      });
    }
    const results = [...fused.values()].sort((a, b) => b.score - a.score
      || a.path.localeCompare(b.path) || a.line - b.line).slice(0, options.limit ?? 25);
    const unique = (values: string[]) => [...new Set(values)].sort();
    const combined: SemanticResult = {
      ...document,
      model: `${document.model}+${code.model}`,
      version: `${document.version}+${code.version}`,
      chunks: document.chunks + code.chunks,
      embedded: document.embedded + code.embedded,
      count: results.length,
      results,
      changes: {
        added: unique([...document.changes.added, ...code.changes.added]),
        modified: unique([...document.changes.modified, ...code.changes.modified]),
        deleted: unique([...document.changes.deleted, ...code.changes.deleted]),
      },
    };
    this.state = { ...this.state, model: combined.model, chunks: combined.chunks };
    if (operation !== 'search' && operation !== 'stats') this.persist();
    return combined;
  }

  private async perform(operation: 'search' | 'update' | 'rebuild' | 'compact' | 'stats',
    options: SemanticOptions = {}): Promise<SemanticResult> {
    const startedAt = new Date().toISOString();
    const tracked = operation !== 'search' && operation !== 'stats';
    const maintenance = operation === 'update' || operation === 'rebuild' || operation === 'compact';
    const previous = this.state;
    this.state = { phase: 'running', operation, stage: operation, startedAt };
    if (tracked) this.persist();
    try {
      const output = maintenance
        ? options.profile
          ? await this.execute(operation, options)
          : await trackIndex(this.knowledge, 'semantic', options.syncPaths,
            (observed, reusableFingerprint, reusableDocuments) =>
              this.execute(operation, options, observed, reusableFingerprint, reusableDocuments))
        : await this.execute(operation, options);
      if (tracked) {
        const corpus = this.knowledge.corpusStatus;
        this.update({ ...this.state, phase: 'ready', completedAt: new Date().toISOString(),
          indexedAt: new Date().toISOString(), chunks: output.chunks, model: output.model,
          ...(output.hotIndexes !== undefined ? { hotIndexes: output.hotIndexes } : {}),
          ...(output.hotIndexEstimatedBytes !== undefined ? { hotIndexEstimatedBytes: output.hotIndexEstimatedBytes } : {}),
          skippedChunks: output.skippedChunks ?? 0, etaSeconds: 0,
          files: { completed: corpus.files, total: corpus.files },
          estimatedTokens: { completed: estimateTokens(corpus.bytes), total: estimateTokens(corpus.bytes) },
          embedded: { completed: output.chunks, total: output.chunks } });
      } else {
        this.state = { ...(previous.phase === 'ready' ? previous : {}), ...this.state, phase: 'ready',
          completedAt: new Date().toISOString(), chunks: output.chunks, model: output.model,
          ...(output.hotIndexes !== undefined ? { hotIndexes: output.hotIndexes } : {}),
          ...(output.hotIndexEstimatedBytes !== undefined ? { hotIndexEstimatedBytes: output.hotIndexEstimatedBytes } : {}) };
        if (output.hotIndexes !== undefined && (output.hotIndexes !== previous.hotIndexes
          || output.hotIndexEstimatedBytes !== previous.hotIndexEstimatedBytes)) this.persist();
      }
      return output;
    } catch (error) {
      const next: SemanticStatus = { ...this.state, phase: 'error', completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error) };
      if (tracked) this.update(next); else this.state = next;
      throw error;
    }
  }

  private async execute(
    operation: string,
    options: SemanticOptions,
    observed?: (fingerprint: string, partial?: boolean) => void,
    reusableFingerprint?: string,
    reusableDocuments?: Record<string, string>,
  ): Promise<SemanticResult> {
    const model = options.profile === 'code' ? process.env.KIMONO_CODE_MODEL_DIR : process.env.KIMONO_MODEL_DIR;
    if (!model) throw new Error(options.profile === 'code'
      ? 'Code semantic search requires KIMONO_CODE_MODEL_DIR with model.onnx, tokenizer.json and model.json.'
      : 'Semantic search requires KIMONO_MODEL_DIR with model.onnx, tokenizer.json and model.json. Use the Kimono Docker image or install a local model.');
    const maintenance = operation === 'update' || operation === 'rebuild' || operation === 'compact';
    const parent = this.knowledge.searchIndex.directory;
    const cache = path.join(parent, options.profile === 'code' ? 'semantic-code' : 'semantic');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const knowledge = this.knowledge;
    const tracked = maintenance;
    let profileFingerprint: string | undefined;
    let manifest: SemanticManifest | undefined;
    if (operation === 'update') {
      const profile = await invokeSemantic({ operation: 'profile', model, cache }, this.knowledge.root,
        this.workerStatusChanged);
      if (!record(profile) || profile.engine !== 'embsearch-core' || typeof profile.fingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(profile.fingerprint)) throw new Error('Invalid semantic model profile response');
      profileFingerprint = profile.fingerprint;
      manifest = await readSemanticManifest(cache);
    }

    const expectedPaths = operation === 'update' && reusableFingerprint !== undefined
      && knowledge.isInitialized && !options.profile
      ? knowledge.list().filter(entry => within(entry.path, options.syncPaths)
        && (options.profile !== 'code' || codeSource.test(entry.path)))
        .map(entry => entry.path).sort()
      : undefined;
    const manifestPaths = manifest ? Object.keys(manifest.documents).sort() : undefined;
    let raw: unknown;
    const reusedFreshIndex = operation === 'update' && reusableFingerprint !== undefined
      && !options.profile && !options.syncPaths && manifest?.complete === true
      && manifest.model === profileFingerprint && manifest.generation !== ''
      && expectedPaths !== undefined && manifestPaths !== undefined
      && expectedPaths.length === manifestPaths.length
      && expectedPaths.every((file, index) => file === manifestPaths[index]);
    if (reusedFreshIndex) {
      observed?.(reusableFingerprint);
      raw = await invokeSemantic({ operation: 'stats', model, cache }, this.knowledge.root, this.workerStatusChanged);
    } else {
      if (maintenance && !options.refreshed) await knowledge.refresh(options.syncPaths);
    }
    if (operation === 'search' && knowledge.immutable) {
      try {
        await readFile(path.join(cache, 'state.json'), 'utf8');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        await this.execute('update', { ...options, refreshed: true });
      }
    }
    const selected = knowledge.list().filter(entry => within(entry.path, options.syncPaths))
      .filter(entry => options.profile !== 'code' || codeSource.test(entry.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    let incremental = reusedFreshIndex;
    let deletedPaths: string[] = [];
    let previousDocuments: Record<string, string> = {};
    if (operation === 'update' && !reusedFreshIndex) {
      if (manifest?.complete && manifest.model === profileFingerprint && manifest.generation
        && Object.values(manifest.documents).every(value => /^[a-f0-9]{64}$/.test(value))) {
        incremental = true;
        previousDocuments = manifest.documents;
        const selectedPaths = new Set(selected.map(entry => entry.path));
        deletedPaths = Object.keys(previousDocuments).filter(file => within(file, options.syncPaths)
          && !selectedPaths.has(file));
      }
    }
    const selectedPaths = new Set(selected.map(entry => entry.path));
    const reusableDocumentFingerprints = incremental && reusableDocuments
      ? Object.fromEntries(Object.entries(reusableDocuments)
        .filter(([file, digest]) => selectedPaths.has(file)
          && previousDocuments[file] === digest))
      : {};
    if (tracked && !reusedFreshIndex) {
      const corpusBytes = options.syncPaths ? 0 : knowledge.corpusStatus.bytes;
      this.state.stage = 'reading_documents';
      this.state.files = { completed: 0, total: selected.length };
      this.state.estimatedTokens = { completed: 0, total: estimateTokens(corpusBytes) };
      this.persist();
    }
    const counted = (bytes: number) => {
      if (!tracked || !this.state.files || !this.state.estimatedTokens) return;
      this.state.files.completed++;
      this.state.estimatedTokens.completed += estimateTokens(bytes);
      this.state.estimatedTokens.total = Math.max(this.state.estimatedTokens.total, this.state.estimatedTokens.completed);
      this.persist(false);
    };
    let indexedFingerprint: string | undefined;
    let readSkipped = false;
    async function* documents() {
      let bytes = 0;
      const currentDocuments: Record<string, string> = {};
      for (const entry of selected) {
        const reusable = reusableDocumentFingerprints[entry.path];
        if (reusable) {
          currentDocuments[entry.path] = reusable;
          counted(0);
          continue;
        }
        // An unreadable document is traced and skipped; it must not abort the whole run.
        const document = await knowledge.tryRead(entry.id);
        if (!document) { readSkipped = true; counted(0); continue; }
        const { content } = document;
        const size = Buffer.byteLength(content);
        bytes += size;
        counted(size);
        if (bytes > knowledge.config.maxCorpusBytes) throw new Error('Semantic corpus exceeds maxCorpusBytes; narrow include/exclude in the host config.');
        const digest = createHash('sha256').update(JSON.stringify([entry.kind, content])).digest('hex');
        currentDocuments[entry.path] = digest;
        if (incremental && previousDocuments[entry.path] === digest) continue;
        yield { path: entry.path, kind: entry.kind, content };
      }
      indexedFingerprint = semanticBasisFingerprint(currentDocuments);
    }
    const payload = {
      operation, model, cache,
      ...(operation === 'update' ? { incremental, deletedPaths } : {}),
      ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'profile')),
    };
    if (!reusedFreshIndex) {
      raw = await invokeSemantic(payload, this.knowledge.root, this.workerStatusChanged, (progress) => {
        if (progress.stage === 'document_embedding' && this.state.stage === progress.stage
          && (this.state.progress?.completed ?? 0) > progress.completed) return;
        this.state.progress = { completed: progress.completed, total: progress.total };
        if (progress.stage) this.state.stage = progress.stage;
        if (progress.runtime) this.state.runtime = progress.runtime;
        if (progress.batchMs !== undefined) this.state.batchMs = progress.batchMs;
        if (tracked && progress.stage !== 'document_embedding') this.persist(false);
        if (!tracked || progress.stage !== 'document_embedding') return;
        if (progress.completed === 0 || !this.embeddingStarted) this.embeddingStarted = Date.now();
        this.state.embedded = { completed: progress.completed, total: progress.total };
        const seconds = (Date.now() - this.embeddingStarted) / 1000;
        if (progress.completed > 0 && seconds > 0) {
          const rate = progress.completed / seconds;
          this.state.chunksPerSecond = Math.round(rate * 10) / 10;
          this.state.etaSeconds = Math.ceil((progress.total - progress.completed) / rate);
        }
        this.persist(progress.completed === progress.total);
      }, operation === 'search' ? 60_000 : 3_600_000, maintenance ? documents() : undefined);
    }
    if (!record(raw) || raw.engine !== 'embsearch-core' || typeof raw.model !== 'string'
      || typeof raw.version !== 'string' || typeof raw.chunks !== 'number'
      || !Number.isSafeInteger(raw.chunks) || raw.chunks < 0 || typeof raw.embedded !== 'number'
      || !Number.isSafeInteger(raw.embedded) || raw.embedded < 0 || raw.embedded > raw.chunks
      || !Array.isArray(raw.results) || raw.count !== raw.results.length) throw new Error('Invalid semantic engine response');
    const skippedChunks = raw.skippedChunks ?? 0;
    const runtime = readRuntime(raw.runtime);
    if (runtime) this.state.runtime = runtime;
    if (typeof skippedChunks !== 'number' || !Number.isSafeInteger(skippedChunks) || skippedChunks < 0) {
      throw new Error('Invalid semantic skipped chunk count');
    }
    if (skippedChunks > 0) console.error(`Kimono: ${skippedChunks} semantic passages could not be embedded; lexical and metadata retrieval remain available`);
    if (indexedFingerprint) observed?.(indexedFingerprint, skippedChunks > 0 || readSkipped);
    const results: SemanticResult['results'] = raw.results.map((hit: unknown) => {
      if (!record(hit) || typeof hit.path !== 'string' || !Number.isInteger(hit.line)
        || typeof hit.line !== 'number' || hit.line < 1 || typeof hit.score !== 'number'
        || !Number.isFinite(hit.score) || typeof hit.excerpt !== 'string') throw new Error('Invalid semantic hit');
      const entry = this.knowledge.list(options.kind).find((item) => item.path === hit.path && (!options.paths || options.paths.includes(item.path)));
      if (!entry) throw new Error(`Semantic engine returned an out-of-scope document: ${hit.path}`);
      return { ...entry, line: hit.line, score: hit.score, excerpt: hit.excerpt };
    });
    if (results.length > (options.limit ?? 25)) throw new Error('Semantic engine exceeded the result limit');
    const changes = changeReport(raw.changes, options.syncPaths);
    if ((raw.indexVersion !== undefined && typeof raw.indexVersion !== 'string')
      || (raw.chunkerVersion !== undefined && typeof raw.chunkerVersion !== 'string')
      || (raw.candidatesExamined !== undefined && (!Number.isSafeInteger(raw.candidatesExamined)
        || Number(raw.candidatesExamined) < 0 || Number(raw.candidatesExamined) > 4096))
      || (raw.hotIndexes !== undefined && (!Number.isSafeInteger(raw.hotIndexes)
        || Number(raw.hotIndexes) < 0 || Number(raw.hotIndexes) > 4))
      || (raw.hotIndexEstimatedBytes !== undefined && (!Number.isSafeInteger(raw.hotIndexEstimatedBytes)
        || Number(raw.hotIndexEstimatedBytes) < 0 || Number(raw.hotIndexEstimatedBytes) > 512 * 1024 * 1024))) {
      throw new Error('Invalid semantic index diagnostics');
    }
    return {
      engine: 'embsearch-core', model: raw.model, version: raw.version,
      chunks: raw.chunks, embedded: raw.embedded, count: results.length, results,
      ...(typeof raw.indexVersion === 'string' ? { indexVersion: raw.indexVersion } : {}),
      ...(typeof raw.chunkerVersion === 'string' ? { chunkerVersion: raw.chunkerVersion } : {}),
      ...(typeof raw.candidatesExamined === 'number' ? { candidatesExamined: raw.candidatesExamined } : {}),
      ...(typeof raw.hotIndexes === 'number' ? { hotIndexes: raw.hotIndexes } : {}),
      ...(typeof raw.hotIndexEstimatedBytes === 'number' ? { hotIndexEstimatedBytes: raw.hotIndexEstimatedBytes } : {}),
      ...(raw.skippedChunks !== undefined ? { skippedChunks } : {}),
      ...(runtime ? { runtime } : {}),
      changes,
    };
  }
}

const runtimeSelections = new Map<string, Promise<SemanticRuntime | undefined>>();

async function invokeSemantic(
  payload: Record<string, unknown>, cwd: string,
  onWorkerStatus?: (status: SemanticWorkerStatus) => void,
  progress?: (value: { completed: number; total: number; stage?: string; batchMs?: number; runtime?: SemanticRuntime }) => void,
  timeout = 60_000,
  documents?: AsyncIterable<{ path: string; kind: string; content: string }>,
): Promise<unknown> {
  const diagnostics = nativeDiagnostics();
  const workingDirectoryExists = await stat(cwd).then(info => {
    if (!info.isDirectory()) throw new Error(`Semantic working directory is not a directory: ${cwd}`);
    return true;
  }).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  });
  const workingDirectory = workingDirectoryExists ? cwd : process.cwd();
  const temporary = await mkdtemp(path.join(tmpdir(), 'kimono-semantic-request-'));
  let finishSelection: ((value: SemanticRuntime | undefined) => void) | undefined;
  const useWorker = semanticWorkerEnabled();
  const workerModel = typeof payload.model === 'string' ? path.resolve(cwd, payload.model) : undefined;
  const requestPayload = (useWorker || !workingDirectoryExists) && workerModel
    ? { ...payload, model: workerModel } : payload;
  const key = JSON.stringify([requestPayload.model, ...['KIMONO_SEMANTIC_BIN', 'ORT_DYLIB_PATH',
    'KIMONO_SEMANTIC_WORKERS', 'KIMONO_SEMANTIC_THREADS', 'KIMONO_SEMANTIC_BATCH',
    'KIMONO_SEMANTIC_CPU_PERCENT', 'KIMONO_SEMANTIC_MEMORY_PERCENT'].map(name => process.env[name])]);
  try {
    const request = path.join(temporary, 'request.json');
    if (documents) {
      const handle = await open(request, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(requestPayload).slice(0, -1)},"documents":[`);
        let first = true;
        for await (const document of documents) {
          await handle.writeFile(`${first ? '' : ','}${JSON.stringify(document)}`);
          first = false;
        }
        await handle.writeFile(']}');
      } finally { await handle.close(); }
    } else await writeFile(request, JSON.stringify(requestPayload), { mode: 0o600 });
    let stderrBuffer = '';
    const handleStderr = (chunk: string) => {
      stderrBuffer += chunk;
      let newline: number;
      while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        diagnostics.line(line);
        if (!line.startsWith('KIMONO_PROGRESS ')) continue;
        try {
          const value: unknown = JSON.parse(line.slice(16));
          if (record(value) && typeof value.completed === 'number' && typeof value.total === 'number'
            && Number.isSafeInteger(value.completed) && Number.isSafeInteger(value.total)
            && value.completed >= 0 && value.total >= value.completed) {
            progress?.({ completed: value.completed, total: value.total,
              ...(value.runtime ? { runtime: readRuntime(value.runtime) } : {}),
              ...(typeof value.batchMs === 'number' && Number.isFinite(value.batchMs) && value.batchMs >= 0
                ? { batchMs: value.batchMs } : {}),
              ...(typeof value.phase === 'string' ? { stage: value.phase.slice(0, 64) } : {}) });
          } else console.error('Invalid semantic progress event');
        } catch (error) {
          console.error('Invalid semantic progress JSON:', error instanceof Error ? error.message : String(error));
        }
      }
      if (stderrBuffer.length > 64 * 1024) {
        stderrBuffer = '';
        console.error('Kimono: oversized semantic diagnostic line omitted');
      }
    };
    const automatic = !process.env.KIMONO_SEMANTIC_DEVICE || process.env.KIMONO_SEMANTIC_DEVICE === 'auto';
    let selected: SemanticRuntime | undefined;
    if (!useWorker) {
      while (automatic && runtimeSelections.has(key)) {
        selected = await runtimeSelections.get(key);
        if (selected) break;
      }
      if (automatic && !selected) {
        runtimeSelections.set(key, new Promise(resolve => { finishSelection = resolve; }));
      }
    }
    let raw: unknown;
    if (useWorker) {
      if (!workerModel) throw new Error('Persistent semantic worker requires a model directory');
      const worker = semanticWorkerFor(workerModel, workingDirectory, process.env, onWorkerStatus);
      raw = await worker.request(request, automatic && !worker.ready ? Math.max(timeout, 120_000) : timeout, handleStderr);
    } else {
      const response = await runProcess(process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic',
        [request], workingDirectory, [0], automatic && !selected ? Math.max(timeout, 120_000) : timeout, handleStderr,
        selected ? { ...process.env, KIMONO_SEMANTIC_DEVICE: selected.executionProvider } : process.env,
        4 * 1024 * 1024, true);
      raw = JSON.parse(response.stdout);
    }
    if (record(raw)) {
      const runtime = readRuntime(raw.runtime);
      if (runtime) {
        if (selected) runtime.benchmarks = selected.benchmarks;
        raw.runtime = runtime;
        finishSelection?.(runtime);
        finishSelection = undefined;
      }
    }
    return raw;
  } finally {
    diagnostics.flush();
    if (finishSelection) {
      runtimeSelections.delete(key);
      finishSelection(undefined);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

function readRuntime(value: unknown): SemanticRuntime | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !['cpu', 'cuda', 'coreml'].includes(String(value.executionProvider))
    || typeof value.gpuExecutionVerified !== 'boolean'
    || ![value.workers, value.threads, value.batch].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count > 0)
    || !Array.isArray(value.benchmarks)) throw new Error('Invalid semantic runtime response');
  const benchmarks = value.benchmarks.map((item: unknown) => {
    if (!record(item) || !['cpu', 'cuda', 'coreml'].includes(String(item.executionProvider))
      || !(item.medianMs === null || typeof item.medianMs === 'number' && Number.isFinite(item.medianMs) && item.medianMs > 0)
      || !(item.error === null || typeof item.error === 'string')
      || (item.medianMs === null) === (item.error === null)) throw new Error('Invalid semantic device benchmark');
    return { executionProvider: String(item.executionProvider), medianMs: item.medianMs, error: item.error };
  });
  let resources: SemanticRuntime['resources'];
  if (value.resources !== undefined) {
    const raw = value.resources;
    const keys = ['availableCpus', 'cpuPercent', 'cpuBudget', 'availableMemoryBytes',
      'memoryPercent', 'memoryBudgetBytes', 'estimatedMemoryBytes'];
    if (!record(raw) || !keys.every(key => typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] > 0)
      || Number(raw.cpuPercent) > 100 || Number(raw.memoryPercent) > 100
      || Number(raw.estimatedMemoryBytes) > Number(raw.memoryBudgetBytes)
      || Number(raw.memoryBudgetBytes) > Number(raw.availableMemoryBytes)) throw new Error('Invalid semantic resource budget');
    resources = {
      availableCpus: Number(raw.availableCpus), cpuPercent: Number(raw.cpuPercent), cpuBudget: Number(raw.cpuBudget),
      availableMemoryBytes: Number(raw.availableMemoryBytes), memoryPercent: Number(raw.memoryPercent),
      memoryBudgetBytes: Number(raw.memoryBudgetBytes), estimatedMemoryBytes: Number(raw.estimatedMemoryBytes),
    };
  }
  return { executionProvider: value.executionProvider as SemanticRuntime['executionProvider'],
    gpuExecutionVerified: value.gpuExecutionVerified, workers: Number(value.workers),
    threads: Number(value.threads), batch: Number(value.batch), benchmarks,
    ...(resources ? { resources } : {}) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validModelInfo(value: unknown): value is Record<string, unknown> {
  if (!record(value) || value.engine !== 'embsearch-core' || typeof value.version !== 'string'
    || typeof value.model !== 'string' || typeof value.name !== 'string'
    || typeof value.dimensions !== 'number' || !Number.isSafeInteger(value.dimensions) || value.dimensions < 1
    || typeof value.normalized !== 'boolean' || typeof value.maxTokens !== 'number'
    || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1
    || !['mean', 'cls'].includes(String(value.pooling))
    || !(value.queryPrefix === null || typeof value.queryPrefix === 'string')
    || !(value.documentPrefix === null || typeof value.documentPrefix === 'string')
    || typeof value.compatibility !== 'string' || !record(value.sha256)) return false;
  for (const file of ['model.onnx', 'tokenizer.json', 'model.json']) {
    const digest = value.sha256[file];
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return false;
  }
  return true;
}

async function readSemanticManifest(cache: string): Promise<SemanticManifest | undefined> {
  let contents: string;
  try { contents = await readFile(path.join(cache, 'state.json'), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch (error) { throw new Error('Invalid semantic index manifest JSON', { cause: error }); }
  if (!record(value) || typeof value.generation !== 'string'
    || value.generation !== '' && !/^store-[a-f0-9]{24}$/.test(value.generation)
    || typeof value.model !== 'string' || !/^[a-f0-9]{64}$/.test(value.model)
    || typeof value.index_version !== 'string' || !value.index_version
    || !record(value.documents) || !record(value.chunks)) {
    throw new Error('Invalid semantic index manifest');
  }
  const documents: Record<string, string> = {};
  for (const [file, digest] of Object.entries(value.documents)) {
    if (!file || path.posix.isAbsolute(file) || /[\\\0\r\n]/.test(file)
      || file.split('/').some(part => !part || part === '.' || part === '..')
      || typeof digest !== 'string') throw new Error('Invalid semantic document manifest');
    documents[file] = digest;
  }
  for (const [id, chunk] of Object.entries(value.chunks)) {
    if (!record(chunk) || typeof chunk.path !== 'string' || !chunk.path
      || path.posix.isAbsolute(chunk.path) || /[\\\0\r\n]/.test(chunk.path)
      || chunk.path.split('/').some(part => !part || part === '.' || part === '..')
      || !id.startsWith(`${chunk.path}#`) || !/^\d+$/.test(id.slice(chunk.path.length + 1))
      || typeof chunk.kind !== 'string' || !chunk.kind || typeof chunk.line !== 'number'
      || !Number.isSafeInteger(chunk.line) || chunk.line < 1 || typeof chunk.text !== 'string'
      || typeof chunk.hash !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.hash)) {
      throw new Error('Invalid semantic chunk manifest');
    }
  }
  const complete = Object.values(value.chunks).every(chunk =>
    record(chunk) && /^[a-f0-9]{64}$/.test(documents[String(chunk.path)] ?? ''));
  return {
    generation: value.generation, model: value.model, indexVersion: value.index_version,
    documents, chunks: value.chunks, complete,
  };
}

function changeReport(value: unknown, scopes?: string[]): ChangeReport {
  if (!record(value)) throw new Error('Invalid semantic synchronization report');
  for (const key of ['added', 'modified', 'deleted']) {
    const files = value[key];
    if (!Array.isArray(files) || !files.every(file => typeof file === 'string' && file
      && !path.isAbsolute(file) && !/[\\\0\r\n]/.test(file)
      && !file.split('/').some(part => !part || part === '..' || part === '.')
      && within(file, scopes))) throw new Error('Invalid semantic synchronization report');
  }
  return { added: value.added as string[], modified: value.modified as string[], deleted: value.deleted as string[] };
}
