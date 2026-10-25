import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AikidoKnowledgeBase, KnowledgeEntry, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';
import { within, type ChangeReport } from './synchronization.js';
import { trackIndex } from './index-basis.js';
import { corpusConfig } from './corpus-config.js';

type Owners = Record<string, string>;
type Candidates = { matches: SearchMatch[]; truncated: boolean };

export class FastGrepIndex {
  readonly directory: string;
  private readonly documents: string;
  private readonly binary: string;
  private pending: Promise<unknown> = Promise.resolve();
  private prepared = false;
  // stat signature (size + mtime) of the known corpus at the last successful full update.
  private freshSignature: string | undefined;

  constructor(private readonly knowledge: AikidoKnowledgeBase) {
    const includeSpec = process.env.AIKIDO_INCLUDE_SPEC === 'true';
    // Keep existing AI-KIDO retargets/revisions in their original cache.
    const legacy = !includeSpec && JSON.stringify(knowledge.config) === JSON.stringify(corpusConfig({ mode: 'aikido' }));
    const identity = legacy ? knowledge.root : JSON.stringify([knowledge.root, knowledge.config, includeSpec]);
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    this.directory = path.join(process.env.KIMONO_CACHE_DIR ?? path.join(homedir(), '.cache', 'kimono'), key);
    if (this.directory === knowledge.root || this.directory.startsWith(`${knowledge.root}${path.sep}`)) {
      throw new Error('KIMONO_CACHE_DIR must be outside AIKIDO_ROOT');
    }
    this.documents = path.join(this.directory, 'documents');
    this.binary = process.env.FGR_BIN ?? 'fgr';
  }

  async synchronize(): Promise<void> {
    await this.exclusive(async () => { this.freshSignature = undefined; await this.update(); });
  }

  async maintain(operation: 'update' | 'rebuild' | 'compact' | 'stats', paths?: string[]) {
    return this.exclusive(async () => {
      this.freshSignature = undefined;
      const changes = await this.update(paths, operation === 'rebuild');
      const owners = await this.owners();
      const indexes = [...new Set(Object.values(owners))];
      const details: string[] = [];
      if (operation === 'compact' || operation === 'stats') {
        for (const shard of indexes) {
          const result = await runProcess(this.binary, [operation, '--index', this.index(shard)], this.directory);
          details.push(result.stdout || result.stderr);
        }
      }
      return { engine: 'fast-grep', changes, files: Object.keys(owners).length, indexes: indexes.length,
        ...(details.length ? { details } : {}) };
    });
  }

  async search(query: string, kind: KnowledgeKind | undefined, limit: number, regex = false, filter?: (entry: KnowledgeEntry) => boolean): Promise<SearchMatch[]> {
    return (await this.searchCandidates(query, kind, limit, regex, filter)).matches;
  }

  async searchCandidates(query: string, kind: KnowledgeKind | undefined, limit: number, regex = false,
    filter?: (entry: KnowledgeEntry) => boolean, perFile?: number): Promise<Candidates> {
    if (!this.knowledge.immutable) return this.exclusive(async () => {
      // Unchanged files since the last full update: skip the full rescan, re-read and git status.
      const signature = await this.statSignature();
      if (signature === undefined || signature !== this.freshSignature) {
        this.freshSignature = undefined;
        await this.update();
        this.freshSignature = signature;
      }
      return this.queryCandidates(query, kind, limit, regex, filter, perFile);
    });
    if (!this.prepared) await this.exclusive(async () => {
      if (!this.prepared) {
        // fgr indexes embed absolute paths and cannot be copied to a snapshot.
        // Index the already validated immutable corpus once, without rescanning
        // the mutable source or copying its obsolete shards.
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const paths = this.knowledge.list().map(entry => entry.path);
        if (paths.length) {
          await runProcess(this.binary, ['index', '-i', this.knowledge.root, '--output', this.index('base'), '--hidden', '--no-ignore'], this.knowledge.root);
        }
        await this.save('literal-state.json', Object.fromEntries(paths.map(file => [file, 'base'])));
        this.prepared = true;
      }
    });
    // An immutable index never changes once prepared: concurrent read-only fgr queries are safe.
    return this.queryCandidates(query, kind, limit, regex, filter, perFile);
  }

