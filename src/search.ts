import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AikidoKnowledgeBase, KnowledgeEntry, KnowledgeKind, SearchMatch } from './knowledge.js';
import { runProcess } from './process.js';

export class FastGrepIndex {
  readonly directory: string;
  private readonly documents: string;
  private readonly index: string;
  private readonly binary: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly knowledge: AikidoKnowledgeBase) {
    const key = createHash('sha256').update(knowledge.root).digest('hex').slice(0, 24);
    this.directory = path.join(process.env.KIMONO_CACHE_DIR ?? path.join(homedir(), '.cache', 'kimono'), key);
    if (this.directory === knowledge.root || this.directory.startsWith(`${knowledge.root}${path.sep}`)) {
      throw new Error('KIMONO_CACHE_DIR must be outside AIKIDO_ROOT');
    }
    this.documents = path.join(this.directory, 'documents');
    this.index = path.join(this.directory, 'index');
    this.binary = process.env.FGR_BIN ?? 'fgr';
  }

  async synchronize(): Promise<void> {
    await this.exclusive(() => this.update());
  }

  async maintain(operation: 'update' | 'rebuild' | 'compact' | 'stats'): Promise<string> {
    return this.exclusive(async () => {
      if (operation === 'rebuild') await rm(this.index, { recursive: true, force: true });
      await this.update();
      if (operation === 'rebuild' || operation === 'update') return `fast-grep index ${operation} complete`;
      const result = await runProcess(this.binary, [operation, '--index', this.index], this.documents);
      return result.stdout || result.stderr;
    });
  }

  async search(query: string, kind: KnowledgeKind | undefined, limit: number, regex = false, filter?: (entry: KnowledgeEntry) => boolean): Promise<SearchMatch[]> {
    return this.exclusive(async () => {
      await this.update();
      // Restrict the engine itself to the selected kind before applying its result cap.
      const entries = this.knowledge.list(kind).filter(entry => !filter || filter(entry));
      if (!entries.length) return [];
      const args = ['--format', 'json', '--ignore-case', '--hidden', '--no-ignore', '--index', this.index, '--max-results', String(limit)];
      if (!regex) args.push('--fixed-strings');
      if (kind || filter) for (const entry of entries) args.push('--include', entry.path);
      args.push('--', query, this.documents);
      const result = await runProcess(this.binary, args, this.documents, [0, 1]);
      if (result.exitCode === 1) return [];
      const data: unknown = JSON.parse(result.stdout);
      if (!isRecord(data) || !Array.isArray(data.files)) throw new Error('Invalid fast-grep JSON response');
      const matches: SearchMatch[] = [];
      for (const file of data.files) {
        if (!isRecord(file) || typeof file.path !== 'string' || !Array.isArray(file.matches)) {
          throw new Error('Invalid fast-grep file response');
        }
        const relative = path.isAbsolute(file.path) ? path.relative(this.documents, file.path) : file.path;
        const entry = entries.find((item) => item.path === relative.split(path.sep).join('/'));
        if (!entry) throw new Error(`fast-grep returned an out-of-scope file: ${file.path}`);
        for (const match of file.matches) {
          if (!isRecord(match) || typeof match.line !== 'number' || typeof match.text !== 'string') {
            throw new Error('Invalid fast-grep match response');
          }
          matches.push({ ...entry, line: match.line, excerpt: match.text.slice(0, 1000) });
        }
      }
      return matches.slice(0, limit);
    });
  }

  private async update(): Promise<void> {
    await mkdir(this.documents, { recursive: true, mode: 0o700 });
    const manifest = path.join(this.directory, 'manifest.json');
    let previous: string[] = [];
    try {
      const data: unknown = JSON.parse(await readFile(manifest, 'utf8'));
      if (!Array.isArray(data) || !data.every((value): value is string => typeof value === 'string'
        && !path.isAbsolute(value) && !value.split('/').includes('..'))) throw new Error('Invalid search manifest');
      previous = data;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const current = this.knowledge.list().map((entry) => entry.path);
    for (const obsolete of previous.filter((file) => !current.includes(file))) {
      await rm(path.join(this.documents, obsolete), { force: true });
    }
    for (const file of current) {
      const target = path.join(this.documents, file);
      const { content } = await this.knowledge.read(file);
      let existing: string | undefined;
      try {
        existing = await readFile(target, 'utf8');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (existing !== content) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { mode: 0o600 });
      }
    }
    let built = false;
    try {
      await readFile(path.join(this.index, 'meta.json'), 'utf8');
      built = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const args = built ? ['update', '--hidden', '--no-ignore', '--index', this.index]
      : ['index', '-i', this.documents, '--output', this.index, '--hidden', '--no-ignore'];
    await runProcess(this.binary, args, this.documents);
    await writeFile(manifest, JSON.stringify(current), { mode: 0o600 });
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.pending.then(action, action);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
