import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { AikidoKnowledgeBase } from './knowledge.js';
import { AIKIDO_REPOSITORY, installAikido, RepositoryAccess, validateRelativePath } from './repository.js';

export const RUNTIME_TOOLS: Tool[] = [
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
    description: 'Search the current AI-KIDO knowledge using the real Rust fast-grep (fgr) index, refreshed before every search. Literal or regex, bounded results with paths and line numbers. Not an embedding/semantic engine.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string' }, regex: { type: 'boolean', default: false },
        kind: { type: 'string', enum: ['command', 'agent', 'skill', 'workflow', 'knowledge'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'aikido_index',
    description: 'Update, rebuild, compact or inspect the persistent fast-grep index. Cache is outside AIKIDO_ROOT; private spec documents are excluded unless explicitly configured.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: { operation: { type: 'string', enum: ['update', 'rebuild', 'compact', 'stats'] } },
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
    description: 'Create/update/delete a text knowledge document in a writable project ROOT. Existing-file updates/deletes require its exact expected content to prevent lost updates. Rejects symlinks, .git, path traversal and protected official bases.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation', 'path'],
      properties: {
        operation: { type: 'string', enum: ['write', 'delete'] }, path: { type: 'string' },
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
  constructor(private readonly knowledge: AikidoKnowledgeBase) {
    this.repository = new RepositoryAccess(knowledge.root);
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const action = this.pending.then(() => this.execute(name, input));
    this.pending = action.then(() => undefined, () => undefined);
    return action;
  }

  private async execute(name: string, input: Record<string, unknown>): Promise<string> {
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
      const query = text(input, 'query', true)!;
      const kind = input.kind;
      if (kind !== undefined && kind !== 'agent' && kind !== 'skill' && kind !== 'command' && kind !== 'workflow' && kind !== 'knowledge') throw new Error('Invalid knowledge kind');
      const limit = input.limit ?? 25;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
      if (input.regex !== undefined && typeof input.regex !== 'boolean') throw new Error('regex must be boolean');
      if (!query.trim()) throw new Error('query must not be empty');
      await this.knowledge.refresh();
      const results = await this.knowledge.searchIndex.search(query, kind, limit, input.regex === true);
      return JSON.stringify({ engine: 'fast-grep', count: results.length, results });
    }
    if (name === 'aikido_index') {
      const operation = text(input, 'operation', true);
      if (operation !== 'update' && operation !== 'rebuild' && operation !== 'compact' && operation !== 'stats') throw new Error('Invalid index operation');
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
      await this.repository.requireWritable();
      const file = text(input, 'path', true)!;
      validateRelativePath(file);
      if (!/\.(md|mdc|txt|json|ya?ml|toml|[cm]?js|sh|py|ts|xml)$/i.test(file)) throw new Error('Only supported text knowledge files can be edited');
      if (file.startsWith('prompts/spec/') && process.env.AIKIDO_INCLUDE_SPEC !== 'true') throw new Error('Personal specs require AIKIDO_INCLUDE_SPEC=true');
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