  private async queryCandidates(query: string, kind: KnowledgeKind | undefined, limit: number, regex: boolean,
    filter: ((entry: KnowledgeEntry) => boolean) | undefined, perFile: number | undefined): Promise<Candidates> {
    const entries = this.knowledge.list(kind).filter(entry => !filter || filter(entry));
    const owners = await this.owners();
    const matches: SearchMatch[] = [];
    let truncated = false;
    const boundMatches = () => {
      if (matches.length <= limit) return;
      truncated = true;
      if (perFile !== undefined) {
        const positions = new Map<string, number>();
        const ordered = matches.map(hit => {
          const position = positions.get(hit.path) ?? 0;
          positions.set(hit.path, position + 1);
          return { hit, position };
        }).sort((a, b) => a.position - b.position || a.hit.path.localeCompare(b.hit.path));
        matches.splice(0, matches.length, ...ordered.slice(0, limit).map(item => item.hit));
      } else matches.length = limit;
    };
    for (const shard of [...new Set(Object.values(owners))]) {
      // Bound command-line size on Windows/POSIX even for very large catalogues.
      const batches: KnowledgeEntry[][] = [];
      let size = 0;
      for (const entry of entries.filter(entry => owners[entry.path] === shard)) {
        const length = Buffer.byteLength(entry.path) * 2 + 32;
        if (!batches.length || size + length > 12_000) { batches.push([]); size = 0; }
        batches[batches.length - 1].push(entry);
        size += length;
      }
      for (const selected of batches) {
        const directory = shard === 'base' ? (this.knowledge.immutable ? this.knowledge.root : this.documents)
          : path.join(this.directory, shard, 'documents');
        const args = ['--format', 'json', '--ignore-case', '--hidden', '--no-ignore', '--index', this.index(shard), '--max-results', String(limit)];
        // Bound JSON below runProcess's buffer; fgr reports every output limit.
        args.push('--max-output-bytes', '2097152', '--no-auto-update');
        if (perFile !== undefined) args.push('--max-results-per-file', String(perFile));
        if (!regex) args.push('--fixed-strings');
        // A bare basename glob matches every nested README.md too, leaking across query batches/scopes.
        for (const entry of selected) args.push('--include', `/${entry.path.replace(/([*?[\]{}])/g, '\\$1')}`);
        args.push('--', query, directory);
        const result = await runProcess(this.binary, args, directory, [0, 1]);
        if (result.exitCode === 1) continue;
        const data: unknown = JSON.parse(result.stdout);
        if (!isRecord(data) || !Array.isArray(data.files)) throw new Error('Invalid fast-grep JSON response');
        truncated ||= Boolean(data.truncated);
        const byPath = new Map(selected.map(entry => [entry.path, entry]));
        for (const file of data.files) {
          if (!isRecord(file) || typeof file.path !== 'string' || !Array.isArray(file.matches)) {
            throw new Error('Invalid fast-grep file response');
          }
          const relative = path.isAbsolute(file.path) ? path.relative(directory, file.path) : file.path;
          const entry = byPath.get(relative.split(path.sep).join('/'));
          if (!entry) throw new Error(`fast-grep returned an out-of-scope file: ${file.path}`);
          for (const match of file.matches) {
            if (!isRecord(match) || typeof match.line !== 'number' || typeof match.text !== 'string') {
              throw new Error('Invalid fast-grep match response');
            }
            matches.push({ ...entry, line: match.line, excerpt: match.text.slice(0, 1000) });
          }
        }
        boundMatches();
      }
    }
    return { matches, truncated };
  }

  private index(shard: string): string {
    return shard === 'base' ? path.join(this.directory, 'index') : path.join(this.directory, shard, 'index');
  }

  private async owners(): Promise<Owners> {
    try {
      const data: unknown = JSON.parse(await readFile(path.join(this.directory, 'literal-state.json'), 'utf8'));
      if (!isRecord(data) || !Object.entries(data).every(([file, shard]) => safeFile(file)
        && typeof shard === 'string' && (shard === 'base' || /^shard-[a-f0-9-]{36}$/.test(shard)))) {
        throw new Error('Invalid literal index state');
      }
      return data as Owners;
    } catch (error) {
      if (!missing(error)) throw error;
      // Read the v0.2 manifest without rereading the original corpus.
      let legacy: unknown;
      try { legacy = JSON.parse(await readFile(path.join(this.directory, 'manifest.json'), 'utf8')); }
      catch (error) { if (missing(error)) return {}; throw error; }
      if (!Array.isArray(legacy) || !legacy.every(safeFile)) throw new Error('Invalid search manifest');
      return Object.fromEntries(legacy.map(file => [file, 'base']));
    }
  }

