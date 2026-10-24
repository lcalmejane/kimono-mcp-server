import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ignore, { type Ignore } from 'ignore';
import { FastGrepIndex } from './search.js';
import { SemanticIndex } from './semantic.js';
import { within } from './synchronization.js';
import { ProjectVocabulary } from './query-plan.js';

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
  '.md', '.mdx', '.mdc', '.txt', '.json', '.yaml', '.yml', '.toml', '.js', '.mjs', '.cjs', '.sh', '.py', '.ts', '.xml',
]);
const EXCLUDED_DIRECTORIES = new Set(['.git', '.ssh', 'node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__', '.next', '.nuxt', '.cache', '.nyc_output', 'temp', 'credentials', 'secrets']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KNOWLEDGE_EXTENSIONS = TEXT_EXTENSIONS;

export class AikidoKnowledgeBase {
  readonly root: string;
  readonly searchIndex: FastGrepIndex;
  readonly semanticIndex: SemanticIndex;
  readonly vocabulary: ProjectVocabulary;
  private initialized = false;
  private memoryRoot = false;
  private entries: KnowledgeEntry[] = [];
  private byId = new Map<string, KnowledgeEntry>();

  constructor(root: string, readonly immutable = false) {
    this.root = path.resolve(root);
    this.searchIndex = new FastGrepIndex(this);
    this.semanticIndex = new SemanticIndex(this);
    this.vocabulary = new ProjectVocabulary(this);
  }

  get isInitialized(): boolean { return this.initialized; }
  get isMemoryRoot(): boolean { return this.memoryRoot; }

  async initialize(): Promise<void> {
    const rootInfo = await stat(this.root).catch((error: unknown) => {
      throw new Error(`AIKIDO_ROOT is unavailable: ${this.root}`, { cause: error });
    });
    if (!rootInfo.isDirectory()) throw new Error(`AIKIDO_ROOT is not a directory: ${this.root}`);

    const realRoot = await realpath(this.root);
    const indexCandidates = ['prompts/index.md', 'index.md'];
    const indexes = await Promise.all(indexCandidates.map(async (candidate) => {
      try {
        const info = await stat(path.join(realRoot, candidate));
        return info.isFile();
      } catch {
        return false;
      }
    }));
    if (!indexes.some(Boolean)) {
      throw new Error(`No AI-KIDO entry point found in ${this.root} (expected prompts/index.md or index.md)`);
    }

    this.memoryRoot = !indexes[0];
    this.entries = await this.scanDirectory(realRoot, '');
    this.byId = new Map();
    for (const entry of this.entries) {
      const hash = fileId(entry.path);
      if (this.byId.has(hash)) throw new Error(`AI-KIDO file ID collision: ${entry.path}`);
      this.byId.set(hash, entry);
      this.byId.set(entry.path, entry);
    }
    this.initialized = true;
  }

  async refresh(paths?: string[]): Promise<number> {
    if (this.immutable && this.initialized) return this.entries.length;
    if (!paths) await this.initialize();
    else {
      this.requireInitialized();
      const selected = await this.scanDirectory(await realpath(this.root), '', [], paths);
      this.entries = [...this.entries.filter(entry => !within(entry.path, paths)), ...selected]
        .sort((a, b) => a.path.localeCompare(b.path));
      this.byId = new Map(this.entries.flatMap(entry => [[entry.path, entry], [fileId(entry.path), entry]]));
    }
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

  async read(idOrPath: string): Promise<{ entry: KnowledgeEntry; content: string; modified: string }> {
    this.requireInitialized();
    const normalized = idOrPath.replaceAll('\\', '/').replace(/^\/+/, '');
    const entry = this.byId.get(normalized);
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
    return { entry, content: await readFile(fileReal, 'utf8'), modified: info.mtime.toISOString() };
  }

  async search(query: string, kind?: KnowledgeKind, limit = 25): Promise<SearchMatch[]> {
    this.requireInitialized();
    if (!query.trim()) throw new Error('Search query must not be empty');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be between 1 and 100');
    await this.refresh();
    return this.searchIndex.search(query, kind, limit);
  }

  private async scanDirectory(realRoot: string, relativeDirectory: string, inherited: Array<{ base: string; rules: Ignore }> = [], scopes?: string[]): Promise<KnowledgeEntry[]> {
    const directoryPath = path.join(realRoot, relativeDirectory);
    const children = await readdir(directoryPath, { withFileTypes: true });
    const rules = [...inherited];
    if (children.some(child => child.name === '.gitignore' && child.isFile())) {
      rules.push({ base: relativeDirectory, rules: ignore().add(await readFile(path.join(directoryPath, '.gitignore'), 'utf8')) });
    }
    const result: KnowledgeEntry[] = [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), child.name);
      // Visit only selected subtrees and their ancestors (for inherited ignore rules).
      if (scopes && !within(relativePath, scopes)
        && !scopes.some(scope => scope.startsWith(`${relativePath}/`))) continue;
      if (child.name.startsWith('.env') || /(?:\.log|\.tmp|\.sw[po]|~)$/.test(child.name)) continue;
      if (isSensitiveKnowledgePath(relativePath)) continue;
      let ignored = false;
      for (const layer of rules) {
        const local = relativePath.slice(layer.base ? layer.base.length + 1 : 0) + (child.isDirectory() ? '/' : '');
        const decision = layer.rules.test(local);
        if (decision.ignored) ignored = true;
        else if (decision.unignored) ignored = false;
      }
      if (ignored) continue;
      if (child.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(child.name)) continue;
        if (process.env.AIKIDO_INCLUDE_SPEC !== 'true' && (relativePath === 'prompts/spec' || relativePath === 'spec')) continue;
        result.push(...await this.scanDirectory(realRoot, relativePath, rules, scopes));
      } else if (child.isFile() && TEXT_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        if (!within(relativePath, scopes)) continue;
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

export function fileId(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 12);
}

export function isKnowledgeFile(filePath: string): boolean {
  return KNOWLEDGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isSensitiveKnowledgePath(filePath: string): boolean {
  const segments = filePath.replaceAll('\\', '/').split('/');
  const basename = segments.at(-1) ?? '';
  return segments.some(segment => ['.git', '.ssh', 'credentials', 'secrets'].includes(segment.toLowerCase()))
    || segments.some(segment => segment.startsWith('.env'))
    || /\.(?:pem|key|p12|pfx)$/i.test(basename)
    || /^(?:id_(?:rsa|ed25519)(?:\.pub)?|credentials(?:\.[^.]+)?|\.netrc|\.npmrc|\.pypirc)$/i.test(basename);
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
