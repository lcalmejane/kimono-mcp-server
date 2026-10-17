import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AikidoKnowledgeBase, KnowledgeEntry, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';
import { within, type ChangeReport } from './synchronization.js';

type Owners = Record<string, string>;

export class FastGrepIndex {
  readonly directory: string;
  private readonly documents: string;
  private readonly binary: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly knowledge: AikidoKnowledgeBase) {
    const key = createHash('sha256').update(knowledge.root).digest('hex').slice(0, 24);
    this.directory = path.join(process.env.KIMONO_CACHE_DIR ?? path.join(homedir(), '.cache', 'kimono'), key);
    if (this.directory === knowledge.root || this.directory.startsWith(`${knowledge.root}${path.sep}`)) {
      throw new Error('KIMONO_CACHE_DIR must be outside AIKIDO_ROOT');
    }
    this.documents = path.join(this.directory, 'documents');
    this.binary = process.env.FGR_BIN ?? 'fgr';
  }

  async synchronize(): Promise<void> {
    await this.exclusive(async () => { await this.update(); });
  }

  async maintain(operation: 'update' | 'rebuild' | 'compact' | 'stats', paths?: string[]) {
    return this.exclusive(async () => {
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
    return this.exclusive(async () => {
      await this.update();
      const entries = this.knowledge.list(kind).filter(entry => !filter || filter(entry));
      const owners = await this.owners();
      const matches: SearchMatch[] = [];
      for (const shard of [...new Set(Object.values(owners))]) {
        const selected = entries.filter(entry => owners[entry.path] === shard);
        if (!selected.length) continue;
        const directory = shard === 'base' ? this.documents : path.join(this.directory, shard, 'documents');
        const args = ['--format', 'json', '--ignore-case', '--hidden', '--no-ignore', '--index', this.index(shard), '--max-results', String(limit)];
        if (!regex) args.push('--fixed-strings');
        // A file has exactly one live owner. Superseded postings are never searched.
        for (const entry of selected) args.push('--include', entry.path.replace(/([*?[\]{}])/g, '\\$1'));
        args.push('--', query, directory);
        const result = await runProcess(this.binary, args, directory, [0, 1]);
        if (result.exitCode === 1) continue;
        const data: unknown = JSON.parse(result.stdout);
        if (!isRecord(data) || !Array.isArray(data.files)) throw new Error('Invalid fast-grep JSON response');
        for (const file of data.files) {
          if (!isRecord(file) || typeof file.path !== 'string' || !Array.isArray(file.matches)) {
            throw new Error('Invalid fast-grep file response');
          }
          const relative = path.isAbsolute(file.path) ? path.relative(directory, file.path) : file.path;
          const entry = selected.find(item => item.path === relative.split(path.sep).join('/'));
          if (!entry) throw new Error(`fast-grep returned an out-of-scope file: ${file.path}`);
          for (const match of file.matches) {
            if (!isRecord(match) || typeof match.line !== 'number' || typeof match.text !== 'string') {
              throw new Error('Invalid fast-grep match response');
            }
            matches.push({ ...entry, line: match.line, excerpt: match.text.slice(0, 1000) });
          }
        }
      }
      return matches.slice(0, limit);
    });
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

  private async update(paths?: string[], rebuild = false): Promise<ChangeReport> {
    await mkdir(this.documents, { recursive: true, mode: 0o700 });
    const previous = await this.owners();
    const owners = { ...previous };
    const changes: ChangeReport = { added: [], modified: [], deleted: [] };
    const current = this.knowledge.list().filter(entry => within(entry.path, paths)).map(entry => entry.path);
    const contents = new Map<string, string>();
    for (const file of Object.keys(previous).filter(file => within(file, paths) && !current.includes(file))) {
      changes.deleted.push(file);
      delete owners[file];
    }
    for (const file of current) {
      const { content } = await this.knowledge.read(file);
      let existing: string | undefined;
      const baseline = previous[file] && previous[file] !== 'base'
        ? path.join(this.directory, previous[file], 'documents', file) : path.join(this.documents, file);
      try { existing = await readFile(baseline, 'utf8'); }
      catch (error) { if (!missing(error)) throw error; }
      if (!(file in previous)) changes.added.push(file);
      else if (existing !== content) changes.modified.push(file);
      if (rebuild || !(file in previous) || existing !== content) contents.set(file, content);
    }
    // fast-grep's update walks its entire root and rebuilds previous delta files.
    // Immutable batch shards avoid both operations for a paths-scoped update.
    const shard = `shard-${randomUUID()}`;
    if (contents.size) {
      const documents = path.join(this.directory, shard, 'documents');
      try {
        for (const [file, content] of contents) {
          const target = path.join(documents, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content, { mode: 0o600 });
        }
        await runProcess(this.binary, ['index', '-i', documents, '--output', this.index(shard), '--hidden', '--no-ignore'], documents);
      } catch (error) {
        await rm(path.join(this.directory, shard), { recursive: true, force: true });
        throw error;
      }
      for (const file of contents.keys()) owners[file] = shard;
    }
    // Commit ownership before compatibility mirrors: failed mirror writes must
    // never make an old base index look synchronized with newer source text.
    await this.save('literal-state.json', owners);
    await this.save('manifest.json', Object.keys(owners).sort());
    for (const [file, content] of contents) {
      const target = path.join(this.documents, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { mode: 0o600 });
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