  private async statSignature(): Promise<string | undefined> {
    const hash = createHash('sha256');
    try {
      for (const entry of this.knowledge.list()) {
        const info = await stat(path.join(this.knowledge.root, entry.path));
        hash.update(`${entry.path}\0${info.size}\0${info.mtimeMs}\0${info.ino}\n`);
      }
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    return hash.digest('hex');
  }

  private async update(paths?: string[], rebuild = false): Promise<ChangeReport> {
    return trackIndex(this.knowledge, 'literal', paths, observed => this.updateDocuments(paths, rebuild, observed));
  }

  private async updateDocuments(paths?: string[], rebuild = false, observed?: (fingerprint: string) => void): Promise<ChangeReport> {
    await mkdir(this.documents, { recursive: true, mode: 0o700 });
    const previous = await this.owners();
    const owners = { ...previous };
    const changes: ChangeReport = { added: [], modified: [], deleted: [] };
    const current = this.knowledge.list().filter(entry => within(entry.path, paths)).map(entry => entry.path);
    const contents = new Set<string>();
    const fingerprint = createHash('sha256');
    const shard = `shard-${randomUUID()}`;
    for (const file of Object.keys(previous).filter(file => within(file, paths) && !current.includes(file))) {
      changes.deleted.push(file);
      delete owners[file];
    }
    try {
      for (const file of current.sort((a, b) => a.localeCompare(b))) {
        const { content, entry } = await this.knowledge.read(file);
        fingerprint.update(JSON.stringify([file, entry.kind, content]));
        let existing: string | undefined;
        const baseline = previous[file] && previous[file] !== 'base'
          ? path.join(this.directory, previous[file], 'documents', file) : path.join(this.documents, file);
        try { existing = await readFile(baseline, 'utf8'); }
        catch (error) { if (!missing(error)) throw error; }
        if (!(file in previous)) changes.added.push(file);
        else if (existing !== content) changes.modified.push(file);
        if (rebuild || !(file in previous) || existing !== content) {
          const target = path.join(this.directory, shard, 'documents', file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content, { mode: 0o600 });
          contents.add(file);
        }
      }
      observed?.(fingerprint.digest('hex'));
      // Immutable batch shards avoid full-root rebuilds for paths-scoped updates.
      if (contents.size) {
        const documents = path.join(this.directory, shard, 'documents');
        await runProcess(this.binary, ['index', '-i', documents, '--output', this.index(shard), '--hidden', '--no-ignore'], documents);
        for (const file of contents) owners[file] = shard;
      }
    } catch (error) {
      await rm(path.join(this.directory, shard), { recursive: true, force: true });
      throw error;
    }
    // Commit ownership before compatibility mirrors: failed mirror writes must
    // never make an old base index look synchronized with newer source text.
    await this.save('literal-state.json', owners);
    await this.save('manifest.json', Object.keys(owners).sort());
    for (const file of contents) {
      const target = path.join(this.documents, file);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(this.directory, shard, 'documents', file), target);
    }
    for (const file of changes.deleted) await rm(path.join(this.documents, file), { force: true });
    for (const unused of new Set(Object.values(previous))) {
      if (Object.values(owners).includes(unused)) continue;
      await rm(unused === 'base' ? this.index(unused) : path.join(this.directory, unused), { recursive: true, force: true });
    }
    for (const files of Object.values(changes)) files.sort();
    return changes;
  }

  private async save(name: string, value: unknown): Promise<void> {
    const pending = path.join(this.directory, `${name}.${randomUUID()}.pending`);
    try {
      await writeFile(pending, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(pending, path.join(this.directory, name));
    } finally {
      await rm(pending, { force: true });
    }
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }
}

function safeFile(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
    && !value.split('/').some(part => !part || part === '..' || part === '.') && !value.includes('\\');
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
