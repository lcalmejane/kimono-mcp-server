import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { FastGrepIndex } from './search.js';

export type KnowledgeKind = 'command' | 'agent' | 'skill' | 'workflow' | 'knowledge';

export interface KnowledgeEntry {
  id: string;
  path: string;
  kind: KnowledgeKind;
  title: string;
}

export interface SearchMatch extends KnowledgeEntry {
  excerpt: string;
  line: number;
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdc', '.txt', '.json', '.yaml', '.yml', '.toml', '.js', '.mjs', '.cjs', '.sh', '.py', '.ts', '.xml',
]);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class AikidoKnowledgeBase {
  readonly root: string;
  readonly searchIndex: FastGrepIndex;
  private initialized = false;
  private entries: KnowledgeEntry[] = [];

  constructor(root: string) {
    this.root = path.resolve(root);
    this.searchIndex = new FastGrepIndex(this);
  }

  get isInitialized(): boolean { return this.initialized; }

  async initialize(): Promise<void> {
    const rootInfo = await stat(this.root).catch((error: unknown) => {
      throw new Error(`AIKIDO_ROOT is unavailable: ${this.root}`, { cause: error });
    });
    if (!rootInfo.isDirectory()) throw new Error(`AIKIDO_ROOT is not a directory: ${this.root}`);

    const realRoot = await realpath(this.root);
    const indexCandidates = ['prompts/index.md', 'index.md'];
    const hasIndex = await Promise.all(indexCandidates.map(async (candidate) => {
      try {
        const info = await stat(path.join(realRoot, candidate));
        return info.isFile();
      } catch {
        return false;
      }
    })).then((results) => results.some(Boolean));
    if (!hasIndex) {
      throw new Error(`No AI-KIDO entry point found in ${this.root} (expected prompts/index.md or index.md)`);
    }

    this.entries = await this.scanDirectory(realRoot, '');
    this.initialized = true;
  }

  async refresh(): Promise<number> {
    await this.initialize();
    return this.entries.length;
  }

  list(kind?: KnowledgeKind, query?: string): KnowledgeEntry[] {
    this.requireInitialized();
    const needle = query?.trim().toLocaleLowerCase();
    return this.entries.filter((entry) => {
      if (kind && entry.kind !== kind) return false;
      return !needle || `${entry.path} ${entry.title}`.toLocaleLowerCase().includes(needle);
    });
  }

  async read(idOrPath: string): Promise<{ entry: KnowledgeEntry; content: string }> {
    this.requireInitialized();
    const normalized = idOrPath.replaceAll('\\', '/').replace(/^\/+/, '');
    const entry = this.entries.find((item) => item.id === normalized || item.path === normalized);
    if (!entry) throw new Error(`AI-KIDO document not found: ${idOrPath}`);

    const filePath = path.resolve(this.root, entry.path);
    const rootReal = await realpath(this.root);
    const fileReal = await realpath(filePath);
    if (!fileReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`Refusing to read a path outside AIKIDO_ROOT: ${idOrPath}`);
    }
    const info = await stat(fileReal);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      throw new Error(`AI-KIDO document is not a readable text file (maximum ${MAX_FILE_BYTES} bytes): ${idOrPath}`);
    }
    return { entry, content: await readFile(fileReal, 'utf8') };
  }

  async search(query: string, kind?: KnowledgeKind, limit = 25): Promise<SearchMatch[]> {
    this.requireInitialized();
    if (!query.trim()) throw new Error('Search query must not be empty');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be between 1 and 100');
    await this.refresh();
    return this.searchIndex.search(query, kind, limit);
  }

  private async scanDirectory(realRoot: string, relativeDirectory: string): Promise<KnowledgeEntry[]> {
    const directoryPath = path.join(realRoot, relativeDirectory);
    const children = await readdir(directoryPath, { withFileTypes: true });
    const result: KnowledgeEntry[] = [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), child.name);
      if (child.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(child.name)) continue;
        if (process.env.AIKIDO_INCLUDE_SPEC !== 'true' && (relativePath === 'prompts/spec' || relativePath.startsWith('prompts/spec/'))) continue;
        result.push(...await this.scanDirectory(realRoot, relativePath));
      } else if (child.isFile() && TEXT_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        const fullPath = path.join(realRoot, relativePath);
        const info = await stat(fullPath);
        if (info.size > MAX_FILE_BYTES) continue;
        result.push({
          id: relativePath,
          path: relativePath,
          kind: classify(relativePath),
          title: titleFromPath(relativePath),
        });
      }
    }
    return result;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('AI-KIDO knowledge base is not initialized');
  }
}

function classify(filePath: string): KnowledgeKind {
  const normalized = filePath.toLowerCase();
  if (/(^|\/)commands\//.test(normalized) || /(^|\/)commands_list\.md$/.test(normalized)) return 'command';
  if (/(^|\/)workflows\//.test(normalized)) return 'workflow';
  if (/(^|\/)(agents|personas)\//.test(normalized) || /(^|\/)agents_list\.md$/.test(normalized)) return 'agent';
  if (/(^|\/)skills\//.test(normalized) || /(^|\/)skills_list\.md$/.test(normalized) || /(^|\/)skills?\.md$/.test(normalized)) return 'skill';
  return 'knowledge';
}

function titleFromPath(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.[^.]+$/, '').replaceAll('-', ' ').replaceAll('_', ' ');
}
