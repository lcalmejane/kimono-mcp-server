import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { AikidoKnowledgeBase } from './knowledge.js';
import { RepositoryAccess } from './repository.js';
import { Retrieval, RETRIEVAL_PROPERTIES, READ_PROPERTIES, integer, selection } from './retrieval.js';
import { synchronizationPaths } from './synchronization.js';
import { indexInfos, sourceSnapshot } from './index-basis.js';
import { snapshotsFor, type KnowledgeSnapshot } from './snapshots.js';
import {
  readProjectPolicy, readRemoteSourceMetadata, readRetargetMetadata,
  saveRetargetMetadata, writeRemoteSourceMetadata,
} from './project-policy.js';
import { publishRemoteKnowledge, remoteSyncChanges } from './remote-sync.js';
import { readGitProfileFile, type GitCredentialResolver, type GitReadProfile } from './git-profile.js';
import { KnowledgeCollaboration } from './collaboration.js';
import { plannedSearch } from './planned-search.js';

export interface RuntimeRequestContext {
  gitProfile?: GitReadProfile | null;
  resolveGitProfile?: GitCredentialResolver;
  allowLocalGitProfile?: boolean;
}

export const RUNTIME_TOOLS: Tool[] = [
  {
    name: 'aikido_snapshot',
    description: 'Begin or end an immutable, bounded knowledge snapshot. Use its snapshotId on every related list, search and file read; lexical and semantic search plus reads then use the same captured corpus. Snapshots expire after 15 minutes and are limited to 8 active snapshots / 256 MiB total.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['begin', 'end'] },
        snapshotId: { type: 'string', description: 'Required for operation=end; returned by operation=begin.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
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
    description: 'Inspect the configured AIKIDO_ROOT. The root is a dedicated knowledge directory and may not be a Git repository.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['status'] },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'aikido_search',
    description: 'Snapshot-scoped search. Prefer text for natural language lexical retrieval, semantic for vectors, or hybrid for parallel text+semantic branches. Normalization and one-hop repository glossary enrichment are reported compactly (query terms, expansions with glossary source lines, branch status/errors, scores, provenance) for the consuming LLM. literal remains exact phrase; regex remains explicit regex. not-ready means poll aikido_index status instead of repeatedly searching. Default detail=locations returns only where to look (path, total lines, best score, hit lines, matched terms); then request the needed passages in ONE aikido_file operation=ranges batch with the same snapshotId, and read whole files only when really needed.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      oneOf: [
        { required: ['snapshotId', 'query'], not: { anyOf: [{ required: ['vector'] }, { required: ['embeddingModel'] }] } },
        { required: ['snapshotId', 'vector', 'embeddingModel', 'mode'], properties: { mode: { const: 'semantic' } }, not: { required: ['query'] } },
      ],
      properties: {
        ...RETRIEVAL_PROPERTIES,
        snapshotId: { type: 'string', description: 'Required snapshot from aikido_snapshot begin.' },
        detail: { type: 'string', enum: ['locations', 'excerpts'], default: 'locations', description: 'locations (default, token-frugal): files ordered by best score with matched line numbers ([start,end] for semantic chunks) and matched terms, no text. Then fetch only the needed passages in one aikido_file operation=ranges call. excerpts: legacy passages with context, document metadata and scoring details (diagnostics only).' },
        contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 2, description: 'detail=excerpts only. Passing it without detail selects excerpts for backward compatibility.' },
        query: { type: 'string' }, regex: { type: 'boolean', default: false },
        vector: { type: 'array', minItems: 1, maxItems: 16384, items: { type: 'number' }, description: 'Finite non-zero embedding; must match the active model dimension.' },
        embeddingModel: { type: 'string', description: 'Exact model identifier returned by aikido_embed; caller is responsible for vector provenance and matching preprocessing.' },
        mode: { type: 'string', enum: ['literal', 'regex', 'text', 'semantic', 'hybrid'], default: 'literal' },
        enrich: { type: 'boolean', default: true, description: 'text/semantic/hybrid: enrich only from declared project vocabulary aliases. No built-in translation, LLM call or ROOT mutation. Cross-language text retrieval requires explicit bilingual glossary aliases; queryPlan includes provenance and warnings.' },
        kind: { type: 'string', enum: ['command', 'agent', 'skill', 'workflow', 'knowledge'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'aikido_index',
    description: 'Refresh external lexical/semantic indexes from the current configured knowledge ROOT. This changes only external cache state; it does not modify ROOT. status with mode=semantic polls progress.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['update', 'status'] },
        mode: { type: 'string', enum: ['literal', 'semantic', 'all'], default: 'literal' },
        background: { type: 'boolean', default: false, description: 'Full semantic update only: start preparation and return status immediately; poll status for progress.' },
        paths: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', minItems: 1, maxItems: 256, items: { type: 'string', minLength: 1 } }],
          description: 'update only: ROOT-relative files/directories; deleted paths accepted, overlaps deduplicated. No globs, absolute paths or traversal.' },
      },
    },
  },
  {
    name: 'aikido_git',
    description: 'Knowledge-project Git guidance only. Retarget associates a credential-free repository URL/optional branch. Sync retrieves that source in read direction, anonymously or using the current user\'s host-resolved read credentials, then indexes its knowledge. The policy manifest URL is never selected implicitly. No checkout, commit, push, merge or branch creation.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      allOf: [{
        if: { properties: { operation: { const: 'retarget' } }, required: ['operation'] },
        then: { required: ['gitUrl'] },
      }, {
        if: { properties: { operation: { enum: ['infos', 'retarget'] } }, required: ['operation'] },
        then: { not: { required: ['connectionId'] } },
      }],
      properties: {
        operation: { type: 'string', enum: ['infos', 'sync', 'retarget'] },
        mode: { type: 'string', enum: ['literal', 'semantic', 'all'], default: 'all' },
        gitUrl: { type: 'string', description: 'Credential-free HTTPS/SSH Git URL; required for retarget.' },
        branch: { type: ['string', 'null'], description: 'Optional existing branch to read; omit to use remote default HEAD. Never creates a branch.' },
        connectionId: { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9_-]*$', description: 'Optional opaque host-managed credential reference for sync; empty means anonymous. Never pass tokens or keys.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'aikido_collaboration',
    description: 'Generic MCP-only shared knowledge collaboration: guidance, status, three-way compare, read a pinned shared revision, and explicitly publish an optimistic revision. A successful publish safely synchronizes the accepted document revision into configured AIKIDO_ROOT, so later snapshots/searches see it; open snapshots remain pinned. No Git or Tatami API is required. Use personal-replica operations only when the client has separate files; verified embedded stdio editing the exact configured ROOT should instead call aikido_index update. Never infer shared-directory mode for HTTP.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: ['guidance', 'status', 'compare', 'read', 'publish'] },
        localManifest: { type: 'object', maxProperties: 2000, additionalProperties: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          description: 'Optional ROOT-relative eligible path to SHA-256 map. Omit to use the configured MCP ROOT snapshot.' },
        baseVersion: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Persisted shared revision the local replica started from.' },
        expectedSharedVersion: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Required current shared revision optimistic concurrency guard for publish.' },
        sharedVersion: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Read: required exact revision. Status: optional historical revision to include as requestedRevision without moving the current pointer.' },
        paths: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' }, description: 'Relative eligible paths to read from the pinned revision.' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
        changes: { type: 'array', maxItems: 2000, items: { type: 'object', additionalProperties: false, required: ['path', 'content'],
          properties: { path: { type: 'string' }, content: { type: ['string', 'null'] } } },
          description: 'Changed file content as UTF-8 text; null deletes. Content hashes must match localManifest.' },
        resolutions: { type: 'object', maxProperties: 2000, additionalProperties: { type: 'string', enum: ['local', 'shared'] },
          description: 'Explicit per-conflict choice; publish never silently chooses last-write-wins.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'aikido_file',
    description: 'Snapshot-scoped read-only JSON retrieval: ranges (batch: up to 50 {path,startLine,endLine?} merged per file, optional contextLines, one byte budget; returns passages and any remaining ranges), metadata, Markdown outline, or read by inclusive 1-based startLine/endLine, exact section, or explicit full=true. Pass snapshotId from aikido_snapshot begin; reads use that immutable corpus.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation', 'snapshotId'],
      if: { properties: { operation: { const: 'ranges' } } },
      then: { required: ['ranges'], not: { anyOf: [{ required: ['path'] }, { required: ['section'] }, { required: ['full'] }, { required: ['startLine'] }, { required: ['endLine'] }] } },
      else: { required: ['path'], not: { anyOf: [{ required: ['ranges'] }, { required: ['contextLines'] }] } },
      properties: {
        ...READ_PROPERTIES,
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        operation: { type: 'string', enum: ['ranges', 'metadata', 'outline', 'read'] }, path: { type: 'string', description: 'Required except for operation=ranges.' },
        ranges: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['path', 'startLine'],
          properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1, description: 'Inclusive; default startLine.' } } } },
        contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 0, description: 'operation=ranges only: lines added around each range before merging.' },
        snapshotId: { type: 'string', description: 'Required snapshot from aikido_snapshot begin.' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

const runtimes = new WeakMap<AikidoKnowledgeBase, RuntimeTools>();
export function runtimeFor(knowledge: AikidoKnowledgeBase, responseMetadata?: Record<string, unknown>): RuntimeTools {
  let runtime = runtimes.get(knowledge);
  if (!runtime) {
    runtime = new RuntimeTools(knowledge, responseMetadata);
    runtimes.set(knowledge, runtime);
  }
  return runtime;
}

class RuntimeTools {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly repository: RepositoryAccess;
  private readonly collaboration: KnowledgeCollaboration;
  readonly retrieval: Retrieval;
  constructor(private readonly knowledge: AikidoKnowledgeBase, responseMetadata?: Record<string, unknown>) {
    this.repository = new RepositoryAccess(knowledge.root);
    this.collaboration = new KnowledgeCollaboration(knowledge);
    this.retrieval = new Retrieval(knowledge, responseMetadata);
  }

  async call(name: string, input: Record<string, unknown>, context: RuntimeRequestContext = {}): Promise<string> {
    if (name === 'aikido_snapshot') return this.dispatch(name, input);
    if (name === 'aikido_search' || name === 'aikido_file') {
      const snapshotId = text(input, 'snapshotId', true)!;
      return snapshotsFor(this.knowledge).withSnapshot(snapshotId, async snapshot => {
        const mode = input.mode;
        const semantic = name === 'aikido_search' && (mode === 'semantic' || mode === 'hybrid');
        let availability: { error: string; index: unknown } | undefined;
        if (semantic && snapshot.knowledge.semanticIndex.status().phase === 'unknown') {
          const source = this.knowledge.semanticIndex;
          if (!await snapshot.knowledge.semanticIndex.seedFrom(source, snapshot.version)) {
            const status = source.status();
            if (status.phase !== 'unknown') {
              if (status.phase === 'ready') source.warmup();
              availability = { error: status.error ?? 'Semantic index is preparing. Poll aikido_index status; lexical search remains available.',
                index: source.status() };
            }
          }
        }
        const result = await runtimeFor(snapshot.knowledge, snapshotMetadata(snapshot)).execute(name, input, {}, availability);
        return decorateSnapshotResult(result, snapshot);
      });
    }
    if (name === 'aikido_index' && input.operation === 'status') {
      if (input.paths !== undefined) throw new Error('paths requires operation=update');
      if (input.mode !== 'semantic') throw new Error('Index status requires mode=semantic');
      return JSON.stringify(this.knowledge.semanticIndex.status());
    }
    return this.dispatch(name, input, context);
  }

  private dispatch(name: string, input: Record<string, unknown>, context: RuntimeRequestContext = {}): Promise<string> {
    const action = this.pending.then(() => this.execute(name, input, context));
    this.pending = action.then(() => undefined, () => undefined);
    return action;
  }

  private async execute(name: string, input: Record<string, unknown>, context: RuntimeRequestContext = {},
    semanticAvailability?: { error: string; index: unknown }): Promise<string> {
    if (name === 'aikido_snapshot') {
      const operation = text(input, 'operation', true);
      const manager = snapshotsFor(this.knowledge);
      if (operation === 'begin') {
        if (input.snapshotId !== undefined) throw new Error('begin does not accept snapshotId');
        return JSON.stringify(await manager.begin());
      }
      if (operation === 'end') return JSON.stringify(await manager.end(text(input, 'snapshotId', true)!));
      throw new Error('operation must be begin or end');
    }
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
        const policy = await readProjectPolicy(this.knowledge.root);
        const retarget = await readRetargetMetadata(this.knowledge.searchIndex.directory);
        return JSON.stringify({
          root: this.knowledge.root, initialized: this.knowledge.isInitialized,
          policy,
          retarget,
          note: 'Knowledge-only MCP: project files and Git remotes are never modified.',
        });
      }
      throw new Error('Only operation=status is available; project files are never initialized or changed through MCP');
    }
    if (name === 'aikido_search') {
      const kind = input.kind;
      if (kind !== undefined && kind !== 'agent' && kind !== 'skill' && kind !== 'command' && kind !== 'workflow' && kind !== 'knowledge') throw new Error('Invalid knowledge kind');
      const limit = input.limit ?? 25;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
      if (input.regex !== undefined && typeof input.regex !== 'boolean') throw new Error('regex must be boolean');
      const mode = input.mode ?? (input.regex === true ? 'regex' : 'literal');
      if (mode !== 'literal' && mode !== 'regex' && mode !== 'text' && mode !== 'semantic' && mode !== 'hybrid') throw new Error('mode must be literal, regex, text, semantic or hybrid');
      if (input.regex === true && mode !== 'regex') throw new Error('regex=true conflicts with the requested search mode');
      if (input.enrich !== undefined && typeof input.enrich !== 'boolean') throw new Error('enrich must be boolean');
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
        if (semanticAvailability) return this.retrieval.search(input, [], {
          engine: 'embsearch-core', status: 'not-ready', ...semanticAvailability,
        });
        return semanticSearch({ vector, embeddingModel });
      }
      if (input.embeddingModel !== undefined) throw new Error('embeddingModel requires vector');
      const query = text(input, 'query', true)!;
      if (Buffer.byteLength(query) > 8192) throw new Error('query must be at most 8192 UTF-8 bytes');
      if (mode === 'text' || mode === 'semantic' || mode === 'hybrid') {
        const plan = await this.knowledge.vocabulary.plan(query, input.enrich !== false);
        const result = await plannedSearch(this.knowledge, plan, mode, kind, filter, limit + 1, semanticAvailability);
        return this.retrieval.search(input, result.results, result.metadata);
      }
      await this.knowledge.refresh();
      const scoped = ['scope', 'pathPrefix', 'type', 'extension'].some(key => input[key] !== undefined);
      const results = await this.knowledge.searchIndex.search(query, kind, limit + 1, mode === 'regex', scoped ? filter : undefined);
      return this.retrieval.search(input, results, { engine: 'fast-grep' });
    }
    if (name === 'aikido_index') {
      const operation = text(input, 'operation', true);
      if (operation !== 'update') throw new Error('Only operation=update is available; index sync never mutates the knowledge ROOT');
      const mode = input.mode ?? 'literal';
      if (mode !== 'literal' && mode !== 'semantic' && mode !== 'all') throw new Error('Index mode must be literal, semantic or all');
      const paths = synchronizationPaths(input.paths);
      if (input.background !== undefined && typeof input.background !== 'boolean') throw new Error('background must be boolean');
      if (input.background === true) {
        if (mode !== 'semantic' || paths) throw new Error('background requires mode=semantic and a full update');
        this.knowledge.semanticIndex.warmup();
        return JSON.stringify(this.knowledge.semanticIndex.status());
      }
      if (paths && operation !== 'update') throw new Error('paths requires operation=update');
      await this.knowledge.refresh(paths);
      await this.knowledge.vocabulary.refresh();
      const indexes: Record<string, unknown> = {};
      if (mode !== 'semantic') indexes.literal = await this.knowledge.searchIndex.maintain(operation, paths);
      if (mode !== 'literal') {
        const { results: _results, count: _count, ...result } = await this.knowledge.semanticIndex.run(operation, { syncPaths: paths, refreshed: true });
        indexes.semantic = result;
      }
      return JSON.stringify({ ...(mode === 'all' ? {} : indexes[mode] as object), operation, mode, scope: paths ?? null, indexes });
    }
    if (name === 'aikido_collaboration') {
      return JSON.stringify(await this.collaboration.call(input));
    }
    if (name === 'aikido_git') {
      if (input.operation === 'infos') {
        return JSON.stringify(await this.infos());
      }
      if (input.operation === 'sync') {
        const mode = input.mode ?? 'all';
        if (mode !== 'literal' && mode !== 'semantic' && mode !== 'all') throw new Error('mode must be literal, semantic or all');
        const target = await readRetargetMetadata(this.knowledge.searchIndex.directory);
        if (!target) throw new Error('Retarget an explicit credential-free Git URL before remote sync; project policy URLs are informational only');
        const connectionId = text(input, 'connectionId');
        if (connectionId !== undefined && connectionId !== '' && !/^[A-Za-z0-9_-]{1,128}$/.test(connectionId)) {
          throw new Error('connectionId must be a safe opaque host-managed reference');
        }
        const credentialRequest = { gitUrl: target.gitUrl, branch: target.branch, connectionId };
        let profile = context.gitProfile ?? null;
        if (connectionId === '') profile = null;
        else if (context.resolveGitProfile) {
          try { profile = await context.resolveGitProfile(credentialRequest); }
          catch { throw new Error('Unable to resolve authorized Git read credentials for this request'); }
        } else if (!profile && context.allowLocalGitProfile !== false) {
          profile = await readGitProfileFile(this.knowledge.root);
        }
        const cacheDirectory = this.knowledge.searchIndex.directory;
        const metadataPath = path.join(cacheDirectory, 'project-remote.json');
        const previousSource = await readRemoteSourceMetadata(cacheDirectory);
        const published = await publishRemoteKnowledge(this.knowledge, { ...target, profile });
        try {
          await this.knowledge.refresh();
          const report = JSON.parse(await this.execute('aikido_index', { operation: 'update', mode }));
          const after = await sourceSnapshot(this.knowledge);
          const source = {
            gitUrl: published.gitUrl,
            branch: published.branch,
            commit: published.commit,
            syncedAt: published.syncedAt,
            indexedAt: new Date().toISOString(),
            corpusFingerprint: after.corpusFingerprint,
          };
          await writeRemoteSourceMetadata(cacheDirectory, source);
          await published.finalize();
          return JSON.stringify({
            operation: 'sync',
            remoteSynchronized: true,
            gitUrl: published.gitUrl,
            branch: published.branch,
            commit: published.commit,
            corpusFingerprint: after.corpusFingerprint,
            report,
          });
        } catch (error) {
          try {
            await published.rollback();
            await this.knowledge.refresh();
            if (previousSource) await writeRemoteSourceMetadata(cacheDirectory, previousSource);
            else await rm(metadataPath, { force: true });
            await this.execute('aikido_index', { operation: 'update', mode });
          } catch {
            console.error('Remote sync recovery is incomplete; check the knowledge corpus and indexes before retrying');
            throw new Error('Remote sync failed and recovery is incomplete; shared knowledge must be checked before retrying');
          }
          throw error;
        }
      }
      if (input.operation === 'retarget') {
        const retarget = await saveRetargetMetadata(this.knowledge.searchIndex.directory, {
          gitUrl: input.gitUrl,
          branch: input.branch,
        });
        return JSON.stringify({ operation: 'retarget', retarget, note: 'Metadata only; no Git remote or branch was changed.' });
      }
      throw new Error('Only aikido_git infos, sync and retarget are available; agents perform Git mutations outside MCP');
    }
    if (name === 'aikido_file') {
      if (input.operation === 'ranges') {
        if (['path', 'section', 'full', 'startLine', 'endLine'].some(key => input[key] !== undefined)) throw new Error('operation=ranges takes ranges[], not path/section/full/startLine/endLine');
        return this.retrieval.ranges(input);
      }
      if (['read', 'metadata', 'outline'].includes(String(input.operation))) {
        if (input.ranges !== undefined || input.contextLines !== undefined) throw new Error('ranges and contextLines require operation=ranges');
        return this.retrieval.read(input, text(input, 'path', true)!);
      }
      throw new Error('Only aikido_file ranges, metadata, outline and read are available; MCP never edits project files');
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  private async infos() {
    const hasGit = await lstat(path.join(this.knowledge.root, '.git')).then(() => true).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    });
    const repository = hasGit ? { available: true, ...await this.repository.infos() }
      : { available: false, head: null, branch: null, dirty: null, upstream: null,
      ahead: null, behind: null, statusFingerprint: null, dirtyFiles: [] };
    const basis = await indexInfos(this.knowledge);
    if (repository.available) {
      const current = await this.repository.infos();
      if (current.head !== repository.head || current.branch !== repository.branch
        || current.statusFingerprint !== repository.statusFingerprint) throw new Error('Repository changed while reading infos; retry');
    }
    const projectPolicy = await readProjectPolicy(this.knowledge.root);
    const retarget = await readRetargetMetadata(this.knowledge.searchIndex.directory);
    const lastSyncedSource = await readRemoteSourceMetadata(this.knowledge.searchIndex.directory);
    const localChanges = repository.available ? null : await remoteSyncChanges(this.knowledge);
    const hasNoLocalChanges = repository.available
      ? repository.dirty === false
      : localChanges?.available === true && localChanges.changes.length === 0;
    const indexedSource = hasNoLocalChanges ? basis.indexedSource : null;
    return { repository, ...basis,
      indexedSource,
      lastSyncedSource,
      localChanges,
      projectPolicy,
      retarget,
      associatedRepository: indexedSource ?? null,
      recommendation: (repository.ahead ?? 0) > 0 && (repository.behind ?? 0) > 0 ? 'review-divergence'
        : (repository.behind ?? 0) > 0 ? 'fetch-review' : 'index-only',
      policy: projectPolicy ?? { execution: 'external-only', gitPushAllowed: false,
        gitPolicy: 'Agents perform Git mutations outside MCP; Kimono only reads the explicitly retargeted remote and synchronizes knowledge.' } };
  }
}

function text(input: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  if (required && !value.trim()) throw new Error(`${key} must not be empty`);
  return value;
}

export function decorateSnapshotResult(result: string, snapshot: KnowledgeSnapshot): string {
  let value: unknown;
  try { value = JSON.parse(result); }
  catch { value = { content: result }; }
  const metadata = snapshotMetadata(snapshot);
  return JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value, ...metadata }
    : { ...metadata, result: value });
}

export function snapshotMetadata(snapshot: KnowledgeSnapshot): Record<string, unknown> {
  return {
    snapshotId: snapshot.snapshotId,
    version: snapshot.version,
    provenance: snapshot.provenance,
  };
}
