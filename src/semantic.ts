import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AikidoKnowledgeBase, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';
import { within, type ChangeReport } from './synchronization.js';
import { corpusFingerprint, indexInfos, trackIndex } from './index-basis.js';

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

export class SemanticIndex {
  private pending: Promise<unknown> = Promise.resolve();
  private state: {
    phase: 'unknown' | 'running' | 'ready' | 'error' | 'disabled';
    operation?: string; stage?: string; startedAt?: string; completedAt?: string; indexedAt?: string;
    progress?: { completed: number; total: number }; error?: string;
    chunks?: number; model?: string;
  } = { phase: 'unknown' };
  constructor(private readonly knowledge: AikidoKnowledgeBase) {}

  status() { return structuredClone(this.state); }
  async idle(): Promise<void> { await this.pending; }

  warmup(): void {
    if (this.state.phase === 'running') return;
    if (!process.env.KIMONO_MODEL_DIR) {
      this.state = { phase: 'disabled', error: 'KIMONO_MODEL_DIR is not configured; semantic search is unavailable.' };
      return;
    }
    const startedAt = new Date().toISOString();
    this.state = { phase: 'running', operation: 'update', stage: 'checking_index', startedAt };
    const result = this.pending.then(async () => {
      try {
        const info = await indexInfos(this.knowledge);
        const semantic = info.indexes.semantic;
        if (record(semantic) && semantic.freshness === 'fresh') {
          const basis = record(semantic.basis) ? semantic.basis : undefined;
          this.state = {
            phase: 'ready', operation: 'update', startedAt, completedAt: new Date().toISOString(),
            ...(typeof basis?.indexedAt === 'string' ? { indexedAt: basis.indexedAt } : {}),
          };
          return;
        }
        await this.perform('update');
      } catch (error) {
        this.state = { phase: 'error', operation: 'update', startedAt, completedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error) };
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
    this.state = { phase: 'running', operation, stage: operation, startedAt };
    try {
      const output = this.knowledge.immutable && operation === 'search'
        ? await this.execute(operation, options)
        : await trackIndex(this.knowledge, 'semantic', options.syncPaths, observed => this.execute(operation, options, observed));
      this.state = { ...this.state, phase: 'ready', completedAt: new Date().toISOString(),
        chunks: output.chunks, model: output.model };
      return output;
    } catch (error) {
      this.state = { ...this.state, phase: 'error', completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error) };
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
    const documents = [];
    let bytes = 0;
    for (const entry of this.knowledge.list()) {
      if (!within(entry.path, options.syncPaths)) continue;
      const { content } = await this.knowledge.read(entry.id);
      bytes += Buffer.byteLength(content);
      if (bytes > 64 * 1024 * 1024) throw new Error('Semantic corpus exceeds the supported 64 MiB text budget; use a narrower ROOT.');
      documents.push({ path: entry.path, kind: entry.kind, content });
    }
    observed?.(corpusFingerprint(documents));
    const raw = await invokeSemantic({
      operation, model, cache: path.join(parent, 'semantic'), documents, ...options,
    }, parent, this.knowledge.root, (progress) => {
      this.state.progress = { completed: progress.completed, total: progress.total };
      if (progress.stage) this.state.stage = progress.stage;
    }, operation === 'search' ? 60_000 : 3_600_000);
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
): Promise<unknown> {
  const temporary = await mkdtemp(path.join(parent, 'semantic-request-'));
  try {
    const request = path.join(temporary, 'request.json');
    await writeFile(request, JSON.stringify(payload), { mode: 0o600 });
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
