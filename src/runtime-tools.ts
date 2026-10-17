import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { AikidoKnowledgeBase } from './knowledge.js';
import { AIKIDO_REPOSITORY, installAikido, RepositoryAccess, validateRelativePath } from './repository.js';
import { Retrieval, RETRIEVAL_PROPERTIES, READ_PROPERTIES, integer, selection } from './retrieval.js';

export const RUNTIME_TOOLS: Tool[] = [
  {
    name: 'aikido_embed',
    description: 'operation=info introspects the active local embedding model without inference: exact identifier, name, dimensions, pooling, normalization, prefixes, token cap and SHA-256 of model/tokenizer/spec. Default operation=embed generates a text vector with usage=query or document. Neither operation reads or modifies ROOT/indexes. Text beyond the token cap is truncated.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      oneOf: [
        { required: ['operation'], properties: { operation: { const: 'info' } }, not: { anyOf: [{ required: ['text'] }, { required: ['usage'] }] } },
        { required: ['text'], properties: { operation: { const: 'embed' } } },
      ],
      properties: {
        operation: { type: 'string', enum: ['embed', 'info'], default: 'embed' },
        text: { type: 'string', minLength: 1, description: 'Non-blank text, maximum 32768 UTF-8 bytes.' },
        usage: { type: 'string', enum: ['query', 'document'], default: 'query' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'aikido_root',
    description: 'Inspect or initialize the configured AIKIDO_ROOT. init clones the standard AI-KIDO repository or another Git repository into this ROOT only; never overwrites non-empty paths.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['status', 'init'] },
        repository: { type: 'string', description: 'HTTPS/SSH Git URL; defaults to AIKIDO_REPOSITORY or the official standard.' },
        ref: { type: 'string', description: 'Branch or tag (default AIKIDO_REF or main).' },
      },
    },
  },
  {
    name: 'aikido_search',
    description: 'Progressive AI-KIDO search: compact JSON results with 1-based source ranges and excerpts, and one document metadata/header per file in documents keyed by SHA-256(path)[:12]. Filter by scope/pathPrefix/type/extension before ranking/limit. Default 2 context lines and 16 KiB JSON budget; truncated reports omitted results. No full files. Use aikido_file metadata/outline/read to expand only selected passages. Semantic query/vector requires the exact local embedding model.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      oneOf: [
        { required: ['query'], not: { anyOf: [{ required: ['vector'] }, { required: ['embeddingModel'] }] } },
        { required: ['vector', 'embeddingModel', 'mode'], properties: { mode: { const: 'semantic' } }, not: { required: ['query'] } },
      ],
      properties: {
        ...RETRIEVAL_PROPERTIES,
        contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 2 },
        query: { type: 'string' }, regex: { type: 'boolean', default: false },
        vector: { type: 'array', minItems: 1, maxItems: 16384, items: { type: 'number' }, description: 'Finite non-zero embedding; must match the active model dimension.' },
        embeddingModel: { type: 'string', description: 'Exact model identifier returned by aikido_embed; caller is responsible for vector provenance and matching preprocessing.' },
        mode: { type: 'string', enum: ['literal', 'regex', 'semantic'], default: 'literal' },
        kind: { type: 'string', enum: ['command', 'agent', 'skill', 'workflow', 'knowledge'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'aikido_index',
    description: 'Update, rebuild, compact or inspect indexes. operation=status with mode=semantic polls in-memory progress without waiting behind indexing or starting inference. Cache is outside ROOT; private specs remain opt-in.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['update', 'rebuild', 'compact', 'stats', 'status'] },
        mode: { type: 'string', enum: ['literal', 'semantic'], default: 'literal' },
      },
    },
  },
  {
    name: 'aikido_git',
    description: 'Scoped Git actions in the configured project ROOT. Official AI-KIDO base is read-only; mutations require AIKIDO_WRITABLE=true. push/reset require confirm=true after explicit client approval. No shell or arbitrary Git flags.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: [
          'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'reflog', 'remote',
          'add', 'restore', 'rm', 'commit', 'fetch', 'pull', 'push', 'switch', 'checkout',
          'branch', 'tag', 'merge', 'rebase', 'rebase-abort', 'rebase-continue',
          'cherry-pick', 'revert', 'reset', 'stash', 'stash-pop', 'remote-add',
        ] },
        paths: { type: 'array', items: { type: 'string' } },
        ref: { type: 'string' }, remote: { type: 'string', default: 'origin' },
        name: { type: 'string' }, url: { type: 'string' }, message: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set only after user/client approval of push/reset.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'aikido_file',
    description: 'Progressive JSON retrieval: metadata (header, hash ID, type, size, lines), paginated Markdown outline, or read by inclusive 1-based startLine/endLine, exact section, or explicit full=true. Default read 200 lines and 16 KiB, nextLine resumes truncation. path accepts a discovered relative path or hash ID for reads. Also write/delete in writable non-official projects, with exact expected content for overwrites/deletes.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation', 'path'],
      properties: {
        ...READ_PROPERTIES,
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        operation: { type: 'string', enum: ['metadata', 'outline', 'read', 'write', 'delete'] }, path: { type: 'string' },
        content: { type: 'string' }, expected: { type: 'string', description: 'Exact previous contents, required for overwriting/deleting a file.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const runtimes = new WeakMap<AikidoKnowledgeBase, RuntimeTools>();
export function runtimeFor(knowledge: AikidoKnowledgeBase): RuntimeTools {
  let runtime = runtimes.get(knowledge);
  if (!runtime) {
    runtime = new RuntimeTools(knowledge);
    runtimes.set(knowledge, runtime);
  }
  return runtime;
}

class RuntimeTools {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly repository: RepositoryAccess;
  readonly retrieval: Retrieval;
  constructor(private readonly knowledge: AikidoKnowledgeBase) {
    this.repository = new RepositoryAccess(knowledge.root);
    this.retrieval = new Retrieval(knowledge);
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'aikido_index' && input.operation === 'status') {
      if (input.mode !== 'semantic') throw new Error('Index status requires mode=semantic');
      return JSON.stringify(this.knowledge.semanticIndex.status());
    }
    const action = this.pending.then(() => this.execute(name, input));
    this.pending = action.then(() => undefined, () => undefined);
    return action;
  }

  private async execute(name: string, input: Record<string, unknown>): Promise<string> {
    if (name === 'aikido_embed') {
      const operation = input.operation ?? 'embed';
      if (operation === 'info') {
        if (input.text !== undefined || input.usage !== undefined) throw new Error('info does not accept text or usage');
        return JSON.stringify(await this.knowledge.semanticIndex.info());
      }
      if (operation !== 'embed') throw new Error('operation must be embed or info');
      const value = text(input, 'text', true)!;
      const usage = input.usage ?? 'query';
      if (usage !== 'query' && usage !== 'document') throw new Error('usage must be query or document');
      return JSON.stringify(await this.knowledge.semanticIndex.embed(value, usage));
    }
    if (name === 'aikido_root') {
      const operation = text(input, 'operation', true);
      if (operation === 'status') {
        return JSON.stringify({
          root: this.knowledge.root, initialized: this.knowledge.isInitialized,
          writeEnabled: this.repository.writable,
          note: 'Official origin is always protected; Git actions verify it independently.',
        });
      }
      if (operation !== 'init') throw new Error('Unknown ROOT operation');
      await installAikido(this.knowledge.root, text(input, 'ref') ?? process.env.AIKIDO_REF ?? 'main',
        text(input, 'repository') ?? process.env.AIKIDO_REPOSITORY ?? AIKIDO_REPOSITORY);
      await this.knowledge.initialize();
      await this.knowledge.searchIndex.synchronize();
      return JSON.stringify({ root: this.knowledge.root, initialized: true, documents: this.knowledge.list().length });
    }
    if (name === 'aikido_search') {
      const kind = input.kind;
      if (kind !== undefined && kind !== 'agent' && kind !== 'skill' && kind !== 'command' && kind !== 'workflow' && kind !== 'knowledge') throw new Error('Invalid knowledge kind');
      const limit = input.limit ?? 25;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
      if (input.regex !== undefined && typeof input.regex !== 'boolean') throw new Error('regex must be boolean');
      const mode = input.mode ?? (input.regex === true ? 'regex' : 'literal');
      if (mode !== 'literal' && mode !== 'regex' && mode !== 'semantic') throw new Error('mode must be literal, regex or semantic');
      if (input.regex === true && mode !== 'regex') throw new Error('regex=true conflicts with the requested search mode');
      const filter = selection(input, this.knowledge.isMemoryRoot);
      integer(input, 'contextLines', 2, 0, 20);
      integer(input, 'maxBytes', 16384, 2048, 262144);
      const semanticSearch = async (options: { query?: string; vector?: number[]; embeddingModel?: string }) => {
        await this.knowledge.refresh();
        const paths = this.knowledge.list(kind).filter(filter).map(entry => entry.path);
        const result = await this.knowledge.semanticIndex.run('search', { ...options, paths, kind, limit: limit + 1 });
        const { results, count: _count, ...metadata } = result;
        return this.retrieval.search(input, results, metadata);
      };
      if (input.vector !== undefined) {
        if (mode !== 'semantic') throw new Error('vector requires mode=semantic');
        if (input.query !== undefined) throw new Error('Provide exactly one of query or vector');
        const vector = input.vector;
        if (!Array.isArray(vector) || vector.length < 1 || vector.length > 16384
          || !vector.every((value: unknown): value is number => typeof value === 'number'
            && Number.isFinite(value) && Math.abs(value) <= 3.4028234663852886e38)
          || !vector.some((value) => Math.abs(value) >= 1.1754943508222875e-38)) {
          throw new Error('vector must contain 1-16384 finite float32 numbers with non-zero norm');
        }
        const embeddingModel = text(input, 'embeddingModel', true)!;
        return semanticSearch({ vector, embeddingModel });
      }
      if (input.embeddingModel !== undefined) throw new Error('embeddingModel requires vector');
      const query = text(input, 'query', true)!;
      if (Buffer.byteLength(query) > 8192) throw new Error('query must be at most 8192 UTF-8 bytes');
      if (mode === 'semantic') {
        return semanticSearch({ query });
      }
      await this.knowledge.refresh();
      const scoped = ['scope', 'pathPrefix', 'type', 'extension'].some(key => input[key] !== undefined);
      const results = await this.knowledge.searchIndex.search(query, kind, limit + 1, mode === 'regex', scoped ? filter : undefined);
      return this.retrieval.search(input, results, { engine: 'fast-grep' });
    }
    if (name === 'aikido_index') {
      const operation = text(input, 'operation', true);
      if (operation !== 'update' && operation !== 'rebuild' && operation !== 'compact' && operation !== 'stats') throw new Error('Invalid index operation');
      const mode = input.mode ?? 'literal';
      if (mode !== 'literal' && mode !== 'semantic') throw new Error('Index mode must be literal or semantic');
      if (mode === 'semantic') return JSON.stringify(await this.knowledge.semanticIndex.run(operation));
      await this.knowledge.refresh();
      return this.knowledge.searchIndex.maintain(operation);
    }
    if (name === 'aikido_git') {
      if (input.paths !== undefined && (!Array.isArray(input.paths) || !input.paths.every((item) => typeof item === 'string'))) throw new Error('paths must be an array of strings');
      if (input.confirm !== undefined && typeof input.confirm !== 'boolean') throw new Error('confirm must be boolean');
      const result = await this.repository.git({
        operation: text(input, 'operation', true)!, paths: input.paths as string[] | undefined,
        ref: text(input, 'ref'), remote: text(input, 'remote'), name: text(input, 'name'),
        url: text(input, 'url'), message: text(input, 'message'), confirm: input.confirm === true,
      });
      await this.knowledge.refresh();
      await this.knowledge.searchIndex.synchronize();
      return JSON.stringify(result);
    }
    if (name === 'aikido_file') {
      if (['read', 'metadata', 'outline'].includes(String(input.operation))) {
        return this.retrieval.read(input, text(input, 'path', true)!);
      }
      await this.repository.requireWritable();
      const file = text(input, 'path', true)!;
      validateRelativePath(file);
      if (!/\.(md|mdx|mdc|txt|json|ya?ml|toml|[cm]?js|sh|py|ts|xml)$/i.test(file)) throw new Error('Only supported text knowledge files can be edited');
      if ((file.startsWith('prompts/spec/') || (this.knowledge.isMemoryRoot && file.startsWith('spec/'))) &&
        process.env.AIKIDO_INCLUDE_SPEC !== 'true') throw new Error('Personal specs require AIKIDO_INCLUDE_SPEC=true');
      const root = await realpath(this.knowledge.root);
      let current = root;
      for (const part of file.split('/')) {
        current = path.join(current, part);
        try {
          if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks are not allowed in document paths');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      const target = path.join(root, file);
      let previous: string | undefined;
      try { previous = await readFile(target, 'utf8'); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (previous !== undefined && previous !== text(input, 'expected')) throw new Error('Document changed or expected content missing; read it before updating');
      const operation = text(input, 'operation', true);
      if (operation === 'delete') {
        if (file === 'prompts/index.md' || file === 'index.md') throw new Error('Cannot delete the AI-KIDO entry point');
        await unlink(target);
      } else if (operation === 'write') {
        const content = text(input, 'content', true)!;
        if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Document exceeds 2 MiB');
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { flag: previous === undefined ? 'wx' : 'w' });
      } else throw new Error('Unknown file operation');
      await this.knowledge.refresh();
      await this.knowledge.searchIndex.synchronize();
      return JSON.stringify({ operation, path: file, indexed: true });
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}

function text(input: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  if (required && !value.trim()) throw new Error(`${key} must not be empty`);
  return value;
}
