import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { AikidoKnowledgeBase, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';

export interface SemanticResult {
  engine: 'embsearch-core';
  version: string;
  model: string;
  chunks: number;
  embedded: number;
  count: number;
  results: Array<SearchMatch & { score: number }>;
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
}

export class SemanticIndex {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly knowledge: AikidoKnowledgeBase) {}

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
    const result = this.pending.then(() => this.execute(operation, options));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute(
    operation: string,
    options: SemanticOptions,
  ): Promise<SemanticResult> {
    const model = process.env.KIMONO_MODEL_DIR;
    if (!model) throw new Error('Semantic search requires KIMONO_MODEL_DIR with model.onnx, tokenizer.json and model.json. Use the Kimono Docker image or install a local model.');
    await this.knowledge.refresh();
    const parent = this.knowledge.searchIndex.directory;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const documents = [];
    let bytes = 0;
    for (const entry of this.knowledge.list()) {
      const { content } = await this.knowledge.read(entry.id);
      bytes += Buffer.byteLength(content);
      if (bytes > 64 * 1024 * 1024) throw new Error('Semantic corpus exceeds the supported 64 MiB text budget; use a narrower ROOT.');
      documents.push({ path: entry.path, kind: entry.kind, content });
    }
    const raw = await invokeSemantic({
      operation, model, cache: path.join(parent, 'semantic'), documents, ...options,
    }, parent, this.knowledge.root);
    if (!record(raw) || raw.engine !== 'embsearch-core' || typeof raw.model !== 'string'
      || typeof raw.version !== 'string' || typeof raw.chunks !== 'number'
      || !Number.isSafeInteger(raw.chunks) || raw.chunks < 0 || typeof raw.embedded !== 'number'
      || !Number.isSafeInteger(raw.embedded) || raw.embedded < 0 || raw.embedded > raw.chunks
      || !Array.isArray(raw.results) || raw.count !== raw.results.length) throw new Error('Invalid semantic engine response');
    const results: SemanticResult['results'] = raw.results.map((hit: unknown) => {
      if (!record(hit) || typeof hit.path !== 'string' || !Number.isInteger(hit.line)
        || typeof hit.line !== 'number' || hit.line < 1 || typeof hit.score !== 'number'
        || !Number.isFinite(hit.score) || typeof hit.excerpt !== 'string') throw new Error('Invalid semantic hit');
      const entry = this.knowledge.list(options.kind).find((item) => item.path === hit.path);
      if (!entry) throw new Error(`Semantic engine returned an out-of-scope document: ${hit.path}`);
      return { ...entry, line: hit.line, score: hit.score, excerpt: hit.excerpt };
    });
    if (results.length > (options.limit ?? 25)) throw new Error('Semantic engine exceeded the result limit');
    return {
      engine: 'embsearch-core', model: raw.model, version: raw.version,
      chunks: raw.chunks, embedded: raw.embedded, count: results.length, results,
    };
  }
}

async function invokeSemantic(payload: Record<string, unknown>, parent: string, cwd: string): Promise<unknown> {
  const temporary = await mkdtemp(path.join(parent, 'semantic-request-'));
  try {
    const request = path.join(temporary, 'request.json');
    await writeFile(request, JSON.stringify(payload), { mode: 0o600 });
    const response = await runProcess(process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic',
      [request], cwd, [0], 600_000);
    return JSON.parse(response.stdout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
