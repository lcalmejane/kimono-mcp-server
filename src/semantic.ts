import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { hostname, tmpdir } from 'node:os';
import type { AikidoKnowledgeBase, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';
import { within, type ChangeReport } from './synchronization.js';
import { IndexLockedError, indexInfos, processAlive, trackIndex } from './index-basis.js';

export interface SemanticResult {
  engine: 'embsearch-core';
  version: string;
  model: string;
  chunks: number;
  embedded: number;
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
        dimensions: raw.dimensions, normalized: raw.normalized, maxTokens: raw.maxTokens, vector: raw.vector };
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
          indexedAt: new Date().toISOString(), chunks: output.chunks, model: output.model, etaSeconds: 0,
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
    observed?: (fingerprint: string) => void,
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
    async function* documents() {
      const fingerprint = createHash('sha256');
      let bytes = 0;
      for (const entry of selected) {
        const { content } = await knowledge.read(entry.id);
        const size = Buffer.byteLength(content);
        bytes += size;
        counted(size);
        if (bytes > knowledge.config.maxCorpusBytes) throw new Error('Semantic corpus exceeds maxCorpusBytes; narrow include/exclude in the host config.');
        fingerprint.update(JSON.stringify([entry.path, entry.kind, content]));
        yield { path: entry.path, kind: entry.kind, content };
      }
      observed?.(fingerprint.digest('hex'));
    }
    const raw = await invokeSemantic({
      operation, model, cache: path.join(parent, 'semantic'), ...options,
    }, parent, this.knowledge.root, (progress) => {
      this.state.progress = { completed: progress.completed, total: progress.total };
      if (progress.stage) this.state.stage = progress.stage;
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
      changes,
    };
  }
}

async function invokeSemantic(
  payload: Record<string, unknown>, parent: string, cwd: string,
  progress?: (value: { completed: number; total: number; stage?: string }) => void,
  timeout = 60_000,
  documents?: AsyncIterable<{ path: string; kind: string; content: string }>,
): Promise<unknown> {
  const temporary = await mkdtemp(path.join(parent, 'semantic-request-'));
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
    let buffered = '';
    const response = await runProcess(process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic',
      [request], cwd, [0], timeout, (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line.startsWith('KIMONO_PROGRESS ')) continue;
          try {
            const value: unknown = JSON.parse(line.slice(16));
            if (record(value) && typeof value.completed === 'number' && typeof value.total === 'number'
              && Number.isSafeInteger(value.completed) && Number.isSafeInteger(value.total)
              && value.completed >= 0 && value.total >= value.completed) {
              progress?.({ completed: value.completed, total: value.total,
                ...(typeof value.phase === 'string' ? { stage: value.phase.slice(0, 64) } : {}) });
            } else console.error('Invalid semantic progress event');
          } catch (error) {
            console.error('Invalid semantic progress JSON:', error instanceof Error ? error.message : String(error));
          }
        }
      });
    return JSON.parse(response.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
