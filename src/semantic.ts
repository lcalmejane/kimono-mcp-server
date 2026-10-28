import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { hostname, tmpdir } from 'node:os';
import type { AikidoKnowledgeBase, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';
import { within, type ChangeReport } from './synchronization.js';
import { IndexLockedError, indexInfos, processAlive, trackIndex } from './index-basis.js';
import { nativeDiagnostics } from './diagnostics.js';

export interface SemanticRuntime {
  executionProvider: 'cpu' | 'cuda' | 'coreml';
  gpuExecutionVerified: boolean;
  workers: number; threads: number; batch: number;
  benchmarks: Array<{ executionProvider: string; medianMs: number | null; error: string | null }>;
}

export interface SemanticResult {
  engine: 'embsearch-core';
  version: string;
  model: string;
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
  kind?: KnowledgeKind;
  limit?: number;
  paths?: string[];
  syncPaths?: string[];
  refreshed?: boolean;
}

interface Count { completed: number; total: number }
export interface SemanticStatus {
  phase: 'unknown' | 'running' | 'waiting' | 'ready' | 'error' | 'disabled';
  operation?: string; stage?: string; startedAt?: string; completedAt?: string; indexedAt?: string;
  progress?: Count; error?: string;
  chunks?: number; model?: string;
  skippedChunks?: number;
  runtime?: SemanticRuntime;
  batchMs?: number;
  /** Live counters: corpus files read, estimated tokens (UTF-8 bytes / 4) and embedded chunks (nodes). */
  files?: Count; estimatedTokens?: Count; embedded?: Count;
  chunksPerSecond?: number; etaSeconds?: number; updatedAt?: string;
  source?: 'this-process' | 'another-process';
}

const estimateTokens = (bytes: number) => Math.ceil(bytes / 4);

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
    if (own.phase === 'running' || this.knowledge.immutable) return own;
    const shared = this.readShared();
    if (shared?.phase === 'running' || shared?.phase === 'waiting') return shared;
    return own.phase === 'unknown' && shared ? shared : own;
  }

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

  private persist(force = true): void {
    if (this.knowledge.immutable) return;
    const now = Date.now();
    if (!force && now - this.persistedAt < 500) return;
    this.persistedAt = now;
    this.state.updatedAt = new Date(now).toISOString();
    const file = this.statusFile;
    const pending = `${file}.${randomUUID()}.pending`;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(pending, JSON.stringify({ ...this.state, source: undefined, pid: process.pid, host: hostname() }), { mode: 0o600 });
      renameSync(pending, file);
    } catch {
      rmSync(pending, { force: true });
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
      const raw = await invokeSemantic({ operation: 'info', model }, tmpdir(), tmpdir());
      if (!record(raw) || raw.engine !== 'embsearch-core' || typeof raw.version !== 'string'
        || typeof raw.model !== 'string' || typeof raw.name !== 'string'
        || typeof raw.dimensions !== 'number' || !Number.isSafeInteger(raw.dimensions) || raw.dimensions < 1
        || typeof raw.normalized !== 'boolean' || typeof raw.maxTokens !== 'number'
        || !Number.isSafeInteger(raw.maxTokens) || raw.maxTokens < 1
        || !['mean', 'cls'].includes(String(raw.pooling))
        || !(raw.queryPrefix === null || typeof raw.queryPrefix === 'string')
        || !(raw.documentPrefix === null || typeof raw.documentPrefix === 'string')
        || typeof raw.compatibility !== 'string' || !record(raw.sha256)) {
        throw new Error('Invalid model introspection response');
      }
      for (const file of ['model.onnx', 'tokenizer.json', 'model.json']) {
        const digest = raw.sha256[file];
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid model file fingerprint');
      }
      this.state.runtime = readRuntime(raw.runtime);
      return raw;
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
      const raw = await invokeSemantic({ operation: 'embed', model, text, usage }, tmpdir(), tmpdir());
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
    const result = this.pending.then(() => this.perform(operation, options));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async perform(operation: 'search' | 'update' | 'rebuild' | 'compact' | 'stats',
    options: SemanticOptions = {}): Promise<SemanticResult> {
    const startedAt = new Date().toISOString();
    const tracked = operation !== 'search' && operation !== 'stats';
    const previous = this.state;
    this.state = { phase: 'running', operation, stage: operation, startedAt };
    if (tracked) this.persist();
    try {
      const output = this.knowledge.immutable && operation === 'search'
        ? await this.execute(operation, options)
        : await trackIndex(this.knowledge, 'semantic', options.syncPaths, observed => this.execute(operation, options, observed));
      if (tracked) {
        const corpus = this.knowledge.corpusStatus;
        this.update({ ...this.state, phase: 'ready', completedAt: new Date().toISOString(),
          indexedAt: new Date().toISOString(), chunks: output.chunks, model: output.model,
          skippedChunks: output.skippedChunks ?? 0, etaSeconds: 0,
          files: { completed: corpus.files, total: corpus.files },
          estimatedTokens: { completed: estimateTokens(corpus.bytes), total: estimateTokens(corpus.bytes) },
          embedded: { completed: output.chunks, total: output.chunks } });
      } else {
        this.state = { ...(previous.phase === 'ready' ? previous : {}), ...this.state, phase: 'ready',
          completedAt: new Date().toISOString(), chunks: output.chunks, model: output.model };
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
  ): Promise<SemanticResult> {
    const model = process.env.KIMONO_MODEL_DIR;
    if (!model) throw new Error('Semantic search requires KIMONO_MODEL_DIR with model.onnx, tokenizer.json and model.json. Use the Kimono Docker image or install a local model.');
    if (!options.refreshed) await this.knowledge.refresh(options.syncPaths);
    const parent = this.knowledge.searchIndex.directory;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const knowledge = this.knowledge;
    const tracked = operation !== 'search' && operation !== 'stats';
    const selected = knowledge.list().filter(entry => within(entry.path, options.syncPaths))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (tracked) {
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
    async function* documents() {
      const fingerprint = createHash('sha256');
      let bytes = 0;
      for (const entry of selected) {
        // An unreadable document is traced and skipped; it must not abort the whole run.
        const document = await knowledge.tryRead(entry.id);
        if (!document) { counted(0); continue; }
        const { content } = document;
        const size = Buffer.byteLength(content);
        bytes += size;
        counted(size);
        if (bytes > knowledge.config.maxCorpusBytes) throw new Error('Semantic corpus exceeds maxCorpusBytes; narrow include/exclude in the host config.');
        fingerprint.update(JSON.stringify([entry.path, entry.kind, content]));
        yield { path: entry.path, kind: entry.kind, content };
      }
      indexedFingerprint = fingerprint.digest('hex');
    }
    const raw = await invokeSemantic({
      operation, model, cache: path.join(parent, 'semantic'), ...options,
    }, parent, this.knowledge.root, (progress) => {
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
    }, operation === 'search' ? 60_000 : 3_600_000, documents());
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
    if (indexedFingerprint) observed?.(indexedFingerprint, skippedChunks > 0);
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
    return {
      engine: 'embsearch-core', model: raw.model, version: raw.version,
      chunks: raw.chunks, embedded: raw.embedded, count: results.length, results,
      ...(raw.skippedChunks !== undefined ? { skippedChunks } : {}),
      ...(runtime ? { runtime } : {}),
      changes,
    };
  }
}

const runtimeSelections = new Map<string, Promise<SemanticRuntime | undefined>>();

async function invokeSemantic(
  payload: Record<string, unknown>, parent: string, cwd: string,
  progress?: (value: { completed: number; total: number; stage?: string; batchMs?: number; runtime?: SemanticRuntime }) => void,
  timeout = 60_000,
  documents?: AsyncIterable<{ path: string; kind: string; content: string }>,
): Promise<unknown> {
  const diagnostics = nativeDiagnostics();
  const temporary = await mkdtemp(path.join(parent, 'semantic-request-'));
  let finishSelection: ((value: SemanticRuntime | undefined) => void) | undefined;
  const key = JSON.stringify([payload.model, ...['KIMONO_SEMANTIC_BIN', 'ORT_DYLIB_PATH',
    'KIMONO_SEMANTIC_WORKERS', 'KIMONO_SEMANTIC_THREADS', 'KIMONO_SEMANTIC_BATCH'].map(name => process.env[name])]);
  try {
    const request = path.join(temporary, 'request.json');
    if (documents) {
      const handle = await open(request, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(payload).slice(0, -1)},"documents":[`);
        let first = true;
        for await (const document of documents) {
          await handle.writeFile(`${first ? '' : ','}${JSON.stringify(document)}`);
          first = false;
        }
        await handle.writeFile(']}');
      } finally { await handle.close(); }
    } else await writeFile(request, JSON.stringify(payload), { mode: 0o600 });
    const automatic = !process.env.KIMONO_SEMANTIC_DEVICE || process.env.KIMONO_SEMANTIC_DEVICE === 'auto';
    let selected: SemanticRuntime | undefined;
    while (automatic && runtimeSelections.has(key)) {
      selected = await runtimeSelections.get(key);
      if (selected) break;
    }
    if (automatic && !selected) {
      runtimeSelections.set(key, new Promise(resolve => { finishSelection = resolve; }));
    }
    let buffered = '';
    const response = await runProcess(process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic',
      [request], cwd, [0], automatic && !selected ? Math.max(timeout, 120_000) : timeout, (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
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
        if (buffered.length > 64 * 1024) {
          buffered = '';
          console.error('Kimono: oversized semantic diagnostic line omitted');
        }
      }, selected ? { ...process.env, KIMONO_SEMANTIC_DEVICE: selected.executionProvider } : process.env,
      4 * 1024 * 1024, true);
    const raw: unknown = JSON.parse(response.stdout);
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
  return { executionProvider: value.executionProvider as SemanticRuntime['executionProvider'],
    gpuExecutionVerified: value.gpuExecutionVerified, workers: Number(value.workers),
    threads: Number(value.threads), batch: Number(value.batch), benchmarks };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
